/**
 * Journey: Cross-session role/tool/staff proposal panels — REPRODUCING TEST.
 *
 * Bug (goal fix-cross-sess-163b4f08): when a role / tool / staff proposal reaches
 * the side-panel through the UNIFIED `remote.onProposal` path ALONE — i.e. via a
 * `proposal_update` frame whose source is "seed" / "rehydrate" / "edit" /
 * "restore" (or the fast-path switch-back), NOT via the live tool-use scan that
 * also fires the legacy per-type `onRoleProposal` / `onToolProposal` /
 * `onStaffProposal` callback — the legacy FORM-MIRROR state the panels render
 * from (rolePreviewName…, toolPreviewName…, staffPreviewName…) is never
 * populated. The panel renders blank and its primary submit button stays
 * disabled (role/staff) or is not rendered at all (tool), so the proposal can't
 * be accepted.
 *
 * Root cause: the unified onProposal callback (src/app/session-manager.ts ~1926)
 * writes `state.activeProposals[type]` for every type, but only bridges the
 * merged fields into the form-mirror for `type === "goal" && assistantType ===
 * "goal"` (~line 2074). There is NO role/tool/staff bridge — so a NON-matching
 * session (here a plain session, `assistantType === null`) leaves the mirror
 * empty when the proposal arrives through the unified path alone.
 *
 * This spec creates a plain session (NOT a role/tool/staff assistant) and drives
 * the unified path directly — the exact path a server "seed" broadcast takes
 * (same technique as tests2/browser/e2e/proposal-inline-comments.spec.ts). It
 * then asserts the form-mirror is populated and the primary submit is
 * enabled/rendered.
 *
 * EXPECTED TO FAIL on current HEAD (mirror empty → submit disabled/absent). It
 * passes once the unified onProposal bridge mirrors role/tool/staff fields.
 */
import {
	test,
	expect,
	openApp,
	createSessionViaUI,
	createSession,
	deleteSession,
	defaultProjectId,
	navigateToHash,
} from "../_helpers/journey-fixture.js";
import type { Page } from "@playwright/test";

// Deterministic bug repro — a failure here is the bug, not a flake budget.
test.describe.configure({ retries: 0 });

async function ensureUnifiedProposalReady(page: Page): Promise<void> {
	await page.waitForFunction(() => {
		const s = (window as any).bobbitState ?? (window as any).__bobbitState;
		return !!s?.remoteAgent && typeof s.remoteAgent.onProposal === "function";
	}, undefined, { timeout: 20_000 });
}

async function waitForActiveSessionProjectRoot(page: Page, expectedSessionId?: string): Promise<void> {
	await page.waitForFunction((expected: string | undefined) => {
		const s = (window as any).bobbitState ?? (window as any).__bobbitState;
		const projects = Array.isArray(s?.projects) ? s.projects : [];
		if (projects.length === 0) return false;

		const selectedSessionId = typeof s?.selectedSessionId === "string" ? s.selectedSessionId : "";
		const routeSessionId = window.location.hash.match(/^#\/session\/([\w-]+)/)?.[1] ?? "";
		const sessionId = expected || selectedSessionId || routeSessionId;
		if (!sessionId) return false;
		if (expected && (selectedSessionId !== expected || routeSessionId !== expected)) return false;

		const sessions = [
			...(Array.isArray(s?.gatewaySessions) ? s.gatewaySessions : []),
			...(Array.isArray(s?.archivedSessions) ? s.archivedSessions : []),
		];
		const session = sessions.find((entry: any) => entry?.id === sessionId);
		const projectId = session?.projectId || s?.chatPanel?.agentInterface?.projectId;
		if (typeof projectId !== "string" || projectId.trim() === "") return false;

		const project = projects.find((entry: any) => entry?.id === projectId);
		return !!project
			&& project.id !== "headquarters"
			&& project.kind !== "headquarters"
			&& typeof project.rootPath === "string"
			&& project.rootPath.trim() !== "";
	}, expectedSessionId, { timeout: 20_000 });
}

/**
 * Drive the unified onProposal callback directly — the SAME path a server-pushed
 * `proposal_update {source:"seed"}` frame takes, and the ONLY path a
 * cross-session role/tool/staff proposal reaches the panel through. Bypasses the
 * live tool-use scan (which would also fire the legacy per-type callback and
 * mask the bug).
 */
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

async function assertNotMatchingAssistant(page: Page, type: string): Promise<void> {
	const at = await page.evaluate(
		() => ((window as any).bobbitState ?? (window as any).__bobbitState)?.assistantType ?? null,
	);
	expect(at, `test must run in a session whose assistantType is not '${type}' (cross-session repro)`).not.toBe(type);
}

test.describe("Journey: cross-session proposal panels populate form-mirror (unified onProposal)", () => {
	test("role proposal via unified seed path populates mirror + enables Create Role", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await ensureUnifiedProposalReady(page);
		await assertNotMatchingAssistant(page, "role");

		const fields = {
			name: "qa-runner",
			label: "QA Runner",
			prompt: "You run QA passes on changed code.",
			tools: "bash,read,grep",
			accessory: "flask",
		};
		await driveUnifiedProposal(page, "role", fields, "seed");
		await activatePanel(page, "Role", '[data-panel="role-proposal"]');

		const r = await page.evaluate(() => {
			const s = (window as any).bobbitState ?? (window as any).__bobbitState;
			const btn = document.querySelector(
				'[data-panel="role-proposal"] [data-testid="proposal-primary-submit"] button',
			) as HTMLButtonElement | null;
			return {
				name: s.rolePreviewName,
				label: s.rolePreviewLabel,
				prompt: s.rolePreviewPrompt,
				tools: s.rolePreviewTools,
				accessory: s.rolePreviewAccessory,
				submitPresent: !!btn,
				submitDisabled: btn ? btn.disabled : null,
			};
		});

		expect(r.name, "CROSS_SESSION_MIRROR_BUG: rolePreviewName not populated from unified onProposal seed path").toBe(fields.name);
		expect(r.label, "CROSS_SESSION_MIRROR_BUG: rolePreviewLabel not populated from unified onProposal seed path").toBe(fields.label);
		expect(r.prompt, "CROSS_SESSION_MIRROR_BUG: rolePreviewPrompt not populated").toBe(fields.prompt);
		expect(r.tools, "CROSS_SESSION_MIRROR_BUG: rolePreviewTools not populated").toBe(fields.tools);
		expect(r.accessory, "CROSS_SESSION_MIRROR_BUG: rolePreviewAccessory not populated").toBe(fields.accessory);
		expect(r.submitPresent, "CROSS_SESSION_MIRROR_BUG: Create Role submit button missing").toBe(true);
		expect(r.submitDisabled, "CROSS_SESSION_MIRROR_BUG: Create Role submit disabled — role form-mirror empty").toBe(false);
	});

	test("tool proposal via unified seed path populates mirror + renders submit", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await ensureUnifiedProposalReady(page);
		await assertNotMatchingAssistant(page, "tool");

		const fields = {
			tool: "qa-widget",
			action: "docs",
			content: "# QA Widget\nA tool that runs QA checks.",
		};
		await driveUnifiedProposal(page, "tool", fields, "seed");
		await activatePanel(page, "Tool", '[data-panel="tool-proposal"]');

		const r = await page.evaluate(() => {
			const s = (window as any).bobbitState ?? (window as any).__bobbitState;
			const btn = document.querySelector(
				'[data-panel="tool-proposal"] [data-testid="proposal-primary-submit"] button',
			) as HTMLButtonElement | null;
			return {
				name: s.toolPreviewName,
				submitPresent: !!btn,
				submitDisabled: btn ? btn.disabled : null,
			};
		});

		expect(r.name, "CROSS_SESSION_MIRROR_BUG: toolPreviewName not populated from unified onProposal seed path").toBe(fields.tool);
		expect(r.submitPresent, "CROSS_SESSION_MIRROR_BUG: Create Tool submit button not rendered — tool form-mirror empty").toBe(true);
		expect(r.submitDisabled, "CROSS_SESSION_MIRROR_BUG: Create Tool submit disabled").not.toBe(true);
	});

	test("staff proposal via unified seed path populates mirror + enables submit", async ({ page }) => {
		// Staff proposals default cwd from the active session's project root. Create
		// the session against the harness default project directly so a transient
		// sidebar project-list race cannot fall back to a Headquarters session.
		const projectId = await defaultProjectId();
		expect(projectId, "staff proposal setup needs a non-Headquarters default project").toBeTruthy();
		const sessionId = await createSession({ projectId });
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await ensureUnifiedProposalReady(page);
			await assertNotMatchingAssistant(page, "staff");
			await waitForActiveSessionProjectRoot(page, sessionId);

			const fields = {
				name: "helper-bot",
				description: "A little helper agent.",
				prompt: "You are a helpful staff agent.",
				triggers: '[{"type":"cron","value":"0 9 * * *"}]',
				cwd: "",
			};
			await driveUnifiedProposal(page, "staff", fields, "seed");
			await activatePanel(page, "Staff", '[data-panel="staff-proposal"]');

			const r = await page.evaluate(() => {
				const s = (window as any).bobbitState ?? (window as any).__bobbitState;
				const btn = document.querySelector(
					'[data-panel="staff-proposal"] [data-testid="proposal-primary-submit"] button',
				) as HTMLButtonElement | null;
				return {
					name: s.staffPreviewName,
					description: s.staffPreviewDescription,
					prompt: s.staffPreviewPrompt,
					triggers: s.staffPreviewTriggers,
					cwd: s.staffPreviewCwd,
					submitPresent: !!btn,
					submitDisabled: btn ? btn.disabled : null,
				};
			});

			expect(r.name, "CROSS_SESSION_MIRROR_BUG: staffPreviewName not populated from unified onProposal seed path").toBe(fields.name);
			expect(r.description, "CROSS_SESSION_MIRROR_BUG: staffPreviewDescription not populated").toBe(fields.description);
			expect(r.prompt, "CROSS_SESSION_MIRROR_BUG: staffPreviewPrompt not populated").toBe(fields.prompt);
			expect(r.triggers, "CROSS_SESSION_MIRROR_BUG: staffPreviewTriggers not populated").toBe(fields.triggers);
			expect(r.cwd, "CROSS_SESSION_MIRROR_BUG: staffPreviewCwd not populated (should default to project root)").not.toBe("");
			expect(r.submitPresent, "CROSS_SESSION_MIRROR_BUG: staff submit button missing").toBe(true);
			expect(r.submitDisabled, "CROSS_SESSION_MIRROR_BUG: staff submit disabled — staff form-mirror empty").toBe(false);
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
