/**
 * Browser E2E — Orchestration Core sub-goal A: the agent-facing team_* surface
 * as seen THROUGH THE BROWSER UI (M4).
 *
 * This spec maximises *real* browser coverage of the user-visible orchestration
 * flows; the granular route mechanics (model inheritance, terminal/timeout
 * mapping, caller→owner authz, etc.) stay pinned in the API specs
 * (tests/e2e/team-delegate.spec.ts, team-wait-semantics.spec.ts,
 * orchestrate-restart.spec.ts) which this file deliberately does NOT duplicate.
 *
 * Coverage here:
 *   1. Blocking one-shot team_delegate → the single completed DelegateRenderer
 *      card (canned mock tool result; deterministic, no LLM).
 *   2. Parallel team_delegate → the multi-child card.
 *   3. The non-blocking INTERACTIVE flow spawn → prompt → wait → read → dismiss
 *      driven against the REAL /orchestrate/* routes and observed in the
 *      browser: the spawned child is a real, navigable session whose transcript
 *      renders (the "read" surface), and it disappears from the live session
 *      list after dismiss.
 *   4. The RESTART live-children reminder: after a spawn, invoking the same
 *      public boot hook restoreSessions() runs
 *      (OrchestrationCore.remindOwnersWithLiveChildren) injects the
 *      "[ORCHESTRATION] … gateway restarted …" reminder, which RENDERS in the
 *      parent's transcript; the parent then re-collects via the shared
 *      team_wait route — no transparent resumption.
 *
 * Documented split (M4): the TEAM-LEAD helper case is NOT re-driven through a
 * full team/goal browser setup — a team-lead's team_delegate produces the
 * IDENTICAL DelegateRenderer card asserted in tests 1–2 (the renderer is
 * caller-agnostic), and the team-lead delegate mechanics + own-child /team/*
 * fallback are pinned in the API spec tests/e2e/team-delegate.spec.ts. The
 * restart reminder is driven via the public boot hook rather than a real
 * gateway reboot, because that hook is exactly what restoreSessions() invokes
 * (see tests/e2e/orchestrate-restart.spec.ts) and keeps the browser assertion
 * deterministic.
 */
import { test, expect } from "../gateway-harness.js";
import type { GatewayInfo } from "../gateway-harness.js";
import { apiFetch, createSession, deleteSession, waitForHealth, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, navigateToHash, sendMessage } from "./ui-helpers.js";

/**
 * The /orchestrate/* routes require the caller to authenticate AS the owner via
 * the unforgeable per-session secret. The browser harness does not register the
 * apiFetch auto-injector (only the in-process harness does), so a browser spec
 * acts as the owner by resolving the owner's secret from the live gateway's
 * SessionSecretStore and sending it explicitly.
 */
function ownerSecret(gateway: GatewayInfo, ownerId: string): Record<string, string> {
	return { "X-Bobbit-Session-Secret": gateway.sessionManager.sessionSecretStore.getOrCreateSecret(ownerId) };
}

async function orchestrate(gateway: GatewayInfo, ownerId: string, verb: string, body?: unknown): Promise<{ status: number; json: any }> {
	const resp = await apiFetch(`/api/sessions/${ownerId}/orchestrate/${verb}`, {
		method: "POST",
		headers: ownerSecret(gateway, ownerId),
		body: JSON.stringify(body ?? {}),
	});
	let json: any = undefined;
	try { json = await resp.json(); } catch { /* chunked / empty */ }
	return { status: resp.status, json };
}

async function listChildren(gateway: GatewayInfo, ownerId: string): Promise<string[]> {
	const resp = await apiFetch(`/api/sessions/${ownerId}/orchestrate/children`, { headers: ownerSecret(gateway, ownerId) });
	expect(resp.status).toBe(200);
	return ((await resp.json()).children ?? []).map((c: any) => c.sessionId);
}

async function liveSessionIds(): Promise<string[]> {
	const resp = await apiFetch("/api/sessions");
	expect(resp.status).toBe(200);
	return ((await resp.json()).sessions as Array<{ id: string }>).map((s) => s.id);
}

test.describe("team_delegate card (DelegateRenderer)", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("blocking one-shot delegate renders a single completed card", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		await sendMessage(page, "TEAM_DELEGATE_CARD please run a helper");

		// DelegateRenderer single-child header: "Delegated — <summary> (duration)".
		await expect(page.getByText("Delegated", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText("Summarise the design doc", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
	});

	test("parallel delegate renders a multi-child card", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		await sendMessage(page, "TEAM_DELEGATE_CARD_PARALLEL run two helpers");

		// DelegateRenderer multi-child header: "Delegated to N agents — all completed".
		await expect(page.getByText("Delegated to 2 agents", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
	});
});

test.describe("team_delegate interactive flow (real /orchestrate/* routes, browser-observed)", () => {
	test("non-goal spawn → prompt → wait → read → dismiss surfaces in the UI", async ({ page, gateway }) => {
		const parent = await createSession();
		await waitForSessionStatus(parent, "idle");

		await openApp(page);
		await navigateToHash(page, `#/session/${parent}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		let childId: string | undefined;
		try {
			// 1. Non-blocking spawn — returns immediately with the child id.
			const marker = `interactive-child-${Date.now()}`;
			const spawn = await orchestrate(gateway, parent, "spawn", { instructions: `${marker} first task` });
			expect(spawn.status).toBe(201);
			childId = spawn.json.childSessionId as string;
			expect(childId).toBeTruthy();
			expect(await listChildren(gateway, parent)).toContain(childId);

			// 2. The child runs its spawn instructions and goes idle; wait collects it.
			const wait1 = await orchestrate(gateway, parent, "wait", { childSessionIds: [childId], timeout_ms: 20_000 });
			expect(wait1.status).toBe(200);
			expect(wait1.json.firstIdle).toBe(childId);

			// 3. READ surface: the spawned child is a real, navigable session whose
			//    transcript renders in the browser (its spawn instructions appear).
			await navigateToHash(page, `#/session/${childId}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText(marker, { exact: false }).first()).toBeVisible({ timeout: 15_000 });

			// 4. Follow-up prompt (run-if-idle) + wait for the turn to settle.
			const prompt = await orchestrate(gateway, parent, "prompt", { childSessionId: childId, message: "another task" });
			expect(prompt.status).toBe(200);
			expect(["dispatched", "queued"]).toContain(prompt.json.status);
			await orchestrate(gateway, parent, "wait", { childSessionIds: [childId], timeout_ms: 20_000 });

			// 5. Dismiss — terminate + archive; the child leaves the tracked set and
			//    the live session list (observable back in the parent view).
			const dismiss = await orchestrate(gateway, parent, "dismiss", { childSessionId: childId });
			expect(dismiss.status).toBe(200);
			expect(dismiss.json.ok).toBe(true);
			expect(await listChildren(gateway, parent)).not.toContain(childId);

			await navigateToHash(page, `#/session/${parent}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect.poll(async () => (await liveSessionIds()).includes(childId!), { timeout: 15_000 }).toBe(false);
			childId = undefined;
		} finally {
			if (childId) await orchestrate(gateway, parent, "dismiss", { childSessionId: childId }).catch(() => {});
			await deleteSession(parent).catch(() => {});
		}
	});
});

test.describe("team_delegate restart reminder (browser-observed) + re-collect", () => {
	test("a restored parent is reminded of its live children and re-collects via team_wait", async ({ page, gateway }) => {
		const parent = await createSession();
		await waitForSessionStatus(parent, "idle");

		await openApp(page);
		await navigateToHash(page, `#/session/${parent}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		// Ensure the browser is connected so it receives the injected reminder.
		await page.waitForFunction(
			() => !!(window as any).__bobbitState?.remoteAgent?.connected,
			undefined,
			{ timeout: 15_000 },
		);

		let childId: string | undefined;
		try {
			// A non-blocking child that survives a (simulated) restart.
			const spawn = await orchestrate(gateway, parent, "spawn", { instructions: "restart-survivor helper" });
			expect(spawn.status).toBe(201);
			childId = spawn.json.childSessionId as string;
			expect(await listChildren(gateway, parent)).toContain(childId);
			// Let the child settle so the later re-collect is immediate.
			await orchestrate(gateway, parent, "wait", { childSessionIds: [childId], timeout_ms: 20_000 });

			// Drive the SAME public boot hook restoreSessions() runs on reboot
			// (orchestrate-restart.spec.ts proves the wiring). The owner is
			// reminded of its live children; the reminder is a normal role:"user"
			// transcript message, so it RENDERS in the browser.
			const reminded = await gateway.sessionManager.orchestrationCore.remindOwnersWithLiveChildren(
				(h: any) => h.childKind !== "team",
			);
			expect(reminded).toBeGreaterThanOrEqual(1);

			await expect(
				page.getByText("The gateway restarted", { exact: false }).first(),
			).toBeVisible({ timeout: 20_000 });
			await expect(page.getByText("team_wait", { exact: false }).first()).toBeVisible({ timeout: 15_000 });

			// Re-collect via the SHARED team_wait route — no transparent resumption.
			const wait = await orchestrate(gateway, parent, "wait", { childSessionIds: [childId], timeout_ms: 20_000 });
			expect(wait.status).toBe(200);
			expect(wait.json.firstIdle).toBe(childId);

			const dismiss = await orchestrate(gateway, parent, "dismiss", { childSessionId: childId });
			expect(dismiss.status).toBe(200);
			childId = undefined;
		} finally {
			if (childId) await orchestrate(gateway, parent, "dismiss", { childSessionId: childId }).catch(() => {});
			await deleteSession(parent).catch(() => {});
		}
	});
});
