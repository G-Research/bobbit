/**
 * Stale-snapshot guard regression test.
 *
 * If `sessions.json` on disk has a HIGHER epoch than what we last loaded
 * (e.g. cloud sync / antivirus restored a newer file under a running
 * gateway, or the primary was repaired manually), saveNow() must refuse to
 * write — otherwise we'd clobber newer state with stale in-memory data.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-store-stale-"));
const stateDir = path.join(tmpRoot, "state");
fs.mkdirSync(stateDir, { recursive: true });
process.env.BOBBIT_DIR = tmpRoot;

const STORE_FILE = path.join(stateDir, "sessions.json");

const { SessionStore } = await import("../src/server/agent/session-store.ts");
type PersistedSession = import("../src/server/agent/session-store.ts").PersistedSession;

function makeSession(id: string): PersistedSession {
	return {
		id,
		title: `Session ${id}`,
		cwd: "/tmp/test",
		agentSessionFile: `/tmp/test/${id}.jsonl`,
		createdAt: Date.now(),
		lastActivity: Date.now(),
	};
}

function clearDir() {
	for (const f of fs.readdirSync(stateDir)) {
		try { fs.unlinkSync(path.join(stateDir, f)); } catch { /* ignore */ }
	}
}

describe("SessionStore stale-snapshot guard", () => {
	beforeEach(() => clearDir());
	afterEach(() => clearDir());

	it("refuses to save when on-disk epoch is newer than loaded epoch", () => {
		// Start fresh, no sessions.json on disk.
		const store = new SessionStore(stateDir);
		assert.equal(store.getLoadedEpoch(), 0);

		// External writer puts a v2 file with epoch 50 after we constructed.
		const externalPayload = {
			version: 2,
			epoch: 50,
			sessions: [{
				id: "external-1",
				title: "External",
				cwd: "/external",
				agentSessionFile: "/external/a.jsonl",
				createdAt: Date.now(),
				lastActivity: Date.now(),
			}],
		};
		fs.writeFileSync(STORE_FILE, JSON.stringify(externalPayload, null, 2), "utf-8");

		// Capture console.error
		const errors: string[] = [];
		const origErr = console.error;
		console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

		try {
			// Trigger a save with an in-memory put.
			store.put(makeSession("s-stale"));

			// On-disk file must be unchanged (still epoch 50, external-1).
			const onDisk = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
			assert.equal(onDisk.epoch, 50, "on-disk epoch must remain 50 — write refused");
			assert.equal(onDisk.sessions.length, 1);
			assert.equal(onDisk.sessions[0].id, "external-1");
		} finally {
			console.error = origErr;
		}

		assert.ok(errors.some(e => /REFUSING to save/.test(e)), `expected REFUSING-to-save log line, got: ${errors.join("\n")}`);
		assert.equal(store.isStaleGuardTripped(), true);
		assert.equal(store.getWrittenEpoch(), 0, "no write succeeded");

		// Subsequent put — still no write.
		const errsBefore = errors.length;
		store.put(makeSession("s-stale-2"));
		const onDisk2 = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
		assert.equal(onDisk2.epoch, 50, "second put still must not overwrite");
		assert.equal(errors.length, errsBefore, "guard latched — no further error spam");
	});

	it("does NOT trip the guard when on-disk epoch matches what we wrote earlier", () => {
		// Write a few sessions, flush, then put more — no external rewrite.
		const store = new SessionStore(stateDir);
		store.put(makeSession("s1"));
		store.put(makeSession("s2"));
		store.put(makeSession("s3"));
		store.put(makeSession("s4"));
		store.put(makeSession("s5"));
		store.flush();

		const after5 = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
		assert.equal(after5.epoch, 5);
		assert.equal(store.isStaleGuardTripped(), false);
		assert.equal(store.getWrittenEpoch(), 5);

		// Another put — epoch should advance, guard should not trip.
		store.put(makeSession("s6"));
		const after6 = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
		assert.equal(after6.epoch, 6);
		assert.equal(store.isStaleGuardTripped(), false);
	});
});
