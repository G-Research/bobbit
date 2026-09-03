/**
 * Browser E2E — Pack-Based Marketplace UI surface.
 * See docs/design/pack-based-marketplace.md §12.3.
 *
 * ISOLATION CONTRACT (why this spec is the shape it is):
 * The browser project runs spec FILES concurrently across 3 workers against a
 * single SHARED gateway (playwright-e2e.config.ts: workers:3, fullyParallel:
 * false). The gateway's SERVER scope (server cwd `.bobbit/config`) and
 * GLOBAL-USER scope are therefore gateway-global — a market pack installed at
 * either scope resolves for EVERY project, so its roles/tools/skills leak into
 * sibling specs running on other workers (e.g. tool-activation seeing an
 * orphan "kit-tool has no provider" warning). To stay self-isolating, every
 * install in this spec targets a DEDICATED, per-test PROJECT scope: a throwaway
 * project created via POST /api/projects with a fresh tmp rootPath. Project-
 * scope packs resolve ONLY for that projectId, which no other spec references,
 * so nothing leaks. afterEach uninstalls, deletes the temp projects + dirs, and
 * clears every registered source so no residue survives across tests/retries.
 *
 * The one assertion that genuinely needs SERVER scope — "a server-scope skill
 * pack resolves for a project whose root != the server cwd" (the serverBase
 * wiring, design finding #3) — was moved to a file:// unit test
 * (tests/pack-marketplace.test.ts → "finding #3 — server-scope skill pack
 * resolves for a non-default project root") which injects an explicit
 * serverBase. That removes the last gateway-global install from this spec
 * entirely while keeping the finding-#3 guarantee pinned.
 *
 * Pattern: mirrors tests/e2e/ui/workflow-page-scope.spec.ts (dedicated project
 * + scope tabs) and reuses config-page conventions (origin badges, scope rows).
 */
import type { Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "../ui/ui-helpers.js";

// Within-file serial is already implied by fullyParallel:false, but make it
// explicit so a failed test can never leak partial state into the next one.
test.describe.configure({ mode: "serial" });

// ---------------------------------------------------------------------------
// Local-dir source fixtures (no network/git). Each test builds a temp repo of
// pack subtrees; a directory is a pack iff it has a pack.yaml.
// ---------------------------------------------------------------------------

interface PackSpec {
	name: string;
	version?: string;
	description?: string;
	roles?: Array<{ name: string; label?: string; description?: string }>;
	tools?: Array<{ group: string; name: string; description?: string }>;
	skills?: Array<{ name: string; description?: string }>;
	/** Pack-scoped entry points: contents.entrypoints + entrypoints/<listName>.yaml. */
	entrypoints?: Array<{ listName: string; id?: string; label?: string; description?: string; panelId?: string }>;
}

let _repoCounter = 0;
const _repos: string[] = [];

function makeRepo(): string {
	const dir = join(tmpdir(), `bobbit-mkt-src-${process.pid}-${Date.now()}-${_repoCounter++}`);
	mkdirSync(dir, { recursive: true });
	_repos.push(dir);
	return dir;
}

/** Write a pack subtree into a source repo. */
function writePack(repo: string, spec: PackSpec): void {
	const packDir = join(repo, spec.name);
	mkdirSync(packDir, { recursive: true });
	const roles = (spec.roles ?? []).map((r) => r.name);
	const toolGroups = [...new Set((spec.tools ?? []).map((t) => t.group))];
	const skills = (spec.skills ?? []).map((s) => s.name);
	const entrypoints = (spec.entrypoints ?? []).map((e) => e.listName);
	writeFileSync(
		join(packDir, "pack.yaml"),
		`name: ${spec.name}\n` +
			`description: ${spec.description ?? `Pack ${spec.name}`}\n` +
			`version: ${spec.version ?? "1.0.0"}\n` +
			`contents:\n` +
			`  roles: [${roles.join(", ")}]\n` +
			`  tools: [${toolGroups.join(", ")}]\n` +
			`  skills: [${skills.join(", ")}]\n` +
			`  entrypoints: [${entrypoints.join(", ")}]\n`,
	);
	for (const r of spec.roles ?? []) {
		mkdirSync(join(packDir, "roles"), { recursive: true });
		writeFileSync(
			join(packDir, "roles", `${r.name}.yaml`),
			`name: ${r.name}\nlabel: ${r.label ?? r.name}\naccessory: none\ncreatedAt: 0\nupdatedAt: 0\n` +
				(r.description ? `description: ${r.description}\n` : "") +
				`promptTemplate: hello from ${r.name}\n`,
		);
	}
	for (const t of spec.tools ?? []) {
		mkdirSync(join(packDir, "tools", t.group), { recursive: true });
		writeFileSync(
			join(packDir, "tools", t.group, `${t.name}.yaml`),
			`name: ${t.name}\ndescription: ${t.description ?? `tool ${t.name}`}\ngroup: ${t.group}\n`,
		);
	}
	for (const s of spec.skills ?? []) {
		mkdirSync(join(packDir, "skills", s.name), { recursive: true });
		writeFileSync(
			join(packDir, "skills", s.name, "SKILL.md"),
			`---\ndescription: ${s.description ?? `skill ${s.name}`}\n---\n\n# ${s.name}\n\nbody for ${s.name}\n`,
		);
	}
	for (const e of spec.entrypoints ?? []) {
		mkdirSync(join(packDir, "entrypoints"), { recursive: true });
		writeFileSync(
			join(packDir, "entrypoints", `${e.listName}.yaml`),
			`id: ${e.id ?? `${e.listName}-id`}\n` +
				`kind: session-menu\n` +
				`label: ${e.label ?? e.listName}\n` +
				(e.description ? `description: ${e.description}\n` : "") +
				`target:\n  panelId: ${e.panelId ?? `${e.listName}-panel`}\n`,
		);
	}
}

// ---------------------------------------------------------------------------
// Per-test isolation registry. Tests run serially, so module-level arrays are
// safe; afterEach drains them.
// ---------------------------------------------------------------------------

interface DedicatedProject { id: string; name: string; dir: string; }
let _projects: DedicatedProject[] = [];
// Temp project dirs are removed in afterAll, NOT afterEach: deleting a project
// closes its search index asynchronously, and rm'ing the dir in the same tick
// races that flush (harmless ENOENT log noise). Deferring removal sidesteps it.
const _projectDirs: string[] = [];

/** Create a throwaway, fully-isolated project scope for one test. Its market
 *  packs resolve ONLY for this projectId, so installs never leak to siblings. */
async function makeDedicatedProject(label: string): Promise<DedicatedProject> {
	const dir = mkdtempSync(join(tmpdir(), `bobbit-mkt-proj-${label}-`));
	mkdirSync(join(dir, ".bobbit", "config"), { recursive: true });
	const name = `mkt-${label}-${Date.now()}-${_projects.length}`;
	const res = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath: dir, __e2e_seed_skip__: true }),
	});
	if (res.status !== 201) throw new Error(`project create failed ${res.status}: ${await res.text()}`);
	const id = (await res.json()).id as string;
	const p = { id, name, dir };
	_projects.push(p);
	_projectDirs.push(dir);
	return p;
}

test.afterEach(async () => {
	// Delete the temp projects (removes project-scope resolution from the
	// registry). Dir removal is deferred to afterAll (see _projectDirs).
	for (const p of _projects) {
		await apiFetch(`/api/projects/${p.id}`, { method: "DELETE" }).catch(() => {});
	}
	_projects = [];
	// Clear every registered source. Sources are gateway-global, but ONLY this
	// (serial) spec touches /api/marketplace/sources, so wiping them between
	// tests guarantees a clean browse panel without affecting other specs.
	try {
		const res = await apiFetch("/api/marketplace/sources");
		const body = await res.json();
		for (const s of (body.sources ?? []) as Array<{ id: string }>) {
			await apiFetch(`/api/marketplace/sources/${encodeURIComponent(s.id)}`, { method: "DELETE" }).catch(() => {});
		}
	} catch { /* ignore */ }
});

test.afterAll(() => {
	for (const d of _projectDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
	for (const r of _repos) { try { rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ } }
});

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

/** Point the in-memory active project at `projectId` so the marketplace page's
 *  installed panel + conflicts query that (dedicated) project. Waits until the
 *  project has propagated into the app's project list first. */
async function setActiveProject(page: Page, projectId: string): Promise<void> {
	// Wait (event-driven) until the project has propagated into the app's list,
	// then pin it as active and force a repaint.
	await page.waitForFunction(
		(id) => {
			const st = (window as any).__bobbitState;
			return !!st && ((st.projects ?? []) as Array<{ id: string }>).some((p) => p.id === id);
		},
		projectId,
		{ timeout: 15_000 },
	);
	await page.evaluate((id) => {
		const st = (window as any).__bobbitState;
		if (st) st.activeProjectId = id;
		(window as any).__bobbitRenderApp?.();
	}, projectId);
}

/** Switch the marketplace sub-tab and wait for its panel to render. */
async function goToTab(page: Page, tab: "installed" | "browse" | "sources"): Promise<void> {
	await expect(page.locator(`[data-testid="market-tab-${tab}"]`)).toBeVisible({ timeout: 15_000 });
	await page.locator(`[data-testid="market-tab-${tab}"]`).click();
	await expect(page.locator(`[data-testid="market-${tab}-panel"]`)).toBeVisible({ timeout: 15_000 });
}

/** Open the app, optionally pin the active project, and open the marketplace on
 *  the Sources tab (the entry point for most flows: register a source first). */
async function openMarket(page: Page, opts?: { activeProjectId?: string }): Promise<void> {
	await openApp(page);
	if (opts?.activeProjectId) await setActiveProject(page, opts.activeProjectId);
	await navigateToHash(page, "#/market");
	await goToTab(page, "sources");
}

/** Re-establish the marketplace surface after a reload (state is reset). */
async function reopenMarketAfterReload(page: Page, projectId: string): Promise<void> {
	await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
	await setActiveProject(page, projectId);
	// Land on a NON-market route first so the subsequent navigation to #/market
	// is a genuine hashchange (setting window.location.hash to the value it
	// already holds is a no-op and would NOT re-trigger loadMarketplaceData with
	// the freshly-pinned active project — leaving the Installed list empty).
	await navigateToHash(page, "#/roles");
	await navigateToHash(page, "#/market");
	await goToTab(page, "sources");
}

/** Register a local-dir source by absolute path; resolves only once its packs
 *  are actually browsable (poll for at least one pack card). */
async function registerSource(page: Page, repoPath: string): Promise<void> {
	// Must be on the Sources tab (where the add-source form lives).
	const urlInput = page.locator('[data-testid="market-source-url"]');
	const addSourceBtn = page.locator('[data-testid="market-add-source"]');
	// fill() dispatches the input event, but the Add button is disabled
	// (?disabled=${!newSourceUrl.trim()}) until the component re-renders. Under
	// load that render can lag a naive click, leaving the button disabled → click
	// timeout. Synchronize on the real precondition (button enabled) instead of
	// clicking optimistically.
	await urlInput.fill(repoPath);
	await expect(urlInput).toHaveValue(repoPath);
	await expect(addSourceBtn).toBeEnabled({ timeout: 15_000 });
	await addSourceBtn.click();
	// Source actions stay on Sources; switch explicitly to Browse and poll until
	// union-browse pack cards render (browse refresh is async after the POST).
	await expect(page.locator('[data-testid="market-sources-panel"]')).toBeVisible({ timeout: 15_000 });
	await goToTab(page, "browse");
	await expect
		.poll(async () => page.locator('[data-testid="market-browse-pack"]').count(), { timeout: 15_000 })
		.toBeGreaterThan(0);
}

/** Pick a dedicated project in the install scope picker (Browse tab). */
async function selectInstallScopeProject(page: Page, projectId: string): Promise<void> {
	await page.locator('[data-testid="market-install-scope"]').selectOption(`project:${projectId}`);
}

/** On a config page (Roles/Tools/Skills), switch the scope row to a project. */
async function selectConfigProjectScope(page: Page, container: string, projectName: string): Promise<void> {
	const tab = page.locator(`${container} button`).filter({ hasText: projectName }).first();
	await expect(tab).toBeVisible({ timeout: 15_000 });
	await tab.click();
}

/** Ordinal of the named config-nav button within the expanded sidebar's nav row. */
async function navButtonOrder(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const sidebar = document.querySelector('[data-testid="sidebar-expanded"]');
		if (!sidebar) return [];
		const buttons = Array.from(sidebar.querySelectorAll<HTMLButtonElement>("button"));
		return buttons
			.map((b) => (b.textContent || "").trim())
			.filter((t) => ["Roles", "Tools", "Skills", "Workflows", "Market", "New Goal"].includes(t));
	});
}

async function openBrowseSourcesMenu(page: Page): Promise<void> {
	const trigger = page.locator('[data-testid="market-source-menu-trigger"]');
	await expect(trigger).toBeVisible({ timeout: 15_000 });
	await trigger.click();
	await expect(trigger).toHaveAttribute("aria-expanded", "true");
	await expect(page.locator('[data-testid="market-source-menu"]')).toBeVisible({ timeout: 15_000 });
}

test.describe("Marketplace UI", () => {
	/**
	 * Consolidation map (15 cases -> 4 step-labelled journeys):
	 *
	 * 1. Shell/accessibility keeps nav order, banner, tabs/panels, graceful forms,
	 *    source warnings, unsupported-source disabling, bulk actions, and keyboard
	 *    semantics.
	 * 2. Source discovery keeps trust disclosure/reload, real source REST, browse
	 *    cards/chips/descriptions, source/search filtering, selection persistence,
	 *    counts, empty states, and keyboard dismissal.
	 * 3. Project install lifecycle keeps non-active project targeting, install,
	 *    provenance/read-only UI, runtime role/tool/skill resolution, reload,
	 *    browse project identity, version detection/update, and exact uninstall.
	 * 4. Conflict lifecycle keeps two-pack conflict/reorder REST and reload order,
	 *    then removes the source to retain the orphan/source-not-found boundary.
	 *
	 * No assertion moved to another tier. Each mutable install remains confined to
	 * a dedicated project, and afterEach remains the failure-path cleanup owner.
	 */
	test("marketplace shell, tabs, forms, and source-status accessibility journey @smoke", async ({ page }) => {
		await test.step("Market nav opens the shell in documented order with banner and tabs", async () => {
			await openApp(page);

			const marketBtn = page.locator('[data-testid="market-nav-button"]').first();
			await expect(marketBtn).toBeVisible({ timeout: 20_000 });

			const order = await navButtonOrder(page);
			const wf = order.indexOf("Workflows");
			const mk = order.indexOf("Market");
			const ng = order.indexOf("New Goal");
			expect(wf).toBeGreaterThanOrEqual(0);
			expect(mk).toBeGreaterThan(wf);
			expect(ng).toBeGreaterThan(mk);

			await marketBtn.click();
			await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/market");
			const previewBanner = page.locator('[data-testid="market-research-preview-banner"]');
			await expect(previewBanner).toBeVisible({ timeout: 10_000 });
			await expect(previewBanner).toContainText("Research Preview");
			await expect(previewBanner).toContainText("The extension API is still subject to change");
			await expect(previewBanner).toContainText("Bobbit extensions may need to be re-written against the final extension API in the next release.");

			await expect(page.locator('[data-testid="market-tab-installed"]')).toBeVisible({ timeout: 10_000 });
			await expect(page.locator('[data-testid="market-tab-browse"]')).toBeVisible();
			await expect(page.locator('[data-testid="market-tab-sources"]')).toBeVisible();
			await expect(page.locator('[data-testid="market-installed-panel"]')).toBeVisible();
			await goToTab(page, "browse");
			await goToTab(page, "sources");
		});

		await test.step("graceful source and install forms stay available without marketplace data", async () => {
			await expect(page.locator('[data-testid="market-source-url"]')).toBeVisible();
			await expect(page.locator('[data-testid="market-add-source"]')).toBeVisible();
			await goToTab(page, "browse");
			await expect(page.locator('[data-testid="market-install-scope"]')).toBeVisible();
		});

		await test.step("source menu exposes error warnings and disables unsupported sources", async () => {
			const pack = (sourceId: string, sourceName: string, name: string) => ({
				name,
				dirName: name,
				description: `${sourceName} demo pack`,
				version: "1.0.0",
				hasTools: false,
				browseKey: `${sourceId}:${name}`,
				source: { id: sourceId, name: sourceName, type: "pack" },
				contents: { roles: [], tools: [], skills: [], entrypoints: [] },
			});
			await page.route(/\/api\/marketplace\/browse(?:\?.*)?$/, async (route) => {
				if (route.request().method() !== "GET") return route.fallback();
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						sources: [
							{ sourceId: "ok-src", sourceName: "Ready source", sourceType: "pack", status: "ok" },
							{ sourceId: "err-src", sourceName: "Errored source", sourceType: "pack", status: "error", error: "Index failed" },
							{ sourceId: "unsupported-src", sourceName: "Unsupported source", sourceType: "pack", status: "unsupported", error: "Unsupported source type" },
						],
						packs: [pack("ok-src", "Ready source", "ready-pack"), pack("err-src", "Errored source", "errored-pack")],
					}),
				});
			});

			await navigateToHash(page, "#/roles");
			await navigateToHash(page, "#/market");
			await goToTab(page, "browse");

			await expect(page.locator('[data-testid="market-source-summary"]')).toContainText("Showing 2 packages from 2 sources", { timeout: 15_000 });
			await expect(page.locator('[data-testid="market-browse-source-warnings"]')).toContainText("Errored source", { timeout: 15_000 });
			await openBrowseSourcesMenu(page);

			const errored = page.locator('[data-testid="market-source-option"][data-source-id="err-src"]');
			await expect(errored.locator('[data-testid="market-source-checkbox"]')).toBeChecked();
			await expect(errored.locator('[data-testid="market-source-status"]')).toContainText(/error|warning|failed/i);
			const unsupported = page.locator('[data-testid="market-source-option"][data-source-id="unsupported-src"]');
			await expect(unsupported.locator('[data-testid="market-source-checkbox"]')).toBeDisabled();
			await expect(unsupported.locator('[data-testid="market-source-checkbox"]')).not.toBeChecked();
			await expect(unsupported.locator('[data-testid="market-source-status"]')).toContainText(/unsupported/i);

			await page.locator('[data-testid="market-source-clear"]').click();
			await expect(page.locator('[data-testid="market-browse-source-warnings"]')).toHaveCount(0);
			await page.locator('[data-testid="market-source-select-all"]').click();
			await expect(errored.locator('[data-testid="market-source-checkbox"]')).toBeChecked();
			await expect(unsupported.locator('[data-testid="market-source-checkbox"]')).not.toBeChecked();
			await expect(page.locator('[data-testid="market-browse-source-warnings"]')).toContainText("Errored source", { timeout: 15_000 });
		});
	});

	test("trusted local sources browse, describe, filter, and persist UI state journey", async ({ page }) => {
		const repoA = makeRepo();
		const repoB = makeRepo();
		writePack(repoA, {
			name: "alpha-pack",
			description: "Alpha source demo pack",
			roles: [{ name: "alpha-role", description: "browse role desc" }],
			tools: [{ group: "alphagroup", name: "alpha-tool", description: "browse tool desc" }],
			skills: [{ name: "alpha-skill", description: "browse skill desc" }],
			entrypoints: [{ listName: "alpha-ep", label: "Alpha EP", description: "browse entry point desc" }],
		});
		writePack(repoB, { name: "beta-pack", description: "Beta source demo pack", roles: [{ name: "beta-role" }] });

		await test.step("source trust warning discloses each executable entity risk", async () => {
			await openMarket(page);
			const warning = page.locator('[data-testid="market-trust-warning"]');
			await expect(warning).toBeVisible({ timeout: 15_000 });
			await expect(warning).toContainText(/only add sources you trust/i);

			const why = page.locator('[data-testid="market-trust-why"]');
			await expect(why).toBeVisible();
			await expect(why).not.toHaveAttribute("open", /.*/);
			const body = why.locator(".market-trust-why-body");
			await expect(body).toBeHidden();
			await why.locator("summary").click();
			await expect(why).toHaveAttribute("open", /.*/);
			await expect(body).toBeVisible();
			await expect(body).toContainText(/Tools/);
			await expect(body).toContainText(/Skills/);
			await expect(body).toContainText(/Roles/);
			await expect(body).toContainText(/runs directly in the Bobbit server process/i);
		});

		await test.step("real source REST registers both repositories and renders pack metadata", async () => {
			await registerSource(page, repoA);
			const alphaCard = page.locator('[data-testid="market-browse-pack"][data-pack-name="alpha-pack"]');
			await expect(alphaCard).toBeVisible({ timeout: 15_000 });
			await expect(alphaCard).toContainText("Alpha source demo pack");
			await expect.poll(async () => alphaCard.locator(".market-entity-chip").count(), { timeout: 15_000 }).toBe(3);

			await goToTab(page, "sources");
			await expect(page.locator('[data-testid="market-source-row"]').first()).toBeVisible();
			await registerSource(page, repoB);
		});

		await test.step("uninstalled browse disclosure retains role, tool, skill, and entrypoint descriptions", async () => {
			const card = page.locator('[data-testid="market-browse-pack"][data-pack-name="alpha-pack"]');
			await expect(card.locator('[data-testid="market-install-pack"]')).toBeVisible();
			const details = card.locator('[data-testid="market-entity-details-alpha-pack"]');
			await expect(details).toBeVisible({ timeout: 15_000 });
			await details.locator("summary").click();
			await expect(card.locator('[data-testid="market-entity-desc-entrypoint-alpha-ep"]')).toContainText("browse entry point desc");
			await expect(card.locator('[data-testid="market-entity-desc-role-alpha-role"]')).toContainText("browse role desc");
			await expect(card.locator('[data-testid="market-entity-desc-tool-alphagroup"]')).toContainText("browse tool desc");
			await expect(card.locator('[data-testid="market-entity-desc-skill-alpha-skill"]')).toContainText("browse skill desc");
		});

		await test.step("checkbox and search filters retain counts, empty states, and tab re-render selection", async () => {
			const trigger = page.locator('[data-testid="market-source-menu-trigger"]');
			const summary = page.locator('[data-testid="market-source-summary"]');
			await expect(page.locator('[data-testid="market-browse-controls"]')).toBeVisible({ timeout: 15_000 });
			await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
			await expect(trigger).toHaveAttribute("aria-expanded", "false");
			await expect(summary).toContainText("Showing 6 packages from 3 sources");
			await openBrowseSourcesMenu(page);
			const menu = page.locator('[data-testid="market-source-menu"]');
			const sourceOptions = page.locator('[data-testid="market-source-option"]');
			const sourceCheckboxes = page.locator('[data-testid="market-source-checkbox"]');
			const fixtureOptions = sourceOptions.filter({ hasText: "1 package" });
			await expect(menu).toHaveAttribute("role", "dialog");
			await expect(sourceOptions).toHaveCount(3);
			await expect(page.locator('[data-testid="market-source-count"]')).toHaveCount(3);
			await expect(page.locator('[data-testid="market-source-count"]').filter({ hasText: "1 package" })).toHaveCount(2);
			await expect(page.locator('[data-testid="market-source-count"]').filter({ hasText: "4 packages" })).toHaveCount(1);
			await expect(sourceCheckboxes).toHaveCount(3);
			await expect.poll(async () => page.locator('[data-testid="market-source-checkbox"]:checked').count(), { timeout: 10_000 }).toBe(3);

			await page.locator('[data-testid="market-source-clear"]').click();
			await expect(menu).toBeVisible();
			await expect(summary).toContainText("No sources selected");
			await expect.poll(async () => page.locator('[data-testid="market-source-checkbox"]:checked').count(), { timeout: 10_000 }).toBe(0);
			await expect(page.locator('[data-testid="market-browse-pack"]')).toHaveCount(0);
			await expect(page.getByText("No sources selected. Open Sources and select at least one source to browse packages.")).toBeVisible();

			await fixtureOptions.nth(1).locator('[data-testid="market-source-checkbox"]').click();
			await expect(menu).toBeVisible();
			await expect(page.locator('[data-testid="market-browse-pack"]')).toHaveCount(1);
			await expect(summary).toContainText("Showing 1 package from 1 source");
			await expect(page.locator('[data-testid="market-browse-pack"][data-pack-name="alpha-pack"]')).toHaveCount(0);
			await expect(page.locator('[data-testid="market-browse-pack"][data-pack-name="beta-pack"]')).toBeVisible();

			await page.locator('[data-testid="market-browse-search"]').fill("beta");
			await expect(summary).toContainText("Showing 1 package from 1 source");
			await expect(page.locator('[data-testid="market-browse-pack"][data-pack-name="beta-pack"]')).toBeVisible();
			await page.locator('[data-testid="market-browse-search"]').fill("alpha");
			await expect(summary).toContainText("No packages match the current filters");
			await expect(page.locator('[data-testid="market-browse-pack"]')).toHaveCount(0);
			await expect(page.getByText(/No packages match “alpha” in the selected sources\./)).toBeVisible();
			await page.locator('[data-testid="market-browse-search-clear"]').click();

			await goToTab(page, "sources");
			await goToTab(page, "browse");
			await openBrowseSourcesMenu(page);
			await expect(fixtureOptions.nth(0).locator('[data-testid="market-source-checkbox"]')).not.toBeChecked();
			await expect(fixtureOptions.nth(1).locator('[data-testid="market-source-checkbox"]')).toBeChecked();
			await expect(summary).toContainText("Showing 1 package from 1 source");

			await page.locator('[data-testid="market-source-select-all"]').click();
			await expect(menu).toBeVisible();
			await expect.poll(async () => page.locator('[data-testid="market-source-checkbox"]:checked').count(), { timeout: 10_000 }).toBe(3);
			await expect(page.locator('[data-testid="market-browse-pack"]')).toHaveCount(6);
			await expect(summary).toContainText("Showing 6 packages from 3 sources");
		});

		await test.step("source filter dialog retains Escape, Enter, Space, and outside-click accessibility", async () => {
			const trigger = page.locator('[data-testid="market-source-menu-trigger"]');
			const menu = page.locator('[data-testid="market-source-menu"]');
			await page.keyboard.press("Escape");
			await expect(trigger).toHaveAttribute("aria-expanded", "false");
			await expect(menu).toBeHidden();
			await trigger.focus();
			await page.keyboard.press("Enter");
			await expect(trigger).toHaveAttribute("aria-expanded", "true");
			await page.keyboard.press("Escape");
			await expect(trigger).toHaveAttribute("aria-expanded", "false");
			await page.keyboard.press("Space");
			await expect(trigger).toHaveAttribute("aria-expanded", "true");
			await page.locator('[data-testid="market-browse-panel"] h2').click();
			await expect(trigger).toHaveAttribute("aria-expanded", "false");
		});

		await test.step("source trust warning survives a full page reload", async () => {
			await page.reload();
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, "#/market");
			await goToTab(page, "sources");
			await expect(page.locator('[data-testid="market-trust-warning"]')).toBeVisible({ timeout: 15_000 });
		});
	});

	test("project-scoped pack install, runtime, reload, update, and uninstall journey", async ({ page }) => {
		const repo = makeRepo();
		const writeKit = (version: string) => writePack(repo, {
			name: "kit-pack",
			version,
			description: "Roles, tools and skills kit",
			roles: [{ name: "kit-role", label: "Kit Role", description: "a polished role" }],
			tools: [{ group: "kitgroup", name: "kit-tool", description: "a polished tool" }],
			skills: [{ name: "kit-skill", description: "a polished skill" }],
			entrypoints: [{ listName: "kit-ep", label: "Kit EP", description: "a polished entry point" }],
		});
		writeKit("1.0.0");
		const projActive = await makeDedicatedProject("active");
		const projTarget = await makeDedicatedProject("target");
		const pid = encodeURIComponent(projTarget.id);

		await test.step("install targets a non-active dedicated project and browse reflects project identity", async () => {
			await openMarket(page, { activeProjectId: projActive.id });
			await registerSource(page, repo);
			await selectInstallScopeProject(page, projTarget.id);
			const browseCard = page.locator('[data-testid="market-browse-pack"][data-pack-name="kit-pack"]');
			await browseCard.locator('[data-testid="market-install-pack"]').click();

			await expect(browseCard.locator('[data-testid="market-browse-installed"]')).toBeVisible({ timeout: 15_000 });
			await expect(browseCard.locator('[data-testid="market-install-pack"]')).toHaveCount(0);

			await selectInstallScopeProject(page, projActive.id);
			await expect(browseCard.locator('[data-testid="market-install-pack"]')).toBeVisible({ timeout: 15_000 });
			await expect(browseCard.locator('[data-testid="market-browse-installed"]')).toHaveCount(0);
			await expect(browseCard.locator('[data-testid="market-browse-update-pack"]')).toHaveCount(0);
			await selectInstallScopeProject(page, projTarget.id);
		});

		await test.step("installed card preserves provenance, descriptions, and up-to-date controls", async () => {
			await goToTab(page, "installed");
			const card = page.locator('[data-testid="market-installed-pack"][data-pack-name="kit-pack"]').first();
			await expect(card).toBeVisible({ timeout: 15_000 });
			await expect(card.locator('[data-testid="market-provenance"]')).toBeVisible();
			await expect(card).toContainText("v1.0.0");
			await expect(card.locator('[data-testid="market-update-pack"]')).toHaveCount(0);
			await expect(page.locator('[data-testid="market-activation-help"]')).toHaveCount(0);
			await expect(card.locator('[data-testid="market-uninstall-pack"]')).toBeVisible();

			const details = card.locator('[data-testid="market-entity-details-kit-pack"]');
			await expect(details).toBeVisible({ timeout: 15_000 });
			await details.locator("summary").click();
			await expect(card.locator('[data-testid="market-entity-desc-entrypoint-kit-ep"]')).toBeVisible();
			await expect(card.locator('[data-testid="market-entity-desc-entrypoint-kit-ep"]')).toContainText("a polished entry point");
			await expect(card.locator('[data-testid="market-entity-desc-role-kit-role"]')).toContainText("a polished role");
			await expect(card.locator('[data-testid="market-entity-desc-tool-kit-tool"]')).toContainText("a polished tool");
			await expect(card.locator('[data-testid="market-entity-desc-skill-kit-skill"]')).toContainText("a polished skill");
		});

		await test.step("project config UI and REST runtime resolve every installed entity as pack-owned", async () => {
			await navigateToHash(page, "#/roles");
			await selectConfigProjectScope(page, ".roles-container", projTarget.name);
			const roleRow = page.locator(".role-row").filter({ hasText: "kit-role" });
			await expect(roleRow).toBeVisible({ timeout: 15_000 });
			await expect(roleRow.locator('[data-testid="origin-pack-chip"]')).toHaveText("kit-pack");
			await roleRow.click();
			await expect(page.locator('[data-testid="market-readonly-note"]')).toBeVisible({ timeout: 10_000 });
			await expect(page.locator(".config-action-btn")).toHaveCount(0);

			await navigateToHash(page, "#/tools/kit-tool");
			await expect(page.locator('[data-testid="market-readonly-note"]')).toBeVisible({ timeout: 15_000 });
			await expect(page.locator('[data-testid="origin-pack-chip"]').first()).toHaveText("kit-pack");
			await expect(page.locator(".config-action-btn")).toHaveCount(0);

			const detailRes = await apiFetch(`/api/tools/kit-tool?projectId=${pid}`);
			expect(detailRes.status).toBe(200);
			const detail = await detailRes.json() as { name: string; origin?: string; originPackId?: string | null; originPackName?: string | null };
			expect(detail.name).toBe("kit-tool");
			expect(detail.origin).toBe("project");
			expect(detail.originPackName).toBe("kit-pack");
			expect(detail.originPackId).toBeTruthy();

			const toolsRes = await apiFetch(`/api/tools?projectId=${pid}`);
			const tools = (await toolsRes.json()).tools as Array<{ name: string; originPackName?: string | null }>;
			expect(tools.find((tool) => tool.name === "kit-tool")?.originPackName).toBe("kit-pack");
			const skillsRes = await apiFetch(`/api/slash-skills/details?projectId=${pid}`);
			const skills = (await skillsRes.json()).skills as Array<{ name: string; originPackName?: string | null }>;
			expect(skills.find((skill) => skill.name === "kit-skill")?.originPackName).toBe("kit-pack");
		});

		await test.step("project-scoped install and provenance persist across reload", async () => {
			await page.reload();
			await reopenMarketAfterReload(page, projTarget.id);
			await goToTab(page, "installed");
			const card = page.locator('[data-testid="market-installed-pack"][data-pack-name="kit-pack"]').first();
			await expect(card).toBeVisible({ timeout: 15_000 });
			await expect(card.locator('[data-testid="market-provenance"]')).toBeVisible();
		});

		await test.step("source version bump offers Browse and Installed updates and re-syncs to v2", async () => {
			writeKit("2.0.0");
			await page.reload();
			await reopenMarketAfterReload(page, projTarget.id);
			await goToTab(page, "browse");
			await selectInstallScopeProject(page, projTarget.id);
			const browseCard = page.locator('[data-testid="market-browse-pack"][data-pack-name="kit-pack"]');
			await expect(browseCard.locator('[data-testid="market-browse-update-pack"]')).toBeVisible({ timeout: 15_000 });
			await expect(browseCard.locator('[data-testid="market-install-pack"]')).toHaveCount(0);

			await goToTab(page, "installed");
			const installed = page.locator('[data-testid="market-installed-pack"][data-pack-name="kit-pack"]').first();
			await expect(installed.locator('[data-testid="market-update-pack"]')).toBeVisible({ timeout: 15_000 });
			await installed.locator('[data-testid="market-update-pack"]').click();
			await expect(page.locator('[data-testid="market-installed-pack"][data-pack-name="kit-pack"]').first()).toContainText("v2.0.0", { timeout: 15_000 });

			await navigateToHash(page, "#/roles");
			await selectConfigProjectScope(page, ".roles-container", projTarget.name);
			await expect(page.locator(".role-row").filter({ hasText: "kit-role" })).toBeVisible({ timeout: 15_000 });
			await navigateToHash(page, "#/market");
			await goToTab(page, "installed");
		});

		await test.step("uninstall targets the install project and removes card, role, detail, and list entries", async () => {
			await page.locator('[data-testid="market-installed-pack"][data-pack-name="kit-pack"]').first()
				.locator('[data-testid="market-uninstall-pack"]').click();
			await expect(page.getByText(/deletes the pack directory/i)).toBeVisible({ timeout: 10_000 });
			await page.keyboard.press("Enter");
			await expect(page.locator('[data-testid="market-installed-pack"][data-pack-name="kit-pack"]')).toHaveCount(0, { timeout: 15_000 });

			await navigateToHash(page, "#/roles");
			await selectConfigProjectScope(page, ".roles-container", projTarget.name);
			await expect(page.locator(".role-row").filter({ hasText: "kit-role" })).toHaveCount(0, { timeout: 15_000 });

			const after = await apiFetch(`/api/tools/kit-tool?projectId=${pid}`);
			expect(after.status).toBe(404);
			const listAfter = await apiFetch(`/api/tools?projectId=${pid}`);
			const toolsAfter = (await listAfter.json()).tools as Array<{ name: string }>;
			expect(toolsAfter.find((tool) => tool.name === "kit-tool")).toBeFalsy();
		});
	});

	test("project conflict reorder, reload, and missing-source lifecycle journey", async ({ page }) => {
		const repo = makeRepo();
		writePack(repo, { name: "conf-a", roles: [{ name: "shared-role", label: "From A" }] });
		writePack(repo, { name: "conf-b", roles: [{ name: "shared-role", label: "From B" }] });
		const proj = await makeDedicatedProject("conf");
		const pid = encodeURIComponent(proj.id);

		await test.step("two project packs install from one source and expose their conflict", async () => {
			await openMarket(page, { activeProjectId: proj.id });
			await registerSource(page, repo);
			await selectInstallScopeProject(page, proj.id);
			await page.locator('[data-testid="market-browse-pack"][data-pack-name="conf-a"]').locator('[data-testid="market-install-pack"]').click();
			await goToTab(page, "installed");
			await expect(page.locator('[data-testid="market-installed-pack"][data-pack-name="conf-a"]').first()).toBeVisible({ timeout: 15_000 });
			await goToTab(page, "browse");
			await page.locator('[data-testid="market-browse-pack"][data-pack-name="conf-b"]').locator('[data-testid="market-install-pack"]').click();
			await goToTab(page, "installed");
			await expect(page.locator('[data-testid="market-installed-pack"][data-pack-name="conf-b"]').first()).toBeVisible({ timeout: 15_000 });
			await expect(page.locator('[data-testid="market-conflict-warning"]').first()).toBeVisible({ timeout: 15_000 });
		});

		await test.step("project pack-order request flips the role winner", async () => {
			await navigateToHash(page, "#/roles");
			await selectConfigProjectScope(page, ".roles-container", proj.name);
			const roleRow = page.locator(".role-row").filter({ hasText: "shared-role" });
			await expect(roleRow.locator('[data-testid="origin-pack-chip"]')).toHaveText("conf-b", { timeout: 15_000 });

			await navigateToHash(page, "#/market");
			await goToTab(page, "installed");
			await page.locator('[data-testid="market-installed-pack"][data-pack-name="conf-a"]').first()
				.locator('[data-testid="market-move-down"]').click();

			await navigateToHash(page, "#/roles");
			await selectConfigProjectScope(page, ".roles-container", proj.name);
			await expect(page.locator(".role-row").filter({ hasText: "shared-role" }).locator('[data-testid="origin-pack-chip"]')).toHaveText("conf-a", { timeout: 15_000 });
		});

		await test.step("winner and installed card order persist across reload and agree with REST", async () => {
			await page.reload();
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, "#/roles");
			await selectConfigProjectScope(page, ".roles-container", proj.name);
			await expect(page.locator(".role-row").filter({ hasText: "shared-role" }).locator('[data-testid="origin-pack-chip"]')).toHaveText("conf-a", { timeout: 15_000 });

			await setActiveProject(page, proj.id);
			await navigateToHash(page, "#/market");
			await goToTab(page, "installed");
			await expect(page.locator('[data-testid="market-installed-pack"][data-pack-name="conf-a"]').first()).toBeVisible({ timeout: 15_000 });
			const cardOrder = await page.evaluate(() =>
				Array.from(document.querySelectorAll('[data-testid="market-installed-pack"]'))
					.map((el) => el.getAttribute("data-pack-name"))
					.filter((name): name is string => name === "conf-a" || name === "conf-b"),
			);
			expect(cardOrder).toEqual(["conf-b", "conf-a"]);

			const orderRes = await apiFetch(`/api/marketplace/pack-order?scope=project&projectId=${pid}`);
			const order = ((await orderRes.json()).order as string[]).filter((name) => name === "conf-a" || name === "conf-b");
			expect(order).toEqual(["conf-b", "conf-a"]);
		});

		await test.step("removing the source leaves installed packs manageable but not updateable", async () => {
			const srcRes = await apiFetch("/api/marketplace/sources");
			for (const source of ((await srcRes.json()).sources ?? []) as Array<{ id: string }>) {
				await apiFetch(`/api/marketplace/sources/${encodeURIComponent(source.id)}`, { method: "DELETE" });
			}

			await page.reload();
			await reopenMarketAfterReload(page, proj.id);
			await goToTab(page, "installed");
			for (const packName of ["conf-a", "conf-b"]) {
				const card = page.locator(`[data-testid="market-installed-pack"][data-pack-name="${packName}"]`).first();
				await expect(card).toBeVisible({ timeout: 15_000 });
				await expect(card.locator('[data-testid="market-source-unknown"]')).toBeVisible();
				await expect(card.locator('[data-testid="market-update-pack"]')).toHaveCount(0);
				await expect(card.locator('[data-testid="market-uninstall-pack"]')).toBeVisible();
			}
		});
	});
});
