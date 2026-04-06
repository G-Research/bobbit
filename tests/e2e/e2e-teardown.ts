/**
 * Global teardown: remove ephemeral state directories and Docker containers
 * created for this test run.
 * Handles both legacy `.e2e-bobbit-*` dirs and per-worker `.e2e-worker-*` dirs.
 */
import { execFileSync } from "node:child_process";
import { rmSync, readdirSync } from "node:fs";
import { join } from "node:path";

export default function globalTeardown() {
	// Legacy: single shared dir from config env
	const bobbitDir = process.env.BOBBIT_DIR;
	if (bobbitDir && (bobbitDir.includes(".e2e-bobbit-") || bobbitDir.includes(".e2e-fullstack-"))) {
		try { rmSync(bobbitDir, { recursive: true, force: true }); } catch {}
	}

	// Per-worker dirs created by gateway-harness.ts
	const projectRoot = join(import.meta.dirname, "..", "..");
	try {
		for (const entry of readdirSync(projectRoot)) {
			if (entry.startsWith(".e2e-worker-")) {
				try { rmSync(join(projectRoot, entry), { recursive: true, force: true }); } catch {}
			}
		}
	} catch {}

	// Clean up Docker containers created by E2E sandbox tests.
	// These are labeled `bobbit-project=<uuid>` and bound to temp dirs.
	cleanTestDockerContainers();
}

/**
 * Remove Docker containers and volumes whose bind-mounts reference E2E or
 * manual-test temp directories. Skips the live project sandbox.
 */
function cleanTestDockerContainers() {
	try {
		const ids = execFileSync("docker", [
			"ps", "-aq", "--filter", "label=bobbit-project",
		], { encoding: "utf-8", timeout: 10_000 }).trim();
		if (!ids) return;

		for (const id of ids.split(/\s+/).filter(Boolean)) {
			try {
				const binds = execFileSync("docker", [
					"inspect", "--format", "{{json .HostConfig.Binds}}", id,
				], { encoding: "utf-8", timeout: 5_000 }).trim();
				// Only remove containers bound to test temp dirs
				if (/\.e2e-worker-|\.e2e-bobbit-|\.e2e-fullstack-|\.e2e-inproc-|\.e2e-resilience-|\.bobbit-manual/.test(binds)) {
					const projectId = execFileSync("docker", [
						"inspect", "--format", '{{index .Config.Labels "bobbit-project"}}', id,
					], { encoding: "utf-8", timeout: 5_000 }).trim();

					execFileSync("docker", ["rm", "-f", id], { timeout: 15_000, stdio: "ignore" });

					if (projectId) {
						for (const prefix of ["bobbit-workspace-", "bobbit-worktrees-"]) {
							try {
								execFileSync("docker", ["volume", "rm", "-f", `${prefix}${projectId}`], {
									timeout: 10_000, stdio: "ignore",
								});
							} catch {}
						}
					}
				}
			} catch {}
		}
	} catch { /* docker not available — skip silently */ }
}
