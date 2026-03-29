/**
 * Worker-scoped gateway fixture for E2E tests.
 *
 * Each Playwright worker spawns its own isolated gateway instance with:
 *   - A unique port (derived from worker index)
 *   - A unique BOBBIT_DIR (ephemeral, cleaned up after)
 *   - The mock agent (no API key needed)
 *
 * The fixture sets process.env.E2E_PORT and process.env.BOBBIT_DIR before
 * any test files in that worker import e2e-setup.ts, so the helpers in
 * e2e-setup automatically target the right server.
 */
import { test as base } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const MOCK_AGENT = resolve(__dirname, "mock-agent.mjs");
const SERVER_CLI = join(PROJECT_ROOT, "dist", "server", "cli.js");

/** Always serve the UI — the overhead is negligible (static files) and
 *  fullstack browser tests need it. API-only tests simply don't use it. */

export interface GatewayInfo {
	port: number;
	baseURL: string;
	wsBase: string;
	bobbitDir: string;
}

/**
 * Spawn a gateway and wait for it to be ready.
 * Returns the child process and connection info.
 */
async function startGateway(workerIndex: number): Promise<{ proc: ChildProcess; info: GatewayInfo }> {
	// Find a free port by binding to port 0 and reading the assigned port
	const port = await new Promise<number>((res, rej) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const p = (srv.address() as any).port;
			srv.close(() => res(p));
		});
		srv.on("error", rej);
	});
	const bobbitDir = join(PROJECT_ROOT, `.e2e-worker-${port}`);

	// Clean slate
	rmSync(bobbitDir, { recursive: true, force: true });
	mkdirSync(bobbitDir, { recursive: true });

	const args = [
		SERVER_CLI,
		"--host", "127.0.0.1",
		"--port", String(port),
		"--no-tls",
		"--auth",
		"--agent-cli", MOCK_AGENT,
	];
	// UI is always served — fullstack tests need it, API tests ignore it.

	const proc = spawn(process.execPath, args, {
		cwd: PROJECT_ROOT,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			BOBBIT_DIR: bobbitDir,
			BOBBIT_LLM_REVIEW_SKIP: "1",
			BOBBIT_SKIP_NPM_CI: "1",
			// Don't skip MCP — the mcp-integration tests need it
			BOBBIT_NO_OPEN: "1",
		},
	});

	// Collect stderr for diagnostics on failure
	let stderr = "";
	proc.stderr?.on("data", (d) => { stderr += d.toString(); });
	proc.stdout?.on("data", () => {}); // drain stdout to prevent backpressure

	const info: GatewayInfo = {
		port,
		baseURL: `http://127.0.0.1:${port}`,
		wsBase: `ws://127.0.0.1:${port}`,
		bobbitDir,
	};

	// Wait for health endpoint to respond
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		// Check process hasn't crashed
		if (proc.exitCode !== null) {
			throw new Error(`Gateway exited early (code ${proc.exitCode}):\n${stderr}`);
		}
		try {
			// Token file must exist before we can auth
			const tokenPath = join(bobbitDir, "state", "token");
			if (existsSync(tokenPath)) {
				const token = readFileSync(tokenPath, "utf-8").trim();
				const resp = await fetch(`${info.baseURL}/api/health`, {
					headers: { Authorization: `Bearer ${token}` },
				});
				if (resp.ok) return { proc, info };
			}
		} catch {
			// Not ready yet
		}
		await new Promise(r => setTimeout(r, 100));
	}
	proc.kill();
	throw new Error(`Gateway on port ${port} did not become healthy in 30s:\n${stderr}`);
}

/**
 * Extended test fixture that provides a per-worker gateway.
 *
 * Usage in test files:
 *   import { test } from "./gateway-harness.js";
 *   // e2e-setup helpers automatically target this worker's gateway
 */
export const test = base.extend<{}, { gateway: GatewayInfo }>({
	gateway: [async ({}, use, workerInfo) => {
		const { proc, info } = await startGateway(workerInfo.workerIndex);

		// Set env so e2e-setup.ts helpers target this worker's server
		process.env.E2E_PORT = String(info.port);
		process.env.BOBBIT_DIR = info.bobbitDir;

		await use(info);

		// Teardown: kill gateway, clean up state dir
		proc.kill();
		// Wait briefly for process to exit
		await new Promise(r => setTimeout(r, 500));
		try {
			rmSync(info.bobbitDir, { recursive: true, force: true });
		} catch {
			// Best-effort
		}
	}, { scope: "worker", auto: true, timeout: 60_000 }],
});

export { expect } from "@playwright/test";
