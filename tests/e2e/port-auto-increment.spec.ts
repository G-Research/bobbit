/**
 * E2E tests for port auto-increment on EADDRINUSE.
 *
 * These tests manage their own server lifecycle since they need to control
 * port allocation. They do NOT use the shared webServer gateway.
 */
import { test, expect } from "@playwright/test";
import { createServer as createTcpServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const HELPER_SCRIPT = join(__dirname, "port-test-helper.mjs");
const MOCK_AGENT = join(PROJECT_ROOT, "tests/e2e/mock-agent.mjs");

/** Create an isolated BOBBIT_DIR for a test. */
function makeBobbitDir(label: string): string {
	const dir = join(tmpdir(), `bobbit-port-test-${label}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Occupy a port with a TCP server. Returns the server (call .close() to release). */
function occupyPort(port: number): Promise<ReturnType<typeof createTcpServer>> {
	return new Promise((resolve, reject) => {
		const srv = createTcpServer();
		srv.once("error", reject);
		srv.listen(port, "127.0.0.1", () => {
			srv.removeListener("error", reject);
			resolve(srv);
		});
	});
}

/** Find a free port to use as a base for tests. */
function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createTcpServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as any).port;
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

/** Run the helper script and wait for exit. Returns exit code and stdout. */
function runHelper(env: Record<string, string>): Promise<{ code: number; output: string }> {
	return new Promise((resolve) => {
		const child = spawn("node", [HELPER_SCRIPT], {
			cwd: PROJECT_ROOT,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
		child.stderr?.on("data", (d: Buffer) => { output += d.toString(); });
		child.on("exit", (code) => resolve({ code: code ?? 1, output }));
		// Safety timeout
		setTimeout(() => { try { child.kill(); } catch {} }, 20_000);
	});
}

/** Start the helper as a long-running process. */
function startHelper(env: Record<string, string>): { child: ChildProcess; output: string[] } {
	const child = spawn("node", [HELPER_SCRIPT], {
		cwd: PROJECT_ROOT,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const output: string[] = [];
	child.stdout?.on("data", (d: Buffer) => output.push(d.toString()));
	child.stderr?.on("data", (d: Buffer) => output.push(d.toString()));
	return { child, output };
}

/** Wait for the gateway to respond on the given port (any HTTP response means it's up). */
async function waitForGateway(port: number, timeoutMs = 15_000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			await fetch(`http://127.0.0.1:${port}/api/health`);
			// Any response (even 401) means the server is listening
			return true;
		} catch {
			// not ready yet — connection refused
		}
		await new Promise(r => setTimeout(r, 100));
	}
	return false;
}

/** Kill a child process and wait for it to exit. */
function killChild(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.killed) { resolve(); return; }
		child.once("exit", () => resolve());
		child.kill("SIGTERM");
		setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
	});
}

test.describe("Port auto-increment", () => {
	test("auto-increments to next port when default port is occupied", async () => {
		const basePort = await findFreePort();
		const bobbitDir = makeBobbitDir("auto-inc");
		const blocker = await occupyPort(basePort);

		try {
			const { child, output } = startHelper({
				BOBBIT_DIR: bobbitDir,
				TEST_PORT: String(basePort),
				TEST_MODE: "bind-and-serve",
				TEST_EXPLICIT: "false",
				MOCK_AGENT,
			});

			try {
				// Wait for the gateway to bind on next port
				const healthy = await waitForGateway(basePort + 1, 15_000);
				expect(healthy).toBe(true);

				// Verify actual-port file
				const actualPort = parseInt(readFileSync(join(bobbitDir, "state", "actual-port"), "utf-8").trim(), 10);
				expect(actualPort).toBe(basePort + 1);

				// Verify gateway-url file
				const gwUrl = readFileSync(join(bobbitDir, "state", "gateway-url"), "utf-8").trim();
				expect(gwUrl).toBe(`http://127.0.0.1:${basePort + 1}`);

				// Verify console output mentions port being in use
				const allOutput = output.join("");
				expect(allOutput).toContain(`Port ${basePort} in use`);
			} finally {
				await killChild(child);
			}
		} finally {
			blocker.close();
		}
	});

	test("fails immediately with explicit portExplicit=true when port is occupied", async () => {
		const basePort = await findFreePort();
		const bobbitDir = makeBobbitDir("explicit");
		const blocker = await occupyPort(basePort);

		try {
			const result = await runHelper({
				BOBBIT_DIR: bobbitDir,
				TEST_PORT: String(basePort),
				TEST_MODE: "bind-and-report",
				TEST_EXPLICIT: "true",
				MOCK_AGENT,
			});

			expect(result.code).toBe(0);
			expect(result.output).toContain("EADDRINUSE");
		} finally {
			blocker.close();
		}
	});

	test("returns correct port when port is free (no increment needed)", async () => {
		const basePort = await findFreePort();
		const bobbitDir = makeBobbitDir("free");

		const result = await runHelper({
			BOBBIT_DIR: bobbitDir,
			TEST_PORT: String(basePort),
			TEST_MODE: "bind-and-report",
			TEST_EXPLICIT: "false",
			MOCK_AGENT,
		});

		expect(result.code).toBe(0);
		expect(result.output).toContain(`OK:${basePort}`);
	});
});
