import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadOrCreateToken, readToken } from "../src/server/auth/token.js";

describe("auth token directory resolution", () => {
	let prevBobbitDir: string | undefined;
	let dirA: string;
	let dirB: string;

	before(() => {
		prevBobbitDir = process.env.BOBBIT_DIR;
		dirA = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-token-a-"));
		dirB = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-token-b-"));
	});

	after(() => {
		if (prevBobbitDir === undefined) delete process.env.BOBBIT_DIR;
		else process.env.BOBBIT_DIR = prevBobbitDir;
		fs.rmSync(dirA, { recursive: true, force: true });
		fs.rmSync(dirB, { recursive: true, force: true });
	});

	it("uses the current BOBBIT_DIR for each token operation", () => {
		process.env.BOBBIT_DIR = dirA;
		const tokenA = loadOrCreateToken();
		assert.strictEqual(readToken(), tokenA);
		assert.strictEqual(fs.readFileSync(path.join(dirA, "state", "token"), "utf-8").trim(), tokenA);

		process.env.BOBBIT_DIR = dirB;
		const tokenB = loadOrCreateToken();
		assert.notStrictEqual(tokenB, tokenA);
		assert.strictEqual(readToken(), tokenB);
		assert.strictEqual(fs.readFileSync(path.join(dirB, "state", "token"), "utf-8").trim(), tokenB);
		assert.strictEqual(fs.readFileSync(path.join(dirA, "state", "token"), "utf-8").trim(), tokenA);
	});
});
