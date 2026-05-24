/**
 * Lazy loaders for medium-weight UI components that aren't on the cold
 * path.
 *
 * Each helper is memoised: callers fire-and-forget the first time and
 * Lit auto-upgrades the rendered tag (`<git-status-widget>`,
 * `<ask-user-choices-widget>`) once the chunk lands. Property bindings
 * set on the element before upgrade are preserved.
 *
 * For `AttachmentOverlay` the call site needs the value export
 * (`.open(...)`), so `loadAttachmentOverlay()` resolves to the module
 * itself — call sites should `await` it.
 *
 * Keep this file dependency-free so it never drags the lazy chunks
 * back into the entry graph.
 */
let _gitWidget: Promise<unknown> | null = null;
export function ensureGitStatusWidget(): Promise<unknown> {
	if (_gitWidget) return _gitWidget;
	_gitWidget = import("../ui/components/GitStatusWidget.js");
	return _gitWidget;
}

let _askWidget: Promise<unknown> | null = null;
export function ensureAskUserChoicesWidget(): Promise<unknown> {
	if (_askWidget) return _askWidget;
	_askWidget = import("../ui/components/AskUserChoicesWidget.js");
	return _askWidget;
}

let _attachmentOverlay: Promise<typeof import("../ui/dialogs/AttachmentOverlay.js")> | null = null;
export function loadAttachmentOverlay(): Promise<typeof import("../ui/dialogs/AttachmentOverlay.js")> {
	if (_attachmentOverlay) return _attachmentOverlay;
	_attachmentOverlay = import("../ui/dialogs/AttachmentOverlay.js");
	return _attachmentOverlay;
}
