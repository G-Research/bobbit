export default function createPanel({ html }) {
	const version = "v1";
	return {
		render(params) {
			return html`
				<section
					data-testid="pack-hot-reload-panel"
					data-version=${version}
					data-artifact-id=${String(params?.artifactId ?? "")}
					data-marker=${String(params?.marker ?? "")}
				>
					<span data-testid="pack-hot-reload-panel-version">panel ${version}</span>
				</section>
			`;
		},
	};
}
