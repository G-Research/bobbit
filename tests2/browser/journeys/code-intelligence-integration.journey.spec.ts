/**
 * Journey: Code Intelligence integration
 *
 * Composes the real project-onboarding, Marketplace, extension-panel, and
 * structural-search seams. It intentionally uses no Code Intelligence-specific
 * import hook: the product import completes before the server-wide opt-in.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAstGrepExtension } from "../../../market-packs/code-intelligence/tools/ast/extension.ts";
import { test, expect, apiFetch, deleteSession, openApp, navigateToHash, sendMessage, waitForSessionStatus } from "../_helpers/journey-fixture.js";
import { ADD_PROJECT, openAddProjectDialog, preflightAvailable, uniqueDir } from "../_helpers/project-onboarding.js";

const PACK = "code-intelligence";
const GRAPH_TOOLS = ["graph_affected", "graph_explain", "graph_path", "graph_neighbors", "graph_query", "graph_status"] as const;
const STATIC_AST_GREP_BINARY = join(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"node_modules",
	".bin",
	process.platform === "win32" ? "ast-grep.cmd" : "ast-grep",
);

let workspace = "";
let sessionId = "";
let projectId = "";
const previousCwd = process.env.BOBBIT_CWD;
const previousAstGrepPath = process.env.BOBBIT_AST_GREP_PATH;

type Contribution = { packId: string; routeNames?: string[]; panels?: Array<{ id: string }> };

async function contributions(): Promise<Contribution[]> {
	const response = await apiFetch("/api/ext/contributions");
	expect(response.ok).toBe(true);
	return (await response.json()).packs as Contribution[];
}

async function toolNames(): Promise<Set<string>> {
	const response = await apiFetch("/api/tools");
	expect(response.ok).toBe(true);
	return new Set(((await response.json()).tools as Array<{ name: string }>).map((tool) => tool.name));
}

async function disablePack(): Promise<void> {
	await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK, disabled: {} }),
	}).catch(() => {});
}

async function expectDisabledGoldenPath(): Promise<void> {
	await expect.poll(async () => (await contributions()).some((pack) => pack.packId === PACK), { timeout: 15_000 }).toBe(false);
	await expect.poll(async () => {
		const names = await toolNames();
		return ["ast_grep", ...GRAPH_TOOLS].some((name) => names.has(name)) || [...names].some((name) => name.startsWith("lsp_"));
	}, { timeout: 15_000 }).toBe(false);
}

/** Invoke the canonical runner, not a canned mock result. The in-process test
 * agent intentionally only auto-loads generated pi-extension paths, so this
 * follows the established AST journey seam while executing the real binary. */
function loadCanonicalAstTool(gateway: any, id: string): void {
	const mockAgent = gateway.sessionManager?.getSession(id)?.rpcClient?._agent;
	if (!mockAgent?.mockPiTools || typeof mockAgent.mockPiTools.set !== "function") {
		throw new Error("Code Intelligence journey requires the established in-process mock tool seam");
	}
	let registered: any;
	createAstGrepExtension()({ registerTool: (tool: any) => { if (tool.name === "ast_grep") registered = tool; } } as any);
	if (!registered) throw new Error("The canonical ast_grep extension did not register for the imported workspace");
	mockAgent.mockPiTools.set("ast_grep", {
		handler: async (input: Record<string, unknown>, context: { toolCallId: string }) => {
			const result = await registered.execute(context.toolCallId, input, new AbortController().signal);
			return result.content?.[0]?.text ?? JSON.stringify(result);
		},
	});
}

function makeImportFixture(): string {
	const root = uniqueDir("code-intelligence-integration");
	mkdirSync(join(root, ".git"), { recursive: true });
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(root, "cmd", "fixture"), { recursive: true });
	writeFileSync(join(root, "package.json"), '{"name":"code-intelligence-browser-fixture"}\n');
	writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"target":"ES2022"}}\n');
	writeFileSync(join(root, "go.mod"), "module example.com/code-intelligence-fixture\n\ngo 1.22\n");
	writeFileSync(join(root, "src", "app.ts"), 'console.log("CODE_INTELLIGENCE_SOURCE_READ");\n');
	writeFileSync(join(root, "cmd", "fixture", "main.go"), "package main\n\nfunc main() { println(\"go fixture\") }\n");
	return root;
}

async function cleanup(): Promise<void> {
	if (sessionId) await deleteSession(sessionId).catch(() => {});
	if (projectId) await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
	await disablePack();
	if (workspace) rmSync(workspace, { recursive: true, force: true });
	if (previousCwd === undefined) delete process.env.BOBBIT_CWD;
	else process.env.BOBBIT_CWD = previousCwd;
	if (previousAstGrepPath === undefined) delete process.env.BOBBIT_AST_GREP_PATH;
	else process.env.BOBBIT_AST_GREP_PATH = previousAstGrepPath;
}

// This journey changes server-scoped activation. Never retry it: retries could
// hide a failed reload reconciliation or leave a later worker with enabled tools.
test.describe.configure({ mode: "serial", retries: 0 });

test.describe("Journey: Code Intelligence integration", () => {
	test("imports normally, enables server-scoped capabilities, queries and reads source, reloads, then cleans up", async ({ page, gateway }, testInfo) => {
		test.setTimeout(120_000);
		if (!(await preflightAvailable())) { testInfo.skip(true, "project preflight endpoint unavailable"); return; }
		expect(existsSync(STATIC_AST_GREP_BINARY), "the pinned ast-grep test binary must be installed").toBe(true);
		expect(spawnSync(STATIC_AST_GREP_BINARY, ["--version"], { encoding: "utf8", shell: false }).status).toBe(0);

		try {
			await disablePack();
			await expectDisabledGoldenPath();
			await openApp(page);
			await navigateToHash(page, "#/ext/code-intelligence");
			await expect(page.getByTestId("ext-route-unavailable")).toBeVisible({ timeout: 15_000 });

			// A normal Add Project flow has no Code Intelligence decision or claim.
			workspace = makeImportFixture();
			await navigateToHash(page, "#/settings/projects");
			await openAddProjectDialog(page);
			const dialog = page.locator(ADD_PROJECT.dialog);
			await expect(dialog).not.toContainText(/Code Intelligence/i);
			await dialog.locator(ADD_PROJECT.pickerInput).fill(workspace);
			await expect(page.locator(ADD_PROJECT.preflightPanel)).toBeVisible({ timeout: 15_000 });
			await expect.poll(async () => (await page.locator(ADD_PROJECT.preflightPanel).getAttribute("data-has-fail")) ?? "loading", { timeout: 15_000 }).toBe("0");
			await page.locator("button").filter({ hasText: "Continue" }).first().click();
			await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 20_000 }).toMatch(/^#\/session\//);
			sessionId = (await page.evaluate(() => window.location.hash)).replace(/^#\/session\//, "");
			await waitForSessionStatus(sessionId, "idle");
			const session = await (await apiFetch(`/api/sessions/${sessionId}`)).json() as { projectId?: string };
			projectId = session.projectId ?? "";

			// The Marketplace control must disclose that this is a server-wide,
			// explicit activation; use keyboard activation to cover the native toggle.
			await navigateToHash(page, "#/market");
			const card = page.locator(`[data-testid="market-installed-pack"][data-builtin="true"][data-pack-name="${PACK}"]`).first();
			await expect(card).toBeVisible({ timeout: 20_000 });
			const toggle = card.getByRole("checkbox", { name: "Enable Code Intelligence for this Bobbit server", exact: true });
			await expect(toggle).not.toBeChecked();
			await toggle.focus();
			const activation = page.waitForResponse((response) => response.url().includes("/api/marketplace/pack-activation") && response.request().method() === "PUT");
			await page.keyboard.press("Space");
			await activation;
			await expect(toggle).toBeChecked();
			await expect.poll(async () => {
				const names = await toolNames();
				return names.has("ast_grep") && GRAPH_TOOLS.every((name) => names.has(name));
			}, { timeout: 15_000 }).toBe(true);

			process.env.BOBBIT_AST_GREP_PATH = STATIC_AST_GREP_BINARY;
			process.env.BOBBIT_CWD = workspace;
			loadCanonicalAstTool(gateway, sessionId);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, "#/ext/code-intelligence");
			const panel = page.getByTestId("code-intelligence-status-panel");
			await expect(panel).toBeVisible({ timeout: 20_000 });
			await panel.getByTestId("graph-status-load").click();
			await expect(panel).toContainText("TypeScript", { timeout: 20_000 });
			await expect(panel).toContainText("Go");
			await expect(panel).toContainText(/Structural search.*Supported|Supported.*Structural search/is);
			// Detection is not an LSP readiness claim. This fixture has no managed
			// exact-worktree service, so both language declarations remain non-ready.
			await expect(panel).toContainText(/TypeScript Language Server|typescript-language-server/i);
			await expect(panel).toContainText(/gopls|Go toolchain/i);
			await expect(panel).not.toContainText(/LSP\s+Ready/i);
			await expect(panel.getByTestId("code-intelligence-no-cross-repo-warning")).toContainText("v1 has no cross-repo edges");
			await expect(panel).toContainText(/source verification|verify.*read|read.*source/i);
			await expect.poll(async () => {
				const cards = await panel.getByTestId("graph-status-component").count();
				const empty = await panel.getByTestId("graph-status-empty").count();
				return cards + empty > 0;
			}, { timeout: 15_000 }).toBe(true);

			// A natural stale/base-fallback status is optional in this isolated
			// import. When the host has one, its consequence must remain visible.
			const panelText = await panel.innerText();
			if (/BASE FALLBACK/i.test(panelText)) expect(panelText).toMatch(/branch graph is not current|may omit branch-only changes/i);
			if (/STALE|PARENT ADVANCED/i.test(panelText)) expect(panelText).not.toMatch(/^CURRENT/im);

			await navigateToHash(page, `#/session/${sessionId}`);
			await sendMessage(page, `PI_EXTENSION_TOOL:ast_grep::${JSON.stringify({
				paths: ["src/app.ts"], pattern: "console.log($$$ARGS)", language: "typescript", strictness: "ast",
			})}`);
			const astCard = page.locator('[data-tool-name="ast_grep"]').last();
			await expect(astCard).toBeVisible({ timeout: 20_000 });
			await expect.poll(() => {
				const messages = gateway.sessionManager?.getSession(sessionId)?.rpcClient?._agent?.conversationMessages ?? [];
				return messages.find((message: any) => message.role === "toolResult" && message.toolName === "ast_grep");
			}, { timeout: 20_000 }).toMatchObject({
				isError: false,
				content: [expect.objectContaining({ text: expect.stringContaining("src/app.ts") })],
			});

			// Verify the cited structural match with the ordinary read tool; it reads
			// the fixture from disk and must expose the source marker in its result.
			await sendMessage(page, `Use the read tool ${join(workspace, "src", "app.ts")}`);
			await expect.poll(() => {
				const messages = gateway.sessionManager?.getSession(sessionId)?.rpcClient?._agent?.conversationMessages ?? [];
				return messages.find((message: any) => message.role === "toolResult" && message.toolName === "Read");
			}, { timeout: 20_000 }).toMatchObject({
				isError: false,
				content: [expect.objectContaining({ text: expect.stringContaining("CODE_INTELLIGENCE_SOURCE_READ") })],
			});

			// Reload preserves declared facts but does not trigger an index build or
			// turn an unavailable LSP into ready.
			await navigateToHash(page, "#/ext/code-intelligence");
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, `#/session/${sessionId}`);
			await navigateToHash(page, "#/ext/code-intelligence");
			const reloadedPanel = page.getByTestId("code-intelligence-status-panel");
			await expect(reloadedPanel).toBeVisible({ timeout: 20_000 });
			await expect(reloadedPanel).toContainText("TypeScript");
			await expect(reloadedPanel).toContainText("Go");
			await expect(reloadedPanel).not.toContainText(/LSP\s+Ready/i);

			await navigateToHash(page, "#/market");
			const reloadedToggle = page.locator(`[data-testid="market-installed-pack"][data-builtin="true"][data-pack-name="${PACK}"]`).first()
				.getByRole("checkbox", { name: "Enable Code Intelligence for this Bobbit server", exact: true });
			await expect(reloadedToggle).toBeChecked({ timeout: 15_000 });
			const deactivation = page.waitForResponse((response) => response.url().includes("/api/marketplace/pack-activation") && response.request().method() === "PUT");
			await reloadedToggle.click();
			await deactivation;
			await expectDisabledGoldenPath();
			await navigateToHash(page, "#/ext/code-intelligence");
			await expect(page.getByTestId("ext-route-unavailable")).toBeVisible({ timeout: 15_000 });
		} finally {
			await cleanup();
		}
	});
});
