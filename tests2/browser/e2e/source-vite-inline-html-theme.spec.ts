import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createProjectAndSession,
	getFreePort,
	promptSession,
	readToken,
	waitForHealth,
} from "./packaged-runtime-helpers.js";
import {
	processFailure,
	startIsolatedSourceGateway,
	startSourceVite,
	stopSourceProcess,
	waitForSourceVite,
	writeSourceViteAgent,
	type RunningSourceProcess,
} from "./source-vite-runtime-helpers.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const SOURCE_MODULE_PATHS = {
	main: "/src/app/main.ts",
	htmlRenderer: "/src/ui/tools/renderers/HtmlRenderer",
	canonicalBridge: "/src/shared/preview-bridge-scripts",
};

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

interface InlineFrameState {
	capture: ThemeState | null;
	current: ThemeState;
	authoredScriptRan: boolean;
	canonicalBridgeCount: number;
	swipeBridgeCount: number;
	snapshotStyleCount: number;
	identity: string | null;
	srcdoc: string;
}

interface RuntimeReport {
	requests: string[];
	responses: Array<{ path: string; status: number }>;
	gatewayStdout?: string;
	gatewayStderr?: string;
	viteStdout?: string;
	viteStderr?: string;
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

async function inlineFrameState(page: Page): Promise<InlineFrameState> {
	return page.locator('iframe[title="theme-card.html"]').evaluate((element) => {
		const iframe = element as HTMLIFrameElement;
		const frameWindow = iframe.contentWindow as (Window & {
			__sourceViteThemeCapture?: ThemeState;
			__sourceViteFrameIdentity?: string;
		}) | null;
		const frameDocument = iframe.contentDocument!;
		const root = frameDocument.documentElement;
		const scripts = [...frameDocument.scripts];
		const style = iframe.contentWindow!.getComputedStyle(root);
		return {
			capture: frameWindow?.__sourceViteThemeCapture ?? null,
			current: {
				background: style.getPropertyValue("--background").trim(),
				foreground: style.getPropertyValue("--foreground").trim(),
				card: style.getPropertyValue("--card").trim(),
				positive: style.getPropertyValue("--positive").trim(),
				chart: style.getPropertyValue("--chart-1").trim(),
				font: style.fontFamily,
				dark: root.classList.contains("dark"),
				palette: root.getAttribute("data-palette"),
			},
			authoredScriptRan: root.getAttribute("data-source-vite-authored-script") === "true",
			canonicalBridgeCount: scripts.filter(script => script.hasAttribute("data-bobbit-inline-theme-bridge")).length,
			swipeBridgeCount: scripts.filter(script => (script.textContent ?? "").includes("preview-swipe-start")).length,
			snapshotStyleCount: frameDocument.querySelectorAll('style[data-bobbit-preview-theme="snapshot"]').length,
			identity: frameWindow?.__sourceViteFrameIdentity ?? null,
			srcdoc: iframe.srcdoc,
		};
	});
}

function expectThemeMatches(actual: ThemeState, expected: ThemeState, label: string): void {
	for (const key of ["background", "foreground", "card", "positive", "chart"] as const) {
		expect(actual[key], `${label} ${key} must be resolved`).not.toBe("");
		expect(actual[key], `${label} ${key} must match the Vite host stylesheet`).toBe(expected[key]);
	}
	expect(actual.font, `${label} font stack must be resolved`).not.toBe("");
	expect(actual.font, `${label} font stack must match the Vite host`).toBe(expected.font);
	expect(actual.dark, `${label} dark state must match the Vite host`).toBe(expected.dark);
	expect(actual.palette, `${label} palette must match the Vite host`).toBe(expected.palette);
}

function sanitizedRequestUrl(rawUrl: string): string {
	const url = new URL(rawUrl);
	return `${url.origin}${url.pathname}`;
}

function processLog(runtime: RunningSourceProcess | undefined): { stdout?: string; stderr?: string } {
	if (!runtime) return {};
	return {
		stdout: runtime.stdout.join("").slice(-20_000),
		stderr: runtime.stderr.join("").slice(-20_000),
	};
}

async function attachReport(testInfo: TestInfo, report: RuntimeReport): Promise<void> {
	await testInfo.attach("source-vite-inline-theme-report.json", {
		body: Buffer.from(`${JSON.stringify(report, null, 2)}\n`),
		contentType: "application/json",
	});
}

// This is a real source-runtime smoke. It intentionally owns both child
// processes rather than relying on Playwright's compiled-dist gateway fixture.
test.describe("source Vite inline HTML theme runtime", () => {
	test.describe.configure({ retries: 0 });

	test("real chat WriteRenderer uses the canonical source bridge at parse time and across a live theme switch", async ({ page }, testInfo) => {
		test.setTimeout(4 * 60_000);
		const tempRoot = await mkdtemp(join(tmpdir(), "bobbit-source-vite-inline-theme-"));
		const workspaceDir = join(tempRoot, "workspace");
		const agentPath = join(tempRoot, "source-vite-write-agent.mjs");
		const report: RuntimeReport = { requests: [], responses: [] };
		let gateway: RunningSourceProcess | undefined;
		let vite: RunningSourceProcess | undefined;

		try {
			await mkdir(workspaceDir, { recursive: true });
			await writeSourceViteAgent(agentPath);

			const gatewayPort = await getFreePort();
			const vitePort = await getFreePort();
			const gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}`;
			const gatewayWsUrl = `ws://127.0.0.1:${gatewayPort}`;
			const viteBaseUrl = `http://127.0.0.1:${vitePort}`;

			gateway = startIsolatedSourceGateway({
				repoRoot: REPO_ROOT,
				tempRoot,
				workspaceDir,
				agentPath,
				port: gatewayPort,
			});
			await waitForHealth(gatewayBaseUrl, gateway, 120_000);
			const token = await readToken(join(tempRoot, "secrets"));
			const sessionId = await createProjectAndSession(gatewayBaseUrl, token, workspaceDir);
			await promptSession(gatewayWsUrl, sessionId, token);

			vite = startSourceVite({
				repoRoot: REPO_ROOT,
				tempRoot,
				gatewayUrl: gatewayBaseUrl,
				port: vitePort,
			});
			await waitForSourceVite(viteBaseUrl, vite);

			page.on("request", request => report.requests.push(sanitizedRequestUrl(request.url())));
			page.on("response", response => {
				const url = new URL(response.url());
				if (url.origin === viteBaseUrl) report.responses.push({ path: url.pathname, status: response.status() });
			});
			await page.addInitScript(() => {
				localStorage.setItem("theme", "light");
				localStorage.setItem("palette", "ocean");
			});
			await page.goto(`${viteBaseUrl}/?token=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 30_000 });

			// Set a known light/palette host state only after boot preferences have
			// settled, then navigate to the already-completed real Write tool call.
			await page.evaluate(() => {
				const root = document.documentElement;
				root.classList.remove("dark");
				root.setAttribute("data-palette", "ocean");
				localStorage.setItem("theme", "light");
				localStorage.setItem("palette", "ocean");
			});
			await page.evaluate(id => { window.location.hash = `#/session/${id}`; }, sessionId);

			const iframe = page.locator('iframe[title="theme-card.html"]');
			await expect(iframe).toBeVisible({ timeout: 30_000 });
			await expect.poll(
				async () => (await inlineFrameState(page)).capture?.background ?? "",
				{ timeout: 20_000, message: "authored head script must capture tokens synchronously after the injected bridge" },
			).not.toBe("");

			const initialHost = await hostTheme(page);
			const initialFrame = await inlineFrameState(page);
			expect(initialHost.dark).toBe(false);
			expect(initialHost.palette).toBe("ocean");
			expect(initialFrame.authoredScriptRan).toBe(true);
			expect(initialFrame.canonicalBridgeCount, "inline srcdoc must contain exactly one canonical bridge").toBe(1);
			expect(initialFrame.swipeBridgeCount, "inline chat iframe must not receive side-panel swipe forwarding").toBe(0);
			expect(initialFrame.snapshotStyleCount, "inline srcdoc must not use the standalone server-filesystem theme snapshot").toBe(0);
			expect(initialFrame.capture).not.toBeNull();
			expectThemeMatches(initialFrame.capture!, initialHost, "parse-time authored capture");
			expectThemeMatches(initialFrame.current, initialHost, "initial inline computed theme");
			expect(initialFrame.srcdoc).toContain("data-bobbit-inline-theme-bridge");
			expect(initialFrame.srcdoc).not.toContain("data-bobbit-preview-theme=\"snapshot\"");
			expect(initialFrame.srcdoc).not.toContain("preview-swipe-start");

			await iframe.evaluate(element => {
				const frameWindow = (element as HTMLIFrameElement).contentWindow as (Window & {
					__sourceViteFrameIdentity?: string;
				}) | null;
				if (frameWindow) frameWindow.__sourceViteFrameIdentity = "same-source-vite-iframe";
			});
			await page.evaluate(() => {
				const root = document.documentElement;
				root.classList.add("dark");
				root.setAttribute("data-palette", "rose");
				localStorage.setItem("theme", "dark");
				localStorage.setItem("palette", "rose");
			});
			const switchedHost = await hostTheme(page);
			await expect.poll(
				async () => {
					const state = await inlineFrameState(page);
					return {
						background: state.current.background,
						dark: state.current.dark,
						palette: state.current.palette,
						identity: state.identity,
					};
				},
				{ timeout: 20_000, message: "the same inline iframe must mirror the live host theme and palette" },
			).toEqual({
				background: switchedHost.background,
				dark: true,
				palette: "rose",
				identity: "same-source-vite-iframe",
			});

			const switchedFrame = await inlineFrameState(page);
			expect(switchedFrame.srcdoc, "a live host switch must not recreate or rewrite the tool call iframe").toBe(initialFrame.srcdoc);
			expect(switchedFrame.capture, "the authored parse-time script must not rerun during a live switch").toEqual(initialFrame.capture);
			expectThemeMatches(switchedFrame.current, switchedHost, "live-switched inline computed theme");
			expect(switchedFrame.current.background).not.toBe(initialFrame.current.background);
			expect(switchedFrame.canonicalBridgeCount).toBe(1);

			const viteRequestPaths = report.requests
				.map(rawUrl => new URL(rawUrl))
				.filter(url => url.origin === viteBaseUrl)
				.map(url => decodeURIComponent(url.pathname));
			expect(viteRequestPaths, "browser must load the real Vite source entry").toContain(SOURCE_MODULE_PATHS.main);
			expect(
				viteRequestPaths.some(pathname => pathname.startsWith(SOURCE_MODULE_PATHS.htmlRenderer)),
				"actual chat rendering must load HtmlRenderer from Vite's source module graph",
			).toBe(true);
			expect(
				viteRequestPaths.some(pathname => pathname.startsWith(SOURCE_MODULE_PATHS.canonicalBridge)),
				"HtmlRenderer's Vite graph must load the canonical shared preview theme bridge source module",
			).toBe(true);
			expect(
				viteRequestPaths.some(pathname => pathname.includes("/dist/ui/")),
				"source-mode browser must not load compiled dist/ui assets",
			).toBe(false);
			expect(
				viteRequestPaths.some(pathname => pathname.includes("theme-snapshot") || pathname.startsWith("/preview/")),
				"inline source-mode rendering must not request the server filesystem snapshot or standalone preview route",
			).toBe(false);

			for (const sourcePath of Object.values(SOURCE_MODULE_PATHS)) {
				const sourceResponses = report.responses.filter(response => response.path.startsWith(sourcePath));
				expect(sourceResponses.length, `${sourcePath} must be served through Vite's source graph`).toBeGreaterThan(0);
				for (const response of sourceResponses) expect(response.status, `${response.path} must be served by Vite`).toBe(200);
			}
		} catch (error) {
			if (gateway && gateway.child.exitCode !== null) throw processFailure(gateway, `failed during test: ${String(error)}`);
			if (vite && vite.child.exitCode !== null) throw processFailure(vite, `failed during test: ${String(error)}`);
			throw error;
		} finally {
			await page.close().catch(() => undefined);
			if (vite) await stopSourceProcess(vite);
			if (gateway) await stopSourceProcess(gateway);
			const gatewayLog = processLog(gateway);
			const viteLog = processLog(vite);
			report.gatewayStdout = gatewayLog.stdout;
			report.gatewayStderr = gatewayLog.stderr;
			report.viteStdout = viteLog.stdout;
			report.viteStderr = viteLog.stderr;
			await attachReport(testInfo, report);
			await rm(tempRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
		}
	});
});
