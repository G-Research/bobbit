import { build, transform } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const DEFAULT_CACHE_ROOT = join(REPO_ROOT, ".profiles", "testing-v2", "server-prebundle");
const BUNDLE_SCHEMA = 2;

function fileDigest(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function walkFiles(root) {
	const out = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.(?:ts|js|json)$/.test(entry.name)) out.push(full);
		}
	};
	walk(root);
	return out.sort();
}

export function computeServerPrebundleKey(repoRoot = REPO_ROOT) {
	const hash = createHash("sha256");
	const files = [
		...walkFiles(join(repoRoot, "src", "server")),
		join(repoRoot, "tests2", "harness", "server-runtime-entry.ts"),
		join(repoRoot, "tsconfig.server.json"),
		join(repoRoot, "package-lock.json"),
		fileURLToPath(import.meta.url),
	];
	for (const file of files) {
		hash.update(relative(repoRoot, file).replace(/\\/g, "/"));
		hash.update("\0");
		hash.update(readFileSync(file));
		hash.update("\0");
	}
	return hash.digest("hex").slice(0, 24);
}

export function validateServerPrebundle(dir, key) {
	try {
		const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
		const bundlePath = join(dir, "runtime.mjs");
		return manifest.schema === BUNDLE_SCHEMA
			&& manifest.key === key
			&& statSync(bundlePath).size > 1024
			&& existsSync(`${bundlePath}.map`)
			&& manifest.bundleSha256 === fileDigest(bundlePath)
			&& manifest.mapSha256 === fileDigest(`${bundlePath}.map`);
	} catch { return false; }
}

function sourceUrlPlugin() {
	return {
		name: "bobbit-source-import-meta-url",
		setup(buildApi) {
			buildApi.onLoad({ filter: /[\\/]src[\\/]server[\\/].*\.(?:ts|js)$/ }, async (args) => {
				const source = readFileSync(args.path, "utf8");
				const transformed = await transform(source, {
					loader: args.path.endsWith(".ts") ? "ts" : "js",
					format: "esm",
					target: "node22",
					sourcefile: args.path,
					sourcemap: "inline",
					define: { "import.meta.url": JSON.stringify(pathToFileURL(args.path).href) },
				});
				return { contents: transformed.code, loader: "js", resolveDir: dirname(args.path) };
			});
		},
	};
}

function runtimeEntryNamespaces(repoRoot) {
	const source = readFileSync(join(repoRoot, "tests2", "harness", "server-runtime-entry.ts"), "utf8");
	return [...source.matchAll(/^export \* as ([A-Za-z_$][\w$]*) from /gm)].map((match) => match[1]).sort();
}

async function assertBundleParity(bundlePath, repoRoot) {
	const loaded = await import(`${pathToFileURL(bundlePath).href}?validate=${Date.now()}`);
	const expected = runtimeEntryNamespaces(repoRoot);
	const actual = Object.keys(loaded).sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`[server-prebundle] export parity failed: expected [${expected.join(", ")}], got [${actual.join(", ")}]`);
	}
	if (typeof loaded?.server?.createGateway !== "function") {
		throw new Error("[server-prebundle] boot parity failed: server.createGateway is missing");
	}
	if (typeof loaded?.gatewayDeps?.realCommandRunner?.execFile !== "function"
		|| loaded.gatewayDeps.realCommandRunner !== loaded.server.realCommandRunner) {
		throw new Error("[server-prebundle] dependency parity failed: shared gatewayDeps.realCommandRunner is missing or duplicated");
	}
	if (!readFileSync(bundlePath, "utf8").includes("createRequire(import.meta.url)")) {
		throw new Error("[server-prebundle] import.meta.url rewrite corrupted a generated child-module source string");
	}
}

export async function ensureServerTestPrebundle({ repoRoot = REPO_ROOT, cacheRoot = DEFAULT_CACHE_ROOT } = {}) {
	const key = computeServerPrebundleKey(repoRoot);
	const finalDir = join(cacheRoot, key);
	const bundlePath = join(finalDir, "runtime.mjs");
	if (validateServerPrebundle(finalDir, key)) return { key, bundlePath, cacheHit: true };

	mkdirSync(cacheRoot, { recursive: true });
	const tempDir = join(cacheRoot, `.tmp-${key}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(tempDir, { recursive: true });
	try {
		const output = join(tempDir, "runtime.mjs");
		await build({
			entryPoints: [join(repoRoot, "tests2", "harness", "server-runtime-entry.ts")],
			outfile: output,
			bundle: true,
			packages: "external",
			platform: "node",
			format: "esm",
			target: "node22",
			sourcemap: "external",
			logLevel: "silent",
			plugins: [sourceUrlPlugin()],
		});
		await assertBundleParity(output, repoRoot);
		writeFileSync(join(tempDir, "manifest.json"), `${JSON.stringify({
			schema: BUNDLE_SCHEMA,
			key,
			createdAt: new Date().toISOString(),
			bundleSha256: fileDigest(output),
			mapSha256: fileDigest(`${output}.map`),
		}, null, 2)}\n`);
		try { renameSync(tempDir, finalDir); }
		catch (error) {
			if (!validateServerPrebundle(finalDir, key)) throw error;
			rmSync(tempDir, { recursive: true, force: true });
		}
	} catch (error) {
		rmSync(tempDir, { recursive: true, force: true });
		throw error;
	}
	if (!validateServerPrebundle(finalDir, key)) throw new Error(`[server-prebundle] invalid artifact after build: ${finalDir}`);
	return { key, bundlePath, cacheHit: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const result = await ensureServerTestPrebundle();
	console.log(JSON.stringify(result));
}
