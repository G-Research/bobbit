import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/sidebar-staff-rendering.spec.ts (v2-dom tier).
// FIDELITY NOTE: the legacy file:// fixture drove an INLINED pure function
// (getStaffRowInfo). There is no exported src counterpart — the staff-row logic
// is expressed inline at the sidebar render site — so this port keeps a
// byte-identical replica of the fixture helper and preserves every assertion.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSidebarData, state, type GatewaySession } from "../../src/app/state.js";
import { startSessionListPushSync, stopSessionListPushSync } from "../../src/app/api.js";

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
const STAFF_SESSION_ID = "staff-agent-session";
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
		});
		vi.stubGlobal("WebSocket", StaffSidebarPushSocket as any);
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/api/sessions")) {
				return new Response(JSON.stringify({ sessions: staffSidebarSessions(), archivedDelegates: [], generation: 1 }), { status: 200 });
			}
			if (url.includes("/api/goals")) {
				return new Response(JSON.stringify({ goals: [], generation: 1 }), { status: 200 });
			}
			if (url.includes("/api/projects")) {
				return new Response(JSON.stringify({ projects: [{ id: PROJECT_ID, name: "Fixture Project", rootPath: "/tmp/staff-sidebar-invalidation" }] }), { status: 200 });
			}
			if (url.includes("/api/staff/orphaned")) {
				return new Response(JSON.stringify({ staff: [] }), { status: 200 });
			}
			if (url.includes("/api/staff")) {
				return new Response(JSON.stringify({ staff: [{ id: "staff-1", name: "greeter", description: "", state: "active", triggers: [], projectId: PROJECT_ID, currentSessionId: STAFF_SESSION_ID }] }), { status: 200 });
			}
			return new Response("not found", { status: 404 });
		}) as any);
	});

	afterEach(() => {
		stopSessionListPushSync();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		localStorage.removeItem("gateway.url");
		localStorage.removeItem("gateway.token");
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
});
