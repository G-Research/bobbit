/**
 * Add Project flow E2E tests — smart path-first dialog.
 * Tests the new path-only dialog, directory detection/auto-import,
 * browse UI, and project assistant session creation.
 */
import type { Page, Route } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { ADD_PROJECT } from "./add-project-helpers.js";
import { existsSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Create a unique temp dir for each test to avoid conflicts. */
function uniqueDir(label: string): string {
	const dir = join(tmpdir(), `bobbit-e2e-addproj-${label}-${process.env.E2E_PORT}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	// Canonicalize: tmpdir() is a /var/folders symlink on macOS. Returning the
	// canonical path keeps test comparisons (p.rootPath === dir) consistent
	// with what the registry stores after the UI's acceptCanonical resubmit.
	return realpathSync(dir);
}

const PATH_HINT = "Type a path or click Browse to pick a directory, or type a path of a new directory to create it";
const REAL_IMPORT_PACK = `add-project-real-import-${process.pid}`;
const REAL_IMPORT_HOOK = "add-project.real-import";
const REAL_IMPORT_QUESTION = "REAL_ADD_PROJECT_IMPORT_QUESTION_choose_mode";

function writeRealImportPack(headquartersDir: string): string {
	const packDir = join(headquartersDir, "config", "market-packs", REAL_IMPORT_PACK);
	rmSync(packDir, { recursive: true, force: true });
	mkdirSync(join(packDir, "hooks"), { recursive: true });
	mkdirSync(join(packDir, "lib"), { recursive: true });
	writeFileSync(join(packDir, ".pack-meta.yaml"), [
		"sourceUrl: test", "sourceRef: local", "commit: fixture", `packName: ${REAL_IMPORT_PACK}`,
		"version: 1.0.0", "installedAt: '2026-01-01T00:00:00.000Z'", "updatedAt: '2026-01-01T00:00:00.000Z'", "scope: server",
	].join("\n") + "\n");
	writeFileSync(join(packDir, "pack.yaml"), [
		"schema: 2", `name: ${REAL_IMPORT_PACK}`, "description: Real Add Project import decision fixture", "version: 1.0.0",
		"contents:", "  roles: []", "  tools: []", "  skills: []", "  entrypoints: []", "  providers: []",
		"  hooks: [add-project-real-import]", "  mcp: []", "  pi-extensions: []", "  runtimes: []", "  workflows: []",
	].join("\n") + "\n");
	writeFileSync(join(packDir, "hooks", "add-project-real-import.yaml"), [
		`id: ${REAL_IMPORT_HOOK}`, "module: ../lib/import.mjs", "events: [projectImported]", "mode: decide", "capabilities: []",
		"budget: { maxTokens: 64, timeoutMs: 1000 }",
	].join("\n") + "\n");
	writeFileSync(join(packDir, "lib", "import.mjs"), `
const deadline = () => new Date(Date.now() + 60_000).toISOString();
export default { decide(ctx) {
  if (ctx.event !== "projectImported" || ctx.components.length !== 1) throw new Error("component snapshot missing");
  return { kind: "request", request: {
    version: 1, key: "add-project-browser", title: "Choose import mode", question: ${JSON.stringify(REAL_IMPORT_QUESTION)},
    options: [{ value: "safe", label: "Safe mode" }, { value: "fast", label: "Fast mode" }], other: { maxLength: 40 },
    requestedClass: "consent-required", scope: "project", deadlineAt: deadline(),
    effect: { kind: "proposal", proposals: {
      safe: { proposalType: "role", args: { name: "browser-import-role", label: "Browser import role", prompt: "A role applied after import review." } },
      fast: { proposalType: "role", args: { name: "browser-rejected-import-role", label: "Rejected browser import role", prompt: "A role rejected after import review." } },
    }, noEffectValues: ["other"] },
  } };
} };
`);
	return packDir;
}

async function readServerPackOrder(): Promise<string[]> {
	const response = await apiFetch("/api/marketplace/pack-order?scope=server");
	expect(response.status).toBe(200);
	return (await response.json()).order as string[];
}

async function refreshPackRegistry(order: string[]): Promise<void> {
	const response = await apiFetch("/api/marketplace/pack-order", {
		method: "PUT", body: JSON.stringify({ scope: "server", order }),
	});
	expect(response.status).toBe(200);
}

const createDirectoryButton = (page: Page) =>
	page.locator("button").filter({ has: page.locator(ADD_PROJECT.createDirectory) }).first();
const inlineCreate = (page: Page) => page.locator(ADD_PROJECT.statusSlot).locator(ADD_PROJECT.inlineCreate);
const footerCreateButton = (page: Page) => page.locator(ADD_PROJECT.footer).locator(ADD_PROJECT.createDirectory);

async function expectInlineCreateCentered(page: Page): Promise<void> {
	const inline = inlineCreate(page);
	await expect(inline).toBeVisible({ timeout: 10_000 });
	await expect(inline).toContainText("Directory doesn't exist");
	await expect(inline.locator(ADD_PROJECT.createDirectory)).toHaveText("Create Directory");
	await expect(footerCreateButton(page)).toHaveCount(0);
	await expect(page.locator(ADD_PROJECT.footer).getByRole("button", { name: "Create Directory" })).toHaveCount(0);

	const centering = await inline.evaluate((el) => {
		const slotEl = el.closest('[data-testid="add-project-status-slot"]') as HTMLElement | null;
		const style = window.getComputedStyle(el);
		const rect = el.getBoundingClientRect();
		const slotRect = slotEl?.getBoundingClientRect();
		return {
			alignItems: style.alignItems,
			justifyContent: style.justifyContent,
			textAlign: style.textAlign,
			centerDelta: slotRect
				? Math.abs((rect.left + rect.width / 2) - (slotRect.left + slotRect.width / 2))
				: Number.POSITIVE_INFINITY,
		};
	});
	expect(centering.centerDelta).toBeLessThanOrEqual(4);
	expect(
		centering.textAlign === "center"
			|| centering.justifyContent === "center"
			|| centering.alignItems === "center",
	).toBe(true);
}

test.describe("Add Project flow (UI)", () => {
	let realImportPackDir = "";
	let originalPackOrder: string[] = [];

	test.beforeAll(async ({ gateway }) => {
		originalPackOrder = await readServerPackOrder();
		realImportPackDir = writeRealImportPack(gateway.bobbitDir);
		await refreshPackRegistry(originalPackOrder);
		const activation = await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT", body: JSON.stringify({ scope: "server", packName: REAL_IMPORT_PACK, disabled: { hooks: [] } }),
		});
		expect(activation.status, await activation.clone().text()).toBe(200);
	});

	test.afterAll(async () => {
		await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT", body: JSON.stringify({ scope: "server", packName: REAL_IMPORT_PACK, disabled: {} }),
		}).catch(() => {});
		if (realImportPackDir) rmSync(realImportPackDir, { recursive: true, force: true });
		await refreshPackRegistry(originalPackOrder).catch(() => {});
	});

	// Tests in this spec create projects (provisional + promoted) that persist
	// in the worker's project registry. Without cleanup they leak into
	// downstream specs — the goal-form-tooltips spec, in particular, expects
	// exactly one registered project so its New-Goal button opens the goal
	// form directly rather than a project-picker dialog (PR #380 already hit
	// this once via per-project-config-dirs leaking; this spec leaked too).
	test.afterEach(async () => {
		const res = await apiFetch("/api/projects");
		const data = await res.json();
		const projects = data.projects || data || [];
		for (const p of projects) {
			if (p.name === "default") continue;
			// Some leaked projects are provisional (assistant sessions); some
			// are promoted. Plain DELETE works for any project, including the
			// last visible one.
			await apiFetch(`/api/projects/${p.id}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("path-only dialog and directory browser render without legacy fields", async ({ page }) => {
		await openApp(page);

		// Click "Add Project" button in sidebar
		await page.locator("button").filter({ hasText: "Add Project" }).first().click();

		// Dialog should appear with the "Add Project" title
		await expect(page.getByText("Add Project", { exact: true }).first()).toBeVisible({ timeout: 5_000 });

		// Should have a path input with placeholder and the exact extended guidance copy.
		const pathInput = page.locator('input[placeholder="/path/to/project"]');
		await expect(pathInput).toBeVisible();
		await expect(page.locator(ADD_PROJECT.statusSlot)).toHaveText(PATH_HINT);

		// Should have a Browse button
		await expect(page.locator("button").filter({ hasText: "Browse" }).first()).toBeVisible();

		// Should have a Continue button
		await expect(page.locator("button").filter({ hasText: "Continue" }).first()).toBeVisible();

		// Should NOT have "Project Name" or "Color" labels (old dialog fields)
		await expect(page.getByText("Project Name")).not.toBeVisible();
		await expect(page.getByText("Color (optional)")).not.toBeVisible();

		// Directory browser opens, Select current closes it, and the chosen path is copied back.
		await page.locator('[data-testid="directory-picker-browse"]').click();
		await expect(page.locator('[data-testid="add-project-browse-dialog"]')).toBeVisible({ timeout: 5_000 });
		const selectBtn = page.locator("button").filter({ hasText: "Select current" }).first();
		await expect(selectBtn).toBeVisible();
		// Wait for the initial browse to populate so `current` is non-empty (Select current is
		// disabled while the modal is still showing "Loading…").
		await expect(selectBtn).toBeEnabled({ timeout: 5_000 });
		await selectBtn.click();
		await expect(page.locator('[data-testid="add-project-browse-dialog"]')).not.toBeVisible({ timeout: 5_000 });
		await expect(pathInput).toBeVisible();
		expect((await pathInput.inputValue()).length).toBeGreaterThan(0);
	});

	test("Add Project answers a real granted import question without a stubbed decision route", async ({ page, gateway }) => {
		const dir = uniqueDir("real-import-decision");
		mkdirSync(join(dir, ".bobbit", "config"), { recursive: true });
		writeFileSync(join(dir, ".bobbit", "config", "project.yaml"), "name: real-import\n");
		let projectId = "";
		let sessionPosts = 0;
		let askPosts = 0;
		let releaseProjection: (() => void) | undefined;
		const projectionPaused = new Promise<void>(resolve => { releaseProjection = resolve; });
		try {
			// Keep the browser's real projection request in flight while the test
			// performs the authenticated grant that a user makes after registration.
			// This is a pass-through, never a stubbed response: the successful path
			// still exercises the production GET and POST decision endpoints.
			await page.route(/\/import-decision-requests\?state=pending$/, async route => {
				await projectionPaused;
				await route.continue();
			});
			page.on("request", (request) => {
				if (request.method() !== "POST") return;
				if (request.url().includes("/api/sessions")) sessionPosts++;
				if (request.url().includes("/api/internal/user-question/submit")) askPosts++;
			});
			await openApp(page);
			await page.locator("button").filter({ hasText: "Add Project" }).first().click();
			const pathInput = page.locator('input[placeholder="/path/to/project"]');
			await pathInput.fill(dir);
			const registered = page.waitForResponse(response => response.request().method() === "POST" && /\/api\/projects$/.test(new URL(response.url()).pathname));
			await page.locator("button").filter({ hasText: "Continue" }).first().click();
			const projectResponse = await registered;
			const project = await projectResponse.json();
			expect(projectResponse.status(), JSON.stringify(project)).toBe(201);
			projectId = project.id;
			const grant = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/extension-grants`, {
				method: "PUT", body: JSON.stringify({ packId: REAL_IMPORT_PACK, hookId: REAL_IMPORT_HOOK, capability: "decide" }),
			});
			expect(grant.status, await grant.clone().text()).toBe(200);
			releaseProjection!();

			const decisions = page.locator('[data-testid="project-import-decisions"]');
			await expect(decisions).toBeVisible({ timeout: 10_000 });
			await expect(decisions).toContainText(REAL_IMPORT_QUESTION);
			await expect(decisions.locator("ask-user-choices-widget")).toHaveCount(1);
			// The audit is rendered from the same durable import projection, not a
			// test-only transcript or mocked activity endpoint.
			await expect(decisions.locator('[data-testid="project-import-decision-activity"]')).toBeVisible();
			await expect(decisions.locator('[data-testid="project-import-decision-activity"]')).toContainText(REAL_IMPORT_HOOK);
			expect(sessionPosts).toBe(0);
			expect(askPosts).toBe(0);

			await decisions.locator("label.ask-option").filter({ hasText: "Safe mode" }).click();
			const proposal = decisions.locator('[data-testid="project-import-proposal"]');
			await expect(proposal).toBeVisible({ timeout: 10_000 });
			await expect(proposal).toContainText("browser-import-role");
			await expect(proposal.locator('[data-testid="project-import-proposal-fields"]')).toContainText("Browser import role");
			const audit = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-decision-requests`);
			expect(audit.status).toBe(200);
			const records = (await audit.json()).requests;
			expect(records).toEqual(expect.arrayContaining([
				expect.objectContaining({ status: "resolved", request: expect.objectContaining({ question: REAL_IMPORT_QUESTION }), resolution: { value: { kind: "option", value: "safe" } } }),
			]));

			await proposal.getByRole("button", { name: "Apply proposal" }).click();
			await expect(proposal).toHaveCount(0, { timeout: 10_000 });
			const roles = await apiFetch(`/api/roles?projectId=${encodeURIComponent(projectId)}`);
			expect((await roles.json()).roles).toEqual(expect.arrayContaining([
				expect.objectContaining({ name: "browser-import-role", label: "Browser import role" }),
			]));

			// Startup reconciliation and an HTTP retry use the same completed run;
			// neither may ask again after the durable answer and review are recorded.
			await gateway.crash();
			await gateway.restart();
			const recovered = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-decision-requests`);
			expect(recovered.status).toBe(200);
			expect((await recovered.json()).requests.filter((request: any) => request.request?.question === REAL_IMPORT_QUESTION)).toHaveLength(1);
			const retry = await apiFetch("/api/projects", {
				method: "POST", body: JSON.stringify({ name: "ignored retry", rootPath: dir, upsert: true }),
			});
			expect(retry.status).toBe(200);
			expect((await (await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-decision-requests`)).json()).requests
				.filter((request: any) => request.request?.question === REAL_IMPORT_QUESTION)).toHaveLength(1);
			expect(sessionPosts).toBe(0);
			expect(askPosts).toBe(0);
		} finally {
			releaseProjection?.();
			await page.unroute(/\/import-decision-requests\?state=pending$/).catch(() => {});
			if (projectId) await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("Add Project rejects a real project-owned proposal without applying it", async ({ page }) => {
		const dir = uniqueDir("real-import-proposal-reject");
		mkdirSync(join(dir, ".bobbit", "config"), { recursive: true });
		writeFileSync(join(dir, ".bobbit", "config", "project.yaml"), "name: real-import-reject\n");
		let projectId = "";
		let releaseProjection: (() => void) | undefined;
		const projectionPaused = new Promise<void>(resolve => { releaseProjection = resolve; });
		try {
			// This only delays the actual projection until the real, authenticated
			// grant replay is stored. It never manufactures a decision response.
			await page.route(/\/import-decision-requests\?state=pending$/, async route => {
				await projectionPaused;
				await route.continue();
			});
			await openApp(page);
			await page.locator("button").filter({ hasText: "Add Project" }).first().click();
			const pathInput = page.locator('input[placeholder="/path/to/project"]');
			await pathInput.fill(dir);
			const registered = page.waitForResponse(response => response.request().method() === "POST" && /\/api\/projects$/.test(new URL(response.url()).pathname));
			await page.locator("button").filter({ hasText: "Continue" }).first().click();
			const projectResponse = await registered;
			const project = await projectResponse.json();
			expect(projectResponse.status(), JSON.stringify(project)).toBe(201);
			projectId = project.id;
			const grant = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/extension-grants`, {
				method: "PUT", body: JSON.stringify({ packId: REAL_IMPORT_PACK, hookId: REAL_IMPORT_HOOK, capability: "decide" }),
			});
			expect(grant.status, await grant.clone().text()).toBe(200);
			releaseProjection!();

			const decisions = page.locator('[data-testid="project-import-decisions"]');
			await expect(decisions).toContainText(REAL_IMPORT_QUESTION, { timeout: 10_000 });
			await decisions.locator("label.ask-option").filter({ hasText: "Fast mode" }).click();
			const proposal = decisions.locator('[data-testid="project-import-proposal"]');
			await expect(proposal).toContainText("browser-rejected-import-role", { timeout: 10_000 });
			await proposal.getByRole("button", { name: "Reject" }).click();
			await expect(proposal).toHaveCount(0, { timeout: 10_000 });
			const roles = await apiFetch(`/api/roles?projectId=${encodeURIComponent(projectId)}`);
			expect((await roles.json()).roles).not.toEqual(expect.arrayContaining([
				expect.objectContaining({ name: "browser-rejected-import-role" }),
			]));
			const audit = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-decision-requests`);
			expect((await audit.json()).requests).toEqual(expect.arrayContaining([
				expect.objectContaining({ status: "resolved", resolution: { value: { kind: "option", value: "fast" } } }),
			]));
		} finally {
			releaseProjection?.();
			await page.unroute(/\/import-decision-requests\?state=pending$/).catch(() => {});
			if (projectId) await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
			rmSync(dir, { recursive: true, force: true });
		}
	});

	for (const failure of [
		{ label: "503", fail: async (route: Route) => route.fulfill({ status: 503, body: "unavailable" }) },
		{ label: "network abort", fail: async (route: Route) => route.abort("failed") },
	]) {
		test(`does not continue an import when its settled projection returns ${failure.label}`, async ({ page }) => {
			const dir = uniqueDir(`import-decision-${failure.label.replace(/\s/g, "-")}`);
			mkdirSync(join(dir, ".bobbit", "config"), { recursive: true });
			mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
			writeFileSync(join(dir, ".bobbit", "config", "project.yaml"), "name: import-decision-failure\n");
			const requestId = `project-import-${failure.label.replace(/\s/g, "-")}`;
			let projectId = "";
			let pending = true;
			let failProjection = false;
			let sessionPosts = 0;
			page.on("request", (request) => {
				if (request.method() === "POST" && request.url().includes("/api/sessions")) sessionPosts++;
			});
			await page.route(/\/import-decision-requests\?state=pending$/, async (route) => {
				const match = route.request().url().match(/\/api\/projects\/([^/]+)\/import-decision-requests/);
				projectId = match?.[1] ?? projectId;
				if (failProjection) {
					await failure.fail(route);
					return;
				}
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ requests: pending ? [{
						id: requestId,
						status: "pending",
						decisionClass: "deferrable",
						title: "Blocking import decision",
						question: "Choose a safe import mode",
						options: [{ value: "safe", label: "Safe mode" }, { value: "fast", label: "Fast mode" }],
					}] : [] }),
				});
			});
			await page.route(/\/import-decision-requests\/[^/]+\/answer$/, async (route) => {
				pending = false;
				failProjection = true;
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ request: {
						id: requestId,
						status: "resolved",
						decisionClass: "deferrable",
						title: "Blocking import decision",
						question: "Choose a safe import mode",
						options: [{ value: "safe", label: "Safe mode" }, { value: "fast", label: "Fast mode" }],
						resolution: { value: { kind: "option", value: "safe" } },
					} }),
				});
			});

			try {
				await openApp(page);
				await page.locator("button").filter({ hasText: "Add Project" }).first().click();
				await page.locator('input[placeholder="/path/to/project"]').fill(dir);
				await page.locator("button").filter({ hasText: "Continue" }).first().click();
				const decisions = page.locator('[data-testid="project-import-decisions"]');
				await expect(decisions).toBeVisible({ timeout: 10_000 });
				await decisions.locator("label.ask-option").filter({ hasText: "Safe mode" }).click();

				const error = page.locator('[data-testid="project-import-decisions-error"]');
				await expect(error).toBeVisible({ timeout: 10_000 });
				await expect(error).toContainText("Retry to continue");
				await expect(page.locator('[data-testid="add-project-dialog"]')).toBeVisible();
				expect(sessionPosts).toBe(0);

				failProjection = false;
				await error.locator('[data-testid="project-import-decisions-retry"]').click();
				await expect(page.locator('[data-testid="add-project-dialog"]')).not.toBeVisible({ timeout: 10_000 });
				expect(sessionPosts).toBe(0);
			} finally {
				await page.unroute(/\/import-decision-requests\?state=pending$/).catch(() => {});
				await page.unroute(/\/import-decision-requests\/[^/]+\/answer$/).catch(() => {});
				if (projectId) await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	test("auto-import project with existing .bobbit directory", async ({ page }) => {
		let sessionPosts = 0;
		page.on("request", (request) => {
			if (request.method() === "POST" && request.url().includes("/api/sessions")) sessionPosts++;
		});
		// Create a temp dir with .bobbit/config/project.yaml — required for
		// hasBobbit=true since commit 54d5b710 (project.yaml is now the source
		// of truth, not the bare .bobbit/ directory).
		const dir = uniqueDir("bobbit-import");
		mkdirSync(join(dir, ".bobbit", "config"), { recursive: true });
		mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
		writeFileSync(join(dir, ".bobbit", "config", "project.yaml"), "name: test\n");
		writeFileSync(join(dir, "README.md"), "# Test Project\n");

		await openApp(page);

		// Click "Add Project"
		await page.locator("button").filter({ hasText: "Add Project" }).first().click();
		await expect(page.locator('input[placeholder="/path/to/project"]')).toBeVisible({ timeout: 5_000 });

		// Type the path
		await page.locator('input[placeholder="/path/to/project"]').fill(dir);

		// Click Continue
		await page.locator("button").filter({ hasText: "Continue" }).first().click();

		// The dialog should close and the project should appear in the sidebar
		// Wait for dialog to disappear
		await expect(page.locator('input[placeholder="/path/to/project"]')).not.toBeVisible({ timeout: 10_000 });

		// Existing-project registration previously ended at dialog cleanup; it
		// must not manufacture a project-assistant session after an empty import projection.
		expect(sessionPosts).toBe(0);

		// Verify the project was registered via API
		const res = await apiFetch("/api/projects");
		const data = await res.json();
		const projects = data.projects || data || [];
		const imported = projects.find((p: any) => p.rootPath === dir);
		expect(imported).toBeTruthy();

		// Cleanup: remove the project
		if (imported) {
			await apiFetch(`/api/projects/${imported.id}`, { method: "DELETE" });
		}
	});


	test("creates a typed nonexistent directory and continues to scaffolding assistant", async ({ page }) => {
		const parent = uniqueDir("create-parent");
		const target = join(parent, "new-project");
		let provisionalProjectId: string | undefined;

		try {
			await openApp(page);
			await page.locator("button").filter({ hasText: "Add Project" }).first().click();
			const pathInput = page.locator('input[placeholder="/path/to/project"]');
			await expect(pathInput).toBeVisible({ timeout: 5_000 });
			await pathInput.fill(target);

			await expectInlineCreateCentered(page);
			await expect(page.locator('[data-testid="preflight-check"][data-check-id="path.exists"]')).toHaveCount(0);
			const createButton = createDirectoryButton(page);
			await expect(createButton).toBeVisible({ timeout: 10_000 });
			await expect(createButton).toBeEnabled();

			const refreshedDetection = page.waitForResponse((resp) => {
				if (!resp.url().includes("/api/projects/detect") || resp.request().method() !== "POST") return false;
				try {
					const body = resp.request().postDataJSON?.() ?? JSON.parse(resp.request().postData() || "{}");
					return body?.path === target && existsSync(target);
				} catch {
					return false;
				}
			});
			await createButton.click();
			await refreshedDetection;

			await expect(page.locator(ADD_PROJECT.dialog)).toBeVisible();
			await expect(pathInput).toHaveValue(target);
			expect(existsSync(target)).toBe(true);
			await expect(inlineCreate(page)).toHaveCount(0, { timeout: 10_000 });
			await expect(page.locator(ADD_PROJECT.statusSlot)).not.toContainText("Directory doesn't exist");
			await expect(page.locator(ADD_PROJECT.createError)).toHaveCount(0);
			await expect(page.locator(ADD_PROJECT.pickerSuggestions)).toHaveCount(0);
			const continueButton = page.locator("button").filter({ has: page.locator(ADD_PROJECT.continue) }).first();
			await expect(continueButton).toBeEnabled({ timeout: 10_000 });

			const sessionPost = page.waitForResponse((resp) => {
				if (!resp.url().includes("/api/sessions") || resp.request().method() !== "POST") return false;
				try {
					const body = resp.request().postDataJSON?.() ?? JSON.parse(resp.request().postData() || "{}");
					return body?.assistantType === "project-scaffolding" && body?.cwd === target;
				} catch {
					return false;
				}
			});
			await continueButton.click();
			const sessionResponse = await sessionPost;
			const session = await sessionResponse.json() as { provisionalProjectId?: string };
			expect(session.provisionalProjectId).toBeTruthy();
			provisionalProjectId = session.provisionalProjectId;
			await expect(pathInput).not.toBeVisible({ timeout: 10_000 });

			await page.reload();
			await expect(page.locator(ADD_PROJECT.dialog)).not.toBeVisible({ timeout: 5_000 });
		} finally {
			if (provisionalProjectId) {
				const removed = await apiFetch(`/api/projects/${provisionalProjectId}`, { method: "DELETE" });
				expect(removed.ok).toBe(true);
			}
			rmSync(parent, { recursive: true, force: true });
		}
	});

	test("already-existing create response refreshes detection so continue can be used", async ({ page }) => {
		const parent = uniqueDir("create-already-exists");
		const target = join(parent, "existing-project");
		const createRoute = "**/api/create-directory";

		try {
			await openApp(page);
			await page.locator("button").filter({ hasText: "Add Project" }).first().click();
			const pathInput = page.locator('input[placeholder="/path/to/project"]');
			await expect(pathInput).toBeVisible({ timeout: 5_000 });
			await pathInput.fill(target);

			await expectInlineCreateCentered(page);
			const createButton = createDirectoryButton(page);
			await expect(createButton).toBeVisible({ timeout: 10_000 });
			await page.route(createRoute, async (route) => {
				if (route.request().method() !== "POST") return route.fallback();
				mkdirSync(target, { recursive: true });
				await route.fulfill({
					status: 409,
					contentType: "application/json",
					body: JSON.stringify({ error: "Already exists", code: "already_exists" }),
				});
			});
			await createButton.click();

			await expect(page.locator(ADD_PROJECT.dialog)).toBeVisible();
			expect(existsSync(target)).toBe(true);
			await expect(inlineCreate(page)).toHaveCount(0, { timeout: 10_000 });
			await expect(page.locator(ADD_PROJECT.createError)).toHaveCount(0);
			await expect(footerCreateButton(page)).toHaveCount(0);
			await expect(page.locator("button").filter({ has: page.locator(ADD_PROJECT.continue) }).first()).toBeEnabled({ timeout: 10_000 });
		} finally {
			await page.unroute(createRoute).catch(() => {});
			rmSync(parent, { recursive: true, force: true });
		}
	});

	test("create directory surfaces routed server errors without closing the dialog", async ({ page }) => {
		const parent = uniqueDir("create-routed-errors");
		const deniedTarget = join(parent, "permission-denied");
		const failedTarget = join(parent, "create-failed");
		const routePath = "**/api/create-directory";
		const responses = new Map([
			[deniedTarget, { status: 403, error: "Permission denied", code: "permission_denied", message: "Permission denied creating this directory." }],
			[failedTarget, { status: 500, error: "Disk exploded", code: "create_failed", message: "Could not create directory: Disk exploded" }],
		]);

		try {
			await page.route(routePath, async (route) => {
				if (route.request().method() !== "POST") return route.fallback();
				let requestedPath = "";
				try {
					requestedPath = JSON.parse(route.request().postData() || "{}").path || "";
				} catch {
					requestedPath = "";
				}
				const response = responses.get(requestedPath);
				if (!response) return route.fallback();
				await route.fulfill({
					status: response.status,
					contentType: "application/json",
					body: JSON.stringify({ error: response.error, code: response.code }),
				});
			});

			await openApp(page);
			await page.locator("button").filter({ hasText: "Add Project" }).first().click();
			const pathInput = page.locator('input[placeholder="/path/to/project"]');
			await expect(pathInput).toBeVisible({ timeout: 5_000 });
			const createButton = createDirectoryButton(page);

			for (const [value, { message }] of responses) {
				await pathInput.fill(value);
				await expectInlineCreateCentered(page);
				await expect(createButton).toBeVisible({ timeout: 10_000 });
				await expect(createButton).toBeEnabled();
				await createButton.click();
				const inlineError = page.locator(ADD_PROJECT.statusSlot).locator(ADD_PROJECT.createError);
				await expect(inlineError).toHaveText(message, { timeout: 5_000 });
				await expect(page.locator(ADD_PROJECT.footer).locator(ADD_PROJECT.createError)).toHaveCount(0);
				await expect(footerCreateButton(page)).toHaveCount(0);
				await expect(page.locator(ADD_PROJECT.dialog)).toBeVisible();
				await expect(pathInput).toHaveValue(value);
			}
		} finally {
			await page.unroute(routePath).catch(() => {});
			rmSync(parent, { recursive: true, force: true });
		}
	});

	test("create directory surfaces structured errors inline without closing the dialog", async ({ page }) => {
		const parent = uniqueDir("create-errors");
		const routePath = "**/api/create-directory";
		const cases = [
			{
				value: join(parent, "invalid-path"),
				status: 400,
				code: "invalid_path",
				error: "Enter an absolute directory path.",
				message: "Enter an absolute directory path.",
			},
			{
				value: join(parent, "missing-parent"),
				status: 404,
				code: "parent_not_found",
				error: "The parent directory does not exist",
				message: "The parent directory does not exist.",
			},
			{
				value: join(parent, "file-target"),
				status: 409,
				code: "exists_as_file",
				error: "A file already exists at that path",
				message: "A file already exists at that path.",
			},
		];

		try {
			await page.route(routePath, async (route) => {
				if (route.request().method() !== "POST") return route.fallback();
				let requestedPath = "";
				try {
					requestedPath = JSON.parse(route.request().postData() || "{}").path || "";
				} catch {
					requestedPath = "";
				}
				const response = cases.find((entry) => entry.value === requestedPath);
				if (!response) return route.fallback();
				await route.fulfill({
					status: response.status,
					contentType: "application/json",
					body: JSON.stringify({ error: response.error, code: response.code }),
				});
			});

			await openApp(page);
			await page.locator("button").filter({ hasText: "Add Project" }).first().click();
			const pathInput = page.locator('input[placeholder="/path/to/project"]');
			await expect(pathInput).toBeVisible({ timeout: 5_000 });
			const createButton = createDirectoryButton(page);

			for (const { value, message } of cases) {
				await pathInput.fill(value);
				await expectInlineCreateCentered(page);
				await expect(createButton).toBeVisible({ timeout: 10_000 });
				await expect(createButton).toBeEnabled();
				await createButton.click();
				const inlineError = page.locator(ADD_PROJECT.statusSlot).locator(ADD_PROJECT.createError);
				await expect(inlineError).toHaveText(message, { timeout: 5_000 });
				await expect(page.locator(ADD_PROJECT.footer).locator(ADD_PROJECT.createError)).toHaveCount(0);
				await expect(footerCreateButton(page)).toHaveCount(0);
				await expect(page.locator(ADD_PROJECT.dialog)).toBeVisible();
				await expect(pathInput).toHaveValue(value);
			}
		} finally {
			await page.unroute(routePath).catch(() => {});
			rmSync(parent, { recursive: true, force: true });
		}
	});

	test("non-empty directory without .bobbit opens project assistant", async ({ page }) => {
		// Create a temp dir with a file (non-empty, no .bobbit)
		const dir = uniqueDir("nonempty");
		writeFileSync(join(dir, "package.json"), '{"name":"test-proj"}');

		await openApp(page);

		// Click "Add Project"
		await page.locator("button").filter({ hasText: "Add Project" }).first().click();
		await expect(page.locator('input[placeholder="/path/to/project"]')).toBeVisible({ timeout: 5_000 });

		// Type the path
		await page.locator('input[placeholder="/path/to/project"]').fill(dir);

		// Click Continue
		await page.locator("button").filter({ hasText: "Continue" }).first().click();

		// Dialog should close
		await expect(page.locator('input[placeholder="/path/to/project"]')).not.toBeVisible({ timeout: 10_000 });

		// A project assistant session should be created — verify via URL hash containing session ID
		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toMatch(/#\/session\//);
		}).toPass({ timeout: 10_000 });

		// Verify the textarea is visible (session is connected)
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });
	});
});
