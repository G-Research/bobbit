import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
	buildSidebarTree,
	parseSidebarTreeKey,
	resolveSidebarTreeLayoutPreference,
	sidebarTreeKey,
	type GoalLike,
	type ProjectLike,
	type SessionLike,
} from "../src/app/sidebar-tree-builder.ts";
import { _setSubgoalsEnabledForTesting } from "../src/app/subgoals-flag.ts";

const project = (id = "p1"): ProjectLike => ({ id, name: id, rootPath: `/tmp/${id}` });

function goal(over: Partial<GoalLike> & { id: string }): GoalLike {
	return {
		id: over.id,
		title: over.id,
		projectId: "p1",
		state: "todo",
		createdAt: 0,
		...over,
	};
}

function session(over: Partial<SessionLike> & { id: string }): SessionLike {
	return {
		id: over.id,
		projectId: "p1",
		createdAt: 0,
		status: "idle",
		title: over.id,
		...over,
	};
}

function countNodes(nodes: readonly { children: any[] }[]): number {
	let count = 0;
	const visit = (node: { children: any[] }) => {
		count++;
		for (const child of node.children) visit(child);
	};
	for (const node of nodes) visit(node);
	return count;
}

function allGoalIds(nodes: readonly { kind: string; entityId: string; children: any[] }[]): string[] {
	const ids: string[] = [];
	const visit = (node: { kind: string; entityId: string; children: any[] }) => {
		if (node.kind === "goal") ids.push(node.entityId);
		for (const child of node.children) visit(child);
	};
	for (const node of nodes) visit(node);
	return ids;
}

describe("sidebar tree key primitives", () => {
	it("serializes and parses punctuation ids and session-children classes", () => {
		const key = sidebarTreeKey({ kind: "goal", goalId: "goal/with spaces?#" });
		assert.equal(key, "sidebar-tree/v1/goal/goal%2Fwith%20spaces%3F%23");
		assert.deepEqual(parseSidebarTreeKey(key), { kind: "goal", goalId: "goal/with spaces?#" });

		const childrenKey = sidebarTreeKey({ kind: "session-children", sessionId: "sess/1", childClass: "archived-delegate" });
		assert.equal(childrenKey, "sidebar-tree/v1/session-children/sess%2F1?childClass=archived-delegate");
		assert.deepEqual(parseSidebarTreeKey(childrenKey), { kind: "session-children", sessionId: "sess/1", childClass: "archived-delegate" });
	});

	it("rejects malformed keys", () => {
		assert.equal(parseSidebarTreeKey("goal:x"), null);
		assert.equal(parseSidebarTreeKey("sidebar-tree/v1/goal"), null);
		assert.equal(parseSidebarTreeKey("sidebar-tree/v1/session-children/s?childClass=nope"), null);
		assert.equal(parseSidebarTreeKey("sidebar-tree/v1/session/s?childClass=first-class"), null);
	});

	it("resolves clamped indentation defaults for builder metadata", () => {
		assert.deepEqual(resolveSidebarTreeLayoutPreference(), { version: 1, indentMode: "comfortable", baseIndentPx: 5, nestedGoalIndentPx: 16 });
		assert.deepEqual(resolveSidebarTreeLayoutPreference({ indentMode: "spacious", baseIndentPx: 16, nestedGoalIndentPx: 28 }), { version: 1, indentMode: "spacious", baseIndentPx: 16, nestedGoalIndentPx: 28 });
		assert.deepEqual(resolveSidebarTreeLayoutPreference({ indentMode: "spacious", baseIndentPx: 99, nestedGoalIndentPx: Number.NaN }), { version: 1, indentMode: "spacious", baseIndentPx: 5, nestedGoalIndentPx: 16 });
	});
});

describe("buildSidebarTree", () => {
	before(() => _setSubgoalsEnabledForTesting(true));
	after(() => _setSubgoalsEnabledForTesting(undefined));

	it("emits project, goal, team-lead, member, sessions, staff, and archived section nodes", () => {
		const model = buildSidebarTree({
			projects: [project()],
			goals: [goal({ id: "g", team: true })],
			sessions: [
				session({ id: "lead", goalId: "g", teamGoalId: "g", role: "team-lead", createdAt: 1 }),
				session({ id: "member", teamGoalId: "g", role: "coder", teamLeadSessionId: "lead", createdAt: 2 }),
				session({ id: "ungrouped", createdAt: 3 }),
			],
			archivedSessions: [session({ id: "archived-session", archived: true, status: "archived", createdAt: 4 })],
			staff: [{ id: "staff", projectId: "p1", name: "Staff" }],
			showArchived: true,
		});
		const tree = model.projects[0];
		assert.equal(tree.projectNode.parentKey, null);
		assert.equal(tree.goalForest[0].parentKey, tree.projectNode.key);
		const teamLead = tree.goalForest[0].children.find(n => n.kind === "team-lead")!;
		assert.equal(teamLead.entityId, "lead");
		assert.equal(teamLead.children.find(n => n.kind === "session")?.entityId, "member");
		assert.equal(tree.sessionsSectionNode.children[0]?.entityId, "ungrouped");
		assert.equal(tree.staffRows.length, 1);
		assert.equal([...model.flatByKey.values()].some(n => n.kind === "project-staff"), true);
		assert.equal([...model.flatByKey.values()].some(n => (n.kind as string) === "staff"), false);
		assert.equal(tree.archivedSectionNode?.children.find(n => n.entityId === "archived-session")?.kind, "session");
	});

	it("preserves goal hierarchy, depths, indentation, descendant counts, and title suffixes", () => {
		const model = buildSidebarTree({
			projects: [project()],
			goals: [
				goal({ id: "root", title: "Root", createdAt: 1 }),
				goal({ id: "child-a", title: "Same", parentGoalId: "root", createdAt: 2 }),
				goal({ id: "child-b", title: "Same", parentGoalId: "root", createdAt: 3 }),
				goal({ id: "grand", title: "Grand", parentGoalId: "child-a", createdAt: 4 }),
			],
			sessions: [],
			archivedSessions: [],
			showArchived: false,
		});
		const root = model.projects[0].goalForest[0];
		const childA = root.children.find(n => n.kind === "goal" && n.entityId === "child-a")!;
		const childB = root.children.find(n => n.kind === "goal" && n.entityId === "child-b")!;
		const grand = childA.children.find(n => n.kind === "goal")!;
		assert.equal(root.logicalDepth, 1);
		assert.equal(childA.parentKey, root.key);
		assert.equal(childA.logicalDepth, 2);
		assert.equal(grand.logicalDepth, 3);
		assert.equal(root.indentPx, 0);
		assert.equal(childA.indentPx, 16);
		assert.equal(grand.indentPx, 32);
		assert.equal(root.context.descendantCount, 3);
		assert.equal(childA.context.displayTitleSuffix, "child-" );
		assert.equal(childB.context.displayTitleSuffix, "child-" );
		assert.equal(root.defaultExpanded, false, "goal rows default collapsed; polling must not auto-open sub-goals in the builder");
	});

	it("places spawned goals under the owning team lead and excludes them from project and archived forests", () => {
		const model = buildSidebarTree({
			projects: [project()],
			goals: [
				goal({ id: "parent", team: true, createdAt: 1 }),
				goal({ id: "spawned", parentGoalId: "parent", spawnedBySessionId: "lead", createdAt: 2 }),
			],
			sessions: [session({ id: "lead", goalId: "parent", role: "team-lead" })],
			archivedSessions: [],
			showArchived: false,
		});
		assert.equal(model.claimedSpawnedGoalIds.has("spawned"), true);
		assert.deepEqual(model.projects[0].goalForest.map(n => n.entityId), ["parent"]);
		assert.equal(model.projects[0].archivedGoalForest.length, 0);
		const spawned = model.spawnedGoalNodesByLeadSessionId.get("lead")?.[0];
		assert.equal(spawned?.entityId, "spawned");
		assert.equal(spawned?.parentKey, sidebarTreeKey({ kind: "team-lead", sessionId: "lead" }));
		assert.equal(model.flatByKey.has(sidebarTreeKey({ kind: "goal", goalId: "spawned" })), true);
	});

	it("keeps archived live-parent children in the project forest and archived orphan chains in archived section", () => {
		const model = buildSidebarTree({
			projects: [project()],
			goals: [
				goal({ id: "live", createdAt: 1 }),
				goal({ id: "archived-child", parentGoalId: "live", archived: true, createdAt: 2 }),
				goal({ id: "archived-root", archived: true, createdAt: 3 }),
				goal({ id: "archived-grand", parentGoalId: "archived-root", archived: true, createdAt: 4 }),
			],
			sessions: [],
			archivedSessions: [],
			showArchived: true,
		});
		const live = model.projects[0].goalForest[0];
		assert.equal(live.children.find(n => n.kind === "goal")?.entityId, "archived-child");
		assert.deepEqual(model.projects[0].archivedGoalForest.map(n => n.entityId), ["archived-root"]);
		assert.equal(model.projects[0].archivedGoalForest[0].children.find(n => n.kind === "goal")?.entityId, "archived-grand");
	});

	it("does not duplicate archived spawned goals under archived team leads", () => {
		const model = buildSidebarTree({
			projects: [project()],
			goals: [
				goal({ id: "archived-parent", team: true, archived: true, createdAt: 1 }),
				goal({ id: "archived-spawned", parentGoalId: "archived-parent", spawnedBySessionId: "archived-lead", archived: true, createdAt: 2 }),
			],
			sessions: [],
			archivedSessions: [session({ id: "archived-lead", teamGoalId: "archived-parent", role: "team-lead", archived: true, status: "archived" })],
			showArchived: true,
		});
		assert.equal(model.claimedSpawnedGoalIds.has("archived-spawned"), true);
		assert.deepEqual(model.projects[0].archivedGoalForest.map(n => n.entityId), ["archived-parent"]);
		assert.equal(allGoalIds(model.projects[0].archivedGoalForest).filter(id => id === "archived-spawned").length, 1);
		assert.equal(model.spawnedGoalNodesByLeadSessionId.get("archived-lead")?.[0]?.entityId, "archived-spawned");
	});

	it("emits coexisting first-class and archived-delegate session child groups without duplicate child sessions", () => {
		const model = buildSidebarTree({
			projects: [project()],
			goals: [],
			sessions: [
				session({ id: "parent" }),
				session({ id: "first", parentSessionId: "parent" }),
			],
			archivedSessions: [session({ id: "delegate", delegateOf: "parent", archived: true, status: "archived" })],
			showArchived: true,
		});
		const groups = model.sessionChildrenNodesBySessionId.get("parent") ?? [];
		assert.deepEqual(groups.map(g => g.nodeKey.kind === "session-children" ? g.nodeKey.childClass : ""), ["first-class", "archived-delegate"]);
		assert.deepEqual(groups.map(g => g.context.childSessionKeys.map(k => model.flatByKey.get(k)?.entityId)), [["first"], ["delegate"]]);
	});

	it("applies injected session filters and uses search as bypass", () => {
		const bypassValues: boolean[] = [];
		const model = buildSidebarTree({
			projects: [project()],
			goals: [],
			sessions: [session({ id: "visible", title: "Visible" }), session({ id: "hidden", title: "Hidden" })],
			archivedSessions: [],
			showArchived: false,
			filters: {
				searchQuery: "vis",
				passesSessionFilters: (s, _active, bypass) => {
					bypassValues.push(bypass);
					return s.id !== "hidden";
				},
			},
		});
		assert.equal(bypassValues.every(Boolean), true);
		assert.deepEqual(model.projects[0].ungroupedSessionNodes.map(n => n.entityId), ["visible"]);
		assert.equal(model.projects[0].ungroupedSessionNodes[0].context.matchesSearch, true);
	});

	it("handles malformed goal data defensively and keeps flatByKey complete", () => {
		const model = buildSidebarTree({
			projects: [project("p1"), project("p2")],
			goals: [
				goal({ id: "missing-parent", parentGoalId: "nope", createdAt: 1 }),
				goal({ id: "cross-parent", projectId: "p1", createdAt: 2 }),
				goal({ id: "cross-child", projectId: "p2", parentGoalId: "cross-parent", createdAt: 3 }),
				goal({ id: "cycle-a", parentGoalId: "cycle-b", createdAt: 4 }),
				goal({ id: "cycle-b", parentGoalId: "cycle-a", createdAt: 5 }),
				goal({ id: "dupe", title: "first", createdAt: 6 }),
				goal({ id: "dupe", title: "second", createdAt: 7 }),
			],
			sessions: [],
			archivedSessions: [],
			showArchived: false,
		});
		assert.equal(model.diagnostics.some(d => d.kind === "duplicate-goal-id" && d.goalId === "dupe"), true);
		assert.equal(model.diagnostics.some(d => d.kind === "cross-project-parent" && d.goalId === "cross-child"), true);
		assert.equal(model.diagnostics.some(d => d.kind === "cycle-cut"), true);
		assert.equal(model.projects[0].goalForest.some(n => n.entityId === "missing-parent"), true);
		assert.equal(model.projects[1].goalForest.some(n => n.entityId === "cross-child"), true);
		assert.equal([...model.flatByKey.values()].filter(n => n.kind === "goal" && n.entityId === "dupe").length, 1);
		assert.equal(model.flatByKey.size, countNodes(model.projects.map(p => p.projectNode)));
	});
});
