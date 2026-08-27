export default function createRenderer({ html }) {
	const version = "v1";
	return {
		render(_params, _result, _isStreaming, ctx) {
			const openPanel = () => ctx?.host?.ui?.openPanel({
				panelId: "hot-reload-fixture.detail",
				params: { artifactId: "artifact-42", marker: "stable-marker" },
			});
			return {
				isCustom: false,
				content: html`
					<section data-testid="pack-hot-reload-renderer" data-version=${version}>
						<span data-testid="pack-hot-reload-renderer-version">renderer ${version}</span>
						<button type="button" data-testid="pack-hot-reload-open-panel" @click=${openPanel}>Open fixture panel</button>
					</section>
				`,
			};
		},
	};
}
