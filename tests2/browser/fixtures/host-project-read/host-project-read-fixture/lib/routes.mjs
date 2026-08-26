// Pack-owned panel data is intentionally loaded before any host.project read.
// The route echoes only its declared record references plus the authenticated
// session identity supplied by the Host; it cannot choose a project.
export const routes = {
	async "panel-data"(ctx, request) {
		const query = request?.query ?? {};
		return {
			sessionId: ctx.sessionId,
			goalId: String(query.goalId ?? ""),
			foreignGoalId: String(query.foreignGoalId ?? ""),
			foreignSessionId: String(query.foreignSessionId ?? ""),
			missingGoalId: String(query.missingGoalId ?? "missing-goal-browser-fixture"),
			missingSessionId: String(query.missingSessionId ?? "missing-session-browser-fixture"),
		};
	},
};
