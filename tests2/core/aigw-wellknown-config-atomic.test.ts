// v2-native — NOT a migrated legacy test. Listed in tests-map.json `v2Native`.
// AIGW atomic models/configuration failure coverage.

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	configureAigw, resetAgentDirStateForTests, startDiscoveryServer,
} from "./helpers/aigw-wellknown-test-helpers.js";

describe("configureAigw — atomic persistence", () => {
	let tmpAgentDir: string;
	let prevAgentDir: string | undefined;

	beforeEach(() => {
		prevAgentDir = process.env.BOBBIT_AGENT_DIR;
		tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-wk-models-"));
		process.env.BOBBIT_AGENT_DIR = tmpAgentDir;
		resetAgentDirStateForTests();
	});
	afterEach(() => {
		if (prevAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
		else process.env.BOBBIT_AGENT_DIR = prevAgentDir;
		resetAgentDirStateForTests();
		fs.rmSync(tmpAgentDir, { recursive: true, force: true });
	});

	it("does not persist configuration when the atomic models.json write fails", async () => {
		const badAgentDir = path.join(tmpAgentDir, "not-a-directory");
		fs.writeFileSync(badAgentDir, "file");
		process.env.BOBBIT_AGENT_DIR = badAgentDir;
		resetAgentDirStateForTests();
		const prefs = new Map<string, unknown>();
		const server = await startDiscoveryServer((_req, res) => {
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ provider: {} }));
		});
		try {
			await assert.rejects(() => configureAigw(server.origin, {
				get: (key: string) => prefs.get(key),
				set: (key: string, value: unknown) => { prefs.set(key, value); },
				remove: (key: string) => { prefs.delete(key); },
			} as any));
			assert.equal(prefs.has("aigw.url"), false);
		} finally {
			await server.close();
			process.env.BOBBIT_AGENT_DIR = tmpAgentDir;
			resetAgentDirStateForTests();
		}
	});
});
