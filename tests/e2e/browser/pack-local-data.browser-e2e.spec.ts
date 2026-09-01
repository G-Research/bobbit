import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import {
	apiFetch,
	createSession,
	defaultProject,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	test,
} from "../../../tests2/browser/_helpers/journey-fixture.js";

const PACK = "pack-local-data";
const SOURCE = fileURLToPath(new URL("../../../market-packs/_fixtures", import.meta.url));

let sourceId: string | undefined;
let sessionId: string | undefined;

async function installAndEnable(): Promise<void> {
	const source = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: SOURCE }),
	});
	const sourceText = await source.text();
	if (source.status === 409) {
		const existing = await apiFetch("/api/marketplace/sources");
		expect(existing.status).toBe(200);
		sourceId = ((await existing.json()).sources ?? []).find((item: any) => item.url === SOURCE)?.id;
		expect(sourceId, sourceText).toBeTruthy();
	} else {
		expect(source.status, sourceText).toBe(201);
		sourceId = JSON.parse(sourceText).source.id;
	}

	const install = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId, dirName: PACK, scope: "server" }),
	});
	const installText = await install.text();
	expect(install.status, installText).toBe(201);

	const enable = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK, disabled: { enabled: true } }),
	});
	const enableText = await enable.text();
	expect(enable.status, enableText).toBe(200);
}

async function uninstall(): Promise<Response> {
	return apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "server", packName: PACK }),
	});
}

async function packIsContributed(): Promise<boolean> {
	const response = await apiFetch("/api/ext/contributions");
	expect(response.status).toBe(200);
	return ((await response.json()).packs ?? []).some((pack: any) => pack.packId === PACK);
}

async function selectSessionAndOpenPanel(page: Page, id: string): Promise<void> {
	await navigateToHash(page, `#/session/${id}`);
	await expect.poll(
		() => page.evaluate(() => (window as any).__bobbitState?.selectedSessionId ?? (window as any).bobbitState?.selectedSessionId),
		{ timeout: 15_000 },
	).toBe(id);
	await navigateToHash(page, "#/ext/pack-local-data");
	await page.getByRole("button", { name: "Open Pack Local Data Fixture" }).click();
}

test.describe.configure({ mode: "serial" });

test.afterEach(async () => {
	if (sessionId) await deleteSession(sessionId).catch(() => {});
	sessionId = undefined;
	await uninstall().catch(() => {});
	if (sourceId) {
		await apiFetch(`/api/marketplace/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" }).catch(() => {});
		sourceId = undefined;
	}
	const project = await defaultProject().catch(() => undefined);
	if (project) fs.rmSync(path.join(project.rootPath, ".pack-local-data-fixture"), { recursive: true, force: true });
});

test("installed pack panel resolves browser and route local data, survives reload, and preserves data on uninstall", async ({ page }) => {
	const project = await defaultProject();
	await installAndEnable();
	await expect.poll(() => packIsContributed(), { timeout: 15_000 }).toBe(true);

	sessionId = await createSession({ projectId: project.id });
	const declaredDirectory = path.join(project.rootPath, ".pack-local-data-fixture");
	await expect.poll(() => fs.existsSync(declaredDirectory), {
		timeout: 15_000,
		message: "Pack Local Data activation should materialize the project directory",
	}).toBe(true);
	const expectedDirectory = fs.realpathSync(declaredDirectory);

	await openApp(page);
	await selectSessionAndOpenPanel(page, sessionId);
	await expect(page.locator('[data-testid="pack-local-data-browser-directory"]')).toHaveText(expectedDirectory, { timeout: 20_000 });
	await expect(page.locator('[data-testid="pack-local-data-route-directory"]')).toHaveText(expectedDirectory);
	await expect(page.locator('[data-testid="pack-local-data-markers"]')).toContainText('"host-marker.txt":"written-by-browser-route"');

	await page.reload();
	await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
	await selectSessionAndOpenPanel(page, sessionId);
	await expect(page.locator('[data-testid="pack-local-data-browser-directory"]')).toHaveText(expectedDirectory, { timeout: 20_000 });
	await expect(page.locator('[data-testid="pack-local-data-route-directory"]')).toHaveText(expectedDirectory);

	const removed = await uninstall();
	expect(removed.status).toBe(204);
	await expect.poll(() => packIsContributed(), { timeout: 15_000 }).toBe(false);
	expect(fs.readFileSync(path.join(expectedDirectory, "host-marker.txt"), "utf8")).toBe("written-by-browser-route");
});
