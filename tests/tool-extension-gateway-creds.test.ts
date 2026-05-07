/**
 * Disk-first credential precedence in `defaults/tools/_shared/gateway.ts`.
 *
 * Contract: `readGatewayCreds()` reads token + gateway-url from the on-disk
 * state directory FIRST, falling back to BOBBIT_TOKEN / BOBBIT_GATEWAY_URL env
 * vars only when the disk read fails. This means a session that survives a
 * gateway restart picks up the new token + URL on the next tool call.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readGatewayCreds } from "../defaults/tools/_shared/gateway.ts";

let tmp: string;
let prev: { dir?: string; token?: string; url?: string; home?: string };

before(() => {
	tmp = mkdtempSync(path.join(tmpdir(), "bobbit-creds-"));
	prev = {
		dir: process.env.BOBBIT_DIR,
		token: process.env.BOBBIT_TOKEN,
		url: process.env.BOBBIT_GATEWAY_URL,
		home: process.env.HOME,
	};
});

after(() => {
	rmSync(tmp, { recursive: true, force: true });
	const restore = (k: keyof typeof prev, env: string) => {
		if (prev[k] === undefined) delete process.env[env];
		else process.env[env] = prev[k] as string;
	};
	restore("dir", "BOBBIT_DIR");
	restore("token", "BOBBIT_TOKEN");
	restore("url", "BOBBIT_GATEWAY_URL");
	restore("home", "HOME");
});

beforeEach(() => {
	delete process.env.BOBBIT_DIR;
	delete process.env.BOBBIT_TOKEN;
	delete process.env.BOBBIT_GATEWAY_URL;
});

describe("readGatewayCreds disk-first precedence", () => {
	it("returns disk values even when BOBBIT_TOKEN/BOBBIT_GATEWAY_URL are set to different values", () => {
		const dir = mkdtempSync(path.join(tmp, "case1-"));
		const stateDir = path.join(dir, "state");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(path.join(stateDir, "token"), "disk-token-1");
		writeFileSync(path.join(stateDir, "gateway-url"), "https://disk.example/");

		process.env.BOBBIT_DIR = dir;
		process.env.BOBBIT_TOKEN = "stale-env-token";
		process.env.BOBBIT_GATEWAY_URL = "https://stale-env.example";

		const creds = readGatewayCreds();
		assert.ok(!("error" in creds), `expected creds, got ${JSON.stringify(creds)}`);
		assert.equal(creds.token, "disk-token-1");
		assert.equal(creds.baseUrl, "https://disk.example"); // trailing slash stripped
	});

	it("falls back to env vars when disk read fails (no BOBBIT_DIR, no ~/.pi)", () => {
		// Point HOME at an empty dir so the legacy ~/.pi disk path also fails.
		const home = mkdtempSync(path.join(tmp, "home-"));
		process.env.HOME = home;
		process.env.BOBBIT_TOKEN = "env-token";
		process.env.BOBBIT_GATEWAY_URL = "https://env.example/";

		const creds = readGatewayCreds();
		assert.ok(!("error" in creds), `expected creds, got ${JSON.stringify(creds)}`);
		assert.equal(creds.token, "env-token");
		assert.equal(creds.baseUrl, "https://env.example");
	});

	it("returns structured error when neither disk nor env have credentials", () => {
		const home = mkdtempSync(path.join(tmp, "home-empty-"));
		process.env.HOME = home;
		// no BOBBIT_DIR, no BOBBIT_TOKEN, no BOBBIT_GATEWAY_URL
		const creds = readGatewayCreds();
		assert.ok("error" in creds, `expected error, got ${JSON.stringify(creds)}`);
	});
});
