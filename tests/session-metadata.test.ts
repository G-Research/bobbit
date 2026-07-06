import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionMetadata } from "../src/server/agent/session-metadata.ts";
import { SessionStore, type PersistedSession } from "../src/server/agent/session-store.ts";

const tmpRoots: string[] = [];

afterEach(() => {
	while (tmpRoots.length > 0) {
		fs.rmSync(tmpRoots.pop()!, { recursive: true, force: true });
	}
});

function makeSession(overrides: Record<string, any> = {}): any {
	return {
		id: "s-meta",
		title: "Metadata",
		cwd: "/tmp/meta",
		status: "idle",
		statusVersion: 0,
		createdAt: 100,
		lastActivity: 200,
		clients: new Set(),
		isCompacting: false,
		rpcClient: {},
		promptQueue: { isEmpty: true },
		...overrides,
	};
}

function makePersisted(overrides: Partial<PersistedSession> = {}): PersistedSession {
	return {
		id: "s-meta",
		title: "Metadata",
		cwd: "/tmp/meta",
		agentSessionFile: "",
		createdAt: 100,
		lastActivity: 200,
		...overrides,
	};
}

function setup(opts: { live?: any; persisted?: PersistedSession } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-metadata-"));
	tmpRoots.push(root);
	const store = new SessionStore(root);
	if (opts.persisted) store.put(opts.persisted);
	const sessions = new Map<string, any>();
	if (opts.live) sessions.set(opts.live.id, opts.live);
	const archivedUpdates: Array<{ id: string; updates: Record<string, unknown> }> = [];
	const broadcasts: unknown[] = [];
	const metadata = new SessionMetadata({
		getSessions: () => sessions,
		getProjectContextManager: () => null,
		getTestStore: () => store,
		getPreferencesStore: () => undefined,
		getSandboxManager: () => null,
		resolveStoreForSession: () => store,
		resolveStoreForId: () => store,
		updateArchivedMeta: (id, updates) => {
			archivedUpdates.push({ id, updates });
			return false;
		},
		broadcast: (_clients, msg) => { broadcasts.push(msg); },
	});
	return { metadata, store, sessions, archivedUpdates, broadcasts };
}

describe("SessionMetadata", () => {
	it("projects live sessions with persisted read/model metadata and marks sessions read", () => {
		const live = makeSession({ assistantType: "goal", clients: new Set([{}]), spawnPinnedModel: "openai/gpt-5" });
		const persisted = makePersisted({
			lastReadAt: 123,
			modelProvider: "openai",
			modelId: "gpt-5",
			runtime: "pi",
		});
		const { metadata, store } = setup({ live, persisted });

		const listed = metadata.listSessions();
		assert.equal(listed.length, 1);
		assert.equal(listed[0].lastReadAt, 123);
		assert.equal(listed[0].clientCount, 1);
		assert.equal(listed[0].goalAssistant, true);
		assert.equal(listed[0].spawnPinnedModel, "openai/gpt-5");
		assert.equal(listed[0].modelProvider, "openai");

		const before = Date.now();
		assert.equal(metadata.markSessionRead("s-meta"), true);
		assert.ok((store.get("s-meta")!.lastReadAt ?? 0) >= before);
	});

	it("updates live metadata, maps repo worktrees, persists, and broadcasts title changes", () => {
		const live = makeSession();
		const persisted = makePersisted();
		const { metadata, store, broadcasts } = setup({ live, persisted });

		assert.equal(metadata.updateSessionMeta("s-meta", {
			role: "coder",
			repoPath: "/repo",
			repoWorktrees: { ".": "/repo-wt/root", "pkg/api": "/repo-wt/api" },
			childTerminal: true,
			terminalAt: 500,
		}), true);

		assert.equal(live.role, "coder");
		assert.deepEqual(live.repoWorktrees, [
			{ repo: ".", repoPath: "/repo", worktreePath: "/repo-wt/root" },
			{ repo: "pkg/api", repoPath: path.join("/repo", "pkg/api"), worktreePath: "/repo-wt/api" },
		]);
		assert.equal(store.get("s-meta")!.role, "coder");
		assert.equal(store.get("s-meta")!.childTerminal, true);

		assert.equal(metadata.setTitle("s-meta", "Renamed", { markGenerated: true }), true);
		assert.equal(live.title, "Renamed");
		assert.equal(live.titleGenerated, true);
		assert.deepEqual(broadcasts.at(-1), { type: "session_title", sessionId: "s-meta", title: "Renamed" });
	});

	it("creates the persistent store entry before draft operations", () => {
		const live = makeSession({ id: "draft-session", title: "Drafty", projectId: "proj-1" });
		const { metadata, store } = setup({ live });

		assert.equal(store.get("draft-session"), undefined);
		assert.equal(metadata.setDraft("draft-session", "prompt", { text: "hello" }), true);
		assert.equal(store.get("draft-session")!.agentSessionFile, "");
		assert.deepEqual(metadata.getDraft("draft-session", "prompt"), { text: "hello" });
		assert.equal(metadata.deleteDraft("draft-session", "prompt"), true);
		assert.equal(metadata.getDraft("draft-session", "prompt"), undefined);
	});

	it("falls back from archived terminal stamping to store-only metadata updates", () => {
		const persisted = makePersisted({ id: "child", archived: true });
		const { metadata, store, archivedUpdates } = setup({ persisted });

		metadata.markChildTerminal("child");

		assert.equal(archivedUpdates.length, 1);
		assert.equal(archivedUpdates[0].id, "child");
		assert.equal(store.get("child")!.childTerminal, true);
		assert.equal(typeof store.get("child")!.terminalAt, "number");
		assert.equal(metadata.getArchivedSession("child")!.id, "child");
		assert.equal(metadata.getPersistedSession("child")!.id, "child");
	});
});
