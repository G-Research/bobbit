import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { apiFetch, expect } from "./journey-fixture.js";

/** Stable selectors from tests/e2e/ui/add-project-helpers.ts */
export const ADD_PROJECT = {
	dialog:       '[data-testid="add-project-dialog"]',
	picker:       '[data-testid="add-project-picker"]',
	pickerInput:  '[data-testid="directory-picker-input"]',
	pickerBrowse: '[data-testid="directory-picker-browse"]',
	pickerSuggestions: '[data-testid="directory-picker-suggestions"]',
	pickerSuggestion: '[data-testid="directory-picker-suggestion"]',
	statusSlot:   '[data-testid="add-project-status-slot"]',
	footer:       '[data-testid="add-project-footer"]',
	browseDialog: '[data-testid="add-project-browse-dialog"]',
	browseUp:     '[data-testid="add-project-browse-up"]',
	browseCurrent:'[data-testid="add-project-browse-current"]',
	browseEntry:  '[data-testid="add-project-browse-entry"]',
	browseList:   '[data-testid="add-project-browse-list"]',
	continue:     '[data-testid="add-project-continue"]',
	createDirectory: '[data-testid="add-project-create-directory"]',
	preflightPanel:'[data-testid="preflight-panel"]',
	step:         '[data-testid="add-project-step"]',
	scanChecklist:'[data-testid="add-project-scan-checklist"]',
	selectAll:    '[data-testid="add-project-select-all"]',
	deselectAll:  '[data-testid="add-project-deselect-all"]',
	selectedCount:'[data-testid="add-project-selected-count"]',
	scanCheckboxFor: (id: string) => `[data-testid="add-project-scan-checkbox-${id}"]`,
} as const;

/** Preflight endpoint availability probe (older gateways lack it). */
export async function preflightAvailable(): Promise<boolean> {
	try {
		const res = await apiFetch("/api/projects/preflight?path=" + encodeURIComponent(tmpdir()));
		return res.status !== 404;
	} catch {
		return false;
	}
}

/** Build a multi-repo fixture: root with N child dirs, each with its own .git/. */
export function makeMultiRepoFixture(label: string, names: readonly string[]): string {
	const root = uniqueDir(`multirepo-${label}`);
	for (const name of names) {
		mkdirSync(join(root, name, ".git"), { recursive: true });
		writeFileSync(join(root, name, "README.md"), `# ${name}\n`);
	}
	return root;
}

let dirCounter = 0;
export function uniqueDir(label: string): string {
	const dir = join(
		tmpdir(),
		`bobbit-v2-onb-${label}-${process.env.E2E_PORT ?? "0"}-${Date.now()}-${++dirCounter}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

export async function clearAddedProjects(): Promise<void> {
	try {
		const res = await apiFetch("/api/projects");
		const data = await res.json();
		const projects: Array<{ id: string; name: string }> = data.projects || data || [];
		for (const project of projects) {
			if (project.name === "default") continue;
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
		}
	} catch {
		// best-effort cleanup
	}
}

/** Open the Add Project dialog; returns the input locator. */
export async function openAddProjectDialog(page: Page): Promise<void> {
	await page.locator("button").filter({ hasText: "Add Project" }).first().click();
	await expect(page.locator(ADD_PROJECT.dialog)).toBeVisible({ timeout: 15_000 });
	await expect(page.locator(ADD_PROJECT.pickerInput)).toBeVisible({ timeout: 15_000 });
}

/**
 * Commit an already-complete path through the picker's public selection event.
 * This intentionally bypasses the typeahead debounce: the select-all journey
 * verifies the scan controls, while the dedicated typeahead journey owns typed
 * path/debounce coverage.
 */
export async function selectCompletedProjectPath(page: Page, path: string): Promise<void> {
	await page.locator(ADD_PROJECT.picker).evaluate((element, selectedPath) => {
		const picker = element as HTMLElement & { setCompletedPath?: (value: string) => void };
		picker.setCompletedPath?.(selectedPath);
		picker.dispatchEvent(new CustomEvent("directory-select", {
			bubbles: true,
			composed: true,
			detail: { path: selectedPath, source: "browse" },
		}));
	}, path);
	await expect(page.locator(ADD_PROJECT.pickerInput)).toHaveValue(path);
}
