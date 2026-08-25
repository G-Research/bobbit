// Minimal hand-authored pack SERVER route module (V1-schema no-tools litmus).
// ESM `export const routes`, loaded by the gateway RouteRegistry/RouteDispatcher
// and executed inside the confined worker. Only `ping` is allowlisted in
// pack.yaml routes.names; it returns a trivial payload so the panel can prove the
// host.callRoute path works for an orphan (no-tools) pack.
export const routes = {
	async ping(_ctx) {
		return { ok: true, pong: Date.now() };
	},
};
