import assert from "node:assert/strict";
import path from "node:path";
import type { PathLike, PathOrFileDescriptor, WriteFileOptions } from "node:fs";
import { beforeEach, describe, it } from "vitest";
import { SessionStore, type PersistedSession } from "../../../src/server/agent/session-store.ts";
import type { ContextClearBoundary } from "../../../src/server/agent/context-clear-boundary.ts";
import { createMemFs, type MemFs } from "../../../tests/support/harnesses/shared/mem-fs.ts";

type SessionStoreMemFs = MemFs & {
	openSync(file: PathLike, flags: string): number;
	fsyncSync(fd: number): void;
	closeSync(fd: number): void;
};

function createSessionStoreMemFs(): SessionStoreMemFs {
	const memfs = createMemFs() as SessionStoreMemFs;
	const baseWriteFileSync = memfs.writeFileSync.bind(memfs) as (
		file: PathLike,
		data: string | NodeJS.ArrayBufferView,
		options?: WriteFileOptions,
	) => void;
	const fdPaths = new Map<number, string>();
	let nextFd = 100;
	memfs.openSync = (file: PathLike): number => {
		const fd = nextFd++;
		const resolved = path.resolve(String(file));
		fdPaths.set(fd, resolved);
		baseWriteFileSync(resolved, "", "utf-8");
		return fd;
	};
	memfs.writeFileSync = ((file: PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: WriteFileOptions) => {
		if (typeof file === "number") {
			const target = fdPaths.get(file);
			if (!target) throw Object.assign(new Error(`EBADF: ${file}`), { code: "EBADF" });
			baseWriteFileSync(target, data, options);
			return;
		}
		baseWriteFileSync(file, data, options);
	}) as typeof memfs.writeFileSync;
	memfs.fsyncSync = () => {};
	memfs.closeSync = (fd: number) => { fdPaths.delete(fd); };
	(memfs.promises as any).open = async (file: PathLike) => ({
		writeFile: (data: string) => memfs.promises.writeFile(file, data, "utf-8"),
		sync: async () => {},
		close: async () => {},
	});
	return memfs;
}

const stateDir = path.resolve("/memfs/context-clear-session-store/state");
const storeFile = path.join(stateDir, "sessions.json");

let memfs: SessionStoreMemFs;

function makeSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
	return {
		id: "clear-store-session",
		title: "Clear store session",
		cwd: "/project",
		agentSessionFile: "/agent/A.jsonl",
		createdAt: 1,
		lastActivity: 2,
		...overrides,
	};
}

function boundary(
	id: string,
	previousAgentSessionFile: string,
	activatedAgentSessionFile: string,
	overrides: Partial<ContextClearBoundary> = {},
): ContextClearBoundary {
	return {
		schemaVersion: 1 as const,
		id,
		clearedAt: "2026-08-22T10:00:00.000Z",
		previousAgentSessionFile,
		activatedAgentSessionFile,
		activatedTranscriptMaterialized: false,
		previousTranscriptMaterialized: true,
		compactionIds: [],
		...overrides,
	};
}

function readPrimary(): { version: number; epoch: number; sessions: PersistedSession[] } {
	return JSON.parse(memfs.readFileSync(storeFile, "utf-8"));
}

describe("SessionStore context-clear publication", () => {
	beforeEach(() => {
		memfs = createSessionStoreMemFs();
		memfs.mkdirSync(stateDir, { recursive: true });
	});

	it("publishes the active transcript pointer and appended boundary in one store generation", async () => {
		const store = new SessionStore(stateDir, memfs);
		store.put(makeSession());
		await store.flushAsync();
		const oldEpoch = readPrimary().epoch;
		const clearA = boundary("clr_1787392800000_a1b2c3", "/agent/A.jsonl", "/agent/B.jsonl");

		store.update("clear-store-session", {
			agentSessionFile: "/agent/B.jsonl",
			contextClearBoundaries: [clearA],
		});
		await store.flushAsync();

		const published = readPrimary();
		assert.equal(published.epoch, oldEpoch + 1);
		assert.equal(published.sessions[0].agentSessionFile, "/agent/B.jsonl");
		assert.deepEqual(published.sessions[0].contextClearBoundaries, [clearA]);
		const restored = new SessionStore(stateDir, memfs).get("clear-store-session")!;
		assert.equal(restored.agentSessionFile, "/agent/B.jsonl");
		assert.deepEqual(
			restored.contextClearBoundaries,
			[clearA],
			"CONTEXT_CLEAR_POINTER_BOUNDARY_SPLIT: reload must observe the pointer and boundary together",
		);
	});

	it("round-trips repeated ordered boundaries without truncating or mixing generation ownership", async () => {
		const clearA = boundary("clr_1787392800000_a1b2c3", "/agent/A.jsonl", "/agent/B.jsonl", {
			compactionIds: ["c_A"],
		});
		const clearB = boundary("clr_1787392860000_d4e5f6", "/agent/B.jsonl", "/agent/C.jsonl", {
			previousTranscriptMaterialized: false,
			compactionIds: ["c_B"],
		});
		const store = new SessionStore(stateDir, memfs);
		store.put(makeSession({
			agentSessionFile: "/agent/C.jsonl",
			contextClearBoundaries: [clearA, clearB],
		}));
		await store.flushAsync();

		const restored = new SessionStore(stateDir, memfs).get("clear-store-session")!;
		assert.deepEqual(
			restored.contextClearBoundaries,
			[clearA, clearB],
			"CONTEXT_CLEAR_REPEATED_BOUNDARIES_MIXED: every clear must retain its immediately preceding generation",
		);
		assert.equal(restored.agentSessionFile, "/agent/C.jsonl");
	});

	it("filters malformed persisted boundary records instead of trusting their transcript paths", async () => {
		const valid = boundary("clr_1787392800000_a1b2c3", "/agent/A.jsonl", "/agent/B.jsonl");
		memfs.writeFileSync(storeFile, JSON.stringify({
			version: 2,
			epoch: 7,
			sessions: [{
				...makeSession({ agentSessionFile: "/agent/B.jsonl" }),
				contextClearBoundaries: [
					valid,
					{ ...valid, id: "wrong-prefix" },
					{ ...valid, id: "clr_1787392860000_d4e5f6", schemaVersion: 2, previousAgentSessionFile: "/untrusted/history" },
				],
			}],
		}), "utf-8");

		const restoredStore = new SessionStore(stateDir, memfs);
		const restored = restoredStore.get("clear-store-session") as any;
		assert.deepEqual(
			restored.contextClearBoundaries,
			[valid],
			"CONTEXT_CLEAR_UNVALIDATED_PATH_RESTORED: malformed/unknown boundary rows must be skipped",
		);
		await restoredStore.flushAsync();
	});

	it("restores exact optional-field absence when an unpublished clear is compensated", async () => {
		const store = new SessionStore(stateDir, memfs);
		store.put(makeSession());
		await store.flushAsync();
		const oldShape = store.captureContextClearPersistenceShape("clear-store-session");
		assert.ok(oldShape);
		assert.equal(oldShape.contextClearBoundaries.present, false);
		assert.equal(oldShape.wasStreaming.present, false);
		assert.equal(oldShape.streamingStartedAt.present, false);

		store.update("clear-store-session", {
			agentSessionFile: "/agent/B.jsonl",
			contextClearBoundaries: [boundary("clr_1787392800000_a1b2c3", "/agent/A.jsonl", "/agent/B.jsonl")],
			wasStreaming: false,
			streamingStartedAt: undefined,
		});
		assert.equal(store.restoreContextClearPersistenceShape("clear-store-session", oldShape), true);
		await store.flushAsync();

		const restored = new SessionStore(stateDir, memfs).get("clear-store-session") as any;
		assert.equal(restored.agentSessionFile, "/agent/A.jsonl");
		assert.equal("contextClearBoundaries" in restored, false);
		assert.equal("wasStreaming" in restored, false);
		assert.equal(
			"streamingStartedAt" in restored,
			false,
			"CONTEXT_CLEAR_OPTIONAL_SHAPE_DRIFT: rollback must preserve absent fields rather than writing undefined",
		);
	});

	it("keeps the old durable pointer/boundary generation when rename fails before publication", async () => {
		const store = new SessionStore(stateDir, memfs);
		store.put(makeSession());
		await store.flushAsync();
		const oldPrimary = memfs.readFileSync(storeFile, "utf-8");
		const originalRename = memfs.promises.rename.bind(memfs.promises);
		(memfs.promises as any).rename = async (from: PathLike, to: PathLike) => {
			if (path.resolve(String(to)) === path.resolve(storeFile)) {
				throw new Error("injected context-clear publication failure before rename");
			}
			return originalRename(from, to);
		};
		try {
			store.update("clear-store-session", {
				agentSessionFile: "/agent/B.jsonl",
				contextClearBoundaries: [boundary("clr_1787392800000_a1b2c3", "/agent/A.jsonl", "/agent/B.jsonl")],
			});
			await assert.rejects(
				store.flushAsync(),
				/injected context-clear publication failure before rename/,
				"CONTEXT_CLEAR_STORE_FAILURE_NOT_REPORTED: a pre-rename failure must reject its durability fence",
			);
		} finally {
			(memfs.promises as any).rename = originalRename;
		}

		assert.equal(memfs.readFileSync(storeFile, "utf-8"), oldPrimary);
		const restored = new SessionStore(stateDir, memfs).get("clear-store-session") as any;
		assert.equal(restored.agentSessionFile, "/agent/A.jsonl");
		assert.equal("contextClearBoundaries" in restored, false);
	});

	it("treats post-rename fingerprint failure as committed and reloadable", async () => {
		const store = new SessionStore(stateDir, memfs);
		store.put(makeSession());
		await store.flushAsync();
		const originalRename = memfs.promises.rename.bind(memfs.promises);
		const originalStat = memfs.promises.stat.bind(memfs.promises);
		let primaryRenamed = false;
		(memfs.promises as any).rename = async (from: PathLike, to: PathLike) => {
			const result = await originalRename(from, to);
			if (path.resolve(String(to)) === path.resolve(storeFile)) primaryRenamed = true;
			return result;
		};
		(memfs.promises as any).stat = async (target: PathLike) => {
			if (primaryRenamed && path.resolve(String(target)) === path.resolve(storeFile)) {
				throw new Error("injected post-rename fingerprint failure");
			}
			return originalStat(target);
		};
		const clearA = boundary("clr_1787392800000_a1b2c3", "/agent/A.jsonl", "/agent/B.jsonl");

		try {
			store.update("clear-store-session", {
				agentSessionFile: "/agent/B.jsonl",
				contextClearBoundaries: [clearA],
			});
			await store.flushAsync();
		} finally {
			(memfs.promises as any).rename = originalRename;
			(memfs.promises as any).stat = originalStat;
		}

		const restored = new SessionStore(stateDir, memfs).get("clear-store-session") as any;
		assert.equal(restored.agentSessionFile, "/agent/B.jsonl");
		assert.deepEqual(
			restored.contextClearBoundaries,
			[clearA],
			"CONTEXT_CLEAR_POST_RENAME_FALSE_FAILURE: canonical renamed bytes must count as published",
		);
	});
});
