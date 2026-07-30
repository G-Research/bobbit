/**
 * Legacy E2E global teardown.
 *
 * The wrapper owns and removes its canonical BOBBIT_V2_RUN_ROOT after
 * Playwright exits. This process may only clean Docker resources carrying this
 * coordinator's opaque run label; it must never sweep shared temp roots,
 * checkout directories, or another coordinator's containers and volumes.
 */
import { execFileSync } from "node:child_process";

function currentRunId(): string | undefined {
	const runId = process.env.BOBBIT_E2E_RUN_ID?.trim();
	return runId && /^[A-Za-z0-9._-]+$/.test(runId) ? runId : undefined;
}

export default function globalTeardown() {
	cleanOwnedDockerResources(currentRunId());
}

/** Remove only Docker containers and volumes explicitly stamped by this run. */
function cleanOwnedDockerResources(runId: string | undefined): void {
	if (!runId) return;
	try {
		const ids = execFileSync("docker", [
			"ps", "-aq", "--filter", `label=bobbit-e2e-run=${runId}`,
		], { encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }).trim();
		if (!ids) return;

		for (const id of ids.split(/\s+/).filter(Boolean)) {
			try {
				const projectId = execFileSync("docker", [
					"inspect", "--format", '{{index .Config.Labels "bobbit-project"}}', id,
				], { encoding: "utf-8", timeout: 5_000 }).trim();
				execFileSync("docker", ["rm", "-f", id], { timeout: 15_000, stdio: "ignore" });
				if (projectId) {
					for (const prefix of ["bobbit-workspace-", "bobbit-worktrees-"]) {
						try {
							execFileSync("docker", ["volume", "rm", "-f", `${prefix}${projectId}`], {
								timeout: 10_000,
								stdio: "ignore",
							});
						} catch { /* volume may already be gone */ }
					}
				}
			} catch { /* continue with other owned containers */ }
		}
	} catch { /* Docker unavailable — no cleanup required */ }
}
