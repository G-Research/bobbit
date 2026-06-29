// Test entry point — bundles the real renderSidebarBobbitCanvas (and Lit's
// render) for file:// use, so the spec can render the same sprite opts N times
// and observe how many times the canvas data-URL encode (toDataURL) actually
// runs. Pins the data-URL memoization in src/ui/bobbit-render.ts.
import { render } from "lit";
import {
	renderSidebarBobbitCanvas,
	ACCESSORY_DEFS,
	NO_ACCESSORY,
	type SidebarBobbitOptions,
} from "../../src/ui/bobbit-render.js";
import { statusBobbit } from "../../src/app/session-colors.js";

function renderInto(host: HTMLElement, opts: SidebarBobbitOptions): void {
	render(renderSidebarBobbitCanvas(opts), host);
}

function renderStatusInto(
	host: HTMLElement,
	status: string,
	isCompacting = false,
	isSelected = false,
	isAborting = false,
	accessory?: string,
	noDesaturate = false,
	unread = false,
): void {
	// Keep sessionId undefined so this fixture exercises statusBobbit's argument
	// forwarding without touching persisted session color assignment.
	render(statusBobbit(status, isCompacting, undefined, isSelected, isAborting, false, false, accessory, noDesaturate, unread), host);
}

(window as any).__sidebarBobbit = {
	renderInto,
	renderStatusInto,
	ACCESSORY_DEFS,
	NO_ACCESSORY,
};
(window as any).__ready = true;
