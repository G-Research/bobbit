/**
 * Legacy E2E global teardown.
 *
 * The wrapper owns and removes its canonical BOBBIT_V2_RUN_ROOT after
 * Playwright exits. This process may only clean Docker resources carrying this
 * coordinator's opaque run label; it must never sweep shared temp roots,
 * checkout directories, or another coordinator's containers and volumes.
 */
import { execFileSync } from "node:child_process";

export function currentRunId(value = process.env.BOBBIT_E2E_RUN_ID): string | undefined {
	const runId = value?.trim();
	return runId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId) ? runId : undefined;
}

/** Must match projectSandboxVolumeNames() in src/server/agent/docker-args.ts. */
export function ownedE2EVolumeNames(projectId: string, runId: string): string[] {
	return [
		`bobbit-workspace-${projectId}-e2e-${runId}`,
		`bobbit-worktrees-${projectId}-e2e-${runId}`,
	];
}

export default function globalTeardown() {
	cleanOwnedDockerResources(currentRunId());
}

type DockerTeardownExec = (args: string[], options?: object) => string;

const execDockerSync: DockerTeardownExec = (args, options) =>
	execFileSync("docker", args, options as Parameters<typeof execFileSync>[2]) as string;

/** A labelled volume is ours only if its name also uses this run's namespace. */
export function isOwnedE2EVolumeName(name: string, runId: string): boolean {
	const suffix = `-e2e-${runId}`;
	return (name.startsWith("bobbit-workspace-") || name.startsWith("bobbit-worktrees-"))
		&& name.length > suffix.length
		&& name.endsWith(suffix);
}

/** Parse Docker's line-oriented volume listing without trusting arbitrary labels alone. */
export function ownedE2EVolumeNamesFromLabelOutput(output: string, runId: string): string[] {
	return output.split(/\s+/).filter((name) => isOwnedE2EVolumeName(name, runId));
}

/**
 * Remove only Docker resources explicitly stamped by this run. Volumes are
 * discovered first by their own labels, rather than inferred from containers:
 * a test may have already removed its container before global teardown runs.
 */
export function cleanOwnedDockerResources(runId: string | undefined, execDocker: DockerTeardownExec = execDockerSync): void {
	const ownedRunId = currentRunId(runId);
	if (!ownedRunId) return;

	const volumeNames = new Set<string>();
	try {
		const listed = execDocker([
			"volume", "ls", "-q", "--filter", `label=bobbit-e2e-run=${ownedRunId}`,
		], { encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });
		for (const name of ownedE2EVolumeNamesFromLabelOutput(listed.trim(), ownedRunId)) volumeNames.add(name);
	} catch { /* Docker unavailable — no cleanup required */ }

	try {
		const ids = execDocker([
			"ps", "-aq", "--filter", `label=bobbit-e2e-run=${ownedRunId}`,
		], { encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }).trim();
		for (const id of ids.split(/\s+/).filter(Boolean)) {
			try {
				execDocker(["rm", "-f", id], { timeout: 15_000, stdio: "ignore" });
			} catch { /* continue with other owned containers */ }
		}
	} catch { /* Docker unavailable — volume cleanup above remains safe */ }

	for (const volumeName of volumeNames) {
		try {
			execDocker(["volume", "rm", "-f", volumeName], { timeout: 10_000, stdio: "ignore" });
		} catch { /* volume may already be gone */ }
	}
}
