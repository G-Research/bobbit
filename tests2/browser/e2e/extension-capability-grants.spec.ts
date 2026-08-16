/**
 * Real authenticated-browser regression for project-owned extension grants.
 *
 * This intentionally drives the production REST routes from the authenticated
 * app origin. EP-7 owns any marketplace controls, so no test-only route or UI
 * affordance is introduced here.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, registerProject } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

// A retry could mask a stale grant projection or persisted-revoke regression.
test.describe.configure({ mode: "serial", retries: 0 });

const PACK_ID = "extension-capability-grants-browser-fixture";
const HOOK_ID = "browser-policy-gate";
const CAPABILITY = "decide";

type HookProjection = {
	id: string;
	status: string;
	runnable: boolean;
	requestedCapabilities: string[];
	grants: string[];
};

type ContributionsResponse = {
	packs: Array<{ packId: string; hooks: HookProjection[] }>;
};

type BrowserResponse = { status: number; text: string };

/** Execute a real authenticated request from the loaded app's own origin. */
async function browserApi(page: Page, request: {
	path: string;
	method?: string;
	body?: unknown;
}): Promise<BrowserResponse> {
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

function packRow(page: Page) {
	return page.locator(`[data-testid="market-project-pack-row"][data-contribution-id="${PACK_ID}"]`);
}

async function serverPackOrder(): Promise<string[]> {
	const response = await apiFetch("/api/marketplace/pack-order?scope=server");
	expect(response.status).toBe(200);
	return (await response.json()).order as string[];
}

async function notifyPackFilesystemMutation(order: string[]): Promise<void> {
	const response = await apiFetch("/api/marketplace/pack-order", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", order }),
	});
	expect(response.status, `fixture filesystem refresh failed: ${await response.clone().text()}`).toBe(200);
}

async function openProjectMarket(page: Page, projectId: string): Promise<void> {
	await openApp(page);
	// The ordinary browser bootstrap request mints the signed operator cookie;
	// grant controls then use that same browser-held proof, never a test header.
	await browserApi(page, { path: "/api/goals" });
	await page.evaluate((id) => { window.location.hash = `#/market/${encodeURIComponent(id)}/installed`; }, projectId);
	// A grants-only fixture has no provider runtime row. Its project-owned Pack
	// target is the public Marketplace surface that owns these grant controls.
	await expect(packRow(page)).toBeVisible({ timeout: 20_000 });
}

async function openPackGrantDetails(page: Page): Promise<ReturnType<typeof packRow>> {
	const row = packRow(page);
	const grants = row.getByTestId("market-extension-grants");
	await expect(grants).toBeVisible({ timeout: 20_000 });
	if ((await grants.getAttribute("open")) === null) {
		await grants.locator("summary").focus();
		await page.keyboard.press("Enter");
	}
	await expect(grants).toHaveAttribute("open", "");
	return row;
}

function hookProjection(body: ContributionsResponse): HookProjection {
	const pack = body.packs.find(candidate => candidate.packId === PACK_ID);
	if (!pack) throw new Error(`Fixture pack ${PACK_ID} was not active in /api/ext/contributions`);
	const hook = pack.hooks.find(candidate => candidate.id === HOOK_ID);
	if (!hook) throw new Error(`Fixture hook ${HOOK_ID} was not projected by /api/ext/contributions`);
	return hook;
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
		"description: Browser fixture for exact extension grants.",
		"version: 1.0.0",
		"schema: 2",
		"capabilities: [service.manage, memory.read, memory.read.all]",
		"contents:",
		"  roles: []",
		"  tools: []",
		"  skills: []",
		"  entrypoints: []",
		"  providers: []",
		"  hooks: [browser-policy-gate]",
		"  mcp: []",
		"  pi-extensions: []",
		"  runtimes: []",
		"  workflows: []",
	].join("\n") + "\n");
	fs.writeFileSync(path.join(packDir, "hooks", "browser-policy-gate.yaml"), [
		`id: ${HOOK_ID}`,
		"module: ../lib/browser-policy-gate.mjs",
		"events: [beforePrompt]",
		"mode: decide",
		"capabilities: []",
		"budget: { maxTokens: 64, timeoutMs: 100 }",
	].join("\n") + "\n");
	// Hook declarations are deliberately metadata-only in EP-6. The module is
	// present only to satisfy the normal pack-path validation and is never loaded.
	fs.writeFileSync(path.join(packDir, "lib", "browser-policy-gate.mjs"), "export default {};\n");
	return packDir;
}

test.describe("extension capability grants", () => {
	let packDir: string | undefined;
	let projectId: string | undefined;
	let projectRoot: string | undefined;
	let initialServerPackOrder: string[] = [];

	test.beforeAll(async ({ gateway }) => {
		initialServerPackOrder = await serverPackOrder();
		packDir = installFixturePack(gateway.bobbitDir);
		await notifyPackFilesystemMutation(initialServerPackOrder);
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "extension-capability-grants-browser-project-"));
		const project = await registerProject({
			name: `extension-capability-grants-browser-${Date.now()}`,
			rootPath: projectRoot,
			seedWorkflows: false,
		});
		projectId = project.id;
	});

	test.afterAll(async () => {
		if (projectId) {
			// The project owns both the persisted grants and audit log.
			await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
		}
		if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
		await notifyPackFilesystemMutation(initialServerPackOrder).catch(() => {});
		if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
	});

	test("Market pack row grants, reloads, revokes, and audits one exact non-hook capability", async ({ page }) => {
		if (!projectId) throw new Error("fixture project was not registered");
		await openProjectMarket(page, projectId);
		const row = await openPackGrantDetails(page);
		const grants = row.getByTestId("market-extension-grants");
		await expect(grants).toContainText("Manage service");
		await expect(grants).toContainText("service.manage");
		await expect(grants).toContainText("Read memory");
		await expect(grants).toContainText("memory.read");
		await expect(grants).toContainText("Read all memory");
		await expect(grants).toContainText("memory.read.all");
		await expect(grants.getByText(/grant all/i)).toHaveCount(0);

		const broadRow = grants.getByTestId("market-capability-grant").filter({ has: page.locator('[data-capability="memory.read.all"]') });
		const broadAction = broadRow.getByTestId("market-capability-action");
		await expect(broadRow).toContainText("Not granted");
		await expect(broadAction).toHaveAccessibleName("Grant memory.read.all");
		await broadAction.focus();
		await page.keyboard.press("Enter");
		await expect(page.getByText("Grant extension capability")).toBeVisible();
		await expect(page.getByText(new RegExp(`Grant memory\\.read\\.all to pack .*\\(${PACK_ID}\\).*all project memory`, "i"))).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(broadRow).toContainText("Not granted");

		await broadAction.click();
		await page.getByRole("button", { name: "Grant capability", exact: true }).click();
		await expect(broadRow).toContainText("Granted", { timeout: 20_000 });
		await expect(grants.getByTestId("market-capability-grant").filter({ has: page.locator('[data-capability="memory.read"]') })).toContainText("Not granted");
		await expect(grants.getByTestId("market-capability-grant").filter({ has: page.locator('[data-capability="service.manage"]') })).toContainText("Not granted");

		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
		const reloadedRow = await openPackGrantDetails(page);
		const reloadedGrants = reloadedRow.getByTestId("market-extension-grants");
		const reloadedBroadRow = reloadedGrants.getByTestId("market-capability-grant").filter({ has: page.locator('[data-capability="memory.read.all"]') });
		await expect(reloadedBroadRow).toContainText("Granted");

		const history = page.getByTestId("market-grant-history");
		await history.locator("summary").click();
		const grantedAudit = history.getByTestId("market-grant-history-entry").filter({ hasText: "memory.read.all" }).first();
		await expect(grantedAudit).toContainText(`Pack · ${PACK_ID}`);
		await expect(grantedAudit).toContainText("Granted");
		await expect(grantedAudit.locator("time")).toHaveAttribute("datetime", /T/);

		await reloadedBroadRow.getByTestId("market-capability-action").click();
		await expect(reloadedBroadRow).toContainText("Not granted", { timeout: 20_000 });
		await expect(history.getByTestId("market-grant-history-entry").filter({ hasText: "Revoked" }).filter({ hasText: "memory.read.all" })).toHaveCount(1, { timeout: 20_000 });
	});

	test("grant → revoke from the authenticated app origin leaves an inert persisted projection after reload", async ({ page }) => {
		if (!projectId) throw new Error("fixture project was not registered");
		await openApp(page);

		const tuple = { packId: PACK_ID, hookId: HOOK_ID, capability: CAPABILITY };
		const contributionsPath = `/api/ext/contributions?projectId=${encodeURIComponent(projectId)}`;
		const grantsPath = `/api/projects/${encodeURIComponent(projectId)}/extension-grants`;
		const revokePath = `${grantsPath}/${encodeURIComponent(PACK_ID)}/${encodeURIComponent(HOOK_ID)}/${CAPABILITY}`;

		// Fail closed: an active decide hook is visible, but cannot run absent an
		// exact project grant.
		let response = await browserApi(page, { path: contributionsPath });
		expect(response.status, response.text).toBe(200);
		let projection = hookProjection(json<ContributionsResponse>(response));
		expect(projection).toMatchObject({ status: "grant-required", runnable: false });
		expect(projection.requestedCapabilities).toContain(CAPABILITY);
		expect(projection.grants).not.toContain(CAPABILITY);

		response = await browserApi(page, { path: grantsPath, method: "PUT", body: tuple });
		expect(response.status, response.text).toBe(200);
		const grantBody = json<{ grant: { packId: string; hookId: string; capability: string; grantedAt: string; grantedBy: string } }>(response);
		expect(grantBody.grant).toMatchObject(tuple);
		expect(new Date(grantBody.grant.grantedAt).toISOString()).toBe(grantBody.grant.grantedAt);
		expect(grantBody.grant.grantedBy).toMatch(/^(localhost|admin)$/);

		response = await browserApi(page, { path: contributionsPath });
		expect(response.status, response.text).toBe(200);
		projection = hookProjection(json<ContributionsResponse>(response));
		expect(projection).toMatchObject({ status: "granted", runnable: true });
		expect(projection.grants).toContain(CAPABILITY);

		response = await browserApi(page, { path: revokePath, method: "DELETE" });
		expect(response.status, response.text).toBe(200);
		expect(json<{ revoked: boolean }>(response).revoked).toBe(true);

		response = await browserApi(page, { path: `/api/projects/${encodeURIComponent(projectId)}/extension-grant-audit` });
		expect(response.status, response.text).toBe(200);
		const audit = json<{ entries: Array<{ at: string; actor: string; action: string; packId: string; hookId: string; capability: string }> }>(response);
		expect(audit.entries).toEqual(expect.arrayContaining([
			expect.objectContaining({ action: "granted", ...tuple }),
			expect.objectContaining({ action: "revoked", ...tuple }),
		]));
		for (const entry of audit.entries.filter((entry) => entry.hookId === HOOK_ID)) {
			expect(Object.keys(entry).sort()).toEqual(["action", "actor", "at", "capability", "hookId", "packId"]);
			expect(new Date(entry.at).toISOString()).toBe(entry.at);
			expect(entry.actor).toMatch(/^(localhost|admin)$/);
		}

		// A cold reload must not restore the revoked decision capability. Re-fetch
		// from the re-authenticated production app origin rather than relying on a
		// cached endpoint result or a test-only notification handler.
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
		response = await browserApi(page, { path: contributionsPath });
		expect(response.status, response.text).toBe(200);
		projection = hookProjection(json<ContributionsResponse>(response));
		expect(projection).toMatchObject({ status: "grant-required", runnable: false });
		expect(projection.grants).not.toContain(CAPABILITY);

		// Gateway credentials stay in browser storage only; neither administrative
		// responses nor rendered page text may disclose them.
		const token = await page.evaluate(() => localStorage.getItem("gateway.token") || "");
		expect(token).toMatch(/^[a-f0-9]{64}$/);
		for (const text of [grantBody, audit, await page.locator("body").innerText()]) {
			expect(JSON.stringify(text)).not.toContain(token);
		}
	});
});
