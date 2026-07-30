import assert from "node:assert/strict";
import { describe, it } from "vitest";

interface WatchdogProbeTarget {
	protocol: "http:" | "https:";
	hostname: string;
	port: number;
	basePath: string;
}

interface WatchdogModule {
	resolveWatchdogProbeTarget(options: {
		forwardedArgs: string[];
		env?: NodeJS.ProcessEnv;
		persistedGatewayUrl?: string;
	}): WatchdogProbeTarget;
	watchdogHealthPath(target: WatchdogProbeTarget): string;
}

async function watchdogModule(): Promise<WatchdogModule> {
	return await import("../../src/server/watchdog.ts") as unknown as WatchdogModule;
}

describe("watchdog mounted probe target", () => {
	it("takes a nested base path from the environment", async () => {
		const { resolveWatchdogProbeTarget, watchdogHealthPath } = await watchdogModule();
		const target = resolveWatchdogProbeTarget({
			forwardedArgs: ["--host", "127.0.0.1", "--port", "4312", "--no-tls"],
			env: { BOBBIT_BASE_PATH: "team/bobbit/" },
		});
		assert.deepEqual(target, {
			protocol: "http:",
			hostname: "127.0.0.1",
			port: 4312,
			basePath: "/team/bobbit",
		});
		assert.equal(watchdogHealthPath(target), "/team/bobbit/api/health");
	});

	it("uses flag presence over an invalid environment value", async () => {
		const { resolveWatchdogProbeTarget } = await watchdogModule();
		const target = resolveWatchdogProbeTarget({
			forwardedArgs: ["--base-path", "/from-flag", "--port", "0"],
			env: { BOBBIT_BASE_PATH: "/../invalid" },
		});
		assert.equal(target.basePath, "/from-flag");
	});

	it.each(["", "/"])("lets explicit %j reset an environment mount to root", async (value) => {
		const { resolveWatchdogProbeTarget, watchdogHealthPath } = await watchdogModule();
		const target = resolveWatchdogProbeTarget({
			forwardedArgs: ["--base-path", value],
			env: { BOBBIT_BASE_PATH: "/from-env" },
		});
		assert.equal(target.basePath, "");
		assert.equal(watchdogHealthPath(target), "/api/health");
	});

	it("rejects missing and selected unsafe base-path configuration", async () => {
		const { resolveWatchdogProbeTarget } = await watchdogModule();
		assert.throws(
			() => resolveWatchdogProbeTarget({ forwardedArgs: ["--base-path"], env: {} }),
			/base.path.*value|value.*base.path/i,
		);
		assert.throws(
			() => resolveWatchdogProbeTarget({ forwardedArgs: ["--base-path", "--port", "3001"], env: {} }),
			/base.path.*value|value.*base.path/i,
		);
		assert.throws(
			() => resolveWatchdogProbeTarget({ forwardedArgs: [], env: { BOBBIT_BASE_PATH: "/a//b" } }),
			/invalid.*base.path|base.path.*invalid/i,
		);
	});

	it("adopts persisted protocol, host, actual port, and path as one record", async () => {
		const { resolveWatchdogProbeTarget, watchdogHealthPath } = await watchdogModule();
		const target = resolveWatchdogProbeTarget({
			forwardedArgs: [],
			env: {},
			persistedGatewayUrl: "https://gateway.example:4443/team/bobbit",
		});
		assert.deepEqual(target, {
			protocol: "https:",
			hostname: "gateway.example",
			port: 4443,
			basePath: "/team/bobbit",
		});
		assert.equal(watchdogHealthPath(target), "/team/bobbit/api/health");
	});

	it("retains the complete selected target when a persisted record is malformed", async () => {
		const { resolveWatchdogProbeTarget } = await watchdogModule();
		const target = resolveWatchdogProbeTarget({
			forwardedArgs: [
				"--host", "127.0.0.1",
				"--port", "4312",
				"--no-tls",
				"--base-path", "/selected/mount",
			],
			env: {},
			persistedGatewayUrl: "https://gateway.example/team/../bobbit",
		});
		assert.deepEqual(target, {
			protocol: "http:",
			hostname: "127.0.0.1",
			port: 4312,
			basePath: "/selected/mount",
		});
	});
});
