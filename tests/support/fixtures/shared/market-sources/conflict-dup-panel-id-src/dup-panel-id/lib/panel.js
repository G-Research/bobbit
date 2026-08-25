// Stub panel module for the duplicate-panel-id conflict fixture. The conflict is
// structural (two panels/*.yaml share id `dup.viewer`) and detected at registry
// build, so this body is never expected to render.
export default function createPanel({ html }) {
	return { render: () => html`<div>dup-panel-id stub</div>` };
}
