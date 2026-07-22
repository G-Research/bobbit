import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
	cleanConsumerNpmEnv,
	commandFailure,
	createProjectAndSession,
	getFreePort,
	promptSession,
	readToken,
	runNpm,
	startPackagedCli,
	stopPackagedCli,
	waitForHealth,
	writePackedAgent,
	type CommandResult,
	type RunningCli,
} from "./packaged-runtime-helpers.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const CANONICAL_BRIDGE_SIGNATURE = "parent.document.styleSheets";
const SOURCE_BRIDGE_PATH = "src/shared/preview-bridge-scripts.ts";
const THEME_TOKENS = ["--background", "--foreground", "--card", "--positive", "--chart-1"] as const;

interface PackEntry {
	name?: string;
	filename?: string;
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
	packFiles: string[];
	bridgeAssets: string[];
	requests: string[];
	cliStdout?: string;
	cliStderr?: string;
}

function parsePackResult(stdout: string): PackEntry {
	let parsed: unknown;
	try { parsed = JSON.parse(stdout); } catch (error) {
		throw new Error(`npm pack emitted malformed JSON: ${(error as Error).message}\nstdout:\n${stdout}`);
	}
	expect(Array.isArray(parsed), "npm pack --json must return an array").toBe(true);
	expect(parsed).toHaveLength(1);
	return (parsed as PackEntry[])[0]!;
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
		const scripts = [...iframe.contentDocument!.scripts].map(script => script.textContent ?? "");
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
			canonicalBridgeCount: scripts.filter(script => script.includes("parent.document.styleSheets")).length,
			swipeBridgeCount: scripts.filter(script => script.includes("preview-swipe-start")).length,
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
			const packed = await runNpm(
				["pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
				{ cwd: REPO_ROOT, timeoutMs: 3 * 60_000 },
			);
			report.commands.push(packed);
			expect(packed.code, commandFailure(packed)).toBe(0);
			const pack = parsePackResult(packed.stdout);
			expect(pack.name).toBe("bobbit");
			expect(typeof pack.filename).toBe("string");
			report.packFiles = normalizedPackagePaths(pack);
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

			const tarballPath = join(packDir, pack.filename!);
			expect(existsSync(tarballPath), `npm pack did not create ${tarballPath}`).toBe(true);
			const install = await runNpm(
				["install", tarballPath, "--no-audit", "--no-fund", "--omit=optional"],
				{ cwd: consumerDir, env: cleanConsumerNpmEnv(consumerDir), timeoutMs: 10 * 60_000 },
			);
			report.commands.push(install);
			expect(install.code, commandFailure(install)).toBe(0);

			const installedRoot = join(consumerDir, "node_modules", "bobbit");
			const installedManifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8")) as {
				bin?: Record<string, string>;
			};
			expect(installedManifest.bin?.bobbit).toBe("dist/server/cli.js");
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
			const sessionId = await createProjectAndSession(baseUrl, token, workspaceDir);
			await promptSession(wsBaseUrl, sessionId, token);

			page.on("request", request => report.requests.push(request.url()));
			await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 30_000 });
			await page.evaluate(() => {
				document.documentElement.classList.remove("dark");
				document.documentElement.setAttribute("data-palette", "forest");
			});
			await page.evaluate(id => { window.location.hash = `#/session/${id}`; }, sessionId);

			const iframe = page.locator('iframe[title="theme-card.html"]');
			await expect(iframe).toBeVisible({ timeout: 30_000 });
			await expect.poll(
				async () => (await iframeTheme(page)).capture?.background ?? "",
				{ timeout: 20_000, message: "authored parse-time capture must run after the injected bridge" },
			).not.toBe("");

			const initialHost = await hostTheme(page);
			const initialFrame = await iframeTheme(page);
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
				document.documentElement.classList.add("dark");
				document.documentElement.setAttribute("data-palette", "ocean");
			});
			const switchedHost = await hostTheme(page);
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
				palette: "ocean",
				background: switchedHost.background,
				identity: "same-packaged-iframe",
			});
			const switchedFrame = await iframeTheme(page);
			expectThemeMatches(switchedFrame.current, switchedHost, "live-switched inline computed theme");
			expect(switchedFrame.canonicalBridgeCount).toBe(1);

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
