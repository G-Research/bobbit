/**
 * Retained spawned-gateway smoke for the artifacts market-pack renderer/panel chain.
 * Per-type rendering, sandboxing, markdown, hljs/pdf/docx roots, and helper logic
 * are covered by tests/artifacts-pack-viewer.test.ts.
 */
import { fileURLToPath } from "node:url";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

test.describe.configure({ mode: "serial" });

const SOURCE_DIR = fileURLToPath(new URL("../../../market-packs", import.meta.url));
const PACK = "artifacts";
const TOOL = "artifact_demo";
const HTML_ARTIFACT = { id: "art-demo-1", trigger: "ARTIFACT_DEMO_TOOL please", filename: "hello.html", content: "<h1>Hello Artifact</h1>" };

const tid = (id: string) => `[data-testid="${id}"]`;
const pillFor = (artifactId: string) => `${tid("artifact-pill")}[data-artifact-id="${artifactId}"]`;

async function installArtifactsPack(): Promise<void> {
	const addRes = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: SOURCE_DIR }),
	});
	const addBody = await addRes.text();
	expect(addRes.status, addBody).toBe(201);
	const sourceId = (JSON.parse(addBody) as { source: { id: string } }).source.id;

	const instRes = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId, dirName: PACK, scope: "server" }),
	});
	const instBody = await instRes.text();
	expect(instRes.status, instBody).toBe(201);
}

async function cleanup(): Promise<void> {
	await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "server", packName: PACK }),
	}).catch(() => {});
	try {
		const res = await apiFetch("/api/marketplace/sources");
		for (const s of ((await res.json()).sources ?? []) as Array<{ id: string }>) {
			await apiFetch(`/api/marketplace/sources/${encodeURIComponent(s.id)}`, { method: "DELETE" }).catch(() => {});
		}
	} catch { /* ignore */ }
}

async function listTools(): Promise<Array<{ name: string; rendererKind?: string }>> {
	const res = await apiFetch("/api/tools");
	expect(res.ok).toBe(true);
	return (await res.json()).tools;
}

async function listContributions(): Promise<Array<{ packId: string; panels: { id: string }[]; entrypoints: Array<{ kind: string; routeId?: string }> }>> {
	const res = await apiFetch("/api/ext/contributions");
	expect(res.ok).toBe(true);
	return (await res.json()).packs;
}

test.afterEach(async () => {
	await cleanup();
});

test.describe("artifacts pack renderer smoke", () => {
	test("install → pill does not auto-invoke store → click opens store-backed viewer → reload and uninstall reconcile @smoke", async ({ page }) => {
		await page.setViewportSize({ width: 1400, height: 900 });
		await installArtifactsPack();

		const tools = await listTools();
		expect(tools.find((t) => t.name === TOOL)?.rendererKind).toBe("pack");
		const contributions = await listContributions();
		const packMeta = contributions.find((p) => p.packId === PACK);
		expect(packMeta?.panels?.some((p) => p.id === "artifacts.viewer")).toBe(true);
		expect(packMeta?.entrypoints?.some((e) => e.kind === "route" && e.routeId === "artifacts")).toBe(true);

		const storePuts: string[] = [];
		const storeGets: string[] = [];
		page.on("request", (r) => {
			if (r.method() !== "POST") return;
			const u = r.url();
			if (/\/api\/ext\/store\/put\b/.test(u)) storePuts.push(u);
			else if (/\/api\/ext\/store\/get\b/.test(u)) storeGets.push(u);
		});

		await openApp(page);
		await createSessionViaUI(page);
		const sid = await page.evaluate(() => (window as any).__bobbitState?.selectedSessionId as string | null);
		expect(sid).toBeTruthy();

		await sendMessage(page, HTML_ARTIFACT.trigger);
		await expect(page.locator(pillFor(HTML_ARTIFACT.id)).first()).toBeVisible({ timeout: 25_000 });
		await waitForSessionStatus(sid!, "idle").catch(() => {});
		expect(storePuts, "renderer must not persist to the store on render").toHaveLength(0);
		expect(storeGets, "renderer must not read from the store on render").toHaveLength(0);

		await page.locator(pillFor(HTML_ARTIFACT.id)).first().click();
		await expect(page.locator(tid("pack-panel-root"))).toBeVisible({ timeout: 15_000 });
		const viewer = page.locator(tid("artifact-viewer-content")).first();
		await expect(viewer).toBeVisible({ timeout: 15_000 });
		await expect(viewer).toHaveAttribute("data-artifact-id", HTML_ARTIFACT.id);
		await expect(viewer).toHaveAttribute("data-artifact-type", "html");
		await expect(page.locator(tid("artifact-viewer-filename"))).toHaveText(HTML_ARTIFACT.filename);
		await expect(page.locator(tid("artifact-viewer-iframe"))).toHaveAttribute("sandbox", "allow-scripts");
		await expect(page.locator(tid("artifact-viewer-iframe"))).toHaveAttribute("srcdoc", /Hello Artifact/);
		expect(storePuts.length).toBeGreaterThan(0);
		expect(storeGets.length).toBeGreaterThan(0);

		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
		await expect(page.locator(pillFor(HTML_ARTIFACT.id)).first()).toBeVisible({ timeout: 25_000 });

		const delRes = await apiFetch("/api/marketplace/installed", {
			method: "DELETE",
			body: JSON.stringify({ scope: "server", packName: PACK }),
		});
		expect(delRes.status).toBe(204);
		expect((await listTools()).find((t) => t.name === TOOL)).toBeFalsy();
	});
});
