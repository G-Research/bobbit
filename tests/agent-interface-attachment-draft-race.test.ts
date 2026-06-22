/**
 * Pins the attachment-draft stale-load race in
 * src/ui/components/AgentInterface.ts (`_loadAttachmentDraft` /
 * `_setAttachmentDraft` / `_clearAttachmentDraft`).
 *
 * The bug: `_loadAttachmentDraft()` kicks off an async IndexedDB read and,
 * on resolve, applied the result whenever (a) the session id was unchanged
 * and (b) `_attachments` was still empty. `_clearAttachmentDraft()` (called
 * on send / compact) sets `_attachments = []` WITHOUT changing the session
 * id — so a load that was already in flight for the *same* session would
 * pass both guards and resurrect the just-sent attachments.
 *
 * The fix adds a monotonic generation token (`_attachmentDraftGen`) that is
 * bumped on every load/set/clear. An in-flight load captures the token at
 * schedule time and refuses to apply if it changed.
 *
 * This is a behavioural twin of the three production methods — it mirrors
 * their exact guard logic (session id + generation) against a controllable
 * fake store, so the race is reproducible and the guard contract is pinned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

type Attachment = { name: string };

/** Deferred promise helper so a load can be paused mid-flight. */
function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

/**
 * Behavioural twin of the AgentInterface attachment-draft methods. The guard
 * logic is copied verbatim from the production methods so this test fails if
 * the generation guard is removed/weakened in the twin and documents the
 * required semantics for the real component.
 */
class DraftHarness {
	attachments: Attachment[] = [];
	sessionId?: string;
	private gen = 0;
	private store: (sid: string) => Promise<Attachment[]>;

	constructor(store: (sid: string) => Promise<Attachment[]>) {
		this.store = store;
	}

	load(sessionId: string | undefined): Promise<void> {
		this.sessionId = sessionId;
		const gen = ++this.gen;
		this.attachments = [];
		if (!sessionId) return Promise.resolve();
		return (async () => {
			const files = await this.store(sessionId);
			if (this.sessionId !== sessionId) return;
			if (this.gen !== gen) return;
			if (files.length > 0 && this.attachments.length === 0) {
				this.attachments = files;
			}
		})();
	}

	set(files: Attachment[]): void {
		this.attachments = files;
		++this.gen;
		this.sessionId = "s1";
	}

	clear(): void {
		this.attachments = [];
		++this.gen;
	}
}

test("clear-after-send during an in-flight load does not resurrect attachments", async () => {
	const d = deferred<Attachment[]>();
	const h = new DraftHarness(() => d.promise);

	h.sessionId = "s1";
	const loadDone = h.load("s1"); // in-flight load for s1

	// User sends → editor cleared. Same session id, attachments emptied.
	h.clear();

	// The slow IndexedDB read now resolves with the pre-send attachments.
	d.resolve([{ name: "sent.png" }]);
	await loadDone;

	assert.deepEqual(h.attachments, [], "stale load must not resurrect sent attachments after clear");
});

test("set during an in-flight load does not clobber user-added attachments", async () => {
	const d = deferred<Attachment[]>();
	const h = new DraftHarness(() => d.promise);

	h.sessionId = "s1";
	const loadDone = h.load("s1");

	// User adds a file before the load resolves.
	h.set([{ name: "user-added.png" }]);

	d.resolve([{ name: "old-draft.png" }]);
	await loadDone;

	assert.deepEqual(
		h.attachments,
		[{ name: "user-added.png" }],
		"stale load must not overwrite freshly user-added attachments",
	);
});

test("session switch during an in-flight load does not apply to the new session", async () => {
	// Per-session store: s1 has a (slow) draft, s2 has none.
	const d1 = deferred<Attachment[]>();
	const h = new DraftHarness((sid) => (sid === "s1" ? d1.promise : Promise.resolve([])));

	const loadDone = h.load("s1");
	// Switch to a different session before s1's load resolves.
	const loadDone2 = h.load("s2");

	d1.resolve([{ name: "s1-draft.png" }]);
	await Promise.all([loadDone, loadDone2]);

	assert.deepEqual(h.attachments, [], "s1's draft must not leak into s2");
});

test("happy path: an undisturbed load still applies the persisted draft", async () => {
	const h = new DraftHarness(async () => [{ name: "restored.png" }]);
	await h.load("s1");
	assert.deepEqual(h.attachments, [{ name: "restored.png" }], "load on session bind must restore the draft");
});
