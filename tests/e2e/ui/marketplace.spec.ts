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
import { openApp, navigateToHash } from "./ui-helpers.js";

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
	roles?: Array<{ name: string; label?: string }>;
	tools?: Array<{ group: string; name: string }>;
	skills?: Array<{ name: string }>;
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
	writeFileSync(
		join(packDir, "pack.yaml"),
		`name: ${spec.name}\n` +
			`description: ${spec.description ?? `Pack ${spec.name}`}\n` +
			`version: ${spec.version ?? "1.0.0"}\n` +
			`contents:\n` +
			`  roles: [${roles.join(", ")}]\n` +
			`  tools: [${toolGroups.join(", ")}]\n` +
			`  skills: [${skills.join(", ")}]\n`,
	);
	for (const r of spec.roles ?? []) {
		mkdirSync(join(packDir, "roles"), { recursive: true });
		writeFileSync(
			join(packDir, "roles", `${r.name}.yaml`),
			`name: ${r.name}\nlabel: ${r.label ?? r.name}\naccessory: none\ncreatedAt: 0\nupdatedAt: 0\npromptTemplate: hello from ${r.name}\n`,
		);
	}
	for (const t of spec.tools ?? []) {
		mkdirSync(join(packDir, "tools", t.group), { recursive: true });
		writeFileSync(
			join(packDir, "tools", t.group, `${t.name}.yaml`),
			`name: ${t.name}\ndescription: tool ${t.name}\ngroup: ${t.group}\n`,
		);
	}
	for (const s of spec.skills ?? []) {
		mkdirSync(join(packDir, "skills", s.name), { recursive: true });
		writeFileSync(
			join(packDir, "skills", s.name, "SKILL.md"),
			`---\ndescription: skill ${s.name}\n---\n\n# ${s.name}\n\nbody for ${s.name}\n`,
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

/** Open the app, optionally pin the active project, and open the marketplace. */
async function openMarket(page: Page, opts?: { activeProjectId?: string }): Promise<void> {
	await openApp(page);
	if (opts?.activeProjectId) await setActiveProject(page, opts.activeProjectId);
	await navigateToHash(page, "#/market");
	await expect(page.locator('[data-testid="market-sources-panel"]')).toBeVisible({ timeout: 15_000 });
}

/** Re-establish the marketplace surface after a reload (state is reset). */
async function reopenMarketAfterReload(page: Page, projectId: string): Promise<void> {
	await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
	await setActiveProject(page, projectId);
	await navigateToHash(page, "#/market");
	await expect(page.locator('[data-testid="market-sources-panel"]')).toBeVisible({ timeout: 15_000 });
}

/** Register a local-dir source by absolute path; resolves only once its packs
 *  are actually browsable (poll for at least one pack card). */
async function registerSource(page: Page, repoPath: string): Promise<void> {
	await page.locator('[data-testid="market-source-url"]').fill(repoPath);
	await page.locator('[data-testid="market-add-source"]').click();
	// The source row must appear...
	await expect(page.locator('[data-testid="market-source-row"]').first()).toBeVisible({ timeout: 15_000 });
	// ...and handleAddSource auto-browses it → poll until the pack cards render
	// (browse is async after the POST; a single visibility check can race it).
	await expect
		.poll(async () => page.locator('[data-testid="market-browse-pack"]').count(), { timeout: 15_000 })
		.toBeGreaterThan(0);
}

/** Pick a dedicated project in the install scope picker. */
async function selectInstallScopeProject(page: Page, projectId: string): Promise<void> {
	await page.locator('[data-testid="market-install-scope"]').selectOption(`project:${projectId}`);
}

/** On a config page (Roles/Tools/Skills), switch the scope row to a project. */
async function selectConfigProjectScope(page: Page, container: string, projectName: string): Promise<void> {
	const tab = page.locator(`${container} button`).filter({ hasText: projectName }).first();
	await expect(tab).toBeVisible({ timeout: 15_000 });
	await tab.click();
}

/** Confirm the "installs executable code" dialog. */
async function confirmExecWarning(page: Page): Promise<void> {
	await expect(page.getByText(/installs executable code that runs on your machine/i)).toBeVisible({ timeout: 10_000 });
	await page.getByRole("button", { name: "Install anyway" }).click();
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

test.describe("Marketplace UI", () => {
	// ------------------------------------------------------------------
	// §12.3 #1 — Market button visible & positioned between Workflows and
	// New Goal; opens the marketplace surface. (UI shell — no install.)
	// ------------------------------------------------------------------
	test("Market button is between Workflows and New Goal and opens the surface @smoke", async ({ page }) => {
		await openApp(page);

		const marketBtn = page.locator('[data-testid="market-nav-button"]').first();
		await expect(marketBtn).toBeVisible({ timeout: 20_000 });

		// Position: Market appears after Workflows and before New Goal.
		const order = await navButtonOrder(page);
		const wf = order.indexOf("Workflows");
		const mk = order.indexOf("Market");
		const ng = order.indexOf("New Goal");
		expect(wf).toBeGreaterThanOrEqual(0);
		expect(mk).toBeGreaterThan(wf);
		expect(ng).toBeGreaterThan(mk);

		// Opening navigates to #/market and renders the marketplace panels.
		await marketBtn.click();
		await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/market");
		await expect(page.locator('[data-testid="market-sources-panel"]')).toBeVisible({ timeout: 10_000 });
		await expect(page.locator('[data-testid="market-browse-panel"]')).toBeVisible();
		await expect(page.locator('[data-testid="market-installed-panel"]')).toBeVisible();
	});

	// ------------------------------------------------------------------
	// Graceful degradation — even if the REST endpoints are absent/erroring,
	// the surface renders the add-source form (so it is testable pre-REST).
	// ------------------------------------------------------------------
	test("marketplace renders the add-source form and degrades gracefully", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/market");
		await expect(page.locator('[data-testid="market-sources-panel"]')).toBeVisible({ timeout: 10_000 });
		await expect(page.locator('[data-testid="market-source-url"]')).toBeVisible();
		await expect(page.locator('[data-testid="market-add-source"]')).toBeVisible();
		// Install scope picker present with the three documented scope options.
		const scope = page.locator('[data-testid="market-install-scope"]');
		await expect(scope).toBeVisible();
	});

	// ==================================================================
	// LIVE-REST TESTS — drive the §12.3 acceptance flow against the real
	// /api/marketplace/* endpoints using a local-dir source fixture. Every
	// install targets a DEDICATED PROJECT scope (see ISOLATION CONTRACT).
	// ==================================================================

	// §12.3 #2–3 — register a source and browse its packs (deterministic; no
	// install, so no scope needed).
	test("register a local-dir source and browse its packs", async ({ page }) => {
		const repo = makeRepo();
		writePack(repo, { name: "browse-pack", description: "Browseable demo pack", roles: [{ name: "browse-role" }], skills: [{ name: "browse-skill" }] });

		await openMarket(page);
		await registerSource(page, repo);

		await expect(page.locator('[data-testid="market-source-row"]').first()).toBeVisible();
		const card = page.locator('[data-testid="market-browse-pack"][data-pack-name="browse-pack"]');
		await expect(card).toBeVisible({ timeout: 15_000 });
		await expect(card).toContainText("Browseable demo pack");
		// Declared entity chips render (role + skill) — poll so we don't race the
		// async browse render.
		await expect.poll(async () => card.locator(".market-entity-chip").count(), { timeout: 15_000 }).toBe(2);
	});

	// §12.3 #4–6 — install to a scope; entities resolve on the config pages
	// tagged with the specific pack (originPackName chip); persist across reload;
	// provenance shown. Installed at a DEDICATED PROJECT scope for isolation.
	test("install a pack → entities resolve with pack origin chip + persist + provenance", async ({ page }) => {
		const repo = makeRepo();
		writePack(repo, {
			name: "kit-pack",
			description: "Roles, tools and skills kit",
			roles: [{ name: "kit-role", label: "Kit Role" }],
			tools: [{ group: "kitgroup", name: "kit-tool" }],
			skills: [{ name: "kit-skill" }],
		});
		const proj = await makeDedicatedProject("kit");

		await openMarket(page, { activeProjectId: proj.id });
		await registerSource(page, repo);
		await selectInstallScopeProject(page, proj.id);

		// The pack ships a tool → executable-code warning dialog appears; confirm.
		await page.locator('[data-testid="market-browse-pack"][data-pack-name="kit-pack"]').locator('[data-testid="market-install-pack"]').click();
		await confirmExecWarning(page);

		// Installed card + provenance (the active project is the dedicated one).
		const installed = page.locator('[data-testid="market-installed-pack"][data-pack-name="kit-pack"]').first();
		await expect(installed).toBeVisible({ timeout: 15_000 });
		await expect(installed.locator('[data-testid="market-provenance"]')).toBeVisible();

		// Roles page → dedicated project scope tab → role resolves with pack chip.
		await navigateToHash(page, "#/roles");
		await selectConfigProjectScope(page, ".roles-container", proj.name);
		const roleRow = page.locator(".role-row").filter({ hasText: "kit-role" });
		await expect(roleRow).toBeVisible({ timeout: 15_000 });
		await expect(roleRow.locator('[data-testid="origin-pack-chip"]')).toHaveText("kit-pack");

		// finding #2 — a market-pack entity is READ-ONLY: opening its editor shows
		// a "Manage in Marketplace" note, NOT the legacy customize/revert buttons
		// (those call override endpoints that can't remove an installed pack).
		await roleRow.click();
		await expect(page.locator('[data-testid="market-readonly-note"]')).toBeVisible({ timeout: 10_000 });
		await expect(page.locator(".config-action-btn")).toHaveCount(0);

		// Tools + skills resolve through the single resolver, tagged with the pack
		// (chip rendering is the identical UI asserted above for roles; the tools
		// page groups rows which makes a UI-visibility assertion brittle). Scope
		// the REST calls to the dedicated project.
		const toolsRes = await apiFetch(`/api/tools?projectId=${encodeURIComponent(proj.id)}`);
		const tools = (await toolsRes.json()).tools as Array<{ name: string; originPackName?: string | null }>;
		expect(tools.find((t) => t.name === "kit-tool")?.originPackName).toBe("kit-pack");

		const skillsRes = await apiFetch(`/api/slash-skills/details?projectId=${encodeURIComponent(proj.id)}`);
		const skills = (await skillsRes.json()).skills as Array<{ name: string; originPackName?: string | null }>;
		expect(skills.find((s) => s.name === "kit-skill")?.originPackName).toBe("kit-pack");

		// Persists across reload: the installed card survives (re-pin the active
		// project, which reload resets to the harness default).
		await page.reload();
		await reopenMarketAfterReload(page, proj.id);
		await expect(page.locator('[data-testid="market-installed-pack"][data-pack-name="kit-pack"]').first()).toBeVisible({ timeout: 15_000 });
	});

	// finding #1 — a market-pack tool must be usable at RUNTIME, not just listed
	// by the cascade: GET /api/tools/:name returns it (404 before the fix) and it
	// appears as an available tool tagged with the pack; uninstall removes it.
	// API-only; installed at a DEDICATED PROJECT scope so nothing leaks.
	test("market-pack tool resolves through the runtime tool machinery (GET /api/tools/:name) + removed on uninstall", async () => {
		const repo = makeRepo();
		writePack(repo, { name: "rt-tool-pack", tools: [{ group: "rtgroup", name: "rt-tool" }] });
		const proj = await makeDedicatedProject("rt");
		const pid = encodeURIComponent(proj.id);

		const addRes = await apiFetch("/api/marketplace/sources", { method: "POST", body: JSON.stringify({ url: repo }) });
		expect(addRes.status).toBe(201);
		const src = (await addRes.json()).source;
		const instRes = await apiFetch("/api/marketplace/install", {
			method: "POST",
			body: JSON.stringify({ sourceId: src.id, dirName: "rt-tool-pack", scope: "project", projectId: proj.id }),
		});
		expect(instRes.status).toBe(201);

		try {
			// GET /api/tools/:name?projectId= returns the market tool (was 404 before
			// finding #1) — resolved via the project's toolManager.
			const detailRes = await apiFetch(`/api/tools/rt-tool?projectId=${pid}`);
			expect(detailRes.status).toBe(200);
			expect((await detailRes.json()).name).toBe("rt-tool");

			// It surfaces as an available tool for the project, tagged with its pack.
			const listRes = await apiFetch(`/api/tools?projectId=${pid}`);
			const tools = (await listRes.json()).tools as Array<{ name: string; originPackName?: string | null }>;
			const hit = tools.find((t) => t.name === "rt-tool");
			expect(hit, "market tool must appear in /api/tools for the project").toBeTruthy();
			expect(hit?.originPackName).toBe("rt-tool-pack");
		} finally {
			await apiFetch("/api/marketplace/installed", { method: "DELETE", body: JSON.stringify({ scope: "project", packName: "rt-tool-pack", projectId: proj.id }) }).catch(() => {});
		}

		// Uninstall removes exactly what was added: tool gone from detail + list.
		const after = await apiFetch(`/api/tools/rt-tool?projectId=${pid}`);
		expect(after.status).toBe(404);
		const listAfter = await apiFetch(`/api/tools?projectId=${pid}`);
		const toolsAfter = (await listAfter.json()).tools as Array<{ name: string }>;
		expect(toolsAfter.find((t) => t.name === "rt-tool")).toBeFalsy();
	});

	// §12.3 #7 — update (re-sync upstream) and uninstall (entities disappear).
	// Installed at a DEDICATED PROJECT scope.
	test("update re-syncs upstream and uninstall removes exactly what was installed", async ({ page }) => {
		const repo = makeRepo();
		writePack(repo, { name: "upd-pack", version: "1.0.0", roles: [{ name: "upd-role" }] });
		const proj = await makeDedicatedProject("upd");

		await openMarket(page, { activeProjectId: proj.id });
		await registerSource(page, repo);
		await selectInstallScopeProject(page, proj.id);

		// upd-pack ships no tools → no exec-code warning.
		await page.locator('[data-testid="market-browse-pack"][data-pack-name="upd-pack"]').locator('[data-testid="market-install-pack"]').click();
		const installed = page.locator('[data-testid="market-installed-pack"][data-pack-name="upd-pack"]').first();
		await expect(installed).toBeVisible({ timeout: 15_000 });
		await expect(installed).toContainText("v1.0.0");

		// Mutate the upstream pack (bump version) and update → re-sync reflected.
		writePack(repo, { name: "upd-pack", version: "2.0.0", roles: [{ name: "upd-role" }] });
		await installed.locator('[data-testid="market-update-pack"]').click();
		await expect(page.locator('[data-testid="market-installed-pack"][data-pack-name="upd-pack"]').first()).toContainText("v2.0.0", { timeout: 15_000 });

		// Role currently resolves on the dedicated project scope.
		await navigateToHash(page, "#/roles");
		await selectConfigProjectScope(page, ".roles-container", proj.name);
		await expect(page.locator(".role-row").filter({ hasText: "upd-role" })).toBeVisible({ timeout: 15_000 });

		// Uninstall → confirm → card gone AND entity gone from #/roles.
		await navigateToHash(page, "#/market");
		await page.locator('[data-testid="market-installed-pack"][data-pack-name="upd-pack"]').first()
			.locator('[data-testid="market-uninstall-pack"]').click();
		await expect(page.getByText(/deletes the pack directory/i)).toBeVisible({ timeout: 10_000 });
		// Confirm via Enter — the dialog's "Uninstall" button shares its accessible
		// name with the installed card's uninstall button (strict-mode collision).
		await page.keyboard.press("Enter");
		await expect(page.locator('[data-testid="market-installed-pack"][data-pack-name="upd-pack"]')).toHaveCount(0, { timeout: 15_000 });

		await navigateToHash(page, "#/roles");
		await selectConfigProjectScope(page, ".roles-container", proj.name);
		await expect(page.locator(".role-row").filter({ hasText: "upd-role" })).toHaveCount(0, { timeout: 15_000 });
	});

	// §12.3 #8 — tool-bearing packs show the executable-code warning before
	// install. Cancels — nothing is installed — so no scope is needed.
	test("tool-bearing pack shows executable-code warning before install", async ({ page }) => {
		const repo = makeRepo();
		writePack(repo, { name: "warn-pack", tools: [{ group: "warngroup", name: "warn-tool" }] });

		await openMarket(page);
		await registerSource(page, repo);

		const card = page.locator('[data-testid="market-browse-pack"][data-pack-name="warn-pack"]');
		await expect(card.locator(".market-exec-warning")).toBeVisible({ timeout: 15_000 });

		await card.locator('[data-testid="market-install-pack"]').click();
		await expect(page.getByText(/installs executable code that runs on your machine/i)).toBeVisible({ timeout: 10_000 });
		// Cancel — nothing installed.
		await page.getByRole("button", { name: "Cancel" }).click();
		await expect(page.locator('[data-testid="market-installed-pack"][data-pack-name="warn-pack"]')).toHaveCount(0);
	});

	// §12.3 #9 — same-name conflict warning + reorder flips the winner.
	// Installed at a DEDICATED PROJECT scope; reorder persists via PUT
	// /api/marketplace/pack-order (scope=project).
	test("conflict warning appears and reorder flips the winner (PUT pack-order)", async ({ page }) => {
		const repo = makeRepo();
		// Two packs in one source, each defining the SAME role name.
		writePack(repo, { name: "conf-a", roles: [{ name: "shared-role", label: "From A" }] });
		writePack(repo, { name: "conf-b", roles: [{ name: "shared-role", label: "From B" }] });
		const proj = await makeDedicatedProject("conf");
		const pid = encodeURIComponent(proj.id);

		await openMarket(page, { activeProjectId: proj.id });
		await registerSource(page, repo);
		await selectInstallScopeProject(page, proj.id);

		// Install both (order a → b ⇒ b wins initially as highest precedence).
		await page.locator('[data-testid="market-browse-pack"][data-pack-name="conf-a"]').locator('[data-testid="market-install-pack"]').click();
		await expect(page.locator('[data-testid="market-installed-pack"][data-pack-name="conf-a"]').first()).toBeVisible({ timeout: 15_000 });
		await page.locator('[data-testid="market-browse-pack"][data-pack-name="conf-b"]').locator('[data-testid="market-install-pack"]').click();
		await expect(page.locator('[data-testid="market-installed-pack"][data-pack-name="conf-b"]').first()).toBeVisible({ timeout: 15_000 });

		// Conflict warning surfaces on the installed cards.
		await expect(page.locator('[data-testid="market-conflict-warning"]').first()).toBeVisible({ timeout: 15_000 });

		// Winner is conf-b (highest precedence = last installed).
		await navigateToHash(page, "#/roles");
		await selectConfigProjectScope(page, ".roles-container", proj.name);
		const roleRow = page.locator(".role-row").filter({ hasText: "shared-role" });
		await expect(roleRow.locator('[data-testid="origin-pack-chip"]')).toHaveText("conf-b", { timeout: 15_000 });

		// Reorder: bump conf-a to higher precedence (move-down) → conf-a wins.
		await navigateToHash(page, "#/market");
		await page.locator('[data-testid="market-installed-pack"][data-pack-name="conf-a"]').first()
			.locator('[data-testid="market-move-down"]').click();

		await navigateToHash(page, "#/roles");
		await selectConfigProjectScope(page, ".roles-container", proj.name);
		await expect(page.locator(".role-row").filter({ hasText: "shared-role" }).locator('[data-testid="origin-pack-chip"]')).toHaveText("conf-a", { timeout: 15_000 });

		// Persists across reload.
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
		await navigateToHash(page, "#/roles");
		await selectConfigProjectScope(page, ".roles-container", proj.name);
		await expect(page.locator(".role-row").filter({ hasText: "shared-role" }).locator('[data-testid="origin-pack-chip"]')).toHaveText("conf-a", { timeout: 15_000 });

		// finding #2 — after reload the INSTALLED-CARD ORDER must reflect the
		// persisted pack_order (project: [conf-b, conf-a] after the move), not raw
		// readdir order — otherwise the UI builds reorder payloads from a stale
		// order and a subsequent move persists the wrong sequence.
		await setActiveProject(page, proj.id);
		await navigateToHash(page, "#/market");
		await expect(page.locator('[data-testid="market-installed-pack"][data-pack-name="conf-a"]').first()).toBeVisible({ timeout: 15_000 });
		const cardOrder = await page.evaluate(() =>
			Array.from(document.querySelectorAll('[data-testid="market-installed-pack"]'))
				.map((el) => el.getAttribute("data-pack-name"))
				.filter((n): n is string => n === "conf-a" || n === "conf-b"),
		);
		expect(cardOrder).toEqual(["conf-b", "conf-a"]);

		// And the persisted pack-order endpoint agrees (highest precedence last).
		const orderRes = await apiFetch(`/api/marketplace/pack-order?scope=project&projectId=${pid}`);
		const order = ((await orderRes.json()).order as string[]).filter((n) => n === "conf-a" || n === "conf-b");
		expect(order).toEqual(["conf-b", "conf-a"]);
	});
});
