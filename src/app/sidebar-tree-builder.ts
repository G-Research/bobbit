import { buildNestedGoalForest, type NestableGoal, type NestedGoalNode } from "./sidebar-nesting.js";
import { selectSpawnedChildren } from "./sidebar-spawned-children.js";
import { bucketTeamChildren } from "./team-archived-bucket.js";
import {
	SIDEBAR_TREE_BASE_INDENT_PX,
	SIDEBAR_TREE_INDENT_DEFAULT_PX,
	SIDEBAR_TREE_INDENT_MAX_PX,
	SIDEBAR_TREE_INDENT_MIN_PX,
} from "./sidebar-tree-layout.js";

export type SidebarSessionChildrenClass = "first-class" | "delegate" | "archived-delegate";

export type SidebarTreeNodeKey =
	| { kind: "project"; projectId: string }
	| { kind: "project-sessions"; projectId: string }
	| { kind: "project-staff"; projectId: string }
	| { kind: "project-archived"; projectId: string }
	| { kind: "goal"; goalId: string }
	| { kind: "team-lead"; sessionId: string }
	| { kind: "session-children"; sessionId: string; childClass: SidebarSessionChildrenClass }
	| { kind: "session"; sessionId: string };

export type SidebarTreeNodeKind = SidebarTreeNodeKey["kind"];
export type SidebarTreeExpansionClass = "project" | "section" | "goal" | "team-lead" | "session-children";
export type SidebarTreeViewport = "desktop" | "mobile" | "collapsed";
export type SidebarIndentMode = "compact" | "comfortable" | "spacious";

export interface SidebarTreeNode<TContext = unknown> {
	/** Canonical stable string key. Kept as `key` for the approved builder API. */
	key: string;
	/** Alias used by the newer tree-state design for DOM/nav/storage consumers. */
	canonicalKey: string;
	nodeKey: SidebarTreeNodeKey;
	kind: SidebarTreeNodeKind;
	entityId: string;
	parentKey: string | null;
	children: SidebarTreeNode[];
	/** Logical rendered tree depth. Alias `depth` matches the tree-state design. */
	logicalDepth: number;
	depth: number;
	/** Layout depth. Alias `indentLevel` matches the tree-state design. */
	indentDepth: number;
	indentLevel: number;
	indentPx: number;
	expandable: boolean;
	expansionClass?: SidebarTreeExpansionClass;
	defaultExpanded: boolean;
	expanded: boolean;
	hiddenByFilter?: boolean;
	context: TContext;
}

export interface ProjectLike {
	id: string;
	name?: string;
	rootPath?: string;
	provisional?: boolean;
}

export type GoalStateLike = "todo" | "in-progress" | "complete" | "shelved" | "blocked";

export interface GoalLike extends NestableGoal {
	projectId?: string;
	parentGoalId?: string;
	spawnedBySessionId?: string;
	archived?: boolean;
	createdAt: number;
	title: string;
	team?: boolean;
	state: GoalStateLike;
}

export interface SessionLike {
	id: string;
	projectId?: string;
	goalId?: string;
	teamGoalId?: string;
	role?: string;
	status?: string;
	createdAt: number;
	delegateOf?: string;
	parentSessionId?: string;
	teamLeadSessionId?: string;
	archived?: boolean;
	title?: string;
	agentSessionFile?: unknown;
}

export interface StaffLike {
	id?: string;
	projectId?: string;
	currentSessionId?: string;
	name?: string;
}

export interface SidebarTreeFilters {
	searchQuery?: string;
	bypassBusyReadFilters?: boolean;
	activeSessionId?: string;
	passesSessionFilters?: (session: SessionLike, active: boolean, bypass: boolean) => boolean;
	includeArchived?: boolean;
}

export interface SidebarTreeLayoutPreferenceV1 {
	version?: 1;
	indentMode?: SidebarIndentMode;
	baseIndentPx?: number;
	nestedGoalIndentPx?: number;
}

export interface ResolvedSidebarTreeLayoutPreference {
	version: 1;
	indentMode: SidebarIndentMode;
	baseIndentPx: number;
	nestedGoalIndentPx: number;
}

export interface SidebarTreeExpansionInput {
	isExpanded?: (key: SidebarTreeNodeKey, defaultExpanded: boolean) => boolean;
	defaultExpanded?: (key: SidebarTreeNodeKey, defaultExpanded: boolean) => boolean;
}

export interface BuildSidebarTreeInput {
	projects: readonly ProjectLike[];
	goals: readonly GoalLike[];
	sessions: readonly SessionLike[];
	archivedSessions: readonly SessionLike[];
	staff?: readonly StaffLike[];
	showArchived: boolean;
	filters?: SidebarTreeFilters;
	projectOrder?: readonly string[];
	nestedDepthByProject?: ReadonlyMap<string, number> | Record<string, number>;
	defaultNestedDepth?: number;
	viewport?: SidebarTreeViewport;
	expansion?: SidebarTreeExpansionInput;
	layout?: SidebarTreeLayoutPreferenceV1;
}

export interface ProjectContext {
	project: ProjectLike;
	projectId: string;
	viewport: SidebarTreeViewport;
}

export interface ProjectSectionContext {
	project: ProjectLike;
	projectId: string;
	section: "sessions" | "staff" | "archived";
	viewport: SidebarTreeViewport;
}

export interface GoalContext {
	goal: GoalLike;
	projectId: string;
	parentGoalId?: string;
	archived: boolean;
	descendantCount: number;
	displayTitleSuffix?: string;
	truncatedChildrenCount?: number;
	renderPlacement: "project-forest" | "team-lead-spawned" | "archived-section";
	ownerLeadSessionId?: string;
	activeChildKeys: string[];
	archivedChildKeys: string[];
	cycleCutChildGoalIds?: string[];
	matchesSearch?: boolean;
}

export interface TeamLeadContext {
	session: SessionLike;
	goalId: string;
	teamGoalId?: string;
	projectId?: string;
	memberSessionKeys: string[];
	spawnedGoalKeys: string[];
	archivedMemberSessionKeys: string[];
	delegateChildrenKeys: string[];
}

export interface SessionChildrenContext {
	sessionId: string;
	childClass: SidebarSessionChildrenClass;
	childSessionKeys: string[];
}

export interface SessionContext {
	session: SessionLike;
	projectId?: string;
	goalId?: string;
	teamGoalId?: string;
	isTeamLead: boolean;
	childClass?: SidebarSessionChildrenClass;
	activeCandidate: boolean;
	matchesSearch?: boolean;
}

export type SidebarTreeDiagnostic =
	| { kind: "cycle-cut"; goalId: string; parentGoalId: string; ancestorGoalIds: string[] }
	| { kind: "duplicate-goal-id"; goalId: string }
	| { kind: "cross-project-parent"; goalId: string; parentGoalId: string }
	| { kind: "duplicate-node-key"; key: string };

export interface SidebarProjectTree {
	project: ProjectLike;
	projectNode: SidebarTreeNode<ProjectContext>;
	goalForest: SidebarTreeNode<GoalContext>[];
	sessionsSectionNode: SidebarTreeNode<ProjectSectionContext>;
	ungroupedSessionNodes: SidebarTreeNode<SessionContext>[];
	staffSectionNode?: SidebarTreeNode<ProjectSectionContext>;
	staffRows: StaffLike[];
	archivedSectionNode?: SidebarTreeNode<ProjectSectionContext>;
	archivedGoalForest: SidebarTreeNode<GoalContext>[];
	archivedSessionNodes: SidebarTreeNode<SessionContext>[];
}

export interface SidebarTreeModel {
	projects: SidebarProjectTree[];
	flatByKey: Map<string, SidebarTreeNode>;
	claimedSpawnedGoalIds: Set<string>;
	spawnedGoalNodesByLeadSessionId: Map<string, SidebarTreeNode<GoalContext>[]>;
	sessionChildrenNodesBySessionId: Map<string, SidebarTreeNode<SessionChildrenContext>[]>;
	diagnostics: SidebarTreeDiagnostic[];
}

const KEY_PREFIX = "sidebar-tree/v1/";
const DEFAULT_NESTED_DEPTH = 5;
const DEFAULT_BASE_INDENT_PX = SIDEBAR_TREE_BASE_INDENT_PX;
const DEFAULT_NESTED_GOAL_INDENT_PX = SIDEBAR_TREE_INDENT_DEFAULT_PX;
const MIN_NESTED_GOAL_INDENT_PX = SIDEBAR_TREE_INDENT_MIN_PX;
const MAX_NESTED_GOAL_INDENT_PX = SIDEBAR_TREE_INDENT_MAX_PX;

export function sidebarTreeKey(input: SidebarTreeNodeKey): string {
	const [kind, id] = keyParts(input);
	const base = `${KEY_PREFIX}${kind}/${encodeURIComponent(id)}`;
	return input.kind === "session-children" ? `${base}?childClass=${input.childClass}` : base;
}

export function parseSidebarTreeKey(raw: string): SidebarTreeNodeKey | null {
	if (!raw.startsWith(KEY_PREFIX)) return null;
	const rest = raw.slice(KEY_PREFIX.length);
	const queryIndex = rest.indexOf("?");
	const path = queryIndex === -1 ? rest : rest.slice(0, queryIndex);
	const query = queryIndex === -1 ? "" : rest.slice(queryIndex + 1);
	const slash = path.indexOf("/");
	if (slash <= 0 || slash === path.length - 1) return null;
	const kind = path.slice(0, slash);
	const encodedId = path.slice(slash + 1);
	if (encodedId.includes("/")) return null;
	let id: string;
	try {
		id = decodeURIComponent(encodedId);
	} catch {
		return null;
	}
	if (!id) return null;
	if (kind === "session-children") {
		const params = new URLSearchParams(query);
		const childClass = params.get("childClass");
		if ((childClass !== "first-class" && childClass !== "delegate" && childClass !== "archived-delegate") || Array.from(params.keys()).length !== 1) return null;
		return { kind, sessionId: id, childClass };
	}
	if (query) return null;
	switch (kind) {
		case "project": return { kind, projectId: id };
		case "project-sessions": return { kind, projectId: id };
		case "project-staff": return { kind, projectId: id };
		case "project-archived": return { kind, projectId: id };
		case "goal": return { kind, goalId: id };
		case "team-lead": return { kind, sessionId: id };
		case "session": return { kind, sessionId: id };
		default: return null;
	}
}

export function isSidebarTreeExpandable(key: SidebarTreeNodeKey): boolean {
	return key.kind !== "session";
}

export function resolveSidebarTreeLayoutPreference(input?: SidebarTreeLayoutPreferenceV1): ResolvedSidebarTreeLayoutPreference {
	const mode = input?.indentMode === "compact" || input?.indentMode === "comfortable" || input?.indentMode === "spacious"
		? input.indentMode
		: "comfortable";
	const baseIndentPx = clampNumber(input?.baseIndentPx ?? input?.nestedGoalIndentPx, MIN_NESTED_GOAL_INDENT_PX, MAX_NESTED_GOAL_INDENT_PX, DEFAULT_BASE_INDENT_PX);
	const nestedGoalIndentPx = clampNumber(input?.nestedGoalIndentPx ?? input?.baseIndentPx, MIN_NESTED_GOAL_INDENT_PX, MAX_NESTED_GOAL_INDENT_PX, DEFAULT_NESTED_GOAL_INDENT_PX);
	return {
		version: 1,
		indentMode: mode,
		baseIndentPx,
		nestedGoalIndentPx,
	};
}

export function buildSidebarTree(input: BuildSidebarTreeInput): SidebarTreeModel {
	const ctx = createBuildContext(input);
	const projects = orderProjects(input.projects, input.projectOrder);
	const projectIds = new Set(projects.map(p => p.id));
	const goals = dedupeGoals(input.goals, ctx.diagnostics);
	const goalById = new Map(goals.map(g => [g.id, g]));
	const projectIdByGoalId = new Map<string, string>();
	const fallbackProjectId = projects[0]?.id;
	for (const goal of goals) {
		const projectId = resolveGoalProjectId(goal, goalById, projectIds, fallbackProjectId);
		if (projectId) projectIdByGoalId.set(goal.id, projectId);
	}
	for (const goal of goals) {
		const parentProjectId = goal.parentGoalId ? projectIdByGoalId.get(goal.parentGoalId) : undefined;
		const goalProjectId = projectIdByGoalId.get(goal.id);
		if (parentProjectId && goalProjectId && parentProjectId !== goalProjectId) {
			ctx.diagnostics.push({ kind: "cross-project-parent", goalId: goal.id, parentGoalId: goal.parentGoalId! });
		}
	}

	const modelProjects: SidebarProjectTree[] = [];
	for (const project of projects) {
		modelProjects.push(buildProjectTree(project, goals, projectIdByGoalId, ctx));
	}
	return {
		projects: modelProjects,
		flatByKey: ctx.flatByKey,
		claimedSpawnedGoalIds: ctx.claimedSpawnedGoalIds,
		spawnedGoalNodesByLeadSessionId: ctx.spawnedGoalNodesByLeadSessionId,
		sessionChildrenNodesBySessionId: ctx.sessionChildrenNodesBySessionId,
		diagnostics: ctx.diagnostics,
	};
}

interface BuildContext {
	input: BuildSidebarTreeInput;
	viewport: SidebarTreeViewport;
	includeArchived: boolean;
	layout: ResolvedSidebarTreeLayoutPreference;
	liveSessions: SessionLike[];
	archivedSessions: SessionLike[];
	flatByKey: Map<string, SidebarTreeNode>;
	claimedSpawnedGoalIds: Set<string>;
	spawnedRootGoalIds: Set<string>;
	spawnedGoalNodesByLeadSessionId: Map<string, SidebarTreeNode<GoalContext>[]>;
	sessionChildrenNodesBySessionId: Map<string, SidebarTreeNode<SessionChildrenContext>[]>;
	diagnostics: SidebarTreeDiagnostic[];
	emittedGoalIds: Set<string>;
	passesSession: (session: SessionLike) => boolean;
}

function createBuildContext(input: BuildSidebarTreeInput): BuildContext {
	const includeArchived = input.filters?.includeArchived ?? input.showArchived;
	const bypass = Boolean(input.filters?.bypassBusyReadFilters || input.filters?.searchQuery?.trim());
	const liveSessions = dedupeSessionsById(sortSessions(input.sessions.filter(s => !s.archived)));
	const liveSessionIds = new Set(liveSessions.map(s => s.id));
	const archivedSessions = includeArchived
		? dedupeSessionsById(sortSessions(input.archivedSessions.filter(s => !liveSessionIds.has(s.id))))
		: [];
	return {
		input,
		viewport: input.viewport ?? "desktop",
		includeArchived,
		layout: resolveSidebarTreeLayoutPreference(input.layout),
		liveSessions,
		archivedSessions,
		flatByKey: new Map(),
		claimedSpawnedGoalIds: new Set(),
		spawnedRootGoalIds: new Set(),
		spawnedGoalNodesByLeadSessionId: new Map(),
		sessionChildrenNodesBySessionId: new Map(),
		diagnostics: [],
		emittedGoalIds: new Set(),
		passesSession: (session) => input.filters?.passesSessionFilters?.(session, input.filters?.activeSessionId === session.id, bypass) ?? true,
	};
}

function buildProjectTree(project: ProjectLike, goals: GoalLike[], projectIdByGoalId: ReadonlyMap<string, string>, ctx: BuildContext): SidebarProjectTree {
	const projectNode = makeNode<ProjectContext>(ctx, { kind: "project", projectId: project.id }, { project, projectId: project.id, viewport: ctx.viewport }, null, 0, 0, 0);
	const renderableGoalIds = new Set(goals.map(g => g.id));
	const projectGoals = sortGoals(goals.filter(g => projectIdByGoalId.get(g.id) === project.id));
	const liveGoals = projectGoals.filter(g => !g.archived);
	const archivedGoals = projectGoals.filter(g => g.archived);
	const liveGoalIds = new Set(liveGoals.map(g => g.id));
	const projectForestCandidates = new Map<string, GoalLike>();
	for (const goal of liveGoals) projectForestCandidates.set(goal.id, goal);
	if (ctx.includeArchived) {
		for (const goal of archivedGoals) {
			if (goal.parentGoalId && liveGoalIds.has(goal.parentGoalId)) projectForestCandidates.set(goal.id, goal);
		}
	}
	const archivedForestCandidates = new Map<string, GoalLike>();
	if (ctx.includeArchived) {
		for (const goal of archivedGoals) {
			const parentProject = goal.parentGoalId ? projectIdByGoalId.get(goal.parentGoalId) : undefined;
			if (!goal.parentGoalId || parentProject !== project.id || !liveGoalIds.has(goal.parentGoalId)) {
				archivedForestCandidates.set(goal.id, goal);
			}
		}
	}
	const spawnedCandidates = projectGoals.filter(g => ctx.includeArchived || !g.archived);
	claimSpawnedGoals(spawnedCandidates, ctx);

	const cycleCutsByParentGoalId = new Map<string, string[]>();
	const maxDepth = nestedDepthForProject(project.id, ctx.input.nestedDepthByProject, ctx.input.defaultNestedDepth ?? DEFAULT_NESTED_DEPTH);
	const projectForestInput = sanitizeGoalForestInput(
		sortGoals(Array.from(projectForestCandidates.values()).filter(g => !ctx.claimedSpawnedGoalIds.has(g.id))),
		project.id,
		projectIdByGoalId,
		ctx.diagnostics,
		cycleCutsByParentGoalId,
	);
	const archivedForestInput = sanitizeGoalForestInput(
		sortGoals(Array.from(archivedForestCandidates.values()).filter(g => !ctx.claimedSpawnedGoalIds.has(g.id))),
		project.id,
		projectIdByGoalId,
		ctx.diagnostics,
		cycleCutsByParentGoalId,
	);
	const goalForest = buildNestedGoalForest(projectForestInput, { maxDepth, includeArchived: ctx.includeArchived })
		.map(n => convertGoalNode(n, projectNode, "project-forest", project, spawnedCandidates, cycleCutsByParentGoalId, ctx))
		.filter(isDefined);
	const sessionsSectionNode = makeNode<ProjectSectionContext>(ctx, { kind: "project-sessions", projectId: project.id }, { project, projectId: project.id, section: "sessions", viewport: ctx.viewport }, projectNode.key, 1, 0, 0);
	const ungroupedSessionNodes = ctx.liveSessions
		.filter(s => s.projectId === project.id && !s.goalId && !s.teamGoalId && !isChildSession(s) && ctx.passesSession(s))
		.map(s => makeSessionNode(s, sessionsSectionNode, undefined, ctx));
	sessionsSectionNode.children.push(...ungroupedSessionNodes);
	const staffRows = (ctx.input.staff ?? []).filter(s => s.projectId === project.id);
	const staffSectionNode = staffRows.length > 0
		? makeNode<ProjectSectionContext>(ctx, { kind: "project-staff", projectId: project.id }, { project, projectId: project.id, section: "staff", viewport: ctx.viewport }, projectNode.key, 1, 0, 0)
		: undefined;
	let archivedSectionNode: SidebarTreeNode<ProjectSectionContext> | undefined;
	let archivedGoalForest: SidebarTreeNode<GoalContext>[] = [];
	let archivedSessionNodes: SidebarTreeNode<SessionContext>[] = [];
	if (ctx.includeArchived) {
		archivedSectionNode = makeNode<ProjectSectionContext>(ctx, { kind: "project-archived", projectId: project.id }, { project, projectId: project.id, section: "archived", viewport: ctx.viewport }, projectNode.key, 1, 0, 0, false);
		archivedGoalForest = buildNestedGoalForest(archivedForestInput, { maxDepth, includeArchived: true })
			.map(n => convertGoalNode(n, archivedSectionNode!, "archived-section", project, spawnedCandidates, cycleCutsByParentGoalId, ctx))
			.filter(isDefined);
		archivedSessionNodes = ctx.archivedSessions
			.filter(s => s.projectId === project.id && isStandaloneArchivedSession(s, renderableGoalIds) && ctx.passesSession(s))
			.map(s => makeSessionNode(s, archivedSectionNode!, "archived-delegate", ctx));
		archivedSectionNode.children.push(...archivedGoalForest, ...archivedSessionNodes);
		if (archivedSectionNode.children.length > 0) registerNode(archivedSectionNode, ctx);
	}
	projectNode.children.push(...goalForest, sessionsSectionNode);
	if (staffSectionNode) projectNode.children.push(staffSectionNode);
	if (archivedSectionNode && ctx.flatByKey.has(archivedSectionNode.key)) projectNode.children.push(archivedSectionNode);
	return { project, projectNode, goalForest, sessionsSectionNode, ungroupedSessionNodes, staffSectionNode, staffRows, archivedSectionNode: archivedSectionNode && ctx.flatByKey.has(archivedSectionNode.key) ? archivedSectionNode : undefined, archivedGoalForest, archivedSessionNodes };
}

function convertGoalNode(
	nested: NestedGoalNode,
	parent: SidebarTreeNode,
	renderPlacement: GoalContext["renderPlacement"],
	project: ProjectLike,
	spawnedCandidates: readonly GoalLike[],
	cycleCutsByParentGoalId: ReadonlyMap<string, string[]>,
	ctx: BuildContext,
	ownerLeadSessionId?: string,
): SidebarTreeNode<GoalContext> | undefined {
	const goal = nested.goal as GoalLike;
	if (ctx.emittedGoalIds.has(goal.id)) return undefined;
	ctx.emittedGoalIds.add(goal.id);
	const indentDepth = parent.kind === "project" || parent.kind === "project-archived" ? nested.depth : parent.indentDepth + 1;
	const goalIndentUnit = renderPlacement === "project-forest" || renderPlacement === "archived-section"
		? ctx.layout.nestedGoalIndentPx
		: ctx.layout.baseIndentPx;
	const context: GoalContext = {
		goal,
		projectId: project.id,
		parentGoalId: goal.parentGoalId,
		archived: !!goal.archived,
		descendantCount: nested.descendantCount,
		displayTitleSuffix: nested.displayTitleSuffix,
		truncatedChildrenCount: nested.truncatedChildrenCount,
		renderPlacement,
		ownerLeadSessionId,
		activeChildKeys: [],
		archivedChildKeys: [],
		matchesSearch: matchesSearch(goal.title, ctx.input.filters?.searchQuery),
	};
	const cycleCuts = cycleCutsByParentGoalId.get(goal.id);
	if (cycleCuts?.length) context.cycleCutChildGoalIds = [...cycleCuts];
	const node = makeNode<GoalContext>(ctx, { kind: "goal", goalId: goal.id }, context, parent.key, parent.logicalDepth + 1, indentDepth, indentDepth * goalIndentUnit);
	appendGoalRuntimeChildren(node, project, spawnedCandidates, ctx);
	for (const child of nested.children) {
		const childNode = convertGoalNode(child, node, renderPlacement, project, spawnedCandidates, cycleCutsByParentGoalId, ctx, ownerLeadSessionId);
		if (!childNode) continue;
		node.children.push(childNode);
		(childNode.context.archived ? node.context.archivedChildKeys : node.context.activeChildKeys).push(childNode.key);
	}
	return node;
}

function appendGoalRuntimeChildren(goalNode: SidebarTreeNode<GoalContext>, project: ProjectLike, spawnedCandidates: readonly GoalLike[], ctx: BuildContext): void {
	const goal = goalNode.context.goal;
	const goalLiveSessions = ctx.liveSessions.filter(s => isGoalOwningSession(s, goal.id) && !isChildSession(s)).sort(compareSessions);
	const filteredLive = goalLiveSessions.filter(ctx.passesSession);
	if (goal.team) {
		const naturalLiveLead = goalLiveSessions.find(s => s.role === "team-lead");
		const stickyLiveLead = naturalLiveLead && !filteredLive.includes(naturalLiveLead) && filteredLive.length > 0 ? naturalLiveLead : undefined;
		const liveLead = stickyLiveLead ?? filteredLive.find(s => s.role === "team-lead");
		if (liveLead) {
			appendTeamLeadNode(goalNode, liveLead, filteredLive.filter(s => s.id !== liveLead.id), false, project, spawnedCandidates, ctx);
		} else {
			for (const session of filteredLive) goalNode.children.push(makeSessionNode(session, goalNode, undefined, ctx));
		}
		if (!ctx.includeArchived) return;
		const archivedForGoal = ctx.archivedSessions.filter(s => isGoalOwningSession(s, goal.id) && !isChildSession(s));
		const archivedLeads = archivedForGoal.filter(s => s.role === "team-lead" && ctx.passesSession(s));
		const archivedMembers = archivedForGoal.filter(s => s.role !== "team-lead" && ctx.passesSession(s));
		const leadIds = new Set([...liveLead ? [liveLead.id] : [], ...archivedLeads.map(s => s.id)]);
		const mappedMemberIds = new Set(archivedMembers.filter(s => s.teamLeadSessionId && leadIds.has(s.teamLeadSessionId)).map(s => s.id));
		const unmapped = archivedMembers.filter(s => !mappedMemberIds.has(s.id));
		archivedLeads.forEach((lead, index) => {
			const members = [...archivedMembers.filter(s => s.teamLeadSessionId === lead.id), ...(!liveLead && index === archivedLeads.length - 1 ? unmapped : [])];
			appendTeamLeadNode(goalNode, lead, members, true, project, spawnedCandidates, ctx);
		});
		if (!liveLead && archivedLeads.length === 0) {
			for (const member of unmapped) goalNode.children.push(makeSessionNode(member, goalNode, "archived-delegate", ctx));
		}
		return;
	}
	for (const session of filteredLive) goalNode.children.push(makeSessionNode(session, goalNode, undefined, ctx));
	if (ctx.includeArchived) {
		for (const session of ctx.archivedSessions.filter(s => isGoalOwningSession(s, goal.id) && !isChildSession(s) && ctx.passesSession(s))) {
			goalNode.children.push(makeSessionNode(session, goalNode, "archived-delegate", ctx));
		}
	}
}

function appendTeamLeadNode(
	goalNode: SidebarTreeNode<GoalContext>,
	lead: SessionLike,
	members: SessionLike[],
	archivedLead: boolean,
	project: ProjectLike,
	spawnedCandidates: readonly GoalLike[],
	ctx: BuildContext,
): void {
	const node = makeNode<TeamLeadContext>(ctx, { kind: "team-lead", sessionId: lead.id }, {
		session: lead,
		goalId: goalNode.context.goal.id,
		teamGoalId: lead.teamGoalId,
		projectId: lead.projectId,
		memberSessionKeys: [],
		spawnedGoalKeys: [],
		archivedMemberSessionKeys: [],
		delegateChildrenKeys: [],
	}, goalNode.key, goalNode.logicalDepth + 1, goalNode.indentDepth + 1, (goalNode.indentDepth + 1) * ctx.layout.baseIndentPx);
	goalNode.children.push(node);
	node.context.delegateChildrenKeys.push(...appendSessionChildrenGroups(node, lead, ctx));
	const archivedForLiveLead = !archivedLead && ctx.includeArchived
		? ctx.archivedSessions.filter(s => isGoalOwningSession(s, goalNode.context.goal.id) && !isChildSession(s) && s.role !== "team-lead" && (s.teamLeadSessionId === lead.id || !s.teamLeadSessionId) && ctx.passesSession(s))
		: [];
	const { liveTeamChildren, archivedBelow } = archivedLead
		? { liveTeamChildren: [] as SessionLike[], archivedBelow: members }
		: bucketTeamChildren(members, archivedForLiveLead, ctx.includeArchived);
	for (const member of liveTeamChildren) {
		const memberNode = makeSessionNode(member, node, undefined, ctx);
		node.children.push(memberNode);
		node.context.memberSessionKeys.push(memberNode.key);
	}
	const spawned = selectSpawnedChildren(spawnedCandidates, goalNode.context.goal.id, lead.id, ctx.includeArchived || archivedLead, lead.id);
	for (const childGoal of spawned.filter(g => !g.archived)) appendSpawnedGoalNode(node, childGoal, project, spawnedCandidates, ctx);
	for (const member of archivedBelow) {
		const memberNode = makeSessionNode(member, node, "archived-delegate", ctx);
		node.children.push(memberNode);
		node.context.archivedMemberSessionKeys.push(memberNode.key);
	}
	for (const childGoal of spawned.filter(g => !!g.archived)) appendSpawnedGoalNode(node, childGoal, project, spawnedCandidates, ctx);
}

function appendSpawnedGoalNode(leadNode: SidebarTreeNode<TeamLeadContext>, goal: GoalLike, project: ProjectLike, spawnedCandidates: readonly GoalLike[], ctx: BuildContext): void {
	const cycleCutsByParentGoalId = new Map<string, string[]>();
	const subtreeInput = descendantSubtreeInput(goal, spawnedCandidates, ctx.spawnedRootGoalIds, ctx.diagnostics, cycleCutsByParentGoalId);
	const sanitized = sanitizeGoalForestInput(subtreeInput, project.id, new Map(spawnedCandidates.map(g => [g.id, project.id])), ctx.diagnostics, cycleCutsByParentGoalId);
	const subtree = buildNestedGoalForest(sanitized, { maxDepth: ctx.input.defaultNestedDepth ?? DEFAULT_NESTED_DEPTH, includeArchived: true })
		.find(n => n.goal.id === goal.id) ?? { goal, depth: 0, children: [], descendantCount: 0 };
	const childNode = convertGoalNode(subtree, leadNode, "team-lead-spawned", project, spawnedCandidates, cycleCutsByParentGoalId, ctx, leadNode.context.session.id);
	if (!childNode) return;
	leadNode.children.push(childNode);
	leadNode.context.spawnedGoalKeys.push(childNode.key);
	const existing = ctx.spawnedGoalNodesByLeadSessionId.get(leadNode.context.session.id) ?? [];
	existing.push(childNode);
	ctx.spawnedGoalNodesByLeadSessionId.set(leadNode.context.session.id, existing);
}

function appendSessionChildrenGroups(parent: SidebarTreeNode, parentSession: SessionLike, ctx: BuildContext): string[] {
	const groupKeys: string[] = [];
	const childCandidates = dedupeSessionsById([
		...ctx.liveSessions,
		...(ctx.includeArchived ? ctx.archivedSessions : []),
	]).filter(s => sessionParentId(s) === parentSession.id && ctx.passesSession(s));
	const firstClassChildren = childCandidates
		.filter(s => !isArchivedOrTerminalSession(s) && isFirstClassChildSession(s))
		.sort(compareSessions);
	const liveDelegates = childCandidates
		.filter(s => !isArchivedOrTerminalSession(s) && !!s.delegateOf && !isFirstClassChildSession(s))
		.sort(compareSessions);
	const liveChildren = firstClassChildren.length > 0 ? sortSessions([...firstClassChildren, ...liveDelegates]) : firstClassChildren;
	const delegateChildren = firstClassChildren.length === 0 ? liveDelegates : [];
	const liveChildIds = new Set([...liveChildren, ...delegateChildren].map(s => s.id));
	const archivedDelegates = ctx.includeArchived
		? childCandidates
			.filter(s => !liveChildIds.has(s.id) && (isArchivedOrTerminalSession(s) || ctx.archivedSessions.includes(s)))
			.sort(compareSessions)
		: [];
	for (const [childClass, children] of [["first-class", liveChildren], ["delegate", delegateChildren], ["archived-delegate", archivedDelegates]] as const) {
		if (children.length === 0) continue;
		const group = makeNode<SessionChildrenContext>(ctx, { kind: "session-children", sessionId: parentSession.id, childClass }, { sessionId: parentSession.id, childClass, childSessionKeys: [] }, parent.key, parent.logicalDepth + 1, parent.indentDepth + 1, (parent.indentDepth + 1) * ctx.layout.baseIndentPx);
		for (const child of children) {
			const childNode = makeSessionNode(child, group, childClass, ctx);
			group.children.push(childNode);
			group.context.childSessionKeys.push(childNode.key);
		}
		parent.children.push(group);
		groupKeys.push(group.key);
		const existing = ctx.sessionChildrenNodesBySessionId.get(parentSession.id) ?? [];
		existing.push(group);
		ctx.sessionChildrenNodesBySessionId.set(parentSession.id, existing);
	}
	return groupKeys;
}

function makeSessionNode(session: SessionLike, parent: SidebarTreeNode, childClass: SidebarSessionChildrenClass | undefined, ctx: BuildContext): SidebarTreeNode<SessionContext> {
	const node = makeNode<SessionContext>(ctx, { kind: "session", sessionId: session.id }, {
		session,
		projectId: session.projectId,
		goalId: session.goalId,
		teamGoalId: session.teamGoalId,
		isTeamLead: session.role === "team-lead",
		childClass,
		activeCandidate: session.id === ctx.input.filters?.activeSessionId,
		matchesSearch: matchesSearch(session.title ?? session.role ?? "", ctx.input.filters?.searchQuery),
	}, parent.key, parent.logicalDepth + 1, parent.indentDepth + 1, (parent.indentDepth + 1) * ctx.layout.baseIndentPx);
	appendSessionChildrenGroups(node, session, ctx);
	return node;
}

function makeNode<TContext>(
	ctx: BuildContext,
	nodeKey: SidebarTreeNodeKey,
	context: TContext,
	parentKey: string | null,
	logicalDepth: number,
	indentDepth: number,
	indentPx: number,
	register = true,
): SidebarTreeNode<TContext> {
	const key = sidebarTreeKey(nodeKey);
	const defaultExpanded = ctx.input.expansion?.defaultExpanded?.(nodeKey, defaultExpandedFor(nodeKey)) ?? defaultExpandedFor(nodeKey);
	const expanded = ctx.input.expansion?.isExpanded?.(nodeKey, defaultExpanded) ?? defaultExpanded;
	const node: SidebarTreeNode<TContext> = {
		key,
		canonicalKey: key,
		nodeKey,
		kind: nodeKey.kind,
		entityId: entityIdFor(nodeKey),
		parentKey,
		children: [],
		logicalDepth,
		depth: logicalDepth,
		indentDepth,
		indentLevel: indentDepth,
		indentPx,
		expandable: isSidebarTreeExpandable(nodeKey),
		expansionClass: expansionClassFor(nodeKey),
		defaultExpanded,
		expanded,
		context,
	};
	if (register) registerNode(node, ctx);
	return node;
}

function registerNode(node: SidebarTreeNode, ctx: BuildContext): void {
	if (ctx.flatByKey.has(node.key)) {
		ctx.diagnostics.push({ kind: "duplicate-node-key", key: node.key });
		return;
	}
	ctx.flatByKey.set(node.key, node);
}

function claimSpawnedGoals(spawnedCandidates: readonly GoalLike[], ctx: BuildContext): void {
	const descendantsByRootId = collectDescendantIdsByRoot(spawnedCandidates);
	for (const parent of spawnedCandidates) {
		for (const lead of teamLeadSessionsForGoal(parent.id, ctx.liveSessions, ctx.archivedSessions, ctx.includeArchived)) {
			if (!willRenderTeamLeadForSpawnedPlacement(parent, lead, ctx)) continue;
			for (const child of selectSpawnedChildren(spawnedCandidates, parent.id, lead.id, ctx.includeArchived, lead.id)) {
				ctx.spawnedRootGoalIds.add(child.id);
				ctx.claimedSpawnedGoalIds.add(child.id);
				for (const descendantId of descendantsByRootId.get(child.id) ?? []) {
					ctx.claimedSpawnedGoalIds.add(descendantId);
				}
			}
		}
	}
}

function willRenderTeamLeadForSpawnedPlacement(goal: GoalLike, lead: SessionLike, ctx: BuildContext): boolean {
	if (!goal.team || isChildSession(lead)) return false;
	if (lead.archived || ctx.archivedSessions.includes(lead)) return ctx.includeArchived && ctx.passesSession(lead);
	if (ctx.passesSession(lead)) return true;
	return ctx.liveSessions.some(s => s.id !== lead.id && isGoalOwningSession(s, goal.id) && !isChildSession(s) && ctx.passesSession(s));
}

function collectDescendantIdsByRoot(goals: readonly GoalLike[]): Map<string, Set<string>> {
	const byParent = new Map<string, GoalLike[]>();
	for (const goal of goals) {
		if (!goal.parentGoalId) continue;
		const children = byParent.get(goal.parentGoalId) ?? [];
		children.push(goal);
		byParent.set(goal.parentGoalId, children);
	}
	const out = new Map<string, Set<string>>();
	const visit = (rootId: string, goal: GoalLike, path: Set<string>) => {
		const children = byParent.get(goal.id) ?? [];
		for (const child of children) {
			if (path.has(child.id)) continue;
			let descendants = out.get(rootId);
			if (!descendants) {
				descendants = new Set();
				out.set(rootId, descendants);
			}
			descendants.add(child.id);
			visit(rootId, child, new Set([...path, child.id]));
		}
	};
	for (const goal of goals) visit(goal.id, goal, new Set([goal.id]));
	return out;
}

function descendantSubtreeInput(
	root: GoalLike,
	goals: readonly GoalLike[],
	claimed: ReadonlySet<string>,
	diagnostics?: SidebarTreeDiagnostic[],
	cycleCutsByParentGoalId?: Map<string, string[]>,
): GoalLike[] {
	const byParent = new Map<string, GoalLike[]>();
	for (const goal of goals) {
		if (!goal.parentGoalId) continue;
		const list = byParent.get(goal.parentGoalId) ?? [];
		list.push(goal);
		byParent.set(goal.parentGoalId, list);
	}
	const out: GoalLike[] = [];
	const emitted = new Set<string>();
	const recordCycle = (parentGoalId: string, repeatedGoalId: string, ancestorGoalIds: readonly string[]): void => {
		const cuts = cycleCutsByParentGoalId?.get(parentGoalId) ?? [];
		if (!cuts.includes(repeatedGoalId)) {
			cuts.push(repeatedGoalId);
			cycleCutsByParentGoalId?.set(parentGoalId, cuts);
			diagnostics?.push({ kind: "cycle-cut", goalId: repeatedGoalId, parentGoalId, ancestorGoalIds: [...ancestorGoalIds] });
		}
	};
	const visit = (goal: GoalLike, path: string[]): void => {
		if (path.includes(goal.id)) {
			recordCycle(path[path.length - 1] ?? goal.id, goal.id, path);
			return;
		}
		if (emitted.has(goal.id)) return;
		emitted.add(goal.id);
		out.push(goal);
		const nextPath = [...path, goal.id];
		for (const child of byParent.get(goal.id) ?? []) {
			if (child.id !== root.id && claimed.has(child.id)) continue;
			if (nextPath.includes(child.id)) {
				recordCycle(goal.id, child.id, nextPath);
				continue;
			}
			visit(child, nextPath);
		}
	};
	visit(root, []);
	return sortGoals(out);
}

export const descendantSubtreeInputForTesting = descendantSubtreeInput;

function sanitizeGoalForestInput(
	goals: readonly GoalLike[],
	projectId: string,
	projectIdByGoalId: ReadonlyMap<string, string>,
	diagnostics: SidebarTreeDiagnostic[],
	cycleCutsByParentGoalId: Map<string, string[]>,
): GoalLike[] {
	const byId = new Map(goals.map(g => [g.id, g]));
	const parentOverride = new Map<string, string | undefined>();
	for (const goal of goals) {
		if (goal.parentGoalId && projectIdByGoalId.get(goal.parentGoalId) && projectIdByGoalId.get(goal.parentGoalId) !== projectId) {
			parentOverride.set(goal.id, undefined);
		}
	}
	for (const goal of goals) {
		const path: string[] = [];
		const seen = new Set<string>();
		let cursor: GoalLike | undefined = goal;
		while (cursor) {
			if (seen.has(cursor.id)) break;
			seen.add(cursor.id);
			path.push(cursor.id);
			const parentId = parentOverride.has(cursor.id) ? parentOverride.get(cursor.id) : cursor.parentGoalId;
			if (!parentId) break;
			if (path.includes(parentId)) {
				parentOverride.set(cursor.id, undefined);
				const cuts = cycleCutsByParentGoalId.get(parentId) ?? [];
				if (!cuts.includes(cursor.id)) cuts.push(cursor.id);
				cycleCutsByParentGoalId.set(parentId, cuts);
				diagnostics.push({ kind: "cycle-cut", goalId: cursor.id, parentGoalId: parentId, ancestorGoalIds: [...path] });
				break;
			}
			cursor = byId.get(parentId);
		}
	}
	return goals.map(goal => parentOverride.has(goal.id) ? { ...goal, parentGoalId: parentOverride.get(goal.id) } : goal);
}

function keyParts(input: SidebarTreeNodeKey): [SidebarTreeNodeKind, string] {
	switch (input.kind) {
		case "project":
		case "project-sessions":
		case "project-staff":
		case "project-archived": return [input.kind, input.projectId];
		case "goal": return [input.kind, input.goalId];
		case "team-lead":
		case "session-children":
		case "session": return [input.kind, input.sessionId];
	}
}

function entityIdFor(input: SidebarTreeNodeKey): string {
	return keyParts(input)[1];
}

function expansionClassFor(key: SidebarTreeNodeKey): SidebarTreeExpansionClass | undefined {
	switch (key.kind) {
		case "project": return "project";
		case "project-sessions":
		case "project-staff":
		case "project-archived": return "section";
		case "goal": return "goal";
		case "team-lead": return "team-lead";
		case "session-children": return "session-children";
		case "session": return undefined;
	}
}

function defaultExpandedFor(key: SidebarTreeNodeKey): boolean {
	switch (key.kind) {
		case "project":
		case "project-sessions":
		case "project-staff":
		case "project-archived":
		case "team-lead": return true;
		case "session-children": return key.childClass === "first-class";
		case "goal":
		case "session": return false;
	}
}

function orderProjects(projects: readonly ProjectLike[], projectOrder?: readonly string[]): ProjectLike[] {
	if (!projectOrder?.length) return [...projects];
	const byId = new Map(projects.map(p => [p.id, p]));
	const out: ProjectLike[] = [];
	const seen = new Set<string>();
	for (const id of projectOrder) {
		const project = byId.get(id);
		if (!project || seen.has(id)) continue;
		out.push(project);
		seen.add(id);
	}
	for (const project of projects) if (!seen.has(project.id)) out.push(project);
	return out;
}

function dedupeGoals(goals: readonly GoalLike[], diagnostics: SidebarTreeDiagnostic[]): GoalLike[] {
	const out: GoalLike[] = [];
	const seen = new Set<string>();
	for (const goal of sortGoals(goals)) {
		if (seen.has(goal.id)) {
			diagnostics.push({ kind: "duplicate-goal-id", goalId: goal.id });
			continue;
		}
		seen.add(goal.id);
		out.push(goal);
	}
	return out;
}

function sortGoals<T extends { id: string; createdAt?: number; archived?: boolean }>(goals: readonly T[]): T[] {
	return [...goals].sort((a, b) => {
		const archivedCmp = Number(!!a.archived) - Number(!!b.archived);
		if (archivedCmp !== 0) return archivedCmp;
		const createdCmp = (a.createdAt ?? 0) - (b.createdAt ?? 0);
		if (createdCmp !== 0) return createdCmp;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
}

function compareSessions(a: SessionLike, b: SessionLike): number {
	const createdCmp = (a.createdAt ?? 0) - (b.createdAt ?? 0);
	if (createdCmp !== 0) return createdCmp;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sortSessions<T extends SessionLike>(sessions: readonly T[]): T[] {
	return [...sessions].sort(compareSessions);
}

function dedupeSessionsById<T extends SessionLike>(sessions: readonly T[]): T[] {
	const out: T[] = [];
	const seen = new Set<string>();
	for (const session of sessions) {
		if (seen.has(session.id)) continue;
		seen.add(session.id);
		out.push(session);
	}
	return out;
}

function resolveGoalProjectId(goal: GoalLike, goalById: ReadonlyMap<string, GoalLike>, projectIds: ReadonlySet<string>, fallbackProjectId?: string): string | undefined {
	if (goal.projectId && projectIds.has(goal.projectId)) return goal.projectId;
	let cursor: GoalLike | undefined = goal;
	const seen = new Set<string>();
	while (cursor?.parentGoalId && !seen.has(cursor.id)) {
		seen.add(cursor.id);
		const parent = goalById.get(cursor.parentGoalId);
		if (!parent) break;
		if (parent.projectId && projectIds.has(parent.projectId)) return parent.projectId;
		cursor = parent;
	}
	return fallbackProjectId;
}

function nestedDepthForProject(projectId: string, depths: BuildSidebarTreeInput["nestedDepthByProject"], fallback: number): number {
	if (!depths) return fallback;
	if (isReadonlyNumberMap(depths)) return depths.get(projectId) ?? fallback;
	const value = depths[projectId];
	return typeof value === "number" ? value : fallback;
}

function isReadonlyNumberMap(value: ReadonlyMap<string, number> | Record<string, number>): value is ReadonlyMap<string, number> {
	return typeof (value as { get?: unknown }).get === "function";
}

function isGoalOwningSession(session: SessionLike, goalId: string): boolean {
	return session.goalId === goalId || session.teamGoalId === goalId;
}

function isVerifierSessionId(id: string | undefined): boolean {
	return !!id && (/^llm-review-/.test(id) || /^agent-qa-/.test(id));
}

function effectiveArchivedTeamGoalId(session: SessionLike): string | undefined {
	return session.teamGoalId || (isVerifierSessionId(session.id) ? session.goalId : undefined);
}

function hasVerifierFallbackContent(session: SessionLike): boolean {
	const transcript = typeof session.agentSessionFile === "string"
		? session.agentSessionFile.trim()
		: session.agentSessionFile;
	const title = (session.title || "").trim();
	return !!transcript || (!!title && title !== "New session");
}

function isStandaloneArchivedSession(session: SessionLike, renderableGoalIds: ReadonlySet<string>): boolean {
	if (isChildSession(session)) return false;
	const owningGoalId = effectiveArchivedTeamGoalId(session);
	if (!owningGoalId) {
		const directOwningGoalId = session.goalId || session.teamGoalId;
		return !directOwningGoalId || !renderableGoalIds.has(directOwningGoalId);
	}
	if (!isVerifierSessionId(session.id)) return false;
	return !renderableGoalIds.has(owningGoalId) && hasVerifierFallbackContent(session);
}

function sessionParentId(session: SessionLike): string | undefined {
	return session.parentSessionId || session.delegateOf;
}

function isFirstClassChildSession(session: SessionLike): boolean {
	return !!session.parentSessionId && !session.delegateOf;
}

function isArchivedOrTerminalSession(session: SessionLike): boolean {
	return session.archived === true || session.status === "terminated" || session.status === "archived";
}

function isChildSession(session: SessionLike): boolean {
	return !!sessionParentId(session);
}

function teamLeadSessionsForGoal(goalId: string, liveSessions: readonly SessionLike[], archivedSessions: readonly SessionLike[], includeArchived: boolean): SessionLike[] {
	const out: SessionLike[] = [];
	const liveLead = liveSessions.find(s => s.role === "team-lead" && isGoalOwningSession(s, goalId) && !isChildSession(s));
	if (liveLead) out.push(liveLead);
	if (includeArchived) out.push(...archivedSessions.filter(s => s.role === "team-lead" && isGoalOwningSession(s, goalId) && !isChildSession(s)));
	return out;
}

function matchesSearch(text: string, query: string | undefined): boolean {
	const q = query?.trim().toLowerCase();
	return !!q && text.toLowerCase().includes(q);
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const rounded = Math.round(value);
	if (rounded < min) return min;
	if (rounded > max) return max;
	return rounded;
}

function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined;
}
