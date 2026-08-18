/**
 * Browser journey for static extension system-prompt sections.
 *
 * This uses real server-scope fixture packs and real project grants, then
 * inspects the production System Prompt dialog. It deliberately keeps the
 * fixture local to this journey: no production controls or test-only routes
 * are needed to verify the persisted prompt projection.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createSession, deleteSession, registerProject, waitForSessionStatus } from "../e2e-setup.js";
import { navigateToHash, openApp } from "./ui-helpers.js";

test.describe.configure({ mode: "serial", retries: 0 });

const ALPHA_PACK = "prompt-extension-inspector-alpha";
const BETA_PACK = "prompt-extension-inspector-beta";
const ALPHA_LIST = "alpha-static";
const BETA_LIST = "beta-static";
const ALPHA_SECTION = "alpha-guidance";
const BETA_SECTION = "beta-guidance";
const ALPHA_TITLE = "Alpha extension guidance";
const BETA_TITLE = "Beta extension guidance";
const ALPHA_CONTENT = "ALPHA_EXTENSION_PROMPT_SENTINEL — keep alpha guidance visible.";
const BETA_CONTENT = "BETA_EXTENSION_PROMPT_SENTINEL — keep beta guidance visible.";
const CAPABILITY = "prompt:system-static";

type PromptSection = {
	label: string;
	source: string;
	content: string;
	tokens: number;
	kind?: "extension";
	packId?: string;
	packName?: string;
	sectionId?: string;
	sectionTitle?: string;
	contentBytes?: number;
	renderedBytes?: number;
	totalPromptBytes?: number;
};

type PromptSnapshot = {
	sections: PromptSection[];
	totalPromptBytes?: number;
	extensionRegionStartByteOffset?: number;
	stablePrefixSha256?: string;
};

function writeFixturePack(bobbitDir: string, packName: string, listName: string, sectionId: string, title: string, content: string): string {
	const packDir = path.join(bobbitDir, "config", "market-packs", packName);
	fs.rmSync(packDir, { recursive: true, force: true });
	fs.mkdirSync(path.join(packDir, "hooks"), { recursive: true });
	fs.mkdirSync(path.join(packDir, "system-prompts"), { recursive: true });
	fs.mkdirSync(path.join(packDir, "lib"), { recursive: true });
	fs.writeFileSync(path.join(packDir, ".pack-meta.yaml"), [
		"sourceUrl: e2e",
		"sourceRef: local",
		"commit: test",
		`packName: ${packName}`,
		"version: 1.0.0",
		"installedAt: '2026-01-01T00:00:00.000Z'",
		"updatedAt: '2026-01-01T00:00:00.000Z'",
		"scope: server",
	].join("\n") + "\n");
	fs.writeFileSync(path.join(packDir, "pack.yaml"), [
		`name: ${packName}`,
		"description: Static prompt inspector browser fixture.",
		"version: 1.0.0",
		"schema: 2",
		"contents:",
		"  roles: []",
		"  tools: []",
		"  skills: []",
		"  entrypoints: []",
		`  hooks: [${listName}-hook]`,
		`  system-prompts: [${listName}]`,
		"  mcp: []",
		"  pi-extensions: []",
		"  runtimes: []",
		"  workflows: []",
	].join("\n") + "\n");
	fs.writeFileSync(path.join(packDir, "hooks", `${listName}-hook.yaml`), [
		`id: ${listName}-hook`,
		"module: ../lib/inert.mjs",
		"events: [sessionSetup]",
		"mode: observe",
		`capabilities: [${CAPABILITY}]`,
		"budget: { maxTokens: 64, timeoutMs: 100 }",
	].join("\n") + "\n");
	fs.writeFileSync(path.join(packDir, "lib", "inert.mjs"), "export default {};\n");
	fs.writeFileSync(path.join(packDir, "system-prompts", `${listName}.yaml`), [
		`id: ${sectionId}`,
		`title: ${title}`,
		"content: |-",
		`  ${content}`,
		"maxBytes: 2048",
	].join("\n") + "\n");
	return packDir;
}

async function putActivation(packName: string, disabled: Record<string, unknown> = {}): Promise<void> {
	const response = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName, disabled }),
	});
	expect(response.status, await response.text()).toBe(200);
}

async function putServerOrder(order: string[]): Promise<void> {
	const response = await apiFetch("/api/marketplace/pack-order", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", order }),
	});
	expect(response.status, await response.text()).toBe(200);
}

let operatorCookie = "";

async function grantStaticPrompt(projectId: string, packId: string, hookId: string): Promise<void> {
	const response = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/extension-grants`, {
		method: "PUT",
		headers: { Cookie: operatorCookie },
		body: JSON.stringify({ packId, hookId, capability: CAPABILITY }),
	});
	expect(response.status, await response.text()).toBe(200);
}

async function promptSnapshot(sessionId: string): Promise<PromptSnapshot> {
	const response = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/prompt-sections`);
	const body = await response.text();
	expect(response.status, body).toBe(200);
	return JSON.parse(body) as PromptSnapshot;
}

function extensionSections(snapshot: PromptSnapshot): PromptSection[] {
	return snapshot.sections.filter((section) => section.kind === "extension");
}

function expectedRenderedBytes(packId: string, sectionId: string, content: string): number {
	const start = `<!-- bobbit:extension-prompt-section:start pack="${packId}" section="${sectionId}" -->`;
	const end = `<!-- bobbit:extension-prompt-section:end pack="${packId}" section="${sectionId}" -->`;
	return Buffer.byteLength(`${start}\n${content}\n${end}`, "utf8");
}

async function openSession(page: Page, sessionId: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
}

async function openPromptInspector(page: Page): Promise<Locator> {
	const dialog = page.locator("system-prompt-dialog");
	if (await dialog.count()) await dialog.evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
	const trigger = page.locator('[data-testid="session-actions-trigger"]').first();
	await expect(trigger).toBeVisible({ timeout: 10_000 });
	await trigger.click();
	const action = page.locator('sidebar-actions-popover [role="menuitem"][data-session-action-id="view-system-prompt"]').first();
	await expect(action).toBeVisible({ timeout: 10_000 });
	await action.click();
	await expect(dialog.getByRole("heading", { name: "System Prompt Inspector" })).toBeVisible({ timeout: 15_000 });
	return dialog;
}

function extensionDetails(dialog: Locator): Locator {
	return dialog.getByLabel("Extension contribution details");
}

async function expectInspectorExtension(dialog: Locator, section: PromptSection, content: string): Promise<void> {
	const details = extensionDetails(dialog).filter({ hasText: `Pack: ${section.packName}` }).filter({ hasText: `Section: ${section.sectionTitle}` });
	await expect(details).toHaveCount(1);
	await expect(details).toContainText(`(${section.packId})`);
	await expect(details).toContainText(`(${section.sectionId})`);
	const contentBytes = Buffer.byteLength(content, "utf8");
	const renderedBytes = expectedRenderedBytes(section.packId!, section.sectionId!, content);
	await expect(details.getByLabel("Authoritative UTF-8 byte usage")).toContainText(`${contentBytes.toLocaleString()} UTF-8 bytes content`);
	await expect(details.getByLabel("Authoritative UTF-8 byte usage")).toContainText(`${renderedBytes.toLocaleString()} UTF-8 bytes rendered`);
	await expect(details.getByLabel("Authoritative UTF-8 byte usage")).toContainText(`${section.totalPromptBytes!.toLocaleString()} UTF-8 bytes total prompt`);
	const expectedShare = ((renderedBytes / section.totalPromptBytes!) * 100).toFixed(1);
	await expect(details.getByLabel(`${expectedShare} percent of total prompt`)).toBeVisible();
	await details.locator("xpath=../..").click();
	await expect(dialog).toContainText(content);
}

test.describe("static extension prompt inspector", () => {
	let alphaDir: string | undefined;
	let betaDir: string | undefined;
	let projectId = "";
	let projectRoot = "";
	let originalOrder: string[] = [];
	const sessions = new Set<string>();

	test.beforeAll(async ({ gateway }) => {
		// Bootstrap the human/operator cookie through the same browser-signaled,
		// same-origin API shape the UI uses. Grant writes must not rely on Bearer
		// credentials, which do not authorize the prompt-operator boundary.
		const cookieProbe = await apiFetch("/api/goals", {
			headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
		});
		const setCookies = (cookieProbe.headers as any).getSetCookie?.() as string[] | undefined
			?? (cookieProbe.headers.get("set-cookie") ? [cookieProbe.headers.get("set-cookie") as string] : []);
		operatorCookie = setCookies.map((cookie) => cookie.split(";", 1)[0])
			.find((cookie) => cookie.startsWith("bobbit_session=v1.")) ?? "";
		expect(operatorCookie, "browser-signaled API bootstrap must mint a signed prompt-operator cookie").not.toBe("");

		alphaDir = writeFixturePack(gateway.bobbitDir, ALPHA_PACK, ALPHA_LIST, ALPHA_SECTION, ALPHA_TITLE, ALPHA_CONTENT);
		betaDir = writeFixturePack(gateway.bobbitDir, BETA_PACK, BETA_LIST, BETA_SECTION, BETA_TITLE, BETA_CONTENT);
		const orderResponse = await apiFetch("/api/marketplace/pack-order?scope=server");
		const orderBody = await orderResponse.text();
		expect(orderResponse.status, orderBody).toBe(200);
		originalOrder = (JSON.parse(orderBody) as { order: string[] }).order;
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-extension-inspector-browser-project-"));
		const project = await registerProject({
			name: `prompt-extension-inspector-browser-${Date.now()}`,
			rootPath: projectRoot,
			seedWorkflows: false,
		});
		projectId = project.id;
		await putServerOrder([...originalOrder.filter((name) => name !== ALPHA_PACK && name !== BETA_PACK), ALPHA_PACK, BETA_PACK]);
		await putActivation(ALPHA_PACK, { hooks: [], systemPrompts: [] });
		await putActivation(BETA_PACK, { hooks: [], systemPrompts: [] });
		await grantStaticPrompt(projectId, ALPHA_PACK, `${ALPHA_LIST}-hook`);
		await grantStaticPrompt(projectId, BETA_PACK, `${BETA_LIST}-hook`);
	});

	test.afterAll(async () => {
		for (const sessionId of sessions) await deleteSession(sessionId).catch(() => {});
		await putActivation(ALPHA_PACK).catch(() => {});
		await putActivation(BETA_PACK).catch(() => {});
		await putServerOrder(originalOrder).catch(() => {});
		if (projectId) await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
		if (alphaDir) fs.rmSync(alphaDir, { recursive: true, force: true });
		if (betaDir) fs.rmSync(betaDir, { recursive: true, force: true });
		if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
	});

	test("inspects attributed prompt bytes in priority order, survives reload, and removes disabled extensions without changing the core cache prefix", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await openApp(page);
		const sessionId = await createSession({ cwd: projectRoot, projectId });
		sessions.add(sessionId);
		await waitForSessionStatus(sessionId, "idle", 30_000);

		let snapshot = await promptSnapshot(sessionId);
		let extensions = extensionSections(snapshot);
		const sectionLabels = snapshot.sections.map((section) => section.label);
		// The in-process gateway must capture the same resolved path as the CLI:
		// the stable core prompt precedes the separately attributed extension region.
		expect(sectionLabels).toContain("System Prompt");
		expect(sectionLabels.indexOf("System Prompt")).toBeLessThan(sectionLabels.indexOf(ALPHA_TITLE));
		expect(sectionLabels.indexOf("System Prompt")).toBeLessThan(sectionLabels.indexOf(BETA_TITLE));
		expect(extensions.map((section) => section.packId)).toEqual([ALPHA_PACK, BETA_PACK]);
		expect(extensions.map((section) => section.sectionId)).toEqual([ALPHA_SECTION, BETA_SECTION]);
		for (const section of extensions) {
			expect(section.totalPromptBytes).toBe(snapshot.totalPromptBytes);
			expect(section.renderedBytes).toBe(expectedRenderedBytes(section.packId!, section.sectionId!, section.packId === ALPHA_PACK ? ALPHA_CONTENT : BETA_CONTENT));
		}
		const stablePrefix = snapshot.stablePrefixSha256;
		expect(stablePrefix).toMatch(/^[a-f0-9]{64}$/);

		await openSession(page, sessionId);
		let dialog = await openPromptInspector(page);
		await expect(extensionDetails(dialog)).toHaveCount(2);
		expect(await extensionDetails(dialog).allTextContents()).toEqual([
			expect.stringContaining(`Pack: ${ALPHA_PACK}`),
			expect.stringContaining(`Pack: ${BETA_PACK}`),
		]);
		await expectInspectorExtension(dialog, extensions[0]!, ALPHA_CONTENT);
		await expectInspectorExtension(dialog, extensions[1]!, BETA_CONTENT);
		await expect(dialog).toContainText("System Prompt");
		await expect(dialog).toContainText("Working Directory");

		// A cold reload reads the persisted projection rather than relying on a
		// live in-memory dialog state.
		await page.reload({ waitUntil: "domcontentloaded" });
		await openSession(page, sessionId);
		dialog = await openPromptInspector(page);
		await expect(extensionDetails(dialog)).toHaveCount(2);
		await expectInspectorExtension(dialog, extensions[0]!, ALPHA_CONTENT);
		await expectInspectorExtension(dialog, extensions[1]!, BETA_CONTENT);

		// Reordering changes the extension region but preserves the exported stable
		// core identity. The inspector must use that new deterministic pack order.
		await putServerOrder([...originalOrder.filter((name) => name !== ALPHA_PACK && name !== BETA_PACK), BETA_PACK, ALPHA_PACK]);
		snapshot = await promptSnapshot(sessionId);
		extensions = extensionSections(snapshot);
		expect(extensions.map((section) => section.packId)).toEqual([BETA_PACK, ALPHA_PACK]);
		expect(snapshot.stablePrefixSha256).toBe(stablePrefix);

		await page.reload({ waitUntil: "domcontentloaded" });
		await openSession(page, sessionId);
		dialog = await openPromptInspector(page);
		await expect(extensionDetails(dialog)).toHaveCount(2);
		expect(await extensionDetails(dialog).allTextContents()).toEqual([
			expect.stringContaining(`Pack: ${BETA_PACK}`),
			expect.stringContaining(`Pack: ${ALPHA_PACK}`),
		]);

		// Disable one list, then all lists. Existing stable sections remain
		// inspectable, while disabled prompt content and extension attribution do not.
		await putActivation(BETA_PACK, { hooks: [], systemPrompts: [BETA_LIST] });
		snapshot = await promptSnapshot(sessionId);
		expect(extensionSections(snapshot).map((section) => section.packId)).toEqual([ALPHA_PACK]);
		expect(snapshot.stablePrefixSha256).toBe(stablePrefix);

		await putActivation(ALPHA_PACK, { hooks: [], systemPrompts: [ALPHA_LIST] });
		snapshot = await promptSnapshot(sessionId);
		expect(extensionSections(snapshot)).toEqual([]);
		expect(snapshot.sections.some((section) => section.content.includes("bobbit:extension-prompt-region"))).toBe(false);
		expect(snapshot.sections.some((section) => section.content.includes(ALPHA_CONTENT) || section.content.includes(BETA_CONTENT))).toBe(false);
		expect(snapshot.sections.some((section) => section.label === "System Prompt")).toBe(true);
		expect(snapshot.sections.some((section) => section.label === "Working Directory")).toBe(true);

		await page.reload({ waitUntil: "domcontentloaded" });
		await openSession(page, sessionId);
		dialog = await openPromptInspector(page);
		await expect(extensionDetails(dialog)).toHaveCount(0);
		await expect(dialog).not.toContainText(ALPHA_CONTENT);
		await expect(dialog).not.toContainText(BETA_CONTENT);
		await expect(dialog).toContainText("System Prompt");
		await expect(dialog).toContainText("Working Directory");
	});
});
