import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/sidebar-goal-group-filters.spec.ts (v2-dom tier).
// FIDELITY NOTE: the legacy file:// fixture mirrored the (fixed) renderGoalGroup
// partitioning as pure functions. The real `passesSidebarFilters`
// (src/app/render-helpers.ts) reads module-level `state.showBusy`/`state.showRead`
// and the goal-group extraction (`computeGoalGroupDisplaySessions`) is not an
// exported helper — it lives inline in renderGoalGroup. To exercise these with
// explicit flags (as every case here requires) without mutating shared module
// state under isolate:false, this port keeps byte-identical replicas of the
// fixture helpers and preserves every assertion.
import { describe, expect, it } from "vitest";

function hasUnseenActivity(session: any, isActive: boolean): boolean {
	if (session.status === "streaming" || session.status === "busy") return false;
	if (isActive) return false;
	const lastRead = session.lastReadAt != null ? session.lastReadAt : 0;
	return (session.lastActivity || 0) > lastRead;
}

function passesSidebarFilters(
	session: any,
	isActive: boolean,
	bypass: boolean,
	flags: { showBusy: boolean; showRead: boolean },
): boolean {
	if (bypass || isActive) return true;
	if (!flags.showBusy) {
		const busy = session.status === "streaming"
			|| session.status === "aborting"
			|| session.status === "preparing"
			|| session.status === "starting"
			|| session.isCompacting;
		if (busy) return false;
	}
	if (!flags.showRead) {
		const idleLike = session.status === "idle" || session.status === "terminated";
		if (idleLike && !hasUnseenActivity(session, isActive)) return false;
	}
	return true;
}

function computeGoalGroupDisplaySessions(
	goalSessions: any[],
	opts: { activeId: string | null; showBusy: boolean; showRead: boolean; searchQuery: string; isTeamGoal: boolean },
): any[] {
	const flags = { showBusy: opts.showBusy, showRead: opts.showRead };
	const bypass = (opts.searchQuery || "").trim().length > 0;
	const filtered = goalSessions.filter(s => passesSidebarFilters(s, s.id === opts.activeId, bypass, flags));
	if (!opts.isTeamGoal) return filtered;
	const naturalLead = goalSessions.find(s => s.role === "team-lead");
	if (naturalLead && !filtered.includes(naturalLead) && filtered.length > 0) {
		return [naturalLead, ...filtered].sort((a, b) => a.createdAt - b.createdAt);
	}
	return filtered;
}

// --- session factories ----------------------------------------------------

const NOW = 1_700_000_000_000;

function idleReadSession(over: Partial<any> = {}): any {
	return { id: "s-idle-read", title: "idle read session", cwd: "/x", status: "idle", role: undefined, createdAt: NOW, lastActivity: NOW, lastReadAt: NOW, clientCount: 0, ...over };
}
function idleUnreadSession(over: Partial<any> = {}): any {
	return { id: "s-idle-unread", title: "idle unread session", cwd: "/x", status: "idle", role: undefined, createdAt: NOW, lastActivity: NOW + 5_000, lastReadAt: NOW, clientCount: 0, ...over };
}
function streamingSession(over: Partial<any> = {}): any {
	return { id: "s-streaming", title: "busy session", cwd: "/x", status: "streaming", role: undefined, createdAt: NOW, lastActivity: NOW, lastReadAt: NOW, clientCount: 0, ...over };
}

const defaultOpts = { activeId: null, showBusy: true, showRead: true, searchQuery: "", isTeamGoal: false };

const ids = (sessions: any[], opts: any) => computeGoalGroupDisplaySessions(sessions, opts).map(s => s.id);

describe("plain goal · Show Read filter", () => {
	it("idle read session is hidden when showRead=false", () => {
		expect(ids([idleReadSession()], { ...defaultOpts, showRead: false })).toEqual([]);
	});
	it("idle read session is visible when showRead=true", () => {
		expect(ids([idleReadSession()], { ...defaultOpts, showRead: true })).toEqual(["s-idle-read"]);
	});
	it("idle UNREAD session is visible even when showRead=false (unseen exemption)", () => {
		expect(ids([idleUnreadSession()], { ...defaultOpts, showRead: false })).toEqual(["s-idle-unread"]);
	});
});

describe("plain goal · Show Busy filter", () => {
	it("streaming session is hidden when showBusy=false", () => {
		expect(ids([streamingSession()], { ...defaultOpts, showBusy: false })).toEqual([]);
	});
	it("streaming session is visible when showBusy=true", () => {
		expect(ids([streamingSession()], { ...defaultOpts, showBusy: true })).toEqual(["s-streaming"]);
	});
	it("isCompacting=true counts as busy and is hidden when showBusy=false", () => {
		expect(ids([idleReadSession({ id: "s-compacting", isCompacting: true })], { ...defaultOpts, showBusy: false })).toEqual([]);
	});
});

describe("active session exemption", () => {
	it("active idle-read session is visible even when showRead=false", () => {
		expect(ids([idleReadSession({ id: "s-active" })], { ...defaultOpts, showRead: false, activeId: "s-active" })).toEqual(["s-active"]);
	});
	it("active streaming session is visible even when showBusy=false", () => {
		expect(ids([streamingSession({ id: "s-active" })], { ...defaultOpts, showBusy: false, activeId: "s-active" })).toEqual(["s-active"]);
	});
});

describe("search bypasses filters", () => {
	it("non-empty searchQuery → all sessions returned regardless of toggles", () => {
		expect(ids([idleReadSession(), streamingSession()], { ...defaultOpts, showBusy: false, showRead: false, searchQuery: "foo" })).toEqual(["s-idle-read", "s-streaming"]);
	});
	it("whitespace-only searchQuery does NOT bypass filters", () => {
		expect(ids([idleReadSession()], { ...defaultOpts, showRead: false, searchQuery: "   " })).toEqual([]);
	});
});

describe("team-lead sticky", () => {
	it("idle-read lead is kept when a child still passes (showBusy=true, showRead=false, child streaming)", () => {
		const lead = idleReadSession({ id: "lead", role: "team-lead", createdAt: NOW });
		const child = streamingSession({ id: "child", role: "coder", createdAt: NOW + 1 });
		expect(ids([lead, child], { ...defaultOpts, showBusy: true, showRead: false, isTeamGoal: true })).toEqual(["lead", "child"]);
	});
	it("lead drops when every child also fails the filter", () => {
		const lead = idleReadSession({ id: "lead", role: "team-lead", createdAt: NOW });
		const child = idleReadSession({ id: "child", role: "coder", createdAt: NOW + 1 });
		expect(ids([lead, child], { ...defaultOpts, showRead: false, isTeamGoal: true })).toEqual([]);
	});
	it("lead that passes on its own is unaffected by sticky logic", () => {
		const lead = streamingSession({ id: "lead", role: "team-lead", createdAt: NOW });
		const child = idleReadSession({ id: "child", role: "coder", createdAt: NOW + 1 });
		expect(ids([lead, child], { ...defaultOpts, showRead: false, showBusy: true, isTeamGoal: true })).toEqual(["lead"]);
	});
	it("non-team goal does NOT apply sticky logic — lead-like sessions filter normally", () => {
		const a = idleReadSession({ id: "a", role: "team-lead", createdAt: NOW });
		const b = idleReadSession({ id: "b", role: "coder", createdAt: NOW + 1 });
		expect(ids([a, b], { ...defaultOpts, showRead: false, isTeamGoal: false })).toEqual([]);
	});
});

describe("empty display list is allowed (goal header stays visible)", () => {
	it("all-filtered-out goal returns empty list (goal header path renders empty state)", () => {
		expect(computeGoalGroupDisplaySessions([idleReadSession()], { ...defaultOpts, showRead: false }).length).toBe(0);
	});
});
