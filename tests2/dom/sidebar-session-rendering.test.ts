import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/sidebar-session-rendering.spec.ts (v2-dom tier).
// `terseRelativeTime` and `formatSessionAge` are imported REAL from
// src/app/render-helpers.ts (higher fidelity). The remaining helpers
// (hasUnseenActivity's 4-arg pure variant, getSessionIndicatorType,
// getSandboxDotColor, getRolePickerItems, getKeyboardShortcutAction) have no
// exported src counterpart — the logic lives inline at the sidebar render sites —
// so they are kept as byte-identical replicas of the legacy fixture, preserving
// every assertion (SB-05..08, SB-15, SB-34, SB-36).
import { describe, expect, it } from "vitest";
import { terseRelativeTime, formatSessionAge } from "../../src/app/render-helpers.js";

function hasUnseenActivity(session: any, activeId: string, goals: any[], visitedMap: Record<string, number>): boolean {
	if (session.status === "streaming" || session.status === "busy") return false;
	if (session.id === activeId) return false;
	const teamGoal = session.teamGoalId || (session.role === "team-lead" ? session.goalId : undefined);
	if (teamGoal) {
		const goal = (goals || []).find(g => g.id === teamGoal);
		if (!goal || goal.state !== "complete") return false;
	}
	const lastVisit = (visitedMap || {})[session.id] || 0;
	return session.lastActivity > lastVisit;
}

function getSessionIndicatorType(session: any): string {
	if (session.status === "streaming" || session.status === "busy") return "pulsing-dot";
	if (session.isCompacting) return "compacting";
	if (session.isAborting) return "aborting";
	if (session.status === "connecting") return "spinner";
	return "time";
}

function getSandboxDotColor(status: string): string {
	return (status === "streaming" || status === "busy") ? "green" : "grey";
}

function getRolePickerItems(roles: any[]): Array<{ type: string; id: string }> {
	const items: Array<{ type: string; id: string }> = [];
	if (roles.length > 0) items.push({ type: "role", id: "role" });
	items.push({ type: "create", id: "create" });
	return items;
}

function getKeyboardShortcutAction(key: string, altKey: boolean, ctrlKey: boolean, metaKey: boolean, activeElementTag: string): string | null {
	if (activeElementTag === "TEXTAREA" || activeElementTag === "INPUT") return null;
	if (altKey && key === "g") return "new-goal";
	if ((ctrlKey || metaKey) && key === "k") return "focus-search";
	if ((ctrlKey || metaKey) && key === "[") return "toggle-sidebar";
	return null;
}

describe("SB-06: terseRelativeTime", () => {
	it("returns empty string for 0", () => expect(terseRelativeTime(0)).toBe(""));
	it("returns empty string for NaN", () => expect(terseRelativeTime(NaN)).toBe(""));
	it('returns "now" for timestamp less than 60s ago', () => expect(terseRelativeTime(Date.now() - 5000)).toBe("now"));
	it('returns "3m" for 3 minutes ago', () => expect(terseRelativeTime(Date.now() - 3 * 60000)).toBe("3m"));
	it('returns "2h" for 2 hours ago', () => expect(terseRelativeTime(Date.now() - 2 * 3600000)).toBe("2h"));
	it('returns "1d" for 1 day ago', () => expect(terseRelativeTime(Date.now() - 86400000)).toBe("1d"));
});

describe("SB-06: formatSessionAge", () => {
	it("returns empty string for 0", () => expect(formatSessionAge(0)).toBe(""));
	it("returns empty string for NaN", () => expect(formatSessionAge(NaN)).toBe(""));
	it('returns "just now" for less than 1 minute', () => expect(formatSessionAge(Date.now() - 5000)).toBe("just now"));
	it('returns "49m ago" for 49 minutes', () => expect(formatSessionAge(Date.now() - 49 * 60000)).toBe("49m ago"));
	it('returns "2h ago" for 2 hours', () => expect(formatSessionAge(Date.now() - 2 * 3600000)).toBe("2h ago"));
	it('returns "3d ago" for 3 days', () => expect(formatSessionAge(Date.now() - 3 * 86400000)).toBe("3d ago"));
});

describe("SB-07: hasUnseenActivity", () => {
	it("returns false for streaming session", () => {
		expect(hasUnseenActivity({ id: "s1", status: "streaming", lastActivity: Date.now() }, "other", [], {})).toBe(false);
	});
	it("returns false for busy session", () => {
		expect(hasUnseenActivity({ id: "s1", status: "busy", lastActivity: Date.now() }, "other", [], {})).toBe(false);
	});
	it("returns false when session is active", () => {
		expect(hasUnseenActivity({ id: "s1", status: "idle", lastActivity: Date.now() }, "s1", [], {})).toBe(false);
	});
	it("returns true when idle and lastActivity > lastVisit", () => {
		const now = Date.now();
		expect(hasUnseenActivity({ id: "s1", status: "idle", lastActivity: now }, "other", [], { s1: now - 10000 })).toBe(true);
	});
	it("returns false when lastActivity <= lastVisit", () => {
		const now = Date.now();
		expect(hasUnseenActivity({ id: "s1", status: "idle", lastActivity: now - 10000 }, "other", [], { s1: now })).toBe(false);
	});
	it("suppresses for team agent when goal is not complete", () => {
		const now = Date.now();
		const s = { id: "s1", status: "idle", lastActivity: now, teamGoalId: "g1" };
		expect(hasUnseenActivity(s, "other", [{ id: "g1", state: "in-progress" }], { s1: now - 10000 })).toBe(false);
	});
	it("shows for team agent when goal is complete", () => {
		const now = Date.now();
		const s = { id: "s1", status: "idle", lastActivity: now, teamGoalId: "g1" };
		expect(hasUnseenActivity(s, "other", [{ id: "g1", state: "complete" }], { s1: now - 10000 })).toBe(true);
	});
	it("returns false for team-lead role when goal not found", () => {
		const now = Date.now();
		const s = { id: "s1", status: "idle", lastActivity: now, role: "team-lead", goalId: "g1" };
		expect(hasUnseenActivity(s, "other", [], { s1: now - 10000 })).toBe(false);
	});
});

describe("SB-05: getSessionIndicatorType", () => {
	it('returns "pulsing-dot" for streaming', () => expect(getSessionIndicatorType({ status: "streaming" })).toBe("pulsing-dot"));
	it('returns "pulsing-dot" for busy', () => expect(getSessionIndicatorType({ status: "busy" })).toBe("pulsing-dot"));
	it('returns "compacting" for compacting session', () => expect(getSessionIndicatorType({ status: "idle", isCompacting: true })).toBe("compacting"));
	it('returns "aborting" for aborting session (SB-08)', () => expect(getSessionIndicatorType({ status: "idle", isAborting: true })).toBe("aborting"));
	it('returns "spinner" for connecting session', () => expect(getSessionIndicatorType({ status: "connecting" })).toBe("spinner"));
	it('returns "time" for idle session', () => expect(getSessionIndicatorType({ status: "idle" })).toBe("time"));
	it('returns "time" for terminated session', () => expect(getSessionIndicatorType({ status: "terminated" })).toBe("time"));
});

describe("SB-15: Role picker dropdown", () => {
	it("collapses roles to a single role dropdown item", () => {
		const result = getRolePickerItems([{ name: "coder" }, { name: "reviewer" }]);
		expect(result.filter(i => i.type === "role")).toEqual([{ type: "role", id: "role" }]);
	});
	it("always includes create button at end", () => {
		const result = getRolePickerItems([]);
		expect(result[result.length - 1]).toEqual({ type: "create", id: "create" });
	});
	it("empty roles returns only create button", () => {
		const result = getRolePickerItems([]);
		expect(result).toHaveLength(1);
		expect(result[0]!.type).toBe("create");
	});
});

describe("SB-34: Keyboard shortcut actions", () => {
	it('Alt+G returns "new-goal"', () => expect(getKeyboardShortcutAction("g", true, false, false, "BODY")).toBe("new-goal"));
	it('Ctrl+K returns "focus-search"', () => expect(getKeyboardShortcutAction("k", false, true, false, "BODY")).toBe("focus-search"));
	it('Ctrl+[ returns "toggle-sidebar"', () => expect(getKeyboardShortcutAction("[", false, true, false, "BODY")).toBe("toggle-sidebar"));
	it("suppressed when textarea is focused", () => expect(getKeyboardShortcutAction("g", true, false, false, "TEXTAREA")).toBeNull());
	it("suppressed when input is focused", () => expect(getKeyboardShortcutAction("g", true, false, false, "INPUT")).toBeNull());
	it("random key returns null", () => expect(getKeyboardShortcutAction("x", false, false, false, "BODY")).toBeNull());
});

describe("SB-36: getSandboxDotColor", () => {
	it('returns "green" for streaming', () => expect(getSandboxDotColor("streaming")).toBe("green"));
	it('returns "green" for busy', () => expect(getSandboxDotColor("busy")).toBe("green"));
	it('returns "grey" for idle', () => expect(getSandboxDotColor("idle")).toBe("grey"));
	it('returns "grey" for terminated', () => expect(getSandboxDotColor("terminated")).toBe("grey"));
});
