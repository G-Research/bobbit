/**
 * Browser E2E — Pack-Based Marketplace UI surface.
 * See docs/design/pack-based-marketplace.md §12.3.
 *
 * STATUS: This spec is written against the documented REST contracts (§9). The
 * backend (/api/marketplace/*, /api/packs/conflicts, originPackName on
 * /api/roles|tools|skills) is being built in parallel. Tests that only exercise
 * the UI shell (Market button position, opening the surface, graceful error
 * degradation, the add-source form) run today. Tests that need live REST are
 * marked `test.fixme` with a TODO so the REST agent can un-skip them once the
 * endpoints land — they are NOT left failing.
 *
 * Pattern: mirrors tests/e2e/ui/sidebar-navigation.spec.ts + skills-chip.spec.ts
 * and reuses config-page conventions (origin badges, scope rows).
 */
import type { Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

/** Resolve the harness default project's id (rootPath == the worker BOBBIT_DIR). */
async function defaultProjectId(): Promise<string> {
	const res = await apiFetch("/api/projects");
	const body = await res.json();
	const projects: Array<{ id?: string; name?: string }> = Array.isArray(body) ? body : (body.projects ?? []);
	const def = projects.find((p) => p.name === "default") ?? projects[0];
	if (!def?.id) throw new Error("no default project");
	return def.id;
}

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

/** Open the app and navigate to the marketplace surface. */
async function openMarket(page: Page): Promise<void> {
	await openApp(page);
	await navigateToHash(page, "#/market");
	await expect(page.locator('[data-testid="market-sources-panel"]')).toBeVisible({ timeout: 15_000 });
}

/** Register a local-dir source by absolute path; resolves when its packs are browsable. */
async function registerSource(page: Page, repoPath: string): Promise<void> {
	await page.locator('[data-testid="market-source-url"]').fill(repoPath);
	await page.locator('[data-testid="market-add-source"]').click();
	// handleAddSource auto-browses the freshly-added source → its pack cards render.
	await expect(page.locator('[data-testid="market-browse-pack"]').first()).toBeVisible({ timeout: 15_000 });
}

test.afterAll(() => {
	for (const r of _repos) { try { rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ } }
});

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
	// New Goal; opens the marketplace surface. (UI shell — runs today.)
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
	// LIVE-REST TESTS — drive the full §12.3 acceptance flow against the
	// real /api/marketplace/* endpoints using a local-dir source fixture.
	// Installs target the SERVER scope (isolated under the worker's BOBBIT_DIR);
	// resolution is verified on the config pages.
	// ==================================================================

	// §12.3 #2–3 — register a source and browse its packs.
	test("register a local-dir source and browse its packs", async ({ page }) => {
		const repo = makeRepo();
		writePack(repo, { name: "browse-pack", description: "Browseable demo pack", roles: [{ name: "browse-role" }], skills: [{ name: "browse-skill" }] });

		await openMarket(page);
		await registerSource(page, repo);

		await expect(page.locator('[data-testid="market-source-row"]').first()).toBeVisible();
		const card = page.locator('[data-testid="market-browse-pack"][data-pack-name="browse-pack"]');
		await expect(card).toBeVisible();
		await expect(card).toContainText("Browseable demo pack");
		// Declared entity chips render (role + skill).
		await expect(card.locator(".market-entity-chip")).toHaveCount(2);
	});

	// §12.3 #4–6 — install to a scope; entities resolve on the config pages
	// tagged with the specific pack (originPackName chip); persist across reload;
	// provenance shown.
	test("install a pack → entities resolve with pack origin chip + persist + provenance", async ({ page }) => {
		const repo = makeRepo();
		writePack(repo, {
			name: "kit-pack",
			description: "Roles, tools and skills kit",
			roles: [{ name: "kit-role", label: "Kit Role" }],
			tools: [{ group: "kitgroup", name: "kit-tool" }],
			skills: [{ name: "kit-skill" }],
		});

		await openMarket(page);
		await registerSource(page, repo);

		// Install to the (default) server scope. The pack ships a tool, so the
		// executable-code warning dialog appears — accept it.
		await page.locator('[data-testid="market-browse-pack"][data-pack-name="kit-pack"]').locator('[data-testid="market-install-pack"]').click();
		await expect(page.getByText(/installs executable code that runs on your machine/i)).toBeVisible({ timeout: 10_000 });
		await page.keyboard.press("Enter"); // confirm "Install anyway"

		// Installed card + provenance.
		const installed = page.locator('[data-testid="market-installed-pack"][data-pack-name="kit-pack"]').first();
		await expect(installed).toBeVisible({ timeout: 15_000 });
		await expect(installed.locator('[data-testid="market-provenance"]')).toBeVisible();

		// Roles page (system scope): role resolves with the pack origin chip in the UI.
		await navigateToHash(page, "#/roles");
		const roleRow = page.locator(".role-row").filter({ hasText: "kit-role" });
		await expect(roleRow).toBeVisible({ timeout: 15_000 });
		await expect(roleRow.locator('[data-testid="origin-pack-chip"]')).toHaveText("kit-pack");

		// Tools + skills resolve through the single resolver tagged with the pack
		// (verified via the REST contract — the chip rendering is identical UI to
		// roles, already asserted above; the tools page groups rows which makes a
		// UI-visibility assertion brittle).
		const projectId = await defaultProjectId();
		const toolsRes = await apiFetch("/api/tools");
		const tools = (await toolsRes.json()).tools as Array<{ name: string; originPackName?: string | null }>;
		expect(tools.find((t) => t.name === "kit-tool")?.originPackName).toBe("kit-pack");

		const skillsRes = await apiFetch(`/api/slash-skills/details?projectId=${encodeURIComponent(projectId)}`);
		const skills = (await skillsRes.json()).skills as Array<{ name: string; originPackName?: string | null }>;
		expect(skills.find((s) => s.name === "kit-skill")?.originPackName).toBe("kit-pack");

		// Persists across reload: installed card survives.
		await page.reload();
		await navigateToHash(page, "#/market");
		await expect(page.locator('[data-testid="market-installed-pack"][data-pack-name="kit-pack"]').first()).toBeVisible({ timeout: 15_000 });
	});

	// finding #1 — a market-pack tool must be usable at RUNTIME, not just listed
	// by the cascade: GET /api/tools/:name returns it (404 before the fix) and it
	// appears as an available tool tagged with the pack; uninstall removes it.
	test("market-pack tool resolves through the runtime tool machinery (GET /api/tools/:name) + removed on uninstall", async () => {
		const repo = makeRepo();
		writePack(repo, { name: "rt-tool-pack", tools: [{ group: "rtgroup", name: "rt-tool" }] });

		const addRes = await apiFetch("/api/marketplace/sources", { method: "POST", body: JSON.stringify({ url: repo }) });
		expect(addRes.status).toBe(201);
		const src = (await addRes.json()).source;
		const instRes = await apiFetch("/api/marketplace/install", {
			method: "POST",
			body: JSON.stringify({ sourceId: src.id, dirName: "rt-tool-pack", scope: "server" }),
		});
		expect(instRes.status).toBe(201);

		try {
			// GET /api/tools/:name returns the market tool (was 404 before finding #1).
			const detailRes = await apiFetch("/api/tools/rt-tool");
			expect(detailRes.status).toBe(200);
			expect((await detailRes.json()).name).toBe("rt-tool");

			// It surfaces as an available tool, tagged with the originating pack.
			const listRes = await apiFetch("/api/tools");
			const tools = (await listRes.json()).tools as Array<{ name: string; originPackName?: string | null }>;
			const hit = tools.find((t) => t.name === "rt-tool");
			expect(hit, "market tool must appear in /api/tools").toBeTruthy();
			expect(hit?.originPackName).toBe("rt-tool-pack");
		} finally {
			await apiFetch("/api/marketplace/installed", { method: "DELETE", body: JSON.stringify({ scope: "server", packName: "rt-tool-pack" }) }).catch(() => {});
		}

		// Uninstall removes exactly what was added: tool gone from detail + list.
		const after = await apiFetch("/api/tools/rt-tool");
		expect(after.status).toBe(404);
		const listAfter = await apiFetch("/api/tools");
		const toolsAfter = (await listAfter.json()).tools as Array<{ name: string }>;
		expect(toolsAfter.find((t) => t.name === "rt-tool")).toBeFalsy();
	});

	// §12.3 #7 — update (re-sync upstream) and uninstall (entities disappear).
	test("update re-syncs upstream and uninstall removes exactly what was installed", async ({ page }) => {
		const repo = makeRepo();
		writePack(repo, { name: "upd-pack", version: "1.0.0", roles: [{ name: "upd-role" }] });

		await openMarket(page);
		await registerSource(page, repo);
		await page.locator('[data-testid="market-browse-pack"][data-pack-name="upd-pack"]').locator('[data-testid="market-install-pack"]').click();
		const installed = page.locator('[data-testid="market-installed-pack"][data-pack-name="upd-pack"]').first();
		await expect(installed).toBeVisible({ timeout: 15_000 });
		await expect(installed).toContainText("v1.0.0");

		// Mutate the upstream pack (bump version) and update → re-sync reflected.
		writePack(repo, { name: "upd-pack", version: "2.0.0", roles: [{ name: "upd-role" }] });
		await installed.locator('[data-testid="market-update-pack"]').click();
		await expect(page.locator('[data-testid="market-installed-pack"][data-pack-name="upd-pack"]').first()).toContainText("v2.0.0", { timeout: 15_000 });

		// Role currently resolves.
		await navigateToHash(page, "#/roles");
		await expect(page.locator(".role-row").filter({ hasText: "upd-role" })).toBeVisible({ timeout: 15_000 });

		// Uninstall → confirm → card gone AND entity gone from #/roles.
		await navigateToHash(page, "#/market");
		await page.locator('[data-testid="market-installed-pack"][data-pack-name="upd-pack"]').first()
			.locator('[data-testid="market-uninstall-pack"]').click();
		await expect(page.getByText(/deletes the pack directory/i)).toBeVisible({ timeout: 10_000 });
		await page.keyboard.press("Enter"); // confirm "Uninstall"
		await expect(page.locator('[data-testid="market-installed-pack"][data-pack-name="upd-pack"]')).toHaveCount(0, { timeout: 15_000 });

		await navigateToHash(page, "#/roles");
		await expect(page.locator(".role-row").filter({ hasText: "upd-role" })).toHaveCount(0, { timeout: 15_000 });
	});

	// §12.3 #8 — tool-bearing packs show the executable-code warning before install.
	test("tool-bearing pack shows executable-code warning before install", async ({ page }) => {
		const repo = makeRepo();
		writePack(repo, { name: "warn-pack", tools: [{ group: "warngroup", name: "warn-tool" }] });

		await openMarket(page);
		await registerSource(page, repo);

		const card = page.locator('[data-testid="market-browse-pack"][data-pack-name="warn-pack"]');
		await expect(card.locator(".market-exec-warning")).toBeVisible();

		await card.locator('[data-testid="market-install-pack"]').click();
		await expect(page.getByText(/installs executable code that runs on your machine/i)).toBeVisible({ timeout: 10_000 });
		// Cancel — nothing installed.
		await page.getByRole("button", { name: "Cancel" }).click();
		await expect(page.locator('[data-testid="market-installed-pack"][data-pack-name="warn-pack"]')).toHaveCount(0);
	});

	// §12.3 #9 — same-name conflict warning + reorder flips the winner.
	test("conflict warning appears and reorder flips the winner (PUT pack-order)", async ({ page }) => {
		const repo = makeRepo();
		// Two packs in one source, each defining the SAME role name.
		writePack(repo, { name: "conf-a", roles: [{ name: "shared-role", label: "From A" }] });
		writePack(repo, { name: "conf-b", roles: [{ name: "shared-role", label: "From B" }] });

		await openMarket(page);
		await registerSource(page, repo);

		// Install both at server scope (install order a → b ⇒ b wins initially).
		await page.locator('[data-testid="market-browse-pack"][data-pack-name="conf-a"]').locator('[data-testid="market-install-pack"]').click();
		await expect(page.locator('[data-testid="market-installed-pack"][data-pack-name="conf-a"]').first()).toBeVisible({ timeout: 15_000 });
		await page.locator('[data-testid="market-browse-pack"][data-pack-name="conf-b"]').locator('[data-testid="market-install-pack"]').click();
		await expect(page.locator('[data-testid="market-installed-pack"][data-pack-name="conf-b"]').first()).toBeVisible({ timeout: 15_000 });

		// Conflict warning surfaces on the installed cards.
		await expect(page.locator('[data-testid="market-conflict-warning"]').first()).toBeVisible({ timeout: 15_000 });

		// Winner is conf-b (highest precedence = last installed).
		await navigateToHash(page, "#/roles");
		const roleRow = page.locator(".role-row").filter({ hasText: "shared-role" });
		await expect(roleRow.locator('[data-testid="origin-pack-chip"]')).toHaveText("conf-b", { timeout: 15_000 });

		// Reorder: bump conf-a to higher precedence (move-down) → conf-a wins.
		await navigateToHash(page, "#/market");
		await page.locator('[data-testid="market-installed-pack"][data-pack-name="conf-a"]').first()
			.locator('[data-testid="market-move-down"]').click();

		await navigateToHash(page, "#/roles");
		await expect(page.locator(".role-row").filter({ hasText: "shared-role" }).locator('[data-testid="origin-pack-chip"]')).toHaveText("conf-a", { timeout: 15_000 });

		// Persists across reload.
		await page.reload();
		await navigateToHash(page, "#/roles");
		await expect(page.locator(".role-row").filter({ hasText: "shared-role" }).locator('[data-testid="origin-pack-chip"]')).toHaveText("conf-a", { timeout: 15_000 });

		// finding #2 — after reload the INSTALLED-CARD ORDER must reflect the
		// persisted pack_order (server: [conf-b, conf-a] after the move), not raw
		// readdir order — otherwise the UI builds reorder payloads from a stale
		// order and a subsequent move persists the wrong sequence.
		await navigateToHash(page, "#/market");
		await expect(page.locator('[data-testid="market-installed-pack"][data-pack-name="conf-a"]').first()).toBeVisible({ timeout: 15_000 });
		// Filter to the two conflict packs — the worker's server scope may hold
		// other packs from sibling tests sharing the same BOBBIT_DIR.
		const cardOrder = await page.evaluate(() =>
			Array.from(document.querySelectorAll('[data-testid="market-installed-pack"]'))
				.map((el) => el.getAttribute("data-pack-name"))
				.filter((n): n is string => n === "conf-a" || n === "conf-b"),
		);
		expect(cardOrder).toEqual(["conf-b", "conf-a"]);

		// And the persisted pack-order endpoint agrees (highest precedence last).
		const orderRes = await apiFetch("/api/marketplace/pack-order?scope=server");
		const order = ((await orderRes.json()).order as string[]).filter((n) => n === "conf-a" || n === "conf-b");
		expect(order).toEqual(["conf-b", "conf-a"]);
	});

	// ------------------------------------------------------------------
	// finding #3 — a SERVER-scope skill pack must resolve for a project whose
	// rootPath != the server cwd. Skill discovery threads an explicit market
	// scope context (serverBase = server cwd), so server-scope market skill
	// packs resolve regardless of the active project's root. API-driven
	// (resolution is server-side; no extra UI surface to exercise).
	// ------------------------------------------------------------------
	test("server-scope skill pack resolves for a non-default project root (root != server cwd)", async () => {
		const repo = makeRepo();
		writePack(repo, { name: "srv-skill-pack", skills: [{ name: "srv-scope-skill" }] });

		// Register a SECOND project whose rootPath differs from the server cwd
		// (the default project's root == server cwd, so it can't expose the bug).
		const projDir = mkdtempSync(join(tmpdir(), "bobbit-mkt-proj-"));
		mkdirSync(join(projDir, ".bobbit", "config"), { recursive: true });
		const projRes = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: `mkt-other-${Date.now()}`, rootPath: projDir }),
		});
		expect(projRes.status).toBe(201);
		const proj = await projRes.json();

		// Register the source and install the skill pack at SERVER scope.
		const addRes = await apiFetch("/api/marketplace/sources", { method: "POST", body: JSON.stringify({ url: repo }) });
		expect(addRes.status).toBe(201);
		const src = (await addRes.json()).source;
		const instRes = await apiFetch("/api/marketplace/install", {
			method: "POST",
			body: JSON.stringify({ sourceId: src.id, dirName: "srv-skill-pack", scope: "server" }),
		});
		expect(instRes.status).toBe(201);

		try {
			// The server-scope skill resolves for the OTHER project — only true
			// when serverBase is the server cwd, not the project root.
			const skillsRes = await apiFetch(`/api/slash-skills?projectId=${encodeURIComponent(proj.id)}`);
			const skills = (await skillsRes.json()).skills as Array<{ name: string; originPackName?: string | null; originPackId?: string | null }>;
			const hit = skills.find((s) => s.name === "srv-scope-skill");
			expect(hit, "server-scope skill must resolve for a non-default project root").toBeTruthy();
			expect(hit?.originPackName).toBe("srv-skill-pack");
			expect(hit?.originPackId).toBe("market:server:srv-skill-pack");
		} finally {
			await apiFetch("/api/marketplace/installed", { method: "DELETE", body: JSON.stringify({ scope: "server", packName: "srv-skill-pack" }) }).catch(() => {});
			await apiFetch(`/api/projects/${proj.id}`, { method: "DELETE" }).catch(() => {});
			try { rmSync(projDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
});
