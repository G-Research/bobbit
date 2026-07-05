import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/ui-fixtures/model-selector-fixture.spec.ts (v2-dom tier).
// The legacy spec esbuild-bundled a file:// entry that rendered the REAL
// <agent-model-selector> (ModelSelector.open) and mocked /api/models. This port
// mounts the same real component under happy-dom via ModelSelector.open, stubbing
// window.fetch for /api/models. No geometry — assertions are on data attributes,
// ordering, titles, class strings, and click-selection.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let ModelSelector: typeof import("../../../src/ui/dialogs/ModelSelector.js").ModelSelector;

type FixtureModel = Record<string, any>;
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const DEFAULT_MODELS: FixtureModel[] = [
	{ id: "claude-opus-4-7", name: "Claude Opus 4.7", provider: "anthropic", api: "anthropic-messages", contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true, input: ["text", "image"], cost, authenticated: true },
	{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic", api: "anthropic-messages", contextWindow: 1_000_000, maxTokens: 64_000, reasoning: true, input: ["text", "image"], cost, authenticated: true },
	{ id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic", api: "anthropic-messages", contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true, input: ["text", "image"], cost, authenticated: true },
	{ id: "claude-opus-4-10", name: "Claude Opus 4.10", provider: "anthropic", api: "anthropic-messages", contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true, input: ["text", "image"], cost, authenticated: true },
];

let models: FixtureModel[];
let selectedModel: FixtureModel | null;

function installFetchMock() {
	vi.stubGlobal("fetch", async (input: any) => {
		const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(raw, "https://fixture.local");
		if (url.pathname === "/api/models") return new Response(JSON.stringify(models), { status: 200, headers: { "Content-Type": "application/json" } });
		return new Response("Not found", { status: 404 });
	});
}

async function openSelector(): Promise<HTMLElement> {
	selectedModel = null;
	await ModelSelector.open(null as any, (m) => { selectedModel = m as FixtureModel; });
	const el = document.querySelector("agent-model-selector") as any;
	// Wait for loadModels() fetch to populate rows.
	const start = Date.now();
	while (Date.now() - start < 5000) {
		await el.updateComplete;
		if (el.querySelector("[data-model-item]")) break;
		await new Promise((r) => setTimeout(r, 15));
	}
	return el as HTMLElement;
}

beforeAll(async () => {
	localStorage.setItem("gateway.url", "https://fixture.local");
	localStorage.setItem("gateway.token", "fixture-token");
	({ ModelSelector } = await import("../../../src/ui/dialogs/ModelSelector.js"));
	__syncCE();
});

beforeEach(() => {
	models = DEFAULT_MODELS.map((m) => ({ ...m }));
	selectedModel = null;
	installFetchMock();
});

afterEach(() => {
	document.querySelector("agent-model-selector")?.remove();
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

describe("ModelSelector Opus ordering", () => {
	it("displays parsed Opus 4 minors in newest-first order and selects Opus 4.8", async () => {
		const el = await openSelector();
		const items = el.querySelectorAll("[data-model-item]");
		expect(items.length).toBeGreaterThan(0);
		const orderedIds = Array.from(items).map((n) => (n as HTMLElement).dataset.modelId);
		expect(orderedIds.slice(0, 4)).toEqual([
			"claude-opus-4-10",
			"claude-opus-4-8",
			"claude-opus-4-7",
			"claude-sonnet-4-6",
		]);

		const row = el.querySelector('[data-model-id="claude-opus-4-8"]') as HTMLElement;
		row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(selectedModel?.id).toBe("claude-opus-4-8");
		expect(`${selectedModel?.provider}/${selectedModel?.id}`).toBe("anthropic/claude-opus-4-8");
	});
});

describe("ModelSelector unauthenticated tooltip (Settings-drift regression)", () => {
	it("locked model row tooltip avoids the dead 'Settings > Providers' path", async () => {
		models = [{
			id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google", api: "google-generative-ai",
			contextWindow: 1_000_000, maxTokens: 64_000, reasoning: true, input: ["text", "image"], cost, authenticated: false,
		}];
		const el = await openSelector();
		const row = el.querySelector('[data-model-id="gemini-2.5-pro"]') as HTMLElement;
		expect(row).toBeTruthy();

		const title = row.getAttribute("title") ?? "";
		expect(title).not.toContain("Settings > Providers");
		expect(title).toContain("Settings → Account");
		expect(title).toContain("Settings → Models");

		const keyTitles = Array.from(row.querySelectorAll("span[title]")).map((n) => (n as HTMLElement).getAttribute("title"));
		expect(keyTitles).toContain("Authentication required");
		expect(keyTitles).not.toContain("API key required");
	});
});

describe("ModelSelector account model selectability (Google Code Assist)", () => {
	it("renders authenticated google-gemini-cli account model selectable", async () => {
		models = [{
			id: "gemini-2.5-pro", name: "Gemini 2.5 Pro (Google account)", provider: "google-gemini-cli", api: "google-code-assist",
			contextWindow: 1_000_000, maxTokens: 64_000, reasoning: true, input: ["text", "image"], cost, authenticated: true,
		}];
		const el = await openSelector();
		const row = el.querySelector('[data-model-id="gemini-2.5-pro"]') as HTMLElement;
		expect(row).toBeTruthy();

		expect(row.getAttribute("data-session-unavailable")).toBe("false");
		expect(row.getAttribute("class")).toContain("cursor-pointer");
		expect(row.getAttribute("class")).not.toContain("cursor-not-allowed");

		row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(selectedModel?.id).toBe("gemini-2.5-pro");
		expect(selectedModel?.provider).toBe("google-gemini-cli");
	});

	it("still disables and refuses any model explicitly marked sessionSelectable=false", async () => {
		models = [{
			id: "some-unrunnable-model", name: "Unrunnable model", provider: "some-provider", api: "some-api",
			contextWindow: 1_000_000, maxTokens: 64_000, reasoning: true, input: ["text", "image"], cost,
			authenticated: true, sessionSelectable: false, sessionUnavailableReason: "This model can't run in agent sessions.",
		}];
		const el = await openSelector();
		const row = el.querySelector('[data-model-id="some-unrunnable-model"]') as HTMLElement;
		expect(row).toBeTruthy();

		expect(row.getAttribute("data-session-unavailable")).toBe("true");
		expect(row.getAttribute("class")).toContain("cursor-not-allowed");
		expect(row.getAttribute("title") ?? "").toContain("can't run in agent sessions");

		row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		await new Promise((r) => setTimeout(r, 50));
		expect(selectedModel).toBeNull();
	});
});
