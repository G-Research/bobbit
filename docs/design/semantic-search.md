# Semantic Search — Design Document

**Status:** Authoritative design for goal `semantic-s-9423e666`.
**Audience:** Implementing coders. This document is complete — you should not need to re-read the goal spec.
**Scope:** v1 = replace SQLite/FTS5 with LanceDB over existing entities (goals, sessions, messages, staff). v2 = file indexing (out of scope, but enabled by the abstractions below).

---

## 1. Architecture overview

### One store, one schema, two retrieval legs

```
                            ┌────────────────────────────────────────┐
  goal/session/staff/msg    │         Indexer (per-project)          │
  mutations ───────────────▶│   queue → batch embed → upsert         │
                            │   (respects contentHash)               │
                            └──────────────┬─────────────────────────┘
                                           │
                               ┌───────────▼───────────┐
                               │  LanceDB dataset      │
                               │  .bobbit/state/       │
                               │    search.lance/      │
                               │  ┌──────────────────┐ │
                               │  │ table: content   │ │
                               │  │  - vector idx    │ │
                               │  │    (IVF_PQ/HNSW) │ │
                               │  │  - FTS idx       │ │
                               │  │    (Tantivy)     │ │
                               │  │  - scalar cols   │ │
                               │  └──────────────────┘ │
                               │  ┌──────────────────┐ │
                               │  │ table:           │ │
                               │  │   search_meta    │ │
                               │  └──────────────────┘ │
                               └───────────┬───────────┘
                                           │
                               ┌───────────▼───────────┐
                               │  HybridQuery          │
                               │  vec ∪ fts → RRF      │
                               │  × weight × filter    │
                               └───────────┬───────────┘
                                           │
                                      /api/search
```

### Key abstractions (v2-ready)

- **`Embedder`** — strategy for text → `Float32Array`. Swappable (nomic today, multilingual tomorrow). Owns model lifecycle & caching.
- **`IndexSource`** — iterates and (optionally) watches a logical content source. `goals`, `sessions`, `messages`, `staff` in v1. `files` drops in for v2 with zero changes to `Indexer`, `LanceStore`, or `HybridQuery`.
- **`Indexable`** — uniform shape handed to the indexer. Role-aware `weight` and `text` encode the *content policy*. All file-specific fields are nullable today; the schema is already file-ready.
- **`Indexer`** — orchestrates: consumes `Indexable`s, dedups by `contentHash`, batches embedding calls, upserts into LanceDB, emits progress events.
- **`LanceStore`** — thin wrapper over `@lancedb/lancedb`. Owns dataset open/create, schema init, index creation (lazy), compaction, meta row.
- **`HybridQuery`** — translates `SearchQuery` into LanceDB's built-in hybrid search, applies post-rank weight multiplier, renders `<b>` snippet.

These are the only modules downstream code should know about. Everything below this line (ONNX runtime, Lance Arrow types, tokenizer internals) is encapsulated.

---

## 2. File / module plan

### New files (all under `src/server/search/`)

| Path | Purpose |
|---|---|
| `embedder.ts` | `Embedder` interface + `NomicEmbedder` impl (ONNX via `@huggingface/transformers`). Lazy model download/load; LRU tokenizer cache; batch API. |
| `lance-store.ts` | `LanceStore` class: open/create dataset, schema, `upsert`, `deleteByIds`, `deleteByFilter`, `count`, `createIndexes`, `compact`. |
| `indexer.ts` | `Indexer`: queue, backlog counter, batch embed, upsert, incremental vs full rebuild driver. Emits progress events. |
| `content-policy.ts` | Role→weight table, `extractForIndexing(message, role)`, `<thinking>` stripping, tool-call arg summariser, tool-result truncator. Replaces most of `message-extractor.ts`. |
| `chunker.ts` | `chunkText(text, { maxTokens: 2000, overlap: 200 }) → { id, text }[]`. Token-count via the embedder's tokenizer (cheap — reuses the nomic tokenizer). |
| `hybrid-query.ts` | `HybridQuery.search(SearchQuery) → SearchResults`. RRF fusion (k=60), weight multiplier, highlighter. |
| `snippet.ts` | `highlight(text, queryTerms) → string` — wraps matches in `<b>`, ~300-char window around best match. Replaces `sanitiseFtsQuery` + FTS5 `snippet()`. |
| `meta.ts` | `MetaRow`: `{ embedderId, dim, schemaVersion, contentPolicyVersion, createdAt }`. `readMeta`, `writeMeta`, `needsRebuild(meta)`. |
| `sources/goal-source.ts` | `GoalIndexSource` over `GoalStore`. |
| `sources/session-source.ts` | `SessionIndexSource` over `SessionStore` (title + role + goal-title denormalised). |
| `sources/message-source.ts` | `MessageIndexSource` streams `.jsonl` lines from `agentSessionFile`, applies `content-policy`. |
| `sources/staff-source.ts` | `StaffIndexSource` over `StaffStore`. |
| `sources/files-source.stub.ts` | **Test-only stub** that proves the v2 path. Not wired into production. |
| `search-service.ts` | Per-project facade (`SearchService`) that bundles `Embedder`, `LanceStore`, `Indexer`, `HybridQuery`, sources. Exposes the public API that `ProjectContext` already consumes from `SearchIndex`. |
| `types.ts` | `Embedder`, `IndexSource`, `Indexable`, `IndexEvent`, `SearchQuery`, `SearchResult`, `SearchResults` type definitions. |
| `progress-bus.ts` | Typed `EventEmitter` for `index:progress` / `index:complete` / `index:error`. Forwarded into the WS broadcast pipeline. |

### Deleted files

| Path | Why |
|---|---|
| `src/server/search/search-index.ts` | Replaced by `search-service.ts` + `lance-store.ts`. |
| `src/server/search/message-extractor.ts` | Replaced by `content-policy.ts` (richer: role-aware, policy-aware). |

### Modified files

| Path | Change |
|---|---|
| `src/server/agent/project-context.ts` | Replace `SearchIndex` with `SearchService`. Same public surface (`.open/.close/.indexGoal/.indexSession/...`) initially; then rename to `indexEntity` in a later pass. |
| `src/server/agent/project-context-manager.ts` | `searchAll` delegates to `SearchService.search` (returns the same `SearchResults` shape). |
| `src/server/agent/session-manager.ts` | Replace `_testSearchIndex: SearchIndex` with `_testSearchService: SearchService`. All call sites at lines 380, 442, 499, 1257, 1639–1655, 3579–3582, 4074 migrate mechanically. |
| `src/server/agent/session-setup.ts` | `SessionContext.searchIndex: SearchIndex` → `searchService: SearchService`. |
| `src/server/agent/staff-manager.ts` | `searchIndex?.indexStaff/removeStaff` → `searchService?.indexStaff/removeStaff`. |
| `src/server/agent/goal-store.ts` / `session-store.ts` | `onIndexUpdate` hook stays; callee path changes. |
| `src/server/agent/state-migration.ts` | Add one-shot: if `search.db` exists at startup, delete it (see §10). |
| `src/server/ws/protocol.ts` | Add `index:progress`, `index:complete`, `index:error` to `ServerMessage`. |
| `src/server/server.ts` | Broadcast index events to project members. New REST: `POST /api/search/rebuild`, `GET /api/search/stats`, `POST /api/search/compact`, `GET /api/maintenance/orphaned-index-rows`, `POST /api/maintenance/cleanup-index-rows`. |
| `src/app/search-page.ts` | Render `<b>` snippets unchanged (same shape). No functional changes beyond consuming new result shape. |
| `src/app/components/search-status-dot.ts` *(new)* | Small lit component subscribing to `index:*` events. Rendered next to the search input. |
| `src/app/settings-page.ts` | New Maintenance sub-panel "Search Index" (stats + Rebuild + Compact + orphan row scan). |
| `src/app/api.ts` | Wrappers for new REST endpoints. |
| `package.json` | Add `@lancedb/lancedb` + `@huggingface/transformers`. Remove `better-sqlite3` *iff* no other consumer (grep confirms — it's only used by `search-index.ts`; double-check before removal). |
| `docs/internals.md` | Rewrite the "search" section to describe LanceDB + content policy. |
| `docs/debugging.md` | Update the "Search index" quick-check (`search.lance/` replaces `search.db`). |

---

## 3. Interfaces

### `src/server/search/types.ts`

```ts
export type Role =
  | "user" | "assistant"
  | "tool_call" | "tool_result"
  | "title" | "spec" | "profile";

export interface Embedder {
  readonly id: string;              // e.g. "nomic-embed-text-v1.5"
  readonly dim: number;             // 768
  /** Batched; implementations should handle >1 call in a single model invocation. */
  embed(texts: string[], kind: "document" | "query"): Promise<Float32Array[]>;
  /** Cheap token count used by the chunker. Must not allocate full embeddings. */
  countTokens(text: string): number;
  /** Ensure model+tokenizer are loaded. Safe to call concurrently. */
  ready(): Promise<void>;
}

export interface Indexable {
  /** Stable key. Examples: "goal:<id>", "session:<id>", "staff:<id>",
   *  "message:<sid>:<msgIdx>:chunk:<n>", "file:<projId>:<path>:chunk:<n>". */
  id: string;
  sourceId: "goals" | "sessions" | "messages" | "staff" | "files";
  text: string;                     // what gets embedded AND FTS-indexed
  metadata: Record<string, string | number | boolean>;
  contentHash: string;              // sha256(text + key metadata)
  timestamp: number;                // ms since epoch
  projectId: string;
  archived?: boolean;
  weight: number;                   // 0.5 – 3.0 post-rank multiplier
  role?: Role;
  display?: {
    title?: string;
    snippet?: string;               // optional precomputed; usually null
    filePath?: string;              // v2
    startLine?: number;             // v2
    endLine?: number;               // v2
  };
}

export type IndexEvent =
  | { type: "upsert"; ids: string[] }
  | { type: "delete"; ids: string[] }
  | { type: "delete-by-filter"; filter: Record<string, unknown> };

export interface IndexSourceContext {
  projectId: string;
  goalStore: import("../agent/goal-store.js").GoalStore;
  sessionStore: import("../agent/session-store.js").SessionStore;
  staffStore: import("../agent/staff-store.js").StaffStore;
}

export interface IndexSource {
  readonly sourceId: Indexable["sourceId"];
  /** Enumerate everything currently belonging to this source for full rebuild. */
  iterate(ctx: IndexSourceContext): AsyncIterable<Indexable>;
  /** Optional: push live changes as they happen. Not used by v1 sources
   *  (project-context wires stores directly), but REQUIRED for v2 file source. */
  watch?(ctx: IndexSourceContext): AsyncIterable<IndexEvent>;
}

export interface SearchQuery {
  q: string;
  projectId?: string;
  /** Restrict to one or more sourceIds. Undefined = all. */
  types?: Array<Indexable["sourceId"]>;
  includeArchived?: boolean;        // default false (matches current behaviour)
  limit?: number;                   // default 20
  offset?: number;                  // default 0
}

export interface SearchResult {
  type: "goal" | "session" | "message" | "staff" | "file";
  id: string;                       // Indexable.id (may be chunked)
  parentId?: string;                // entity-level id after chunk collapse
  title: string;
  snippet: string;                  // HTML with <b> match markers
  timestamp: number;
  archived: boolean;
  score: number;                    // post-weight fused score; monotonic
  goalId?: string;
  sessionId?: string;
  sessionTitle?: string;
  projectId?: string;
  projectName?: string;
  // v2:
  filePath?: string;
  startLine?: number;
  endLine?: number;
}

export interface SearchResults {
  results: SearchResult[];
  total: number;
}
```

### LanceDB schema (literal)

One table `content` per project. Arrow schema:

```ts
// lance-store.ts
import { Schema, Field, Utf8, Int32, Int64, Float32, Bool, FixedSizeList } from "apache-arrow";

export const EMBED_DIM = 768;

export const contentSchema = new Schema([
  new Field("id",            new Utf8(),                                           false), // primary key
  new Field("source_id",     new Utf8(),                                           false), // goals|sessions|messages|staff|files
  new Field("project_id",    new Utf8(),                                           false),
  new Field("entity_type",   new Utf8(),                                           false), // goal|session|message|staff|file
  new Field("parent_id",     new Utf8(),                                           true),  // entity id before chunking
  new Field("archived",      new Bool(),                                           false),
  new Field("timestamp",     new Int64(),                                          false),
  new Field("content_hash",  new Utf8(),                                           false),
  new Field("weight",        new Float32(),                                        false),
  new Field("role",          new Utf8(),                                           true),
  new Field("title",         new Utf8(),                                           true),
  new Field("text",          new Utf8(),                                           false), // indexed by FTS + used for snippet
  // Denormalised for display / filtering without a join:
  new Field("goal_id",       new Utf8(),                                           true),
  new Field("session_id",    new Utf8(),                                           true),
  new Field("session_title", new Utf8(),                                           true),
  // v2 file fields (nullable today):
  new Field("file_path",     new Utf8(),                                           true),
  new Field("start_line",    new Int32(),                                          true),
  new Field("end_line",      new Int32(),                                          true),
  new Field("embedding",     new FixedSizeList(EMBED_DIM, new Field("item", new Float32(), false)), false),
]);
```

Plus a single-row `search_meta` table: `{ embedder_id: Utf8, dim: Int32, schema_version: Int32, content_policy_version: Int32, created_at: Int64 }`.

Indexes (created lazily when row count > 10 000):

- **Vector**: `createIndex("embedding", { type: "IVF_PQ", numPartitions: ..., numSubVectors: ... })` — see §13.
- **Full-text**: `createIndex(["title", "text"], { type: "FTS", withPosition: true })`.

---

## 4. Dependencies

Live npm check performed on 2026-04-18 (see Risk §14 for prebuilt-binary matrix):

| Package | Version | License | Platforms (prebuilt) |
|---|---|---|---|
| `@lancedb/lancedb` | `0.27.2` | Apache-2.0 | see below |
| `@lancedb/lancedb-win32-x64-msvc` | `0.27.2` | Apache-2.0 | ✓ |
| `@lancedb/lancedb-win32-arm64-msvc` | `0.27.2` | Apache-2.0 | ✓ |
| `@lancedb/lancedb-linux-x64-gnu` | `0.27.2` | Apache-2.0 | ✓ |
| `@lancedb/lancedb-linux-x64-musl` | `0.27.2` | Apache-2.0 | ✓ (covers Alpine) |
| `@lancedb/lancedb-linux-arm64-gnu` | `0.27.2` | Apache-2.0 | ✓ |
| `@lancedb/lancedb-linux-arm64-musl` | `0.27.2` | Apache-2.0 | ✓ |
| `@lancedb/lancedb-darwin-x64` | `0.22.3` | Apache-2.0 | ⚠ lags main (older) but present |
| `@lancedb/lancedb-darwin-arm64` | `0.27.2` | Apache-2.0 | ✓ |
| `@huggingface/transformers` | `4.1.0` | Apache-2.0 | JS; loads ONNX at runtime |
| `onnxruntime-node` | transitive of `@huggingface/transformers` | MIT | ships prebuilt binaries for win/linux/mac |
| `apache-arrow` | transitive of `@lancedb/lancedb` | Apache-2.0 | pure JS |

**License posture:** all Apache-2.0 / MIT — compatible with Bobbit.

**Exact `package.json` additions:**

```json
{
  "dependencies": {
    "@lancedb/lancedb": "^0.27.2",
    "@huggingface/transformers": "^4.1.0"
  }
}
```

`better-sqlite3` is used *only* by `search-index.ts` today (verified via grep). Remove it after migration lands to shrink install. Leave `onnxruntime-node` to NPM's transitive resolution — do not pin directly.

**Darwin x64 caveat:** `@lancedb/lancedb-darwin-x64` is at 0.22.3 while the core is 0.27.2. Validate on macOS Intel during rollout; LanceDB's Node loader is designed to pick the appropriate platform optional-dep, but old binaries against new JS glue can break. Mitigation: pin to the latest version that has all targets in sync if this matters for our user base (most devs are arm64 Mac / x64 Linux / x64 Windows).

---

## 5. Content policy

Copied from the spec, mapped to concrete code:

| Content type | Role tag | Weight | Text indexed |
|---|---|---|---|
| Session title | `title` | 3.0 | full |
| Goal spec | `spec` | 2.5 | `title + "\n\n" + spec` (title gets FTS weighting via `title` column) |
| User message | `user` | 2.0 | full |
| Staff profile | `profile` | 1.5 | `name + "\n\n" + description` |
| Assistant text | `assistant` | 1.0 | stripped of `<thinking>…</thinking>` blocks |
| Tool call | `tool_call` | 0.8 | `"<tool_name> " + firstLine(JSON.stringify(input))` |
| Tool result | `tool_result` | 0.5 | first 500 chars; skip entirely if raw >32KB (aligns with `truncate-large-content.ts` threshold) |

### Refactored `content-policy.ts` surface

```ts
export interface PolicyHit {
  /** Zero or more Indexables emitted from one message. */
  entries: Array<{
    role: Role;
    weight: number;
    text: string;
    /** For deterministic child ids: e.g. "text:0" or "tool_use:web_search:0". */
    blockKey: string;
  }>;
}

export interface ExtractOptions {
  /** Max characters of raw tool_result to consider before skipping. Default 32_768. */
  maxToolResultInputChars?: number;
  /** Max characters of tool_result we actually index. Default 500. */
  toolResultIndexChars?: number;
}

/** Replaces extractTextFromMessage. Role-aware, policy-aware, preserves block ordering. */
export function extractForIndexing(message: unknown, opts?: ExtractOptions): PolicyHit;

/** Strips <thinking>…</thinking> (greedy across newlines, non-nested). */
export function stripThinking(text: string): string;

/** Summarise a tool_use block to a single short line for indexing. */
export function summariseToolCall(name: string, input: unknown): string;

/** Keep nudging this when the policy changes so migration auto-rebuilds. */
export const CONTENT_POLICY_VERSION = 1;
```

Role detection rules (applied in order, per block, per message):

1. `message.role === "user"` AND block type `"text"` → role=`user`, weight=2.0.
2. `message.role === "user"` AND block type `"tool_result"` → role=`tool_result`, weight=0.5.
3. `message.role === "assistant"` AND block type `"text"` → role=`assistant`, weight=1.0, text = `stripThinking(block.text)`.
4. `message.role === "assistant"` AND block type `"tool_use"` → role=`tool_call`, weight=0.8, text = `summariseToolCall(name, input)`.
5. `block.type === "thinking"` → skip entirely.
6. `block.type === "image"` / binary → skip.

Goal spec / session title / staff profile are not messages — their `IndexSource`s construct `Indexable`s directly with roles `spec`, `title`, `profile`.

Empty/whitespace-only `text` is filtered out before embedding.

---

## 6. Chunking

### Parameters
- **Target tokens per chunk:** 2 000 (well under nomic's 8 192-token context; leaves headroom for the `search_document: ` prefix and tokenization slack).
- **Overlap:** 200 tokens.
- **Token counter:** `embedder.countTokens(text)` — uses the nomic tokenizer already loaded. No separate tiktoken dep.

### ID scheme
- Unchunked: `message:<sid>:<msgIdx>`.
- Chunked: `message:<sid>:<msgIdx>:chunk:<n>` where `n` is 0-based chunk index.
- `parent_id` column stores the pre-chunk id (`message:<sid>:<msgIdx>`) so collapse is a simple group-by.

### Collapse on display
`HybridQuery` dedups on `parent_id` after ranking: for each parent, keep the best-scoring chunk, carry its snippet and score to the parent row. A query returning 20 chunks across 7 parents yields 7 `SearchResult`s.

### Applies uniformly
- Goal specs usually fit in one chunk — but the chunker is invoked unconditionally so over-long specs (rare) still index correctly.
- User messages rarely exceed 2 000 tokens; chunking is idempotent — `chunkText(smallString)` returns `[{ id: "...:chunk:0", text: smallString }]`.
- v2 file source uses the **same** chunker for text files; this is the v2-readiness test.

---

## 7. Hybrid query

LanceDB ships a first-class hybrid search API. Invocation:

```ts
// hybrid-query.ts
async function search(q: SearchQuery, store: LanceStore, embedder: Embedder): Promise<SearchResults> {
  const table = await store.openTable();
  const queryVec = (await embedder.embed([q.q], "query"))[0];

  const filter = buildFilter(q);            // SQL-like predicate string
  const raw = await table
    .query()
    .fullTextSearch(q.q, { columns: ["title", "text"] })
    .nearestTo(queryVec)
    .where(filter)
    .rerank({ type: "rrf", k: 60 })          // LanceDB built-in Reciprocal Rank Fusion
    .limit((q.limit ?? 20) * 3)              // over-fetch for parent collapse
    .toArray();

  // Post-rank weight multiplier
  const scored = raw.map(r => ({ ...r, score: r._relevance_score * r.weight }));
  scored.sort((a, b) => b.score - a.score);

  // Collapse by parent_id (keep best chunk per parent)
  const byParent = new Map<string, typeof scored[0]>();
  for (const r of scored) {
    const key = r.parent_id ?? r.id;
    if (!byParent.has(key)) byParent.set(key, r);
  }

  const final = [...byParent.values()].slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 20));
  return {
    total: byParent.size,
    results: final.map(row => toSearchResult(row, q.q)),
  };
}
```

### Filter predicate assembly

LanceDB `.where()` accepts SQL strings. Build via safe interpolation (values are controlled internals — goal ids, project ids, source ids — never user text):

```ts
function buildFilter(q: SearchQuery): string {
  const parts: string[] = [];
  if (q.projectId) parts.push(`project_id = '${escape(q.projectId)}'`);
  if (!q.includeArchived) parts.push(`archived = false`);
  if (q.types && q.types.length > 0) {
    const list = q.types.map(t => `'${escape(t)}'`).join(",");
    parts.push(`source_id IN (${list})`);
  }
  return parts.length > 0 ? parts.join(" AND ") : "TRUE";
}
```

### Snippet rendering

`snippet.ts::highlight(text, query)`:
1. Tokenise query (lowercase, split on `\s+`, drop tokens < 2 chars).
2. Find earliest match window (~300 chars centred on first hit).
3. HTML-escape the window, then wrap each case-insensitive token match in `<b>…</b>`.
4. Prepend `…` / append `…` if the window is not at the string edge.

Same `<b>` contract as today — `search-page.ts` keeps its existing sanitiser.

---

## 8. Indexing triggers — full call-site map

Every existing call site maps 1:1 to the new surface. `SearchService` exposes the same method names during the initial migration to keep the diff small; a follow-up rename is free.

| File : line | Current call | New call |
|---|---|---|
| `project-context.ts:72` | `new SearchIndex(...)` | `new SearchService({ stateDir, projectId, embedder })` |
| `project-context.ts:88` | `searchIndex.staffStore = ...` | constructor takes `staffStore` |
| `project-context.ts:89` | `.open()` | `.open()` (async now — loads dataset, checks meta, schedules rebuild if needed) |
| `project-context.ts:91` | `.rebuildFromStores(...)` | `.rebuildFromSources([GoalSource, SessionSource, MessageSource, StaffSource])` — runs in background, emits progress |
| `project-context.ts:95` | `.indexGoal(goal, projectId)` | `.indexGoal(goal)` (projectId bound at construction) |
| `project-context.ts:99` | `.indexSession(session, goalTitle, projectId)` | `.indexSession(session, goalTitle)` |
| `project-context.ts:106` | `.close()` | `.close()` |
| `session-manager.ts:380` | `new SearchIndex(...)` (test harness) | `new SearchService({ stateDir, projectId: "test", embedder: TEST_EMBEDDER })` |
| `session-manager.ts:442, 499` | `getSearchIndexForProject` / `resolveSearchIndex` | rename → `getSearchServiceForProject` / `resolveSearchService` |
| `session-manager.ts:573` | injects `searchIndex` into `SessionContext` | inject `searchService` |
| `session-manager.ts:1257` | `resolveSearchIndex(session).indexMessage(...)` | `.indexMessage({ sessionId, sessionTitle, message, timestamp })` — note: takes the **raw message object** now; `content-policy.extractForIndexing` runs inside the service |
| `session-manager.ts:1641-1655` | test-harness full rebuild loop | `.open()` handles needsRebuild internally; ad-hoc indexGoal/indexSession loop can stay |
| `session-manager.ts:3579-3582` | `.removeMessagesForSession / .removeSession` | same names |
| `session-manager.ts:4074` | `.close()` | `.close()` |
| `staff-manager.ts:82, 166` | `.indexStaff(staff, projectId)` | `.indexStaff(staff)` |
| `staff-manager.ts:115, 197` | `.removeStaff(id)` | same |
| `state-migration.ts:287` | `renameForBackup(search.db)` | add: also delete `search.lance/` on version mismatch (very rare); keep the rename-for-backup for legacy `search.db` |

### Incremental upsert flow

Every `indexX(entity)` call:
1. Builds `Indexable[]` via the matching source's helper (`GoalSource.toIndexable(goal)` etc.).
2. Computes `contentHash = sha256(text + weight + role + timestamp)`.
3. Looks up existing hash in the `content` table (`SELECT content_hash FROM content WHERE id IN (...)`).
4. Skips if unchanged.
5. Queues changed entries onto an in-memory FIFO; the indexer drains in batches of 32 (embedding cost dominates).

### Backlog threshold (yellow dot)

`Indexer` maintains `backlog: number` (queued but not yet embedded). Status logic:

- `backlog === 0` and no active rebuild → **green** (no indicator).
- `backlog > 50` OR `rebuildInProgress` → **yellow** with `"Indexing {backlog} items…"` tooltip.
- Last-open error → **red** with Retry link.

`progress-bus.ts` emits `index:progress` whenever `backlog` changes; the server debounces to 500ms before broadcasting.

---

## 9. WebSocket events & UI surfaces

### Protocol additions (`src/server/ws/protocol.ts`)

```ts
export type ServerMessage =
  | /* existing types */
  | { type: "index:progress"; projectId: string; phase: "rebuild" | "incremental";
      total: number; completed: number; backlog: number }
  | { type: "index:complete"; projectId: string; phase: "rebuild" | "incremental";
      durationMs: number; rowsWritten: number }
  | { type: "index:error"; projectId: string; message: string; recoverable: boolean };
```

Broadcast scope: all WS connections currently viewing the given `projectId` (existing `broadcastToProject` helper in `server.ts`). Debounce `index:progress` to 500ms.

### UI components

**Search status dot** — `src/app/components/search-status-dot.ts`:
- Rendered inline inside the search input in the main header and inside `search-page.ts`'s search bar.
- Subscribes to `index:*` WS events via the existing `ws-client` event bus.
- States: hidden (green), yellow pill with tooltip, red pill with clickable Retry (fires `POST /api/search/rebuild`).

**Settings → Maintenance → "Search Index" panel** — added inside `src/app/settings-page.ts` Maintenance tab:
- Stats (from `GET /api/search/stats`): last full rebuild, per-source row counts (goals/sessions/messages/staff), dataset size on disk (via `du -s` or Node `fs.stat` recursive), embedder id + dim.
- Live progress bar when an `index:progress` event stream is active for this project.
- Buttons: **Rebuild Index** (confirm dialog → `POST /api/search/rebuild`), **Compact Dataset** (`POST /api/search/compact`).
- "v2: Re-scan Project Files" button hidden behind a feature flag for now.

**Orphaned index rows** scan — added as a 4th section in the existing Maintenance tab, mirroring the worktree/session/archive pattern:
- `GET /api/maintenance/orphaned-index-rows?projectId=…` returns `{ count, sample: [{ id, source_id, parent_id }] }` — rows whose parent entity no longer exists in `goalStore` / `sessionStore` / `staffStore`.
- `POST /api/maintenance/cleanup-index-rows` deletes them via `LanceStore.deleteByIds`.

### Never surfaced

- Individual incremental upserts.
- Background compaction (logs only).
- No toast / no banner ever — the yellow dot + Settings panel are the only affordances.

---

## 10. Migration

### On first startup after deploy
1. `ProjectContext.open()` resolves `stateDir/search.lance` — directory does not exist yet.
2. `LanceStore.open()` creates the dataset with current schema + writes `search_meta` row.
3. `SearchService.rebuildFromSources([...])` runs asynchronously. Status dot goes yellow.
4. `state-migration.ts` detects legacy `search.db` next to `search.lance/` and **deletes** it (after the first successful LanceDB `open()` to avoid losing both if we crash mid-rebuild). Use `fs.rm` with a `.bak` rename fallback for paranoia.

### On subsequent startups
1. `LanceStore.open()` reads `search_meta`.
2. If `meta.embedder_id !== currentEmbedder.id` OR `meta.dim !== currentEmbedder.dim` OR `meta.schema_version !== SCHEMA_VERSION` OR `meta.content_policy_version !== CONTENT_POLICY_VERSION` → drop the `content` table and rebuild. Log at info level.
3. If the dataset fails to open (corrupt, partial write) — log, rename dataset dir to `search.lance.corrupt-<ts>`, rebuild from scratch.

### Rebuild path under the hood

```ts
async rebuildFromSources(sources: IndexSource[]): Promise<void> {
  await this.embedder.ready();          // may trigger model download
  await this.lance.recreateContentTable();
  for (const src of sources) {
    for await (const batch of chunked(src.iterate(ctx), 32)) {
      const vecs = await this.embedder.embed(batch.map(b => "search_document: " + b.text), "document");
      await this.lance.upsert(batch.map((b, i) => ({ ...toRow(b), embedding: vecs[i] })));
      progressBus.emit("progress", { completed += batch.length });
    }
  }
  if (rowCount > 10_000) await this.lance.createIndexes();
  await this.lance.writeMeta(currentMeta);
  progressBus.emit("complete", { ... });
}
```

---

## 11. Graceful degradation

Two independent failure classes, both surfaced as **red dot + "Search unavailable"**. Never a silent partial mode.

### LanceDB native binary fails to load
- Thrown at first `require("@lancedb/lancedb")`.
- `SearchService.open()` catches, logs with the platform tuple, sets `state = "disabled-no-native"`.
- All `indexX` / `removeX` / `search` calls become no-ops that return empty results.
- REST `/api/search` returns `503 { error: "search-unavailable", reason: "native-binary", message }`.
- WS broadcasts `index:error { recoverable: false }`.

### Embedding model fails to download / load
- First `Embedder.ready()` throws.
- `SearchService` enters `state = "disabled-no-model"`. Same no-op semantics.
- UI status dot red + tooltip "Embedding model unavailable"; Settings → Maintenance panel shows the underlying error and a **Retry Download** button that clears the cached partial model and calls `embedder.ready()` again.
- WS broadcasts `index:error { recoverable: true }`.

### The server never
- Falls back to a half-indexed state (ad-hoc "just do FTS for now").
- Returns partial results labelled "degraded" — users get a clear unavailable state with one obvious action.

---

## 12. Test plan

All tests go under `tests/`. Use existing harnesses (`file://` fixtures for unit, `in-process-harness.js` for API E2E, `gateway-harness.js` for browser E2E).

### Unit (under `tests/search/`)

| File | Covers |
|---|---|
| `tests/search/embedder.spec.ts` | `Embedder` contract using a **fake deterministic embedder** (hash → 768-dim vector). Parent tests don't download the real model. |
| `tests/search/content-policy.spec.ts` | Role detection (user/assistant/tool_call/tool_result), `<thinking>` strip, tool-call arg summary, >32KB tool_result skip, 500-char tool_result truncation. Covers the content-policy table row-by-row. |
| `tests/search/chunker.spec.ts` | Boundary cases: empty, single-token, exactly 2000 tokens, 2001 tokens → 2 chunks, overlap preserved, deterministic chunk ids. |
| `tests/search/snippet-highlight.spec.ts` | `<b>`-wrap, HTML escape, window centring, edge ellipses, case-insensitive, multi-token. |
| `tests/search/weight-apply.spec.ts` | Given two rows with equal raw fused score but weights 2.0 vs 1.0, the 2.0 row ranks first. |
| `tests/search/meta-mismatch.spec.ts` | Write meta with stale `embedder_id` / `dim` / `schema_version` / `content_policy_version`; next `open()` triggers rebuild. |
| `tests/search/index-source-contract.spec.ts` | Shared contract runner applied to Goal/Session/Message/Staff sources: `iterate()` yields valid `Indexable`s. |
| `tests/search/files-source-stub.spec.ts` | **V2-readiness test.** Throwaway `FilesIndexSource` iterates a fixture dir, flows end-to-end through `Indexer` → `LanceStore` → `HybridQuery` with **zero changes** to the rest. Asserts no new imports in `indexer.ts`. |

### Lexical parity suite (`tests/search/lexical-parity.spec.ts`)

Guards the FTS5 → Lance+Tantivy switch. Seed a fixed corpus and assert each query returns the same top-1 as the old suite:

- Exact token (`"deadbeef"`).
- Exact phrase (`"refactor hybrid query"`).
- Boolean AND / OR / NOT.
- Stem match (`run` vs `running`).
- Rare-token (UUID, stack-trace fragment).
- Case-insensitive.

If any query regresses, the test prints both rankings side-by-side.

### Integration (`tests/e2e/search-semantic.spec.ts`, in-process harness)

- **Paraphrase fixture**: seed messages containing "story", "stories", "narrative", "user journey". Query "story" → top-3 includes all four.
- **Lexical dominance on exact phrase**: seed a rare phrase into one message; query with the phrase → that message is rank 1 (hybrid+RRF reward exact match).
- **Content policy**: two sessions, identical text; one is a user message (weight 2.0), one is an assistant message (weight 1.0). Query matching both → user message outranks.
- **Chunk collapse**: 5 000-token user message gets 3 chunks; query matches middle chunk → exactly one result for that message.

### Browser E2E (`tests/e2e/ui/search-e2e.spec.ts`)

Extend existing search tests:
- Status dot goes yellow during a forced rebuild; green when done.
- Red state on injected embed-load failure; Retry button recovers.
- Settings → Maintenance "Search Index" panel shows non-zero row counts after seed.
- Orphan-row scan appears in Maintenance and cleans up on Execute.

### Scale smoke (`tests/search/scale-smoke.spec.ts`, tag `@slow`, not in CI default)

- Generate 100 000 synthetic `Indexable`s (fake embedder — sub-ms per row).
- Trigger `createIndexes()`.
- Run 50 random queries; assert p95 latency < 300ms on a dev laptop.

### Migration (`tests/e2e/search-migration.spec.ts`)

- Place a populated legacy `search.db` in the project's `stateDir`.
- Start the server.
- Assert: `search.db` is deleted (or backed up), `search.lance/` exists, search returns results for seeded entities.

---

## 13. Performance plan

### Vector index choice

LanceDB supports IVF_PQ and HNSW.

- **IVF_PQ**: lower memory, slightly lower recall, faster build.
- **HNSW**: higher recall, RAM-heavy (but Lance keeps it on-disk with good caching).

**Decision:** **IVF_PQ** for v1.
- Our corpus is heterogeneous (messages, specs, titles) not uniformly distributed — HNSW graph quality isn't a clear win.
- Memory budget matters: Bobbit runs on user laptops and in Docker sandboxes.
- Easy to re-index to HNSW later by bumping `schema_version`.

### Index creation parameters

- `numPartitions ≈ sqrt(rowCount)` (Lance recommendation). Capped at 256.
- `numSubVectors = 96` (for 768-dim vectors → 8-dim sub-spaces), 8-bit codes — a sensible default across Lance docs.

### Creation trigger

- Row count ≤ 10 000 → brute-force is fast enough; no ANN index. Saves build time on small projects.
- Row count > 10 000 → create/rebuild ANN index at the end of any full rebuild, and opportunistically once per hour during incremental growth when `rowsSinceLastIndex > rowCount * 0.1`.

### Batch sizes
- Embedding batch: 32 (empirical sweet spot for nomic on CPU).
- Upsert batch: 128 rows.

### 100K scale smoke
See `tests/search/scale-smoke.spec.ts` above. Non-blocking for launch but we want a red signal if we regress.

---

## 14. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **LanceDB native binary missing on user platform** | Low | High | Prebuilt binaries exist for all Bobbit-supported platforms (see §4 live-check table). 10-minute smoke test on each target in CI/release. On failure at load time, §11 degradation path — red dot + "Search unavailable". |
| **macOS Intel binary version skew** (`darwin-x64` at 0.22.3 vs 0.27.2 core) | Medium | Medium | Validate during rollout on an Intel Mac; if broken, pin to a triple-matched version or drop to the highest version where all triples are in sync. |
| **First-run ~140MB model download blocks UX** | High | Medium | Lazy: download starts on first `Embedder.ready()`, which happens on first search or first rebuild — **not** server startup. Status dot yellow + "Downloading embedding model (140MB)…". Retry on failure. Cache in `.bobbit/state/models/` shared across projects. |
| **Model download fails (firewall / offline)** | Medium | High | Red dot + Retry (§11). Document offline install: pre-place model files in `.bobbit/state/models/nomic-embed-text-v1.5/`. |
| **Long-message embedding cost** | Medium | Medium | Chunker caps per-entry text at ~2K tokens; batching of 32 keeps latency bounded. Content policy already drops tool_result >32KB entirely. |
| **Tool result >32KB dumps** | Certain | Low | Content policy hard-skips. Aligned with existing `truncate-large-content.ts` threshold so the same broadcasts/indexing boundaries apply. |
| **Lance dataset corruption on hard crash** | Low | Medium | Rename-to-`.corrupt-<ts>` + rebuild on open failure. Periodic compaction schedules a fresh snapshot. |
| **Docker sandbox can't find native binary** | Medium | High | Pre-install `@lancedb/lancedb` in the image. Add to Dockerfile apt layer if it pulls any C++ runtime deps. Verify `linux-x64-gnu` or `linux-x64-musl` based on base image. |
| **Index creation stalls >10K rows** | Low | Medium | `createIndexes()` runs in a worker; progress emitted; user can ignore it — fallback to brute-force continues to work. |
| **Windows path length / OneDrive weirdness with `.lance` directory** | Low | Medium | Store under `.bobbit/state/search.lance/` — no deep paths. Existing worktrees already tolerate Windows. |

---

## 15. Rollout order (task decomposition for parallel work)

Tasks are **file-disjoint** wherever possible so multiple coders can work simultaneously. Dependencies labelled.

### Phase 0 — Foundations (serial)
**T0. Dependencies & skeleton.** Add `@lancedb/lancedb` + `@huggingface/transformers` to `package.json`. Create `src/server/search/types.ts` with the full interface set from §3. No behaviour yet.
**T0.1. `meta.ts` + `progress-bus.ts` + `snippet.ts`.** Leaf modules; mutually independent; add immediately after T0.

### Phase 1 — Parallel (4 concurrent coders after T0 merges)

| Task | Files touched | Dependencies |
|---|---|---|
| **T1. `embedder.ts` + Nomic impl** | `src/server/search/embedder.ts` | types.ts |
| **T2. `lance-store.ts`** | `src/server/search/lance-store.ts` | types.ts, meta.ts |
| **T3. `content-policy.ts` + tests** | `src/server/search/content-policy.ts`, `tests/search/content-policy.spec.ts`, delete `message-extractor.ts` **but** keep a re-export shim until T6 lands | types.ts |
| **T4. `chunker.ts` + tests** | `src/server/search/chunker.ts`, `tests/search/chunker.spec.ts` | types.ts (embedder injected) |

### Phase 2 — Parallel (3 concurrent coders after T1–T4 merge)

| Task | Files | Depends on |
|---|---|---|
| **T5. `indexer.ts`** | `src/server/search/indexer.ts` | T1, T2, T4, progress-bus |
| **T6. Sources** | `src/server/search/sources/*.ts` + `sources/files-source.stub.ts` + tests | T3 |
| **T7. `hybrid-query.ts`** | `src/server/search/hybrid-query.ts`, `snippet.ts` integration, tests | T1, T2 |

### Phase 3 — Integration (serial, single coder)

**T8. `search-service.ts` facade + wire into `project-context.ts`.** Depends on T5, T6, T7. Preserves method names so T9 is mechanical.
**T9. Migrate call sites.** `session-manager.ts`, `staff-manager.ts`, `session-setup.ts`, `state-migration.ts`. Mechanical; one commit.
**T10. Delete `search-index.ts` + `message-extractor.ts` shim.** After T9 passes type-check + tests.

### Phase 4 — Parallel (2 coders)

| Task | Files | Depends on |
|---|---|---|
| **T11. REST + WS protocol** | `src/server/server.ts` new endpoints, `src/server/ws/protocol.ts` additions | T8 |
| **T12. UI: status dot + Maintenance panel** | `src/app/components/search-status-dot.ts` (new), `src/app/settings-page.ts` (edit), `src/app/search-page.ts` (integrate dot), `src/app/api.ts` (new wrappers) | T11 |

### Phase 5 — Hardening (serial or paired)

**T13. Parity + integration + E2E tests.** All tests listed in §12.
**T14. Docker image sanity.** Verify `linux-x64-*` binary loads inside the sandbox image; add apt deps if needed.
**T15. Docs.** Update `docs/internals.md`, `docs/debugging.md`, recipes in `AGENTS.md`.
**T16. Smoke / scale.** Run `tests/search/scale-smoke.spec.ts`. Verify macOS Intel behaviour.

### Critical path
T0 → T1,T2,T3,T4 → T5,T6,T7 → T8 → T9 → T11,T12 → T13 → T16.

Expected wall-clock with 3 coders in parallel where noted: ~2 weeks. Solo: ~4 weeks.

---

## Appendix A — One-page cheat sheet

- **Store:** LanceDB, `.bobbit/state/search.lance/`, one `content` table, one `search_meta` row.
- **Model:** `nomic-embed-text-v1.5`, 768-dim, via `@huggingface/transformers` + ONNX runtime.
- **Query prefix:** `search_document: ` on index, `search_query: ` on query.
- **Ranking:** RRF-fused vector + FTS, then `score *= weight`, then collapse by `parent_id`.
- **Content policy versioning:** bump `CONTENT_POLICY_VERSION` → auto rebuild.
- **Schema versioning:** bump `SCHEMA_VERSION` → auto rebuild.
- **Status dot states:** green (≤50 backlog, no rebuild), yellow (rebuild or backlog>50), red (unavailable).
- **Never:** foreground toasts / banners for rebuilds. Silent partial mode. Shipping without a parity test.
