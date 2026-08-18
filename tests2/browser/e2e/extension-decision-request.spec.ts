/**
 * Authenticated browser journey for schema-2 extension decision requests.
 *
 * The fixture is a real market pack and its hook is dispatched through the
 * normal beforePrompt lifecycle seam. It deliberately never posts an agent
 * prompt: answering is limited to the typed decision endpoint.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createSession, deleteSession, registerProject } from "../e2e-setup.js";
import { navigateToHash, openApp } from "./ui-helpers.js";

// A retry could hide a lost decision invalidation or a stale durable answer.
test.describe.configure({ mode: "serial", retries: 0 });

const PACK_ID = "extension-decision-request-browser-fixture";
const HOOK_ID = "browser-decision-request";
const CONSENT_HOOK_ID = "browser-consent-required";
const QUESTION = "DECISION_QUESTION_SECRET_browser_choose_a_safe_path";
const CONSENT_QUESTION = "CONSENT_QUESTION_browser_review_before_protected_work";
const OTHER_ANSWER = "DECISION_OTHER_SECRET_browser_custom_path";
const CONFIG_SECRET = "DECISION_CONFIG_SECRET_must_not_reach_trace";
const DECISION_KEY = "browser-choice";

type BrowserResponse = { status: number; text: string };
type DecisionProjection = {
	id: string;
	sessionId: string;
	status: string;
	decisionClass?: "deferrable" | "consent-required";
	request: { question: string; options: Array<{ value: string; label: string }> };
};

type BrowserDecisionStore = {
	requests: Record<string, {
		id: string;
		sessionId: string;
		status: string;
		resolution?: { value: { kind: string; text?: string } };
	}>;
	memories: Record<string, {
		scope: string;
		scopeId: string;
		packId: string;
		hookId: string;
		key: string;
		value: { kind: string; text?: string };
	}>;
};

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
	try {
		return JSON.parse(response.text) as T;
	} catch {
		throw new Error(`Expected JSON response, got ${response.status}: ${response.text}`);
	}
}

/** Replay the normal pack-order mutation after a direct fixture filesystem change. */
async function notifyPackFilesystemMutation(order: string[]): Promise<void> {
	const response = await apiFetch("/api/marketplace/pack-order", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", order }),
	});
	expect(response.status, await response.text()).toBe(200);
}

async function readServerPackOrder(): Promise<string[]> {
	const response = await apiFetch("/api/marketplace/pack-order?scope=server");
	expect(response.status, await response.clone().text()).toBe(200);
	return (await response.json() as { order: string[] }).order;
}

function installFixturePack(bobbitDir: string): string {
	const packDir = path.join(bobbitDir, "config", "market-packs", PACK_ID);
	fs.rmSync(packDir, { recursive: true, force: true });
	fs.mkdirSync(path.join(packDir, "hooks"), { recursive: true });
	fs.mkdirSync(path.join(packDir, "lib"), { recursive: true });
	fs.writeFileSync(path.join(packDir, ".pack-meta.yaml"), [
		"sourceUrl: e2e",
		"sourceRef: local",
		"commit: test",
		`packName: ${PACK_ID}`,
		"version: 1.0.0",
		"installedAt: '2026-01-01T00:00:00.000Z'",
		"updatedAt: '2026-01-01T00:00:00.000Z'",
		"scope: server",
	].join("\n") + "\n");
	fs.writeFileSync(path.join(packDir, "pack.yaml"), [
		`name: ${PACK_ID}`,
		"description: Real browser fixture for extension decision requests.",
		"version: 1.0.0",
		"schema: 2",
		"contents:",
		"  roles: []",
		"  tools: []",
		"  skills: []",
		"  entrypoints: []",
		"  providers: []",
		"  hooks: [browser-decision-request, browser-consent-required]",
		"  mcp: []",
		"  pi-extensions: []",
		"  runtimes: []",
		"  workflows: []",
	].join("\n") + "\n");
	fs.writeFileSync(path.join(packDir, "hooks", "browser-decision-request.yaml"), [
		`id: ${HOOK_ID}`,
		"module: ../lib/browser-decision-request.mjs",
		"events: [beforePrompt]",
		"mode: decide",
		"capabilities: []",
		"budget: { maxTokens: 64, timeoutMs: 1000 }",
	].join("\n") + "\n");
	fs.writeFileSync(path.join(packDir, "hooks", "browser-consent-required.yaml"), [
		`id: ${CONSENT_HOOK_ID}`,
		"module: ../lib/browser-consent-required.mjs",
		"events: [beforePrompt]",
		"mode: decide",
		"capabilities: []",
		"budget: { maxTokens: 64, timeoutMs: 1000 }",
	].join("\n") + "\n");
	fs.writeFileSync(path.join(packDir, "lib", "browser-decision-request.mjs"), `
const deadline = () => new Date(Date.now() + 60_000).toISOString();
export default {
  decide() {
    return {
      kind: "request",
      request: {
        version: 1,
        key: ${JSON.stringify(DECISION_KEY)},
        title: "Browser decision",
        question: ${JSON.stringify(QUESTION)},
        options: [
          { value: "keep", label: "Keep default" },
          { value: "change", label: "Change plan" },
        ],
        other: { minLength: 3, maxLength: 80 },
        default: { kind: "option", value: "keep" },
        scope: "session",
        deadlineAt: deadline(),
        effect: { kind: "none" },
      },
    };
  },
  onDecision() {
    // ${CONFIG_SECRET}: no host API, prompt, or config mutation is available here.
  },
};
`);
	fs.writeFileSync(path.join(packDir, "lib", "browser-consent-required.mjs"), `
const deadline = () => new Date(Date.now() + 60_000).toISOString();
export default {
  decide() {
    return {
      kind: "request",
      request: {
        version: 1,
        key: "browser-consent-choice",
        title: "Protected browser decision",
        question: ${JSON.stringify(CONSENT_QUESTION)},
        options: [
          { value: "allow", label: "Allow this protected work" },
          { value: "deny", label: "Keep it blocked" },
        ],
        other: { minLength: 3, maxLength: 80 },
        requestedClass: "consent-required",
        scope: "session",
        deadlineAt: deadline(),
        effect: { kind: "none" },
      },
    };
  },
};
`);
	return packDir;
}

async function triggerDecision(page: Page, sessionId: string): Promise<void> {
	const response = await browserApi(page, {
		path: `/api/sessions/${encodeURIComponent(sessionId)}/provider-hooks/before-prompt`,
		method: "POST",
		body: { prompt: "browser lifecycle trigger" },
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

async function navigateToSession(page: Page, sessionId: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	await expect.poll(
		() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? (window as any).__bobbitState?.selectedSessionId ?? ""),
		{ timeout: 10_000 },
	).toBe(sessionId);
}

async function openContextTrace(page: Page): Promise<Locator> {
	const trigger = page.locator('[data-testid="session-actions-trigger"]').first();
	await expect(trigger).toBeVisible({ timeout: 10_000 });
	await trigger.click();
	const action = page.locator('sidebar-actions-popover [role="menuitem"][data-session-action-id="view-context-trace"]').first();
	await expect(action).toBeVisible({ timeout: 10_000 });
	await action.click();
	const inspector = page.locator('[data-testid="context-trace-inspector"]');
	await expect(inspector).toBeVisible({ timeout: 15_000 });
	return inspector;
}

function messageCount(page: Page): Promise<number> {
	return page.evaluate(() => ((window as any).__bobbitState?.remoteAgent?.state?.messages ?? []).length);
}

test.describe("extension decision request", () => {
	let packDir: string | undefined;
	let projectId: string | undefined;
	let projectRoot: string | undefined;
	let originalPackOrder: string[] | undefined;
	const sessions: string[] = [];

	test.beforeAll(async ({ gateway }) => {
		originalPackOrder = await readServerPackOrder();
		packDir = installFixturePack(gateway.bobbitDir);
		await notifyPackFilesystemMutation(originalPackOrder);
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "extension-decision-request-browser-project-"));
		const project = await registerProject({
			name: `extension-decision-request-browser-${Date.now()}`,
			rootPath: projectRoot,
			seedWorkflows: false,
		});
		projectId = project.id;
		const activation = await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT",
			body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled: { hooks: [] } }),
		});
		expect(activation.status, await activation.text()).toBe(200);
	});

	test.afterEach(async () => {
		for (const sessionId of sessions.splice(0)) await deleteSession(sessionId).catch(() => {});
	});

	test.afterAll(async () => {
		if (projectId) await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
		if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
		if (originalPackOrder) await notifyPackFilesystemMutation(originalPackOrder).catch(() => {});
		if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
	});

	test("a granted schema-2 hook asks through the shared widget, persists a scoped Other answer, and redacts its trace", async ({ page }) => {
		if (!projectId || !projectRoot) throw new Error("fixture project was not registered");
		await openApp(page);
		const sessionCwd = path.join(projectRoot, "workspace");
		fs.mkdirSync(sessionCwd, { recursive: true });
		const sessionId = await createSession({ cwd: sessionCwd, projectId });
		sessions.push(sessionId);

		// Activation alone is insufficient: the exact EP-6 decide grant is required.
		await triggerDecision(page, sessionId);
		await expect.poll(() => pendingDecisions(page, sessionId)).toEqual([]);
		const grant = await browserApi(page, {
			path: `/api/projects/${encodeURIComponent(projectId)}/extension-grants`,
			method: "PUT",
			body: { packId: PACK_ID, hookId: HOOK_ID, capability: "decide" },
		});
		expect(grant.status, grant.text).toBe(200);

		await triggerDecision(page, sessionId);
		let pending: DecisionProjection[] = [];
		await expect.poll(async () => {
			pending = await pendingDecisions(page, sessionId);
			return pending.length;
		}, { timeout: 10_000 }).toBe(1);
		const request = pending[0];
		expect(request).toMatchObject({ sessionId, status: "pending", request: { question: QUESTION } });

		await navigateToSession(page, sessionId);
		let card = page.locator(`[data-decision-request-id="${request.id}"]`);
		await expect(card).toContainText(QUESTION, { timeout: 15_000 });
		await expect(card.locator("ask-user-choices-widget")).toHaveCount(1);

		// A reload keeps a still-pending durable question visible through the normal
		// decision projection; it is not an agent prompt or transcript envelope.
		await page.reload({ waitUntil: "domcontentloaded" });
		await navigateToSession(page, sessionId);
		card = page.locator(`[data-decision-request-id="${request.id}"]`);
		await expect(card).toContainText(QUESTION, { timeout: 15_000 });
		const messagesBeforeAnswer = await messageCount(page);
		const promptRequests: string[] = [];
		page.on("request", requestEvent => {
			if (requestEvent.method() === "POST" && requestEvent.url().includes(`/api/sessions/${sessionId}/prompt`)) {
				promptRequests.push(requestEvent.url());
			}
		});

		await card.locator('input[value="__OTHER__"]').click({ force: true });
		await card.locator(".ask-other-input").fill(OTHER_ANSWER);
		await card.locator(".ask-submit").click();
		await expect(card.locator(".ask-submit")).toHaveCount(0, { timeout: 15_000 });
		// The pending-only projection may remove the terminal card as soon as its
		// invalidation arrives; the authoritative answered state is asserted below.
		expect(await messageCount(page)).toBe(messagesBeforeAnswer);
		expect(promptRequests).toEqual([]);
		await expect.poll(() => pendingDecisions(page, sessionId)).toEqual([]);

		// The server's atomic project store is the durable scope-memory authority.
		// This verifies the browser answer published only this session's exact key.
		const storePath = path.join(projectRoot, ".bobbit", "state", "extension-decision-requests.json");
		await expect.poll(() => fs.existsSync(storePath), { timeout: 10_000 }).toBe(true);
		const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as BrowserDecisionStore;
		expect(store.requests[request.id]).toMatchObject({
			id: request.id,
			sessionId,
			status: "resolved",
			resolution: { value: { kind: "other", text: OTHER_ANSWER } },
		});
		expect(Object.values(store.memories)).toContainEqual(expect.objectContaining({
			scope: "session",
			scopeId: sessionId,
			packId: PACK_ID,
			hookId: HOOK_ID,
			key: DECISION_KEY,
			value: { kind: "other", text: OTHER_ANSWER },
		}));

		const inspector = await openContextTrace(page);
		const decisionOutcomes = inspector.locator('[data-testid="context-trace-outcome"]', { hasText: "Decision" });
		await expect(decisionOutcomes).not.toHaveCount(0);
		await expect(inspector).toContainText("other");
		const inspectorText = await inspector.innerText();
		for (const secret of [QUESTION, OTHER_ANSWER, CONFIG_SECRET]) {
			expect(inspectorText).not.toContain(secret);
		}
	});

	test("a requested consent decision has no default and remains answerable through the shared card", async ({ page }) => {
		if (!projectId || !projectRoot) throw new Error("fixture project was not registered");
		await openApp(page);
		const sessionCwd = path.join(projectRoot, "consent-workspace");
		fs.mkdirSync(sessionCwd, { recursive: true });
		const sessionId = await createSession({ cwd: sessionCwd, projectId });
		sessions.push(sessionId);
		const grant = await browserApi(page, {
			path: `/api/projects/${encodeURIComponent(projectId)}/extension-grants`,
			method: "PUT",
			body: { packId: PACK_ID, hookId: CONSENT_HOOK_ID, capability: "decide" },
		});
		expect(grant.status, grant.text).toBe(200);

		await triggerDecision(page, sessionId);
		let request: DecisionProjection | undefined;
		await expect.poll(async () => {
			request = (await pendingDecisions(page, sessionId)).find(candidate => candidate.request.question === CONSENT_QUESTION);
			return request?.id;
		}, { timeout: 10_000 }).toBeTruthy();
		expect(request).toMatchObject({ status: "pending", decisionClass: "consent-required" });

		await navigateToSession(page, sessionId);
		const card = page.locator(`[data-decision-request-id="${request!.id}"]`);
		await expect(card).toContainText("Consent required", { timeout: 15_000 });
		await expect(card).not.toContainText("Default applied");
		// The widget exposes both the label and its screen-reader-only native input
		// as radios. Target the label by its rendered option value to avoid a strict
		// role-locator collision while exercising the shared widget's click path.
		await card.locator('label:has(input[value="Allow this protected work"])').click();
		await expect.poll(() => pendingDecisions(page, sessionId)).not.toContainEqual(expect.objectContaining({ id: request!.id }));
	});
});
