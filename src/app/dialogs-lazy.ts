/**
 * Lazy wrappers for `app/dialogs.ts`.
 *
 * `dialogs.ts` is ~66 kB of dialog rendering / project + goal creation /
 * gateway + QR + OAuth flows. None of that runs until the user opens a
 * dialog, so we keep the heavy module out of the entry chunk by routing
 * every call through a small wrapper that dynamic-imports it on first
 * call.
 *
 * Important: every caller that statically `import`ed from `./dialogs.js`
 * for the entry-chunk modules (render.ts, sidebar.ts, render-helpers.ts,
 * goal-entry.ts, goal-dashboard.ts, session-manager.ts) should import
 * from here instead so the static graph stays clean.
 *
 * Memoised at the module level \u2014 the first dialog open pays the chunk
 * fetch; subsequent calls reuse the same module promise.
 */
import type { Goal } from "./state.js";

let _loaded: Promise<typeof import("./dialogs.js")> | null = null;
function load(): Promise<typeof import("./dialogs.js")> {
	if (_loaded) return _loaded;
	_loaded = import("./dialogs.js");
	return _loaded;
}

// \u2500\u2500 Sync void wrappers \u2014 fire-and-forget. \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function showConnectionError(
	title: string,
	message: string,
	opts?: { code?: string; stack?: string },
): void {
	void load().then((m) => m.showConnectionError(title, message, opts));
}

export function openGatewayDialog(): void {
	void load().then((m) => m.openGatewayDialog());
}

export function showRenameDialog(sessionId: string, currentTitle: string): void {
	void load().then((m) => m.showRenameDialog(sessionId, currentTitle));
}

export function showGoalDialog(existingGoal?: Goal, projectId?: string): void {
	void load().then((m) => m.showGoalDialog(existingGoal, projectId));
}

export function showProjectDialog(): void {
	void load().then((m) => m.showProjectDialog());
}

// \u2500\u2500 Async wrappers \u2014 propagate the returned promise.  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export async function showQrCodeDialog(): Promise<void> {
	const m = await load();
	return m.showQrCodeDialog();
}

export async function confirmAction(
	title: string,
	message: string,
	confirmLabel?: string,
	destructive?: boolean,
): Promise<boolean> {
	const m = await load();
	return m.confirmAction(title, message, confirmLabel, destructive);
}

export async function checkOAuthStatus(provider?: string): Promise<boolean> {
	const m = await load();
	return m.checkOAuthStatus(provider);
}

export async function openOAuthDialog(provider?: string): Promise<boolean> {
	const m = await load();
	return m.openOAuthDialog(provider);
}

export async function createProjectAssistantSession(
	dirPath: string,
	scaffolding: boolean,
	opts?: { projectId?: string; existingProjectName?: string },
): Promise<void> {
	const m = await load();
	return m.createProjectAssistantSession(dirPath, scaffolding, opts);
}
