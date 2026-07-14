/**
 * Journey: Cross-project proposal banner + accept routing (design §5, §7).
 *
 * A `propose_*` made from one project may target a DIFFERENT project via its
 * optional `projectId`. When the resolved target differs from the proposer's
 * session project the proposal panel must show a prominent "Proposing into
 * <Target Project>" banner (data-testid="cross-project-banner") tinted with the
 * target's accent. When the target equals the proposer's project (the common
 * case) NO banner renders and the panel is unchanged.
 *
 * This spec drives the UNIFIED `remote.onProposal` path directly (the same path
 * a server-pushed `proposal_update {source:"seed"}` frame takes — see
 * cross-session-proposal-mirror.journey.spec.ts) from a plain session in the
 * "default" project, seeding proposals whose `projectId` names a second,
 * separately-registered project ("target").
 *
 * Asserts, per design §7:
 *   (i)  cross-project role/goal/project proposals show the banner with the
 *        human-readable TARGET name;
 *   (ii) a same-project role proposal (projectId omitted → session's project)
 *        shows NO banner;
 *   (iii) accept routes to the target — for the goal proposal we now DRIVE THE
 *        REAL ACCEPT: click "Create Goal" and assert, via the goals REST API,
 *        that the newly-created goal's `projectId` equals the TARGET project
 *        (not the proposer's session project). The previous
 *        `previewProjectId === targetId` proxy is retained as a pre-accept
 *        sanity check, but the load-bearing assertion is now on the real
 *        created entity. (Seed-endpoint accept routing for role/tool/staff/
 *        project is owned by the server task; those banner assertions do not
 *        depend on it.)
 */
import { test, expect, openApp, createSessionViaUI, registerProject, apiFetch, deleteGoal, defaultProjectId } from "../_helpers/journey-fixture.js";
import type { Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Deterministic UI behaviour — a failure here is a bug, not a flake budget.
test.describe.configure({ retries: 0 });

async function ensureUnifiedProposalReady(page: Page): Promise<void> {
	await page.waitForFunction(() => {
		const s = (window as any).bobbitState ?? (window as any).__bobbitState;
		return !!s?.remoteAgent && typeof s.remoteAgent.onProposal === "function";
	}, undefined, { timeout: 20_000 });
}

/** Drive the unified onProposal callback directly (server "seed" broadcast path). */
async function driveUnifiedProposal(
	page: Page,
	type: string,
	fields: Record<string, unknown>,
	source = "seed",
): Promise<void> {
	await page.evaluate(
		({ type, fields, source }) => {
			const s = (window as any).bobbitState ?? (window as any).__bobbitState;
			const ra = s?.remoteAgent;
			if (!ra || typeof ra.onProposal !== "function") {
				throw new Error("remoteAgent.onProposal handler missing");
			}
			const rev = ((s?.activeProposals?.[type]?.rev ?? 0) as number) + 1;
			ra.onProposal(type, fields, false, rev, source);
		},
		{ type, fields, source },
	);
}

/** Focus the proposal workspace tab and wait for its panel container to mount. */
async function activatePanel(page: Page, tabTitle: string, panelSelector: string): Promise<void> {
	const pill = page.locator(`.goal-tab-pill[title="${tabTitle}"]`).first();
	await expect(pill, `${tabTitle} proposal tab pill should appear`).toBeVisible({ timeout: 15_000 });
	await pill.click();
	await expect(page.locator(panelSelector).first(), `${panelSelector} should mount`).toBeVisible({ timeout: 15_000 });
}

/**
 * Register a second project so proposals can cross-target it.
 *
 * Banner-only tests keep `seedWorkflows: false` (a bare registry entry is all
 * the banner resolver needs). The goal-accept test passes `withWorkflows: true`
 * so the target has a resolvable workflow set — otherwise the goal panel's
 * "no workflows" guard blocks Create and the accept never fires.
 */
async function registerTargetProject(opts?: { withWorkflows?: boolean }): Promise<{ id: string; name: string }> {
	const dir = mkdtempSync(join(tmpdir(), `bobbit-v2-xproj-${process.env.E2E_PORT ?? "0"}-`));
	const name = `v2-xproj-target-${Date.now()}`;
	const proj = await registerProject({ name, rootPath: dir, seedWorkflows: opts?.withWorkflows ? undefined : false });
	return { id: proj.id, name };
}

test.describe("Journey: cross-project proposal banner (design §7)", () => {
	test("role proposal targeting another project shows the cross-project banner", async ({ page }) => {
		const target = await registerTargetProject();
		await openApp(page);
		await createSessionViaUI(page);
		await ensureUnifiedProposalReady(page);

		// Proposer session is in "default"; proposal targets the "target" project.
		await driveUnifiedProposal(page, "role", {
			name: "qa-runner",
			label: "QA Runner",
			prompt: "You run QA passes on changed code.",
			tools: "bash,read,grep",
			accessory: "flask",
			projectId: target.id,
		});
		await activatePanel(page, "Role", '[data-panel="role-proposal"]');

		const banner = page.locator('[data-panel="role-proposal"] [data-testid="cross-project-banner"]').first();
		await expect(banner, "cross-project banner should render for a cross-project role proposal").toBeVisible({ timeout: 10_000 });
		await expect(banner).toContainText("Proposing into");
		await expect(banner).toContainText(target.name);
		// The banner must show the human-readable NAME, never the raw id.
		await expect(banner).not.toContainText(target.id);
	});

	test("same-project role proposal shows NO banner", async ({ page }) => {
		// Register a target project too, so the registry has >1 project (proves the
		// absence of a banner is due to same-project resolution, not a missing registry entry).
		await registerTargetProject();
		await openApp(page);
		await createSessionViaUI(page);
		await ensureUnifiedProposalReady(page);

		// projectId omitted → defaults to the proposer's session project → same-project.
		await driveUnifiedProposal(page, "role", {
			name: "local-role",
			label: "Local Role",
			prompt: "A role created in this same project.",
			tools: "read",
		});
		await activatePanel(page, "Role", '[data-panel="role-proposal"]');

		// Panel is mounted; assert the banner is absent (common-case: no extra chrome).
		await expect(
			page.locator('[data-panel="role-proposal"] [data-testid="cross-project-banner"]'),
			"no cross-project banner for a same-project proposal",
		).toHaveCount(0);
	});

	test("goal proposal targeting another project banners AND routes accept to the target", async ({ page }) => {
		test.setTimeout(90_000);
		const target = await registerTargetProject({ withWorkflows: true });
		const proposerProjectId = await defaultProjectId();
		expect(proposerProjectId, "proposer session must resolve to the default project").toBeTruthy();
		expect(target.id, "target must be a DIFFERENT project than the proposer").not.toBe(proposerProjectId);

		// Unique title so we can pinpoint the created goal in the API list.
		const goalTitle = `Cross-project goal ${Date.now()}`;
		let createdGoalId: string | undefined;

		try {
			await openApp(page);
			await createSessionViaUI(page);
			await ensureUnifiedProposalReady(page);

			await driveUnifiedProposal(page, "goal", {
				title: goalTitle,
				spec: "A goal proposed from the default project but targeting the registered target project.",
				projectId: target.id,
			});
			await activatePanel(page, "Goal", '[data-panel="goal-proposal"]');

			const banner = page.locator('[data-panel="goal-proposal"] [data-testid="cross-project-banner"]').first();
			await expect(banner, "cross-project banner should render for a cross-project goal proposal").toBeVisible({ timeout: 10_000 });
			await expect(banner).toContainText(target.name);

			// Pre-accept sanity: the goal-create path uses state.previewProjectId,
			// which must resolve to the explicit target before we click Create.
			await expect
				.poll(async () => page.evaluate(() => {
					const s = (window as any).bobbitState ?? (window as any).__bobbitState;
					return s?.previewProjectId ?? null;
				}), { timeout: 10_000 })
				.toBe(target.id);

			// Keep the accept lightweight: don't auto-start a team (avoids spawning a
			// team-lead session for a goal the test tears down immediately).
			const autoStart = page.locator('[data-panel="goal-proposal"] label:has-text("Auto-start team") input.toggle-switch').first();
			if (await autoStart.isChecked().catch(() => false)) {
				await autoStart.uncheck();
			}

			// (iii) REAL ACCEPT: click "Create Goal" once the workflow-backed target
			// has enabled the primary submit, then verify the created entity lands in
			// the TARGET project via the goals REST API.
			const createBtn = page.locator('[data-panel="goal-proposal"] [data-testid="proposal-primary-submit"] button').first();
			await expect(createBtn, "Create Goal must become enabled once the target's workflows load").toBeEnabled({ timeout: 20_000 });
			await createBtn.click();

			// The goal proposal panel closes on a successful create.
			await expect(
				page.locator('[data-panel="goal-proposal"]'),
				"goal proposal panel should close after a successful accept",
			).toHaveCount(0, { timeout: 20_000 });

			// Authoritative assertion: the newly-created goal exists and its projectId
			// is the TARGET, not the proposer's session project.
			let createdGoal: { id: string; title?: string; projectId?: string } | undefined;
			await expect.poll(async () => {
				const resp = await apiFetch("/api/goals");
				if (!resp.ok) return false;
				const data = await resp.json();
				const goals = (Array.isArray(data) ? data : data.goals ?? []) as Array<{ id: string; title?: string; projectId?: string }>;
				createdGoal = goals.find(g => g.title === goalTitle);
				return !!createdGoal;
			}, {
				timeout: 20_000,
				message: "the accepted goal should appear in the goals API list",
			}).toBe(true);

			createdGoalId = createdGoal!.id;
			expect(createdGoal!.projectId, "accepted cross-project goal must be created in the TARGET project").toBe(target.id);
			expect(createdGoal!.projectId, "accepted cross-project goal must NOT land in the proposer's project").not.toBe(proposerProjectId);
		} finally {
			if (createdGoalId) await deleteGoal(createdGoalId).catch(() => {});
		}
	});

	test("project proposal editing another registered project banners AND takes the EDIT path", async ({ page }) => {
		const target = await registerTargetProject();
		await openApp(page);
		await createSessionViaUI(page);
		await ensureUnifiedProposalReady(page);

		// A registered-mode project proposal naming an explicit, registered target.
		await driveUnifiedProposal(page, "project", {
			name: target.name,
			projectId: target.id,
			test_command: "npm test",
		});
		await activatePanel(page, "Project", '[data-panel="project-proposal"]');

		const banner = page.locator('[data-panel="project-proposal"] [data-testid="cross-project-banner"]').first();
		await expect(banner, "cross-project banner should render when editing another registered project").toBeVisible({ timeout: 10_000 });
		await expect(banner).toContainText(target.name);

		// Finding 2: an explicit, REGISTERED target must resolve the proposal to
		// "registered" (EDIT) mode, never provisional/promote. resolveProjectMode
		// derives mode from the target project, not the proposer session.
		await expect
			.poll(async () => page.evaluate(() => {
				const s = (window as any).bobbitState ?? (window as any).__bobbitState;
				return s?.activeProposals?.project?.mode ?? null;
			}), { timeout: 10_000 })
			.toBe("registered");
		// The `projectId` routing key is never persisted into project config on
		// accept (buildProjectConfigDiff excludes it) — pinned by the focused unit
		// test tests2/core/project-proposal-diff.test.ts.
	});

	test("STALE MODE (PR #1005 P1): a project slot re-evaluates mode when a LATER revision adds a cross-project target", async ({ page }) => {
		// Regression pin for the slot-update recompute fix in
		// src/app/session-manager.ts. A project proposal slot FIRST created without
		// an explicit fields.projectId is create intent, regardless of its source
		// session. If a LATER revision adds a cross-project target, the slot must
		// RE-EVALUATE the mode from the new fields — the buggy code kept the sticky
		// `prev.mode`, so an accept took the stale create branch.
		await openApp(page);
		await createSessionViaUI(page);
		await ensureUnifiedProposalReady(page);

		// Inject a PROVISIONAL target into the client-side project registry. A real
		// registered project (via the REST API) is never provisional, so we seed the
		// provisional target directly — resolveProjectMode reads state.projects.
		const provisionalTargetId = `v2-provisional-target-${Date.now()}`;
		await page.evaluate((id) => {
			const s = (window as any).bobbitState ?? (window as any).__bobbitState;
			s.projects.push({ id, name: "Provisional Target", provisional: true });
		}, provisionalTargetId);

		// Rev 1: NO projectId → create mode, independent of the source session.
		await driveUnifiedProposal(page, "project", {
			name: "same-project-first",
			test_command: "npm test",
		});
		await expect
			.poll(async () => page.evaluate(() => {
				const s = (window as any).bobbitState ?? (window as any).__bobbitState;
				return s?.activeProposals?.project?.mode ?? null;
			}), { timeout: 10_000 })
			.toBe("create");

		// Rev 2 (later revision): ADD an explicit provisional cross-project target.
		// The recompute must flip the mode create → provisional. With the stale
		// `prev.mode` code this stayed "create".
		await driveUnifiedProposal(page, "project", {
			name: "same-project-first",
			test_command: "npm test",
			projectId: provisionalTargetId,
		});
		await expect
			.poll(async () => page.evaluate(() => {
				const s = (window as any).bobbitState ?? (window as any).__bobbitState;
				return s?.activeProposals?.project?.mode ?? null;
			}), { timeout: 10_000 })
			.toBe("provisional");
	});

	test("tool proposal targeting another project routes 'View Tool' to the target scope", async ({ page }) => {
		const target = await registerTargetProject();
		await openApp(page);
		await createSessionViaUI(page);
		await ensureUnifiedProposalReady(page);

		await driveUnifiedProposal(page, "tool", {
			tool: "cross-tool",
			name: "cross-tool",
			projectId: target.id,
		});
		await activatePanel(page, "Tool", '[data-panel="tool-proposal"]');

		const banner = page.locator('[data-panel="tool-proposal"] [data-testid="cross-project-banner"]').first();
		await expect(banner, "cross-project banner should render for a cross-project tool proposal").toBeVisible({ timeout: 10_000 });
		await expect(banner).toContainText(target.name);

		// The config-scope test seam attaches once proposal-panels.ts has loaded
		// (i.e. after the panel mounts above).
		await page.waitForFunction(
			() => typeof (window as any).__bobbitGetConfigScope === "function",
			undefined,
			{ timeout: 20_000 },
		);

		// Finding 1: clicking "View Tool" must scope the tool editor to the TARGET
		// project so the tool is edited/saved in the target's config store.
		await page.locator('[data-panel="tool-proposal"] [data-testid="proposal-primary-submit"] button').first().click();
		await expect
			.poll(async () => page.evaluate(() => (window as any).__bobbitGetConfigScope?.() ?? null), { timeout: 10_000 })
			.toBe(target.id);
	});
});
