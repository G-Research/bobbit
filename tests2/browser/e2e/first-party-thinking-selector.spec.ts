/**
 * Real browser journey for the first-party thinking-selector extension.
 *
 * The browser drives the ordinary built-in Market and project-grant APIs while
 * sessions run through the production setup/afterTurn paths. This proves the
 * selector remains entirely inert until both opt-in boundaries are satisfied,
 * while the host retains clamp and human-pin authority.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createSession, deleteSession, registerProject, waitForSessionStatus } from "../e2e-setup.js";
import { navigateToHash, openApp, sendMessage } from "./ui-helpers.js";

// Retries could hide a late setup dispatch, stale revocation, or a lost user pin.
test.describe.configure({ mode: "serial", retries: 0 });

const PACK_ID = "thinking-selector";
const HOOK_ID = "default-thinking";
const FABLE_MODEL = "anthropic/claude-fable-5";
const NON_REASONING_MODEL = "mock/mock-model";

type BrowserResponse = { status: number; text: string };
type TraceOutcome = {
	kind?: string;
	packId?: string;
	hookId?: string;
	event?: string;
	outcome?: string;
	reason?: string;
	selectionKind?: string;
	selectionValue?: string;
};
type TraceEntry = { hook: string; outcomes?: TraceOutcome[] };
type ContributionHook = { id: string; status: string; runnable: boolean; grants: string[] };
type ContributionsResponse = { packs: Array<{ packId: string; hooks: ContributionHook[] }> };

/** Execute authenticated product requests from the loaded application's origin. */
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
	return json<{ entries?: TraceEntry[] }>(response).entries ?? [];
}

async function selectorOutcomes(page: Page, sessionId: string): Promise<TraceOutcome[]> {
	return (await trace(page, sessionId)).flatMap(entry => entry.outcomes ?? []).filter(outcome =>
		outcome.packId === PACK_ID && outcome.hookId === HOOK_ID,
	);
}

async function setActivation(page: Page, enabled: boolean): Promise<void> {
	const response = await browserApi(page, {
		path: "/api/marketplace/pack-activation",
		method: "PUT",
		// This is the Market master toggle's persisted default-disabled shape.
		body: { scope: "server", packName: PACK_ID, disabled: enabled ? { enabled: true } : {} },
	});
	expect(response.status, response.text).toBe(200);
}

async function grant(page: Page, projectId: string): Promise<void> {
	const response = await browserApi(page, {
		path: `/api/projects/${encodeURIComponent(projectId)}/extension-grants`,
		method: "PUT",
		body: { packId: PACK_ID, hookId: HOOK_ID, capability: "decide" },
	});
	expect(response.status, response.text).toBe(200);
	expect(json<{ grant: { packId: string; hookId: string; capability: string } }>(response).grant).toMatchObject({
		packId: PACK_ID, hookId: HOOK_ID, capability: "decide",
	});
}

async function revoke(page: Page, projectId: string): Promise<void> {
	const response = await browserApi(page, {
		path: `/api/projects/${encodeURIComponent(projectId)}/extension-grants/${PACK_ID}/${HOOK_ID}/decide`,
		method: "DELETE",
	});
	expect(response.status, response.text).toBe(200);
	expect(json<{ revoked: boolean }>(response).revoked).toBe(true);
}

async function selectorHook(page: Page, projectId: string): Promise<ContributionHook | undefined> {
	const response = await browserApi(page, { path: `/api/ext/contributions?projectId=${encodeURIComponent(projectId)}` });
	expect(response.status, response.text).toBe(200);
	const pack = json<ContributionsResponse>(response).packs.find(candidate => candidate.packId === PACK_ID);
	return pack?.hooks.find(candidate => candidate.id === HOOK_ID);
}

async function setDefaults(page: Page, sessionModel: string): Promise<void> {
	const response = await browserApi(page, {
		path: "/api/preferences",
		method: "PUT",
		// Null is deliberate: configured defaults are explicit host choices and
		// therefore must not be confused with the optional selector fallback.
		body: { "default.sessionModel": sessionModel, "default.sessionThinkingLevel": null },
	});
	expect(response.status, response.text).toBe(200);
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

test.describe("first-party thinking selector", () => {
	let projectId: string | undefined;
	let projectRoot: string | undefined;
	const sessions: string[] = [];

	test.beforeAll(async () => {
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "first-party-thinking-selector-browser-project-"));
		const project = await registerProject({
			name: `first-party-thinking-selector-browser-${Date.now()}`,
			rootPath: projectRoot,
			seedWorkflows: false,
		});
		projectId = project.id;
	});

	test.afterEach(async () => {
		for (const sessionId of sessions.splice(0)) await deleteSession(sessionId).catch(() => {});
	});

	test.afterAll(async () => {
		// Always return the shared built-in activation to its shipped default-OFF.
		await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT", body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled: {} }),
		}).catch(() => {});
		if (projectId) await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
		if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
	});

	test("built-in selector is inert until enabled and exactly granted; it clamps, survives reload, yields to a pin, and is inert again when disabled or revoked", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		if (!projectId || !projectRoot || !gateway.sessionManager) throw new Error("THINKING_SELECTOR_BROWSER: fixture project or session manager missing");
		await openApp(page);

		const previousPreferences = json<Record<string, unknown>>(await browserApi(page, { path: "/api/preferences" }));
		const cwd = path.join(projectRoot, "workspace");
		fs.mkdirSync(cwd, { recursive: true });

		try {
			await setDefaults(page, FABLE_MODEL);
			await setActivation(page, false);

			// The raw built-in catalogue remains visible for a user to opt in, while its
			// disabled pack must not register any executable hook or setup trace.
			await navigateToHash(page, "#/market");
			const builtinCard = page.locator('[data-testid="market-installed-pack"][data-builtin="true"][data-pack-name="thinking-selector"]').first();
			await expect(builtinCard).toBeVisible({ timeout: 20_000 });
			const inactive = await createSession({ cwd, projectId });
			sessions.push(inactive);
			await waitForSessionStatus(inactive, "idle");
			await expect.poll(() => selectorOutcomes(page, inactive), { timeout: 10_000 }).toEqual([]);
			// With no selector authority, setup must still preserve Pi's verified
			// live model tuple rather than leaving the session model-only or stale.
			expect(gateway.sessionManager.getPersistedSession(inactive)).toMatchObject({
				modelProvider: "anthropic", modelId: "claude-fable-5",
			});

			// Opting into the default-disabled Market pack still grants no authority.
			await setActivation(page, true);
			await expect.poll(() => selectorHook(page, projectId!), { timeout: 10_000 }).toMatchObject({
				id: HOOK_ID, status: "grant-required", runnable: false,
			});
			const enabledWithoutGrant = await createSession({ cwd, projectId });
			sessions.push(enabledWithoutGrant);
			await waitForSessionStatus(enabledWithoutGrant, "idle");
			// An active but ungranted decision hook records the safe host denial;
			// it still cannot select or apply a thinking level.
			await expect.poll(() => selectorOutcomes(page, enabledWithoutGrant).then(outcomes => outcomes.some(outcome =>
				outcome.outcome === "denied" && outcome.reason === "Grant required",
			)), { timeout: 10_000 }).toBe(true);

			await grant(page, projectId);
			await expect.poll(() => selectorHook(page, projectId!), { timeout: 10_000 }).toMatchObject({
				id: HOOK_ID, status: "granted", runnable: true, grants: expect.arrayContaining(["decide"]),
			});

			// With both opt-ins, the shipped selector recreates the old medium fallback.
			const selected = await createSession({ cwd, projectId });
			sessions.push(selected);
			await waitForSessionStatus(selected, "idle");
			await navigateToSession(page, selected);
			await expect.poll(() => remoteThinkingLevel(page), { timeout: 15_000 }).toBe("medium");
			await expect.poll(() => selectorOutcomes(page, selected).then(outcomes => outcomes.some(outcome =>
				outcome.event === "sessionSetup"
				&& outcome.selectionKind === "thinking"
				&& outcome.selectionValue === "medium"
				&& (outcome.outcome === "advised" || outcome.outcome === "applied"),
			)), { timeout: 15_000 }).toBe(true);
			expect(gateway.sessionManager.getPersistedSession(selected)).toMatchObject({
				modelProvider: "anthropic", modelId: "claude-fable-5", effectiveThinkingLevel: "medium",
			});

			// The selector can only propose medium. A non-reasoning current model is
			// clamped by core to off before the exact tuple is persisted or broadcast.
			await setDefaults(page, NON_REASONING_MODEL);
			const clamped = await createSession({ cwd, projectId });
			sessions.push(clamped);
			await waitForSessionStatus(clamped, "idle");
			await navigateToSession(page, clamped);
			await expect.poll(() => remoteThinkingLevel(page), { timeout: 15_000 }).toBe("off");
			expect(gateway.sessionManager.getPersistedSession(clamped)).toMatchObject({
				modelProvider: "mock", modelId: "mock-model", effectiveThinkingLevel: "off",
			});

			// Reload and production picker pinning prove an authenticated human choice
			// still wins over the selector's afterTurn proposal.
			await setDefaults(page, FABLE_MODEL);
			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToSession(page, selected);
			await expect.poll(() => remoteThinkingLevel(page), { timeout: 15_000 }).toBe("medium");
			const thinking = page.locator(".thinking-select-compact");
			await thinking.locator("button").click();
			const listbox = page.locator('[role="listbox"]').last();
			await expect(listbox).toBeVisible({ timeout: 10_000 });
			await listbox.getByRole("option", { name: "High", exact: true }).click();
			await expect.poll(() => remoteThinkingLevel(page), { timeout: 15_000 }).toBe("high");
			expect(gateway.sessionManager.getPersistedSession(selected)?.humanSelectionPins?.thinkingLevel).toBe("high");
			await sendMessage(page, "FIRST_PARTY_THINKING_SELECTOR_PIN_TURN");
			await waitForSessionStatus(selected, "idle");
			await expect.poll(() => selectorOutcomes(page, selected).then(outcomes => outcomes.some(outcome =>
				outcome.event === "afterTurn" && outcome.outcome === "denied" && outcome.reason === "User pin",
			)), { timeout: 15_000 }).toBe(true);
			expect(await remoteThinkingLevel(page)).toBe("high");

			// Context is a browser-safe projection of bounded host metadata, never a
			// file path or module detail from the installed extension.
			const inspector = await openContextTrace(page);
			await expect(inspector).toContainText(PACK_ID);
			await expect(inspector).toContainText(HOOK_ID);
			await expect(inspector).toContainText("User pin");
			const rendered = await inspector.evaluate(node => node.outerHTML);
			const attributes = await inspector.locator("*").evaluateAll(nodes => nodes.flatMap(node => [...node.attributes]
				.map(attribute => `${attribute.name}=${attribute.value}`)));
			for (const unsafeDetail of ["default-thinking-selector.mjs", "market-packs", "file:"]) {
				expect(rendered).not.toContain(unsafeDetail);
				expect(attributes.join("\n")).not.toContain(unsafeDetail);
			}

			// Disable is an execution ceiling even while the exact grant remains stored.
			await setActivation(page, false);
			const disabled = await createSession({ cwd, projectId });
			sessions.push(disabled);
			await waitForSessionStatus(disabled, "idle");
			await expect.poll(() => selectorOutcomes(page, disabled), { timeout: 10_000 }).toEqual([]);

			// Re-enabling does not resurrect authority after the grant is revoked.
			await setActivation(page, true);
			await revoke(page, projectId);
			await expect.poll(() => selectorHook(page, projectId!), { timeout: 10_000 }).toMatchObject({
				id: HOOK_ID, status: "grant-required", runnable: false,
			});
			const revoked = await createSession({ cwd, projectId });
			sessions.push(revoked);
			await waitForSessionStatus(revoked, "idle");
			await expect.poll(() => selectorOutcomes(page, revoked).then(outcomes => outcomes.some(outcome =>
				outcome.outcome === "denied" && outcome.reason === "Grant required",
			)), { timeout: 10_000 }).toBe(true);
		} finally {
			await setActivation(page, false).catch(() => {});
			await browserApi(page, {
				path: "/api/preferences",
				method: "PUT",
				body: {
					"default.sessionModel": previousPreferences["default.sessionModel"] ?? null,
					"default.sessionThinkingLevel": previousPreferences["default.sessionThinkingLevel"] ?? null,
				},
			}).catch(() => {});
		}
	});
});
