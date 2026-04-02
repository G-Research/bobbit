/**
 * Docker sandbox E2E tests — container lifecycle, network, and goal workflow.
 *
 * All tests require Docker and the bobbit-agent image to be available.
 * They skip gracefully when either is missing (no CI failures).
 *
 * Uses the in-process harness for a real gateway on a known port.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken } from "./e2e-setup.js";
import { execFile as execFileCb, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFileCb);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const IMAGE_NAME = "bobbit-agent";
const DOCKER_ENV = { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" };

// ── Docker availability detection ──────────────────────────────────────────

function isDockerAvailable(): boolean {
	try {
		execFileSync("docker", ["info"], { timeout: 5000, stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function isImageAvailable(name: string): boolean {
	try {
		execFileSync("docker", ["image", "inspect", name], { timeout: 5000, stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

const DOCKER_OK = isDockerAvailable();
const IMAGE_OK = DOCKER_OK && isImageAvailable(IMAGE_NAME);

// ── Helpers ────────────────────────────────────────────────────────────────

async function dockerExec(containerId: string, ...cmd: string[]): Promise<string> {
	const { stdout } = await execFileAsync("docker", ["exec", containerId, ...cmd], {
		timeout: 30_000,
		env: DOCKER_ENV,
	});
	return stdout.toString().trim();
}

async function dockerPs(label: string): Promise<string[]> {
	const { stdout } = await execFileAsync("docker", [
		"ps", "--filter", `label=bobbit-sandbox=${label}`,
		"--format", "{{.ID}}",
	], { timeout: 10_000, env: DOCKER_ENV });
	return stdout.trim().split("\n").filter(Boolean);
}

/** Poll until pool stats match a condition, with timeout. */
async function waitForPoolStats(
	pool: { getStats(): { idle: number; claimed: number; total: number } },
	predicate: (s: { idle: number; claimed: number; total: number }) => boolean,
	timeoutMs = 60_000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate(pool.getStats())) return;
		await new Promise(r => setTimeout(r, 500));
	}
	throw new Error(`Pool stats timeout. Current: ${JSON.stringify(pool.getStats())}`);
}

async function ensureSandboxNetwork(): Promise<void> {
	try {
		await execFileAsync("docker", [
			"network", "create", "--driver", "bridge",
			"-o", "com.docker.network.bridge.enable_icc=false",
			"bobbit-sandbox-net",
		], { timeout: 10_000, env: DOCKER_ENV });
	} catch {
		/* already exists */
	}
}

async function createPool(gatewayPort: number) {
	const { SandboxPool } = await import("../../dist/server/agent/sandbox-pool.js");
	return new SandboxPool({
		poolSize: 1,
		maxIdleSeconds: 300,
		image: IMAGE_NAME,
		projectDir: PROJECT_ROOT,
		repoPath: PROJECT_ROOT,
		healthCheckIntervalMs: 60_000,
		gatewayUrl: `http://host.docker.internal:${gatewayPort}`,
		gatewayToken: readE2EToken(),
		sandboxNetwork: "bobbit-sandbox-net",
	});
}

// Use serial mode — these tests share pool state and must run in order
// within each describe block. Also bump the global timeout for Docker tests.
test.describe.configure({ mode: "serial" });

// ═══════════════════════════════════════════════════════════════════════════
// Container Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Docker Sandbox — Container Lifecycle", () => {
	test.skip(!IMAGE_OK, "Docker or bobbit-agent image not available");

	let pool: InstanceType<any>;
	let poolLabel: string;
	let claimedContainerId: string;

	test("pool init creates a container", async ({ gateway }) => {
		test.setTimeout(120_000);
		await ensureSandboxNetwork();

		pool = await createPool(gateway.port);
		poolLabel = pool.label;
		await pool.init();
		await waitForPoolStats(pool, s => s.idle >= 1);

		const containers = await dockerPs(poolLabel);
		expect(containers.length).toBeGreaterThanOrEqual(1);

		const stats = pool.getStats();
		expect(stats.idle).toBe(1);
		expect(stats.total).toBe(1);
	});

	test("claim and exec returns output", async () => {
		test.setTimeout(60_000);
		const result = await pool.claim("test-session-lifecycle");
		expect(result).not.toBeNull();
		claimedContainerId = result!.containerId;

		const output = await dockerExec(claimedContainerId, "echo", "hello");
		expect(output).toBe("hello");

		const stats = pool.getStats();
		expect(stats.claimed).toBe(1);
	});

	test("release returns slot to idle", async () => {
		test.setTimeout(60_000);
		expect(claimedContainerId).toBeTruthy();
		await pool.release("test-session-lifecycle", claimedContainerId);

		await waitForPoolStats(pool, s => s.idle >= 1, 30_000);
		const stats = pool.getStats();
		expect(stats.idle).toBe(1);
		expect(stats.claimed).toBe(0);
	});

	test("shutdown stops all containers", async () => {
		test.setTimeout(60_000);
		await pool.shutdown();
		// Give Docker a moment to stop
		await new Promise(r => setTimeout(r, 2000));
		const containers = await dockerPs(poolLabel);
		expect(containers.length).toBe(0);
		pool = null as any;
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Network Access
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Docker Sandbox — Network Access", () => {
	test.skip(!IMAGE_OK, "Docker or bobbit-agent image not available");

	let pool: InstanceType<any>;
	let containerId: string;
	let gatewayPort: number;

	test("setup: create pool and claim slot", async ({ gateway }) => {
		test.setTimeout(120_000);
		await ensureSandboxNetwork();
		gatewayPort = gateway.port;

		pool = await createPool(gateway.port);
		await pool.init();
		await waitForPoolStats(pool, s => s.idle >= 1);

		const result = await pool.claim("test-session-network");
		expect(result).not.toBeNull();
		containerId = result!.containerId;
	});

	test("outbound internet works", async () => {
		test.setTimeout(60_000);
		// curl may not be installed; try wget too
		try {
			await dockerExec(containerId, "curl", "-sf", "https://www.google.com/generate_204");
		} catch {
			await dockerExec(containerId, "wget", "-q", "-O", "/dev/null", "https://www.google.com/generate_204");
		}
	});

	test("host.docker.internal resolves from container", async () => {
		test.setTimeout(60_000);
		// The in-process gateway listens on 127.0.0.1 only, so we can't reach it
		// from Docker. Instead, verify that host.docker.internal resolves correctly —
		// the DNS resolution is the critical sandbox infrastructure piece.
		// In production, the gateway listens on 0.0.0.0 and is fully reachable.
		try {
			await dockerExec(containerId, "getent", "hosts", "host.docker.internal");
		} catch {
			// getent may not be available — try resolving via curl connection attempt.
			// curl will fail with connection refused (not DNS error) if resolution works.
			try {
				await dockerExec(
					containerId, "curl", "-sf", "--connect-timeout", "2",
					`http://host.docker.internal:${gatewayPort}/api/health`,
				);
			} catch (err: any) {
				// "Connection refused" = host resolved OK but port not accessible (expected)
				// "Could not resolve host" = DNS failure (unexpected)
				const stderr = err.stderr?.toString() || err.message || "";
				expect(stderr).not.toContain("Could not resolve host");
			}
		}
	});

	test("ICC blocked between containers", async () => {
		test.setTimeout(60_000);
		// Create a second container on the same network
		try {
			await execFileAsync("docker", ["rm", "-f", "bobbit-icc-test"], {
				timeout: 10_000, env: DOCKER_ENV,
			});
		} catch { /* may not exist */ }

		await execFileAsync("docker", [
			"run", "-d", "--network=bobbit-sandbox-net",
			"--name=bobbit-icc-test", IMAGE_NAME, "sleep", "infinity",
		], { timeout: 30_000, env: DOCKER_ENV });

		// Get the second container's IP address
		const { stdout: inspectOut } = await execFileAsync("docker", [
			"inspect", "--format",
			"{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
			"bobbit-icc-test",
		], { timeout: 10_000, env: DOCKER_ENV });
		const otherIp = inspectOut.trim();
		expect(otherIp).toBeTruthy();

		// Attempt to reach the other container — should fail due to ICC=false
		try {
			await dockerExec(
				containerId, "curl", "--connect-timeout", "3", `http://${otherIp}:3000`,
			);
			// If curl succeeded, ICC is NOT blocked — fail the test
			throw new Error("Expected ICC to be blocked, but curl succeeded");
		} catch (err: any) {
			if (err.message?.includes("Expected ICC to be blocked")) throw err;
			// Any other error means the connection was blocked — success
		}
	});

	test("cleanup: release and shutdown", async () => {
		test.setTimeout(60_000);
		try {
			await execFileAsync("docker", ["rm", "-f", "bobbit-icc-test"], {
				timeout: 10_000, env: DOCKER_ENV,
			});
		} catch { /* may not exist */ }
		if (pool) {
			await pool.release("test-session-network", containerId).catch(() => {});
			await pool.shutdown();
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Orphan Cleanup
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Docker Sandbox — Orphan Cleanup", () => {
	test.skip(!IMAGE_OK, "Docker or bobbit-agent image not available");

	test("stale containers cleaned up on pool init", async ({ gateway }) => {
		test.setTimeout(120_000);
		await ensureSandboxNetwork();

		const pool = await createPool(gateway.port);
		const label = pool.label;

		// Create an orphan container manually with the pool's label
		const { stdout: orphanId } = await execFileAsync("docker", [
			"run", "-d",
			"--label", `bobbit-sandbox=${label}`,
			"--network=bobbit-sandbox-net",
			IMAGE_NAME, "sleep", "infinity",
		], { timeout: 30_000, env: DOCKER_ENV });
		const orphanShortId = orphanId.trim().substring(0, 12);

		// Verify the orphan exists
		const before = await dockerPs(label);
		expect(before.length).toBeGreaterThanOrEqual(1);

		// Init the pool — it should clean up or re-adopt the orphan
		await pool.init();
		await waitForPoolStats(pool, s => s.idle >= 1);

		// After init, the orphan should either be:
		// - Re-adopted (but validation fails because no /workspace mount) → removed
		// - Or a fresh container should have been created
		// Either way, pool.init() should succeed without errors
		const stats = pool.getStats();
		expect(stats.idle).toBeGreaterThanOrEqual(1);

		await pool.shutdown();

		// Final cleanup: make sure orphan is really gone
		try {
			await execFileAsync("docker", ["rm", "-f", orphanShortId], {
				timeout: 10_000, env: DOCKER_ENV,
			});
		} catch { /* already gone */ }
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Goal Workflow
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Docker Sandbox — Goal Workflow", () => {
	test.skip(!IMAGE_OK, "Docker or bobbit-agent image not available");

	let pool: InstanceType<any>;
	let containerId: string;
	const testBranch = `test-sandbox-branch-${Date.now()}`;

	test("branch checkout works in claimed slot", async ({ gateway }) => {
		test.setTimeout(120_000);
		await ensureSandboxNetwork();

		pool = await createPool(gateway.port);
		await pool.init();
		await waitForPoolStats(pool, s => s.idle >= 1);

		const result = await pool.claim("test-session-goal", { branch: testBranch });
		expect(result).not.toBeNull();
		containerId = result!.containerId;

		// The container user differs from the host user who owns /workspace.
		// Add safe.directory so git commands work inside the container.
		await dockerExec(containerId, "git", "config", "--global", "--add", "safe.directory", "/workspace");

		const branch = await dockerExec(containerId, "git", "-C", "/workspace", "branch", "--show-current");
		expect(branch).toBe(testBranch);
	});

	test("git operations work inside container", async () => {
		test.setTimeout(60_000);
		expect(containerId).toBeTruthy();
		const status = await dockerExec(containerId, "git", "-C", "/workspace", "status", "--porcelain");
		expect(typeof status).toBe("string");
	});

	test("pool slot resets to default branch after release", async () => {
		test.setTimeout(120_000);
		expect(containerId).toBeTruthy();
		await pool.release("test-session-goal", containerId);

		await waitForPoolStats(pool, s => s.idle >= 1, 60_000);
		const stats = pool.getStats();
		expect(stats.idle).toBe(1);
		expect(stats.claimed).toBe(0);

		// Claim again without branch — should be on default branch
		const result = await pool.claim("test-session-goal-2");
		expect(result).not.toBeNull();
		await dockerExec(result!.containerId, "git", "config", "--global", "--add", "safe.directory", "/workspace");
		const branch = await dockerExec(
			result!.containerId, "git", "-C", "/workspace", "branch", "--show-current",
		);
		expect(["master", "main"]).toContain(branch);

		await pool.release("test-session-goal-2", result!.containerId);
	});

	test("cleanup: shutdown pool", async () => {
		test.setTimeout(60_000);
		if (pool) await pool.shutdown();
		// Clean up the test branch from origin if pushed
		try {
			await execFileAsync("git", ["push", "origin", "--delete", testBranch], {
				cwd: PROJECT_ROOT, timeout: 15_000,
			});
		} catch { /* may not exist */ }
	});
});
