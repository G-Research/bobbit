import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// v2-native — focused multi-enum Market UI coverage. Listed in tests-map.json `v2Native`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";
import { clearMarketplaceState, loadMarketplaceData, renderMarketplacePage } from "../../src/app/marketplace-page.js";
import { setRenderApp, state } from "../../src/app/state.js";

let root: HTMLElement;
let patches: unknown[];

function fixturePack(): any {
	return {
		scope: "project", packName: "language-pack", status: "ok", updateAvailable: false, sourceStatus: "ok",
		manifest: { name: "language-pack", version: "1.0.0", schema: 2 },
		meta: { version: "1.0.0", sourceUrl: "https://example.test/fixture", installedAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
	};
}

function target(fields: any[]): any {
	return {
		ref: { packId: "language-pack", kind: "hook", id: "language-hook" }, packName: "language-pack", listName: "Language hook",
		enabled: { effective: true }, configuration: { state: "ready", missing: [] }, fields,
	};
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function renderFixture(fields: any[]): Promise<void> {
	const projectId = "multi-enum-project";
	state.projects = [{ id: projectId, name: "Multi enum fixture", rootPath: "/fixture", colorLight: "#888", colorDark: "#aaa" }];
	state.activeProjectId = projectId;
	window.location.hash = `#/market/${projectId}/installed`;
	setRenderApp(() => render(renderMarketplacePage(), root));
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
		const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
		if (init.method === "PATCH" && url.pathname.includes("/extension-settings/")) {
			patches.push(JSON.parse(String(init.body)));
			return Response.json({ revision: 2, target: target(fields) });
		}
		const body = url.pathname === "/api/marketplace/sources" ? { sources: [] }
			: url.pathname === "/api/marketplace/installed" ? { installed: [fixturePack()] }
			: url.pathname === "/api/packs/conflicts" ? { conflicts: [] }
			: url.pathname === "/api/marketplace/adoptions" ? { adoptions: [] }
			: url.pathname === "/api/marketplace/browse" ? { sources: [], packs: [] }
			: url.pathname.endsWith("/extension-settings") ? { schema: 2, revision: 1, targets: [target(fields)] }
			: url.pathname.endsWith("/extension-grant-audit") ? { entries: [] }
			: url.pathname === "/api/marketplace/pack-activation" ? { scope: "project", packName: "language-pack", catalogue: { roles: [], tools: [], skills: [], entrypoints: [], mcp: [], piExtensions: [] }, disabled: {} }
			: {};
		return Response.json(body);
	});
	await loadMarketplaceData(false);
	await waitFor(() => root.querySelector('[data-testid="market-settings-toggle"]') !== null, "Market settings target");
	root.querySelector<HTMLButtonElement>('[data-testid="market-settings-toggle"]')!.click();
	// Market renders through the real requestAnimationFrame-debounced renderApp;
	// wait for that production update rather than inspecting the pre-click DOM.
	await waitFor(() => root.querySelector('[data-testid="market-settings-multi-enum"]') !== null, "multi-enum settings form");
}

beforeEach(() => {
	root = document.createElement("div");
	document.body.append(root);
	patches = [];
});

afterEach(() => {
	vi.unstubAllGlobals();
	clearMarketplaceState();
	setRenderApp(() => {});
	state.projects = [];
	state.activeProjectId = null;
	document.body.innerHTML = "";
	window.location.hash = "";
});

describe("Market multi-enum extension settings", () => {
	it("renders a labelled publisher-order checkbox group and PATCHes a canonical set", async () => {
		await renderFixture([{
			key: "languages", type: "multi-enum", label: "Languages", description: "Languages to inspect", optional: true,
			values: ["typescript", "go", "javascript"], default: [], value: [], source: "default",
		}]);
		const group = root.querySelector<HTMLElement>('[data-testid="market-settings-multi-enum"]')!;
		expect(group.tagName).toBe("FIELDSET");
		expect(group.querySelector("legend")?.textContent).toContain("Languages");
		expect(group.getAttribute("aria-describedby")).toContain("-help");
		const options = [...root.querySelectorAll<HTMLInputElement>('[data-testid="market-settings-multi-enum-option"]')];
		expect(options.map((option) => option.dataset.optionValue)).toEqual(["typescript", "go", "javascript"]);

		options[2].click();
		await waitFor(() => root.querySelector('[data-testid="market-settings-multi-enum-summary"]')?.textContent?.includes("1 option selected") === true, "first selected option");
		root.querySelector<HTMLInputElement>('[data-testid="market-settings-multi-enum-option"][data-option-value="go"]')!.click();
		await waitFor(() => root.querySelector('[data-testid="market-settings-multi-enum-summary"]')?.textContent?.includes("2 options selected") === true, "selected options");
		root.querySelector<HTMLButtonElement>('[data-testid="market-settings-save"]')!.click();
		await waitFor(() => patches.length === 1, "canonical settings PATCH");
		expect(patches[0]).toMatchObject({ expectedRevision: 1, values: { languages: ["go", "javascript"] } });
	});

	it("keeps an explicit empty required set invalid, then stages Use default as PATCH null", async () => {
		await renderFixture([{
			key: "languages", type: "multi-enum", label: "Languages", optional: false,
			values: ["typescript", "go"], default: ["go"], value: ["typescript"], source: "project",
		}]);
		root.querySelector<HTMLInputElement>('[data-testid="market-settings-multi-enum-option"][data-option-value="typescript"]')!.click();
		await waitFor(() => root.querySelector('[data-testid="market-settings-multi-enum-summary"]')?.textContent?.includes("0 options selected") === true, "empty required selection");
		root.querySelector<HTMLButtonElement>('[data-testid="market-settings-save"]')!.click();
		await waitFor(() => root.querySelector('[data-testid="market-settings-error-summary"]') !== null, "required selection error");
		expect(root.querySelector('[data-testid="market-settings-error-summary"]')?.textContent).toContain("Review the highlighted settings");
		expect(root.querySelector('.market-settings-field-error')?.textContent).toContain("Select at least one option.");
		expect(patches).toEqual([]);

		root.querySelector<HTMLButtonElement>('[data-testid="market-settings-use-default"]')!.click();
		await waitFor(() => root.querySelector<HTMLInputElement>('[data-testid="market-settings-multi-enum-option"][data-option-value="go"]')?.checked === true, "inherited default selection");
		root.querySelector<HTMLButtonElement>('[data-testid="market-settings-save"]')!.click();
		await waitFor(() => patches.length === 1, "Use default PATCH");
		expect(patches[0]).toMatchObject({ values: { languages: null } });
	});

	it("retains an explicit optional empty set rather than treating it as Use default", async () => {
		await renderFixture([{
			key: "languages", type: "multi-enum", label: "Languages", optional: true,
			values: ["typescript", "go"], default: ["go"], value: ["typescript"], source: "project",
		}]);
		root.querySelector<HTMLInputElement>('[data-testid="market-settings-multi-enum-option"][data-option-value="typescript"]')!.click();
		await waitFor(() => root.querySelector('[data-testid="market-settings-multi-enum-summary"]')?.textContent?.includes("0 options selected") === true, "empty optional selection");
		root.querySelector<HTMLButtonElement>('[data-testid="market-settings-save"]')!.click();
		await waitFor(() => patches.length === 1, "empty-set PATCH");
		expect(patches[0]).toMatchObject({ values: { languages: [] } });
	});
});
