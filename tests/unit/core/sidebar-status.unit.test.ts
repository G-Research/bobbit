import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	collectEligibleStatusSessions,
	selectSidebarStatusSections,
	type StatusCandidate,
	type StatusSession,
} from "../../../src/app/sidebar-status.ts";
import {
	buildSidebarTree,
	type SidebarTreeModel,
	type SidebarTreeNode,
} from "../../../src/app/sidebar-tree-builder.ts";

function session(id: string, over: Partial<StatusSession> = {}): StatusSession {
	return {
		id,
		title: id,
		cwd: "/tmp",
		status: "idle",
		createdAt: 1,
		lastActivity: 1,
		clientCount: 0,
		...over,
	};
}

function candidate(id: string, over: Partial<StatusSession> = {}, archived = false): StatusCandidate {
	return { session: session(id, over), archived, staff: false };
}

const isPinned = (value: StatusSession) => value.user_tags?.includes("pinned=true") === true;
const isUnread = (value: StatusSession) => value.server_tags?.includes("read-state=unread") === true;
const isBusy = (value: StatusSession) => value.server_tags?.includes("activity-state=busy") === true;
const isTeamMember = (value: StatusSession) => value.server_tags?.includes("team-kind=member") === true;
const defaultFilters = { showArchived: false, showBusy: true, showRead: true, showTeams: false } as const;

function select(candidates: StatusCandidate[], options: Partial<Parameters<typeof selectSidebarStatusSections>[0]> = {}) {
	return selectSidebarStatusSections({
		candidates,
		filters: defaultFilters,
		isPinned,
		isUnread,
		isBusy,
		isTeamMember,
		...options,
	});
}

function ids(candidates: readonly StatusCandidate[]): string[] {
	return candidates.map(value => value.session.id);
}

describe("collectEligibleStatusSessions", () => {
	it("collects eligible session and team-lead nodes independent of expansion", () => {
		const model = buildSidebarTree({
			projects: [{ id: "p", name: "P" }],
			goals: [{ id: "g", title: "G", createdAt: 1, state: "todo", projectId: "p", team: true }],
			sessions: [
				{ id: "lead", title: "Lead", createdAt: 1, projectId: "p", goalId: "g", teamGoalId: "g", role: "team-lead" },
				{ id: "member", title: "Member", createdAt: 2, projectId: "p", teamGoalId: "g", role: "coder", teamLeadSessionId: "lead" },
				{ id: "child", title: "Child", createdAt: 3, projectId: "p", parentSessionId: "member" },
			],
			archivedSessions: [],
			showArchived: false,
			expansion: { isExpanded: () => false },
		});
		const staffSession = session("staff-live", { title: "Staff display", staffId: "staff" });
		const collected = collectEligibleStatusSessions(
			model,
			[{ currentSessionId: "staff-live" }],
			() => staffSession,
		);
		assert.deepEqual(new Set(ids(collected)), new Set(["lead", "member", "child", "staff-live"]));
		assert.equal(collected.find(value => value.session.id === "lead")?.goalId, "g");
		assert.equal(collected.find(value => value.session.id === "member")?.goalId, "g");
		assert.equal(collected.find(value => value.session.id === "child")?.goalId, "g", "child membership inherits from its tree ancestors");
		assert.equal(collected.find(value => value.session.id === "staff-live")?.staff, true);
	});

	it("deduplicates by id with live and staff-backed representations winning", () => {
		const archived = session("same", { archived: true, status: "archived", title: "Archived" });
		const live = session("same", { title: "Live" });
		const archivedNode = {
			kind: "team-lead",
			context: { session: archived },
		} as SidebarTreeNode;
		const liveNode = {
			kind: "session",
			context: { session: live, goalId: "goal-live" },
		} as SidebarTreeNode;
		const model = { flatByKey: new Map([["archived", archivedNode], ["live", liveNode]]) } as Pick<SidebarTreeModel, "flatByKey">;
		const collected = collectEligibleStatusSessions(model, [{ currentSessionId: "same" }], () => ({ ...live, title: "Staff name", staffId: "staff" }));
		assert.equal(collected.length, 1);
		assert.equal(collected[0].archived, false);
		assert.equal(collected[0].staff, true);
		assert.equal(collected[0].session.title, "Staff name");
		assert.equal(collected[0].goalId, "goal-live", "staff display replacement preserves canonical tree membership");
	});
});

describe("selectSidebarStatusSections", () => {
	it("classifies exclusively with Pinned taking priority over Unread", () => {
		const sections = select([
			candidate("pinned-unread", { user_tags: ["pinned=true"], server_tags: ["read-state=unread"] }),
			candidate("unread", { server_tags: ["read-state=unread"] }),
			candidate("read", { server_tags: ["read-state=read"] }),
		]);
		assert.deepEqual(ids(sections.pinned), ["pinned-unread"]);
		assert.deepEqual(ids(sections.unread), ["unread"]);
		assert.deepEqual(ids(sections.read), ["read"]);
		assert.equal([...sections.pinned, ...sections.unread, ...sections.read].length, 3);
	});

	it("sorts timestamp rows by activity and keeps shimmer-only active rows stable", () => {
		const sections = select([
			candidate("z", { lastActivity: 20, createdAt: 5, server_tags: ["read-state=unread"] }),
			candidate("b", { lastActivity: 20, createdAt: 10, server_tags: ["read-state=unread"] }),
			candidate("a", { lastActivity: 20, createdAt: 10, server_tags: ["read-state=unread"] }),
			candidate("newest", { lastActivity: 30, createdAt: 1, server_tags: ["read-state=unread"] }),
			candidate("active-new", { status: "streaming", lastActivity: 100, createdAt: 40, server_tags: ["read-state=unread"] }),
			candidate("active-old", { status: "busy", lastActivity: 200, createdAt: 35, server_tags: ["read-state=unread"] }),
		]);
		assert.deepEqual(ids(sections.unread), ["active-new", "active-old", "newest", "a", "b", "z"]);

		const afterHiddenActivityChurn = select([
			candidate("active-new", { status: "streaming", lastActivity: 500, createdAt: 40, server_tags: ["read-state=unread"] }),
			candidate("active-old", { status: "busy", lastActivity: 900, createdAt: 35, server_tags: ["read-state=unread"] }),
		]);
		assert.deepEqual(ids(afterHiddenActivityChurn.unread), ["active-new", "active-old"], "hidden timestamps must not reorder shimmer-only rows");
	});

	it("keeps categorical archive/team filters active for the open row until an explicit reveal", () => {
		const candidates = [
			candidate("active-archived-team", {
				server_tags: ["team-kind=member", "activity-state=busy", "read-state=read"],
			}, true),
			candidate("active-live", {
				server_tags: ["activity-state=busy", "read-state=read"],
			}),
			candidate("unread-visible", { server_tags: ["read-state=unread"] }),
		];

		const categoricallyHidden = select(candidates, {
			activeSessionId: "active-archived-team",
			filters: { showArchived: false, showTeams: false, showBusy: false, showRead: false },
		});
		assert.deepEqual(ids(categoricallyHidden.unread), ["unread-visible"]);
		assert.deepEqual(ids(categoricallyHidden.read), []);

		const busyReadExempt = select(candidates, {
			activeSessionId: "active-live",
			filters: { showArchived: false, showTeams: false, showBusy: false, showRead: false },
		});
		assert.deepEqual(ids(busyReadExempt.read), ["active-live"], "Busy/Read retain the established active-row exemption");
	});

	it("admits only the exact action-scoped reveal target through archive/team gates", () => {
		const candidates = [
			candidate("target", {
				server_tags: ["team-kind=member", "activity-state=busy", "read-state=read"],
			}, true),
			candidate("archived-other", { server_tags: ["read-state=unread"] }, true),
			candidate("member-other", { server_tags: ["team-kind=member", "read-state=unread"] }),
			candidate("unread-visible", { server_tags: ["read-state=unread"] }),
		];
		const sections = select(candidates, {
			activeSessionId: "target",
			revealSessionId: "target",
			filters: { showArchived: false, showTeams: false, showBusy: false, showRead: false },
		} as Partial<Parameters<typeof selectSidebarStatusSections>[0]>);

		assert.deepEqual(ids(sections.unread), ["unread-visible"]);
		assert.deepEqual(ids(sections.read), ["target"]);
		assert.deepEqual(ids(sections.pinned), []);
		assert.equal(
			[...sections.pinned, ...sections.unread, ...sections.read].some(value => value.session.id.endsWith("-other")),
			false,
			"the categorical exception must neither follow activeSessionId alone nor include unrelated rows",
		);
	});

	it("does not apply the read filter to active-work states", () => {
		const sections = select([
			candidate("busy-read", { status: "streaming", server_tags: ["activity-state=busy", "read-state=read"] }),
			candidate("read", { server_tags: ["read-state=read"] }),
		], {
			filters: { showArchived: false, showTeams: true, showBusy: true, showRead: false },
		});
		assert.equal(ids(sections.read).includes("busy-read"), true, "active-work states are not read-filterable");
		assert.equal(ids(sections.read).includes("read"), false);
	});

	it("uses production read-filterability for archived and terminal records", () => {
		const sections = select([
			candidate("archived-read", { status: "archived", server_tags: ["read-state=read"] }, true),
			candidate("terminated-read", { status: "terminated", server_tags: ["read-state=read"] }, true),
			candidate("idle-read", { status: "idle", server_tags: ["read-state=read"] }),
		], {
			filters: { showArchived: true, showTeams: false, showBusy: true, showRead: false },
		});
		assert.deepEqual(ids(sections.read), ["archived-read"]);
	});

	it("Show teams hides only canonical members, not delegates or first-class children", () => {
		const sections = select([
			candidate("lead", { role: "team-lead", server_tags: ["team-kind=lead", "read-state=unread"] }),
			candidate("member", { teamLeadSessionId: "lead", server_tags: ["team-kind=member", "read-state=unread"] }),
			candidate("legacy-member", { teamGoalId: "g", role: "coder", server_tags: ["team-kind=member", "read-state=unread"] }),
			candidate("delegate", { delegateOf: "lead", server_tags: ["team-kind=none", "read-state=unread"] }),
			candidate("child", { parentSessionId: "lead", server_tags: ["team-kind=none", "read-state=unread"] }),
		]);
		assert.deepEqual(new Set(ids(sections.unread)), new Set(["lead", "delegate", "child"]));
	});

	it("trimmed search bypasses every visibility gate without changing classification", () => {
		const sections = select([
			candidate("archived", { server_tags: ["read-state=read"] }, true),
			candidate("member", { server_tags: ["team-kind=member", "read-state=unread"] }),
			candidate("busy", { server_tags: ["activity-state=busy", "read-state=read"] }),
			candidate("pinned", { user_tags: ["pinned=true"], server_tags: ["read-state=read"] }),
		], {
			searchQuery: "  match  ",
			filters: { showArchived: false, showTeams: false, showBusy: false, showRead: false },
		});
		assert.deepEqual(ids(sections.pinned), ["pinned"]);
		assert.deepEqual(ids(sections.unread), ["member"]);
		assert.deepEqual(new Set(ids(sections.read)), new Set(["archived", "busy"]));
	});

	it("defensively deduplicates candidates before classification", () => {
		const duplicate = candidate("same", { server_tags: ["read-state=unread"] });
		const sections = select([duplicate, duplicate]);
		assert.deepEqual(ids(sections.unread), ["same"]);
	});
});
