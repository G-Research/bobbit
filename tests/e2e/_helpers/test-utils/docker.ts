import { execFileSync } from "node:child_process";

/** Image the Docker sandbox tests bind-mount into and run containers from. */
export const SANDBOX_IMAGE = "bobbit-agent";

/**
 * Detect whether a usable Docker daemon is reachable.
 * Tests that exercise the Docker sandbox use this to skip themselves on
 * machines where Docker isn't installed or running.
 */
export function isDockerAvailable(): boolean {
	try {
		execFileSync("docker", ["info"], { stdio: "ignore", timeout: 5000 });
		return true;
	} catch {
		return false;
	}
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
export function isDockerSandboxAvailable(): boolean {
	if (!isDockerAvailable()) return false;
	try {
		execFileSync("docker", ["image", "inspect", SANDBOX_IMAGE], { stdio: "ignore", timeout: 10_000 });
		return true;
	} catch {
		return false;
	}
}
