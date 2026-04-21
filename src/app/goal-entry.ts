/**
 * Entry point for "+ New Goal" actions.
 *
 * Centralizes the behavior of every goal-creation trigger (toolbar button,
 * mobile toolbar, Alt+G shortcut, empty-state CTA) so call sites stay in
 * sync with the multi-project UX defined in the eliminate-default-project
 * design doc (§4.3).
 *
 * Zero-project  → routes to the Add Project flow.
 * One-project   → skips the picker; opens the goal dialog immediately.
 * Many-project  → anchors a `<project-picker-popover>` beneath `anchorEl`.
 */

import { state } from "./state.js";
import { showGoalDialog, showProjectDialog } from "./dialogs.js";
import "../ui/components/ProjectPickerPopover.js";
import type { ProjectPickerPopover } from "../ui/components/ProjectPickerPopover.js";

/**
 * Mount the project picker popover anchored to `anchorEl`. Fires `onPick`
 * when the user chooses a project and tears the popover down afterwards.
 * Closes (and tears down) on Esc/click-outside without firing `onPick`.
 *
 * Idempotent: if a previous popover is still mounted it is removed first.
 */
export function showProjectPickerPopover(
	anchorEl: HTMLElement | null,
	onPick: (projectId: string) => void,
): void {
	// Tear down any stale instance so repeated invocations don't stack.
	for (const stale of Array.from(document.querySelectorAll("project-picker-popover"))) {
		stale.remove();
	}

	const picker = document.createElement("project-picker-popover") as ProjectPickerPopover;
	picker.projects = state.projects.map(p => ({
		id: p.id,
		name: p.name,
		colorLight: p.colorLight,
		colorDark: p.colorDark,
		color: p.color,
	}));
	picker.anchorEl = anchorEl;
	picker.open = true;

	const teardown = () => {
		picker.open = false;
		// Remove after one frame so disconnectedCallback runs in a predictable order.
		queueMicrotask(() => {
			try { picker.remove(); } catch { /* ignore */ }
		});
	};

	picker.addEventListener("project-pick", (ev: Event) => {
		const detail = (ev as CustomEvent<{ projectId: string }>).detail;
		const pid = detail?.projectId;
		teardown();
		if (pid) onPick(pid);
	});
	picker.addEventListener("close", () => {
		teardown();
	});

	document.body.appendChild(picker);
}

/**
 * Entry point for every "+ New Goal" trigger.
 *
 *   - 0 projects → opens Add Project.
 *   - 1 project  → opens the goal dialog in that project (no picker).
 *   - ≥ 2        → opens the project picker anchored below `anchorEl`.
 */
export function startNewGoalFlow(anchorEl?: HTMLElement | null): void {
	const projects = state.projects;
	if (projects.length === 0) {
		showProjectDialog();
		return;
	}
	if (projects.length === 1) {
		const only = projects[0];
		if (only) showGoalDialog(undefined, only.id);
		return;
	}
	showProjectPickerPopover(anchorEl ?? null, (projectId) => {
		showGoalDialog(undefined, projectId);
	});
}
