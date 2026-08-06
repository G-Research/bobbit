/**
 * Real browser journey for EP-2's first advisory-selection consumer.
 *
 * The pack is installed through the normal server-scope pack resolver. Browser
 * prompts drive the in-process mock agent's real terminal event, which in turn
 * dispatches the gateway-internal afterTurn lifecycle. Only the agent runtime
 * is mocked by the harness; grants, hook isolation, reduction, mutation,
 * persistence, reload, and the Context UI are production paths.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createSession, deleteSession, registerProject, waitForSessionStatus } from "../e2e-setup.js";
import { navigateToHash, openApp, sendMessage } from "./ui-helpers.js";

// Retrying could hide a missed afterTurn dispatch, stale user pin, or lost grant.
test.describe.configure({ mode: "serial", retries: 0 });

const PACK_ID = "extension-advisory-thinking-browser-fixture";
const THINKING_HOOK_ID = "browser-advisory-thinking";
const UNAVAILABLE_HOOK_ID = "browser-advisory-unavailable";
const PRIVATE_USAGE_SENTINEL = "ADVISORY_USAGE_PRIVATE_browser_never_render";
const PRIVATE_MODULE_SENTINEL = "ADVISORY_MODULE_PRIVATE_browser_never_render";
const FABLE_MODEL = { provider: "anthropic", id: "claude-fable-5" } as const;

type BrowserResponse = { status: number; text: string };
type TraceOutcome = {
	packId?: string;
	hookId: string;
	event: string;
	outcome: string;
	reason?: string;
	selectionKind?: string;
	selectionValue?: string;
};
type TraceEntry = { hook: string; outcomes?: TraceOutcome[] };

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
		"sourceUrl: e2e", "sourceRef: local", "commit: test", `packName: ${PACK_ID}`,
		"version: 1.0.0", "installedAt: '2026-01-01T00:00:00.000Z'",
		"updatedAt: '2026-01-01T00:00:00.000Z'", "scope: server",
	].join("\n") + "\n");
	fs.writeFileSync(path.join(packDir, "pack.yaml"), [
		`name: ${PACK_ID}`,
		"description: Real browser fixture for advisory thinking selections.",
		"version: 1.0.0", "schema: 2", "contents:",
		"  roles: []", "  tools: []", "  skills: []", "  entrypoints: []", "  providers: []",
		`  hooks: [${THINKING_HOOK_ID}, ${UNAVAILABLE_HOOK_ID}]`,
		"  mcp: []", "  pi-extensions: []", "  runtimes: []", "  workflows: []",
	].join("\n") + "\n");
	for (const hookId of [THINKING_HOOK_ID, UNAVAILABLE_HOOK_ID]) {
		fs.writeFileSync(path.join(packDir, "hooks", `${hookId}.yaml`), [
			`id: ${hookId}`, `module: ../lib/${hookId}.mjs`, "events: [afterTurn]", "mode: decide",
			"capabilities: []", "budget: { maxTokens: 64, timeoutMs: 1000 }",
		].join("\n") + "\n");
	}
	// This verifies that the direct terminal usage snapshot is forwarded into the
	// untrusted hook context: the only valid output is reached by the mock's real
	// input/output usage pair. The sentinels must never cross into trace metadata.
	fs.writeFileSync(path.join(packDir, "lib", `${THINKING_HOOK_ID}.mjs`), `
const privateUsage = ${JSON.stringify(PRIVATE_USAGE_SENTINEL)};
const privateModule = ${JSON.stringify(PRIVATE_MODULE_SENTINEL)};
export default {
  decide(ctx) {
    if (ctx.event !== "afterTurn" || ctx.usage?.telemetry !== "known" || ctx.usage?.inputTokens !== 150 || ctx.usage?.outputTokens !== 25) {
      return { kind: "selection", selection: { kind: "thinking", thinkingLevel: "not-a-thinking-level" } };
    }
    void privateUsage; void privateModule;
    // Fable's authoritative map rejects off, so the runtime must verify and
    // clamp this advice to minimal before persistence/broadcast.
    return { kind: "selection", selection: { kind: "thinking", thinkingLevel: "off" } };
  },
};
`);
	// A simultaneously-granted proposal outside the host's role availability
	// proves unavailable values are inert without introducing a test-only route.
	fs.writeFileSync(path.join(packDir, "lib", `${UNAVAILABLE_HOOK_ID}.mjs`), `
export default {
  decide() {
    return { kind: "selection", selection: { kind: "role", roleName: "unavailable-browser-role" } };
  },
};
`);
	return packDir;
}

async function navigateToSession(page: Page, sessionId: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	await expect.poll(
		() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? (window as any).__bobbitState?.selectedSessionId ?? ""),
		{ timeout: 10_000 },
	).toBe(sessionId);
}

async function remoteThinkingLevel(page: Page): Promise<string | undefined> {
	return page.evaluate(() => {
		const state = (window as any).bobbitState?.remoteAgent?.state ?? (window as any).__bobbitState?.remoteAgent?.state;
		return state?.thinkingLevel;
	});
}

async function trace(page: Page, sessionId: string): Promise<TraceEntry[]> {
	const response = await browserApi(page, { path: `/api/sessions/${encodeURIComponent(sessionId)}/context-trace?limit=100` });
	expect(response.status, response.text).toBe(200);
	const body = json<{ entries?: TraceEntry[] }>(response);
	return body.entries ?? [];
}

function hookOutcomes(entries: TraceEntry[], hookId: string): TraceOutcome[] {
	return entries.flatMap(entry => entry.hook === "afterTurn" ? (entry.outcomes ?? []) : []).filter(outcome => outcome.hookId === hookId);
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

async function grant(page: Page, projectId: string, hookId: string): Promise<void> {
	const response = await browserApi(page, {
		path: `/api/projects/${encodeURIComponent(projectId)}/extension-grants`,
		method: "PUT", body: { packId: PACK_ID, hookId, capability: "decide" },
	});
	expect(response.status, response.text).toBe(200);
}

async function revoke(page: Page, projectId: string, hookId: string): Promise<void> {
	const response = await browserApi(page, {
		path: `/api/projects/${encodeURIComponent(projectId)}/extension-grants/${encodeURIComponent(PACK_ID)}/${encodeURIComponent(hookId)}/decide`,
		method: "DELETE",
	});
	expect(response.status, response.text).toBe(200);
}

async function clearDefaultThinkingLevel(page: Page): Promise<void> {
	const response = await browserApi(page, {
		path: "/api/preferences",
		method: "PUT",
		// Ambient defaults are explicit authority and would correctly deny the
		// advisory hook as pinned, so isolate this fixture from shared preferences.
		body: { "default.sessionThinkingLevel": null },
	});
	expect(response.status, response.text).toBe(200);
}

test.describe("extension advisory thinking", () => {
	let packDir: string | undefined;
	let projectId: string | undefined;
	let projectRoot: string | undefined;
	let originalPackOrder: string[] | undefined;
	const sessions: string[] = [];

	test.beforeAll(async ({ gateway }) => {
		originalPackOrder = await readServerPackOrder();
		packDir = installFixturePack(gateway.bobbitDir);
		await notifyPackFilesystemMutation(originalPackOrder);
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "extension-advisory-thinking-browser-project-"));
		const project = await registerProject({ name: `extension-advisory-thinking-browser-${Date.now()}`, rootPath: projectRoot, seedWorkflows: false });
		projectId = project.id;
		const activation = await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT", body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled: { hooks: [] } }),
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

	test("granted afterTurn advice uses terminal usage, clamps and persists, while pins, unavailable values, and revocation stay inert", async ({ page, gateway }) => {
		if (!projectId || !projectRoot || !gateway.sessionManager) throw new Error("ADVISORY_THINKING_BROWSER: fixture gateway project/session manager missing");
		await openApp(page);
		const previousPreferences = json<Record<string, unknown>>(await browserApi(page, { path: "/api/preferences" }));
		try {
			await clearDefaultThinkingLevel(page);
			const cwd = path.join(projectRoot, "workspace");
			fs.mkdirSync(cwd, { recursive: true });
			const sessionId = await createSession({ cwd, projectId });
			sessions.push(sessionId);
			await waitForSessionStatus(sessionId, "idle");

			// Configure the harness's real mock runtime with Fable's authoritative map.
			// The test does not replace the dispatcher or consumer: it only supplies the
			// same live runtime tuple that production has to verify before mutation.
			const session = gateway.sessionManager.getSession(sessionId);
			if (!session) throw new Error("ADVISORY_THINKING_BROWSER: live session missing");
			await session.rpcClient.setModel(FABLE_MODEL.provider, FABLE_MODEL.id);
			await session.rpcClient.setThinkingLevel("high");
			gateway.sessionManager.persistSessionModel(sessionId, FABLE_MODEL.provider, FABLE_MODEL.id, "high");

			await grant(page, projectId, THINKING_HOOK_ID);
			await grant(page, projectId, UNAVAILABLE_HOOK_ID);
			await navigateToSession(page, sessionId);
			await expect.poll(() => remoteThinkingLevel(page), { timeout: 15_000 }).toBe("high");

			// A normal browser prompt produces the mock agent's real message_end usage
			// and agent_end. The gateway owns the detached afterTurn dispatch.
			await sendMessage(page, "ADVISORY_THINKING_USAGE_TURN");
			await waitForSessionStatus(sessionId, "idle");
			await expect.poll(async () => hookOutcomes(await trace(page, sessionId), THINKING_HOOK_ID), { timeout: 15_000 }).toContainEqual(expect.objectContaining({
				packId: PACK_ID, event: "afterTurn", outcome: "applied", selectionKind: "thinking", selectionValue: "minimal",
			}));
			await expect.poll(async () => hookOutcomes(await trace(page, sessionId), UNAVAILABLE_HOOK_ID), { timeout: 15_000 }).toContainEqual(expect.objectContaining({
				outcome: "dropped", reason: "Unavailable value", selectionKind: "role",
			}));
			await expect.poll(() => remoteThinkingLevel(page), { timeout: 15_000 }).toBe("minimal");
			expect(gateway.sessionManager.getPersistedSession(sessionId)).toMatchObject({ effectiveThinkingLevel: "minimal" });

			// Reload proves the verified effective value, rather than the hook request,
			// is durable and rehydrated through the ordinary browser session path.
			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToSession(page, sessionId);
			await expect.poll(() => remoteThinkingLevel(page), { timeout: 15_000 }).toBe("minimal");

			// Choose High through the production selector. Its websocket route both
			// verifies the tuple and records human provenance, which must dominate later
			// advice even when the hook is still exactly granted.
			const thinking = page.locator(".thinking-select-compact");
			const thinkingButton = thinking.locator("button");
			await expect(thinkingButton).toBeVisible({ timeout: 10_000 });
			await thinkingButton.click();
			const listbox = page.locator('[role="listbox"]').last();
			await expect(listbox).toBeVisible({ timeout: 10_000 });
			const labels = (await listbox.locator('[role="option"]').allTextContents()).map((text) => text.replace(/\s+/g, " ").trim());
			expect(labels).toContain("High");
			const highOption = listbox.getByRole("option", { name: "High", exact: true });
			await expect(highOption).toBeVisible({ timeout: 10_000 });
			await highOption.click();
			await expect.poll(() => remoteThinkingLevel(page), { timeout: 15_000 }).toBe("high");
			expect(gateway.sessionManager.getPersistedSession(sessionId)?.humanSelectionPins?.thinkingLevel).toBe("high");

			await sendMessage(page, "ADVISORY_THINKING_PIN_TURN");
			await waitForSessionStatus(sessionId, "idle");
			await expect.poll(async () => hookOutcomes(await trace(page, sessionId), THINKING_HOOK_ID).some(outcome => outcome.outcome === "denied" && outcome.reason === "User pin"), { timeout: 15_000 }).toBe(true);
			expect(await remoteThinkingLevel(page)).toBe("high");

			await revoke(page, projectId, THINKING_HOOK_ID);
			await sendMessage(page, "ADVISORY_THINKING_REVOKED_TURN");
			await waitForSessionStatus(sessionId, "idle");
			await expect.poll(async () => hookOutcomes(await trace(page, sessionId), THINKING_HOOK_ID).some(outcome => outcome.outcome === "denied" && outcome.reason === "Grant required"), { timeout: 15_000 }).toBe(true);
			expect(await remoteThinkingLevel(page)).toBe("high");

			// Context is a browser-visible safe projection: it attributes only bounded
			// host metadata and never leaks hook-module/usage values or private sentinels.
			const inspector = await openContextTrace(page);
			await expect(inspector).toContainText(PACK_ID);
			await expect(inspector).toContainText("User pin");
			await expect(inspector).toContainText("Grant required");
			await expect(inspector).toContainText("Unavailable value");
			const rendered = await inspector.evaluate(node => node.outerHTML);
			const attributes = await inspector.locator("*").evaluateAll(nodes => nodes.flatMap(node => [...node.attributes].map(attribute => `${attribute.name}=${attribute.value}`)));
			for (const privateValue of [PRIVATE_USAGE_SENTINEL, PRIVATE_MODULE_SENTINEL]) {
				expect(rendered).not.toContain(privateValue);
				expect(attributes.join("\n")).not.toContain(privateValue);
			}

			// Timestamps and generated IDs may contain an incidental "25", so check
			// the structured advisory rows rather than the inspector's full markup.
			// Neither hook usage labels nor its exact token values may cross the safe
			// trace boundary into rendered outcome details or element attributes.
			const advisoryRows = inspector.locator('[data-testid="context-trace-outcome"]');
			const outcomeDetails = await advisoryRows.locator("dt, dd").allTextContents();
			const outcomeAttributes = await advisoryRows.evaluateAll(rows => rows.flatMap(row => [row, ...row.querySelectorAll("*")]
				.flatMap(node => [...node.attributes].map(attribute => `${attribute.name}=${attribute.value}`))));
			expect(outcomeDetails.join("\n")).not.toMatch(/\b(?:inputTokens|outputTokens|usage|telemetry|input tokens|output tokens)\b/i);
			expect(outcomeAttributes.join("\n")).not.toMatch(/\b(?:inputTokens|outputTokens|usage|telemetry|input tokens|output tokens)\b/i);
			for (const tokenCount of ["150", "25"]) {
				expect(outcomeDetails).not.toContain(tokenCount);
				expect(outcomeDetails).not.toContain(`${tokenCount} tokens`);
				expect(outcomeAttributes).not.toContain(tokenCount);
				expect(outcomeAttributes).not.toContain(`${tokenCount} tokens`);
			}
		} finally {
			await browserApi(page, {
				path: "/api/preferences",
				method: "PUT",
				body: { "default.sessionThinkingLevel": previousPreferences["default.sessionThinkingLevel"] ?? null },
			}).catch(() => {});
		}
	});
});
