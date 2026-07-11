import { icon } from "@mariozechner/mini-lit";
import { html } from "lit";
import { X } from "lucide";
import { renderApp } from "./state.js";

// Header-only "Link copied" toast — separate state + testid so it doesn't
// collide with the proposal-toast testid used by the proposal panels' own
// toast (the session header is rendered alongside open proposal panels).
let _headerToastText = "";
let _headerToastTimer: ReturnType<typeof setTimeout> | null = null;
export function showHeaderToast(text: string): void {
	_headerToastText = text;
	if (_headerToastTimer) clearTimeout(_headerToastTimer);
	_headerToastTimer = setTimeout(() => {
		_headerToastText = "";
		_headerToastTimer = null;
		renderApp();
	}, 2500);
	renderApp();
}

// Persistent launcher feedback — deliberately NOT sharing `_headerToastText`
// (which auto-clears after 2500ms). A launcher `pending` state must stay visible
// until the launch resolves; an `error` must persist until the user dismisses it.
let _launcherFeedback: { kind: "pending" | "error"; message: string } | null = null;

export function headerToast() {
	const transient = _headerToastText
		? html`<div class="review-toast" data-testid="header-toast">${_headerToastText}</div>`
		: "";
	const launcher = launcherFeedbackToast();
	if (!transient && !launcher) return "";
	return html`${transient}${launcher}`;
}

function launcherFeedbackToast() {
	if (!_launcherFeedback) return "";
	const { kind, message } = _launcherFeedback;
	if (kind === "pending") {
		return html`<div class="review-toast launcher-feedback" data-testid="launcher-feedback" data-kind="pending">
			<svg class="animate-spin shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
			<span>${message}</span>
		</div>`;
	}
	return html`<div class="review-toast launcher-feedback" data-testid="launcher-feedback" data-kind="error">
		<span>${message}</span>
		<button type="button" class="launcher-feedback-dismiss" data-testid="launcher-feedback-dismiss" title="Dismiss"
			@click=${() => { _launcherFeedback = null; renderApp(); }}>${icon(X, "xs")}</button>
	</div>`;
}

window.addEventListener("bobbit-launcher-feedback", (event: Event) => {
	const detail = (event as CustomEvent<{ kind?: string; message?: string }>).detail;
	if (!detail) return;
	if (detail.kind === "resolved") {
		_launcherFeedback = null;
		renderApp();
		return;
	}
	if ((detail.kind !== "pending" && detail.kind !== "error") || !detail.message) return;
	_launcherFeedback = { kind: detail.kind, message: detail.message };
	renderApp();
});
