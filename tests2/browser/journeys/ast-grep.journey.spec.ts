import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAstGrepExtension } from "../../../market-packs/code-intelligence/tools/ast/extension.ts";
import { test, expect, apiFetch, createSession, deleteSession, openApp, navigateToHash, registerProject, sendMessage, waitForSessionStatus } from "../_helpers/journey-fixture.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const AST_SOURCE = path.resolve(__dirname, "..", "..", "..", "market-packs", "code-intelligence");
const PACK_NAME = "code-intelligence";
let sourceRoot = "";
let workspace = "";
let sourceId = "";
let projectId = "";
let sessionId = "";
const previousCwd = process.env.BOBBIT_CWD;

function writeFixtureManifest(packRoot: string): void {
	fs.writeFileSync(path.join(packRoot, "pack.yaml"), [
		`name: ${PACK_NAME}`,
		"schema: 2",
		"description: Test-only market-pack wrapper for the canonical AST tool source.",
		"version: 1.0.0",
		"contents:",
		"  roles: []",
		"  tools: [ast]",
		"  skills: []",
	].join("\n") + "\n");
}

async function installAstPack(): Promise<void> {
	sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-ast-pack-source-"));
	const packRoot = path.join(sourceRoot, PACK_NAME);
	fs.cpSync(AST_SOURCE, packRoot, { recursive: true });
	writeFixtureManifest(packRoot);

	const source = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: sourceRoot }),
	});
	expect(source.status, await source.clone().text()).toBe(201);
	sourceId = (await source.json()).source.id;
	const install = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId, dirName: PACK_NAME, scope: "server" }),
	});
	expect(install.status, await install.text()).toBe(201);
	const activate = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK_NAME, disabled: { enabled: true, tools: [] } }),
	});
	expect(activate.status, await activate.text()).toBe(200);
}

function loadCanonicalAstToolIntoMock(gateway: any, id: string): void {
	const mockAgent = gateway.sessionManager?.getSession(id)?.rpcClient?._agent;
	if (!mockAgent?.mockPiTools || typeof mockAgent.mockPiTools.set !== "function") {
		throw new Error("AST browser journey requires the established in-process mock tool seam");
	}
	let registered: any;
	createAstGrepExtension()({ registerTool: (tool: any) => { if (tool.name === "ast_grep") registered = tool; } } as any);
	if (!registered) throw new Error("canonical Code Intelligence ast_grep extension did not activate for the fixture workspace");
	mockAgent.mockPiTools.set("ast_grep", {
		handler: async (input: Record<string, unknown>, context: { toolCallId: string }) => {
			const result = await registered.execute(context.toolCallId, input, new AbortController().signal);
			return result.content?.[0]?.text ?? JSON.stringify(result);
		},
	});
}

async function cleanup(): Promise<void> {
	if (sessionId) await deleteSession(sessionId).catch(() => {});
	if (projectId) await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
	await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "server", packName: PACK_NAME }),
	}).catch(() => {});
	if (sourceId) await apiFetch(`/api/marketplace/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" }).catch(() => {});
	if (sourceRoot) fs.rmSync(sourceRoot, { recursive: true, force: true });
	if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
	if (previousCwd === undefined) delete process.env.BOBBIT_CWD;
	else process.env.BOBBIT_CWD = previousCwd;
}

test.describe("Journey: code-intelligence AST market pack", () => {
	test("activates the canonical AST pack, invokes its real tool, and retains the result after reload", async ({ page, gateway }) => {
		try {
			await installAstPack();
			workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-ast-browser-workspace-"));
			fs.mkdirSync(path.join(workspace, "src"));
			fs.writeFileSync(path.join(workspace, "src", "app.ts"), 'console.log("browser-journey");\n');

			const toolsResponse = await apiFetch("/api/tools");
			expect(toolsResponse.status).toBe(200);
			const astTool = ((await toolsResponse.json()).tools as Array<any>).find(tool => tool.name === "ast_grep");
			expect(astTool, "the activated pack must expose only its structural-search tool").toBeTruthy();
			expect(JSON.stringify(astTool)).toMatch(/read-only/i);
			expect(JSON.stringify(astTool)).not.toMatch(/\blsp\b/i);

			// The in-process mock loads extensions in this process. Preserve the same
			// CWD contract as a real agent so the registered pack tool searches the
			// session workspace, not the Bobbit checkout running the fixture.
			process.env.BOBBIT_CWD = workspace;
			const project = await registerProject({ name: `ast-browser-${Date.now()}`, rootPath: workspace });
			projectId = project.id;
			sessionId = await createSession({ cwd: workspace, projectId });
			await waitForSessionStatus(sessionId, "idle");
			// The browser's in-process mock intentionally loads only generated
			// `/pi-extensions` paths. Register the real canonical market-pack module
			// through its established test seam so this journey executes its tool,
			// rather than a fake output-only stand-in.
			loadCanonicalAstToolIntoMock(gateway, sessionId);
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);

			const invocation = `PI_EXTENSION_TOOL:ast_grep::${JSON.stringify({
				paths: ["src/app.ts"], pattern: "console.log($$$ARGS)", language: "typescript", strictness: "ast",
			})}`;
			await sendMessage(page, invocation);
			const card = page.locator('[data-tool-name="ast_grep"]').last();
			await expect(card).toBeVisible({ timeout: 20_000 });
			await expect(card).toContainText(/AST Grep/i);
			await expect.poll(() => {
				const messages = gateway.sessionManager?.getSession(sessionId)?.rpcClient?._agent?.conversationMessages ?? [];
				return messages.find((message: any) => message.role === "toolResult" && message.toolName === "ast_grep");
			}, { timeout: 20_000 }).toMatchObject({
				isError: false,
				content: [expect.objectContaining({ text: expect.stringContaining("src/app.ts") })],
			});

			await page.reload();
			const reloadedCard = page.locator('[data-tool-name="ast_grep"]').last();
			await expect(reloadedCard).toBeVisible({ timeout: 20_000 });
			await expect(reloadedCard).toContainText(/AST Grep/i);
		} finally {
			await cleanup();
		}
	});
});
