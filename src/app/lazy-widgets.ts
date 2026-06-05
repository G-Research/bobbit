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

let _goalStatusWidget: Promise<unknown> | null = null;
export function ensureGoalStatusWidget(): Promise<unknown> {
	if (_goalStatusWidget) return _goalStatusWidget;
	_goalStatusWidget = import("../ui/components/GoalStatusWidget.js");
	return _goalStatusWidget;
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

// ── Conditional-render LitElements ─────────────────────────────────
// These tags only appear after a user action / runtime event — bg
// processes spawn, a popover opens, search bar mounts, compaction
// completes, the agent prompts to continue a session, etc.
// Fire-and-forget triggers; Lit upgrades the unknown tag once defined.

let _bgProcessPill: Promise<unknown> | null = null;
export function ensureBgProcessPill(): Promise<unknown> {
	if (_bgProcessPill) return _bgProcessPill;
	_bgProcessPill = import("../ui/components/BgProcessPill.js");
	return _bgProcessPill;
}

let _costPopover: Promise<unknown> | null = null;
export function ensureCostPopover(): Promise<unknown> {
	if (_costPopover) return _costPopover;
	_costPopover = import("../ui/components/CostPopover.js");
	return _costPopover;
}

let _preCompactionHistory: Promise<unknown> | null = null;
export function ensurePreCompactionHistory(): Promise<unknown> {
	if (_preCompactionHistory) return _preCompactionHistory;
	_preCompactionHistory = import("../ui/components/PreCompactionHistory.js");
	return _preCompactionHistory;
}

let _searchBox: Promise<unknown> | null = null;
export function ensureSearchBox(): Promise<unknown> {
	if (_searchBox) return _searchBox;
	_searchBox = Promise.all([
		import("../ui/components/SearchBox.js"),
		import("../ui/components/SearchResults.js"),
	]);
	return _searchBox;
}

let _continueSessionChooser: Promise<unknown> | null = null;
export function ensureContinueSessionChooser(): Promise<unknown> {
	if (_continueSessionChooser) return _continueSessionChooser;
	_continueSessionChooser = import("../ui/components/ContinueSessionChooser.js");
	return _continueSessionChooser;
}
