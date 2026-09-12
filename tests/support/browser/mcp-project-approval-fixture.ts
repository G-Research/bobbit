import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCAL_SERVER_NAME = "approval-local-journey";
export const REMOTE_SERVER_NAME = "approval-remote-journey";
export const WORKTREE_SERVER_NAME = "approval-worktree-journey";
export const LOCAL_SECRET = "local-browser-secret-must-not-render";
export const REMOTE_SECRET = "remote-browser-secret-must-not-render";

const MOCK_MCP_SERVER = fileURLToPath(new URL("../../fixtures/mock-mcp-server.mjs", import.meta.url));

export interface McpProjectApprovalFixture {
	root: string;
	primaryRoot: string;
	secondaryRoot: string;
	primaryConfigPath: string;
	secondaryConfigPath: string;
	writePrimary(version: string): void;
	cleanup(): void;
}

export interface McpWorktreeApprovalFixture {
	root: string;
	projectRoot: string;
	worktreeRoot: string;
	writeWorktree(version: string): void;
	cleanup(): void;
}

/** Root/worktree pair whose same-named server differs behaviorally by cwd. */
export function createMcpWorktreeApprovalFixture(): McpWorktreeApprovalFixture {
	const runRoot = process.env.BOBBIT_E2E_TMP_ROOT;
	if (!runRoot) throw new Error("BOBBIT_E2E_TMP_ROOT must identify the browser run root");
	const root = mkdtempSync(join(runRoot, "mcp-worktree-approval-"));
	const projectRoot = join(root, "project");
	// Match Bobbit's real host layout: worktrees are siblings of the registered
	// repository, never descendants that user-input cwd validation would admit.
	const worktreeRoot = join(root, "project-wt", "session", "approval-browser");
	mkdirSync(projectRoot, { recursive: true });
	mkdirSync(worktreeRoot, { recursive: true });
	const config = (variant: string) => JSON.stringify({
		mcpServers: {
			[WORKTREE_SERVER_NAME]: {
				command: process.execPath,
				args: [MOCK_MCP_SERVER, "--variant", variant],
				cwd: ".",
			},
		},
	}, null, 2);
	writeFileSync(join(projectRoot, ".mcp.json"), config("root"), "utf8");
	const writeWorktree = (version: string): void => {
		writeFileSync(join(worktreeRoot, ".mcp.json"), config(`worktree-${version}`), "utf8");
	};
	writeWorktree("v1");
	return {
		root,
		projectRoot,
		worktreeRoot,
		writeWorktree,
		cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
	};
}

/** Filesystem-only fixture for the real browser-v2 gateway journey. */
export function createMcpProjectApprovalFixture(): McpProjectApprovalFixture {
	const runRoot = process.env.BOBBIT_E2E_TMP_ROOT;
	if (!runRoot) throw new Error("BOBBIT_E2E_TMP_ROOT must identify the browser run root");
	const root = mkdtempSync(join(runRoot, "mcp-project-approval-"));
	const primaryRoot = join(root, "primary");
	const secondaryRoot = join(root, "secondary");
	mkdirSync(primaryRoot, { recursive: true });
	mkdirSync(secondaryRoot, { recursive: true });
	const primaryConfigPath = join(primaryRoot, ".mcp.json");
	const secondaryConfigPath = join(secondaryRoot, ".mcp.json");

	const writePrimary = (version: string): void => {
		writeFileSync(primaryConfigPath, JSON.stringify({
			mcpServers: {
				[LOCAL_SERVER_NAME]: {
					command: process.execPath,
					args: [
						MOCK_MCP_SERVER,
						"--token", LOCAL_SECRET,
						"--header", `Authorization: Bearer ${LOCAL_SECRET}`,
						`--header=X-Api-Key: ${LOCAL_SECRET}`,
						"-H", `Cookie: session=${LOCAL_SECRET}`,
						`-H=Cookie: session=${LOCAL_SECRET}`,
						`-HProxy-Authorization: Basic ${LOCAL_SECRET}`,
						"--proxy-header", `X-Proxy-Token: ${LOCAL_SECRET}`,
						`--proxy-header=Proxy-Authorization: Basic ${LOCAL_SECRET}`,
						`Authorization: Bearer ${LOCAL_SECRET}`,
						`Proxy-Authorization: Basic ${LOCAL_SECRET}`,
						`Cookie: session=${LOCAL_SECRET}`,
						`prefix-${LOCAL_SECRET}-suffix`,
						"--variant", version,
					],
					cwd: ".",
					env: { JOURNEY_API_TOKEN: LOCAL_SECRET },
				},
			},
		}, null, 2), "utf8");
	};

	writePrimary("v1");
	writeFileSync(secondaryConfigPath, JSON.stringify({
		mcpServers: {
			[REMOTE_SERVER_NAME]: {
				url: `http://127.0.0.1:9/mcp?access_token=${REMOTE_SECRET}#private`,
				headers: { Authorization: `Bearer ${REMOTE_SECRET}` },
			},
		},
	}, null, 2), "utf8");

	return {
		root,
		primaryRoot,
		secondaryRoot,
		primaryConfigPath,
		secondaryConfigPath,
		writePrimary,
		cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
	};
}
