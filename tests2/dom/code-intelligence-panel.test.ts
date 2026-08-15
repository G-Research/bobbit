// v2-native — panel envelope parsing and route-only rebuild feedback.
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
		const panel = mount({
			state: "stale",
			[collection]: [],
			lifecycle: { automaticProcessing: "unavailable" },
		}, `panel-empty-${collection}`);

		await panel.load();
		await waitFor(() => {
			expect(panel.root.querySelectorAll('[data-testid="graph-status-component"]')).toHaveLength(0);
			expect(panel.root.querySelector('[data-testid="graph-status-empty"]')?.textContent)
				.toContain("No component graph status is available yet.");
			expect(panel.root.querySelector('[data-testid="code-intelligence-freshness"]')?.textContent)
				.toContain("STALE — no current graph is published.");
		});
	});

	it("renders component-labelled revision and stale reason from an envelope collection", async () => {
		const panel = mount({
			state: "stale",
			components: [{
				component: { name: "api", repo: "services/api" },
				revision: "0123456789abcdef",
				state: "stale",
				staleReason: "parent-advanced",
			}],
		}, "panel-component");

		await panel.load();
		await waitFor(() => {
			expect(panel.root.querySelectorAll('[data-testid="graph-status-component"]')).toHaveLength(1);
			expect(panel.root.querySelector('[data-testid="graph-status-component-label"]')?.textContent)
				.toContain("api · services/api");
			expect(panel.root.querySelector('[data-testid="graph-status-component-revision"]')?.textContent)
				.toContain("Revision: 0123456789ab");
			expect(panel.root.querySelector('[data-testid="graph-status-stale-reason"]')?.textContent)
				.toContain("Stale reason: parent advanced");
		});
	});

	it("uses non-queue wording while a route-only rebuild request is checked", async () => {
		const panel = mount({ state: "stale", components: [] }, "panel-rebuild");
		const pending = deferred<unknown>();
		panel.callRoute.mockImplementation(async (route: string) => route === "rebuild" ? pending.promise : { state: "stale", components: [] });

		(panel.root.querySelector('[data-testid="code-intelligence-rebuild"]') as HTMLButtonElement).click();
		await waitFor(() => {
			expect(panel.root.querySelector('[data-testid="code-intelligence-rebuild"]')?.textContent).toContain("Checking…");
			expect(panel.root.textContent).not.toContain("Queued…");
		});
		pending.resolve({ status: { state: "stale", components: [] } });
		await waitFor(() => expect(panel.root.querySelector('[data-testid="code-intelligence-rebuild"]')?.textContent).toContain("Rebuild"));
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
