import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/ui-fixtures/thinking-levels.spec.ts (v2-dom tier).
// Renders the REAL renderModelsTab() Session-row thinking picker under happy-dom
// (was an esbuild file:// bundle). State is injected via the real
// __testResetModelsTab()/__testSetPrefs() (same harness as
// settings-models-tab-redesign.test.ts) instead of the network-load path, whose
// one-shot `_modelsLoaded` guard can't be reset in a shared fork. Preference
// writes still flow through gatewayFetch → window.fetch, which we stub + capture.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";
import { __testResetModelsTab, __testSetPrefs, renderModelsTab } from "../../../src/app/settings-page.js";
import { setRenderApp } from "../../../src/app/state.js";
import { storage } from "../../../src/app/storage.js";
import type { StorageBackend } from "../../../src/ui/storage/types.js";

const OPUS_48 = "anthropic/claude-opus-4-8-20260528";
const OPUS_48_DOTTED = "anthropic/claude-opus-4.8-20260528";
const AIGW_OPUS_48 = "aigw/claude-opus-4-8-20260528";
const AIGW_OPUS_48_DOTTED = "aigw/claude-opus-4.8-20260528";
const OPUS_45 = "anthropic/claude-opus-4-5-20250920";
const GPT_4O = "openai/gpt-4o";

const MODELS = [
	{ id: "claude-opus-4-8-20260528", provider: "anthropic", reasoning: true },
	{ id: "claude-opus-4.8-20260528", provider: "anthropic", reasoning: true },
	{ id: "claude-opus-4-8-20260528", provider: "aigw", reasoning: true },
	{ id: "claude-opus-4.8-20260528", provider: "aigw", reasoning: true },
	{ id: "claude-opus-4-7-20251101", provider: "anthropic", reasoning: true },
	{ id: "claude-opus-4-5-20250920", provider: "anthropic", reasoning: true },
	{ id: "gpt-4o", provider: "openai", reasoning: false },
];

// happy-dom has no IndexedDB; back the provider-keys store with memory so the
// <provider-key-input> elements rendered by the models tab don't reject.
function memBackend(): StorageBackend {
	const m = new Map<string, unknown>();
	return {
		async get(_s, key) { return (m.get(key) ?? null) as any; },
		async set(_s, key, value) { m.set(key, value); },
		async delete(_s, key) { m.delete(key); },
		async keys(_s, prefix) { return [...m.keys()].filter((k) => !prefix || k.startsWith(prefix)); },
	} as StorageBackend;
}

let prefsStore: Record<string, string> = {};

function installFetch(): void {
	vi.stubGlobal("fetch", async (input: any, init?: any) => {
		const raw = typeof input === "string" ? input : input?.url ?? String(input);
		let path = raw;
		try { const u = new URL(raw, "http://localhost"); path = u.pathname + u.search; } catch { /* keep */ }
		const method = (init?.method || "GET").toUpperCase();
		let body: any = null;
		if (init?.body && typeof init.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
		if (path === "/api/preferences" && method === "PUT") {
			for (const [k, v] of Object.entries(body || {})) {
				if (v === null || v === undefined || v === "") delete prefsStore[k];
				else prefsStore[k] = v as string;
			}
			return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
		}
		if (path === "/api/preferences") return new Response(JSON.stringify(prefsStore), { status: 200, headers: { "Content-Type": "application/json" } });
		if (path === "/api/models") return new Response(JSON.stringify(MODELS), { status: 200, headers: { "Content-Type": "application/json" } });
		return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
	});
}

function container(): HTMLElement { return document.getElementById("container")!; }
function doRender(): void { render(renderModelsTab(), container()); }
const tick = async () => { for (let i = 0; i < 3; i++) await new Promise<void>((r) => setTimeout(r, 0)); };

const sessionRow = () => container().querySelector('[data-testid="model-row"][data-row-label="Session"]') as HTMLElement | null;
const thinkingWrapper = () => sessionRow()?.querySelector('div[title="Thinking level"], div[title="Selected model does not support thinking"]') as HTMLElement | null;
const thinkingButton = () => thinkingWrapper()?.querySelector("button") as HTMLButtonElement | null;
const readThinkingLabel = () => (thinkingButton()?.textContent || "").replace(/\s+/g, " ").trim();
const optionTexts = () => Array.from(document.querySelectorAll('[role="listbox"] [role="option"]')).map((o) => (o.textContent || "").replace(/\s+/g, " ").trim());

async function renderWithModel(model: string): Promise<void> {
	__testResetModelsTab({ allModels: MODELS as any, prefSessionModel: model });
	doRender();
	await tick();
	expect(sessionRow()).toBeTruthy();
}

function openThinking(): void {
	thinkingButton()!.click();
}

async function pickThinking(label: string): Promise<void> {
	openThinking();
	const opt = Array.from(document.querySelectorAll('[role="listbox"] [role="option"]')).find((o) => (o.textContent || "").replace(/\s+/g, " ").trim() === label);
	if (!opt) throw new Error(`thinking option not found: ${label} (have ${optionTexts().join(", ")})`);
	(opt as HTMLElement).click();
	await tick();
}

async function reloadAndRender(): Promise<void> {
	doRender();
	await tick();
}

beforeEach(() => {
	const div = document.createElement("div");
	div.id = "container";
	document.body.appendChild(div);
	prefsStore = {};
	installFetch();
	setRenderApp(doRender);
	storage.providerKeys.setBackend(memBackend());
});

afterEach(() => {
	setRenderApp(() => {});
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
	prefsStore = {};
});

describe("Per-model thinking-level dropdown", () => {
	it("Opus 4.8 exposes Extra high; selection persists across reload", async () => {
		await renderWithModel(OPUS_48);

		openThinking();
		const opts = optionTexts();
		expect(opts).toContain("Off");
		expect(opts).toContain("High");
		expect(opts).toContain("Extra high");

		// Dropdown is already open — click the option directly (re-opening toggles it shut).
		const xhigh = Array.from(document.querySelectorAll('[role="listbox"] [role="option"]')).find((o) => (o.textContent || "").replace(/\s+/g, " ").trim() === "Extra high")!;
		(xhigh as HTMLElement).click();
		await tick();
		expect(prefsStore["default.sessionThinkingLevel"]).toBe("xhigh");
		expect(readThinkingLabel()).toBe("Extra high");

		await reloadAndRender();
		expect(readThinkingLabel()).toBe("Extra high");
	});

	for (const [label, model] of [
		["dotted Opus 4.8", OPUS_48_DOTTED],
		["AIGW-routed Opus 4.8", AIGW_OPUS_48],
		["AIGW-routed dotted Opus 4.8", AIGW_OPUS_48_DOTTED],
	] as const) {
		it(`${label} exposes Extra high`, async () => {
			await renderWithModel(model);
			openThinking();
			expect(optionTexts()).toContain("Extra high");
		});
	}

	it("Switching to Opus 4.5 clamps xhigh down to High and persists", async () => {
		await renderWithModel(OPUS_48);
		await pickThinking("Extra high");
		expect(readThinkingLabel()).toBe("Extra high");

		__testSetPrefs({ session: OPUS_45 });
		await reloadAndRender();

		expect(readThinkingLabel()).toBe("High");
		expect(prefsStore["default.sessionThinkingLevel"]).toBe("high");

		openThinking();
		const opts = optionTexts();
		expect(opts).toContain("High");
		expect(opts).not.toContain("Extra high");
	});

	it("Non-reasoning model disables the thinking picker", async () => {
		await renderWithModel(GPT_4O);
		const disabledWrapper = sessionRow()!.querySelector('div[title="Selected model does not support thinking"]') as HTMLElement;
		expect(disabledWrapper).toBeTruthy();
		expect(disabledWrapper.className).toMatch(/pointer-events-none/);
	});
});
