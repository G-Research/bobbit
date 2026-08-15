/**
 * Browser boundary for the existing project settings + sandbox status/build API.
 * The browser harness deliberately fences Docker, so the fake-runner integration
 * journey owns pending → available. This fixture proves the authenticated browser
 * route and persisted revoke/reload behavior without adding a requirement UI.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, registerProject } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

test.describe.configure({ mode: "serial", retries: 0 });

const PACK_ID = "sandbox-requirements-browser-fixture";
const REQUIREMENT_ID = "python-analysis";

type BrowserResponse = { status: number; text: string };

async function browserApi(page: Page, request: { path: string; method?: string; body?: unknown }): Promise<BrowserResponse> {
	return page.evaluate(async ({ path, method, body }) => {
		const token = localStorage.getItem("gateway.token");
		const response = await fetch(path, {
			method: method ?? "GET",
			credentials: "include",
			headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, text: await response.text() };
	}, request);
}

function json<T>(response: BrowserResponse): T {
	try { return JSON.parse(response.text) as T; }
	catch { throw new Error(`Expected JSON from ${response.status}: ${response.text}`); }
}

function writeFixturePack(bobbitDir: string): string {
	const packDir = path.join(bobbitDir, "config", "market-packs", PACK_ID);
	fs.rmSync(packDir, { recursive: true, force: true });
	fs.mkdirSync(path.join(packDir, "sandbox-requirements"), { recursive: true });
	fs.writeFileSync(path.join(packDir, ".pack-meta.yaml"), [
		"sourceUrl: browser-test", "sourceRef: local", "commit: fixture", `packName: ${PACK_ID}`,
		"version: 1.0.0", "installedAt: '2026-01-01T00:00:00.000Z'", "updatedAt: '2026-01-01T00:00:00.000Z'", "scope: server",
	].join("\n") + "\n");
	fs.writeFileSync(path.join(packDir, "pack.yaml"), [
		"schema: 3", `name: ${PACK_ID}`, "description: Browser sandbox requirement fixture", "version: 1.0.0",
		"contents:", "  roles: []", "  tools: []", "  skills: []", "  entrypoints: []", "  providers: []", "  hooks: []", "  mcp: []", "  pi-extensions: []", "  runtimes: []", "  workflows: []", `  sandboxRequirements: [${REQUIREMENT_ID}]`,
	].join("\n") + "\n");
	fs.writeFileSync(path.join(packDir, "sandbox-requirements", `${REQUIREMENT_ID}.yaml`), [
		`id: ${REQUIREMENT_ID}`, "profiles: [python]", "config:", "  enabled: { type: boolean, default: true }", "activation:", "  requiresConfig: [enabled]",
	].join("\n") + "\n");
	return packDir;
}

async function readServerPackOrder(): Promise<string[]> {
	const response = await apiFetch("/api/marketplace/pack-order?scope=server");
	expect(response.status, await response.clone().text()).toBe(200);
	return (await response.json() as { order: string[] }).order;
}

async function notifyPackFilesystemMutation(order: string[]): Promise<void> {
	const response = await apiFetch("/api/marketplace/pack-order", { method: "PUT", body: JSON.stringify({ scope: "server", order }) });
	expect(response.status, await response.clone().text()).toBe(200);
}

test.describe("sandbox extension requirements browser API journey", () => {
	let packDir: string | undefined;
	let projectRoot: string | undefined;
	let projectId: string | undefined;
	let originalPackOrder: string[] | undefined;

	test.beforeAll(async ({ gateway }) => {
		originalPackOrder = await readServerPackOrder();
		packDir = writeFixturePack(gateway.bobbitDir);
		await notifyPackFilesystemMutation(originalPackOrder);
		const activated = await apiFetch("/api/marketplace/pack-activation", { method: "PUT", body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled: { enabled: true, sandboxRequirements: [] } }) });
		expect(activated.status, await activated.clone().text()).toBe(200);
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-requirements-browser-project-"));
		const project = await registerProject({ name: `sandbox-requirements-browser-${Date.now()}`, rootPath: projectRoot, seedWorkflows: false });
		projectId = project.id;
		const configured = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/config`, { method: "PUT", body: JSON.stringify({ sandbox: "docker", sandbox_image: "registry.example.test/team/browser-agent:base" }) });
		expect(configured.status, await configured.clone().text()).toBe(200);
	});

	test.afterAll(async () => {
		if (projectId) await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
		if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
		if (originalPackOrder) await notifyPackFilesystemMutation(originalPackOrder).catch(() => {});
		if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
	});

	test("grants an exact pack build capability, survives reload, and removes the server-resolved profile on revoke", async ({ page }) => {
		if (!projectId) throw new Error("fixture project was not registered");
		await openApp(page);
		await browserApi(page, { path: "/api/goals" }); // mint the normal browser operator proof
		const statusPath = `/api/sandbox-status?projectId=${encodeURIComponent(projectId)}`;
		const grantsPath = `/api/projects/${encodeURIComponent(projectId)}/extension-grants`;
		const revokePath = `${grantsPath}/${encodeURIComponent(PACK_ID)}/principals/pack/sandbox%3Abuild`;

		let response = await browserApi(page, { path: statusPath });
		expect(response.status, response.text).toBe(200);
		expect(json<any>(response).requirements).toMatchObject({ profiles: [], entries: [] });

		response = await browserApi(page, { path: grantsPath, method: "PUT", body: { packId: PACK_ID, principal: "pack", capability: "sandbox:build" } });
		expect(response.status, response.text).toBe(200);
		expect(json<any>(response).grant).toMatchObject({ packId: PACK_ID, principal: "pack", capability: "sandbox:build" });

		response = await browserApi(page, { path: statusPath });
		expect(response.status, response.text).toBe(200);
		// Docker is intentionally unavailable in this browser harness; authorization
		// must still project the exact server-owned profile, never client data.
		expect(json<any>(response).requirements).toMatchObject({ profiles: ["python"], entries: [{ packId: PACK_ID, requirementId: REQUIREMENT_ID, state: "unsupported" }] });

		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
		response = await browserApi(page, { path: statusPath });
		expect(response.status, response.text).toBe(200);
		expect(json<any>(response).requirements).toMatchObject({ profiles: ["python"], entries: [{ state: "unsupported" }] });

		response = await browserApi(page, { path: revokePath, method: "DELETE" });
		expect(response.status, response.text).toBe(200);
		expect(json<any>(response).revoked).toBe(true);
		response = await browserApi(page, { path: statusPath });
		expect(response.status, response.text).toBe(200);
		expect(json<any>(response).requirements).toMatchObject({ profiles: [], entries: [] });
	});
});
