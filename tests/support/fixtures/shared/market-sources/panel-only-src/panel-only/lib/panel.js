// Minimal hand-authored pack CLIENT panel module (V1-schema panel-only litmus).
// Self-contained ESM with a default factory. The pack has no tools/entrypoints/
// routes — the panel is a pure support surface, available whenever the pack is
// installed + active.
export default function createPanel({ html, renderHeader }) {
	return {
		render() {
			return html`
				${renderHeader ? renderHeader({ title: "Panel Only" }) : html`<header>Panel Only</header>`}
				<div data-testid="panelonly-body">panel-only</div>
			`;
		},
	};
}
