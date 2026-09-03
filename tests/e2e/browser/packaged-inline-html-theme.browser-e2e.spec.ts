import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	piPackedConsumerNpmEnv,
	runPiPackedConsumerCommand,
	runPiPackedConsumerNpm,
} from "../test-utils/pi-packed-consumer-command.js";
import {
	capturePackagedCli,
	commandFailure,
	createProjectAndSession,
	getFreePort,
	promptSession,
	readToken,
	startPackagedCli,
	stopPackagedCli,
	waitForHealth,
	writePackedAgent,
	type CommandResult,
	type RunningCli,
} from "../../../tests/support/helpers/browser/e2e/packaged-runtime-helpers.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const PACKAGE_NAME = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { name: string }).name;
const PACKAGE_INSTALL_SEGMENTS = PACKAGE_NAME.split("/");
const CANONICAL_BRIDGE_SIGNATURE = "data-bobbit-inline-theme-bridge";
const SOURCE_BRIDGE_PATH = "src/shared/preview-bridge-scripts.ts";
const THEME_TOKENS = ["--background", "--foreground", "--card", "--positive", "--chart-1"] as const;
const PI_PACKAGES = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
] as const;
const INSPECTED_PACKAGES = [...PI_PACKAGES, "brace-expansion", "protobufjs"];
const DEV_ONLY_BUNDLED_PACKAGES = [
	"@mariozechner/mini-lit",
	"@recogito/text-annotator",
	"@xterm/addon-fit",
	"@xterm/xterm",
	"lucide",
	"qrcode",
	"sortablejs",
] as const;
const REQUIRED_PI_VERSION = "0.84.1";

interface JsonRecord {
	[key: string]: unknown;
}

interface DependencyOccurrence {
	name: string;
	version: string;
	path: string[];
}

interface PackEntry {
	name?: string;
	filename?: string;
	size?: number;
	unpackedSize?: number;
	files?: Array<{ path?: string }>;
}

interface ThemeState {
	background: string;
	foreground: string;
	card: string;
	positive: string;
	chart: string;
	font: string;
	dark: boolean;
	palette: string | null;
}

interface RuntimeReport {
	commands: CommandResult[];
	pack?: unknown;
	packFiles: string[];
	packageMetrics?: {
		fileCount: number;
		packedBytes: number;
		unpackedBytes: number;
		installedPackageCount: number;
	};
	selectedPiVersion?: string;
	tree?: unknown;
	binaries?: unknown;
	bridgeAssets: string[];
	requests: string[];
	cliStdout?: string;
	cliStderr?: string;
}

function asRecord(value: unknown, label: string): JsonRecord {
	expect(value, `${label} must be an object`).not.toBeNull();
	expect(typeof value, `${label} must be an object`).toBe("object");
	expect(Array.isArray(value), `${label} must not be an array`).toBe(false);
	return value as JsonRecord;
}

function parseJson(stdout: string, label: string): unknown {
	expect(stdout.trim(), `${label} stdout must contain JSON`).not.toBe("");
	try {
		return JSON.parse(stdout);
	} catch (error) {
		throw new Error(`${label} emitted malformed JSON: ${(error as Error).message}\nstdout:\n${stdout}`, {
			cause: error,
		});
	}
}

function parsePackResult(stdout: string): { entry: PackEntry; report: unknown } {
	const parsed = parseJson(stdout, "npm pack");
	expect(Array.isArray(parsed), "npm pack --json must return an array").toBe(true);
	expect(parsed).toHaveLength(1);
	return { entry: (parsed as PackEntry[])[0]!, report: parsed };
}

function parseVersion(version: string, label = "version"): [number, number, number] {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	expect(match, `${label} must be an exact stable semver, received ${JSON.stringify(version)}`).not.toBeNull();
	return [Number(match![1]), Number(match![2]), Number(match![3])];
}

function compareVersions(left: string, right: string): number {
	const a = parseVersion(left, "selected version");
	const b = parseVersion(right, "compatibility baseline");
	for (let index = 0; index < a.length; index++) {
		if (a[index] !== b[index]) return a[index]! - b[index]!;
	}
	return 0;
}

function collectDependencies(tree: unknown): DependencyOccurrence[] {
	const occurrences: DependencyOccurrence[] = [];
	const visit = (value: unknown, ancestors: string[]): void => {
		const node = asRecord(value, `npm ls node at ${ancestors.join(" > ") || "root"}`);
		const dependencies = node.dependencies;
		if (dependencies === undefined) return;
		const dependencyMap = asRecord(dependencies, `dependencies at ${ancestors.join(" > ") || "root"}`);
		for (const [name, rawDependency] of Object.entries(dependencyMap)) {
			const dependency = asRecord(rawDependency, `npm ls dependency ${name}`);
			const path = [...ancestors, name];
			if (INSPECTED_PACKAGES.includes(name as typeof INSPECTED_PACKAGES[number])) {
				expect(typeof dependency.version, `${path.join(" > ")} must report a version`).toBe("string");
				occurrences.push({ name, version: dependency.version as string, path });
			}
			visit(dependency, path);
		}
	};
	visit(tree, []);
	return occurrences;
}

function collectNpmProblems(tree: unknown): string[] {
	const problems: string[] = [];
	const visit = (value: unknown): void => {
		const node = asRecord(value, "npm ls node");
		if (node.problems !== undefined) {
			expect(Array.isArray(node.problems), "npm ls problems must be an array").toBe(true);
			for (const problem of node.problems as unknown[]) problems.push(String(problem));
		}
		if (node.dependencies === undefined) return;
		for (const dependency of Object.values(asRecord(node.dependencies, "npm ls dependencies"))) visit(dependency);
	};
	visit(tree);
	return problems;
}

async function listFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	const visit = async (dir: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) await visit(fullPath);
			else if (entry.isFile()) files.push(fullPath);
		}
	};
	await visit(root);
	return files;
}

function normalizedPackagePaths(pack: PackEntry): string[] {
	return (pack.files ?? [])
		.map(file => String(file.path ?? "").replace(/\\/g, "/").replace(/^package\//, ""))
		.filter(Boolean);
}

async function expectIndexAssetsExist(packageRoot: string): Promise<void> {
	const indexPath = join(packageRoot, "dist", "ui", "index.html");
	const index = await readFile(indexPath, "utf8");
	const references = [...index.matchAll(/(?:src|href)=["']([^"']*assets\/[^"']+)["']/g)]
		.map(match => match[1]!.split(/[?#]/, 1)[0]!.replace(/^\.\//, "").replace(/^\//, ""));
	expect(references.length, "packaged dist/ui/index.html must reference compiled assets").toBeGreaterThan(0);
	for (const asset of references) {
		expect(existsSync(join(packageRoot, "dist", "ui", asset)), `index references missing packaged asset ${asset}`).toBe(true);
	}
}

async function findBridgeAssets(packageRoot: string): Promise<string[]> {
	const assetsDir = join(packageRoot, "dist", "ui", "assets");
	const assets = (await listFiles(assetsDir)).filter(file => /\.(?:js|mjs)$/.test(file));
	const matches: string[] = [];
	for (const asset of assets) {
		const content = await readFile(asset, "utf8");
		if (content.includes(CANONICAL_BRIDGE_SIGNATURE)) matches.push(relative(packageRoot, asset).replace(/\\/g, "/"));
	}
	return matches;
}

async function hostTheme(page: Page): Promise<ThemeState> {
	return page.evaluate(() => {
		const root = document.documentElement;
		const style = getComputedStyle(root);
		return {
			background: style.getPropertyValue("--background").trim(),
			foreground: style.getPropertyValue("--foreground").trim(),
			card: style.getPropertyValue("--card").trim(),
			positive: style.getPropertyValue("--positive").trim(),
			chart: style.getPropertyValue("--chart-1").trim(),
			font: style.fontFamily,
			dark: root.classList.contains("dark"),
			palette: root.getAttribute("data-palette"),
		};
	});
}

async function iframeTheme(page: Page): Promise<{
	capture: ThemeState | null;
	current: ThemeState;
	authoredScriptRan: boolean;
	canonicalBridgeCount: number;
	swipeBridgeCount: number;
	identity: string | null;
}> {
	return page.locator('iframe[title="theme-card.html"]').evaluate((element) => {
		const iframe = element as HTMLIFrameElement;
		const frameWindow = iframe.contentWindow as (Window & {
			__packedThemeCapture?: ThemeState;
			__packedFrameIdentity?: string;
		}) | null;
		const documentRoot = iframe.contentDocument!.documentElement;
		const style = iframe.contentWindow!.getComputedStyle(documentRoot);
		const scripts = [...iframe.contentDocument!.scripts];
		return {
			capture: frameWindow?.__packedThemeCapture ?? null,
			current: {
				background: style.getPropertyValue("--background").trim(),
				foreground: style.getPropertyValue("--foreground").trim(),
				card: style.getPropertyValue("--card").trim(),
				positive: style.getPropertyValue("--positive").trim(),
				chart: style.getPropertyValue("--chart-1").trim(),
				font: style.fontFamily,
				dark: documentRoot.classList.contains("dark"),
				palette: documentRoot.getAttribute("data-palette"),
			},
			authoredScriptRan: documentRoot.getAttribute("data-authored-script-ran") === "true",
			canonicalBridgeCount: scripts.filter(script => script.hasAttribute("data-bobbit-inline-theme-bridge")).length,
			swipeBridgeCount: scripts.filter(script => (script.textContent ?? "").includes("preview-swipe-start")).length,
			identity: frameWindow?.__packedFrameIdentity ?? null,
		};
	});
}

function expectThemeMatches(actual: ThemeState, expected: ThemeState, label: string): void {
	for (const key of ["background", "foreground", "card", "positive", "chart"] as const) {
		expect(actual[key], `${label} ${key} must be populated`).not.toBe("");
		expect(actual[key], `${label} ${key} must match the packaged host stylesheet`).toBe(expected[key]);
	}
	expect(actual.font, `${label} font stack must match the packaged host`).toBe(expected.font);
	expect(actual.dark, `${label} dark state must match the packaged host`).toBe(expected.dark);
	expect(actual.palette, `${label} palette must match the packaged host`).toBe(expected.palette);
}

async function attachReport(testInfo: TestInfo, report: RuntimeReport): Promise<void> {
	await testInfo.attach("packaged-inline-html-theme-report.json", {
		body: Buffer.from(`${JSON.stringify(report, null, 2)}\n`),
		contentType: "application/json",
	});
}

test.describe("packed Bobbit inline HTML runtime", () => {
	// A retry repeats npm pack + a clean dependency install and can hide a real
	// packaging regression behind a second independently-built consumer.
	test.describe.configure({ retries: 0 });

	test("teardown escalates an unresponsive packaged runtime without leaking its pipes", async () => {
		const child = spawn(process.execPath, ["-e", process.platform === "win32"
			? "console.log('ready'); setInterval(() => {}, 1_000);"
			: "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1_000);"], {
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const runtime = capturePackagedCli(child);
		await once(child.stdout!, "data");

		const startedAt = Date.now();
		await stopPackagedCli(runtime);
		const elapsedMs = Date.now() - startedAt;

		if (process.platform !== "win32") expect(child.signalCode).toBe("SIGKILL");
		expect(runtime.closed, "teardown must wait for ChildProcess close").toBe(true);
		expect(child.exitCode ?? child.signalCode).not.toBeNull();
		expect(child.stdout?.destroyed, "teardown must release inherited stdout").toBe(true);
		expect(child.stderr?.destroyed, "teardown must release inherited stderr").toBe(true);
		expect(elapsedMs, "teardown must remain bounded after escalation").toBeLessThan(10_000);
	});

	test("teardown does not mistake released stdio for packaged process close", async () => {
		const child = spawn(process.execPath, ["-e", `
			const fs = require("node:fs");
			const keepAlive = setInterval(() => {}, 1_000);
			process.on("message", message => {
				if (message !== "release-stdio") return;
				process.stdout.destroy();
				process.stderr.destroy();
				fs.closeSync(1);
				fs.closeSync(2);
				process.send?.("stdio-released");
			});
			// This source is itself a template literal: retain the child script's
			// escaped newline rather than embedding a syntax-breaking raw newline.
			process.stdout.write("ready\\\\n");
		`], {
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			windowsHide: true,
		});
		const runtime = capturePackagedCli(child);
		const actualClose = once(child, "close");
		await once(child.stdout!, "data");
		const stdoutReleased = once(child.stdout!, "close");
		const stderrReleased = once(child.stderr!, "close");
		const stdioReleased = once(child, "message");
		child.send("release-stdio");
		expect((await stdioReleased)[0], "fixture must acknowledge its stdio release").toBe("stdio-released");
		// Windows keeps the parent pipe handle open after the child closes its
		// descriptor. Release the inherited endpoints locally as well, then wait
		// for their close events before proving that this is not process closure.
		child.stdout?.destroy();
		child.stderr?.destroy();
		await Promise.all([stdoutReleased, stderrReleased]);

		try {
			expect(runtime.closed, "stdio closure must not be recorded as process closure").toBe(false);
			expect(child.exitCode).toBeNull();
			expect(child.signalCode).toBeNull();

			await stopPackagedCli(runtime);
			expect(runtime.closed, "teardown must await actual ChildProcess close").toBe(true);
			await actualClose;
			expect(child.exitCode ?? child.signalCode).not.toBeNull();
		} finally {
			// Keep this regression self-cleaning against a broken teardown: the
			// fixture intentionally has no natural exit path after closing stdio.
			if (!runtime.closed) {
				child.kill("SIGKILL");
				await actualClose;
			}
		}
	});

	test("reaps an inherited-stdio descendant at the owned root-exit boundary", async () => {
		test.setTimeout(5_000);
		const child = spawn(process.execPath, ["-e", [
			'const { spawn } = require("node:child_process");',
			'const descendant = spawn(process.execPath, ["-e", "process.on(\\\"SIGTERM\\\", () => {}); setInterval(() => {}, 1000);"], { stdio: "inherit" });',
			'process.stdout.write("ready\\n");',
			'process.on("SIGTERM", () => process.exit(0));',
		].join("")], {
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const runtime = capturePackagedCli(child);
		const actualExit = once(child, "exit");
		const actualClose = once(child, "close");
		await once(child.stdout!, "data");

		try {
			await stopPackagedCli(runtime);
			await actualExit;
			await actualClose;
			expect(runtime.exited, "root exit must be recorded before inherited stdio closes").toBe(true);
			expect(runtime.closed, "the owned process tree must close after teardown").toBe(true);
			if (process.platform !== "win32") {
				expect(runtime.finalTreeSignalSent, "the original POSIX group must be finalized at root exit").toBe(true);
			}
		} finally {
			if (!runtime.closed) await stopPackagedCli(runtime);
		}
	});

	test("clean consumer serves dist UI and executes the bundled canonical theme bridge", async ({ page }, testInfo) => {
		test.setTimeout(15 * 60_000);
		const tempRoot = await mkdtemp(join(tmpdir(), "bobbit-packed-inline-theme-"));
		const packDir = join(tempRoot, "pack");
		const consumerDir = join(tempRoot, "consumer");
		const workspaceDir = join(consumerDir, "workspace");
		const secretsDir = join(consumerDir, "secrets");
		const agentDir = join(consumerDir, "agent-state");
		const agentPath = join(consumerDir, "packed-write-agent.mjs");
		const report: RuntimeReport = { commands: [], packFiles: [], bridgeAssets: [], requests: [] };
		let runtime: RunningCli | undefined;

		try {
			await Promise.all([
				mkdir(packDir, { recursive: true }),
				mkdir(workspaceDir, { recursive: true }),
				mkdir(secretsDir, { recursive: true }),
				mkdir(agentDir, { recursive: true }),
			]);
			await writeFile(join(consumerDir, "package.json"), `${JSON.stringify({
				name: "bobbit-inline-theme-clean-consumer",
				version: "1.0.0",
				private: true,
			}, null, 2)}\n`);
			await writePackedAgent(agentPath);

			// Browser-v2 global setup produces a content-addressed fresh dist first.
			// npm pack therefore tests the same built artifact published to npx users
			// without running an expensive build inside this E2E spec.
			const packed = await runPiPackedConsumerNpm(
				["pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
				{ cwd: REPO_ROOT, timeoutMs: 3 * 60_000 },
			);
			report.commands.push(packed);
			expect(packed.code, commandFailure(packed)).toBe(0);
			const { entry: pack, report: packReport } = parsePackResult(packed.stdout);
			report.pack = packReport;
			expect(pack.name).toBe(PACKAGE_NAME);
			expect(typeof pack.filename).toBe("string");
			report.packFiles = normalizedPackagePaths(pack);
			report.packageMetrics = {
				fileCount: report.packFiles.length,
				packedBytes: Number(pack.size),
				unpackedBytes: Number(pack.unpackedSize),
				installedPackageCount: 0,
			};
			expect(Number.isSafeInteger(report.packageMetrics.packedBytes)).toBe(true);
			expect(Number.isSafeInteger(report.packageMetrics.unpackedBytes)).toBe(true);
			expect(report.packFiles).toContain("dist/server/cli.js");
			expect(report.packFiles).toContain("dist/ui/index.html");
			expect(report.packFiles).toContain("src/ui/app.css");
			expect(
				report.packFiles.some(file => /^dist\/ui\/assets\/.+\.(?:js|mjs)$/.test(file)),
				"tarball must contain compiled dist/ui JavaScript assets",
			).toBe(true);
			expect(
				report.packFiles.some(file => /^dist\/ui\/assets\/.+\.css$/.test(file)),
				"tarball must contain compiled dist/ui CSS assets",
			).toBe(true);

			const tarballPath = resolve(packDir, pack.filename!);
			expect(existsSync(tarballPath), `npm pack did not create ${tarballPath}`).toBe(true);
			const consumerEnv = piPackedConsumerNpmEnv(consumerDir);
			const lockConfig = await runPiPackedConsumerNpm(
				["config", "get", "package-lock"],
				{ cwd: consumerDir, env: consumerEnv, timeoutMs: 30_000 },
			);
			report.commands.push(lockConfig);
			expect(lockConfig.code, commandFailure(lockConfig)).toBe(0);
			expect(lockConfig.stdout.trim(), "clean consumer must use npm's normal package-lock=true default").toBe("true");

			// CI prewarms every tarball selected by this clean consumer. Offline mode
			// fails closed instead of letting this deterministic E2E consult a registry.
			const install = await runPiPackedConsumerNpm(
				["install", "--offline", tarballPath],
				{ cwd: consumerDir, env: consumerEnv, timeoutMs: 10 * 60_000 },
			);
			report.commands.push(install);
			expect(install.code, commandFailure(install)).toBe(0);
			expect(existsSync(join(consumerDir, "package-lock.json")), "consumer install must create its own lockfile").toBe(true);
			expect(
				existsSync(join(
					consumerDir,
					"node_modules",
					"@earendil-works",
					"pi-coding-agent",
					"npm-shrinkwrap.json",
				)),
				"published pi-coding-agent must include its dependency-owned shrinkwrap",
			).toBe(true);

			const installedRoot = join(consumerDir, "node_modules", ...PACKAGE_INSTALL_SEGMENTS);
			const installedManifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8")) as {
				bin?: Record<string, string>;
				dependencies?: Record<string, string>;
			};
			expect(installedManifest.bin?.bobbit).toBe("dist/server/cli.js");
			for (const name of DEV_ONLY_BUNDLED_PACKAGES) {
				expect(installedManifest.dependencies?.[name], `${name} must not ship as a production dependency`).toBeUndefined();
			}
			const installedLock = JSON.parse(await readFile(join(consumerDir, "package-lock.json"), "utf8")) as {
				packages?: Record<string, { dependencies?: Record<string, string> }>;
			};
			const installedPackagePaths = Object.keys(installedLock.packages ?? {})
				.filter(path => path !== "" && /(?:^|\/)node_modules\//.test(path));
			report.packageMetrics!.installedPackageCount = installedPackagePaths.length;
			for (const name of DEV_ONLY_BUNDLED_PACKAGES) {
				const suffix = `/node_modules/${name}`;
				expect(
					installedPackagePaths.some(path => `/${path.replaceAll("\\", "/")}`.endsWith(suffix)),
					`${name} must be absent from the installed production graph`,
				).toBe(false);
			}
			const piPins = PI_PACKAGES.map(name => installedManifest.dependencies?.[name]);
			expect(piPins.every(pin => typeof pin === "string"), "packed Bobbit must declare all three Pi dependencies").toBe(true);
			expect(new Set(piPins).size, "packed Bobbit must pin all three Pi packages to one version").toBe(1);
			const selectedPiVersion = piPins[0]!;
			parseVersion(selectedPiVersion, "selected Pi pin");
			expect(selectedPiVersion, "packed Bobbit must pin Pi exactly to the supported version").toBe(REQUIRED_PI_VERSION);
			report.selectedPiVersion = selectedPiVersion;

			const lsResult = await runPiPackedConsumerNpm(
				["ls", ...INSPECTED_PACKAGES, "--all", "--json"],
				{ cwd: consumerDir, env: consumerEnv, timeoutMs: 2 * 60_000 },
			);
			report.commands.push(lsResult);
			expect(lsResult.code, commandFailure(lsResult)).toBe(0);
			const tree = parseJson(lsResult.stdout, "npm ls");
			report.tree = tree;
			expect(collectNpmProblems(tree), "npm ls must have no invalid, missing, stale, or extraneous edges").toEqual([]);
			const occurrences = collectDependencies(tree);

			for (const piPackage of PI_PACKAGES) {
				const piOccurrences = occurrences.filter(entry => entry.name === piPackage);
				expect(piOccurrences.length, `${piPackage} must appear in the packed consumer tree`).toBeGreaterThan(0);
				expect(
					[...new Set(piOccurrences.map(entry => entry.version))],
					`${piPackage} must not have mixed or stale versions`,
				).toEqual([selectedPiVersion]);
				expect(
					piOccurrences.every(entry => entry.path.includes(PACKAGE_NAME)),
					`${piPackage} must resolve through the installed Bobbit package`,
				).toBe(true);
			}

			const braceOccurrences = occurrences.filter(entry => entry.name === "brace-expansion");
			expect(braceOccurrences.length, "brace-expansion must appear in the packed consumer tree").toBeGreaterThan(0);
			expect(
				braceOccurrences.every(entry => compareVersions(entry.version, "5.0.7") >= 0),
				`every brace-expansion edge must be 5.0.7+: ${JSON.stringify(braceOccurrences)}`,
			).toBe(true);

			const protobufOccurrences = occurrences.filter(entry => entry.name === "protobufjs");
			expect(protobufOccurrences.length, "protobufjs must appear in the packed consumer tree").toBeGreaterThan(0);
			expect(
				protobufOccurrences.every(entry => compareVersions(entry.version, "7.6.5") >= 0),
				`Pi ${selectedPiVersion} must resolve every protobufjs edge to 7.6.5+: ${JSON.stringify(protobufOccurrences)}`,
			).toBe(true);

			const binariesModulePath = join(installedRoot, "dist", "server", "binaries.js");
			const binaries = await import(pathToFileURL(binariesModulePath).href) as {
				expectedBinaryPackage(): string | null;
				getFdResolution(): { source: string; path: string | null; expectedPackage: string };
				getRgResolution(): { source: string; path: string | null; expectedPackage: string };
			};
			const expectedBinaryPackage = binaries.expectedBinaryPackage();
			const resolutions = {
				fd: binaries.getFdResolution(),
				rg: binaries.getRgResolution(),
			};
			report.binaries = { expectedBinaryPackage, resolutions };
			if (expectedBinaryPackage) {
				for (const [tool, resolution] of Object.entries(resolutions)) {
					expect(resolution.source, `${tool} must resolve from ${expectedBinaryPackage}`).toBe("bundled");
					expect(resolution.expectedPackage).toBe(expectedBinaryPackage);
					expect(resolution.path, `${tool} bundled resolution must have a path`).not.toBeNull();
					expect(existsSync(resolution.path!), `${tool} binary does not exist at ${resolution.path}`).toBe(true);
					const smoke = await runPiPackedConsumerCommand(resolution.path!, ["--version"], {
						cwd: consumerDir,
						env: consumerEnv,
						timeoutMs: 30_000,
					});
					report.commands.push(smoke);
					expect(smoke.code, commandFailure(smoke)).toBe(0);
					expect(`${smoke.stdout}\n${smoke.stderr}`.trim(), `${tool} --version must print its version`).not.toBe("");
				}
			} else {
				testInfo.annotations.push({
					type: "unsupported-binary-platform",
					description: `${process.platform}-${process.arch} has no published Bobbit binary package`,
				});
			}
			for (const required of [
				join(installedRoot, "dist", "server", "cli.js"),
				join(installedRoot, "dist", "ui", "index.html"),
				join(installedRoot, "src", "ui", "app.css"),
			]) expect(existsSync(required), `clean consumer is missing ${required}`).toBe(true);
			await expectIndexAssetsExist(installedRoot);

			report.bridgeAssets = await findBridgeAssets(installedRoot);

			const port = await getFreePort();
			const baseUrl = `http://127.0.0.1:${port}`;
			const wsBaseUrl = `ws://127.0.0.1:${port}`;
			runtime = startPackagedCli({
				cliPath: join(installedRoot, "dist", "server", "cli.js"),
				consumerDir,
				workspaceDir,
				agentPath,
				secretsDir,
				agentDir,
				port,
			});
			await waitForHealth(baseUrl, runtime);
			const rootResponse = await fetch(`${baseUrl}/`);
			expect(rootResponse.status, "packaged CLI must serve its sibling dist/ui index").toBe(200);
			expect(await rootResponse.text()).toMatch(/assets\//);

			const token = await readToken(secretsDir);
			const preferenceHeaders = {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			};
			const providerSeed = await fetch(`${baseUrl}/api/preferences`, {
				method: "PUT",
				headers: preferenceHeaders,
				body: JSON.stringify({
					customProviders: [{
						id: "mock",
						name: "mock",
						type: "manual",
						baseUrl: "http://127.0.0.1",
						models: [{ id: "mock-model", name: "mock-model" }],
					}],
				}),
			});
			expect(
				providerSeed.ok,
				`failed to register packaged mock provider: ${providerSeed.status} ${await providerSeed.clone().text()}`,
			).toBe(true);
			const defaultSeed = await fetch(`${baseUrl}/api/preferences`, {
				method: "PUT",
				headers: preferenceHeaders,
				body: JSON.stringify({
					palette: "ocean",
					"default.sessionModel": "mock/mock-model",
					"default.sessionThinkingLevel": "off",
				}),
			});
			expect(
				defaultSeed.ok,
				`failed to select packaged mock default and ocean palette: ${defaultSeed.status} ${await defaultSeed.clone().text()}`,
			).toBe(true);
			expect(await defaultSeed.json()).toMatchObject({
				palette: "ocean",
				"default.sessionModel": "mock/mock-model",
				"default.sessionThinkingLevel": "off",
			});
			const sessionId = await createProjectAndSession(baseUrl, token, workspaceDir);

			page.on("request", request => report.requests.push(request.url()));
			await page.addInitScript(() => {
				localStorage.setItem("theme", "light");
				localStorage.setItem("palette", "ocean");
			});
			await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 30_000 });
			// The sidebar appears in the initial gateway-starting render, before the
			// asynchronous preference load. Wait for the app's explicit end-of-boot
			// marker so a delayed preference/session lifecycle cannot clear this
			// host palette while the iframe bridge is being observed.
			await expect(page.locator("body")).toHaveAttribute("data-shortcuts-ready", "1", { timeout: 30_000 });
			await page.evaluate(() => {
				const root = document.documentElement;
				root.classList.remove("dark");
				root.setAttribute("data-palette", "ocean");
				localStorage.setItem("theme", "light");
				localStorage.setItem("palette", "ocean");
			});
			// Emit only after the host theme lifecycle is settled. This makes the
			// generated inline document's parse-time bridge observe a stable host.
			await promptSession(wsBaseUrl, sessionId, token);
			await page.evaluate(id => { window.location.hash = `#/session/${id}`; }, sessionId);

			const iframe = page.locator('iframe[title="theme-card.html"]');
			await expect(iframe).toBeVisible({ timeout: 30_000 });
			await expect.poll(
				async () => (await iframeTheme(page)).capture?.background ?? "",
				{ timeout: 20_000, message: "authored parse-time capture must run after the injected bridge" },
			).not.toBe("");

			const initialHost = await hostTheme(page);
			const initialFrame = await iframeTheme(page);
			expect(initialHost.dark).toBe(false);
			expect(initialHost.palette).toBe("ocean");
			expect(
				report.bridgeAssets.length,
				"PACKAGED_INLINE_THEME_BRIDGE_MISSING: compiled dist/ui assets must include the canonical preview theme bridge",
			).toBeGreaterThan(0);
			expect(initialFrame.authoredScriptRan).toBe(true);
			expect(initialFrame.canonicalBridgeCount, "inline srcdoc must contain exactly one canonical theme bridge").toBe(1);
			expect(initialFrame.swipeBridgeCount, "inline chat cards must not receive the side-panel swipe bridge").toBe(0);
			expect(initialFrame.capture).not.toBeNull();
			expectThemeMatches(initialFrame.capture!, initialHost, "parse-time inline capture");
			expectThemeMatches(initialFrame.current, initialHost, "initial inline computed theme");

			await iframe.evaluate(element => {
				const frameWindow = (element as HTMLIFrameElement).contentWindow as (Window & {
					__packedFrameIdentity?: string;
				}) | null;
				if (frameWindow) frameWindow.__packedFrameIdentity = "same-packaged-iframe";
			});
			await page.evaluate(() => {
				const root = document.documentElement;
				root.classList.add("dark");
				root.setAttribute("data-palette", "rose");
				localStorage.setItem("theme", "dark");
				localStorage.setItem("palette", "rose");
			});
			const switchedHost = await hostTheme(page);
			expect(switchedHost.dark).toBe(true);
			expect(switchedHost.palette).toBe("rose");
			await expect.poll(
				async () => {
					const state = await iframeTheme(page);
					return {
						dark: state.current.dark,
						palette: state.current.palette,
						background: state.current.background,
						identity: state.identity,
					};
				},
				{ timeout: 20_000, message: "packaged iframe must mirror a live host theme/palette switch" },
			).toEqual({
				dark: true,
				palette: "rose",
				background: switchedHost.background,
				identity: "same-packaged-iframe",
			});
			const switchedFrame = await iframeTheme(page);
			expectThemeMatches(switchedFrame.current, switchedHost, "live-switched inline computed theme");
			expect(switchedFrame.canonicalBridgeCount).toBe(1);
			const palettePersist = await fetch(`${baseUrl}/api/preferences`, {
				method: "PUT",
				headers: preferenceHeaders,
				body: JSON.stringify({ palette: "rose" }),
			});
			expect(
				palettePersist.ok,
				`failed to persist packaged rose palette: ${palettePersist.status} ${await palettePersist.clone().text()}`,
			).toBe(true);

			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("body")).toHaveAttribute("data-shortcuts-ready", "1", { timeout: 30_000 });
			const reloadedIframe = page.locator('iframe[title="theme-card.html"]');
			await expect(reloadedIframe).toBeVisible({ timeout: 30_000 });
			await expect.poll(
				async () => (await iframeTheme(page)).capture?.background ?? "",
				{ timeout: 20_000, message: "packaged inline bridge must execute after a full browser reload" },
			).not.toBe("");
			const reloadedHost = await hostTheme(page);
			const reloadedFrame = await iframeTheme(page);
			expect(reloadedHost.palette).toBe("rose");
			expect(reloadedFrame.authoredScriptRan).toBe(true);
			expect(reloadedFrame.canonicalBridgeCount).toBe(1);
			expectThemeMatches(reloadedFrame.capture!, reloadedHost, "reloaded parse-time inline capture");
			expectThemeMatches(reloadedFrame.current, reloadedHost, "reloaded inline computed theme");

			const sourceRuntimeRequests = report.requests.filter(rawUrl => {
				const url = new URL(rawUrl);
				return url.pathname.startsWith("/src/") || decodeURIComponent(url.pathname).includes(SOURCE_BRIDGE_PATH);
			});
			expect(
				sourceRuntimeRequests,
				"packaged dist/ui must not resolve the canonical bridge from source at browser runtime",
			).toEqual([]);
			for (const tokenName of THEME_TOKENS) {
				expect(await page.evaluate(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), tokenName)).not.toBe("");
			}
		} finally {
			if (runtime) {
				await stopPackagedCli(runtime);
				report.cliStdout = runtime.stdout.join("");
				report.cliStderr = runtime.stderr.join("");
			}
			await attachReport(testInfo, report);
			await rm(tempRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
		}
	});
});
