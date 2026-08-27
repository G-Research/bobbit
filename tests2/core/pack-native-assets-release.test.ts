// v2-native — release transport coverage for generic pack-local native assets.
import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const COPY_BUILTIN_PACKS = path.join(REPO_ROOT, "scripts", "copy-builtin-packs.mjs");
const PACK_NAME = "file-explorer";
const FAMILY_ID = "fixture-addon";
const CANONICAL_TARGETS = [
	"darwin-arm64",
	"darwin-x64",
	"linux-glibc-arm64",
	"linux-glibc-x64",
	"linux-musl-arm64",
	"linux-musl-x64",
	"win32-arm64",
	"win32-x64",
] as const;

type CanonicalTarget = (typeof CANONICAL_TARGETS)[number];

interface NpmLoadResult {
	exec: boolean;
	command?: string;
	args: string[];
}

interface NpmInstance {
	load(): Promise<NpmLoadResult>;
	exec(command: string, args: string[]): Promise<void>;
	unload(): void;
}

interface NpmConstructor {
	new(options: {
		stdout: NodeJS.WritableStream;
		stderr: NodeJS.WritableStream;
		argv: string[];
	}): NpmInstance;
}

interface NpmPackEntry {
	filename: string;
	files: Array<{ path: string; size: number; mode: number }>;
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeMaterializedPack(packRoot: string): Map<CanonicalTarget, Buffer> {
	const family = path.join(packRoot, "lib", "native", FAMILY_ID);
	const bytes = new Map<CanonicalTarget, Buffer>();
	const targets: Record<string, string> = {};
	const sizes: Record<string, number> = {};
	const sha256: Record<string, string> = {};

	for (const target of CANONICAL_TARGETS) {
		const contents = Buffer.from(`fixture-native:${target}\n`, "utf8");
		const filename = `${target}.node`;
		bytes.set(target, contents);
		targets[target] = filename;
		sizes[target] = contents.byteLength;
		sha256[target] = createHash("sha256").update(contents).digest("hex");
		fs.mkdirSync(family, { recursive: true });
		fs.writeFileSync(path.join(family, filename), contents);
	}

	writeJson(path.join(family, "manifest.json"), {
		schema: 1,
		package: "fixture-native-addon",
		version: "1.2.3",
		targets,
		sizes,
		sha256,
	});
	writeJson(path.join(packRoot, "pack.yaml"), {
		schema: 2,
		name: PACK_NAME,
		version: "1.0.0",
	});
	fs.mkdirSync(path.join(packRoot, "src"), { recursive: true });
	fs.writeFileSync(path.join(packRoot, "src", "repository-only.ts"), "throw new Error('must not ship');\n");
	fs.mkdirSync(path.join(packRoot, "node_modules", "fixture-native-addon"), { recursive: true });
	fs.writeFileSync(path.join(packRoot, "node_modules", "fixture-native-addon", "must-not-ship.js"), "export {};\n");

	// This represents the owning pack's already-built entry bundle. The focused
	// native-assets test pins the production alias bundling and selector; this
	// fixture pins only release transport and execution after clean installation.
	fs.writeFileSync(path.join(packRoot, "lib", "resolve.mjs"), `
import fs from "node:fs";
import path from "node:path";
export function resolveInjectedNativeAsset(packRoot, target) {
  const family = path.join(packRoot, "lib", "native", ${JSON.stringify(FAMILY_ID)});
  const manifest = JSON.parse(fs.readFileSync(path.join(family, "manifest.json"), "utf8"));
  const filename = manifest.targets[target];
  if (typeof filename !== "string") throw new Error(\`fixture target unavailable: \${target}\`);
  const resolved = path.resolve(family, filename);
  if (path.dirname(resolved) !== path.resolve(family) || !fs.statSync(resolved).isFile()) {
    throw new Error(\`fixture native asset invalid: \${target}\`);
  }
  return resolved;
}
`.trimStart(), "utf8");
	return bytes;
}

async function runBuiltinCopy(fixtureRoot: string, outputRoot: string): Promise<void> {
	for (const name of [PACK_NAME, "pr-walkthrough", "terminal"]) {
		fs.mkdirSync(path.join(fixtureRoot, "market-packs", name), { recursive: true });
	}
	const previousCwd = process.cwd();
	const previousOutput = process.env.BOBBIT_SERVER_OUT_DIR;
	try {
		process.chdir(fixtureRoot);
		process.env.BOBBIT_SERVER_OUT_DIR = outputRoot;
		await import(`${pathToFileURL(COPY_BUILTIN_PACKS).href}?release-fixture=${Date.now()}`);
	} finally {
		process.chdir(previousCwd);
		if (previousOutput === undefined) delete process.env.BOBBIT_SERVER_OUT_DIR;
		else process.env.BOBBIT_SERVER_OUT_DIR = previousOutput;
	}
}

function loadNpmConstructor(): NpmConstructor {
	const npmCli = process.env.npm_execpath;
	if (!npmCli || !fs.existsSync(npmCli)) {
		throw new Error("release packaging test requires npm_execpath from the npm test runner");
	}
	const npmModule = path.resolve(path.dirname(npmCli), "..", "lib", "npm.js");
	if (!fs.existsSync(npmModule)) {
		throw new Error(`release packaging test cannot locate npm's in-process API: ${npmModule}`);
	}
	return createRequire(import.meta.url)(npmModule) as NpmConstructor;
}

async function runNpm(cwd: string, argv: string[]): Promise<{ stdout: string; stderr: string }> {
	const Npm = loadNpmConstructor();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	let stdoutText = "";
	let stderrText = "";
	stdout.setEncoding("utf8");
	stderr.setEncoding("utf8");
	stdout.on("data", chunk => { stdoutText += String(chunk); });
	stderr.on("data", chunk => { stderrText += String(chunk); });

	const previousCwd = process.cwd();
	process.chdir(cwd);
	const npm = new Npm({ stdout, stderr, argv });
	try {
		const loaded = await npm.load();
		if (!loaded.exec || !loaded.command) throw new Error(`npm did not load command: ${argv.join(" ")}`);
		await npm.exec(loaded.command, loaded.args);
		await new Promise<void>(resolve => setImmediate(resolve));
		return { stdout: stdoutText, stderr: stderrText };
	} finally {
		npm.unload();
		process.chdir(previousCwd);
	}
}

function setTreeReadOnly(root: string): void {
	if (process.platform === "win32") return;
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const child = path.join(root, entry.name);
		if (entry.isDirectory()) setTreeReadOnly(child);
		else fs.chmodSync(child, 0o444);
	}
	fs.chmodSync(root, 0o555);
}

function setTreeWritable(root: string): void {
	if (!fs.existsSync(root) || process.platform === "win32") return;
	fs.chmodSync(root, 0o755);
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const child = path.join(root, entry.name);
		if (entry.isDirectory()) setTreeWritable(child);
		else fs.chmodSync(child, 0o644);
	}
}

function fileDigest(file: string): string {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

describe("pack native assets in the release package", () => {
	it("copies, packs, installs, and resolves all canonical assets from a read-only clean consumer", async () => {
		const root = fs.mkdtempSync(path.join(tmpdir(), "bobbit-native-release-"));
		const releaseRoot = path.join(root, "release");
		const packRoot = path.join(releaseRoot, "market-packs", PACK_NAME);
		const outputRoot = path.join(releaseRoot, "dist");
		const tarballRoot = path.join(root, "tarballs");
		const consumerRoot = path.join(root, "consumer");
		const npmCache = path.join(root, "npm-cache");
		let installedRelease = "";
		onTestFinished(() => {
			setTreeWritable(installedRelease);
			fs.rmSync(root, { recursive: true, force: true });
		});

		fs.mkdirSync(releaseRoot, { recursive: true });
		const expectedBytes = writeMaterializedPack(packRoot);
		writeJson(path.join(releaseRoot, "package.json"), {
			name: "@fixture/bobbit-native-release",
			version: "1.0.0",
			files: ["dist/"],
		});

		await runBuiltinCopy(releaseRoot, outputRoot);
		const copiedPack = path.join(outputRoot, "server", "builtin-packs", "market-packs", PACK_NAME);
		expect(fs.existsSync(path.join(copiedPack, "lib", "native", FAMILY_ID, "manifest.json"))).toBe(true);
		expect(fs.existsSync(path.join(copiedPack, "src"))).toBe(false);
		expect(fs.existsSync(path.join(copiedPack, "node_modules"))).toBe(false);

		fs.mkdirSync(tarballRoot, { recursive: true });
		const packed = await runNpm(releaseRoot, [
			"pack",
			"--ignore-scripts",
			"--json",
			"--pack-destination",
			tarballRoot,
			"--cache",
			npmCache,
		]);
		const packEntries = JSON.parse(packed.stdout) as NpmPackEntry[];
		expect(packEntries).toHaveLength(1);
		const packEntry = packEntries[0];
		const listed = packEntry.files.map(file => file.path.replaceAll("\\", "/"));
		const familyPrefix = `dist/server/builtin-packs/market-packs/${PACK_NAME}/lib/native/${FAMILY_ID}`;
		expect(listed.filter(file => file.startsWith(`${familyPrefix}/`) && file.endsWith(".node")).sort())
			.toEqual(CANONICAL_TARGETS.map(target => `${familyPrefix}/${target}.node`).sort());
		expect(listed).toContain(`${familyPrefix}/manifest.json`);
		expect(listed.some(file => file.includes("/src/") || file.includes("/node_modules/"))).toBe(false);

		const tarball = path.join(tarballRoot, packEntry.filename);
		expect(fs.statSync(tarball).isFile()).toBe(true);
		fs.mkdirSync(consumerRoot, { recursive: true });
		writeJson(path.join(consumerRoot, "package.json"), {
			name: "native-release-clean-consumer",
			version: "1.0.0",
			private: true,
		});
		await runNpm(consumerRoot, [
			"install",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--no-save",
			"--package-lock=false",
			"--offline",
			"--json",
			"--cache",
			npmCache,
			tarball,
		]);

		installedRelease = path.join(consumerRoot, "node_modules", "@fixture", "bobbit-native-release");
		const installedPack = path.join(installedRelease, "dist", "server", "builtin-packs", "market-packs", PACK_NAME);
		expect(fs.existsSync(path.join(consumerRoot, "package-lock.json"))).toBe(false);
		expect(fs.existsSync(path.join(installedRelease, "node_modules"))).toBe(false);
		setTreeReadOnly(installedRelease);
		if (process.platform !== "win32") {
			expect(fs.statSync(installedRelease).mode & 0o222).toBe(0);
		}

		const resolverFile = path.join(installedPack, "lib", "resolve.mjs");
		const beforeResolver = fileDigest(resolverFile);
		const resolver = await import(`${pathToFileURL(resolverFile).href}?read-only-release=${Date.now()}`) as {
			resolveInjectedNativeAsset(pack: string, target: CanonicalTarget): string;
		};
		const injectedTarget: CanonicalTarget = "linux-musl-arm64";
		const resolved = resolver.resolveInjectedNativeAsset(installedPack, injectedTarget);
		expect(path.resolve(resolved)).toBe(path.resolve(
			installedPack,
			"lib",
			"native",
			FAMILY_ID,
			`${injectedTarget}.node`,
		));
		expect(fs.readFileSync(resolved)).toEqual(expectedBytes.get(injectedTarget));
		expect(fileDigest(resolverFile)).toBe(beforeResolver);
	});
});
