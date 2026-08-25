import { describe, expect, it, vi } from "vitest";
import createPerformancePanel from "../../market-packs/performance-optimisation/src/performance-panel.ts";

function projectSnapshot() {
	return {
		version: 1 as const,
		generatedAt: Date.now(),
		project: { id: "project-1", name: "Live project" },
		staff: [
			{ id: "scanner-staff", name: "Optimisation Scanner", state: "active", roleId: "performance-scanner", currentSessionId: "scanner-session", createdAt: 1, updatedAt: 2 },
			{ id: "director-staff", name: "Optimisation Director", state: "active", roleId: "optimisation-director", currentSessionId: "director-session", createdAt: 1, updatedAt: 2 },
		],
		sessions: [
			{ id: "goal-session", title: "Goal team", status: "streaming", createdAt: 1, lastActivity: 20, goalId: "goal-1" },
			{ id: "scanner-session", title: "Optimisation Scanner", status: "streaming", createdAt: 1, lastActivity: 22, staffId: "scanner-staff" },
			{ id: "director-session", title: "Optimisation Director", status: "idle", createdAt: 1, lastActivity: 21, staffId: "director-staff" },
		],
		goals: [
			{ id: "goal-1", title: "Live performance goal", state: "in-progress", createdAt: 1, updatedAt: 2 },
			{ id: "goal-unrelated", title: "Unrelated project goal", state: "in-progress", createdAt: 1, updatedAt: 2 },
		],
		tasks: [{ id: "task-1", goalId: "goal-1", title: "Measure", type: "implementation", state: "blocked", createdAt: 1, updatedAt: 2 }],
		gates: [{ gateId: "gate-1", goalId: "goal-1", name: "Measure", status: "failed", signalCount: 1, updatedAt: 2 }],
		pullRequests: [{ goalId: "goal-1", number: 42, title: "Measured improvement", state: "OPEN", reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE" }],
		truncated: { staff: false, sessions: false, goals: false, tasks: false, gates: false, pullRequests: false },
	};
}

function fakeHost() {
	const notificationHandlers = new Map<string, Array<() => void>>();
	const refreshHandlers: Array<() => void> = [];
	const read = vi.fn(async (key: string) => key === "control-pane.ui"
		? { state: "present", value: { version: 1, tab: "flow" } }
		: { state: "absent" });
	const createBobbitSprite = vi.fn((options: { label: string }) => {
		const element = document.createElement("span");
		element.setAttribute("role", "img");
		element.setAttribute("aria-label", options.label);
		return element;
	});
	const callRoute = vi.fn(async () => ({
		ok: true,
		value: {
			version: 1,
			revision: 7,
			updatedAt: 1_700_000_000_000,
			scannerStaffId: "scanner-staff",
			directorStaffId: "director-staff",
			registry: [{ id: "hyp-1", title: "Avoid repeated parsing", status: "active", confidence: 0.9, sessionId: "scanner-session" }],
			goals: [
				{ id: "goal-1", label: "Stored title", detail: "active" },
				{ id: "goal-no-longer-live", label: "Concluded linked goal", detail: "concluded" },
			],
			coverage: [
				{ id: "unit-1", label: "src/server", kind: "Structural", state: "scanned", covered: 2, total: 2, children: [] },
				{ id: "unit-2", label: "src/app", kind: "Structural", state: "stale", covered: 0, total: 3, children: [] },
			],
			benchmarks: [{ id: "bench-1", name: "Session startup", component: "server", commandName: "benchmark:startup", metric: "p95", unit: "ms", direction: "lower", scanUnitIds: ["unit-1"], fileGlobs: ["src/server/**"], tags: ["startup"], warmup: 2, repetitions: 10 }],
			benchmarkRuns: [{ id: "run-1", hypothesisId: "hyp-1", benchmarkId: "bench-1", kind: "candidate", commit: "abc123", metrics: { p95: 640 }, variability: { sd: 11 }, interpretation: "Repeatable improvement", createdAt: "2024-02-01T00:00:00Z" }],
			outcomes: [{ hypothesisId: "hyp-1", outcome: "Recommend merging", measurementSummary: "p95 improved", recordedAt: "2024-02-02T00:00:00Z" }],
			activity: [
				{ id: "old", at: "2024-01-01T00:00:00Z", kind: "info", actor: "Scanner", message: "Older" },
				{ id: "new", at: "2024-02-01T00:00:00Z", kind: "success", actor: "Scanner", message: "Newer" },
			],
		},
	}));
	const openPanel = vi.fn();
	const navigate = vi.fn();
	const host = {
		version: 1,
		contractVersion: 7,
		capabilities: {
			callRoute: true, projectSnapshot: true, projectNotifications: true, store: true,
			session: false, ui: true, invokeAction: true, requestRender: true,
			has(name: string) { return Boolean((this as Record<string, unknown>)[name]); },
		},
		callRoute,
		project: {
			snapshot: vi.fn(async () => projectSnapshot()),
			notifications: {
				subscribe: vi.fn((name: string, handler: () => void) => {
					const handlers = notificationHandlers.get(name) ?? [];
					handlers.push(handler);
					notificationHandlers.set(name, handlers);
					return vi.fn();
				}),
				onRefreshRequired: vi.fn((handler: () => void) => {
					refreshHandlers.push(handler);
					queueMicrotask(handler);
					return vi.fn();
				}),
			},
		},
		store: { read, put: vi.fn(async () => undefined) },
		ui: { createBobbitSprite, openPanel, navigate }, session: {}, requestRender: vi.fn(), invokeAction: vi.fn(),
	};
	return { host, callRoute, read, createBobbitSprite, openPanel, navigate, notificationHandlers, refreshHandlers };
}

describe("Performance panel live data", () => {
	it("reads the pack route, joins Bobbit state by goal id, and coalesces project notifications", async () => {
		const fake = fakeHost();
		const root = createPerformancePanel().render(undefined, fake.host as any);
		await vi.waitFor(() => expect(fake.callRoute).toHaveBeenCalledTimes(1));
		expect(fake.callRoute).toHaveBeenCalledWith("performance-snapshot", {
			method: "GET",
			query: { view: "flow", activityLimit: 50 },
		});
		expect(fake.read).toHaveBeenCalledTimes(1);
		expect(fake.read).toHaveBeenCalledWith("control-pane.ui");
		expect(root.querySelector('[data-flow-node="goals"] .po-map-metric strong')?.textContent).toBe("1");
		expect(root.querySelector('[data-flow-node="benchmarks"] .po-map-metric strong')?.textContent).toBe("1");
		expect(root.querySelector(".po-headline-copy strong")?.textContent).toBe("40%");
		root.querySelector<HTMLButtonElement>('[data-flow-node="scanner"] .po-map-action')?.click();
		expect(fake.openPanel).toHaveBeenCalledWith({ panelId: "performance-optimisation.panel", params: { tab: "flow" }, sessionId: "scanner-session" });
		root.querySelector<HTMLButtonElement>('[data-flow-node="director"] .po-map-action')?.click();
		expect(fake.openPanel).toHaveBeenCalledWith({ panelId: "performance-optimisation.panel", params: { tab: "flow" }, sessionId: "director-session" });
		root.querySelector<HTMLButtonElement>('[data-flow-node="coverage"] .po-map-action')?.click();
		expect(fake.navigate).toHaveBeenCalledWith({ route: "performance-optimisation", params: { tab: "coverage" } });
		root.querySelector<HTMLButtonElement>('[data-flow-node="hypotheses"] .po-map-action')?.click();
		expect(fake.navigate).toHaveBeenCalledWith({ route: "performance-optimisation", params: { tab: "registry" } });
		root.querySelector<HTMLButtonElement>('[data-flow-node="benchmarks"] .po-map-action')?.click();
		expect(fake.navigate).toHaveBeenCalledWith({ route: "performance-optimisation", params: { tab: "benchmarks" } });
		const edges = Array.from(root.querySelectorAll<SVGGElement>(".po-edge"));
		expect(edges).toHaveLength(8);
		const tools = edges.flatMap((edge) => (edge.dataset.tools ?? "").split(", ").filter(Boolean));
		expect(tools).toHaveLength(10);
		expect(new Set(tools).size).toBe(tools.length);
		expect(tools).not.toContain("read_session");
		const benchmarkRoute = edges.find((edge) => edge.dataset.tools?.includes("perf_benchmark_list"));
		expect(benchmarkRoute?.getAttribute("aria-label")).toContain("benchmarks and goals (bidirectional)");
		expect(benchmarkRoute?.querySelector(".po-edge-line")?.hasAttribute("marker-start")).toBe(true);
		expect(root.querySelector(`[data-edge-tip="${benchmarkRoute?.dataset.edge}"]`)?.querySelectorAll("code")).toHaveLength(2);
		const scannerCoverageRoute = edges.find((edge) => edge.dataset.tools?.includes("perf_coverage_get_modules_to_scan"));
		expect(scannerCoverageRoute?.getAttribute("aria-label")).toContain("scanner and coverage (bidirectional)");
		expect(root.querySelector(`[data-edge-tip="${scannerCoverageRoute?.dataset.edge}"]`)?.querySelectorAll("code")).toHaveLength(2);
		expect(scannerCoverageRoute?.querySelector(".po-edge-line")?.hasAttribute("marker-start")).toBe(true);
		const ideatorCoverageRoute = edges.find((edge) => edge.dataset.tools?.includes("perf_coverage_mark_module_as"));
		expect(ideatorCoverageRoute?.getAttribute("aria-label")).toContain("ideators to coverage");
		expect(ideatorCoverageRoute?.querySelector(".po-edge-line")?.hasAttribute("marker-start")).toBe(false);
		for (const store of root.querySelectorAll<HTMLElement>(".po-map-node.is-store")) {
			expect(store.dataset.contentInset).toBe("46 12 25 12");
			expect(store.querySelector(".po-cylinder-cap")?.tagName.toLowerCase()).toBe("ellipse");
			expect(store.querySelector(".po-cylinder-bottom")?.tagName.toLowerCase()).toBe("ellipse");
			expect(store.querySelector(".po-map-node-content")).not.toBeNull();
		}
		expect(fake.createBobbitSprite).toHaveBeenCalledWith({ subject: { kind: "staff", id: "scanner-staff" }, state: "active", label: "Optimisation Scanner Bobbit avatar", size: 40, animated: true });
		expect(fake.createBobbitSprite).toHaveBeenCalledWith({ subject: { kind: "staff", id: "director-staff" }, state: "idle", label: "Optimisation Director Bobbit avatar", size: 40, animated: true });
		expect(root.querySelector('[aria-label="Optimisation Scanner Bobbit avatar"]')).not.toBeNull();
		expect(root.querySelector('[aria-label="Optimisation Director Bobbit avatar"]')).not.toBeNull();
		const statusDots = Array.from(root.querySelectorAll<HTMLElement>(".po-map-status"));
		expect(statusDots).toHaveLength(4);
		expect(statusDots.every((status) => !status.classList.contains("po-state") && status.textContent === "" && Boolean(status.getAttribute("aria-label")))).toBe(true);
		const feed = Array.from(root.querySelectorAll(".po-feed-row")).map((row) => row.textContent);
		expect(feed[0]).toContain("Newer");
		expect(feed[1]).toContain("Older");

		const routedLayout = root.querySelector(".po-map-layout");
		const routeResult = await fake.callRoute.mock.results[0].value;
		let resolveRefresh: ((value: typeof routeResult) => void) | undefined;
		fake.callRoute.mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
		fake.notificationHandlers.get("goalUpdated")?.[0]?.();
		fake.notificationHandlers.get("taskUpdated")?.[0]?.();
		fake.refreshHandlers[0]?.();
		await vi.waitFor(() => expect(fake.callRoute).toHaveBeenCalledTimes(2));
		expect(root.querySelector(".po-map-layout"), "the fully routed map stays mounted while refresh data is in flight").toBe(routedLayout);
		resolveRefresh?.(routeResult);
		await vi.waitFor(() => expect(root.querySelector(".po-map-layout")).not.toBe(routedLayout));
	});

	it("does not count concluded registry goals as in flight when the host snapshot is unavailable", async () => {
		const fake = fakeHost();
		fake.host.capabilities.projectSnapshot = false;
		const root = createPerformancePanel().render(undefined, fake.host as any);
		await vi.waitFor(() => expect(fake.callRoute).toHaveBeenCalledTimes(1));
		expect(fake.host.project.snapshot).not.toHaveBeenCalled();
		expect(root.querySelector('[data-flow-node="goals"] .po-map-metric strong')?.textContent).toBe("1");
		expect(Array.from(root.querySelectorAll(".po-headline-copy strong")).map(item => item.textContent)).toContain("1");
	});

	it("renders four working equal tabs and a searchable benchmark store from the live snapshot", async () => {
		const fake = fakeHost();
		const root = createPerformancePanel().render({ tab: "benchmarks" }, fake.host as any);
		await vi.waitFor(() => expect(root.textContent).toContain("Session startup"));
		expect(fake.callRoute).toHaveBeenCalledTimes(1);
		const tabs = Array.from(root.querySelectorAll<HTMLElement>('[role="tab"]'));
		expect(tabs).toHaveLength(4);
		expect(tabs.every((tab) => tab.querySelector("svg.po-tab-icon") !== null)).toBe(true);
		expect(root.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Benchmark store");
		const css = root.querySelector("style")?.textContent ?? "";
		expect(css).toContain("grid-template-columns: repeat(4, minmax(0, 1fr))");
		expect(css).toContain("padding: 4px 6px");
		expect(css).toContain("font-size: 1.1667em");
		expect(css).not.toContain(".po-tab[aria-selected=\"true\"]::after");
		expect(root.textContent).toContain("registered references");
		expect(root.textContent).toContain("Named command reference");
		expect(root.textContent).toContain("benchmark:startup");
		expect(root.textContent).toContain("640 ms");
		expect(root.textContent).toContain("Recommend merging");
		const search = root.querySelector<HTMLInputElement>('[aria-label="Search benchmark store"]')!;
		search.value = "missing";
		search.dispatchEvent(new InputEvent("input", { bubbles: true }));
		expect(root.textContent).toContain("No matches");
	});

	it("does not refetch, resubscribe, or rebuild for recreated host facades bound to the same session", async () => {
		const fake = fakeHost();
		const panel = createPerformancePanel();
		const params = { tab: "flow", __sessionId: "bound-session" };
		const root = panel.render(params, fake.host as any);
		await vi.waitFor(() => expect(root.querySelector('[data-flow-node="hypotheses"] .po-map-metric strong')?.textContent).toBe("1"));
		const routedLayout = root.querySelector(".po-map-layout");
		const subscriptions = fake.host.project.notifications.subscribe.mock.calls.length;

		const recreatedFacade = { ...fake.host, capabilities: { ...fake.host.capabilities } };
		panel.render({ ...params }, recreatedFacade as any);
		expect(fake.callRoute).toHaveBeenCalledTimes(1);
		expect(fake.host.project.snapshot).toHaveBeenCalledTimes(1);
		expect(fake.host.project.notifications.subscribe).toHaveBeenCalledTimes(subscriptions);
		expect(root.querySelector(".po-map-layout")).toBe(routedLayout);

		panel.render({ tab: "coverage", __sessionId: "bound-session" }, recreatedFacade as any);
		expect(root.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Scan coverage");
		expect(fake.callRoute).toHaveBeenCalledTimes(1);
	});

	it("keeps the user's current tab when the host rerenders unchanged route params during a data sync", async () => {
		const fake = fakeHost();
		const panel = createPerformancePanel();
		const params = { tab: "registry" };
		const root = panel.render(params, fake.host as any);
		await vi.waitFor(() => expect(fake.callRoute).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(root.textContent).toContain("Avoid repeated parsing"));
		expect(root.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Hypothesis registry");
		const sourceSessionButton = Array.from(root.querySelectorAll<HTMLButtonElement>(".po-row-button")).find(button => button.textContent === "Open source session");
		expect(sourceSessionButton?.disabled).toBe(false);
		sourceSessionButton?.click();
		expect(fake.openPanel).toHaveBeenCalledWith({ panelId: "performance-optimisation.panel", params: { tab: "registry" }, sessionId: "scanner-session" });

		(root.querySelector('[data-action="tab:coverage"]') as HTMLButtonElement).click();
		expect(root.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Scan coverage");
		await vi.waitFor(() => expect(root.querySelector('[aria-label="Filter scan coverage"]')).not.toBeNull());

		// Notification-driven host reconciliation calls the renderer again with the
		// same route params. Those params must not override local interaction state.
		panel.render({ ...params }, fake.host as any);
		expect(root.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Scan coverage");
		expect(root.querySelector('[aria-label="Filter scan coverage"]')).not.toBeNull();
	});
});
