import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { BOBBIT_AIGW_USER_AGENT, aigwUserAgentHeaders } from "../src/server/agent/aigw-user-agent.js";

const EXPECTED_USER_AGENT = `Bobbit/${JSON.parse(readFileSync(path.resolve("package.json"), "utf-8")).version}`;

describe("AI Gateway User-Agent single source of truth", () => {
	it("formats the shared constant from the current package version", () => {
		assert.equal(BOBBIT_AIGW_USER_AGENT, EXPECTED_USER_AGENT);
	});

	it("adds the canonical User-Agent and preserves unrelated extra headers", () => {
		const headers = aigwUserAgentHeaders({
			"Content-Type": "application/json",
			"X-Test": "keep-me",
		});

		assert.equal(headers["User-Agent"], EXPECTED_USER_AGENT);
		assert.equal(headers["Content-Type"], "application/json");
		assert.equal(headers["X-Test"], "keep-me");
	});

	it("prevents User-Agent overrides and duplicate user-agent keys", () => {
		const headers = aigwUserAgentHeaders({
			"User-Agent": "BadClient/1.0",
			"user-agent": "bad-lowercase",
			"USER-AGENT": "bad-uppercase",
			Accept: "application/json",
		});

		const userAgentKeys = Object.keys(headers).filter(key => key.toLowerCase() === "user-agent");
		assert.deepEqual(userAgentKeys, ["User-Agent"]);
		assert.equal(headers["User-Agent"], EXPECTED_USER_AGENT);
		assert.equal(headers.Accept, "application/json");
	});
});
