import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadOrCreateToken, readToken } from "../src/server/auth/token.js";

// Live server secrets (the admin token) now resolve to serverSecretsDir(), which
// is driven by BOBBIT_SECRETS_DIR (outside any project root). This test pins that
// each token operation follows the CURRENT serverSecretsDir(), and never writes
// into the developer's real home dir (BOBBIT_SECRETS_DIR is always a temp dir).
describe("auth token directory resolution", () => {
	let prevSecretsDir: string | undefined;
	let prevBobbitDir: string | undefined;
	let hqDir: string;
	let dirA: string;
	let dirB: string;

	before(() => {
		prevSecretsDir = process.env.BOBBIT_SECRETS_DIR;
		prevBobbitDir = process.env.BOBBIT_DIR;
		// Isolate the Headquarters dir too so the legacy-token fallback in
		// loadOrCreateToken/readToken (which reads bobbitStateDir()/token) cannot
		// pick up a real gateway token from the environment.
		hqDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-token-hq-"));
		process.env.BOBBIT_DIR = hqDir;
		dirA = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-token-a-"));
		dirB = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-token-b-"));
	});

	after(() => {
		if (prevSecretsDir === undefined) delete process.env.BOBBIT_SECRETS_DIR;
		else process.env.BOBBIT_SECRETS_DIR = prevSecretsDir;
		if (prevBobbitDir === undefined) delete process.env.BOBBIT_DIR;
		else process.env.BOBBIT_DIR = prevBobbitDir;
		fs.rmSync(hqDir, { recursive: true, force: true });
		fs.rmSync(dirA, { recursive: true, force: true });
		fs.rmSync(dirB, { recursive: true, force: true });
	});

	it("uses the current serverSecretsDir for each token operation", () => {
		process.env.BOBBIT_SECRETS_DIR = dirA;
		const tokenA = loadOrCreateToken();
		assert.strictEqual(readToken(), tokenA);
		// The token lives under serverSecretsDir(), NOT under any project state dir.
		assert.strictEqual(fs.readFileSync(path.join(dirA, "token"), "utf-8").trim(), tokenA);

		process.env.BOBBIT_SECRETS_DIR = dirB;
		const tokenB = loadOrCreateToken();
		assert.notStrictEqual(tokenB, tokenA);
		assert.strictEqual(readToken(), tokenB);
		assert.strictEqual(fs.readFileSync(path.join(dirB, "token"), "utf-8").trim(), tokenB);
		assert.strictEqual(fs.readFileSync(path.join(dirA, "token"), "utf-8").trim(), tokenA);
	});
});
