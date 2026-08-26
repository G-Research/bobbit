import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_helpers/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/settings-models-tab-redesign.spec.ts (v2-dom tier).
// Renders the REAL renderModelsTab() (src/app/settings-page.ts) into a happy-dom
// container, replacing the esbuild file:// fixture. State is driven via the real
// __testResetModelsTab() and HTTP is stubbed via a logging fetch. The real
// <provider-key-input> and <aigw-models-dialog> custom elements are registered as
// a side effect of importing settings-page (which statically imports both).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";
import { __testResetModelsTab, renderModelsTab } from "../../src/app/settings-page.js";
import { setRenderApp } from "../../src/app/state.js";
import { storage } from "../../src/app/storage.js";
import type { StorageBackend } from "../../src/ui/storage/types.js";

// happy-dom has no IndexedDB; back the provider-keys store with memory so
// seeds/reads resolve instead of throwing an unhandled rejection.
function memBackend(): StorageBackend {
	const m = new Map<string, unknown>();
	return {
		async get(_s, key) { return (m.get(key) ?? null) as any; },
		async set(_s, key, value) { m.set(key, value); },
		async delete(_s, key) { m.delete(key); },
		async keys(_s, prefix) { return [...m.keys()].filter((k) => !prefix || k.startsWith(prefix)); },
	} as StorageBackend;
}

// ── Fetch stub (mirrors the fixture entry) ─────────────────────────────────────
type StubResponseInit = { ok: boolean; status?: number; body: any };
type Responder = StubResponseInit | ((url: string, method: string, body: any) => StubResponseInit);

const fetchLog: Array<{ url: string; method: string; body: any }> = [];
let responder: Responder = { ok: true, body: {} };

function setNextFetchResponse(r: Responder) { responder = r; }
function getFetchLog() { return fetchLog.slice(); }
function clearFetchLog() { fetchLog.length = 0; }
function seedProviderKey(provider: string, key: string) { storage.providerKeys.set(provider, key); }

function installFetchStub() {
	vi.stubGlobal("fetch", async (input: any, init?: RequestInit) => {
		const urlStr = typeof input === "string" ? input : (input as Request).url;
		let pathOnly = urlStr;
		try {
			const u = new URL(urlStr, "http://localhost");
			pathOnly = u.pathname + u.search;
		} catch { /* keep raw */ }
		const method = (init?.method || "GET").toUpperCase();
		let body: any = null;
		if (init?.body && typeof init.body === "string") {
			try { body = JSON.parse(init.body); } catch { body = init.body; }
		}
		fetchLog.push({ url: pathOnly, method, body });
		const picked = typeof responder === "function" ? (responder as any)(pathOnly, method, body) : responder;
		return new Response(JSON.stringify(picked.body ?? {}), {
			status: picked.status ?? (picked.ok ? 200 : 500),
			headers: { "Content-Type": "application/json" },
		});
	});
}

function container(): HTMLElement {
	let el = document.getElementById("container");
	if (!el) {
		el = document.createElement("div");
		el.id = "container";
		document.body.appendChild(el);
	}
	return el;
}

function doRender() {
	render(renderModelsTab(), container());
}

function resetModelsTab(opts: any) {
	__testResetModelsTab(opts);
	doRender();
}

async function waitFor(fn: () => boolean, timeout = 5000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (fn()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error("waitFor timed out");
}

const AIGW_MODELS = [
	{ id: "aws/us.anthropic.claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000, maxTokens: 8192, reasoning: false },
	{ id: "aws/us.anthropic.claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 200_000, maxTokens: 8192, reasoning: true },
];
const ALL_MODELS = [
	{ id: "us.anthropic.claude-haiku-4-5", provider: "aigw", reasoning: false },
	{ id: "us.anthropic.claude-sonnet-4-5", provider: "aigw", reasoning: true },
];

const q = (sel: string) => container().querySelector(sel);
const qa = (sel: string) => [...container().querySelectorAll(sel)];

beforeEach(() => {
	responder = { ok: true, body: {} };
	clearFetchLog();
	installFetchStub();
	setRenderApp(doRender);
	storage.providerKeys.setBackend(memBackend());
});

afterEach(() => {
	// Neutralize the shared renderApp callback so a rAF-debounced straggler
	// scheduled by this file cannot fire *another* file's renderer into a
	// torn-down / foreign container (isolate:false shares the state module).
	setRenderApp(() => {});
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

describe("Settings Models tab redesign", () => {
	it("section ordering: AI Gateway before Default Models", () => {
		resetModelsTab({ aigwConfigured: true, aigwUrl: "http://dummy/v1", aigwModels: AIGW_MODELS, allModels: ALL_MODELS });

		const aigwBox = q('[data-testid="aigw-section"]') as HTMLElement;
		const defaultsBox = q('[data-testid="defaults-section"]') as HTMLElement;
		expect(aigwBox).toBeTruthy();
		expect(defaultsBox).toBeTruthy();

		const gatewayUrlInput = aigwBox.querySelector('[data-testid="aigw-url-input"]') as HTMLElement;
		expect(gatewayUrlInput.getAttribute("name")).toBe("bobbit-aigw-url");
		expect(gatewayUrlInput.getAttribute("autocomplete")).toBe("off");
		expect(gatewayUrlInput.getAttribute("autocapitalize")).toBe("off");
		expect(gatewayUrlInput.getAttribute("spellcheck")).toBe("false");

		// DOM order: aigw appears before defaults.
		const pos = aigwBox.compareDocumentPosition(defaultsBox);
		expect((pos & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
	});

	it("Unavailable badge + Clear X for stale pref", () => {
		resetModelsTab({
			aigwConfigured: true, aigwUrl: "http://dummy/v1", aigwModels: AIGW_MODELS, allModels: ALL_MODELS,
			prefReviewModel: "aigw/aws/us.anthropic.claude-stale", // not in allModels
		});

		expect(qa('[data-testid="model-unavailable-badge"]').length).toBe(1);
		const reviewRow = q('[data-row-label="Review"]') as HTMLElement;
		expect(reviewRow.querySelector('[data-testid="model-clear-btn"]')).toBeTruthy();
	});

	it("Clear button resets the pref value", async () => {
		resetModelsTab({
			aigwConfigured: true, aigwModels: AIGW_MODELS, allModels: ALL_MODELS,
			prefSessionModel: "aigw/us.anthropic.claude-sonnet-4-5",
		});

		setNextFetchResponse({ ok: true, body: { ok: true } });
		clearFetchLog();

		const sessionRow = () => q('[data-row-label="Session"]') as HTMLElement;
		const clearBtn = sessionRow().querySelector('[data-testid="model-clear-btn"]') as HTMLElement;
		expect(clearBtn).toBeTruthy();
		clearBtn.click();

		// After clear, the row re-renders without a Clear button (pref empty).
		await waitFor(() => !sessionRow().querySelector('[data-testid="model-clear-btn"]'));

		const prefWrites = getFetchLog().filter((e) => e.url === "/api/preferences" && e.method === "PUT");
		expect(prefWrites.length).toBeGreaterThanOrEqual(1);
		expect(prefWrites[prefWrites.length - 1].body).toMatchObject({ "default.sessionModel": null });
	});

	it("Test button invokes /api/models/test and shows result", async () => {
		resetModelsTab({
			aigwConfigured: true, aigwModels: AIGW_MODELS, allModels: ALL_MODELS,
			prefReviewModel: "aigw/us.anthropic.claude-haiku-4-5",
		});

		setNextFetchResponse((url: string) => {
			if (url === "/api/models/test") return { ok: true, body: { ok: true, modelResolved: "aws/us.anthropic.claude-haiku-4-5", latencyMs: 123 } };
			return { ok: true, body: {} };
		});
		clearFetchLog();

		const reviewRow = () => q('[data-row-label="Review"]') as HTMLElement;
		const testBtn = reviewRow().querySelector('[data-testid="model-test-btn"]') as HTMLElement;
		expect(testBtn).toBeTruthy();
		testBtn.click();

		await waitFor(() => /Test OK/.test(reviewRow().querySelector('[data-testid="model-test-result"]')?.textContent || ""));

		const testCalls = getFetchLog().filter((e) => e.url === "/api/models/test");
		expect(testCalls).toHaveLength(1);
		expect(testCalls[0].method).toBe("POST");
		expect(testCalls[0].body).toEqual({ pref: "aigw/us.anthropic.claude-haiku-4-5" });
	});

	it("View available models… button renders and dispatches", async () => {
		resetModelsTab({ aigwConfigured: true, aigwModels: AIGW_MODELS, allModels: ALL_MODELS });

		const viewBtn = q('[data-testid="view-aigw-models-btn"]') as HTMLElement;
		expect(viewBtn).toBeTruthy();
		expect(viewBtn.textContent || "").toMatch(/View available models/);

		viewBtn.click();
		await waitFor(() => !!document.querySelector("aigw-models-dialog"), 2000);
		expect(!!document.querySelector("aigw-models-dialog")).toBe(true);
	});

	it("Provider API Keys ignores gateway-managed session sentinel", async () => {
		await seedProviderKey("anthropic", "gateway-managed");
		setNextFetchResponse((url: string) => {
			if (url === "/api/provider-keys") return { ok: true, body: { providers: [] } };
			if (url === "/api/aigw/status") return { ok: true, body: { configured: false, url: "", models: [] } };
			if (url === "/api/models") return { ok: true, body: [] };
			if (url === "/api/image-models") return { ok: true, body: [] };
			return { ok: true, body: {} };
		});
		clearFetchLog();

		resetModelsTab({ aigwConfigured: false, allModels: ALL_MODELS });

		await waitFor(() => getFetchLog().filter((e) => e.url === "/api/provider-keys").length >= 4);
		const anthropicKey = q('[data-testid="provider-key-input-anthropic"]') as HTMLElement;
		expect(anthropicKey.querySelectorAll('[data-testid="provider-key-present"]').length).toBe(0);
	});

	// Requirement 4 evidence for the "Adopt legacy AIGW models block" goal: when a
	// legacy (unmarked) providers.aigw block was treated as user-owned, Bobbit
	// dropped `upstreamProvider` from the published models, and these Default
	// Models rows rendered bare model ids with no provider tag. renderModelRow()
	// only renders the chip when the selected model has provider === "aigw" AND
	// carries `upstreamProvider`, so these tests pin both directions.
	//
	// The chip has no data-testid in production code, so it is selected
	// structurally via its title attribute inside the model-picker button. Adding
	// a data-testid to the chip would be a worthwhile follow-up.
	describe("Default Models upstream-provider chip", () => {
		const OPUS = "us.anthropic.claude-opus-5";
		const row = (label: string) => q(`[data-testid="model-row"][data-row-label="${label}"]`) as HTMLElement;
		const pickerButton = (label: string) => row(label).querySelector('button[title="Choose model"]') as HTMLElement;
		const chip = (label: string) => pickerButton(label).querySelector('span[title="AIGW provider"]') as HTMLElement | null;

		it("renders the upstream provider chip for an aigw model carrying upstreamProvider", () => {
			resetModelsTab({
				aigwConfigured: true,
				aigwUrl: "http://dummy/v1",
				aigwModels: AIGW_MODELS,
				allModels: [{ id: OPUS, provider: "aigw", reasoning: true, upstreamProvider: "aws" }],
				prefSessionModel: `aigw/${OPUS}`,
			});

			expect(row("Session")).toBeTruthy();
			const tag = chip("Session");
			expect(tag, "provider chip missing: Default Models row rendered a bare id without its upstream provider tag").toBeTruthy();
			expect((tag!.textContent || "").trim()).toBe("aws");

			// The chip is separate from the model-id label: the row still shows the
			// bare id, and the id text does not absorb the provider tag.
			const idLabel = pickerButton("Session").querySelector("span.truncate") as HTMLElement;
			expect((idLabel.textContent || "").trim()).toBe(OPUS);
			expect(idLabel.contains(tag!)).toBe(false);

			// It is a chip on this row only — untouched rows have no pref, no chip.
			expect(chip("Review")).toBeNull();
		});

		it("renders no chip when the aigw model lacks upstreamProvider (the regression)", () => {
			resetModelsTab({
				aigwConfigured: true,
				aigwUrl: "http://dummy/v1",
				aigwModels: AIGW_MODELS,
				allModels: [{ id: OPUS, provider: "aigw", reasoning: true }],
				prefSessionModel: `aigw/${OPUS}`,
			});

			const button = pickerButton("Session");
			expect((button.textContent || "").replace(/\s+/g, " ").trim()).toBe(OPUS);
			expect(chip("Session")).toBeNull();
			// The pref is a real available model, so this is a provenance gap and not
			// a stale-pref "Unavailable" state.
			expect(row("Session").querySelector('[data-testid="model-unavailable-badge"]')).toBeNull();
		});

		it("renders no chip for a non-aigw provider even when upstreamProvider is set", () => {
			resetModelsTab({
				aigwConfigured: false,
				allModels: [{ id: "gpt-4o", provider: "openai", reasoning: false, upstreamProvider: "openai" }],
				prefSessionModel: "openai/gpt-4o",
			});

			expect((pickerButton("Session").textContent || "").replace(/\s+/g, " ").trim()).toBe("gpt-4o");
			expect(chip("Session")).toBeNull();
		});
	});

	it("Provider API Keys section is discoverable with a Google key input", async () => {
		resetModelsTab({ aigwConfigured: false, allModels: ALL_MODELS });

		const section = q('[data-testid="provider-keys-section"]') as HTMLElement;
		expect(section).toBeTruthy();
		expect(section.textContent || "").toMatch(/Provider API Keys/);
		expect(section.textContent || "").toMatch(/Google AI Studio/);

		const googleKey = q('[data-testid="provider-key-input-google"]') as HTMLElement;
		// The <provider-key-input> renders its label/input asynchronously (light DOM).
		await waitFor(() => /google/i.test(googleKey.textContent || "") && !!googleKey.querySelector('input[type="password"]'));
		expect(googleKey).toBeTruthy();
		expect(googleKey.querySelectorAll("provider-key-input").length).toBe(1);
		expect(googleKey.textContent || "").toMatch(/google/i);
		const googleInput = googleKey.querySelector('input[type="password"]') as HTMLInputElement;
		expect(googleInput.getAttribute("name")).toBe("bobbit-provider-api-key-google");
		expect(googleInput.getAttribute("autocomplete")).toBe("new-password");
		expect(googleInput.value).toBe("");

		const openrouterKey = q('[data-testid="provider-key-input-openrouter"]') as HTMLElement;
		expect(openrouterKey).toBeTruthy();
		expect(openrouterKey.querySelectorAll("provider-key-input").length).toBe(1);
		expect(openrouterKey.textContent || "").toMatch(/openrouter/i);

		// Provider API Keys appears after Default Models in document order.
		const d = q('[data-testid="defaults-section"]') as HTMLElement;
		const k = q('[data-testid="provider-keys-section"]') as HTMLElement;
		expect((d.compareDocumentPosition(k) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
	});
});
