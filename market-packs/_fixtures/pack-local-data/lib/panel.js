export default function createPanel({ html, renderHeader }) {
	let result;
	let error;
	let loading;

	return {
		render(_params, host) {
			if (!loading && !result && !error) {
				loading = (async () => {
					const browserDirectory = await host.localData.directory();
					await host.callRoute("write", { body: { name: "host-marker.txt", content: "written-by-browser-route" } });
					const snapshot = await host.callRoute("snapshot", {});
					result = { browserDirectory, snapshot };
				})().catch((cause) => {
					error = cause instanceof Error ? cause.message : String(cause);
				}).finally(() => host.requestRender?.());
			}

			const header = renderHeader
				? renderHeader({ title: "Pack Local Data Fixture" })
				: html`<header>Pack Local Data Fixture</header>`;
			if (error) return html`${header}<pre data-testid="pack-local-data-error">${error}</pre>`;
			if (!result) return html`${header}<div data-testid="pack-local-data-loading">Loading…</div>`;
			return html`
				${header}
				<div data-testid="pack-local-data-browser-directory">${result.browserDirectory}</div>
				<div data-testid="pack-local-data-route-directory">${result.snapshot.directory}</div>
				<pre data-testid="pack-local-data-markers">${JSON.stringify(result.snapshot.markers)}</pre>
			`;
		},
	};
}
