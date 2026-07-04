import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
	buildSidebarTree,
	descendantSubtreeInputForTesting,
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
		assert.deepEqual(resolveSidebarTreeLayoutPreference(), { version: 1, indentMode: "comfortable", baseIndentPx: 5, nestedGoalIndentPx: 6 });
		assert.deepEqual(resolveSidebarTreeLayoutPreference({ indentMode: "spacious", baseIndentPx: 16, nestedGoalIndentPx: 28 }), { version: 1, indentMode: "spacious", baseIndentPx: 16, nestedGoalIndentPx: 28 });
		assert.deepEqual(resolveSidebarTreeLayoutPreference({ indentMode: "spacious", baseIndentPx: 99, nestedGoalIndentPx: Number.NaN }), { version: 1, indentMode: "spacious", baseIndentPx: 28, nestedGoalIndentPx: 6 });
		assert.deepEqual(resolveSidebarTreeLayoutPreference({ baseIndentPx: -10, nestedGoalIndentPx: -1 }), { version: 1, indentMode: "comfortable", baseIndentPx: 1, nestedGoalIndentPx: 1 });
		assert.deepEqual(resolveSidebarTreeLayoutPreference({ baseIndentPx: 99, nestedGoalIndentPx: 99 }), { version: 1, indentMode: "comfortable", baseIndentPx: 28, nestedGoalIndentPx: 28 });
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

	it("dedupes live and archived ungrouped sessions with live placement winning", () => {
		const model = buildSidebarTree({
			projects: [project()],
			goals: [],
			sessions: [session({ id: "dupe", status: "terminated", createdAt: 1 })],
			archivedSessions: [session({ id: "dupe", archived: true, status: "archived", createdAt: 0 })],
			showArchived: true,
		});
		const tree = model.projects[0];
		assert.deepEqual(tree.ungroupedSessionNodes.map(n => n.entityId), ["dupe"]);
		assert.deepEqual(tree.archivedSessionNodes.map(n => n.entityId), []);
		assert.equal([...model.flatByKey.values()].filter(n => n.kind === "session" && n.entityId === "dupe").length, 1);
		assert.equal(model.diagnostics.some(d => d.kind === "duplicate-node-key"), false);
		assert.equal(model.flatByKey.size, countNodes(model.projects.map(p => p.projectNode)));
	});

	it("dedupes live non-team goal sessions over archived duplicates", () => {
		const model = buildSidebarTree({
			projects: [project()],
			goals: [goal({ id: "g" })],
			sessions: [session({ id: "same", goalId: "g", createdAt: 1 })],
			archivedSessions: [session({ id: "same", goalId: "g", archived: true, status: "archived", createdAt: 0 })],
			showArchived: true,
		});
		const goalNode = model.projects[0].goalForest[0];
		assert.deepEqual(goalNode.children.filter(n => n.kind === "session").map(n => n.entityId), ["same"]);
		assert.deepEqual(model.projects[0].archivedSessionNodes.map(n => n.entityId), []);
		assert.equal([...model.flatByKey.values()].filter(n => n.kind === "session" && n.entityId === "same").length, 1);
		assert.equal(model.diagnostics.some(d => d.kind === "duplicate-node-key"), false);
		assert.equal(model.flatByKey.size, countNodes(model.projects.map(p => p.projectNode)));
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
		assert.equal(childA.indentPx, 6);
		assert.equal(grand.indentPx, 12);
		assert.equal(root.context.descendantCount, 3);
		assert.equal(childA.context.displayTitleSuffix, "child-" );
		assert.equal(childB.context.displayTitleSuffix, "child-" );
		assert.equal(root.defaultExpanded, false, "goal rows default collapsed; polling must not auto-open sub-goals in the builder");
	});

	it("applies custom indentation to nested goals and runtime child spacing", () => {
		const goalModel = buildSidebarTree({
			projects: [project()],
			goals: [goal({ id: "root", createdAt: 1 }), goal({ id: "child", parentGoalId: "root", createdAt: 2 })],
			sessions: [],
			archivedSessions: [],
			showArchived: false,
			layout: { nestedGoalIndentPx: 24, baseIndentPx: 14 },
		});
		const root = goalModel.projects[0].goalForest.find(n => n.entityId === "root")!;
		const child = root.children.find(n => n.kind === "goal" && n.entityId === "child")!;
		assert.equal(root.indentPx, 0);
		assert.equal(child.indentPx, 24);

		const runtimeModel = buildSidebarTree({
			projects: [project()],
			goals: [
				goal({ id: "team", team: true, createdAt: 1 }),
				goal({ id: "spawned", parentGoalId: "team", spawnedBySessionId: "lead", createdAt: 2 }),
			],
			sessions: [
				session({ id: "lead", goalId: "team", role: "team-lead", teamGoalId: "team", createdAt: 3 }),
				session({ id: "member", teamGoalId: "team", role: "coder", teamLeadSessionId: "lead", createdAt: 4 }),
			],
			archivedSessions: [],
			showArchived: false,
			layout: { nestedGoalIndentPx: 24, baseIndentPx: 14 },
		});
		const teamRoot = runtimeModel.projects[0].goalForest.find(n => n.entityId === "team")!;
		const lead = teamRoot.children.find(n => n.kind === "team-lead")!;
		const member = lead.children.find(n => n.kind === "session")!;
		const spawned = runtimeModel.spawnedGoalNodesByLeadSessionId.get("lead")?.find(n => n.entityId === "spawned")!;
		assert.equal(lead.indentPx, 14);
		assert.equal(member.indentPx, 28);
		assert.equal(spawned.indentPx, 28);
	});

	it("places spawned goals and descendants under the owning team lead and excludes them from project and archived forests", () => {
		const model = buildSidebarTree({
			projects: [project()],
			goals: [
				goal({ id: "parent", team: true, createdAt: 1 }),
				goal({ id: "spawned", parentGoalId: "parent", spawnedBySessionId: "lead", createdAt: 2 }),
				goal({ id: "spawned-child", parentGoalId: "spawned", createdAt: 3 }),
			],
			sessions: [session({ id: "lead", goalId: "parent", role: "team-lead" })],
			archivedSessions: [],
			showArchived: false,
		});
		assert.equal(model.claimedSpawnedGoalIds.has("spawned"), true);
		assert.equal(model.claimedSpawnedGoalIds.has("spawned-child"), true);
		assert.deepEqual(model.projects[0].goalForest.map(n => n.entityId), ["parent"]);
		assert.equal(allGoalIds(model.projects[0].goalForest).filter(id => id === "spawned-child").length, 1);
		assert.equal(model.projects[0].archivedGoalForest.length, 0);
		const spawned = model.spawnedGoalNodesByLeadSessionId.get("lead")?.[0];
		assert.equal(spawned?.entityId, "spawned");
		assert.equal(spawned?.parentKey, sidebarTreeKey({ kind: "team-lead", sessionId: "lead" }));
		assert.equal(spawned?.children.find(n => n.kind === "goal")?.entityId, "spawned-child");
		assert.equal(model.flatByKey.has(sidebarTreeKey({ kind: "goal", goalId: "spawned" })), true);
		assert.equal(model.flatByKey.has(sidebarTreeKey({ kind: "goal", goalId: "spawned-child" })), true);
	});

	it("keeps spawned goals in the normal goal forest when their owning team lead is filtered out", () => {
		const model = buildSidebarTree({
			projects: [project()],
			goals: [
				goal({ id: "parent", team: true, createdAt: 1 }),
				goal({ id: "spawned", parentGoalId: "parent", spawnedBySessionId: "lead", createdAt: 2 }),
				goal({ id: "spawned-child", parentGoalId: "spawned", createdAt: 3 }),
			],
			sessions: [session({ id: "lead", goalId: "parent", role: "team-lead" })],
			archivedSessions: [],
			showArchived: false,
			filters: { passesSessionFilters: s => s.id !== "lead" },
		});
		assert.equal(model.claimedSpawnedGoalIds.has("spawned"), false);
		assert.equal(model.claimedSpawnedGoalIds.has("spawned-child"), false);
		assert.equal(model.spawnedGoalNodesByLeadSessionId.has("lead"), false);
		const parent = model.projects[0].goalForest.find(n => n.entityId === "parent")!;
		assert.equal(parent.children.some(n => n.kind === "team-lead"), false);
		const spawned = parent.children.find(n => n.kind === "goal" && n.entityId === "spawned");
		assert.equal(spawned?.parentKey, parent.key);
		assert.equal(spawned?.children.find(n => n.kind === "goal")?.entityId, "spawned-child");
		assert.equal(allGoalIds(model.projects[0].goalForest).filter(id => id === "spawned").length, 1);
		assert.equal(allGoalIds(model.projects[0].goalForest).filter(id => id === "spawned-child").length, 1);
		assert.equal(model.flatByKey.size, countNodes(model.projects.map(p => p.projectNode)));
	});

	it("keeps a filtered natural team lead sticky when visible members remain", () => {
		const model = buildSidebarTree({
			projects: [project()],
			goals: [
				goal({ id: "parent", team: true, createdAt: 1 }),
				goal({ id: "spawned", parentGoalId: "parent", spawnedBySessionId: "lead", createdAt: 2 }),
				goal({ id: "spawned-child", parentGoalId: "spawned", createdAt: 3 }),
			],
			sessions: [
				session({ id: "lead", goalId: "parent", teamGoalId: "parent", role: "team-lead", createdAt: 1 }),
				session({ id: "member", teamGoalId: "parent", role: "coder", teamLeadSessionId: "lead", createdAt: 2 }),
			],
			archivedSessions: [],
			showArchived: false,
			filters: { passesSessionFilters: s => s.id !== "lead" },
		});
		assert.equal(model.claimedSpawnedGoalIds.has("spawned"), true);
		assert.equal(model.claimedSpawnedGoalIds.has("spawned-child"), true);
		const parent = model.projects[0].goalForest.find(n => n.entityId === "parent")!;
		const lead = parent.children.find(n => n.kind === "team-lead" && n.entityId === "lead")!;
		assert.ok(lead, "filtered natural lead should remain as the structural team row");
		assert.deepEqual(lead.children.filter(n => n.kind === "session").map(n => n.entityId), ["member"]);
		const spawned = model.spawnedGoalNodesByLeadSessionId.get("lead")?.[0];
		assert.equal(spawned?.entityId, "spawned");
		assert.equal(spawned?.parentKey, lead.key);
		assert.equal(spawned?.children.find(n => n.kind === "goal")?.entityId, "spawned-child");
		assert.equal(parent.children.some(n => n.kind === "goal" && n.entityId === "spawned"), false);
		assert.equal(allGoalIds(model.projects[0].goalForest).filter(id => id === "spawned").length, 1);
		assert.equal(allGoalIds(model.projects[0].goalForest).filter(id => id === "spawned-child").length, 1);
		assert.equal(model.flatByKey.size, countNodes(model.projects.map(p => p.projectNode)));
	});

	it("does not let child team-lead sessions claim spawned goals", () => {
		const model = buildSidebarTree({
			projects: [project()],
			goals: [
				goal({ id: "parent", team: true, createdAt: 1 }),
				goal({ id: "spawned", parentGoalId: "parent", spawnedBySessionId: "child-lead", createdAt: 2 }),
			],
			sessions: [
				session({ id: "child-lead", goalId: "parent", teamGoalId: "parent", role: "team-lead", parentSessionId: "host", createdAt: 1 }),
			],
			archivedSessions: [],
			showArchived: false,
		});
		assert.equal(model.claimedSpawnedGoalIds.has("spawned"), false);
		assert.equal(model.spawnedGoalNodesByLeadSessionId.has("child-lead"), false);
		const parent = model.projects[0].goalForest.find(n => n.entityId === "parent")!;
		assert.equal(parent.children.some(n => n.kind === "team-lead"), false);
		const spawned = parent.children.find(n => n.kind === "goal" && n.entityId === "spawned");
		assert.equal(spawned?.parentKey, parent.key);
		assert.equal(allGoalIds(model.projects[0].goalForest).filter(id => id === "spawned").length, 1);
		assert.equal(model.flatByKey.size, countNodes(model.projects.map(p => p.projectNode)));
	});

	it("keeps missing-goal verifier transcripts standalone while nesting renderable-goal verifiers", () => {
		const model = buildSidebarTree({
			projects: [project()],
			goals: [goal({ id: "team", team: true, createdAt: 1 })],
			sessions: [session({ id: "lead", goalId: "team", teamGoalId: "team", role: "team-lead", createdAt: 2 })],
			archivedSessions: [
				session({ id: "normal-standalone", archived: true, status: "archived", createdAt: 3 }),
				session({ id: "llm-review-renderable", goalId: "team", archived: true, status: "archived", title: "New session", createdAt: 4, agentSessionFile: "reviews/renderable.jsonl" }),
				session({ id: "llm-review-missing-transcript", goalId: "missing", archived: true, status: "archived", title: "New session", createdAt: 5, agentSessionFile: "reviews/missing.jsonl" }),
				session({ id: "agent-qa-missing-placeholder", goalId: "missing", archived: true, status: "archived", title: "New session", createdAt: 6 }),
			],
			showArchived: true,
		});
		const archivedIds = model.projects[0].archivedSessionNodes.map(n => n.entityId);
		assert.deepEqual(archivedIds, ["normal-standalone", "llm-review-missing-transcript"]);
		const lead = model.projects[0].goalForest[0].children.find(n => n.kind === "team-lead")!;
		assert.equal(lead.children.some(n => n.kind === "session" && n.entityId === "llm-review-renderable"), true);
		assert.equal([...model.flatByKey.values()].some(n => n.kind === "session" && n.entityId === "agent-qa-missing-placeholder"), false);
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
		const archivedRoot = model.projects[0].archivedGoalForest[0];
		const archivedGrand = archivedRoot.children.find(n => n.kind === "goal")!;
		assert.equal(archivedRoot.parentKey, model.projects[0].archivedSectionNode?.key);
		assert.equal(archivedRoot.logicalDepth, (model.projects[0].archivedSectionNode?.logicalDepth ?? 0) + 1);
		assert.equal(archivedRoot.indentPx, 0);
		assert.equal(archivedGrand.entityId, "archived-grand");
		assert.equal(archivedGrand.indentPx, 6);
	});

	it("terminates malformed spawned descendant cycles before recursive subtree conversion", () => {
		const diagnostics: any[] = [];
		const cuts = new Map<string, string[]>();
		const root = goal({ id: "spawned", parentGoalId: "parent", spawnedBySessionId: "lead", createdAt: 1 });
		const subtree = descendantSubtreeInputForTesting(root, [
			root,
			goal({ id: "child", parentGoalId: "spawned", createdAt: 2 }),
			goal({ id: "grand", parentGoalId: "child", createdAt: 3 }),
			goal({ id: "child", parentGoalId: "grand", createdAt: 4 }),
		], new Set(), diagnostics, cuts);
		assert.deepEqual(subtree.map(g => g.id), ["spawned", "child", "grand"]);
		assert.equal(diagnostics.some(d => d.kind === "cycle-cut" && d.goalId === "child" && d.parentGoalId === "grand"), true);
		assert.deepEqual(cuts.get("grand"), ["child"]);
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

	it("keeps live delegate-only child sessions in a collapsed delegate group when archived rows are shown", () => {
		const model = buildSidebarTree({
			projects: [project()],
			goals: [],
			sessions: [
				session({ id: "parent", createdAt: 1 }),
				session({ id: "live-delegate", delegateOf: "parent", createdAt: 2 }),
			],
			archivedSessions: [],
			showArchived: true,
		});
		const groups = model.sessionChildrenNodesBySessionId.get("parent") ?? [];
		assert.deepEqual(groups.map(g => g.nodeKey.kind === "session-children" ? g.nodeKey.childClass : ""), ["delegate"]);
		assert.deepEqual(groups[0]?.context.childSessionKeys.map(k => model.flatByKey.get(k)?.entityId), ["live-delegate"]);
		assert.equal(groups[0]?.children[0]?.context.childClass, "delegate");
		assert.equal(groups[0]?.defaultExpanded, false);
		assert.equal(groups[0]?.expanded, false);
	});

	it("cuts recursive session parent/delegate cycles", () => {
		const model = buildSidebarTree({
			projects: [project()],
			goals: [],
			sessions: [
				session({ id: "a", delegateOf: "c", createdAt: 1 }),
				session({ id: "b", delegateOf: "a", createdAt: 2 }),
				session({ id: "c", delegateOf: "b", createdAt: 3 }),
			],
			archivedSessions: [],
			showArchived: true,
		});
		assert.equal(model.flatByKey.size, countNodes(model.projects.map(p => p.projectNode)));
		assert.equal(model.diagnostics.some(d => d.kind === "session-cycle-cut" && d.sessionId === "a" && d.parentSessionId === "b"), true);
	});

	it("applies filters to first-class children and routes archived first-class children to archived-delegate", () => {
		const model = buildSidebarTree({
			projects: [project()],
			goals: [],
			sessions: [
				session({ id: "parent", createdAt: 1 }),
				session({ id: "first", parentSessionId: "parent", createdAt: 2 }),
				session({ id: "hidden", parentSessionId: "parent", createdAt: 3 }),
				session({ id: "terminated", parentSessionId: "parent", status: "terminated", createdAt: 4 }),
			],
			archivedSessions: [session({ id: "archived-first", parentSessionId: "parent", archived: true, status: "archived", createdAt: 5 })],
			showArchived: true,
			filters: { passesSessionFilters: s => s.id !== "hidden" },
		});
		const groups = model.sessionChildrenNodesBySessionId.get("parent") ?? [];
		assert.deepEqual(groups.map(g => g.nodeKey.kind === "session-children" ? g.nodeKey.childClass : ""), ["first-class", "archived-delegate"]);
		assert.deepEqual(groups[0]?.context.childSessionKeys.map(k => model.flatByKey.get(k)?.entityId), ["first"]);
		assert.deepEqual(groups[1]?.context.childSessionKeys.map(k => model.flatByKey.get(k)?.entityId), ["terminated", "archived-first"]);
		assert.equal([...model.flatByKey.values()].some(n => n.kind === "session" && n.entityId === "hidden"), false);
	});

	it("keeps team goal member sessions visible when no live team lead exists", () => {
		const model = buildSidebarTree({
			projects: [project()],
			goals: [goal({ id: "team", team: true })],
			sessions: [session({ id: "member", teamGoalId: "team", role: "coder" })],
			archivedSessions: [],
			showArchived: false,
		});
		const goalNode = model.projects[0].goalForest[0];
		assert.equal(goalNode.children.some(n => n.kind === "team-lead"), false);
		assert.deepEqual(goalNode.children.filter(n => n.kind === "session").map(n => n.entityId), ["member"]);
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

	it("omits hidden Headquarters goals instead of bucketing them under a visible project", () => {
		const model = buildSidebarTree({
			projects: [project("p1")],
			goals: [
				goal({ id: "normal", projectId: "p1", createdAt: 1 }),
				goal({ id: "headquarters-goal", projectId: "headquarters", createdAt: 2 }),
			],
			sessions: [],
			archivedSessions: [],
			showArchived: false,
		});
		assert.deepEqual(allGoalIds([model.projects[0].projectNode]), ["normal"]);
		assert.equal(model.flatByKey.has(sidebarTreeKey({ kind: "goal", goalId: "headquarters-goal" })), false);
	});

	it("omits children whose parent has a hidden explicit projectId", () => {
		const model = buildSidebarTree({
			projects: [project("p1")],
			goals: [
				goal({ id: "normal", projectId: "p1", createdAt: 1 }),
				goal({ id: "hidden-parent", projectId: "headquarters", createdAt: 2 }),
				goal({ id: "hidden-child", projectId: "p1", parentGoalId: "hidden-parent", createdAt: 3 }),
			],
			sessions: [],
			archivedSessions: [],
			showArchived: false,
		});
		assert.deepEqual(allGoalIds([model.projects[0].projectNode]), ["normal"]);
		assert.equal(model.flatByKey.has(sidebarTreeKey({ kind: "goal", goalId: "hidden-parent" })), false);
		assert.equal(model.flatByKey.has(sidebarTreeKey({ kind: "goal", goalId: "hidden-child" })), false);
	});

	it("falls back legacy goals with no projectId ancestry to the first project bucket", () => {
		const model = buildSidebarTree({
			projects: [project("p1"), project("p2")],
			goals: [
				goal({ id: "legacy-live", projectId: undefined, createdAt: 1 }),
				goal({ id: "legacy-archived", projectId: undefined, archived: true, createdAt: 2 }),
			],
			sessions: [],
			archivedSessions: [],
			showArchived: true,
		});
		assert.deepEqual(model.projects[0].goalForest.map(n => n.entityId), ["legacy-live"]);
		assert.deepEqual(model.projects[0].archivedGoalForest.map(n => n.entityId), ["legacy-archived"]);
		assert.deepEqual(model.projects[1].goalForest.map(n => n.entityId), []);
		assert.deepEqual(model.projects[1].archivedGoalForest.map(n => n.entityId), []);
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
