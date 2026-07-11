import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore, type PersistedSession } from "../../src/server/agent/session-store.ts";

const roots: string[] = [];

function freshRoot(): string {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "session-store-real-fs-")));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function makeSession(id: string, overrides: Partial<PersistedSession> = {}): PersistedSession {
	const now = Date.now();
	return {
		id,
		title: `Session ${id}`,
		cwd: "/tmp/test",
		agentSessionFile: `/tmp/test/${id}.jsonl`,
		createdAt: now,
		lastActivity: now,
		...overrides,
	};
}

function writeJsonl(file: string, mtimeMs: number): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, '{"hello":"world"}\n', "utf-8");
	fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

describe("SessionStore real filesystem fidelity", () => {
	it("saveNow persists through real fs and leaves no .tmp after atomic rename", () => {
		const root = freshRoot();
		const stateDir = path.join(root, "state");
		const storeFile = path.join(stateDir, "sessions.json");
		const tmpFile = `${storeFile}.tmp`;

		const store = new SessionStore(stateDir);
		store.put(makeSession("s1"));
		store.flush();

		assert.ok(fs.existsSync(storeFile), "sessions.json should exist after save");
		assert.ok(!fs.existsSync(tmpFile), "successful real-fs save must not leave sessions.json.tmp");
		const parsed = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
		assert.equal(parsed.version, 2);
		assert.equal(parsed.epoch, 1);
		assert.deepEqual(parsed.sessions.map((s: PersistedSession) => s.id), ["s1"]);
	});

	it("rotates real backups and restores from .bak.1 after a corrupt primary", () => {
		const root = freshRoot();
		const stateDir = path.join(root, "state");
		const storeFile = path.join(stateDir, "sessions.json");
		const bak1 = `${storeFile}.bak.1`;
		const bak2 = `${storeFile}.bak.2`;

		const store = new SessionStore(stateDir);
		store.put(makeSession("s1"));
		store.put(makeSession("s2"));
		store.put(makeSession("s3"));
		store.flush();

		assert.ok(fs.existsSync(bak1), ".bak.1 should exist after repeated saves");
		assert.ok(fs.existsSync(bak2), ".bak.2 should exist after three saves");
		const bak1Parsed = JSON.parse(fs.readFileSync(bak1, "utf-8"));
		const bak2Parsed = JSON.parse(fs.readFileSync(bak2, "utf-8"));
		assert.equal(bak1Parsed.epoch, 2, ".bak.1 should hold the immediately prior payload");
		assert.deepEqual(bak1Parsed.sessions.map((s: PersistedSession) => s.id).sort(), ["s1", "s2"]);
		assert.equal(bak2Parsed.epoch, 1, ".bak.2 should hold the older rotated payload");
		assert.deepEqual(bak2Parsed.sessions.map((s: PersistedSession) => s.id), ["s1"]);

		fs.writeFileSync(storeFile, "{ this is not valid json", "utf-8");

		const warns: string[] = [];
		const origWarn = console.warn;
		console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
		try {
			const restored = new SessionStore(stateDir);
			assert.deepEqual(restored.getAll().map(s => s.id).sort(), ["s1", "s2"]);
		} finally {
			console.warn = origWarn;
		}
		assert.ok(
			warns.some(w => /Failed to parse/.test(w)) && warns.some(w => /Loaded from backup/.test(w)),
			`expected corrupt-primary and backup-restore warnings, got: ${warns.join("\n")}`,
		);
	});

	it("walks real nested transcript directories and ignores tracked or old jsonl files", () => {
		const root = freshRoot();
		const stateDir = path.join(root, "state");
		const transcriptsDir = path.join(root, "agent-sessions");
		const now = Date.now();
		const trackedFile = path.join(transcriptsDir, "project", "tracked.jsonl");
		const oldOrphan = path.join(transcriptsDir, "project", "old-orphan.jsonl");
		const deepOrphan = path.join(transcriptsDir, "deep", "nested", "dir", "lost.jsonl");
		const branchOrphan = path.join(transcriptsDir, "another", "branch.jsonl");

		writeJsonl(trackedFile, now);
		writeJsonl(oldOrphan, now - 7 * 24 * 60 * 60 * 1000);
		writeJsonl(deepOrphan, now);
		writeJsonl(branchOrphan, now);

		const store = new SessionStore(stateDir);
		store.put(makeSession("tracked", { agentSessionFile: trackedFile, lastActivity: now - 60_000 }));

		const warns: string[] = [];
		const origWarn = console.warn;
		console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
		let result: { count: number; paths: string[] };
		try {
			result = store.scanOrphanedTranscripts(transcriptsDir);
		} finally {
			console.warn = origWarn;
		}

		assert.equal(result!.count, 2);
		assert.deepEqual(result!.paths.map(p => path.relative(transcriptsDir, p)).sort(), [
			path.join("another", "branch.jsonl"),
			path.join("deep", "nested", "dir", "lost.jsonl"),
		].sort());
		assert.ok(warns.every(w => !w.includes("tracked.jsonl") && !w.includes("old-orphan.jsonl")));
	});
});
