import { execFileSync } from "node:child_process";

/** Image the Docker sandbox tests bind-mount into and run containers from. */
export const SANDBOX_IMAGE = "bobbit-agent";

type DockerProbe = (args: readonly string[], timeoutMs: number) => boolean;

const probeDocker: DockerProbe = (args, timeoutMs) => {
	try {
		execFileSync("docker", [...args], { stdio: "ignore", timeout: timeoutMs });
		return true;
	} catch {
		return false;
	}
};

/**
 * Detect whether a usable Docker daemon is reachable.
 * Tests that exercise daemon-only behavior use this independently of the
 * repository's local sandbox image.
 */
export function isDockerAvailable(probe: DockerProbe = probeDocker): boolean {
	return probe(["info"], 5000);
}

/**
 * Detect whether the Docker sandbox is actually usable: a reachable daemon AND a
 * locally-present `bobbit-agent` image.
 *
 * A daemon-only check is not sufficient. Every sandbox test runs
 * `docker run … bobbit-agent`, which fails with
 * `failed to resolve reference "docker.io/library/bobbit-agent:latest": not found`
 * on a machine that has Docker but has never built the image (the image is local-only,
 * built with `docker build -t bobbit-agent docker/` — see docker/README.md — and never
 * pulled from a registry). Those tests are meant to self-skip when the sandbox is
 * unusable, so they must gate on the image too rather than hard-failing the E2E lane.
 */
export function isDockerSandboxAvailable(probe: DockerProbe = probeDocker): boolean {
	if (!isDockerAvailable(probe)) return false;
	return probe(["image", "inspect", SANDBOX_IMAGE], 10_000);
}
