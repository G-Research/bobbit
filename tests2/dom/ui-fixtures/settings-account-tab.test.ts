import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/ui-fixtures/settings-account-tab.spec.ts (v2-dom tier).
// Renders the REAL renderAccountTab() Google-OAuth row under happy-dom (was an
// esbuild file:// bundle). State is driven via the real __testResetAccountTab()
// and HTTP through gatewayFetch → window.fetch, which we stub + capture. The
// logout confirm dialog (confirmAction) is confirmed via a document Enter keydown.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";
import { renderAccountTab, __testResetAccountTab } from "../../../src/app/settings-page.js";
import { setRenderApp } from "../../../src/app/state.js";

type StubResponseInit = { ok: boolean; status?: number; body: any };
type Responder = StubResponseInit | ((url: string, method: string, body: any) => StubResponseInit);

const FUTURE = Date.now() + 86_400_000;

let fetchLog: Array<{ url: string; method: string; body: any }> = [];
let responder: Responder = { ok: true, body: { authenticated: false } };

function setNextFetchResponse(r: Responder): void { responder = r; }
function getFetchLog(): Array<{ url: string; method: string; body: any }> { return fetchLog.slice(); }
function clearFetchLog(): void { fetchLog.length = 0; }

function installFetch(): void {
	vi.stubGlobal("fetch", async (input: any, init?: any) => {
		const urlStr = typeof input === "string" ? input : (input as Request).url;
		let pathOnly = urlStr;
		try { const u = new URL(urlStr, window.location.origin); pathOnly = u.pathname + u.search; } catch { /* keep */ }
		const method = (init?.method || "GET").toUpperCase();
		let body: any = null;
		if (init?.body && typeof init.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
		fetchLog.push({ url: pathOnly, method, body });
		const picked = typeof responder === "function" ? (responder as any)(pathOnly, method, body) : responder;
		return new Response(JSON.stringify(picked.body ?? {}), {
			status: picked.status ?? (picked.ok ? 200 : 500),
			headers: { "Content-Type": "application/json" },
		});
	});
}

function container(): HTMLElement { return document.getElementById("container")!; }
function doRender(): void { render(renderAccountTab(), container()); }
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise<void>((r) => setTimeout(r, 0)); };

async function resetAccountTab(opts: any): Promise<void> {
	__testResetAccountTab(opts ?? {});
	doRender();
	await tick();
}

const q = (sel: string) => container().querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => Array.from(container().querySelectorAll(sel)) as HTMLElement[];
const text = (el: Element | null) => (el?.textContent || "").replace(/\s+/g, " ").trim();

beforeEach(() => {
	const div = document.createElement("div");
	div.id = "container";
	document.body.appendChild(div);
	localStorage.setItem("gateway.url", "https://fixture.local");
	localStorage.setItem("gateway.token", "fixture-token");
	fetchLog = [];
	responder = { ok: true, body: { authenticated: false } };
	installFetch();
	setRenderApp(doRender);
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("Settings Account tab — Google OAuth row", () => {
	it("renders a Google row with canonical id and 'Log in' when unauthenticated", async () => {
		await resetAccountTab({ status: {} });

		const row = q('[data-testid="account-row-google-gemini-cli"]');
		expect(row).toBeTruthy();
		expect(text(row)).toContain("Google OAuth");
		expect(text(q('[data-testid="account-status-google-gemini-cli"]'))).toBe("Not authenticated");
		expect(text(q('[data-testid="account-auth-btn-google-gemini-cli"]'))).toContain("Log in");

		// Logout button is hidden while unauthenticated.
		expect(qa('[data-testid="account-logout-btn-google-gemini-cli"]').length).toBe(0);

		const limitNote = q('[data-testid="account-google-gemini-cli-limit-note"]');
		expect(text(limitNote)).toMatch(/Code Assist/);
		expect(text(limitNote)).toMatch(/quota/);
		expect(text(limitNote)).toMatch(/Google AI Studio API key/);
		expect(text(limitNote)).not.toMatch(/can't|cannot|does not make Gemini/i);
		expect(text(q('[data-testid="account-apikey-link-google-gemini-cli"]'))).toMatch(/Provider API Keys/);

		// Anthropic/OpenAI rows still render (additive — peers unchanged).
		expect(q('[data-testid="account-row-anthropic"]')).toBeTruthy();
		expect(q('[data-testid="account-row-openai-codex"]')).toBeTruthy();
	});

	it("authenticated status persists across a simulated reload (status fetch)", async () => {
		// Drive the real loadAccountStatus() fetch path: the status endpoint
		// reports Google authenticated. status null → triggers loadAccountStatus().
		setNextFetchResponse((url: string) => {
			if (url.includes("provider=google-gemini-cli")) return { ok: true, body: { authenticated: true, expires: FUTURE } };
			return { ok: true, body: { authenticated: false } };
		});
		await resetAccountTab({});

		expect(text(q('[data-testid="account-status-google-gemini-cli"]'))).toBe("Authenticated");
		expect(text(q('[data-testid="account-auth-btn-google-gemini-cli"]'))).toContain("Re-authenticate");
		expect(text(q('[data-testid="account-logout-btn-google-gemini-cli"]'))).toContain("Log out");
		expect(q('[data-testid="account-expires-google-gemini-cli"]')).toBeTruthy();
	});

	it("logout confirms, POSTs /api/oauth/logout for the canonical provider, and returns to 'Log in'", async () => {
		await resetAccountTab({ status: { "google-gemini-cli": { authenticated: true, expires: FUTURE } } });
		setNextFetchResponse({ ok: true, body: { authenticated: false } });
		clearFetchLog();

		(q('[data-testid="account-logout-btn-google-gemini-cli"] button') as HTMLButtonElement).click();
		await tick();
		// confirmAction accepts Enter (document keydown) as confirm.
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await tick();

		expect(text(q('[data-testid="account-status-google-gemini-cli"]'))).toBe("Not authenticated");
		expect(text(q('[data-testid="account-auth-btn-google-gemini-cli"]'))).toContain("Log in");

		const logoutCalls = getFetchLog().filter((e) => e.url === "/api/oauth/logout" && e.method === "POST");
		expect(logoutCalls).toHaveLength(1);
		expect(logoutCalls[0].body).toEqual({ provider: "google-gemini-cli" });
	});
});
