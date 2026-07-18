// v2-native — NOT a migrated legacy test. Listed in tests-map.json `v2Native`.
// AIGW provider DNS admission and active-host lifecycle coverage.

import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	GATEWAY, filterValidatedProviderUrls, getAigwProviderDnsGuardHosts, removeAigw,
	replaceAigwProviderDnsGuardHosts, resetAgentDirStateForTests, translateWellKnown,
} from "./helpers/aigw-wellknown-test-helpers.js";

describe("AIGW DNS admission lifecycle", () => {
	afterEach(() => replaceAigwProviderDnsGuardHosts([]));

	it("does not activate rejected or merely translated provider hosts", async () => {
		replaceAigwProviderDnsGuardHosts(["active.example"]);
		translateWellKnown({ provider: { candidate: {
			npm: "@ai-sdk/openai", options: { baseURL: "https://candidate.example/v1" }, models: { model: {} },
		} } }, GATEWAY);
		assert.deepEqual(getAigwProviderDnsGuardHosts(), ["active.example"]);

		const privateLookup = ((_hostname: string, _options: any, callback: any) => callback(null, [
			{ address: "169.254.169.254", family: 4 },
		])) as any;
		const admitted = await filterValidatedProviderUrls({ provider: { candidate: {
			options: { baseURL: "https://candidate.example/v1" }, models: { model: {} },
		} } }, new URL(GATEWAY).origin, Date.now() + 250, privateLookup);
		assert.deepEqual(admitted.provider, {});
		assert.deepEqual(getAigwProviderDnsGuardHosts(), ["active.example"], "rejected discovery must not change active DNS behavior");
	});

	it("replaces and clears the active host set on removal", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-aigw-remove-"));
		const previousAgentDir = process.env.BOBBIT_AGENT_DIR;
		try {
			process.env.BOBBIT_AGENT_DIR = agentDir;
			resetAgentDirStateForTests();
			replaceAigwProviderDnsGuardHosts(["old.example"]);
			replaceAigwProviderDnsGuardHosts(["new.example"]);
			assert.deepEqual(getAigwProviderDnsGuardHosts(), ["new.example"]);
			removeAigw({ remove() {} } as any);
			assert.deepEqual(getAigwProviderDnsGuardHosts(), []);
		} finally {
			if (previousAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
			else process.env.BOBBIT_AGENT_DIR = previousAgentDir;
			resetAgentDirStateForTests();
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("bounds and consolidates provider DNS admission by the shared deadline", async () => {
		let lookups = 0;
		const hangingLookup = ((_hostname: string, _options: any, _callback: any) => { lookups++; }) as any;
		const config = {
			disabled_providers: ["disabled"],
			provider: {
				first: { options: { baseURL: "https://slow.example/one" }, models: {} },
				second: { options: { baseURL: "https://slow.example/two" }, models: {} },
				disabled: { options: { baseURL: "https://disabled-slow.example/v1" }, models: {} },
			},
		};
		const started = Date.now();
		const admitted = await filterValidatedProviderUrls(config, new URL(GATEWAY).origin, Date.now() + 40, hangingLookup);
		assert.deepEqual(admitted.provider, {});
		assert.equal(lookups, 1, "duplicate provider hostnames share one DNS admission");
		assert.ok(Date.now() - started < 500, "DNS admission must stop at the shared deadline");
	});

});
