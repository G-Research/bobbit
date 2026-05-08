import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	setServerCwd,
	bobbitStateDir,
	globalAgentDir,
	migrateLegacyHomeAgentDir,
} from "../src/server/bobbit-dir.js";

describe("globalAgentDir", () => {
	let tmpDir: string;
	let prevHome: string | undefined;
	let prevUserProfile: string | undefined;
	let prevBobbitDir: string | undefined;
	let prevPiDir: string | undefined;
	let prevAgent: string | undefined;
	let prevPiAgent: string | undefined;

	before(() => {
		prevHome = process.env.HOME;
		prevUserProfile = process.env.USERPROFILE;
		prevBobbitDir = process.env.BOBBIT_DIR;
		prevPiDir = process.env.BOBBIT_PI_DIR;
		prevAgent = process.env.BOBBIT_AGENT_DIR;
		prevPiAgent = process.env.PI_CODING_AGENT_DIR;
		delete process.env.BOBBIT_DIR;
		delete process.env.BOBBIT_PI_DIR;
	});

	after(() => {
		if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
		if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile; else delete process.env.USERPROFILE;
		if (prevBobbitDir !== undefined) process.env.BOBBIT_DIR = prevBobbitDir;
		if (prevPiDir !== undefined) process.env.BOBBIT_PI_DIR = prevPiDir;
		if (prevAgent !== undefined) process.env.BOBBIT_AGENT_DIR = prevAgent; else delete process.env.BOBBIT_AGENT_DIR;
		if (prevPiAgent !== undefined) process.env.PI_CODING_AGENT_DIR = prevPiAgent; else delete process.env.PI_CODING_AGENT_DIR;
	});

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "global-agent-"));
		// Isolate HOME so any homedir lookups land in our sandbox.
		const fakeHome = path.join(tmpDir, "home");
		fs.mkdirSync(fakeHome, { recursive: true });
		process.env.HOME = fakeHome;
		process.env.USERPROFILE = fakeHome;
		delete process.env.BOBBIT_AGENT_DIR;
		delete process.env.PI_CODING_AGENT_DIR;
		setServerCwd(path.join(tmpDir, "cwd"));
		fs.mkdirSync(path.join(tmpDir, "cwd"), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("defaults to <bobbitStateDir()>/agent when no env override", () => {
		const got = globalAgentDir();
		assert.strictEqual(got, path.join(bobbitStateDir(), "agent"));
	});

	it("honors BOBBIT_AGENT_DIR env override", () => {
		process.env.BOBBIT_AGENT_DIR = path.join(tmpDir, "explicit");
		assert.strictEqual(globalAgentDir(), path.join(tmpDir, "explicit"));
		delete process.env.BOBBIT_AGENT_DIR;
	});

	it("honors legacy PI_CODING_AGENT_DIR env override", () => {
		process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, "legacy-pi");
		assert.strictEqual(globalAgentDir(), path.join(tmpDir, "legacy-pi"));
		delete process.env.PI_CODING_AGENT_DIR;
	});

	it("expands ~ and ~/ in BOBBIT_AGENT_DIR", () => {
		process.env.BOBBIT_AGENT_DIR = "~";
		assert.strictEqual(globalAgentDir(), os.homedir());
		process.env.BOBBIT_AGENT_DIR = "~/foo/bar";
		assert.strictEqual(globalAgentDir(), os.homedir() + "/foo/bar");
		delete process.env.BOBBIT_AGENT_DIR;
	});

	it("expands ~ and ~/ in PI_CODING_AGENT_DIR", () => {
		process.env.PI_CODING_AGENT_DIR = "~";
		assert.strictEqual(globalAgentDir(), os.homedir());
		process.env.PI_CODING_AGENT_DIR = "~/legacy";
		assert.strictEqual(globalAgentDir(), os.homedir() + "/legacy");
		delete process.env.PI_CODING_AGENT_DIR;
	});
});

describe("migrateLegacyHomeAgentDir", () => {
	let tmpDir: string;
	let fakeHome: string;
	let prevHome: string | undefined;
	let prevUserProfile: string | undefined;
	let prevBobbitDir: string | undefined;
	let prevPiDir: string | undefined;
	let prevAgent: string | undefined;
	let prevPiAgent: string | undefined;

	before(() => {
		prevHome = process.env.HOME;
		prevUserProfile = process.env.USERPROFILE;
		prevBobbitDir = process.env.BOBBIT_DIR;
		prevPiDir = process.env.BOBBIT_PI_DIR;
		prevAgent = process.env.BOBBIT_AGENT_DIR;
		prevPiAgent = process.env.PI_CODING_AGENT_DIR;
		delete process.env.BOBBIT_DIR;
		delete process.env.BOBBIT_PI_DIR;
	});

	after(() => {
		if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
		if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile; else delete process.env.USERPROFILE;
		if (prevBobbitDir !== undefined) process.env.BOBBIT_DIR = prevBobbitDir;
		if (prevPiDir !== undefined) process.env.BOBBIT_PI_DIR = prevPiDir;
		if (prevAgent !== undefined) process.env.BOBBIT_AGENT_DIR = prevAgent; else delete process.env.BOBBIT_AGENT_DIR;
		if (prevPiAgent !== undefined) process.env.PI_CODING_AGENT_DIR = prevPiAgent; else delete process.env.PI_CODING_AGENT_DIR;
	});

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-agent-"));
		fakeHome = path.join(tmpDir, "home");
		fs.mkdirSync(fakeHome, { recursive: true });
		process.env.HOME = fakeHome;
		process.env.USERPROFILE = fakeHome;
		delete process.env.BOBBIT_AGENT_DIR;
		delete process.env.PI_CODING_AGENT_DIR;
		setServerCwd(path.join(tmpDir, "cwd"));
		fs.mkdirSync(path.join(tmpDir, "cwd"), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("moves ~/.bobbit/agent/ to <serverCwd>/.bobbit/state/agent/ when target absent", () => {
		const legacy = path.join(fakeHome, ".bobbit", "agent");
		const sessions = path.join(legacy, "sessions");
		fs.mkdirSync(sessions, { recursive: true });
		fs.writeFileSync(path.join(sessions, "marker.txt"), "hello");

		migrateLegacyHomeAgentDir();

		const target = globalAgentDir();
		assert.ok(fs.existsSync(target), `target ${target} should exist`);
		assert.ok(fs.existsSync(path.join(target, "sessions", "marker.txt")));
		assert.ok(!fs.existsSync(legacy), "legacy should be gone");
	});

	it("is idempotent — second run is a no-op via marker", () => {
		const legacy = path.join(fakeHome, ".bobbit", "agent");
		fs.mkdirSync(path.join(legacy, "sessions"), { recursive: true });
		fs.writeFileSync(path.join(legacy, "sessions", "a.txt"), "1");

		migrateLegacyHomeAgentDir();
		// Re-create a fresh legacy dir; second run should NOT touch it (no marker after first run if rename succeeded — but the rename consumed the legacy dir, so we just confirm nothing crashes and target is unchanged).
		const target = globalAgentDir();
		const before = fs.readdirSync(path.join(target, "sessions"));

		// Drop the same legacy contents back; with target now populated, this exercises the merge branch + marker.
		fs.mkdirSync(path.join(legacy, "sessions"), { recursive: true });
		fs.writeFileSync(path.join(legacy, "sessions", "b.txt"), "2");
		migrateLegacyHomeAgentDir();
		assert.ok(fs.existsSync(path.join(fakeHome, ".bobbit", "agent.pre-relocate")), "marker should exist");
		assert.ok(!fs.existsSync(legacy), "legacy should be renamed to marker");

		// Run a third time — marker is present so this is a true no-op.
		const beforeThird = fs.readdirSync(path.join(target, "sessions")).sort();
		migrateLegacyHomeAgentDir();
		const afterThird = fs.readdirSync(path.join(target, "sessions")).sort();
		assert.deepStrictEqual(afterThird, beforeThird);
		// And marker still present.
		assert.ok(fs.existsSync(path.join(fakeHome, ".bobbit", "agent.pre-relocate")));
		// Sanity: original contents preserved.
		assert.ok(before.length >= 1);
	});

	it("skips migration when BOBBIT_AGENT_DIR is set", () => {
		process.env.BOBBIT_AGENT_DIR = path.join(tmpDir, "explicit-agent");
		const legacy = path.join(fakeHome, ".bobbit", "agent");
		fs.mkdirSync(path.join(legacy, "sessions"), { recursive: true });
		fs.writeFileSync(path.join(legacy, "sessions", "x.txt"), "v");

		migrateLegacyHomeAgentDir();

		assert.ok(fs.existsSync(legacy), "legacy untouched");
		assert.ok(!fs.existsSync(path.join(fakeHome, ".bobbit", "agent.pre-relocate")));
		delete process.env.BOBBIT_AGENT_DIR;
	});

	it("skips migration when PI_CODING_AGENT_DIR is set", () => {
		process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, "legacy-pi-agent");
		const legacy = path.join(fakeHome, ".bobbit", "agent");
		fs.mkdirSync(path.join(legacy, "sessions"), { recursive: true });

		migrateLegacyHomeAgentDir();

		assert.ok(fs.existsSync(legacy), "legacy untouched");
		assert.ok(!fs.existsSync(path.join(fakeHome, ".bobbit", "agent.pre-relocate")));
		delete process.env.PI_CODING_AGENT_DIR;
	});

	it("is a no-op when marker already exists", () => {
		const marker = path.join(fakeHome, ".bobbit", "agent.pre-relocate");
		fs.mkdirSync(marker, { recursive: true });
		const legacy = path.join(fakeHome, ".bobbit", "agent");
		fs.mkdirSync(path.join(legacy, "sessions"), { recursive: true });
		fs.writeFileSync(path.join(legacy, "sessions", "y.txt"), "v");

		migrateLegacyHomeAgentDir();

		assert.ok(fs.existsSync(legacy), "legacy preserved due to marker");
	});
});
