import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
	apiFetch,
	createSession,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	registerProject,
	sendMessage,
	test,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";

test.describe.configure({ mode: "serial" });
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const PANEL = '[data-testid="file-explorer-panel"]';
const TREE = '[data-testid="file-explorer-tree"]';
const TREE_ITEM = '[data-testid="file-explorer-treeitem"]';
const PREVIEW = '[data-testid="file-explorer-preview"]';

interface FixtureProject {
	root: string;
	projectId: string;
	sessionId: string;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(cwd: string, relativePath: string, contents: string | Buffer): void {
	const file = join(cwd, ...relativePath.split("/"));
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, contents);
}

function createGitFixture(): string {
	const root = mkdtempSync(join(tmpdir(), `bobbit-file-explorer-git-${process.env.E2E_PORT ?? "0"}-`));
	git(root, "init", "-q");
	git(root, "config", "user.email", "file-explorer@example.test");
	git(root, "config", "user.name", "File Explorer Test");
	git(root, "config", "commit.gpgsign", "false");

	write(root, "src/changed.ts", 'export const version = "base";\n');
	write(root, "src/deleted.txt", "deleted baseline\n");
	write(root, "deep/navigation/direct-target.txt", "opened by canonical relative path\n");
	write(root, "search-only/level/Report.md", "opened from recursive path-fragment search\n");
	write(root, "copy-source.txt", "retained copy source\nsecond line\n");
	write(root, "rename-old.txt", "rename baseline\n");
	write(root, "conflict.txt", "conflict baseline\n");
	write(root, "binary.dat", Buffer.from([0, 1, 2, 3]));
	write(root, ".hidden", "dotfiles stay visible\n");
	git(root, "add", "--", ".");
	git(root, "commit", "-q", "-m", "explorer baseline");
	return root;
}

function populateGitChanges(root: string): void {
	write(root, "src/changed.ts", 'export const version = "staged";\n');
	git(root, "add", "--", "src/changed.ts");
	write(root, "src/changed.ts", 'export const version = "staged";\nexport const working = true;\n');
	write(root, "src/added.ts", "export const added = true;\n");
	git(root, "add", "--", "src/added.ts");
	rmSync(join(root, "src", "deleted.txt"));
	git(root, "mv", "--", "rename-old.txt", "rename-new.txt");
	write(root, "nested/copied.txt", "retained copy source\nsecond line\n");
	git(root, "add", "--", "nested/copied.txt");
	git(root, "config", "status.renames", "false");
	write(root, "untracked.txt", "untracked preview\n");
	write(root, "empty.txt", "");
	write(root, "binary.dat", Buffer.from([0, 9, 8, 7]));
	write(root, "oversized.txt", "x".repeat(1024 * 1024 + 32));

	// Build a deterministic unmerged index without entering an in-progress merge.
	// This keeps copy/rename fixtures independent while still exercising UU status.
	write(root, ".conflict-ours", "ours\n");
	write(root, ".conflict-theirs", "theirs\n");
	const baseBlob = git(root, "rev-parse", "HEAD:conflict.txt");
	const oursBlob = git(root, "hash-object", "-w", ".conflict-ours");
	const theirsBlob = git(root, "hash-object", "-w", ".conflict-theirs");
	rmSync(join(root, ".conflict-ours"));
	rmSync(join(root, ".conflict-theirs"));
	execFileSync("git", ["update-index", "--index-info"], {
		cwd: root,
		input: `100644 ${baseBlob} 1\tconflict.txt\n100644 ${oursBlob} 2\tconflict.txt\n100644 ${theirsBlob} 3\tconflict.txt\n`,
		stdio: ["pipe", "ignore", "pipe"],
	});
	write(root, "conflict.txt", "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n");
}

async function createFixtureProject(root: string, label: string): Promise<FixtureProject> {
	const project = await registerProject({
		name: `file-explorer-${label}-${Date.now()}`,
		rootPath: root,
		seedWorkflows: false,
	});
	const sessionId = await createSession({ cwd: root, projectId: project.id });
	await waitForSessionStatus(sessionId, "idle");
	return { root, projectId: project.id, sessionId };
}

async function removeFixtureProject(fixture: FixtureProject | undefined): Promise<void> {
	if (!fixture) return;
	await deleteSession(fixture.sessionId).catch(() => {});
	await apiFetch(`/api/projects/${fixture.projectId}`, { method: "DELETE" }).catch(() => {});
	rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function treeItem(page: Page, relativePath: string): Locator {
	return page.locator(`${TREE_ITEM}[data-path="${relativePath}"]`).first();
}

async function waitForExplorer(page: Page): Promise<Locator> {
	const panel = page.locator(PANEL);
	await expect(panel).toBeVisible({ timeout: 20_000 });
	await expect(panel.locator(TREE)).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
	return panel;
}

async function showTreeIfNarrow(panel: Locator): Promise<void> {
	const back = panel.getByRole("button", { name: "Back to files" });
	if (await back.isVisible()) await back.click();
}

async function waitForSessionActionsReady(page: Page, sessionId: string): Promise<void> {
	// Session hydration's final state update schedules one last full render. Wait
	// for it before clicking the lazy popover trigger so its async import retains
	// a connected anchor.
	await page.waitForFunction((id) => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		return state?.selectedSessionId === id && state?.connectingSessionId !== id;
	}, sessionId, { timeout: 15_000 });
	await page.evaluate(() => new Promise<void>((resolve) => {
		requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
	}));
}

async function openFromSessionMenu(page: Page, sessionId: string): Promise<void> {
	await waitForSessionActionsReady(page, sessionId);
	const trigger = page.locator('[data-testid="session-actions-trigger"]').first();
	await expect(trigger, "the active session actions menu must be available").toBeVisible({ timeout: 15_000 });
	await trigger.click();
	const menu = page.locator("sidebar-actions-popover [role=menu]");
	await expect(menu).toBeVisible({ timeout: 5_000 });
	const launcher = menu.getByRole("menuitem", { name: /Open file explorer/ });
	await expect(launcher, "the built-in explorer must contribute a session launcher").toBeVisible();
	await launcher.click();
	await expect(page.locator("sidebar-actions-popover")).toHaveCount(0, { timeout: 5_000 });
}

async function openFromSlashMenu(page: Page): Promise<void> {
	const composer = page.locator("message-editor textarea").first();
	await expect(composer).toBeVisible({ timeout: 15_000 });
	await composer.fill("/files");
	const slashEntry = page.locator('[data-testid="slash-command-files"]');
	await expect(slashEntry, "typing /files must offer the explorer launcher").toBeVisible({ timeout: 10_000 });
	await composer.press("Enter");
	await expect(composer).toHaveValue("/files ");
	await composer.press("Enter");
	await expect(composer).toHaveValue("");
}

async function expectBadge(page: Page, relativePath: string, label: RegExp): Promise<void> {
	const badge = treeItem(page, relativePath).locator(".bb-explorer-badges");
	await expect(badge, `${relativePath} should expose its Git status accessibly`).toHaveAttribute("aria-label", label);
}

test.describe("Journey: built-in file explorer pack", () => {
	let gitFixture: FixtureProject | undefined;
	let nonGitFixture: FixtureProject | undefined;

	test.afterEach(async () => {
		await removeFixtureProject(nonGitFixture);
		await removeFixtureProject(gitFixture);
		nonGitFixture = undefined;
		gitFixture = undefined;
	});

	// These locators intentionally pin the public role/name contract from the approved
	// interaction design instead of coupling the journey to implementation-only test ids.
	test("navigates and discovers nested paths, filters and collapses the tree, copies paths, and restores durable preferences", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		const projectRoot = createGitFixture();
		gitFixture = await createFixtureProject(projectRoot, "discovery");
		const persisted = gateway.sessionManager?.getPersistedSession(gitFixture.sessionId) as { cwd?: string; worktreePath?: string } | undefined;
		const root = persisted?.worktreePath ?? persisted?.cwd;
		expect(root, "the explorer fixture must mutate the bound session working directory").toBeTruthy();
		populateGitChanges(root!);
		await page.setViewportSize({ width: 1600, height: 1000 });
		await openApp(page);
		await navigateToHash(page, `#/session/${gitFixture.sessionId}`);
		await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers?.());
		await openFromSessionMenu(page, gitFixture.sessionId);
		let panel = await waitForExplorer(page);

		let search = panel.getByRole("combobox", { name: "Search files and folders" });
		await expect(search).toBeVisible();
		await treeItem(page, "copy-source.txt").click();
		await expect(treeItem(page, "copy-source.txt")).toHaveAttribute("aria-selected", "true");
		await showTreeIfNarrow(panel);

		await search.fill("LEVEL/rep");
		const reportResult = panel.getByRole("option").filter({ hasText: "Report.md" });
		await expect(reportResult, "search traverses directories that the lazy tree has never loaded").toBeVisible({ timeout: 15_000 });
		await expect(reportResult).toContainText(/search-only.*level/);
		await search.press("Enter");
		await expect(panel.locator(PREVIEW)).toContainText("search-only/level/Report.md", { timeout: 15_000 });
		await expect(panel.getByRole("region", { name: "Read-only file contents" })).toContainText("opened from recursive path-fragment search");
		await showTreeIfNarrow(panel);
		await expect(search).toHaveValue("LEVEL/rep");
		await panel.getByRole("button", { name: "Clear search" }).click();
		await expect(search).toHaveValue("");
		await expect(treeItem(page, "copy-source.txt"), "clearing search restores the prior tree selection").toHaveAttribute("aria-selected", "true");
		await expect(panel.locator(PREVIEW), "clearing search restores the prior preview even when the responsive tree pane is active").toContainText("retained copy source");
		await page.waitForTimeout(300);
		await page.reload();
		panel = await waitForExplorer(page);
		search = panel.getByRole("combobox", { name: "Search files and folders" });
		await expect(search, "the cleared query remains transient after reload").toHaveValue("");
		await expect(treeItem(page, "copy-source.txt"), "reload restores the browse selection persisted by search clear").toHaveAttribute("aria-selected", "true");
		await expect(panel.locator(PREVIEW)).toContainText("retained copy source");

		const pathShortcut = process.platform === "darwin" ? "Meta+L" : "Control+L";
		await treeItem(page, "copy-source.txt").focus();
		await page.keyboard.press(pathShortcut);
		let pathInput = panel.getByRole("textbox", { name: "Relative path" });
		await expect(pathInput).toBeFocused();
		await pathInput.fill("deep/navigation");
		await pathInput.press("Enter");
		await expect(treeItem(page, "deep/navigation"), "direct directory navigation reveals initially unloaded ancestors").toBeVisible({ timeout: 15_000 });
		await expect(treeItem(page, "deep/navigation")).toBeFocused();
		const breadcrumbs = panel.getByRole("navigation", { name: "Current absolute path" });
		await expect(breadcrumbs).toBeVisible();
		await expect(breadcrumbs.getByRole("button", { name: /navigation/i })).toHaveAttribute("aria-current", "location");

		await breadcrumbs.getByRole("button", { name: /deep/i }).click();
		await expect(treeItem(page, "deep")).toBeFocused();
		await treeItem(page, "deep").focus();
		await page.keyboard.press(pathShortcut);
		pathInput = panel.getByRole("textbox", { name: "Relative path" });
		await pathInput.fill("deep/navigation/direct-target.txt");
		await pathInput.press("Enter");
		await expect(treeItem(page, "deep/navigation/direct-target.txt")).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
		await expect(panel.locator(PREVIEW)).toContainText("deep/navigation/direct-target.txt");
		await expect(panel.getByRole("region", { name: "Read-only file contents" })).toContainText("opened by canonical relative path");
		await showTreeIfNarrow(panel);

		const selectedTarget = treeItem(page, "deep/navigation/direct-target.txt");
		const deleted = treeItem(page, "src/deleted.txt");
		const src = treeItem(page, "src");
		await src.click();
		await expect(deleted).toBeVisible();
		await deleted.click({ button: "right" });
		let pathMenu = page.getByRole("menu", { name: "Path actions" });
		await expect(pathMenu).toBeVisible();
		await pathMenu.getByRole("menuitem", { name: "Copy relative path" }).click({ timeout: 5_000 });
		await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("src/deleted.txt");
		await expect(panel.locator(".bb-explorer-inline-feedback").getByText("Relative path copied", { exact: true })).toBeVisible();
		await expect(selectedTarget, "opening a pointer context menu does not replace the selected preview").toHaveAttribute("aria-selected", "true");

		await deleted.focus();
		await deleted.press("Shift+F10");
		pathMenu = page.getByRole("menu", { name: "Path actions" });
		await expect(pathMenu.getByRole("menuitem", { name: "Copy relative path" })).toBeFocused();
		await pathMenu.getByRole("menuitem", { name: "Copy filename" }).click({ timeout: 5_000 });
		await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("deleted.txt");
		await expect(panel.locator(".bb-explorer-inline-feedback").getByText("Filename copied", { exact: true })).toBeVisible();
		await expect(deleted, "keyboard path actions restore focus to their invoking row").toBeFocused();
		await expect(selectedTarget).toHaveAttribute("aria-selected", "true");

		const collapseAll = panel.getByRole("button", { name: "Collapse all" });
		await collapseAll.click();
		await expect(collapseAll, "toolbar collapse keeps focus on its command").toBeFocused();
		await expect(collapseAll).toBeDisabled();
		await expect(panel.locator(PREVIEW), "collapsing preserves the selected preview while the tree pane is active").toContainText("opened by canonical relative path");
		await expect(treeItem(page, "deep/navigation/direct-target.txt")).toHaveCount(0);

		const changedOnly = panel.getByRole("button", { name: "Changed files only" });
		await changedOnly.click();
		await expect(changedOnly).toHaveAttribute("aria-pressed", "true");
		await expect(treeItem(page, "copy-source.txt"), "unchanged root files are hidden by the Git filter").toHaveCount(0);
		await treeItem(page, "src").click();
		await expect(treeItem(page, "src/deleted.txt"), "virtual deleted paths remain discoverable when filtered").toBeVisible();
		await changedOnly.click();
		await expect(changedOnly).toHaveAttribute("aria-pressed", "false");
		await expect(treeItem(page, "copy-source.txt")).toBeVisible();

		await page.setViewportSize({ width: 600, height: 800 });
		await changedOnly.focus();
		await page.keyboard.press(pathShortcut);
		pathInput = panel.getByRole("textbox", { name: "Relative path" });
		await pathInput.fill("deep/navigation/direct-target.txt");
		await pathInput.press("Enter");
		await expect(panel.getByRole("navigation", { name: "Current absolute path" }), "the path bar remains available in the narrow preview pane").toBeVisible();
		await expect(panel.getByRole("button", { name: "Back to files" })).toBeVisible();
		await panel.getByRole("button", { name: "Back to files" }).click();
		await expect(search).toBeVisible();
		await expect(changedOnly).toBeVisible();
		await expect(collapseAll).toBeVisible();
		expect((await search.boundingBox())?.width ?? 0, "narrow search remains usable").toBeGreaterThanOrEqual(120);

		await changedOnly.click();
		await expect(changedOnly).toHaveAttribute("aria-pressed", "true");
		await search.fill("Report.md");
		const narrowReport = panel.getByRole("option").filter({ hasText: "Report.md" });
		await expect(narrowReport, "search remains whole-root while Changed files only is active").toBeVisible({ timeout: 15_000 });
		await search.press("Enter");
		await expect(panel.getByRole("region", { name: "Read-only file contents" })).toContainText("opened from recursive path-fragment search");
		await expect(panel.locator('[aria-label="Changed files only"]'), "previewing a clean search result retains the durable filter preference").toHaveAttribute("aria-pressed", "true");
		await expect(panel.locator(TREE)).toContainText("Search includes all files.");
		await panel.getByRole("button", { name: "Back to files" }).click();
		await expect(search, "Back returns narrow search preview focus to the combobox owner").toBeFocused();
		await expect(search).toHaveAttribute("aria-activedescendant", /option-0$/);
		await search.press("ArrowDown");
		await expect(search).toHaveAttribute("aria-activedescendant", /option-0$/);
		await search.press("Escape");
		await expect(search).toHaveValue("");
		await expect(panel.locator(TREE)).toHaveAttribute("role", "tree");
		await expect(panel.locator(TREE), "clearing search resets the shared tree busy state").toHaveAttribute("aria-busy", "false");
		await expect(changedOnly).toHaveAttribute("aria-pressed", "true");
		await search.fill("Report.md");
		await expect(panel.getByRole("option").filter({ hasText: "Report.md" })).toBeVisible({ timeout: 15_000 });
		await page.reload();
		let restored = await waitForExplorer(page);
		await expect(restored.getByRole("button", { name: "Changed files only" })).toHaveAttribute("aria-pressed", "true");
		await expect(restored.getByRole("combobox", { name: "Search files and folders" }), "search queries are transient across reload").toHaveValue("");
		await expect(restored.getByRole("navigation", { name: "Current absolute path" })).toBeVisible();

		await restored.getByRole("button", { name: /Edit path/ }).click();
		pathInput = restored.getByRole("textbox", { name: "Relative path" });
		await pathInput.fill("draft/not-submitted");
		await page.reload();
		restored = await waitForExplorer(page);
		await expect(restored.getByRole("textbox", { name: "Relative path" }), "path editing state is transient across reload").toHaveCount(0);
		await expect(restored.getByRole("navigation", { name: "Current absolute path" })).toBeVisible();
		await expect(restored.getByRole("button", { name: "Changed files only" }), "the durable filter preference survives both reloads").toHaveAttribute("aria-pressed", "true");
	});

	test("launches a singleton, browses Git state read-only, restores it, refreshes, and browses outside Git @smoke", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		const projectRoot = createGitFixture();
		gitFixture = await createFixtureProject(projectRoot, "git");
		const persisted = gateway.sessionManager?.getPersistedSession(gitFixture.sessionId) as { cwd?: string; worktreePath?: string } | undefined;
		const root = persisted?.worktreePath ?? persisted?.cwd;
		expect(root, "the explorer fixture must mutate the bound session working directory").toBeTruthy();
		populateGitChanges(root!);
		await page.setViewportSize({ width: 1600, height: 1000 });

		const contributionsResponse = await apiFetch("/api/ext/contributions");
		expect(contributionsResponse.ok).toBe(true);
		const contributions = (await contributionsResponse.json()).packs as Array<{
			packId: string;
			panels?: Array<{ id: string }>;
			entrypoints?: Array<{ id: string; kind: string; label?: string }>;
			routeNames?: string[];
		}>;
		const explorer = contributions.find((pack) => pack.packId === "file-explorer");
		expect(explorer?.panels?.some((panel) => panel.id === "file-explorer.panel")).toBe(true);
		expect(explorer?.entrypoints).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "session-menu", label: "Open file explorer" }),
			expect.objectContaining({ kind: "composer-slash", id: "files" }),
		]));
		expect(explorer?.routeNames).toEqual(expect.arrayContaining(["list", "read", "diff", "resolve", "search"]));

		await openApp(page);
		await navigateToHash(page, "#/market");
		const builtinGroup = page.getByTestId("market-builtin-group");
		await expect(builtinGroup).toBeVisible({ timeout: 15_000 });
		const explorerCard = builtinGroup.locator('[data-testid="market-installed-pack"][data-builtin="true"][data-pack-name="file-explorer"]');
		await expect(explorerCard, "Marketplace must expose the shipped explorer as built-in").toBeVisible({ timeout: 15_000 });
		await expect(explorerCard.getByTestId("market-pack-builtin-badge")).toBeVisible();
		await expect(explorerCard.getByTestId("market-uninstall-pack"), "built-in packs cannot be uninstalled").toHaveCount(0);
		const activation = explorerCard.getByTestId("market-toggle-pack-file-explorer");
		await expect(activation, "the explorer is enabled by default").toBeChecked({ timeout: 15_000 });
		let activationPut = page.waitForResponse((response) => response.url().includes("/api/marketplace/pack-activation") && response.request().method() === "PUT");
		await activation.uncheck();
		expect((await activationPut).ok()).toBe(true);
		await expect(activation).not.toBeChecked();

		await navigateToHash(page, `#/session/${gitFixture.sessionId}`);
		await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
		const trigger = page.locator('[data-testid="session-actions-trigger"]').first();
		await trigger.click();
		const menu = page.locator("sidebar-actions-popover [role=menu]");
		await expect(menu).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: /Open file explorer/ }), "disabling the pack removes its session launcher").toHaveCount(0);
		await page.keyboard.press("Escape");
		// Closing is animated; wait for its completion before navigating and opening
		// the same session menu again, otherwise its stale ownership can consume the
		// next toggle without rendering a popover.
		await expect(page.locator("sidebar-actions-popover")).toHaveCount(0, { timeout: 5_000 });
		const composer = page.locator("message-editor textarea").first();
		await composer.fill("/files");
		await expect(page.getByTestId("slash-command-files"), "disabling the pack removes its slash launcher").toHaveCount(0);
		await composer.fill("");

		await navigateToHash(page, "#/market");
		await expect(activation).not.toBeChecked({ timeout: 15_000 });
		activationPut = page.waitForResponse((response) => response.url().includes("/api/marketplace/pack-activation") && response.request().method() === "PUT");
		await activation.check();
		expect((await activationPut).ok()).toBe(true);
		await expect(activation).toBeChecked();

		await navigateToHash(page, `#/session/${gitFixture.sessionId}`);
		await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers?.());

		await openFromSessionMenu(page, gitFixture.sessionId);
		const panel = await waitForExplorer(page);
		await expect(page.locator(PANEL)).toHaveCount(1);
		await expect(panel.getByRole("tree", { name: "Files" })).toBeVisible();
		await expect(treeItem(page, ".hidden"), "dotfiles are visible").toBeVisible();
		await expect(treeItem(page, ".git"), "internal .git is excluded").toHaveCount(0);

		await openFromSlashMenu(page);
		await expect(page.locator(PANEL), "the slash launcher focuses the existing singleton").toHaveCount(1);
		await expect(page.locator(PANEL)).toBeVisible();

		const src = treeItem(page, "src");
		await expect(src.locator(".bb-explorer-icon.kind-directory svg")).toHaveAttribute("stroke", /^url\(#folder-gradient-/);
		await src.focus();
		await src.press("ArrowRight");
		await expect(src).toHaveAttribute("aria-expanded", "true");
		await expect(treeItem(page, "src/added.ts"), "lazy children must load before navigating into the directory").toBeVisible();
		await src.press("ArrowRight");
		await expect(treeItem(page, "src/added.ts")).toBeFocused();
		await treeItem(page, "src/added.ts").press("ArrowLeft");
		await expect(src).toBeFocused();

		await expectBadge(page, "src/changed.ts", /Staged modified, Unstaged modified/);
		await expectBadge(page, "src/added.ts", /Staged added/);
		await expectBadge(page, "src/deleted.txt", /Unstaged deleted/);
		await expectBadge(page, "rename-new.txt", /renamed from rename-old\.txt/i);
		await expectBadge(page, "conflict.txt", /^Conflict$/);
		await expectBadge(page, "untracked.txt", /^Untracked$/);
		await expectBadge(page, "binary.dat", /Unstaged modified/);

		const nested = treeItem(page, "nested");
		await expect(nested.locator(".bb-explorer-icon.kind-directory svg")).toHaveAttribute("stroke", "var(--warning)");
		await nested.click();
		await expect(nested).toHaveAttribute("aria-expanded", "true");
		await expectBadge(page, "nested/copied.txt", /copied from copy-source\.txt/i);

		await treeItem(page, "src/changed.ts").click();
		await expect(panel.locator(PREVIEW)).toContainText("src/changed.ts");
		await expect(panel.locator(PREVIEW)).toContainText("Read only");
		await expect(panel.getByRole("region", { name: "Read-only file contents" })).toContainText('export const version = "staged";');
		await expect(panel.locator(".bb-explorer-line-number")).toHaveText(["1", "2", "3"]);
		await expect(panel.locator(`${PREVIEW} textarea, ${PREVIEW} input, ${PREVIEW} [contenteditable=true]`)).toHaveCount(0);

		await panel.getByRole("tab", { name: "Diff" }).click();
		const completeDiff = panel.getByRole("region", { name: "Working tree compared with HEAD" });
		await expect(completeDiff).toContainText('export const version = "base";');
		await expect(completeDiff).toContainText('export const version = "staged";');
		await expect(completeDiff).toContainText("export const working = true;");

		await showTreeIfNarrow(panel);
		await treeItem(page, "nested/copied.txt").click();
		await panel.getByRole("tab", { name: "Diff" }).click();
		await expect(panel.locator(".bb-explorer-diff-file")).toContainText("copy from copy-source.txt");
		await expect(panel.locator(".bb-explorer-diff-file")).toContainText("copy to nested/copied.txt");

		await showTreeIfNarrow(panel);
		await treeItem(page, "rename-new.txt").click();
		await panel.getByRole("tab", { name: "Diff" }).click();
		await expect(panel.locator(".bb-explorer-diff-file")).toContainText("rename from rename-old.txt");
		await expect(panel.locator(".bb-explorer-diff-file")).toContainText("rename to rename-new.txt");

		await showTreeIfNarrow(panel);
		await treeItem(page, "binary.dat").click();
		await expect(panel.getByRole("tab", { name: "Diff" }), "file navigation remembers Diff mode").toHaveAttribute("aria-selected", "true");
		await expect(panel.locator(PREVIEW)).toContainText("Binary file changed. A text diff is not available.");
		await panel.getByRole("tab", { name: "File" }).click();
		await expect(panel.locator(PREVIEW)).toContainText("Binary files cannot be previewed.");
		await showTreeIfNarrow(panel);
		await treeItem(page, "empty.txt").click();
		await expect(panel.locator(PREVIEW)).toContainText("This file is empty.");
		await panel.getByRole("tab", { name: "Diff" }).click();
		await expect(panel.locator(PREVIEW)).toContainText("Empty file added.");
		await panel.getByRole("tab", { name: "File" }).click();
		await showTreeIfNarrow(panel);
		await treeItem(page, "oversized.txt").click();
		await expect(panel.locator(PREVIEW)).toContainText(/File is too large|File exceeds the preview limit/);
		await showTreeIfNarrow(panel);
		await treeItem(page, "src/deleted.txt").click();
		await expect(panel.getByRole("tab", { name: "Diff" })).toHaveAttribute("aria-selected", "true");
		await expect(panel.getByRole("region", { name: "Working tree compared with HEAD" })).toContainText("deleted baseline");

		await showTreeIfNarrow(panel);
		await treeItem(page, "src/changed.ts").click();
		await panel.getByRole("tab", { name: "Diff" }).click();
		write(root!, "new-after-refresh.txt", "created outside Bobbit\n");
		await page.getByTestId("pack-panel-refresh").click();
		await showTreeIfNarrow(panel);
		await expect(treeItem(page, "new-after-refresh.txt")).toBeVisible({ timeout: 15_000 });
		await expect(src, "manual refresh preserves valid expansion").toHaveAttribute("aria-expanded", "true");
		await expect(treeItem(page, "src/changed.ts"), "manual refresh preserves selection").toHaveAttribute("aria-selected", "true");

		await sendMessage(page, "STAY_BUSY:2500 explorer idle refresh");
		await expect(page.locator("button[title='Stop streaming']"), "the refresh fixture must exercise a real non-idle agent state").toBeVisible({ timeout: 10_000 });
		write(root!, "new-after-idle.txt", "created while the agent was active\n");
		await waitForSessionStatus(gitFixture.sessionId, "idle", 15_000);
		await expect(treeItem(page, "new-after-idle.txt"), "the real transition back to idle refreshes the explorer").toBeVisible({ timeout: 15_000 });

		await page.waitForTimeout(300);
		await page.reload();
		const restored = await waitForExplorer(page);
		await expect(treeItem(page, "src")).toHaveAttribute("aria-expanded", "true");
		await expect(treeItem(page, "src/changed.ts")).toHaveAttribute("aria-selected", "true");
		const restoredDiff = restored.locator('[role="tab"]').filter({ hasText: "Diff" });
		await expect(restoredDiff, "reload restores the selected view even when the responsive preview pane is hidden").toHaveAttribute("aria-selected", "true");
		await expect(restored.locator('[role="region"][aria-label="Working tree compared with HEAD"]')).toContainText("export const working = true;");

		const nonGitRoot = mkdtempSync(join(tmpdir(), `bobbit-file-explorer-plain-${process.env.E2E_PORT ?? "0"}-`));
		write(nonGitRoot, "folder/plain.txt", "ordinary non-git file\n");
		nonGitFixture = await createFixtureProject(nonGitRoot, "plain");
		await navigateToHash(page, `#/session/${nonGitFixture.sessionId}`);
		await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers?.());
		await openFromSessionMenu(page, nonGitFixture.sessionId);
		const plainPanel = await waitForExplorer(page);
		await treeItem(page, "folder").click();
		await treeItem(page, "folder/plain.txt").click();
		await expect(plainPanel.getByRole("region", { name: "Read-only file contents" })).toContainText("ordinary non-git file");
		await expect(plainPanel.locator(".bb-explorer-badges, .bb-explorer-ancestor"), "non-Git browsing has no diff decorations").toHaveCount(0);
		await expect(plainPanel.getByRole("tab", { name: "Diff" })).toHaveCount(0);
		await expect(plainPanel).not.toContainText(/Git (status|failed|unavailable)/i);
	});
});
