import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore, type PersistedSession } from "../../src/server/agent/session-store.ts";
import { scanOrphanedTranscriptsAsync } from "../../src/server/agent/orphan-cleanup.ts";
import { readDeletionTombstones } from "../../src/server/agent/deletion-tombstones.ts";

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

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

function fsWithDeferredFirstOpen() {
	const entered = deferred();
	const release = deferred();
	let opens = 0;
	const deferredPromises = new Proxy(fs.promises, {
		get(target, property, receiver) {
			if (property === "open") {
				return async (...args: Parameters<typeof fs.promises.open>) => {
					opens++;
					if (opens === 1) {
						entered.resolve();
						await release.promise;
					}
					return fs.promises.open(...args);
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const fsImpl = new Proxy(fs, {
		get(target, property, receiver) {
			if (property === "promises") return deferredPromises;
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { fsImpl, entered: entered.promise, release: () => release.resolve(), opens: () => opens };
}

/**
 * Hold the final sessions.json fingerprint read. The scheduled callback lands
 * after the drain's final requested-state observation but before reactions on
 * the drain promise, deterministically exercising its settlement boundary.
 */
function fsWithDeferredFinalFingerprint(storeFile: string) {
	const entered = deferred();
	const release = deferred();
	let matchingStats = 0;
	let boundary: Promise<fs.Stats> | undefined;
	const resolvedStoreFile = path.resolve(storeFile);
	const deferredPromises = new Proxy(fs.promises, {
		get(target, property, receiver) {
			if (property === "stat") {
				return (...args: any[]) => {
					const operation = fs.promises.stat(args[0]);
					if (path.resolve(String(args[0])) === resolvedStoreFile && ++matchingStats === 2) {
						boundary = release.promise.then(() => operation);
						entered.resolve();
						return boundary;
					}
					return operation;
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const fsImpl = new Proxy(fs, {
		get(target, property, receiver) {
			if (property === "promises") return deferredPromises;
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return {
		fsImpl,
		entered: entered.promise,
		release: () => release.resolve(),
		scheduleAtDrainSettle(callback: () => void): void {
			assert.ok(boundary, "final fingerprint boundary must be pending");
			void boundary.then(() => {
				queueMicrotask(() => queueMicrotask(callback));
			});
		},
	};
}

describe("SessionStore real filesystem fidelity", () => {
	it("saveNow persists through real fs and leaves no .tmp after atomic rename", async () => {
		const root = freshRoot();
		const stateDir = path.join(root, "state");
		const storeFile = path.join(stateDir, "sessions.json");
		const tmpFile = `${storeFile}.tmp`;

		const store = new SessionStore(stateDir);
		store.put(makeSession("s1"));
		await store.flushAsync();

		assert.ok(fs.existsSync(storeFile), "sessions.json should exist after save");
		assert.ok(!fs.existsSync(tmpFile), "successful real-fs save must not leave sessions.json.tmp");
		const parsed = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
		assert.equal(parsed.version, 3);
		assert.equal(parsed.epoch, 1);
		assert.deepEqual(parsed.sessions.map((s: PersistedSession) => s.id), ["s1"]);
	});

	it("an external real rewrite changes the fingerprint and forces epoch revalidation", async () => {
		const root = freshRoot();
		const stateDir = path.join(root, "state");
		const storeFile = path.join(stateDir, "sessions.json");
		const store = new SessionStore(stateDir);
		store.put(makeSession("s1"));
		await store.flushAsync();
		assert.equal(store.getWrittenEpoch(), 1);

		const externalPayload = {
			version: 3,
			epoch: 41,
			sessions: [makeSession("external", { title: "external rewrite with a distinct real-file size" })],
		};
		fs.writeFileSync(storeFile, JSON.stringify(externalPayload), "utf-8");

		store.put(makeSession("s2"));
		await store.flushAsync();

		const persisted = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
		assert.equal(persisted.epoch, 42, "changed real metadata must disable fingerprint reuse and re-read epoch 41");
		assert.equal(store.getWrittenEpoch(), 42);
	});

	it("rotates real backups and restores from .bak.1 after a corrupt primary", async () => {
		const root = freshRoot();
		const stateDir = path.join(root, "state");
		const storeFile = path.join(stateDir, "sessions.json");
		const bak1 = `${storeFile}.bak.1`;
		const bak2 = `${storeFile}.bak.2`;

		const store = new SessionStore(stateDir);
		// Separate durability barriers deliberately produce recovery snapshots;
		// ordinary bursts are covered by the coalescing tests below.
		store.put(makeSession("s1"));
		await store.flushAsync();
		store.put(makeSession("s2"));
		await store.flushAsync();
		store.put(makeSession("s3"));
		await store.flushAsync();

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

	// purge() is a permanent hard-delete, just like remove(). Without a tombstone
	// a purged session can be resurrected by the boot-time headquarters migration
	// from a stale `.pre-headquarters-id-migration` backup. Assert parity: purge
	// writes the same durable deletion tombstone remove() does.
	it("purge records a durable deletion tombstone (parity with remove)", async () => {
		const root = freshRoot();
		const stateDir = path.join(root, "state");

		const store = new SessionStore(stateDir);
		store.put(makeSession("s-remove"));
		store.put(makeSession("s-purge"));
		await store.flushAsync();

		store.remove("s-remove");
		assert.equal(
			readDeletionTombstones(stateDir, "sessions.json").has("s-remove"),
			true,
			"remove must tombstone the id (baseline)",
		);

		store.archive("s-purge");
		assert.equal(store.purge("s-purge"), true);
		assert.equal(store.get("s-purge"), undefined, "purged session must be gone from the store");
		assert.equal(
			readDeletionTombstones(stateDir, "sessions.json").has("s-purge"),
			true,
			"purge must tombstone the id so the boot migration cannot resurrect it",
		);
	});

	it("purgeAsync yields at deferred I/O and durably orders concurrent sync mutations", async () => {
		const root = freshRoot();
		const stateDir = path.join(root, "state");
		const storeFile = path.join(stateDir, "sessions.json");
		// Establish the recovery baseline before deferring the purge writer.
		// The proxy then proves only the hot-path purge yields at filesystem I/O.
		const seed = new SessionStore(stateDir);
		seed.put(makeSession("victim"));
		await seed.flushAsync();
		seed.archive("victim");
		await seed.flushAsync();
		const deferredFs = fsWithDeferredFirstOpen();
		const store = new SessionStore(stateDir, deferredFs.fsImpl as any);

		let settled = false;
		const purge = store.purgeAsync("victim").then((result) => {
			settled = true;
			return result;
		});
		await deferredFs.entered;
		let eventLoopProgressed = false;
		await Promise.resolve().then(() => { eventLoopProgressed = true; });
		assert.equal(eventLoopProgressed, true);
		assert.equal(settled, false, "purge must remain pending while atomic open is deferred");

		store.put(makeSession("survivor"));
		deferredFs.release();
		assert.equal(await purge, true);

		const persisted = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
		assert.equal(persisted.epoch, 3, "archived-only purge must not advance the live epoch before the folded put");
		assert.deepEqual(persisted.sessions.map((session: PersistedSession) => session.id), ["survivor"]);
		const backup = JSON.parse(fs.readFileSync(`${storeFile}.bak.1`, "utf-8"));
		assert.equal(backup.epoch, 2, ".bak.1 retains the live snapshot before the folded put");
		assert.deepEqual(backup.sessions, []);
		assert.equal(fs.existsSync(`${storeFile}.tmp`), false);
		assert.equal(readDeletionTombstones(stateDir, "sessions.json").has("victim"), true);
		assert.equal(deferredFs.opens(), 2, "a concurrent synchronous mutation schedules a second serialized async save");
	});

	it("does not lose a synchronous mutation at the async drain settlement boundary", async () => {
		const root = freshRoot();
		const stateDir = path.join(root, "state");
		const storeFile = path.join(stateDir, "sessions.json");
		const archivedFile = path.join(stateDir, "sessions.archived.json");
		const seed = new SessionStore(stateDir);
		seed.put(makeSession("victim"));
		await seed.flushAsync();
		seed.archive("victim");
		await seed.flushAsync();
		const deferredFs = fsWithDeferredFinalFingerprint(archivedFile);
		const store = new SessionStore(stateDir, deferredFs.fsImpl as any);

		const purge = store.purgeAsync("victim");
		await deferredFs.entered;
		deferredFs.scheduleAtDrainSettle(() => {
			store.put(makeSession("settlement-survivor"));
		});
		deferredFs.release();
		assert.equal(await purge, true);
		// The mutation is intentionally scheduled after purge's own drain
		// settles, so the caller's explicit shutdown/reload barrier owns it.
		await store.flushAsync();

		const persisted = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
		assert.equal(persisted.epoch, 3, "the settle-boundary live mutation must advance only the live epoch");
		assert.deepEqual(
			persisted.sessions.map((session: PersistedSession) => session.id),
			["settlement-survivor"],
			"a mutation scheduled between drain observation and completion must not be lost",
		);
		assert.equal(readDeletionTombstones(stateDir, "sessions.json").has("victim"), true);
	});

	it("purgeAsync rejects when the stale epoch guard refuses its durable delete", async () => {
		const root = freshRoot();
		const stateDir = path.join(root, "state");
		const storeFile = path.join(stateDir, "sessions.json");
		const seed = new SessionStore(stateDir);
		seed.put(makeSession("victim"));
		await seed.flushAsync();
		const stale = new SessionStore(stateDir);
		const external = {
			version: 3,
			epoch: 9,
			sessions: [makeSession("external", { title: "newer external state with a different fingerprint size" })],
		};
		fs.writeFileSync(storeFile, JSON.stringify(external), "utf-8");

		const errors: unknown[][] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => { errors.push(args); };
		try {
			await assert.rejects(stale.purgeAsync("victim"), /stale-snapshot|newer than loaded epoch/i);
		} finally {
			console.error = originalError;
		}

		assert.equal(stale.isStaleGuardTripped(), true);
		assert.deepEqual(JSON.parse(fs.readFileSync(storeFile, "utf-8")), external);
		assert.ok(errors.some((args) => String(args[0]).includes("REFUSING to save")));
		assert.equal(
			readDeletionTombstones(stateDir, "sessions.json").has("victim"),
			false,
			"a rejected durable purge must not publish a tombstone for a deletion that was not saved",
		);
	});

	it("walks real nested transcript directories and ignores tracked or old jsonl files", async () => {
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
			result = await scanOrphanedTranscriptsAsync(
				transcriptsDir,
				new Set([trackedFile]),
				now - 60_000,
			);
		} finally {
			console.warn = origWarn;
		}

		const expected = [
			path.join("another", "branch.jsonl"),
			path.join("deep", "nested", "dir", "lost.jsonl"),
		].sort();
		assert.equal(result!.count, 2);
		assert.deepEqual(result!.paths.map(p => path.relative(transcriptsDir, p)).sort(), expected);
		assert.ok(warns.every(w => !w.includes("tracked.jsonl") && !w.includes("old-orphan.jsonl")));
	});

	it("migrates a 1,234-row v2 snapshot exactly once and retains the recoverable source", async () => {
		const root = freshRoot();
		const stateDir = path.join(root, "state");
		const storeFile = path.join(stateDir, "sessions.json");
		const archivedFile = path.join(stateDir, "sessions.archived.json");
		const rows = Array.from({ length: 1234 }, (_, i) => makeSession(`migration-${i}`, {
			title: `payload-${i}`,
			archived: i % 3 === 0,
			archivedAt: i % 3 === 0 ? i + 1 : undefined,
		}));
		const source = JSON.stringify({ version: 2, epoch: 41, sessions: rows });
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(storeFile, source, "utf-8");

		const migrated = new SessionStore(stateDir);
		await migrated.flushAsync();
		assert.equal(migrated.getAll().length, 1234);
		assert.equal(fs.readFileSync(`${storeFile}.pre-archived-split`, "utf-8"), source, "the original v2 bytes are forensic recovery evidence");
		const live = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
		const archived = JSON.parse(fs.readFileSync(archivedFile, "utf-8"));
		assert.equal(live.version, 3);
		assert.equal(archived.version, 3);
		assert.equal(live.sessions.length + archived.sessions.length, 1234);
		assert.ok(live.sessions.every((row: PersistedSession) => row.archived !== true));
		assert.ok(archived.sessions.every((row: PersistedSession) => row.archived === true));
		assert.deepEqual(new Set([...live.sessions, ...archived.sessions].map((row: PersistedSession) => row.id)), new Set(rows.map(row => row.id)));

		const liveBytes = fs.readFileSync(storeFile, "utf-8");
		const archiveBytes = fs.readFileSync(archivedFile, "utf-8");
		const reloaded = new SessionStore(stateDir);
		await reloaded.flushAsync();
		assert.equal(reloaded.getAll().length, 1234);
		assert.equal(fs.readFileSync(storeFile, "utf-8"), liveBytes, "a completed migration must be idempotent");
		assert.equal(fs.readFileSync(archivedFile, "utf-8"), archiveBytes, "a completed migration must not rewrite archive rows");
		assert.equal(fs.existsSync(`${storeFile}.pre-archived-split.1`), false);
	});
});
