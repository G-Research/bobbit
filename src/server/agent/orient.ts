/**
 * orient(self) — pure assembly logic for the `orient` tool's whoami payload.
 *
 * Finding W2.15 (Bobbit refactor program): closes Bobbit's biggest
 * self-description gap — no queryable "who am I" for an in-harness agent.
 * Every field below is a straight read of state the
 * gateway already holds (SessionInfo/PersistedSession, GoalRecord,
 * RegisteredProject, the gateway's own package.json version) — no new state,
 * no facts that can silently drift out of sync with reality.
 *
 * The one static list is `ORIENT_API_ROUTE_FAMILIES` — a small, deliberately
 * NOT auto-derived set of top-level REST route-family examples. A live,
 * generated full route catalog (OpenAPI) needs the route-registry refactor
 * described in the design doc as future work; building a throwaway version
 * of it here would be exactly the premature surface that doc warns against.
 * Instead, this hand-curated list is kept honest the same way
 * `defaults/system-prompt.md`'s endpoint list is kept honest: a pinning test
 * (tests/orient-api-route-families.test.ts) asserts every example route
 * actually resolves against the live server route surface, reusing the
 * extraction idiom in tests/helpers/server-route-surface.ts.
 *
 * This module is intentionally decoupled from `SessionInfo`/`PersistedSession`
 * (session-manager.ts / session-store.ts) so it stays a pure, dependency-free
 * function that's cheap to unit test — the server.ts route handler is
 * responsible for normalizing whichever session shape it has (live or
 * persisted) into `OrientSessionInput` before calling `buildOrientPayload`.
 */

export interface OrientSessionInput {
	id: string;
	title: string;
	/** Live status ("idle"/"streaming"/...), or a synthetic value like "dormant" for a persisted-only session. */
	status: string;
	cwd: string;
	worktreePath?: string;
	role?: string;
	assistantType?: string;
	sandboxed?: boolean;
	containerId?: string;
	/** `<provider>/<modelId>` the session is currently bound to, if known. */
	model?: string;
	thinkingLevel?: string;
	readOnly?: boolean;
	delegateOf?: string;
	parentSessionId?: string;
	childKind?: string;
	projectId?: string;
	goalId?: string;
	teamGoalId?: string;
	teamLeadSessionId?: string;
}

export interface OrientGoalInput {
	id: string;
	title: string;
	state: string;
	branch?: string;
	team?: boolean;
	teamLeadSessionId?: string;
	parentGoalId?: string;
}

export interface OrientProjectInput {
	id: string;
	name: string;
	rootPath: string;
}

export interface OrientGatewayInput {
	/** Bobbit's own package.json version. */
	version: string;
	/** Base URL agents should call back into (from `<stateDir>/gateway-url`, or "" if unavailable). */
	url: string;
	/** Absolute path to the auth token file (`<stateDir>/token`) — never the token value itself. */
	tokenPath: string;
}

export interface OrientPayload {
	gateway: OrientGatewayInput;
	apiRouteFamilies: ReadonlyArray<{ family: string; example: string }>;
	session: {
		id: string;
		title: string;
		status: string;
		cwd: string;
		worktreePath: string | null;
		role: string | null;
		assistantType: string | null;
		readOnly: boolean;
		delegateOf: string | null;
		parentSessionId: string | null;
		childKind: string | null;
		goalId: string | null;
		teamGoalId: string | null;
		teamLeadSessionId: string | null;
		runtime: {
			sandboxed: boolean;
			containerId: string | null;
			model: string | null;
			thinkingLevel: string | null;
		};
	};
	project: OrientProjectInput | null;
	goal: {
		id: string;
		title: string;
		state: string;
		branch: string | null;
		team: boolean;
		teamLeadSessionId: string | null;
		parentGoalId: string | null;
	} | null;
}

/**
 * Curated top-level REST route families a self-orienting agent is most
 * likely to need next. NOT exhaustive (see module docblock) — `example` is
 * one concrete, currently-live route per family, pinned by
 * tests/orient-api-route-families.test.ts so this list can never silently
 * point at a dead route the way `defaults/system-prompt.md` once did
 * (`/api/skills` vs the real `/api/slash-skills`, fixed by the api-drift
 * pinning test this list reuses the same idiom from).
 */
export const ORIENT_API_ROUTE_FAMILIES: ReadonlyArray<{ family: string; example: string }> = [
	{ family: "sessions", example: "GET /api/sessions" },
	{ family: "goals", example: "GET /api/goals" },
	{ family: "team", example: "GET /api/goals/:id/team/agents" },
	{ family: "gates", example: "GET /api/goals/:id/gates" },
	{ family: "tasks", example: "GET /api/goals/:id/tasks" },
	{ family: "tools", example: "GET /api/tools" },
	{ family: "mcp-servers", example: "GET /api/mcp-servers" },
	{ family: "workflows", example: "GET /api/workflows" },
	{ family: "projects", example: "GET /api/projects" },
	{ family: "skills", example: "GET /api/slash-skills" },
];

export function buildOrientPayload(input: {
	gateway: OrientGatewayInput;
	session: OrientSessionInput;
	goal: OrientGoalInput | null;
	project: OrientProjectInput | null;
}): OrientPayload {
	const { gateway, session, goal, project } = input;
	return {
		gateway,
		apiRouteFamilies: ORIENT_API_ROUTE_FAMILIES,
		session: {
			id: session.id,
			title: session.title,
			status: session.status,
			cwd: session.cwd,
			worktreePath: session.worktreePath ?? null,
			role: session.role ?? null,
			assistantType: session.assistantType ?? null,
			readOnly: !!session.readOnly,
			delegateOf: session.delegateOf ?? null,
			parentSessionId: session.parentSessionId ?? null,
			childKind: session.childKind ?? null,
			goalId: session.goalId ?? null,
			teamGoalId: session.teamGoalId ?? null,
			teamLeadSessionId: session.teamLeadSessionId ?? null,
			runtime: {
				sandboxed: !!session.sandboxed,
				containerId: session.containerId ?? null,
				model: session.model ?? null,
				thinkingLevel: session.thinkingLevel ?? null,
			},
		},
		project,
		goal: goal
			? {
					id: goal.id,
					title: goal.title,
					state: goal.state,
					branch: goal.branch ?? null,
					team: !!goal.team,
					teamLeadSessionId: goal.teamLeadSessionId ?? null,
					parentGoalId: goal.parentGoalId ?? null,
				}
			: null,
	};
}
