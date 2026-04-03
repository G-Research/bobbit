/**
 * Docker container /proc/1/environ E2E test.
 *
 * Verifies that containers created by buildDockerRunArgs() do NOT expose
 * sensitive gateway tokens (BOBBIT_TOKEN, BOBBIT_GATEWAY_URL) in PID 1's
 * environment. This is the primary defense against sandbox escape via
 * /proc/1/environ reading.
 *
 * Requires Docker — auto-skips when Docker is unavailable.
 */
import { test, expect } from "./in-process-harness.js";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const execFileAsync = promisify(execFileCb);

// Check Docker availability at module level — skip all tests if unavailable.
let dockerAvailable = false;
try {
	await execFileAsync("docker", ["info"], { timeout: 10_000 });
	dockerAvailable = true;
} catch {
	/* Docker not available */
}

test.describe("Sandbox Docker — /proc/1/environ", () => {
	test.skip(!dockerAvailable, "Docker not available");

	test("/proc/1/environ does not contain gateway tokens", async () => {
		const { buildDockerRunArgs } = await import("../../dist/server/agent/docker-args.js");

		const args = buildDockerRunArgs({
			image: "node:20-slim",
			workspaceDir: os.tmpdir(),
		});

		// Start container
		const { stdout: rawId } = await execFileAsync("docker", args, {
			timeout: 60_000,
			env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
		});
		const cid = rawId.trim();

		try {
			// Read PID 1 environment — null-separated key=value pairs
			const { stdout: environ } = await execFileAsync(
				"docker",
				["exec", cid, "cat", "/proc/1/environ"],
				{ timeout: 10_000 },
			);

			// Primary assertions: no gateway tokens in PID 1 env
			expect(environ).not.toContain("BOBBIT_TOKEN");
			expect(environ).not.toContain("BOBBIT_GATEWAY_URL");

			// Sanity: expected env vars ARE present (proves we read the right thing)
			expect(environ).toContain("NODE_TLS_REJECT_UNAUTHORIZED=0");
		} finally {
			await execFileAsync("docker", ["rm", "-f", cid], { timeout: 10_000 }).catch(() => {});
		}
	});

	test("git credential helper uses GITHUB_TOKEN from docker exec -e", async () => {
		// Start a bare node:20-slim container (same base as our Dockerfile).
		// After the fix, our Dockerfile adds a credential helper that reads
		// GITHUB_TOKEN. This test asserts the credential helper works — it
		// FAILS on the current code (no credential helper) and PASSES after fix.
		const { stdout: rawId } = await execFileAsync(
			"docker",
			["run", "-d", "node:20-slim", "sleep", "infinity"],
			{
				timeout: 60_000,
				env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
			},
		);
		const cid = rawId.trim();

		try {
			// Install git and configure the credential helper (mirrors what our Dockerfile should do)
			await execFileAsync(
				"docker",
				["exec", cid, "sh", "-c",
					"apt-get update -qq && apt-get install -y -qq git >/dev/null 2>&1"],
				{ timeout: 120_000 },
			);

			// Try git credential fill with GITHUB_TOKEN injected via docker exec -e.
			// Without a credential helper, this fails. With the fix, it succeeds.
			const { stdout } = await execFileAsync(
				"docker",
				[
					"exec",
					"-e", "GITHUB_TOKEN=test-fake-token",
					cid,
					"sh", "-c",
					'printf "protocol=https\\nhost=github.com\\n" | git credential fill',
				],
				{ timeout: 15_000 },
			);

			// Assert the credential helper returned the expected values
			expect(stdout).toContain("username=x-access-token");
			expect(stdout).toContain("password=test-fake-token");
		} finally {
			await execFileAsync("docker", ["rm", "-f", cid], { timeout: 10_000 }).catch(() => {});
		}
	});

	test("buildDockerRunArgs output has no token env vars", async () => {
		const { buildDockerRunArgs } = await import("../../dist/server/agent/docker-args.js");

		const args = buildDockerRunArgs({
			image: "node:20-slim",
			workspaceDir: os.tmpdir(),
		});

		const joined = args.join(" ");
		expect(joined).not.toContain("BOBBIT_TOKEN");
		expect(joined).not.toContain("BOBBIT_GATEWAY_URL");

		// Sanity: other env vars are present
		expect(joined).toContain("NODE_TLS_REJECT_UNAUTHORIZED=0");
	});
});
