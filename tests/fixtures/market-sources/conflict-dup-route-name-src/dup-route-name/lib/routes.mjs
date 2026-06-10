// Stub route module for the duplicate-route-name conflict fixture. The conflict
// is structural (routes.names lists `bundle` twice) and is detected before any
// module load, so this body is never expected to run.
export const routes = {
	async bundle(_ctx) {
		return { ok: true };
	},
};
