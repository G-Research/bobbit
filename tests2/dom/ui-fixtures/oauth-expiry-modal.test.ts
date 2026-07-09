import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/ui-fixtures/oauth-expiry-modal.spec.ts (v2-dom tier).
// The legacy spec esbuild-bundled tests/ui-fixtures/oauth-expiry-modal-entry.ts,
// which drives the REAL authenticateGateway() → provider-neutral OAuth expiry
// modal path (dialogs.showOAuthExpiryModal via dialogs-lazy) plus the Account-tab
// re-auth flow. This port imports the SAME real modules and replicates the entry's
// window helpers + fetch mock as module functions under happy-dom.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let authenticateGateway: typeof import("../../../src/app/session-manager.js").authenticateGateway;
let stopSessionPolling: () => void = () => {};
let stopSessionListPushSync: () => void = () => {};
let renderAccountTab: typeof import("../../../src/app/settings-page.js").renderAccountTab;
let __testResetAccountTab: typeof import("../../../src/app/settings-page.js").__testResetAccountTab;
let setRenderApp: typeof import("../../../src/app/state.js").setRenderApp;
let render: typeof import("lit").render;

type OAuthStatus = { authenticated: boolean; expires?: number };
type ProviderId = "anthropic" | "openai-codex" | "google-gemini-cli";
type StatusMap = Partial<Record<ProviderId, OAuthStatus>>;
type StatusFailureMode = "non-2xx" | "network-error" | "invalid-json";

const GATEWAY_URL = "https://oauth-expiry.fixture";
const GATEWAY_TOKEN = "fixture-token";

const ANTHROPIC_EXPIRES = 1_700_000_001_000;
const OPENAI_EXPIRES = 1_700_000_002_000;
const GOOGLE_EXPIRES = 1_700_000_003_000;
const GOOGLE_EXPIRES_CHANGED = 1_700_000_004_000;

const TRANSIENT_STATUS_FAILURE_CASES = [
	["non-2xx", "non-2xx"],
	["network error", "network-error"],
	["invalid JSON", "invalid-json"],
] as const satisfies readonly (readonly [string, StatusFailureMode])[];

// ── module state (ported from the entry) ────────────────────────────────────
let statuses: StatusMap = {};
let statusFailures: Partial<Record<ProviderId, StatusFailureMode>> = {};
let allowOAuthStart = false;
let nextFlowId = 0;
const oauthFlowProviders = new Map<string, ProviderId>();
let accountTabMounted = false;

function installGatewayStorage(): void {
	localStorage.setItem("gateway.url", GATEWAY_URL);
	localStorage.setItem("gateway.token", GATEWAY_TOKEN);
}
function normalizeUrl(input: any): string {
	const raw = typeof input === "string" ? input : (input as Request).url;
	try { const u = new URL(raw, window.location.href); return u.pathname + u.search; } catch { return raw; }
}
function jsonResponse(body: any, init: { ok?: boolean; status?: number } = {}): Response {
	const status = init.status ?? (init.ok === false ? 500 : 200);
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function invalidJsonResponse(): Response {
	return new Response("{", { status: 200, headers: { "Content-Type": "application/json" } });
}
function statusFor(path: string): Response | null {
	if (!path.startsWith("/api/oauth/status")) return null;
	const url = new URL(path, "https://fixture.local");
	const provider = url.searchParams.get("provider") as ProviderId | null;
	if (!provider) return jsonResponse({ authenticated: false });
	const failure = statusFailures[provider];
	if (failure === "network-error") throw new Error(`simulated ${provider} status network error`);
	if (failure === "invalid-json") return invalidJsonResponse();
	if (failure === "non-2xx") return jsonResponse({ error: "simulated status failure" }, { status: 503 });
	return jsonResponse(statuses[provider] ?? { authenticated: false });
}
function installFetchMock() {
	vi.stubGlobal("fetch", async (input: any, init?: any) => {
		const path = normalizeUrl(input);
		const method = (init?.method || "GET").toUpperCase();
		let body: any = null;
		if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
		void method;

		if (path.includes("/side-panel-workspace")) return jsonResponse({ version: 1, tabs: [], activeTabId: "", sizeMode: "split" });
		if (path === "/api/health") return jsonResponse({ localhost: false, aigw: false, setupComplete: true, orphanedTranscripts: 0 });
		const oauthStatus = statusFor(path);
		if (oauthStatus) return oauthStatus;
		if (path === "/api/oauth/start") {
			if (!allowOAuthStart) return jsonResponse({ error: "legacy OAuth flow should not start for expiry reminders" }, { ok: false, status: 500 });
			const provider = body?.provider as ProviderId;
			const flowId = `flow-${++nextFlowId}`;
			oauthFlowProviders.set(flowId, provider);
			return jsonResponse({ flowId, url: `https://oauth.example/${provider}/${flowId}`, callbackServer: false });
		}
		if (path === "/api/oauth/complete") {
			const provider = oauthFlowProviders.get(body?.flowId);
			if (!provider) return jsonResponse({ success: false, error: "unknown flow" });
			statuses[provider] = { authenticated: true, expires: Date.now() + 86_400_000 };
			delete statusFailures[provider];
			return jsonResponse({ success: true });
		}
		if (path.startsWith("/api/sessions")) return jsonResponse({ sessions: [], archivedDelegates: [], generation: 0 });
		if (path.startsWith("/api/goals")) return jsonResponse({ goals: [], generation: 0 });
		if (path === "/api/projects") return jsonResponse([]);
		if (path === "/api/config/cwd") return jsonResponse({ cwd: "" });
		if (path === "/api/pr-status-cache") return jsonResponse({});
		if (path.startsWith("/api/gates/status")) return jsonResponse({});
		if (path.startsWith("/api/search/stats")) return jsonResponse({});
		return jsonResponse({});
	});
}

function renderAccountFixture(): void {
	if (!accountTabMounted) return;
	const container = document.getElementById("container");
	if (!container) return;
	render(renderAccountTab(), container);
}

async function runGatewayAuth(): Promise<void> {
	try { await authenticateGateway(GATEWAY_URL, GATEWAY_TOKEN); } catch { /* indeterminate */ }
}
function startGatewayAuth(): void { void runGatewayAuth(); }

function resetFixture(next: StatusMap = {}): void {
	localStorage.clear();
	sessionStorage.clear();
	installGatewayStorage();
	statuses = { ...next };
	statusFailures = {};
	allowOAuthStart = false;
	nextFlowId = 0;
	oauthFlowProviders.clear();
	accountTabMounted = false;
	__testResetAccountTab({ status: {} });
	const container = document.getElementById("container");
	if (container) render(null, container);
	window.location.hash = "";
}

async function loadFixture(next: StatusMap, opts: { preserveStorage?: boolean } = {}): Promise<void> {
	if (opts.preserveStorage) statuses = { ...next };
	else resetFixture(next);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const buttons = () => Array.from(document.body.querySelectorAll("button")) as HTMLButtonElement[];
function buttonByText(text: string): HTMLButtonElement | undefined {
	return buttons().find((b) => (b.textContent || "").trim() === text);
}
const modalPrimary = () => buttonByText("Go to Account Settings");
const modalDismiss = () => buttonByText("Dismiss");

async function waitForModal(timeout = 3000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (modalPrimary()) return;
		await sleep(15);
	}
	throw new Error("timeout waiting for OAuth expiry modal");
}
async function expectExpiryModalFor(providerNames: string[]): Promise<void> {
	await waitForModal();
	expect(modalPrimary()).toBeTruthy();
	expect(modalDismiss()).toBeTruthy();
	for (const name of providerNames) expect(document.body.textContent || "").toContain(name);
}
function dismissedReminderIds(): string[] {
	return JSON.parse(localStorage.getItem("bobbit.oauthExpiry.dismissed.v1") || "[]");
}
function closeModalIfOpen(): void {
	// Close via the primary handler (cleanup + reset internal open flag) without the
	// localStorage side effects of Dismiss.
	modalPrimary()?.click();
}

beforeAll(async () => {
	({ render } = await import("lit"));
	await import("../../../src/app/session-manager.js");
	({ authenticateGateway } = await import("../../../src/app/session-manager.js"));
	// authenticateGateway() starts background session pollers (setInterval poll +
	// push-sync WebSocket + reconnect timers) that otherwise leak across files and
	// throw fire-and-forget "document/localStorage is not defined" / "Connection
	// timed out" stragglers under isolate:false. Capture their stop fns to shut
	// them down in teardown.
	({ stopSessionPolling, stopSessionListPushSync } = await import("../../../src/app/api.js"));
	({ renderAccountTab, __testResetAccountTab } = await import("../../../src/app/settings-page.js"));
	({ setRenderApp } = await import("../../../src/app/state.js"));
	(window as any).open = () => null;
	setRenderApp(renderAccountFixture);
	__syncCE();
});

beforeEach(() => {
	installFetchMock();
	document.body.innerHTML = '<div id="container"></div>';
	closeModalIfOpen();
});

afterEach(async () => {
	stopSessionPolling();
	stopSessionListPushSync();
	await sleep(30);
	closeModalIfOpen();
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
	window.location.hash = "";
});

// The render callback is installed once in beforeAll, so it must be neutralized
// once here (not per-test) — otherwise a debounced straggler render scheduled by
// this file fires renderAccountFixture into a torn-down / foreign container
// under isolate:false (the state module is shared across files).
afterAll(() => { setRenderApp(() => {}); stopSessionPolling(); stopSessionListPushSync(); });

describe("OAuth expiry modal fixture (v2-dom)", () => {
	const expired = (expires: number): OAuthStatus => ({ authenticated: false, expires });
	const authed = (): OAuthStatus => ({ authenticated: true, expires: Date.now() + 86_400_000 });

	it("expired existing credentials for every account provider show one provider-neutral modal", async () => {
		await loadFixture({ anthropic: expired(ANTHROPIC_EXPIRES), "openai-codex": expired(OPENAI_EXPIRES), "google-gemini-cli": expired(GOOGLE_EXPIRES) });
		startGatewayAuth();
		await expectExpiryModalFor(["Anthropic", "OpenAI", "Google"]);
		expect(buttons().map((b) => (b.textContent || "").trim())).toEqual(["Dismiss", "Go to Account Settings"]);
	});

	it("never-authenticated or missing credentials do not show the expiry modal or launch legacy OAuth", async () => {
		await loadFixture({ anthropic: { authenticated: false }, "openai-codex": { authenticated: false }, "google-gemini-cli": { authenticated: false } });
		startGatewayAuth();
		await sleep(250);
		expect(modalPrimary()).toBeUndefined();
		expect(document.body.textContent || "").not.toMatch(/Anthropic Login|OpenAI Login|Google Login/);
	});

	for (const [name, mode] of TRANSIENT_STATUS_FAILURE_CASES) {
		it(`transient ${name} OAuth status failures do not show the expiry modal`, async () => {
			await loadFixture({ anthropic: expired(ANTHROPIC_EXPIRES), "openai-codex": { authenticated: false }, "google-gemini-cli": { authenticated: false } });
			statusFailures = { anthropic: mode };
			await runGatewayAuth();
			await sleep(100);
			expect(modalPrimary()).toBeUndefined();
		});
	}

	it("dismiss suppresses the same provider plus expiry reminder across auth checks and reloads", async () => {
		const statusesInit = { anthropic: authed(), "openai-codex": { authenticated: false }, "google-gemini-cli": expired(GOOGLE_EXPIRES) } satisfies StatusMap;
		await loadFixture(statusesInit);

		await runGatewayAuth();
		await expectExpiryModalFor(["Google"]);
		modalDismiss()!.click();
		expect(modalPrimary()).toBeUndefined();

		await runGatewayAuth();
		await sleep(100);
		expect(modalPrimary()).toBeUndefined();

		await loadFixture(statusesInit, { preserveStorage: true });
		await runGatewayAuth();
		await sleep(100);
		expect(modalPrimary()).toBeUndefined();
	});

	it("a different expired provider resurfaces the modal after dismissing another provider", async () => {
		await loadFixture({ anthropic: authed(), "openai-codex": { authenticated: false }, "google-gemini-cli": expired(GOOGLE_EXPIRES) });
		await runGatewayAuth();
		await expectExpiryModalFor(["Google"]);
		modalDismiss()!.click();

		statuses = { anthropic: authed(), "openai-codex": expired(OPENAI_EXPIRES), "google-gemini-cli": expired(GOOGLE_EXPIRES) };
		await runGatewayAuth();
		await expectExpiryModalFor(["OpenAI"]);
	});

	it("a changed expiry timestamp resurfaces the modal for the same provider", async () => {
		await loadFixture({ anthropic: authed(), "openai-codex": { authenticated: false }, "google-gemini-cli": expired(GOOGLE_EXPIRES) });
		await runGatewayAuth();
		await expectExpiryModalFor(["Google"]);
		modalDismiss()!.click();

		statuses = { anthropic: authed(), "openai-codex": { authenticated: false }, "google-gemini-cli": expired(GOOGLE_EXPIRES_CHANGED) };
		await runGatewayAuth();
		await expectExpiryModalFor(["Google"]);
	});

	it("Go to Account Settings closes the modal and navigates to the Account tab", async () => {
		await loadFixture({ anthropic: authed(), "openai-codex": { authenticated: false }, "google-gemini-cli": expired(GOOGLE_EXPIRES) });
		await runGatewayAuth();
		await expectExpiryModalFor(["Google"]);

		modalPrimary()!.click();
		expect(window.location.hash).toBe("#/settings/system/account");
		expect(modalPrimary()).toBeUndefined();
	});

	it("successful Account-tab re-authentication clears dismissed expiry reminders for that provider", async () => {
		await loadFixture({ anthropic: authed(), "openai-codex": { authenticated: false }, "google-gemini-cli": expired(GOOGLE_EXPIRES) });
		await runGatewayAuth();
		await expectExpiryModalFor(["Google"]);
		modalDismiss()!.click();
		expect(dismissedReminderIds()).toEqual([`google-gemini-cli:${GOOGLE_EXPIRES}`]);

		allowOAuthStart = true;
		accountTabMounted = true;
		__testResetAccountTab({ status: { "google-gemini-cli": { authenticated: false, expires: GOOGLE_EXPIRES } } });
		renderAccountFixture();

		const authBtn = document.querySelector('[data-testid="account-auth-btn-google-gemini-cli"] button') as HTMLButtonElement;
		expect(authBtn).toBeTruthy();
		authBtn.click();
		await sleep(50);
		renderAccountFixture();

		let codeInput: HTMLInputElement | undefined;
		const startWait = Date.now();
		while (Date.now() - startWait < 3000) {
			codeInput = (Array.from(document.querySelectorAll("input")) as HTMLInputElement[])
				.find((i) => /Paste (redirect URL or )?code/i.test(i.getAttribute("placeholder") || ""));
			if (codeInput) break;
			renderAccountFixture();
			await sleep(30);
		}
		expect(codeInput, "code input should appear after starting OAuth").toBeTruthy();
		codeInput!.value = "code#state";
		codeInput!.dispatchEvent(new Event("input", { bubbles: true }));
		codeInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

		const doneStart = Date.now();
		while (Date.now() - doneStart < 3000) {
			renderAccountFixture();
			const statusEl = document.querySelector('[data-testid="account-status-google-gemini-cli"]');
			if (statusEl && (statusEl.textContent || "").trim() === "Authenticated") break;
			await sleep(30);
		}
		expect((document.querySelector('[data-testid="account-status-google-gemini-cli"]')?.textContent || "").trim()).toBe("Authenticated");
		expect(dismissedReminderIds()).toEqual([]);
	});
});
