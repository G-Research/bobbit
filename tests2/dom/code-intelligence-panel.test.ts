// v2-native — truthful, accessible route-only Code Intelligence panel states.
import { afterEach, describe, expect, it, vi } from "vitest";
import { html, nothing, render } from "lit";
import createCodeIntelligencePanel from "../../market-packs/code-intelligence/src/panel.js";

type RouteInit = { method?: string; query?: Record<string, string>; body?: unknown };
type Host = {
	callRoute?: (name: string, init?: RouteInit) => Promise<unknown>;
	requestRender?: () => void;
};

async function waitFor(assertion: () => void): Promise<void> {
	let last: unknown;
	for (let attempt = 0; attempt < 20; attempt++) {
		try { assertion(); return; } catch (error) { last = error; }
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	throw last;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(res => { resolve = res; });
	return { promise, resolve };
}

function mount(response: unknown, sessionId: string) {
	const root = document.createElement("div");
	document.body.appendChild(root);
	const panel = createCodeIntelligencePanel({ html, nothing });
	const params = { __sessionId: sessionId };
	let currentResponse = response;
	let host!: Host;
	const draw = () => render(panel.render(params, host), root);
	const callRoute = vi.fn(async (_route: string, _init?: RouteInit) => currentResponse);
	host = { callRoute, requestRender: draw };
	draw();
	return {
		root,
		callRoute,
		load: async () => {
			(root.querySelector('[data-testid="graph-status-load"]') as HTMLButtonElement).click();
			await waitFor(() => expect(callRoute).toHaveBeenCalledWith("status", { method: "GET" }));
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("Code Intelligence status panel", () => {
	it.each(["components", "items", "graphs"] as const)("treats an empty %s envelope as an honest zero state", async (collection) => {
		const panel = mount({ state: "stale", [collection]: [], manualRebuild: { available: false, reason: "GRAPH_REBUILD_UNAVAILABLE_PENDING_EP8" } }, `panel-empty-${collection}`);

		await panel.load();
		await waitFor(() => {
			expect(panel.root.querySelectorAll('[data-testid="graph-status-component"]')).toHaveLength(0);
			expect(panel.root.querySelector('[data-testid="graph-status-empty"]')?.textContent).toContain("No component graph status is available yet.");
			expect(panel.root.querySelector('[data-testid="code-intelligence-freshness"]')?.textContent).toContain("No graph published");
		});
	});

	it("renders declared language facts without deriving runtime availability", async () => {
		const panel = mount({
			components: [],
			manualRebuild: { available: false, reason: "GRAPH_REBUILD_UNAVAILABLE_PENDING_EP8" },
			capabilities: [{
				languageLabel: "TypeScript",
				evidence: { fileCount: 84, rootMarkers: ["tsconfig.json"], truncated: true },
				structuralSearch: "available",
				lsp: {
					state: "requires-toolchain",
					reason: "TypeScript Language Server is missing from the sandbox runtime.",
				},
			}],
		}, "panel-capabilities");

		await panel.load();
		await waitFor(() => {
			expect(panel.root.querySelector('[data-testid="code-intelligence-language-label"]')?.textContent).toContain("TypeScript");
			expect(panel.root.querySelector('[data-testid="code-intelligence-language-evidence"]')?.textContent).toContain("84 files · tsconfig.json");
			expect(panel.root.querySelector('[data-testid="code-intelligence-structural-state"]')?.textContent).toContain("Supported — syntax-aware, not type-aware");
			expect(panel.root.querySelector('[data-testid="code-intelligence-lsp-state"]')?.textContent).toContain("Needs runtime");
			expect(panel.root.querySelector('[data-testid="code-intelligence-lsp-reason"]')?.textContent).toContain("sandbox runtime");
			expect(panel.root.querySelector('[data-testid="code-intelligence-detection-truncated"]')?.textContent).toContain("10,000-entry limit");
		});
	});

	it("aggregates mixed component graph states conservatively and explains stale/base fallback consequences", async () => {
		const panel = mount({
			components: [
				{ component: { name: "web", repo: "services/web" }, revision: "0123456789abcdef", state: "fresh" },
				{ component: { name: "api", repo: "services/api" }, revision: "abcdef0123456789", state: "stale", staleReason: "parent-advanced" },
				{ component: { name: "worker", repo: "services/worker" }, revision: "base0123456789", state: "base-fallback", revisions: { baseRev: "base0123456789" } },
			],
			manualRebuild: { available: false, reason: "No lifecycle executor is declared." },
		}, "panel-component");

		await panel.load();
		await waitFor(() => {
			expect(panel.root.querySelectorAll('[data-testid="graph-status-component"]')).toHaveLength(3);
			expect(panel.root.querySelector('[data-testid="graph-status-component-label"]')?.textContent).toContain("web · services/web");
			expect(panel.root.querySelector('[data-testid="code-intelligence-freshness"]')?.textContent).toContain("Not current");
			const consequences = [...panel.root.querySelectorAll('[data-testid="graph-status-consequence"]')].map(node => node.textContent).join(" ");
			expect(consequences).toContain("the parent changed");
			expect(consequences).toContain("may omit branch-only changes");
		});
	});

	it("uses a disabled rebuild control and adjacent declared reason when no executor is available", async () => {
		const panel = mount({ components: [], manualRebuild: { available: false, reason: "GRAPH_REBUILD_UNAVAILABLE_PENDING_EP8" } }, "panel-rebuild-unavailable");
		await panel.load();
		await waitFor(() => {
			const rebuild = panel.root.querySelector('[data-testid="code-intelligence-rebuild"]') as HTMLButtonElement;
			expect(rebuild.disabled).toBe(true);
			expect(rebuild.textContent).toContain("Rebuild unavailable");
			expect(panel.root.querySelector('[data-testid="code-intelligence-rebuild-status"]')?.textContent).toContain("GRAPH_REBUILD_UNAVAILABLE_PENDING_EP8");
		});
	});

	it("keeps an available rebuild route-only and exposes busy feedback", async () => {
		const response = { components: [], manualRebuild: { available: true } };
		const panel = mount(response, "panel-rebuild-available");
		await panel.load();
		const pending = deferred<unknown>();
		panel.callRoute.mockImplementation(async (route: string) => route === "rebuild" ? pending.promise : response);

		(panel.root.querySelector('[data-testid="code-intelligence-rebuild"]') as HTMLButtonElement).click();
		await waitFor(() => {
			const rebuild = panel.root.querySelector('[data-testid="code-intelligence-rebuild"]') as HTMLButtonElement;
			expect(rebuild.textContent).toContain("Checking…");
			expect(rebuild.getAttribute("aria-busy")).toBe("true");
			expect(panel.root.textContent).not.toContain("Queued…");
		});
		pending.resolve({ status: response });
		await waitFor(() => expect(panel.root.querySelector('[data-testid="code-intelligence-rebuild"]')?.textContent).toContain("Rebuild index"));
	});

	it("provides semantic live, note, and button controls with persistent review guidance", async () => {
		const panel = mount({ components: [], manualRebuild: { available: false, reason: "not available" } }, "panel-accessible");
		const summary = panel.root.querySelector('[data-testid="code-intelligence-freshness"]');
		expect(summary?.getAttribute("role")).toBe("status");
		expect(summary?.getAttribute("aria-live")).toBe("polite");
		expect(summary?.getAttribute("aria-atomic")).toBe("true");
		expect(panel.root.querySelector('[data-testid="code-intelligence-no-cross-repo-warning"]')?.getAttribute("role")).toBe("note");
		expect(panel.root.querySelector('[data-testid="code-intelligence-no-cross-repo-warning"]')?.textContent).toContain("v1 has no cross-repo edges");
		expect(panel.root.querySelector('[data-testid="code-intelligence-review-guidance"]')?.textContent).toContain("Open and read every cited source");
		for (const button of panel.root.querySelectorAll("button")) expect(button.getAttribute("type")).toBe("button");
	});

	it("renders a route error envelope instead of masking it as an empty status", async () => {
		const panel = mount({ ok: false, error: "GRAPH_CONTEXT_PROJECT_REQUIRED" }, "panel-error-envelope");
		await panel.load();
		await waitFor(() => {
			expect(panel.root.querySelector('[role="alert"]')?.textContent).toContain("GRAPH_CONTEXT_PROJECT_REQUIRED");
			expect(panel.root.querySelector('[data-testid="graph-status-empty"]')).toBeNull();
		});
	});
});
