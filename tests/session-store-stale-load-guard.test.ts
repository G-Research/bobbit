/**
 * Stale-snapshot guard regression test.
 *
 * If `sessions.json` on disk has a HIGHER epoch than what we last loaded
 * (e.g. cloud sync / antivirus restored a newer file under a running
 * gateway, or a second gateway is running against the same state dir), the
 * store must not blindly clobber the newer on-disk file with stale
 * in-memory data.
 *
 * CON-05 (Fable refactor audit, 2026-07-05): the ORIGINAL fix for this
 * latched permanently — one refused write, then silent, total persistence
 * loss for the rest of the process's lifetime while the UI kept behaving as
 * if writes were landing. The current behavior instead merge-recovers
 * inline: on the very save that detects the trip, it folds the on-disk
 * sessions we don't already know about into memory, keeps this process's
 * own in-memory copy for any id both sides have, and resumes persisting —
 * so it neither clobbers the newer file nor goes dark forever. The event
 * stays visible afterward via `getStaleGuardStatus()` (surfaced through
 * `GET /api/health` and a UI banner) even though the store has self-healed.
 * See docs/design/session-store-crash-safety.md §3.3.
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

function captureConsoleError(): { errors: string[]; restore: () => void } {
	const errors: string[] = [];
	const orig = console.error;
	console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
	return { errors, restore: () => { console.error = orig; } };
}

describe("SessionStore stale-snapshot guard", () => {
	beforeEach(() => clearDir());
	afterEach(() => clearDir());

	it("merge-recovers when on-disk epoch is newer than loaded epoch, instead of clobbering or latching forever", () => {
		// Start fresh, no sessions.json on disk.
		const store = new SessionStore(stateDir);
		assert.equal(store.getLoadedEpoch(), 0);

		// External writer (second gateway / cloud-sync restore) puts a v2 file
		// with epoch 50 after we constructed, holding a session we don't know about.
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

		const { errors, restore } = captureConsoleError();
		try {
			// Trigger a save with an in-memory put — this is the save that detects
			// the stale-snapshot condition.
			store.put(makeSession("s-stale"));

			// The on-disk file must now hold BOTH the external-only session
			// (adopted — nothing the other writer created is lost) and the
			// in-memory session we just added, at an epoch advanced past 50.
			const onDisk = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
			assert.equal(onDisk.epoch, 51, "epoch advances past the adopted on-disk epoch");
			const ids = onDisk.sessions.map((s: PersistedSession) => s.id).sort();
			assert.deepEqual(ids, ["external-1", "s-stale"], "merged: on-disk-only session kept, new in-memory session written");
		} finally {
			restore();
		}

		assert.ok(errors.some(e => /Stale-snapshot RECOVERED/.test(e)), `expected a RECOVERED log line, got: ${errors.join("\n")}`);
		// Recovered, not permanently latched: isStaleGuardTripped() reflects
		// only the genuinely-unrecoverable case (see next test), not "we hit a
		// stale snapshot at some point".
		assert.equal(store.isStaleGuardTripped(), false, "guard is not left tripped after a successful merge-recovery");
		assert.equal(store.getWrittenEpoch(), 51, "the merge-recovery write itself succeeded");

		const status = store.getStaleGuardStatus();
		assert.equal(status.tripped, false);
		assert.equal(status.recoveries, 1, "recovery event stays visible via getStaleGuardStatus() for /api/health");
		assert.ok(status.lastRecoveredAt !== null && status.lastRecoveredAt <= Date.now());

		// Subsequent put — persistence resumed normally, no permanent outage.
		const errsBefore = errors.length;
		store.put(makeSession("s-stale-2"));
		const onDisk2 = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
		assert.equal(onDisk2.epoch, 52, "writes continue to land after recovery");
		const ids2 = onDisk2.sessions.map((s: PersistedSession) => s.id).sort();
		assert.deepEqual(ids2, ["external-1", "s-stale", "s-stale-2"]);
		assert.equal(errors.length, errsBefore, "no repeat trip/recovery logging on subsequent normal saves");
	});

	it("prefers the in-memory row over the on-disk row for a session id both sides hold (in-memory wins per-session)", () => {
		// Seed an initial v2 file this store will load from construction.
		const initialPayload = {
			version: 2,
			epoch: 5,
			sessions: [{ ...makeSession("shared-id"), title: "Original (loaded)" }],
		};
		fs.writeFileSync(STORE_FILE, JSON.stringify(initialPayload, null, 2), "utf-8");

		const store = new SessionStore(stateDir);
		assert.equal(store.getLoadedEpoch(), 5);
		assert.equal(store.get("shared-id")?.title, "Original (loaded)");

		// External writer rewrites the file at a higher epoch BEFORE this
		// process's first save, changing "shared-id" and adding a new id.
		const externalPayload = {
			version: 2,
			epoch: 6,
			sessions: [
				{ ...makeSession("shared-id"), title: "On-disk external (should NOT win)" },
				{ ...makeSession("external-only"), title: "External only" },
			],
		};
		fs.writeFileSync(STORE_FILE, JSON.stringify(externalPayload, null, 2), "utf-8");

		const { errors, restore } = captureConsoleError();
		try {
			store.put(makeSession("other-new-id"));
			const onDisk = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
			const shared = onDisk.sessions.find((s: PersistedSession) => s.id === "shared-id");
			const externalOnly = onDisk.sessions.find((s: PersistedSession) => s.id === "external-only");
			assert.equal(shared.title, "Original (loaded)", "in-memory copy wins for an id both sides hold — the external edit to it is not adopted");
			assert.ok(externalOnly, "on-disk-only session is still adopted (not lost)");
			assert.ok(onDisk.sessions.some((s: PersistedSession) => s.id === "other-new-id"));
		} finally {
			restore();
		}
		assert.ok(errors.some(e => /Stale-snapshot RECOVERED/.test(e)));
	});

	it("falls back to refusing (does not merge) when the on-disk content can't be safely parsed", () => {
		const store = new SessionStore(stateDir);
		assert.equal(store.getLoadedEpoch(), 0);

		// A payload with a valid numeric epoch (so peekDiskEpoch trips the
		// guard) but missing the `version`/`sessions` shape readDiskSnapshotForMerge
		// requires — e.g. a torn read mid-external-write, or hand-corrupted file.
		fs.writeFileSync(STORE_FILE, JSON.stringify({ epoch: 50 }), "utf-8");

		const { errors, restore } = captureConsoleError();
		try {
			store.put(makeSession("s-stale"));
			const onDisk = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
			assert.equal(onDisk.epoch, 50, "on-disk epoch must remain 50 — write refused, no merge attempted");
		} finally {
			restore();
		}

		assert.ok(errors.some(e => /REFUSING to save/.test(e)), `expected REFUSING-to-save log line, got: ${errors.join("\n")}`);
		assert.equal(store.isStaleGuardTripped(), true, "genuinely unmergeable content still latches (protective property preserved)");
		assert.equal(store.getWrittenEpoch(), 0);

		// Subsequent put — still no write, still no additional log spam.
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
