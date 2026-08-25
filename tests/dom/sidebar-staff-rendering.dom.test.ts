import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_helpers/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/sidebar-staff-rendering.spec.ts (v2-dom tier).
// FIDELITY NOTE: the legacy file:// fixture drove an INLINED pure function
// (getStaffRowInfo). There is no exported src counterpart — the staff-row logic
// is expressed inline at the sidebar render site — so this port keeps a
// byte-identical replica of the fixture helper and preserves every assertion.
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSidebarData, state, type GatewaySession } from "../../src/app/state.js";
import { startSessionListPushSync, stopSessionListPushSync } from "../../src/app/api.js";
import { buildSidebarTreeModel, renderSidebar } from "../../src/app/sidebar.js";

function getStaffRowInfo(
	staffMember: { name: string; retired?: boolean },
	activeSession: { status?: string } | null,
): {
	name: string;
	hasActiveSession: boolean;
	isRetired: boolean;
	showWakeButton: boolean;
	statusIndicator: string;
	dimmed: boolean;
} {
	return {
		name: staffMember.name,
		hasActiveSession: !!activeSession,
		isRetired: !!staffMember.retired,
		showWakeButton: !activeSession && !staffMember.retired,
		statusIndicator: activeSession
			? (activeSession.status === "streaming" || activeSession.status === "busy" ? "active" : "idle")
			: "none",
		dimmed: !!staffMember.retired,
	};
}

describe("SB-31: Staff row rendering", () => {
	it("staff with active streaming session", () => {
		const r = getStaffRowInfo({ name: "greeter", retired: false }, { status: "streaming" });
		expect(r.hasActiveSession).toBe(true);
		expect(r.statusIndicator).toBe("active");
		expect(r.showWakeButton).toBe(false);
	});

	it("staff with active busy session", () => {
		const r = getStaffRowInfo({ name: "greeter", retired: false }, { status: "busy" });
		expect(r.statusIndicator).toBe("active");
	});

	it("staff with idle session", () => {
		const r = getStaffRowInfo({ name: "greeter", retired: false }, { status: "idle" });
		expect(r.statusIndicator).toBe("idle");
		expect(r.showWakeButton).toBe(false);
	});

	it("staff with no session shows wake button", () => {
		const r = getStaffRowInfo({ name: "greeter", retired: false }, null);
		expect(r.showWakeButton).toBe(true);
		expect(r.statusIndicator).toBe("none");
		expect(r.hasActiveSession).toBe(false);
	});

	it("retired staff is dimmed and has no wake button", () => {
		const r = getStaffRowInfo({ name: "old-greeter", retired: true }, null);
		expect(r.dimmed).toBe(true);
		expect(r.showWakeButton).toBe(false);
		expect(r.isRetired).toBe(true);
	});

	it("staff name is preserved", () => {
		const r = getStaffRowInfo({ name: "my-staff-member", retired: false }, null);
		expect(r.name).toBe("my-staff-member");
	});
});

const PROJECT_ID = "staff-sidebar-invalidation-project";
const OTHER_PROJECT_ID = "staff-sidebar-other-project";
const STAFF_SESSION_ID = "staff-agent-session";
const FORK_STAFF_SESSION_ID = "forked-staff-agent-session";
const OTHER_STAFF_SESSION_ID = "other-staff-agent-session";
const STAFF_ASSISTANT_SESSION_ID = "staff-creation-assistant";

class StaffSidebarPushSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: StaffSidebarPushSocket[] = [];

	readyState = StaffSidebarPushSocket.OPEN;
	sent: string[] = [];

	constructor(public readonly url: string) {
		super();
		StaffSidebarPushSocket.instances.push(this);
		queueMicrotask(() => this.dispatchEvent(new Event("open")));
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = StaffSidebarPushSocket.CLOSED;
		this.dispatchEvent(new Event("close"));
	}

	emit(data: unknown): void {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
	}
}

function makeGatewaySession(overrides: Partial<GatewaySession>): GatewaySession {
	return {
		id: "session",
		title: "Session",
		cwd: "/tmp/staff-sidebar-invalidation",
		projectId: PROJECT_ID,
		status: "idle",
		createdAt: 1,
		lastActivity: 1,
		clientCount: 0,
		...overrides,
	} as GatewaySession;
}

function staffSidebarSessions(): GatewaySession[] {
	return [
		makeGatewaySession({ id: "plain-session", title: "Plain Session", createdAt: 1 }),
		makeGatewaySession({ id: STAFF_ASSISTANT_SESSION_ID, title: "Staff Creation Assistant", assistantType: "staff", createdAt: 2 }),
		makeGatewaySession({ id: STAFF_SESSION_ID, title: "greeter", createdAt: 3 }),
	];
}

function staffRecord(id: string, name: string, projectId: string, currentSessionId: string) {
	return { id, name, description: "", state: "active", triggers: [], projectId, currentSessionId };
}

let sessionsResponse: GatewaySession[];
let staffResponse: ReturnType<typeof staffRecord>[];
let projectsResponse: Array<{ id: string; name: string; rootPath: string }>;

describe("staff sidebar invalidation from external lifecycle pushes", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		StaffSidebarPushSocket.instances = [];
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
		localStorage.setItem("gateway.url", "https://gateway.test");
		localStorage.setItem("gateway.token", "gateway-token");
		Object.assign(state, {
			appView: "authenticated",
			gatewaySessions: [] as GatewaySession[],
			archivedSessions: [] as GatewaySession[],
			goals: [],
			projects: [],
			activeProjectId: PROJECT_ID,
			staffList: [],
			orphanedStaff: [],
			sessionsGeneration: -1,
			goalsGeneration: -1,
			sidebarCollapsed: false,
			sidebarSessionView: "project",
			sessionsLoading: false,
			sessionsError: null,
			searchQuery: "",
			showArchived: false,
			showBusy: true,
			showRead: true,
		});
		sessionsResponse = staffSidebarSessions();
		staffResponse = [staffRecord("staff-1", "greeter", PROJECT_ID, STAFF_SESSION_ID)];
		projectsResponse = [
			{ id: PROJECT_ID, name: "Fixture Project", rootPath: "/tmp/staff-sidebar-invalidation" },
			{ id: OTHER_PROJECT_ID, name: "Other Project", rootPath: "/tmp/staff-sidebar-other" },
		];
		const canvasContext = new Proxy({}, { get: () => () => {}, set: () => true });
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(canvasContext as CanvasRenderingContext2D);
		vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,c3RhdGlj");
		vi.stubGlobal("WebSocket", StaffSidebarPushSocket as any);
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/api/sessions")) {
				return new Response(JSON.stringify({ sessions: sessionsResponse, archivedDelegates: [], generation: 1 }), { status: 200 });
			}
			if (url.includes("/api/goals")) {
				return new Response(JSON.stringify({ goals: [], generation: 1 }), { status: 200 });
			}
			if (url.includes("/api/projects")) {
				return new Response(JSON.stringify({ projects: projectsResponse }), { status: 200 });
			}
			if (url.includes("/api/staff/orphaned")) {
				return new Response(JSON.stringify({ staff: [] }), { status: 200 });
			}
			if (url.includes("/api/staff")) {
				return new Response(JSON.stringify({ staff: staffResponse }), { status: 200 });
			}
			return new Response("not found", { status: 404 });
		}) as any);
	});

	afterEach(() => {
		stopSessionListPushSync();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		localStorage.removeItem("gateway.url");
		localStorage.removeItem("gateway.token");
		document.body.innerHTML = "";
		Object.assign(state, {
			appView: "unauthenticated",
			gatewaySessions: [] as GatewaySession[],
			archivedSessions: [] as GatewaySession[],
			goals: [],
			projects: [],
			staffList: [],
			orphanedStaff: [],
			sessionsGeneration: -1,
			goalsGeneration: -1,
		});
	});

	it("reloads staff before classifying a newly-created permanent staff session", async () => {
		startSessionListPushSync();
		const socket = StaffSidebarPushSocket.instances[0];
		expect(socket).toBeTruthy();

		socket.emit({ type: "session_created", sessionId: STAFF_SESSION_ID });
		socket.emit({ type: "staff_changed", reason: "created", staffId: "staff-1", projectId: PROJECT_ID, sessionId: STAFF_SESSION_ID });
		await vi.advanceTimersByTimeAsync(150);

		const ids = getSidebarData().ungroupedSessions.map((s) => s.id);
		expect(ids).toContain(STAFF_ASSISTANT_SESSION_ID);
		expect(ids, "staff permanent session must move out of regular Sessions after external staff lifecycle push").not.toContain(STAFF_SESSION_ID);
	});

	it("places a forked permanent session beside its source under the owning project's Staff section", async () => {
		startSessionListPushSync();
		const socket = StaffSidebarPushSocket.instances[0];
		expect(socket).toBeTruthy();

		sessionsResponse = [
			...staffSidebarSessions(),
			makeGatewaySession({ id: FORK_STAFF_SESSION_ID, title: "Fork: greeter", createdAt: 4 }),
			makeGatewaySession({ id: OTHER_STAFF_SESSION_ID, title: "reviewer", projectId: OTHER_PROJECT_ID, cwd: "/tmp/staff-sidebar-other", createdAt: 5 }),
		];
		staffResponse = [
			staffRecord("staff-1", "greeter", PROJECT_ID, STAFF_SESSION_ID),
			staffRecord("staff-fork", "Fork: greeter", PROJECT_ID, FORK_STAFF_SESSION_ID),
			staffRecord("staff-other", "reviewer", OTHER_PROJECT_ID, OTHER_STAFF_SESSION_ID),
		];

		socket.emit({ type: "session_created", sessionId: FORK_STAFF_SESSION_ID });
		socket.emit({ type: "staff_changed", reason: "created", staffId: "staff-fork", projectId: PROJECT_ID, sessionId: FORK_STAFF_SESSION_ID });
		await vi.advanceTimersByTimeAsync(150);

		const sidebarData = getSidebarData();
		expect(sidebarData.staffSessionIds).toEqual(new Set([STAFF_SESSION_ID, FORK_STAFF_SESSION_ID, OTHER_STAFF_SESSION_ID]));
		expect(sidebarData.ungroupedSessions.map((session) => session.id)).toEqual(["plain-session", STAFF_ASSISTANT_SESSION_ID]);

		const tree = buildSidebarTreeModel(sidebarData);
		expect(tree.projects.find((project) => project.project.id === PROJECT_ID)?.staffRows.map((staff) => staff.id)).toEqual(["staff-1", "staff-fork"]);
		expect(tree.projects.find((project) => project.project.id === OTHER_PROJECT_ID)?.staffRows.map((staff) => staff.id)).toEqual(["staff-other"]);

		const host = document.createElement("div");
		document.body.append(host);
		render(renderSidebar(), host);

		const owningProject = host.querySelector<HTMLElement>(`[data-project-id="${PROJECT_ID}"]`)!;
		const otherProject = host.querySelector<HTMLElement>(`[data-project-id="${OTHER_PROJECT_ID}"]`)!;
		const owningStaffSection = owningProject.querySelector('[data-testid="sidebar-staff-header"]')!.parentElement!;
		const owningSessionsSection = owningProject.querySelector('[data-testid="sidebar-sessions-header"]')!.parentElement!;
		const staffTitles = [...owningStaffSection.querySelectorAll('[data-testid="sidebar-session-title-text"]')].map((element) => element.textContent?.trim());
		const sessionTitles = [...owningSessionsSection.querySelectorAll('[data-testid="sidebar-session-title-text"]')].map((element) => element.textContent?.trim());
		const otherStaffTitles = [...otherProject.querySelector('[data-testid="sidebar-staff-header"]')!.parentElement!.querySelectorAll('[data-testid="sidebar-session-title-text"]')].map((element) => element.textContent?.trim());

		expect(staffTitles).toEqual(["greeter", "Fork: greeter"]);
		expect(sessionTitles).toEqual(["Plain Session", "Staff Creation Assistant"]);
		expect(sessionTitles).not.toContain("Fork: greeter");
		expect(otherStaffTitles).toEqual(["reviewer"]);
	});
});

describe("staff sidebar cache invalidation", () => {
	beforeEach(() => {
		Object.assign(state, {
			gatewaySessions: [
				makeGatewaySession({ id: "plain-session", title: "Plain Session", createdAt: 1 }),
				makeGatewaySession({ id: STAFF_ASSISTANT_SESSION_ID, title: "Staff Creation Assistant", assistantType: "staff", createdAt: 2 }),
				makeGatewaySession({ id: STAFF_SESSION_ID, title: "greeter", createdAt: 3 }),
			],
			archivedSessions: [] as GatewaySession[],
			goals: [],
			projects: [],
			activeProjectId: PROJECT_ID,
			staffList: [{ id: "staff-1", name: "greeter", description: "hello", state: "active", triggers: [{ id: "manual", type: "manual" }], projectId: PROJECT_ID, currentSessionId: STAFF_SESSION_ID, lastWakeAt: 1 }],
		});
	});

	afterEach(() => {
		Object.assign(state, {
			gatewaySessions: [] as GatewaySession[],
			archivedSessions: [] as GatewaySession[],
			goals: [],
			projects: [],
			staffList: [],
			orphanedStaff: [],
		});
	});

	it("keeps staff-creation assistant sessions in regular Sessions while excluding linked permanent staff sessions", () => {
		const ids = getSidebarData().ungroupedSessions.map((s) => s.id);
		expect(ids).toContain("plain-session");
		expect(ids).toContain(STAFF_ASSISTANT_SESSION_ID);
		expect(ids).not.toContain(STAFF_SESSION_ID);
	});

	it.each([
		["id", { id: "staff-2" }],
		["name", { name: "renamed-greeter" }],
		["description", { description: "updated description" }],
		["state", { state: "paused" }],
		["projectId", { projectId: "other-project" }],
		["currentSessionId", { currentSessionId: "other-staff-session" }],
		["lastWakeAt", { lastWakeAt: 2 }],
		["triggers", { triggers: [{ id: "schedule", type: "schedule", cron: "* * * * *" }] }],
	])("invalidates memoized sidebar data when staff %s changes", (_field, patch) => {
		const first = getSidebarData();
		state.staffList = [{ ...state.staffList[0], ...patch } as any];
		const second = getSidebarData();
		expect(second).not.toBe(first);
	});
});
