import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setProjectRoot, bobbitConfigDir, bobbitStateDir } from "../src/server/bobbit-dir.js";
import { isSetupComplete } from "../src/server/setup-status.js";

describe("isSetupComplete", () => {
	let tmpDir: string;
	let prevBobbitDir: string | undefined;
	let prevPiDir: string | undefined;

	before(() => {
		prevBobbitDir = process.env.BOBBIT_DIR;
		prevPiDir = process.env.BOBBIT_PI_DIR;
		delete process.env.BOBBIT_DIR;
		delete process.env.BOBBIT_PI_DIR;
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "is-setup-complete-"));
		setProjectRoot(tmpDir);
	});

	after(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		if (prevBobbitDir !== undefined) process.env.BOBBIT_DIR = prevBobbitDir;
		if (prevPiDir !== undefined) process.env.BOBBIT_PI_DIR = prevPiDir;
	});

	beforeEach(() => {
		// Reset filesystem state between tests
		const stateDir = bobbitStateDir();
		const sentinel = path.join(stateDir, "setup-complete");
		const userPrompt = path.join(bobbitConfigDir(), "system-prompt.md");
		try { fs.rmSync(sentinel); } catch {}
		try { fs.rmSync(userPrompt); } catch {}
	});

	it("returns false when neither sentinel nor user system-prompt.md exists", () => {
		assert.strictEqual(isSetupComplete(), false);
	});

	it("returns true when only the sentinel file exists", () => {
		const stateDir = bobbitStateDir();
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, "setup-complete"), "");
		assert.strictEqual(isSetupComplete(), true);
	});

	it("returns true when only the user system-prompt.md exists", () => {
		const cfg = bobbitConfigDir();
		fs.mkdirSync(cfg, { recursive: true });
		fs.writeFileSync(path.join(cfg, "system-prompt.md"), "anything\n");
		assert.strictEqual(isSetupComplete(), true);
	});

	it("returns true when both exist", () => {
		const stateDir = bobbitStateDir();
		const cfg = bobbitConfigDir();
		fs.mkdirSync(stateDir, { recursive: true });
		fs.mkdirSync(cfg, { recursive: true });
		fs.writeFileSync(path.join(stateDir, "setup-complete"), "");
		fs.writeFileSync(path.join(cfg, "system-prompt.md"), "anything\n");
		assert.strictEqual(isSetupComplete(), true);
	});
});
