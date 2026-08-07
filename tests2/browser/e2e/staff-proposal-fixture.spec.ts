/**
 * Browser journey for the fixture-pack staff-improvement proposal flow.
 *
 * The production server deliberately has no transcript classifier yet, so this
 * uses DecisionHookDispatcher's documented fixture-only bounded-signal seam.
 * The installed pack, scheduled afterTurn dispatch, consent endpoint, proposal
 * seed service, and ordinary proposal panel remain server-backed production
 * paths; signal classification itself is covered by the focused core suite.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createSession, deleteSession, registerProject, waitForSessionStatus } from "../e2e-setup.js";
import { navigateToHash, openApp, sendMessage } from "./ui-helpers.js";

test.describe.configure({ mode: "serial", retries: 0 });

const PACK_ID = "staff-proposal-advisor";
const HOOK_ID = "staff-improvement";
const QUESTION = "Recent session patterns suggest an improvement. Create an editable draft?";
const TITLE = "Improve staff workflow guidance";
const EDITED_TITLE = "Edited staff workflow guidance";

type BrowserResponse = { status: number; text: string };
type DecisionProjection = {
	id: string;
	status: string;
	decisionClass?: string;
	request: { question: string; options: Array<{ value: string; label: string }> };
};
type ProposalProjection = { proposalType: string; fields: Record<string, unknown>; rev: number };

async function browserApi(page: Page, request: { path: string; method?: string; body?: unknown }): Promise<BrowserResponse> {
	return page.evaluate(async ({ path, method, body }) => {
		const token = localStorage.getItem("gateway.token");
		const response = await fetch(path, {
			method: method ?? "GET",
			credentials: "include",
			headers: {
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, text: await response.text() };
	}, request);
}

function json<T>(response: BrowserResponse): T {
	try { return JSON.parse(response.text) as T; }
	catch { throw new Error(`Expected JSON response, got ${response.status}: ${response.text}`); }
}

async function readServerPackOrder(): Promise<string[]> {
	const response = await apiFetch("/api/marketplace/pack-order?scope=server");
	expect(response.status, await response.clone().text()).toBe(200);
	return (await response.json() as { order: string[] }).order;
}

/** Replays normal resolver invalidation after this isolated fixture copy changes. */
async function notifyPackFilesystemMutation(order: string[]): Promise<void> {
	const response = await apiFetch("/api/marketplace/pack-order", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", order }),
	});
	expect(response.status, await response.text()).toBe(200);
}

function installFixturePack(bobbitDir: string): string {
	const source = path.resolve(import.meta.dirname, "../../../market-packs/_fixtures/staff-proposal-advisor");
	const destination = path.join(bobbitDir, "config", "market-packs", PACK_ID);
	fs.rmSync(destination, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.cpSync(source, destination, { recursive: true });
	fs.writeFileSync(path.join(destination, ".pack-meta.yaml"), [
		"sourceUrl: e2e", "sourceRef: local", "commit: test", `packName: ${PACK_ID}`,
		"version: 1.0.0", "installedAt: '2026-01-01T00:00:00.000Z'",
		"updatedAt: '2026-01-01T00:00:00.000Z'", "scope: server",
	].join("\n") + "\n");
	return destination;
}

function installFixtureSignals(gateway: unknown, signals: Map<string, unknown>): void {
	const dispatcher = (gateway as { sessionManager?: { lifecycleHub?: Record<string, unknown> } })
		.sessionManager?.lifecycleHub?.decisionDispatcher as { deps?: Record<string, unknown> } | undefined;
	if (!dispatcher?.deps) throw new Error("STAFF_PROPOSAL_BROWSER: DecisionHookDispatcher fixture seam unavailable");
	dispatcher.deps.staffImprovementSignalsForSession = (sessionId: string) => signals.get(sessionId);
}

async function grant(page: Page, projectId: string): Promise<void> {
	const response = await browserApi(page, {
		path: `/api/projects/${encodeURIComponent(projectId)}/extension-grants`,
		method: "PUT",
		body: { packId: PACK_ID, hookId: HOOK_ID, capability: "decide" },
	});
	expect(response.status, response.text).toBe(200);
}

async function pendingDecisions(page: Page, sessionId: string): Promise<DecisionProjection[]> {
	const response = await browserApi(page, {
		path: `/api/sessions/${encodeURIComponent(sessionId)}/decision-requests?state=pending`,
	});
	expect(response.status, response.text).toBe(200);
	return json<{ requests: DecisionProjection[] }>(response).requests;
}

async function proposals(page: Page, sessionId: string): Promise<ProposalProjection[]> {
	const response = await browserApi(page, { path: `/api/sessions/${encodeURIComponent(sessionId)}/proposals` });
	expect(response.status, response.text).toBe(200);
	return json<{ proposals: ProposalProjection[] }>(response).proposals;
}

async function navigateToSession(page: Page, sessionId: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	await expect.poll(
		() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? (window as any).__bobbitState?.selectedSessionId ?? ""),
		{ timeout: 10_000 },
	).toBe(sessionId);
}

async function requestAtDueTurn(page: Page, sessionId: string): Promise<DecisionProjection> {
	for (let turn = 1; turn <= 3; turn++) {
		await sendMessage(page, `STAFF_PROPOSAL_BROWSER_TURN_${turn}`);
		await waitForSessionStatus(sessionId, "idle");
	}
	let request: DecisionProjection | undefined;
	await expect.poll(async () => {
		request = (await pendingDecisions(page, sessionId)).find(candidate => candidate.request.question === QUESTION);
		return request?.id;
	}, { timeout: 15_000 }).toBeTruthy();
	return request!;
}

test.describe("staff proposal fixture", () => {
	let packDir: string | undefined;
	let projectId: string | undefined;
	let projectRoot: string | undefined;
	let originalPackOrder: string[] | undefined;
	const sessions: string[] = [];
	const signals = new Map<string, unknown>();

	test.beforeAll(async ({ gateway }) => {
		originalPackOrder = await readServerPackOrder();
		packDir = installFixturePack(gateway.bobbitDir);
		await notifyPackFilesystemMutation(originalPackOrder);
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "staff-proposal-browser-project-"));
		// The fixture seed deliberately omits `workflow`, so keep this fixture project
		// workflow-free. registerProject otherwise installs a default workflow and
		// ProposalSeedService correctly rejects the unqualified goal proposal.
		const project = await registerProject({
			name: `staff-proposal-browser-${Date.now()}`,
			rootPath: projectRoot,
			seedWorkflows: false,
		});
		projectId = project.id;
		const activation = await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT",
			body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled: { hooks: [] } }),
		});
		expect(activation.status, await activation.text()).toBe(200);
		installFixtureSignals(gateway, signals);
	});

	test.afterEach(async () => {
		for (const sessionId of sessions.splice(0)) {
			signals.delete(sessionId);
			await deleteSession(sessionId).catch(() => {});
		}
	});

	test.afterAll(async () => {
		if (projectId) await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
		if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
		if (originalPackOrder) await notifyPackFilesystemMutation(originalPackOrder).catch(() => {});
		if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
	});

	test("uses the shared consent card; decline remains draft-free after reload", async ({ page }) => {
		if (!projectId || !projectRoot) throw new Error("STAFF_PROPOSAL_BROWSER: fixture project missing");
		await openApp(page);
		const cwd = path.join(projectRoot, "decline-workspace");
		fs.mkdirSync(cwd, { recursive: true });
		const sessionId = await createSession({ cwd, projectId });
		sessions.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");
		signals.set(sessionId, { windowTurns: 3, patterns: [{ kind: "repeated-user-correction", count: 1 }] });
		await grant(page, projectId);
		await navigateToSession(page, sessionId);

		const request = await requestAtDueTurn(page, sessionId);
		const card = page.locator(`[data-decision-request-id="${request.id}"]`);
		await expect(card).toContainText("Consent required", { timeout: 15_000 });
		await expect(card).toContainText(QUESTION);
		await expect(card.locator("ask-user-choices-widget")).toHaveCount(1);
		// Consent is deliberately rendered by the shared decision component; EP-8
		// adds no proposal panel until the user explicitly creates a draft.
		await expect(page.locator('.goal-tab-pill[title="Goal Proposal"], [data-panel="goal-proposal"], [data-panel="staff-proposal"]')).toHaveCount(0);

		await card.locator('label:has(input[value="Not now"])').click();
		await expect.poll(() => pendingDecisions(page, sessionId)).toEqual([]);
		expect(await proposals(page, sessionId)).toEqual([]);

		await page.reload({ waitUntil: "domcontentloaded" });
		await navigateToSession(page, sessionId);
		await expect(page.locator('.goal-tab-pill[title="Goal Proposal"], [data-panel="goal-proposal"], [data-panel="staff-proposal"]')).toHaveCount(0);
		expect(await proposals(page, sessionId)).toEqual([]);
	});

	test("creates, edits, and dismisses the ordinary goal proposal without applying it", async ({ page }) => {
		if (!projectId || !projectRoot) throw new Error("STAFF_PROPOSAL_BROWSER: fixture project missing");
		await openApp(page);
		const cwd = path.join(projectRoot, "create-workspace");
		fs.mkdirSync(cwd, { recursive: true });
		const sessionId = await createSession({ cwd, projectId });
		sessions.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");
		signals.set(sessionId, { windowTurns: 3, patterns: [{ kind: "repeated-user-correction", count: 1 }] });
		await grant(page, projectId);
		await navigateToSession(page, sessionId);

		const request = await requestAtDueTurn(page, sessionId);
		const card = page.locator(`[data-decision-request-id="${request.id}"]`);
		await expect(card).toContainText(QUESTION, { timeout: 15_000 });
		await card.locator('label:has(input[value="Create draft"])').click();
		await expect.poll(() => pendingDecisions(page, sessionId)).toEqual([]);

		const panel = page.locator('[data-panel="goal-proposal"]').first();
		await expect(panel, "the affirmative option must use the existing goal proposal panel").toBeVisible({ timeout: 15_000 });
		await expect(page.locator('[data-panel="staff-proposal"]'), "no bespoke staff-proposal UI is introduced").toHaveCount(0);
		const title = panel.locator('input[placeholder="Goal title"]');
		await expect(title).toHaveValue(TITLE);
		await expect.poll(() => proposals(page, sessionId)).toContainEqual(expect.objectContaining({
			proposalType: "goal", fields: expect.objectContaining({ title: TITLE }),
		}));

		// This is the normal editable-proposal API, not an EP-8-specific mutation.
		const edited = await browserApi(page, {
			path: `/api/sessions/${encodeURIComponent(sessionId)}/proposal/goal/edit`,
			method: "POST",
			body: { old_text: TITLE, new_text: EDITED_TITLE },
		});
		expect(edited.status, edited.text).toBe(200);
		await expect(title).toHaveValue(EDITED_TITLE, { timeout: 15_000 });

		await panel.getByRole("button", { name: "Dismiss", exact: true }).click();
		await expect(panel).toHaveCount(0, { timeout: 15_000 });
		expect(await proposals(page, sessionId)).toEqual([]);
		// The normal acceptance control was never invoked, so dismissal is not an
		// applied goal/configuration change.
		const goals = json<{ goals: Array<{ title?: string; projectId?: string }> }>(await browserApi(page, { path: "/api/goals" })).goals;
		expect(goals).not.toContainEqual(expect.objectContaining({ title: EDITED_TITLE, projectId }));
	});
});
