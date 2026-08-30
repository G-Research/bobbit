import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../../tests2/dom/_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/pack-panels-reconcile.spec.ts (v2-dom tier).
// The legacy spec esbuild-bundled an entry that drove the REAL pack-panels
// registry (reconcilePackPanelsForProject / openPackPanel / setSessionSwitcher)
// via window globals under a file:// fixture. This port imports those SAME real
// functions + app state and stubs the global fetch. side-panel-workspace's
// `useServerWorkspaceApi()` keys off `window.location.protocol === "file:"` to
// take the in-memory (non-server) tab path the fixture relied on, so we set the
// happy-dom URL to file:// in beforeAll.
//
// Module-level reconcile dedupe state persists across tests in a fork (the
// legacy suite got a fresh page per test), so each test uses UNIQUE project ids.
// The shared module importer uses source-derived data URLs under Vitest, which
// lets this suite exercise successful module evaluation and generation fencing.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// pack-panels ⇄ host-api ⇄ ToolGroup form a module-init cycle (setPanelHostFactory
// runs before pack-panels finishes initializing its `panelHostFactory` binding).
// session-manager owns the canonical import order; importing it FIRST in beforeAll
// breaks the TDZ, then the real functions are bound from the settled modules.
let reconcilePackPanelsForProject: typeof import("../../src/app/pack-panels.js").reconcilePackPanelsForProject;
let registerPackPanels: typeof import("../../src/app/pack-panels.js").registerPackPanels;
let invalidatePackPanelModules: typeof import("../../src/app/pack-panels.js").invalidatePackPanelModules;
let renderPackPanelContent: typeof import("../../src/app/pack-panels.js").renderPackPanelContent;
let openPackPanel: typeof import("../../src/app/pack-panels.js").openPackPanel;
let setSessionSwitcher: typeof import("../../src/app/pack-panels.js").setSessionSwitcher;
let packPanelProjectId: typeof import("../../src/app/pack-panels.js").packPanelProjectId;
let state: typeof import("../../src/app/state.js").state;
let panelTabsForSession: typeof import("../../src/app/panel-workspace.js").panelTabsForSession;
let activePanelTabIdForSession: typeof import("../../src/app/panel-workspace.js").activePanelTabIdForSession;
let HOST_CONTRACT_VERSION: number;

type PackWire = { packId: string; packName: string; panels: Array<{ id: string; title?: string; instanceMode?: "singleton" | "parameterized"; instanceParam?: string }>; entrypoints: unknown[]; routeNames: string[] };

let fetchCalls: string[];
let contributions: PackWire[];
let panelModuleSource: string;
let panelRequest: ((url: string) => Response | Promise<Response>) | undefined;
const contribDelayByProject = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const panelModule = (label: string) => `export default function(){ return { render(params){ return ${JSON.stringify(label)} + ":" + String(params?.artifactId ?? ""); } }; }`;
const PANEL_MODULE = panelModule("default");

const DEMO: PackWire = { packId: "demo_pack", packName: "demo_pack", panels: [{ id: "demo.panel", title: "Demo" }], entrypoints: [], routeNames: [] };

beforeAll(async () => {
	(window as any).happyDOM?.setURL?.("file:///test.html");
	localStorage.setItem("gateway.url", "http://localhost");
	await import("../../src/app/session-manager.js");
	({ reconcilePackPanelsForProject, registerPackPanels, invalidatePackPanelModules, renderPackPanelContent, openPackPanel, setSessionSwitcher, packPanelProjectId } = await import("../../src/app/pack-panels.js"));
	({ state } = await import("../../src/app/state.js"));
	({ panelTabsForSession, activePanelTabIdForSession } = await import("../../src/app/panel-workspace.js"));
	({ HOST_CONTRACT_VERSION } = await import("../../src/shared/extension-host/host-api.js"));
	__syncCE();
});

beforeEach(() => {
	fetchCalls = [];
	contributions = [structuredClone(DEMO)];
	panelModuleSource = PANEL_MODULE;
	panelRequest = undefined;
	contribDelayByProject.clear();
	vi.stubGlobal("fetch", async (input: any): Promise<Response> => {
		const url = typeof input === "string" ? input : (input && input.url) || String(input);
		fetchCalls.push(String(url));
		if (String(url).includes("/side-panel-workspace")) {
			// Valid workspace body so the fire-and-forget settleMutation resolves
			// (an invalid body throws "Invalid side-panel workspace response" as a
			// run-failing unhandled rejection when the mutation settles post-test).
			return new Response(JSON.stringify({ version: 1, tabs: [], activeTabId: "", sizeMode: "split" }), { status: 200, headers: { "Content-Type": "application/json" } });
		}
		if (String(url).includes("/panels/")) {
			if (panelRequest) return panelRequest(String(url));
			return new Response(panelModuleSource, { status: 200, headers: { "Content-Type": "text/javascript" } });
		}
		if (String(url).includes("/api/ext/contributions")) {
			const m = /[?&]projectId=([^&]*)/.exec(String(url));
			const pid = m ? decodeURIComponent(m[1]) : "";
			const delay = contribDelayByProject.get(pid) ?? 0;
			if (delay > 0) await sleep(delay);
			return new Response(JSON.stringify({ packs: contributions }), { status: 200, headers: { "Content-Type": "application/json" } });
		}
		return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
	});
	// Reset per-session panel/workspace state so tab assertions are deterministic.
	state.panelTabsBySession = {} as any;
	state.panelWorkspaceActiveBySession = {} as any;
	(state as any).sidePanelWorkspaceBySession = {};
	(state as any).lastWorkspaceRevisionBySession = {};
	(state as any).selectedSessionId = null;
	(state as any).remoteAgent = null;
	setSessionSwitcher(undefined as any);
});

afterEach(() => { vi.unstubAllGlobals(); });

const clearCalls = () => { fetchCalls.length = 0; };
const calls = (): string[] => fetchCalls.slice();
const reconcile = (pid?: string) => reconcilePackPanelsForProject(pid);
const open = (panelId: string, packId?: string) => { openPackPanel({ panelId }, packId ?? "demo_pack"); };
const openWithParams = (panelId: string, params: Record<string, unknown>, packId?: string) => { openPackPanel({ panelId, params }, packId ?? "demo_pack"); };
const openWithInstanceKey = (panelId: string, instanceKey: string, params?: Record<string, unknown>, packId?: string) => { openPackPanel({ panelId, instanceKey, params }, packId ?? "demo_pack"); };
const openByPanelId = (panelId: string) => { openPackPanel({ panelId }); };
const openInSession = (panelId: string, sessionId: string, packId?: string) => { openPackPanel({ panelId, sessionId }, packId ?? "demo_pack"); };
const tabIdsForSession = (sid: string | undefined): string[] => panelTabsForSession(state, sid).map((t: any) => t?.id);
const activeTabIdForSession = (sid: string | undefined): string => activePanelTabIdForSession(state, sid);
const flush = async () => { await new Promise((r) => setTimeout(r, 30)); };
const panelRequestUrls = () => calls().filter((url) => url.includes("/panels/"));
const renderedPanel = (packId: string, panelId: string, params?: Record<string, unknown>) => renderPackPanelContent(packId, panelId, params);

describe("reconcilePackPanelsForProject (pack schema V1 §8.1)", () => {
	it("re-drives registration scoped to the active project; dedupes unchanged; swaps the loader on project change", async () => {
		clearCalls();
		await reconcile("P1a");
		expect(calls().some((u) => /\/api\/ext\/contributions\?projectId=P1a$/.test(u))).toBe(true);

		clearCalls();
		await reconcile("P1a");
		expect(calls().some((u) => u.includes("/api/ext/contributions"))).toBe(false);

		clearCalls();
		open("demo.panel");
		await flush();
		expect(calls().some((u) => u.includes("/api/ext/packs/demo_pack/panels/demo.panel?projectId=P1a"))).toBe(true);

		clearCalls();
		await reconcile("P1b");
		expect(calls().some((u) => /\/api\/ext\/contributions\?projectId=P1b$/.test(u))).toBe(true);

		clearCalls();
		open("demo.panel");
		await flush();
		expect(calls().some((u) => u.includes("/api/ext/packs/demo_pack/panels/demo.panel?projectId=P1b"))).toBe(true);
		expect(calls().some((u) => u.includes("projectId=P1a"))).toBe(false);
	});

	it("out-of-order completion: a late reconcile(A) response does NOT clobber the registry already applied for B", async () => {
		contribDelayByProject.set("P2a", 120);
		contribDelayByProject.set("P2b", 0);
		const pA = reconcile("P2a");
		const pB = reconcile("P2b");
		await pB;
		await pA;

		clearCalls();
		open("demo.panel");
		await flush();
		expect(calls().some((u) => u.includes("/api/ext/packs/demo_pack/panels/demo.panel?projectId=P2b"))).toBe(true);
		expect(calls().some((u) => u.includes("projectId=P2a"))).toBe(false);

		clearCalls();
		await reconcile("P2b");
		expect(calls().some((u) => u.includes("/api/ext/contributions"))).toBe(false);

		clearCalls();
		await reconcile("P2c");
		expect(calls().some((u) => /\/api\/ext\/contributions\?projectId=P2c$/.test(u))).toBe(true);
	});

	it("two packs share a panel id — a caller's packId opens ITS pack's panel; an ambiguous bare panelId no-ops", async () => {
		contributions = [
			{ packId: "pack_a", packName: "pack_a", panels: [{ id: "viewer", title: "A" }], entrypoints: [], routeNames: [] },
			{ packId: "pack_b", packName: "pack_b", panels: [{ id: "viewer", title: "B" }], entrypoints: [], routeNames: [] },
		];
		await reconcile("P3shared");

		clearCalls();
		open("viewer", "pack_a");
		await flush();
		expect(calls().some((u) => u.includes("/api/ext/packs/pack_a/panels/viewer"))).toBe(true);
		expect(calls().some((u) => u.includes("/api/ext/packs/pack_b/panels/viewer"))).toBe(false);

		clearCalls();
		open("viewer", "pack_b");
		await flush();
		expect(calls().some((u) => u.includes("/api/ext/packs/pack_b/panels/viewer"))).toBe(true);
		expect(calls().some((u) => u.includes("/api/ext/packs/pack_a/panels/viewer"))).toBe(false);

		clearCalls();
		openByPanelId("viewer");
		await flush();
		expect(calls().some((u) => u.includes("/panels/"))).toBe(false);
	});

	it("uninstall reconcile drops the panel — a later openPackPanel no-ops (no stale fetch)", async () => {
		await reconcile("P5a");

		contributions = [];
		await reconcile("P5d");
		await reconcile("P5a"); // re-drive same project (A→D→A) — no longer deduped

		clearCalls();
		open("demo.panel");
		await flush();
		expect(calls().some((u) => u.includes("/panels/"))).toBe(false);
	});

	it("PanelTarget.sessionId drives the real session switch and mounts the tab under the chosen session (contractVersion >= 3)", async () => {
		expect(HOST_CONTRACT_VERSION).toBeGreaterThanOrEqual(3);

		await reconcile("P6");
		let lastSwitchTarget: string | undefined;
		setSessionSwitcher((sid: string) => {
			lastSwitchTarget = sid;
			(state as any).selectedSessionId = sid;
		});
		(state as any).selectedSessionId = "owner-session";

		openInSession("demo.panel", "child-session");
		await flush();

		const expectedTabId = "pack:demo_pack:demo.panel:default";
		expect(lastSwitchTarget).toBe("child-session");
		expect((state as any).selectedSessionId).toBe("child-session");
		expect(tabIdsForSession("child-session")).toContain(expectedTabId);
		expect(activeTabIdForSession("child-session")).toBe(expectedTabId);
		expect(tabIdsForSession("owner-session")).not.toContain(expectedTabId);
	});

	it("default open (no PanelTarget.sessionId) mounts under the active session — v1 behaviour unchanged", async () => {
		await reconcile("P7");
		(state as any).selectedSessionId = "active-session";
		open("demo.panel");
		await flush();

		expect((state as any).selectedSessionId).toBe("active-session");
		expect(tabIdsForSession("active-session")).toContain("pack:demo_pack:demo.panel:default");
	});

	it("PanelTarget.instanceKey and allowlisted params create distinct pack panel tabs", async () => {
		await reconcile("P8");
		(state as any).selectedSessionId = "active-session";
		openWithParams("demo.panel", { artifactId: "artifact-a" });
		openWithParams("demo.panel", { artifactId: "artifact-b" });
		openWithInstanceKey("demo.panel", "explicit-key", { artifactId: "artifact-c" });
		await flush();

		const ids = tabIdsForSession("active-session");
		expect(ids).toContain("pack:demo_pack:demo.panel:artifact-a");
		expect(ids).toContain("pack:demo_pack:demo.panel:artifact-b");
		expect(ids).toContain("pack:demo_pack:demo.panel:explicit-key");
	});

	// The registered project scope is what side-panel pane RETENTION reads to keep
	// a retained hidden pane from being re-projected with another project's module
	// (docs/design/keep-side-panels-mounted.md §4.2). These pin the accessor's
	// contract against the "last requested project wins" registry.
	it("a registered panel carries the project of the last registration (cross-project, shared key)", () => {
		registerPackPanels([{ packId: "demo_pack", panelId: "demo.panel" }], "P9a");
		expect(packPanelProjectId("demo_pack", "demo.panel")).toBe("P9a");

		// Project B exposes the SAME {packId,panelId}: the entry survives, but its
		// project — and therefore the module behind it — is now B's.
		registerPackPanels([{ packId: "demo_pack", panelId: "demo.panel" }], "P9b");
		expect(packPanelProjectId("demo_pack", "demo.panel")).toBe("P9b");
	});

	it("a cross-project registration with disjoint keys unregisters the absent panel and closes its tab", async () => {
		registerPackPanels([{ packId: "demo_pack", panelId: "demo.panel" }], "P10a");
		(state as any).selectedSessionId = "sA";
		open("demo.panel");
		await flush();
		expect(tabIdsForSession("sA")).toContain("pack:demo_pack:demo.panel:default");

		registerPackPanels([{ packId: "other_pack", panelId: "other.panel" }], "P10b");
		await flush();

		// Treated as an uninstall: unregistered, and its tab is closed in EVERY
		// session (synchronously under the in-memory fixture workspace path).
		expect(packPanelProjectId("demo_pack", "demo.panel")).toBeUndefined();
		expect(packPanelProjectId("other_pack", "other.panel")).toBe("P10b");
		expect(tabIdsForSession("sA")).not.toContain("pack:demo_pack:demo.panel:default");
	});

	it("a genuine same-project uninstall unregisters only the removed panel", async () => {
		registerPackPanels([
			{ packId: "demo_pack", panelId: "demo.panel" },
			{ packId: "other_pack", panelId: "other.panel" },
		], "P11");
		(state as any).selectedSessionId = "sA";
		open("demo.panel");
		open("other.panel", "other_pack");
		await flush();
		expect(tabIdsForSession("sA")).toContain("pack:demo_pack:demo.panel:default");
		expect(tabIdsForSession("sA")).toContain("pack:other_pack:other.panel:default");

		registerPackPanels([{ packId: "other_pack", panelId: "other.panel" }], "P11");
		await flush();

		expect(packPanelProjectId("demo_pack", "demo.panel")).toBeUndefined();
		expect(packPanelProjectId("other_pack", "other.panel")).toBe("P11");
		expect(tabIdsForSession("sA")).not.toContain("pack:demo_pack:demo.panel:default");
		expect(tabIdsForSession("sA")).toContain("pack:other_pack:other.panel:default");
	});

	it("hot-invalidates fresh module bytes by token without changing tab identity, params, order, or selection", async () => {
		contributions = [{
			packId: "hot_identity",
			packName: "hot_identity",
			panels: [{ id: "viewer", title: "Hot viewer", instanceMode: "parameterized", instanceParam: "artifactId" }],
			entrypoints: [],
			routeNames: [],
		}];
		panelModuleSource = panelModule("v1");
		await reconcile("P9-hot-identity");
		(state as any).selectedSessionId = "hot-session";
		openPackPanel({ panelId: "viewer", params: { artifactId: "artifact-a", stable: true } }, "hot_identity");
		openPackPanel({ panelId: "viewer", params: { artifactId: "artifact-b", stable: true } }, "hot_identity");
		await vi.waitFor(() => expect(renderedPanel("hot_identity", "viewer", { artifactId: "artifact-a" })).toBe("v1:artifact-a"));

		const workspaceBefore = structuredClone({
			selectedSessionId: (state as any).selectedSessionId,
			panelTabsBySession: state.panelTabsBySession,
			panelWorkspaceActiveBySession: state.panelWorkspaceActiveBySession,
		});

		clearCalls();
		panelModuleSource = panelModule("v2");
		expect(invalidatePackPanelModules("hot_identity", 101)).toBe(1);
		expect({
			selectedSessionId: (state as any).selectedSessionId,
			panelTabsBySession: state.panelTabsBySession,
			panelWorkspaceActiveBySession: state.panelWorkspaceActiveBySession,
		}).toEqual(workspaceBefore);
		await vi.waitFor(() => expect(renderedPanel("hot_identity", "viewer", { artifactId: "artifact-a" })).toBe("v2:artifact-a"));
		expect(panelRequestUrls()).toEqual([
			"http://localhost/api/ext/packs/hot_identity/panels/viewer?projectId=P9-hot-identity&devReload=101",
		]);
		expect({
			selectedSessionId: (state as any).selectedSessionId,
			panelTabsBySession: state.panelTabsBySession,
			panelWorkspaceActiveBySession: state.panelWorkspaceActiveBySession,
		}).toEqual(workspaceBefore);

		clearCalls();
		panelModuleSource = panelModule("v3");
		expect(invalidatePackPanelModules("hot_identity", 102)).toBe(1);
		await vi.waitFor(() => expect(renderedPanel("hot_identity", "viewer", { artifactId: "artifact-b" })).toBe("v3:artifact-b"));
		expect(panelRequestUrls()).toEqual([
			"http://localhost/api/ext/packs/hot_identity/panels/viewer?projectId=P9-hot-identity&devReload=102",
		]);
		expect({
			selectedSessionId: (state as any).selectedSessionId,
			panelTabsBySession: state.panelTabsBySession,
			panelWorkspaceActiveBySession: state.panelWorkspaceActiveBySession,
		}).toEqual(workspaceBefore);
	});

	it("invalidating one pack leaves another pack's evaluated panel cached", async () => {
		registerPackPanels([
			{ packId: "hot_pack_a", panelId: "viewer" },
			{ packId: "hot_pack_b", panelId: "viewer" },
		], "P10-pack-isolation");
		let sourceA = panelModule("a-v1");
		let sourceB = panelModule("b-v1");
		panelRequest = (url) => new Response(url.includes("/hot_pack_a/") ? sourceA : sourceB, {
			status: 200,
			headers: { "Content-Type": "text/javascript" },
		});
		await vi.waitFor(() => expect(renderedPanel("hot_pack_a", "viewer")).toBe("a-v1:"));
		await vi.waitFor(() => expect(renderedPanel("hot_pack_b", "viewer")).toBe("b-v1:"));

		clearCalls();
		sourceA = panelModule("a-v2");
		sourceB = panelModule("b-v2");
		expect(invalidatePackPanelModules("hot_pack_a", 201)).toBe(1);
		expect(renderedPanel("hot_pack_b", "viewer")).toBe("b-v1:");
		await vi.waitFor(() => expect(renderedPanel("hot_pack_a", "viewer")).toBe("a-v2:"));
		expect(panelRequestUrls()).toEqual([
			"http://localhost/api/ext/packs/hot_pack_a/panels/viewer?projectId=P10-pack-isolation&devReload=201",
		]);
		expect(renderedPanel("hot_pack_b", "viewer")).toBe("b-v1:");
	});

	it("a stale in-flight module cannot resurrect after tokenized invalidation", async () => {
		registerPackPanels([{ packId: "hot_stale", panelId: "viewer" }], "P11-stale");
		let resolveStale!: (response: Response) => void;
		let requestCount = 0;
		panelRequest = () => {
			requestCount += 1;
			if (requestCount === 1) return new Promise<Response>((resolve) => { resolveStale = resolve; });
			return new Response(panelModule("new"), { status: 200, headers: { "Content-Type": "text/javascript" } });
		};

		renderedPanel("hot_stale", "viewer");
		await vi.waitFor(() => expect(requestCount).toBe(1));
		expect(invalidatePackPanelModules("hot_stale", 301)).toBe(1);
		await vi.waitFor(() => expect(renderedPanel("hot_stale", "viewer")).toBe("new:"));
		resolveStale(new Response(panelModule("stale"), { status: 200, headers: { "Content-Type": "text/javascript" } }));
		await flush();

		expect(renderedPanel("hot_stale", "viewer")).toBe("new:");
		expect(panelRequestUrls()).toEqual([
			"http://localhost/api/ext/packs/hot_stale/panels/viewer?projectId=P11-stale",
			"http://localhost/api/ext/packs/hot_stale/panels/viewer?projectId=P11-stale&devReload=301",
		]);
	});

	it("a later rebuild event recovers a panel after a failed tokenized load", async () => {
		registerPackPanels([{ packId: "hot_recovery", panelId: "viewer" }], "P12-recovery");
		panelModuleSource = panelModule("before");
		await vi.waitFor(() => expect(renderedPanel("hot_recovery", "viewer")).toBe("before:"));
		clearCalls();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		panelRequest = (url) => {
			const token = new URL(url).searchParams.get("devReload");
			if (token === "401") return new Response("failed", { status: 500 });
			return new Response(panelModule("recovered"), { status: 200, headers: { "Content-Type": "text/javascript" } });
		};

		expect(invalidatePackPanelModules("hot_recovery", 401)).toBe(1);
		renderedPanel("hot_recovery", "viewer");
		await vi.waitFor(() => expect(panelRequestUrls().some((url) => new URL(url).searchParams.get("devReload") === "401")).toBe(true));
		await flush();
		expect(invalidatePackPanelModules("hot_recovery", 402)).toBe(1);
		await vi.waitFor(() => expect(renderedPanel("hot_recovery", "viewer")).toBe("recovered:"));

		expect(panelRequestUrls().map((url) => new URL(url).searchParams.get("devReload"))).toEqual(["401", "402"]);
		error.mockRestore();
	});
});
