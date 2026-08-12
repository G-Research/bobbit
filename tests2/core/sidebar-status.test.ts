import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	collectEligibleStatusSessions,
	selectSidebarStatusSections,
	type StatusCandidate,
	type StatusSession,
} from "../../src/app/sidebar-status.ts";
import {
	buildSidebarTree,
	type SidebarTreeModel,
	type SidebarTreeNode,
} from "../../src/app/sidebar-tree-builder.ts";

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
			context: { session: live },
		} as SidebarTreeNode;
		const model = { flatByKey: new Map([["archived", archivedNode], ["live", liveNode]]) } as Pick<SidebarTreeModel, "flatByKey">;
		const collected = collectEligibleStatusSessions(model, [{ currentSessionId: "same" }], () => ({ ...live, title: "Staff name", staffId: "staff" }));
		assert.equal(collected.length, 1);
		assert.equal(collected[0].archived, false);
		assert.equal(collected[0].staff, true);
		assert.equal(collected[0].session.title, "Staff name");
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

	it("sorts each section by activity, creation, then id", () => {
		const sections = select([
			candidate("z", { lastActivity: 20, createdAt: 5, server_tags: ["read-state=unread"] }),
			candidate("b", { lastActivity: 20, createdAt: 10, server_tags: ["read-state=unread"] }),
			candidate("a", { lastActivity: 20, createdAt: 10, server_tags: ["read-state=unread"] }),
			candidate("newest", { lastActivity: 30, createdAt: 1, server_tags: ["read-state=unread"] }),
		]);
		assert.deepEqual(ids(sections.unread), ["newest", "a", "b", "z"]);
	});

	it("applies Archived, teams, Busy, and Read gates with only Busy/Read active exemptions", () => {
		const candidates = [
			candidate("archived-active", { server_tags: ["read-state=unread"] }, true),
			candidate("member-active", { server_tags: ["team-kind=member", "read-state=unread"] }),
			candidate("busy", { server_tags: ["activity-state=busy", "read-state=unread"] }),
			candidate("read", { server_tags: ["read-state=read"] }),
			candidate("busy-read", { server_tags: ["activity-state=busy", "read-state=read"] }),
			candidate("unread", { server_tags: ["read-state=unread"] }),
		];
		const sections = select(candidates, {
			activeSessionId: "member-active",
			filters: { showArchived: false, showTeams: false, showBusy: false, showRead: false },
		});
		assert.deepEqual(ids(sections.unread), ["unread"]);
		assert.deepEqual(ids(sections.read), []);
		assert.deepEqual(ids(sections.pinned), []);

		const busyReadVisible = select(candidates, {
			filters: { showArchived: false, showTeams: true, showBusy: true, showRead: false },
		});
		assert.equal(ids(busyReadVisible.read).includes("busy-read"), true, "busy rows retain the production Show Read exemption");
		assert.equal(ids(busyReadVisible.read).includes("read"), false);
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
