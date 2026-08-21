// Authoritative fixture projection reached only through this pack's scoped Host API.
export const routes = {
	async snapshot(ctx) {
		return {
			sessionId: ctx.sessionId,
			workingDir: ctx.workingDir,
		};
	},
};
