import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import {
	apiFetch,
	createSession,
	deleteSession,
	expect,
	navigateToHash,
	registerProject,
	test,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";
import { readE2EToken } from "../e2e-setup.js";
import { getFreePort } from "../e2e/packaged-runtime-helpers.js";
import {
	startSourceVite,
	stopSourceProcess,
	waitForSourceVite,
	type RunningSourceProcess,
} from "../e2e/source-vite-runtime-helpers.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const SOURCE_DIR = fileURLToPath(new URL("../fixtures/pack-hot-reload", import.meta.url));
const PACK_NAME = "pack-hot-reload-fixture";
const TOOL_NAME = "pack_hot_reload_probe";
const PANEL_ID = "hot-reload-fixture.detail";
const RELOAD_TOKEN = 42;

function rendererBundle(version: "v2"): string {
	return `export default function createRenderer({ html }) {
\tconst version = ${JSON.stringify(version)};
\treturn {
\t\trender(_params, _result, _isStreaming, ctx) {
\t\t\tconst openPanel = () => ctx?.host?.ui?.openPanel({
\t\t\t\tpanelId: "${PANEL_ID}",
\t\t\t\tparams: { artifactId: "artifact-42", marker: "stable-marker" },
\t\t\t});
\t\t\treturn {
\t\t\t\tisCustom: false,
\t\t\t\tcontent: html\`
\t\t\t\t\t<section data-testid="pack-hot-reload-renderer" data-version=\${version}>
\t\t\t\t\t\t<span data-testid="pack-hot-reload-renderer-version">renderer \${version}</span>
\t\t\t\t\t\t<button type="button" data-testid="pack-hot-reload-open-panel" @click=\${openPanel}>Open fixture panel</button>
\t\t\t\t\t</section>
\t\t\t\t\`,
\t\t\t};
\t\t},
\t};
}
`;
}

function panelBundle(version: "v2"): string {
	return `export default function createPanel({ html }) {
\tconst version = ${JSON.stringify(version)};
\treturn {
\t\trender(params) {
\t\t\treturn html\`
\t\t\t\t<section
\t\t\t\t\tdata-testid="pack-hot-reload-panel"
\t\t\t\t\tdata-version=\${version}
\t\t\t\t\tdata-artifact-id=\${String(params?.artifactId ?? "")}
\t\t\t\t\tdata-marker=\${String(params?.marker ?? "")}
\t\t\t\t>
\t\t\t\t\t<span data-testid="pack-hot-reload-panel-version">panel \${version}</span>
\t\t\t\t</section>
\t\t\t\`;
\t\t},
\t};
}
`;
}

async function responseText(response: Response): Promise<string> {
	return response.clone().text().catch(() => "");
}

async function addFixtureSource(sourceRoot: string): Promise<string> {
	const response = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: sourceRoot }),
	});
	if (response.status === 409) {
		const list = await apiFetch("/api/marketplace/sources");
		const source = ((await list.json()).sources ?? []).find((item: { id: string; url: string }) => item.url === sourceRoot);
		expect(source, "the existing hot-reload fixture source should be discoverable").toBeTruthy();
		return source.id;
	}
	expect(response.status, `fixture source registration failed: ${await responseText(response)}`).toBe(201);
	return (await response.json()).source.id;
}

async function installFixturePack(sourceId: string, projectId: string): Promise<void> {
	const response = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId, dirName: PACK_NAME, scope: "project", projectId }),
	});
	expect(response.status, `fixture pack installation failed: ${await responseText(response)}`).toBe(201);
}

async function updateFixturePack(projectId: string): Promise<void> {
	const response = await apiFetch("/api/marketplace/update", {
		method: "POST",
		body: JSON.stringify({ scope: "project", packName: PACK_NAME, projectId }),
	});
	expect(response.status, `fixture pack update failed: ${await responseText(response)}`).toBe(200);
}

async function uninstallFixturePack(projectId: string): Promise<void> {
	await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "project", projectId, packName: PACK_NAME }),
	}).catch(() => {});
}

function seedToolTranscript(gateway: any, sessionId: string): void {
	const agent = gateway.sessionManager?.getSession(sessionId)?.rpcClient?._agent;
	if (!Array.isArray(agent?.conversationMessages)) throw new Error("hot-reload journey requires the in-process mock agent transcript");
	const toolCallId = "pack-hot-reload-tool-call";
	agent.conversationMessages = [
		{
			id: `${toolCallId}-assistant`,
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: TOOL_NAME, arguments: { artifactId: "artifact-42" } }],
			timestamp: 1,
		},
		{
			id: `${toolCallId}-result`,
			role: "toolResult",
			toolCallId,
			toolName: TOOL_NAME,
			isError: false,
			content: [{ type: "text", text: "fixture result" }],
			timestamp: 2,
		},
	];
}

interface WorkspaceSnapshot {
	tabCount: number;
	tabOrder: string[];
	activeId: string;
	packTab: {
		id: string;
		kind: string;
		packId: string;
		panelId: string;
		instanceKey: string;
		params: Record<string, unknown> | null;
		stateInstanceKey: string;
		stateParams: Record<string, unknown> | null;
	};
}

async function workspaceSnapshot(page: Page, sessionId: string): Promise<WorkspaceSnapshot> {
	return page.evaluate(({ sessionId, packName, panelId }) => {
		const state = (window as any).__bobbitState;
		const tabs = Array.isArray(state?.panelTabsBySession?.[sessionId]) ? state.panelTabsBySession[sessionId] : [];
		const tab = tabs.find((candidate: any) => candidate?.source?.type === "pack"
			&& candidate.source.packId === packName
			&& candidate.source.panelId === panelId);
		if (!tab) throw new Error("parameterized hot-reload panel tab was not present in the workspace");
		return {
			tabCount: tabs.length,
			tabOrder: tabs.map((candidate: any) => String(candidate.id)),
			activeId: String(state.panelWorkspaceActiveBySession?.[sessionId] ?? state.activePanelTabId ?? ""),
			packTab: {
				id: String(tab.id),
				kind: String(tab.kind),
				packId: String(tab.source.packId),
				panelId: String(tab.source.panelId),
				instanceKey: String(tab.source.instanceKey),
				params: tab.source.params ? structuredClone(tab.source.params) : null,
				stateInstanceKey: String(tab.state?.instanceKey),
				stateParams: tab.state?.params ? structuredClone(tab.state.params) : null,
			},
		};
	}, { sessionId, packName: PACK_NAME, panelId: PANEL_ID });
}

function isRendererRequest(raw: string): boolean {
	return new URL(raw).pathname === `/api/tools/${TOOL_NAME}/renderer`;
}

function isPanelRequest(raw: string): boolean {
	return new URL(raw).pathname === `/api/ext/packs/${PACK_NAME}/panels/${PANEL_ID}`;
}

test.describe("Journey: marketplace-pack development hot reload", () => {
	test("repaints nested renderer and parameterized panel while preserving page and workspace identity", async ({ page, gateway }) => {
		test.setTimeout(150_000);
		const runRoot = process.env.BOBBIT_E2E_TMP_ROOT;
		if (!runRoot) throw new Error("BOBBIT_E2E_TMP_ROOT must identify the browser run root");
		const tempRoot = mkdtempSync(join(runRoot, "pack-hot-reload-"));
		const projectRoot = join(tempRoot, "project");
		const marketplaceSourceRoot = join(tempRoot, "marketplace-source");
		mkdirSync(projectRoot, { recursive: true });
		cpSync(SOURCE_DIR, marketplaceSourceRoot, { recursive: true });
		let projectId: string | undefined;
		let sessionId: string | undefined;
		let sourceId: string | undefined;
		let vite: RunningSourceProcess | undefined;
		const moduleRequests: string[] = [];
		const cleanupFailures: unknown[] = [];

		try {
			projectId = (await registerProject({
				name: `pack-hot-reload-${Date.now()}`,
				rootPath: projectRoot,
				seedWorkflows: false,
			})).id;
			sourceId = await addFixtureSource(marketplaceSourceRoot);
			await installFixturePack(sourceId, projectId);
			sessionId = await createSession({ projectId, cwd: projectRoot });
			await waitForSessionStatus(sessionId, "idle", 30_000);
			seedToolTranscript(gateway, sessionId);

			const vitePort = await getFreePort();
			const viteBaseUrl = `http://127.0.0.1:${vitePort}`;
			vite = startSourceVite({
				repoRoot: REPO_ROOT,
				tempRoot: projectRoot,
				gatewayUrl: gateway.baseURL,
				port: vitePort,
			});
			await waitForSourceVite(viteBaseUrl, vite);

			page.on("request", (request) => {
				if (isRendererRequest(request.url()) || isPanelRequest(request.url())) moduleRequests.push(request.url());
			});
			const token = readE2EToken();
			await page.goto(`${viteBaseUrl}/?token=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 25_000 });

			const renderer = page.getByTestId("pack-hot-reload-renderer");
			await expect(renderer).toHaveAttribute("data-version", "v1", { timeout: 25_000 });
			await page.getByTestId("pack-hot-reload-open-panel").click();
			const panel = page.getByTestId("pack-hot-reload-panel");
			await expect(panel).toHaveAttribute("data-version", "v1", { timeout: 25_000 });
			await expect(panel).toHaveAttribute("data-artifact-id", "artifact-42");
			await expect(panel).toHaveAttribute("data-marker", "stable-marker");

			await page.evaluate(() => {
				(window as any).__packHotReloadPageIdentity = { nonce: crypto.randomUUID() };
				(window as any).__packHotReloadOriginalPageIdentity = (window as any).__packHotReloadPageIdentity;
			});
			const urlBefore = page.url();
			const workspaceBefore = await workspaceSnapshot(page, sessionId);
			expect(workspaceBefore.activeId).toBe(workspaceBefore.packTab.id);
			expect(workspaceBefore.packTab).toMatchObject({
				kind: "pack",
				packId: PACK_NAME,
				panelId: PANEL_ID,
				instanceKey: "artifact-42",
				stateInstanceKey: "artifact-42",
				params: { artifactId: "artifact-42", marker: "stable-marker" },
				stateParams: { artifactId: "artifact-42", marker: "stable-marker" },
			});

			const authoredPackRoot = join(marketplaceSourceRoot, PACK_NAME);
			writeFileSync(join(authoredPackRoot, "lib", "nested", "hot-reload", "renderer.js"), rendererBundle("v2"), "utf8");
			writeFileSync(join(authoredPackRoot, "lib", "nested", "hot-reload", "panel.js"), panelBundle("v2"), "utf8");
			await updateFixturePack(projectId);

			const rebuilt = await fetch(`${viteBaseUrl}/__bobbit_dev/pack-rebuilt`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Bobbit-Pack-Reload": "1",
				},
				body: JSON.stringify({ pack: PACK_NAME, reloadToken: RELOAD_TOKEN }),
			});
			expect(rebuilt.status, `Vite pack rebuild bridge failed: ${await rebuilt.clone().text()}`).toBe(204);

			await expect(renderer).toHaveAttribute("data-version", "v2", { timeout: 25_000 });
			await expect(panel).toHaveAttribute("data-version", "v2", { timeout: 25_000 });
			await expect(panel).toHaveAttribute("data-artifact-id", "artifact-42");
			await expect(panel).toHaveAttribute("data-marker", "stable-marker");
			expect(page.url(), "pack reload must not navigate the page").toBe(urlBefore);
			expect(await page.evaluate(() => (window as any).__packHotReloadPageIdentity === (window as any).__packHotReloadOriginalPageIdentity),
				"custom pack reconciliation must preserve the live page realm").toBe(true);
			expect(await workspaceSnapshot(page, sessionId), "hot reload must preserve tab order, active selection, params, and instance identity").toEqual(workspaceBefore);

			await expect.poll(() => moduleRequests.some((raw) => isRendererRequest(raw) && new URL(raw).searchParams.get("devReload") === String(RELOAD_TOKEN)), {
				timeout: 20_000,
				message: "renderer reload must use the successful-cycle token on the authenticated byte fetch",
			}).toBe(true);
			await expect.poll(() => moduleRequests.some((raw) => isPanelRequest(raw) && new URL(raw).searchParams.get("devReload") === String(RELOAD_TOKEN)), {
				timeout: 20_000,
				message: "panel reload must use the successful-cycle token on the authenticated byte fetch",
			}).toBe(true);

			const requestsBeforeReload = moduleRequests.length;
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.getByTestId("pack-hot-reload-renderer")).toHaveAttribute("data-version", "v2", { timeout: 30_000 });
			await expect(page.getByTestId("pack-hot-reload-panel")).toHaveAttribute("data-version", "v2", { timeout: 30_000 });
			expect(await page.evaluate(() => typeof (window as any).__packHotReloadPageIdentity), "ordinary reload must create a new page realm").toBe("undefined");
			expect(await workspaceSnapshot(page, sessionId), "ordinary reload must restore the same durable parameterized tab").toEqual(workspaceBefore);
			const ordinaryReloadRequests = moduleRequests.slice(requestsBeforeReload);
			expect(ordinaryReloadRequests.some((raw) => isRendererRequest(raw) && !new URL(raw).searchParams.has("devReload")),
				"ordinary reload must restore v2 through the normal renderer byte URL").toBe(true);
			expect(ordinaryReloadRequests.some((raw) => isPanelRequest(raw) && !new URL(raw).searchParams.has("devReload")),
				"ordinary reload must restore v2 through the normal panel byte URL").toBe(true);
		} finally {
			if (vite) await stopSourceProcess(vite).catch((error) => cleanupFailures.push(error));
			if (sessionId) await deleteSession(sessionId).catch((error) => cleanupFailures.push(error));
			if (projectId) await uninstallFixturePack(projectId).catch((error) => cleanupFailures.push(error));
			if (sourceId) await apiFetch(`/api/marketplace/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" }).catch((error) => cleanupFailures.push(error));
			if (projectId) await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch((error) => cleanupFailures.push(error));
			try { rmSync(tempRoot, { recursive: true, force: true }); } catch (error) { cleanupFailures.push(error); }
			if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, "hot-reload journey cleanup failed");
		}
	});
});
