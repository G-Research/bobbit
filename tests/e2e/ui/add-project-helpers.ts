/**
 * Shared fixture/utility helpers for the Add Project browser E2E specs.
 *
 * The five `add-project-*.spec.ts` siblings that drive the V2 picker — typeahead,
 * footer-stability, browse-modal, multi-repo-subset, and select-all — share the
 * same dialog-opening sequence, temp-dir conventions, and assistant-prompt WS
 * capture trick. Centralising those here keeps individual specs focused on what
 * they verify.
 */
import { expect, type Page } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Stable selectors exposed by the V2 Add Project dialog. */
export const ADD_PROJECT = {
	dialog: '[data-testid="add-project-dialog"]',
	picker: '[data-testid="add-project-picker"]',
	pickerInput: '[data-testid="directory-picker-input"]',
	pickerBrowse: '[data-testid="directory-picker-browse"]',
	pickerSuggestions: '[data-testid="directory-picker-suggestions"]',
	pickerSuggestion: '[data-testid="directory-picker-suggestion"]',
	statusSlot: '[data-testid="add-project-status-slot"]',
	preflightSlot: '[data-testid="add-project-preflight-slot"]',
	preflightPanel: '[data-testid="preflight-panel"]',
	footer: '[data-testid="add-project-footer"]',
	step: '[data-testid="add-project-step"]',
	browseDialog: '[data-testid="add-project-browse-dialog"]',
	browseUp: '[data-testid="add-project-browse-up"]',
	browseCurrent: '[data-testid="add-project-browse-current"]',
	browseEntry: '[data-testid="add-project-browse-entry"]',
	browseList: '[data-testid="add-project-browse-list"]',
	browseStatus: '[data-testid="add-project-browse-status"]',
	browseFooter: '[data-testid="add-project-browse-footer"]',
	selectAll: '[data-testid="add-project-select-all"]',
	deselectAll: '[data-testid="add-project-deselect-all"]',
	selectedCount: '[data-testid="add-project-selected-count"]',
	scanChecklist: '[data-testid="add-project-scan-checklist"]',
	scanCheckboxFor: (id: string) =>
		`[data-testid="add-project-scan-checkbox-${id}"]`,
	scanRowFor: (id: string) => `[data-testid="add-project-scan-row-${id}"]`,
	continue: '[data-testid="add-project-continue"]',
} as const;

/** Build a unique temp dir under tmpdir(). Caller is responsible for cleanup. */
export function uniqueDir(label: string): string {
	const dir = join(
		tmpdir(),
		`bobbit-e2e-${label}-${process.env.E2E_PORT}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);
	mkdirSync(dir, { recursive: true });
	// Canonicalise so test assertions match the path the server stores after
	// any symlink resolution on tmpdir() (e.g. macOS /var/folders → /private/var).
	return realpathSync(dir);
}

/**
 * Build a multi-repo fixture: a root dir containing two sibling subdirectories,
 * each with its own `.git/`. `scanRepos()` returns one entry per child with
 * `hasGit:true`. Returns the absolute paths so specs can assert against the
 * canonical strings the server emits.
 */
export function makeMultiRepoFixture(
	label: string,
	names: readonly string[] = ["repo-a", "repo-b"],
): { root: string; children: string[] } {
	const root = uniqueDir(`multirepo-${label}`);
	const children: string[] = [];
	for (const name of names) {
		const repo = join(root, name);
		mkdirSync(join(repo, ".git"), { recursive: true });
		// A README ensures the child is non-trivially populated; not required
		// by scanRepos but it helps the directory listing make sense.
		writeFileSync(join(repo, "README.md"), `# ${name}\n`);
		children.push(repo);
	}
	return { root, children };
}

/** Open the app shell and trigger the Add Project dialog. */
export async function openAddProjectDialog(page: Page): Promise<void> {
	await openApp(page);
	await page.locator("button").filter({ hasText: "Add Project" }).first().click();
	await page.locator(ADD_PROJECT.dialog).waitFor({ state: "visible", timeout: 5_000 });
	await page.locator(ADD_PROJECT.pickerInput).waitFor({ state: "visible", timeout: 5_000 });
}

/** Type a value into the picker input and wait for the value to settle. */
export async function setPickerValue(page: Page, value: string): Promise<void> {
	const input = page.locator(ADD_PROJECT.pickerInput);
	await input.fill(value);
	await expect(input).toHaveValue(value);
}

/**
 * Wait for the preflight panel to render after typing a path. Returns true
 * when it appears, false if the endpoint is unavailable (older gateway).
 * Mirrors the same guard as the pre-existing preflight spec so the new
 * specs degrade the same way.
 */
export async function waitForPreflight(page: Page, timeoutMs = 8_000): Promise<boolean> {
	const panel = page.locator(ADD_PROJECT.preflightPanel);
	try {
		await panel.waitFor({ state: "visible", timeout: timeoutMs });
	} catch {
		return false;
	}
	return true;
}

/** True if the preflight endpoint exists (proxies the legacy availability probe). */
export async function preflightAvailable(): Promise<boolean> {
	try {
		const res = await apiFetch(
			"/api/projects/preflight?path=" + encodeURIComponent(tmpdir()),
		);
		return res.status !== 404;
	} catch {
		return false;
	}
}

/**
 * Hook `page` and start collecting every WebSocket `prompt` frame sent from the
 * page until the returned `stop()` is called. Returns a snapshot of all frames
 * matching `type === "prompt"` (the envelope `RemoteAgent.prompt` sends).
 *
 * Set this up BEFORE any session is created so we don't miss the first
 * connection's `framesent` events.
 */
export interface CapturedPrompt {
	text: string;
	ws: string;
	raw: any;
}
export function captureAssistantPrompts(page: Page): {
	prompts: CapturedPrompt[];
	stop: () => void;
} {
	const prompts: CapturedPrompt[] = [];
	const onWs = (ws: import("@playwright/test").WebSocket) => {
		ws.on("framesent", (event) => {
			try {
				const payload = typeof event.payload === "string"
					? event.payload
					: event.payload.toString("utf-8");
				const data = JSON.parse(payload);
				if (data?.type === "prompt" && typeof data.text === "string") {
					prompts.push({ text: data.text, ws: ws.url(), raw: data });
				}
			} catch {
				/* non-JSON frame */
			}
		});
	};
	page.on("websocket", onWs);
	return {
		prompts,
		stop: () => page.off("websocket", onWs),
	};
}

/** Strip every registered (non-default) project from the gateway registry. */
export async function clearProjects(): Promise<void> {
	const res = await apiFetch("/api/projects");
	const data = await res.json();
	const projects = data.projects || data || [];
	for (const p of projects) {
		if (p.name === "default") continue;
		await apiFetch(`/api/projects/${p.id}`, { method: "DELETE" }).catch(() => {});
	}
}
