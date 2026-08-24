/**
 * E2E tests for port auto-increment on EADDRINUSE.
 *
 * These tests manage their own server lifecycle since they need to control
 * port allocation. They do NOT use the shared webServer gateway.
 */
import { test, expect } from "./gateway-harness.js";
import { pollUntil } from "./test-utils/cleanup.js";
import { createServer as createTcpServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
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

type GatewayReadiness =
	| { kind: "ready" }
	| { kind: "failed"; message: string };

function isConnectionRefusal(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const candidate = error as { code?: unknown; cause?: unknown };
	return candidate.code === "ECONNREFUSED" || isConnectionRefusal(candidate.cause);
}

function childExitDescription(child: ChildProcess): string | null {
	if (child.exitCode === null && child.signalCode === null) return null;
	return String(child.exitCode ?? child.signalCode);
}

/** Wait for the live helper gateway to report its authoritative ready health. */
async function waitForGateway(
	child: ChildProcess,
	output: string[],
	port: number,
	authToken: string,
	timeoutMs = 15_000,
): Promise<void> {
	const result = await pollUntil<GatewayReadiness | null>(async () => {
		const exit = childExitDescription(child);
		if (exit !== null) {
			return { kind: "failed", message: `gateway helper exited before :${port} became healthy (${exit})\n${output.join("")}` };
		}

		let response: Response;
		let bodyText: string;
		try {
			response = await fetch(`http://127.0.0.1:${port}/api/health`, {
				headers: { Authorization: `Bearer ${authToken}` },
				signal: AbortSignal.timeout(timeoutMs),
			});
			bodyText = await response.text();
		} catch (error) {
			const requestExit = childExitDescription(child);
			if (requestExit !== null) {
				return { kind: "failed", message: `gateway helper exited before :${port} became healthy (${requestExit})\n${output.join("")}` };
			}
			if (isConnectionRefusal(error)) return null;
			return { kind: "failed", message: `gateway health request on :${port} failed unexpectedly: ${String(error)}` };
		}

		const responseExit = childExitDescription(child);
		if (responseExit !== null) {
			return { kind: "failed", message: `gateway helper exited while :${port} reported health (${responseExit})\n${output.join("")}` };
		}
		if (response.status === 503) return null;
		if (response.status !== 200) {
			return { kind: "failed", message: `gateway health on :${port} returned unexpected ${response.status}: ${bodyText}` };
		}

		let health: { status?: unknown };
		try {
			health = JSON.parse(bodyText) as { status?: unknown };
		} catch {
			return { kind: "failed", message: `gateway health on :${port} returned invalid JSON: ${bodyText}` };
		}
		if (health.status !== "ok") {
			return { kind: "failed", message: `gateway health on :${port} returned 200 without status ok: ${bodyText}` };
		}
		return { kind: "ready" };
	}, { timeoutMs, intervalMs: 100, label: `gateway healthy on :${port}` });

	if (result.kind === "failed") throw new Error(result.message);
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
	test("retries only coded connection refusals", () => {
		const refusal = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
		expect(isConnectionRefusal(refusal)).toBe(true);
		expect(isConnectionRefusal(Object.assign(new TypeError("fetch failed"), { cause: refusal }))).toBe(true);

		for (const unexpected of [
			new Error("connect ECONNREFUSED 127.0.0.1"),
			new TypeError("fetch failed"),
			Object.assign(new TypeError("fetch failed"), {
				cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
			}),
			Object.assign(new TypeError("fetch failed"), {
				cause: Object.assign(new Error("malformed HTTP response"), { code: "HPE_INVALID_CONSTANT" }),
			}),
		]) {
			expect(isConnectionRefusal(unexpected)).toBe(false);
		}
	});

	test("auto-increments to next port when default port is occupied", async () => {
		const basePort = await findFreePort();
		const bobbitDir = makeBobbitDir("auto-inc");
		const secretsDir = join(bobbitDir, "secrets");
		const authToken = "port-readiness-test-token".padEnd(64, "0");
		mkdirSync(secretsDir, { recursive: true });
		writeFileSync(join(secretsDir, "token"), authToken, "utf8");
		const blocker = await occupyPort(basePort);

		try {
			const { child, output } = startHelper({
				BOBBIT_DIR: bobbitDir,
				BOBBIT_SECRETS_DIR: secretsDir,
				TEST_PORT: String(basePort),
				TEST_MODE: "bind-and-serve",
				TEST_EXPLICIT: "false",
				MOCK_AGENT,
			});

			try {
				// The listener can answer 503 before start() returns and writes the
				// port files. Wait until the live child reports status ok.
				await waitForGateway(child, output, basePort + 1, authToken, 15_000);

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
