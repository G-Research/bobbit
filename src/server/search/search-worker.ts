import { parentPort } from "node:worker_threads";
import * as fs from "node:fs";
import * as path from "node:path";
import { FlexSearchStore, FLEX_VERSION } from "./flex-store.js";
import { Indexer } from "./indexer.js";
import { ProgressBus } from "./progress-bus.js";
import { GoalIndexSource } from "./sources/goal-source.js";
import { SessionIndexSource } from "./sources/session-source.js";
import { MessageIndexSource } from "./sources/message-source.js";
import { StaffIndexSource } from "./sources/staff-source.js";
import { contentHashOf } from "./sources/hash.js";
import { formatSessionSearchTitle } from "./sources/session-title.js";
import { CONTENT_POLICY_VERSION, extractForIndexing } from "./content-policy.js";
import { buildCurrentMeta, needsRebuild } from "./meta.js";
import { isMessageAuthor } from "../../shared/message-author.js";
import { initAuthorSidecarDir } from "../agent/author-sidecar.js";
import type { Indexable, SearchQuery } from "./types.js";

const port = parentPort!;
if (!port) throw new Error("search worker requires a parent port");

let store: FlexSearchStore | null = null;
let indexer: Indexer | null = null;
let projectId = "";
const bus = new ProgressBus();
for (const event of ["index:progress", "index:complete", "index:error"] as const) {
	bus.on(event, (payload) => port.postMessage({ kind: "event", event, payload }));
}

type Request = { id: number; command: string; payload?: any };
const MAX_QUEUED_RPCS = 1_024;
const MAX_QUEUED_RPC_BYTES = 16 * 1024 * 1024;
let queuedCount = 0;
let queuedBytes = 0;
// Mutations, queries, and close are ordered. In particular, a graceful close
// cannot race an earlier fire-and-forget ingest or its mirror flush. The
// parent applies the same limits, but enforce them here too: a future caller
// must not turn this worker's serial queue into an unbounded memory sink.
let requestQueue: Promise<void> = Promise.resolve();
port.on("message", (request: Request) => {
	const bytes = estimateRequestBytes(request);
	if (queuedCount >= MAX_QUEUED_RPCS || bytes > MAX_QUEUED_RPC_BYTES || queuedBytes + bytes > MAX_QUEUED_RPC_BYTES) {
		port.postMessage({ kind: "response", id: request.id, ok: false, error: "SEARCH_UNAVAILABLE: worker queue saturated" });
		return;
	}
	queuedCount++;
	queuedBytes += bytes;
	const operation = requestQueue.then(() => handle(request));
	requestQueue = operation.then(() => undefined, () => undefined);
	void operation.then(
		(value) => port.postMessage({ kind: "response", id: request.id, ok: true, value }),
		(error: unknown) => port.postMessage({ kind: "response", id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
	).finally(() => { queuedCount--; queuedBytes -= bytes; });
});

async function handle({ command, payload }: Request): Promise<unknown> {
	if (command === "open") {
		projectId = payload.projectId;
		// Existing native indexes are cache data. Remove them only in this worker
		// so migration cleanup cannot contend with gateway WS/auth handling.
		const stateDir = path.dirname(payload.dataDir);
		// Worker isolates do not share the gateway module's digest key. Initialize
		// the private ledger with the same stable server-owned key before any source
		// can read v2 digest-only bindings. Migration/security failures stay fatal.
		initAuthorSidecarDir(stateDir);
		await Promise.all(["search.lance", "search.db", "search.db-wal", "search.db-shm"].map((name) => fs.promises.rm(path.join(stateDir, name), { recursive: name === "search.lance", force: true }).catch(() => undefined)));
		store = await FlexSearchStore.open({
			dataDir: payload.dataDir,
			onPersistenceMetric: (metric) => {
				// Keep the main-process diagnostic stream unified without moving
				// serialization or file I/O back onto the gateway event loop.
				port.postMessage({ kind: "metric", ...metric });
			},
		});
		indexer = new Indexer({ store, progressBus: bus, projectId });
		const meta = await store.readMeta();
		const current = buildCurrentMeta({ engine: "flexsearch", engineVersion: FLEX_VERSION, contentPolicyVersion: CONTENT_POLICY_VERSION });
		return { needsRebuild: needsRebuild(meta, current) || (meta !== null && store.count() === 0) };
	}
	if (!store || !indexer) throw new Error("search worker is not open");
	switch (command) {
		case "search": return store.search(payload as SearchQuery);
		case "compact": await store.compact(); return undefined;
		case "close": await store.close(); return undefined;
		case "stats": return stats();
		// Fixture-only raw document path. Keep preparation in FlexSearchStore,
		// which is owned by this worker; callers never receive its instance.
		case "injectDocuments": return store.upsert(Array.isArray(payload?.docs) ? payload.docs : []);
		case "deleteDocuments": return store.deleteByIds(Array.isArray(payload?.ids) ? payload.ids : []);
		case "findOrphanedRows": return findOrphanedRows(payload);
		case "cleanupOrphanedRows": return cleanupOrphanedRows(payload);
		case "indexGoal": return indexGoal(payload.goal, payload.projectId);
		case "removeGoal": return indexer.removeEntries([`goal:${payload.goalId}`]);
		case "indexSession": return indexSession(payload.session, payload.goalTitle, payload.projectId);
		case "removeSession": await indexer.removeEntries([`session:${payload.sessionId}`]); return indexer.removeByFilter({ session_id: payload.sessionId, source_id: "messages" });
		case "removeMessages": return indexer.removeByFilter({ session_id: payload.sessionId, source_id: "messages" });
		case "indexStaff": return indexStaff(payload.staff, payload.projectId);
		case "removeStaff": return indexer.removeEntries([`staff:${payload.staffId}`]);
		case "indexMessage": return indexMessage(payload);
		case "reindexMessages": return reindexMessages(payload);
		case "rebuild": return rebuild(payload);
		default: throw new Error(`unknown search worker command: ${command}`);
	}
}

async function indexGoal(goal: any, pid?: string): Promise<void> {
	const title = String(goal.title ?? "").trim(), spec = String(goal.spec ?? "").trim();
	if (!title && !spec) return;
	const text = title && spec ? `${title}\n\n${spec}` : title || spec, weight = 2.5, role = "spec" as const, timestamp = goal.updatedAt ?? goal.createdAt ?? 0;
	await indexer!.upsertEntries([{ id: `goal:${goal.id}`, sourceId: "goals", text, metadata: { goalId: goal.id, state: goal.state ?? "" }, contentHash: contentHashOf(text, weight, role, timestamp), timestamp, projectId: pid ?? goal.projectId ?? projectId, archived: goal.archived === true, weight, role, display: { title, snippet: spec.slice(0, 300) } }]);
}
async function indexSession(session: any, goalTitle?: string, pid?: string): Promise<void> {
	const title = String(session.title ?? "").trim(); if (!title) return;
	const weight = 3.0, role = "title" as const, timestamp = session.createdAt ?? session.lastActivity ?? 0, displayTitle = formatSessionSearchTitle(title, goalTitle);
	const metadata: Record<string, string | number | boolean> = { sessionId: session.id };
	if (session.goalId) metadata.goalId = session.goalId; if (goalTitle) metadata.goalTitle = goalTitle; if (session.role) metadata.agentRole = session.role;
	await indexer!.upsertEntries([{ id: `session:${session.id}`, sourceId: "sessions", text: title, metadata, contentHash: contentHashOf(`${title}\n${displayTitle}`, weight, role, timestamp), timestamp, projectId: pid ?? session.projectId ?? projectId, archived: session.archived === true, weight, role, display: { title: displayTitle, snippet: displayTitle } }]);
}
async function indexStaff(staff: any, pid?: string): Promise<void> {
	const name = String(staff.name ?? "").trim(), description = String(staff.description ?? "").trim(); if (!name && !description) return;
	const text = name && description ? `${name}\n\n${description}` : name || description, weight = 1.5, role = "profile" as const, timestamp = staff.updatedAt ?? staff.createdAt ?? 0;
	const metadata: Record<string, string | number | boolean> = { staffId: staff.id, state: staff.state ?? "" }; if (staff.roleId) metadata.roleId = staff.roleId;
	await indexer!.upsertEntries([{ id: `staff:${staff.id}`, sourceId: "staff", text, metadata, contentHash: contentHashOf(text, weight, role, timestamp), timestamp, projectId: pid ?? staff.projectId ?? projectId, archived: false, weight, role, display: { title: name, snippet: description.slice(0, 300) } }]);
}
async function indexMessage(arg: any): Promise<void> {
	if (typeof arg.sessionId === "string" && typeof arg.text === "string") {
		const body = arg.text.trim(); if (!body) return; const title = String(arg.sessionTitle ?? "").trim(), ts = arg.timestamp ?? 0, weight = 1, role = "assistant" as const;
		return indexer!.upsertEntries([{ id: `message:${arg.sessionId}:legacy:${ts}`, sourceId: "messages", text: body, metadata: { sessionId: arg.sessionId, blockKey: "legacy:0", ...(title ? { sessionTitle: title } : {}) }, contentHash: contentHashOf(`${body}\n${title}`, weight, role, ts), timestamp: ts, projectId: arg.projectId ?? projectId, archived: false, weight, role, display: { title } }]);
	}
	const hit = extractForIndexing(arg.message); if (hit.entries.length === 0) return;
	const displayTitle = formatSessionSearchTitle(arg.sessionTitle, arg.goalTitle), idx = typeof arg.msgIdx === "number" ? arg.msgIdx : arg.timestamp;
	const authorCandidate = arg.message && typeof arg.message === "object" ? arg.message.author : undefined;
	const author = isMessageAuthor(authorCandidate) ? authorCandidate : undefined;
	await indexer!.upsertEntries(hit.entries.map((entry) => ({ id: `message:${arg.sessionId}:${idx}:${entry.blockKey}`, sourceId: "messages" as const, text: entry.text, metadata: { sessionId: arg.sessionId, msgIdx: idx, blockKey: entry.blockKey, ...(arg.goalId ? { goalId: arg.goalId } : {}), ...(arg.goalTitle ? { goalTitle: arg.goalTitle } : {}), ...(displayTitle ? { sessionTitle: displayTitle } : {}), ...(author ? { authorKind: author.kind, authorId: author.id, authorLabel: author.label } : {}) }, contentHash: contentHashOf(`${entry.text}\n${displayTitle}`, entry.weight, entry.role, arg.timestamp), timestamp: arg.timestamp, projectId: arg.projectId ?? projectId, archived: false, weight: entry.weight, role: entry.role, display: { title: displayTitle } })));
}
async function reindexMessages(payload: any): Promise<void> {
	await indexer!.removeByFilter({ session_id: payload.session.id, source_id: "messages" });
	const ctx = { projectId: payload.projectId ?? payload.session.projectId ?? projectId, goalStore: { getAll: () => payload.session.goalId ? [{ id: payload.session.goalId, title: payload.goalTitle ?? "" }] : [] }, sessionStore: { getAll: () => [payload.session] }, staffStore: { getAll: () => [] } } as any;
	const entries: Indexable[] = []; for await (const e of new MessageIndexSource().iterate(ctx)) entries.push(e);
	await indexer!.upsertEntries(entries);
}
async function rebuild(payload: any): Promise<void> {
	const ctx = { projectId, goalStore: { getAll: () => payload.goals }, sessionStore: { getAll: () => payload.sessions }, staffStore: { getAll: () => payload.staff } } as any;
	await indexer!.rebuildFromSources([new GoalIndexSource(), new SessionIndexSource(), new MessageIndexSource(), new StaffIndexSource()], ctx);
}
type LiveIndexEntities = { goalIds?: string[]; sessionIds?: string[]; staffIds?: string[] };

function findOrphanedRows(live: LiveIndexEntities): Array<{ id: string; source_id: string; parent_id: string | null }> {
	const goals = new Set(live.goalIds ?? []), sessions = new Set(live.sessionIds ?? []), staff = new Set(live.staffIds ?? []);
	const orphans: Array<{ id: string; source_id: string; parent_id: string | null }> = [];
	for (const row of store!.list({ limit: Number.MAX_SAFE_INTEGER })) {
		let orphan = false;
		if (row.source_id === "goals") orphan = !goals.has(row.id.replace(/^goal:/, ""));
		else if (row.source_id === "sessions") orphan = !sessions.has(row.id.replace(/^session:/, ""));
		else if (row.source_id === "messages") orphan = !row.session_id || !sessions.has(row.session_id);
		else if (row.source_id === "staff") orphan = !staff.has(row.id.replace(/^staff:/, ""));
		if (orphan) orphans.push({ id: row.id, source_id: row.source_id, parent_id: row.parent_id });
	}
	return orphans;
}

async function cleanupOrphanedRows(live: LiveIndexEntities): Promise<number> {
	const rows = findOrphanedRows(live);
	if (rows.length > 0) await store!.deleteByIds(rows.map((row) => row.id));
	return rows.length;
}

async function stats() {
	const counts = { goals: store!.count({ source_id: "goals" }), sessions: store!.count({ source_id: "sessions" }), messages: store!.count({ source_id: "messages" }), staff: store!.count({ source_id: "staff" }), files: store!.count({ source_id: "files" }) };
	return { lastRebuildAt: (await store!.readMeta())?.createdAt ?? null, rowCountsBySource: counts, datasetBytes: directorySize(store!.dataDir) };
}
function directorySize(dir: string): number { let total = 0; const pending = [dir]; while (pending.length) { const p = pending.pop()!; try { const st = fs.lstatSync(p); if (st.isDirectory()) pending.push(...fs.readdirSync(p).map((e) => path.join(p, e))); else if (st.isFile()) total += st.size; } catch { /* best effort */ } } return total; }

function estimateRequestBytes(request: Request): number {
	const seen = new Set<object>();
	const measure = (value: unknown, depth: number): number => {
		if (depth > 12 || value == null) return 8;
		if (typeof value === "string") return 8 + value.length * 2;
		if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return 16;
		if (typeof value !== "object") return 16;
		if (value instanceof ArrayBuffer) return value.byteLength;
		if (ArrayBuffer.isView(value)) return value.byteLength;
		if (seen.has(value)) return 8;
		seen.add(value);
		if (Array.isArray(value)) return 16 + value.reduce((total, item) => total + measure(item, depth + 1), 0);
		let total = 24;
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) total += key.length * 2 + measure(item, depth + 1);
		return total;
	};
	return request.command.length * 2 + measure(request.payload, 0);
}
