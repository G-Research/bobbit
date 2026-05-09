import { execFileSync } from "node:child_process";

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
