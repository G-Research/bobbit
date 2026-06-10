// Minimal hand-authored pack CLIENT panel module (V1-schema no-tools litmus).
// Self-contained ESM with a default factory handed the host's lit toolkit; the
// host hands each render() the per-session Host API. It calls a pack route and a
// pack-scoped store through the Host API (no raw fetch) to exercise the
// pack-bound surface auth path.
export default function createPanel({ html, renderHeader }) {
	return {
		async render(host, params) {
			const pong = await host.callRoute("ping", { query: { jobId: params?.jobId } });
			await host.store.put("last-job", { jobId: params?.jobId ?? null });
			return html`
				${renderHeader ? renderHeader({ title: "No-Tools Viewer" }) : nothingHeader()}
				<div data-testid="notools-panel-body">ping: ${pong?.ok ? "ok" : "?"}</div>
			`;
		},
	};
	function nothingHeader() {
		return html`<header>No-Tools Viewer</header>`;
	}
}
