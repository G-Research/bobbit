// v2-native — NOT a migrated legacy test. Listed in tests-map.json `v2Native`.
// Generated AIGW connection-time DNS rebinding guard coverage.

import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import dnsCallback from "node:dns";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	GATEWAY, replaceAigwProviderDnsGuardHosts, resetAgentDirStateForTests,
	writeAigwDnsGuardExtension, writeAigwModelsJson,
} from "./helpers/aigw-wellknown-test-helpers.js";

describe("generated AIGW DNS guard", () => {
	afterEach(() => replaceAigwProviderDnsGuardHosts([]));

	it("executes the generated guard for public/private lookups and real requests", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-aigw-guard-"));
		const previousAgentDir = process.env.BOBBIT_AGENT_DIR;
		const previousBobbitDir = process.env.BOBBIT_DIR;
		const originalLookup = dnsCallback.lookup;
		let answers: Array<{ address: string; family: number }> = [];
		try {
			process.env.BOBBIT_AGENT_DIR = path.join(root, "agent");
			process.env.BOBBIT_DIR = path.join(root, "headquarters");
			resetAgentDirStateForTests();
			writeAigwModelsJson(GATEWAY, [{
				id: "model", wireId: "model", name: "Model", api: "openai-responses",
				baseUrl: "https://api.vendor.example/v1", upstreamProvider: "vendor",
				reasoning: false, input: ["text"], contextWindow: 1, maxTokens: 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}]);
			const extension = writeAigwDnsGuardExtension();
			assert.ok(extension && fs.existsSync(extension));
			assert.match(extension!, /aigw-dns-guard/);

			// The generated module captures this resolver as its connection-time
			// source, then installs its own dns.lookup wrapper on import.
			dnsCallback.lookup = ((_hostname: string, options: any, callback?: any) => {
				const cb = typeof options === "function" ? options : callback;
				cb(null, answers);
			}) as any;
			const loaded = await import(`${pathToFileURL(extension!).href}?test=${Date.now()}`);
			assert.equal(typeof loaded.default, "function");

			const guardedLookup = (options: any = { all: true }) => new Promise<any[]>((resolve, reject) => {
				dnsCallback.lookup("api.vendor.example", options, (error: Error | null, result: any) => error ? reject(error) : resolve(result));
			});
			answers = [{ address: "93.184.216.34", family: 4 }];
			assert.deepEqual(await guardedLookup(), answers, "generated extension must pass public answers to the socket caller");

			answers = [
				{ address: "93.184.216.34", family: 4 },
				{ address: "169.254.169.254", family: 4 },
			];
			await assert.rejects(guardedLookup(), /non-public address/,
				"a mixed answer set must fail closed rather than selecting its public member");

			// Exercise Node's real HTTP client path, not just a direct helper call:
			// request socket creation must stop at the generated lookup guard.
			answers = [{ address: "127.0.0.1", family: 4 }];
			await assert.rejects(new Promise<void>((resolve, reject) => {
				const request = http.get("http://api.vendor.example/provider-probe", () => resolve());
				request.once("error", reject);
				request.setTimeout(1_000, () => request.destroy(new Error("request unexpectedly reached socket timeout")));
			}), /non-public address/);
		} finally {
			dnsCallback.lookup = originalLookup;
			if (previousAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
			else process.env.BOBBIT_AGENT_DIR = previousAgentDir;
			if (previousBobbitDir === undefined) delete process.env.BOBBIT_DIR;
			else process.env.BOBBIT_DIR = previousBobbitDir;
			resetAgentDirStateForTests();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
