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
		forwardedArgs: readonly string[];
		env?: Readonly<Record<string, string | undefined>>;
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

	it.each([
		{
			label: "final --tls",
			forwardedArgs: [
				"--host", "ignored.example",
				"--port", "3000",
				"--no-tls",
				"--host", "gateway.example",
				"--port", "4312",
				"--tls",
			],
			env: { PORT: "4999" },
			expected: { protocol: "https:", hostname: "gateway.example", port: 4312, basePath: "" },
		},
		{
			label: "final --no-tls",
			forwardedArgs: ["--host", "gateway.example", "--tls", "--no-tls"],
			env: {},
			expected: { protocol: "http:", hostname: "gateway.example", port: 3001, basePath: "" },
		},
	] as const)("uses the $label override while retaining valued-option precedence", async ({ forwardedArgs, env, expected }) => {
		const { resolveWatchdogProbeTarget } = await watchdogModule();
		assert.deepEqual(resolveWatchdogProbeTarget({ forwardedArgs, env }), expected);
	});

	it.each([
		{ host: "localhost", protocol: "http:" },
		{ host: "gateway.example", protocol: "https:" },
	] as const)("defaults to $protocol for $host without a TLS flag", async ({ host, protocol }) => {
		const { resolveWatchdogProbeTarget } = await watchdogModule();
		assert.equal(resolveWatchdogProbeTarget({ forwardedArgs: ["--host", host] }).protocol, protocol);
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
