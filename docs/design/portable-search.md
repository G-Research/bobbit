# Portable Search — Design Document

**Status:** Authoritative design for goal `goal-portable-s-ee9008c4`.
**Audience:** The coder implementing this change. You should not need to re-investigate the codebase.
**Scope:** Replace the Nomic + LanceDB semantic search stack with a pure-JS FlexSearch backend. BM25-only ranking. No embeddings. No native binaries. No runtime model downloads.
**Supersedes:** `docs/design/semantic-search.md` §3 (stack choice), §4 (dependencies), §7 (RRF), §10 (meta), §11 (graceful-degradation states). The `IndexSource` / `Indexable` / `SearchQuery` / `SearchResult` surface from that doc is **unchanged** and remains authoritative.

---

## 1. Overview & motivation

Since v0.6.0 (#334) `npm install bobbit` fails in network-restricted environments:

1. **`@huggingface/transformers`** transitively pulls in `onnxruntime-node` and `sharp`, both of which run `postinstall` scripts that fetch prebuilt native binaries from GitHub Releases / CDNs — not the npm registry. No npm mirror can intercept them.
2. **`@lancedb/lancedb`** ships a platform-specific native Rust binary per target triple.
3. At first search, `NomicEmbedder` downloads ~140–500 MB of ONNX weights from `huggingface.co`.

Vendoring, mirroring, or lockfile tricks do not solve the runtime model download and turn every upstream bump into a landmine.

**Decision.** Drop embeddings entirely and move to **[FlexSearch](https://github.com/nextapps-de/flexsearch)** — a pure-JS, zero-dep, Apache-2.0 full-text index library, ~90 KB shipped. BM25-style lexical ranking is the *only* scoring path. Identifier / code-token search quality is expected to **improve** over the current blended Nomic+BM25 baseline; natural-language "fuzzy meaning" queries regress — explicitly accepted per goal requirements.

One engine. One code path. Installs anywhere, even with no internet.

---

## 2. Current architecture (what is being replaced)

- **`src/server/search/embedder.ts`** — `NomicEmbedder` (ONNX via `@huggingface/transformers`) + `createFakeEmbedder()` for tests. Exposes `id`, `dim: 768`, `embed()`, `countTokens()`, `ready()`.
- **`src/server/search/lance-store.ts`** — `LanceStore` wraps `@lancedb/lancedb`. Owns the `content` table Arrow schema (see `buildContentSchema`, lance-store.ts:50), the `search_meta` table, dataset open/create/rename-on-corrupt, lazy IVF_PQ + FTS index creation at 10 K rows, and `compact()`.
- **`src/server/search/hybrid-query.ts`** — builds `.fullTextSearch(...).nearestTo(vec).rerank(RRF).limit(...).toArray()`, post-multiplies `_relevance_score * row.weight`, collapses by `parent_id`, highlights via `snippet.highlight`.
- **`src/server/search/chunker.ts`** — `chunkText(text, parentId, { countTokens })`. Token counter is the embedder's tokenizer; 2 000-token chunks with 200-token overlap.
- **`src/server/search/meta.ts`** — `MetaRow { embedderId, dim, schemaVersion, contentPolicyVersion, createdAt }`; `needsRebuild()` triggers full rebuilds on any mismatch. `SCHEMA_VERSION = 1` (in `types.ts`).
- **`src/server/search/indexer.ts`** — orchestrates `Indexable` → embed(batch 32) → upsert(batch 128) → progress events. Dedups via `contentHash`. Expands long entries through `chunker`. Handles full rebuild from `IndexSource[]`.
- **`src/server/search/search-service.ts`** — per-project facade. State machine: `initializing | ready | disabled-no-native | disabled-no-model | closed`. Opens `LanceStore`, warms up the embedder, reads meta, schedules background rebuild on mismatch, schedules daily compaction. Legacy-compat `search()`, `indexGoal/Session/Message/Staff`, `removeX`, `rebuildFromStores`.
- **REST:** `GET /api/search/stats`, `POST /api/search/rebuild`, `POST /api/search/compact`, `GET /api/maintenance/orphaned-index-rows`, `POST /api/maintenance/cleanup-index-rows` (server.ts:6430–6585).
- **UI:** `src/app/components/search-status-dot.ts` (green/yellow/red pill with Retry), `src/app/settings-page.ts` Maintenance → Search Index panel (stats grid, progress bar, `Rebuild Index`, `Compact Dataset`, `Refresh`).
- **Progress bus:** `src/server/search/progress-bus.ts` — emits `index:progress | index:complete | index:error`; forwarded over WS.

---

## 3. Target architecture

```
  goal/session/staff/msg mutations
               │
               ▼
  ┌─────────────────────────────────────────────┐
  │  SearchService (facade — unchanged surface) │
  │    indexGoal / indexSession / indexMessage  │
  │    indexStaff / removeX / search            │
  │    rebuildFromStores / getStats / compact   │
  └───────────────────────┬─────────────────────┘
                          │
                          ▼
  ┌─────────────────────────────────────────────┐
  │  Indexer (unchanged shape, no embed step)   │
  │   dedup by contentHash → chunk → upsert     │
  └───────────────────────┬─────────────────────┘
                          │
                          ▼
  ┌─────────────────────────────────────────────┐
  │  FlexSearchStore  (replaces LanceStore +    │
  │                    HybridQuery)             │
  │   flexsearch.Document                       │
  │     ├─ idx "text"      (forward, stemmer)   │
  │     ├─ idx "identifier"(strict, no stemmer) │
  │     └─ idx "title"     (forward, stemmer)   │
  │   scalar store: role, sourceId, projectId,  │
  │                archived, timestamp, weight, │
  │                parent_id, text, display…    │
  │   BM25 + per-source weight × recency boost  │
  │   persistence: <stateDir>/search.flex/*.json│
  └─────────────────────────────────────────────┘
```

Key differences vs. today:

- No `Embedder`. `countTokens` moves to a 20-line `approxTokenCount(text)` helper in `chunker.ts`.
- No Arrow schema. Documents are plain JS objects handed to `flexsearch.Document`.
- No IVF_PQ. No cosine. No RRF. No reranker.
- No network at install, no network at runtime, no native binary.
- `HybridQuery` is folded into `FlexSearchStore.search()` (see §9).

---

## 4. FlexSearch configuration

### 4.1 Library import

```ts
// Top-level ES module import is fine — FlexSearch ships ESM since 0.8.
import { Document } from "flexsearch";
```

Pin: `"flexsearch": "0.8.158"` (latest stable at design time — confirm on implementation). No postinstall. Zero runtime deps. ~90 KB minified.

### 4.2 Document shape

One FlexSearch document per `Indexable` (or per chunk). Scalars mirror the existing `ContentRow` in `lance-store.ts`, minus the `embedding` column and minus Arrow-specific null typing. The primary key is `id: string`.

```ts
interface FlexDoc {
  id: string;                      // primary key (matches Indexable.id or chunk id)
  source_id: "goals" | "sessions" | "messages" | "staff" | "files";
  project_id: string;
  entity_type: "goal" | "session" | "message" | "staff" | "file";
  parent_id: string | null;        // null on the primary row; set on chunk rows
  archived: boolean;
  timestamp: number;               // ms since epoch
  content_hash: string;
  weight: number;                  // post-rank multiplier (0.5 – 3.0)
  role: string | null;
  title: string | null;            // title / display head
  text: string;                    // indexed natural-language content
  identifier_text: string;         // derived — see §4.4
  goal_id: string | null;
  session_id: string | null;
  session_title: string | null;
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
}
```

### 4.3 Document index config

```ts
const index = new Document<FlexDoc, string[]>({
  // Documents are small-to-medium; we want fast startup over top-end speed.
  // FlexSearch's `Document` API supports field-specific tokenizers/encoders.
  document: {
    id: "id",
    // `index` = fields that are *searchable*
    index: [
      {
        field: "title",
        tokenize: "forward",          // prefix matching on titles
        encoder: "LatinAdvanced",     // dedup-friendly encoder; keeps punctuation tokens
        resolution: 9,                // max scoring resolution
      },
      {
        field: "text",
        tokenize: "forward",          // prefix matching on natural-language body
        encoder: "LatinAdvanced",
        resolution: 9,
      },
      {
        field: "identifier_text",
        tokenize: "strict",           // whole-token exact matching for identifiers
        encoder: "Simple",            // preserves case-folded tokens without stemming
        resolution: 9,
      },
    ],
    // `store` = fields we want back on hits without re-reading a side-table.
    // We store every scalar we need to render a SearchResult so we never have
    // to look rows up in a second structure.
    store: [
      "source_id", "project_id", "entity_type", "parent_id", "archived",
      "timestamp", "weight", "role", "title", "text",
      "goal_id", "session_id", "session_title",
      "file_path", "start_line", "end_line",
    ],
  },
  // Per-field tag filtering via where():
  tag: {
    source_id: "source_id",
    project_id: "project_id",
    archived: "archived",
  },
  // Cache last-N queries for the common "same query + paginate" UI case.
  cache: 100,
});
```

**Justifications.**

- `tokenize: "forward"` on natural-language fields gives prefix search — typing `goa` matches `goal`, matching the UX users expect from the sidebar search box.
- `tokenize: "strict"` on `identifier_text` makes `hybridQuery`, `LanceStore`, or `searchService` land as exact matches rather than being stem-collapsed into `hybridqueri`. This is the single biggest reason we expect identifier search to *improve* vs. Nomic: embeddings dilute symbol matches with vague semantic neighbours; strict tokenization ranks exact hits first and deterministically.
- `encoder: "Simple"` for identifiers avoids stemming and aggressive phonetic folding — we want `searchService` and `searchStore` to stay distinct.
- `encoder: "LatinAdvanced"` for `title` / `text` normalises diacritics and lowercases, which is the classic English full-text trade-off.
- `cache: 100` is small enough to stay out of memory budget discussions and kills the cost of the sidebar debouncing identical keystrokes.
- No `context: true` — context indexing doubles memory for marginal ranking gains on short chat text.

### 4.4 `identifier_text` derivation

A pure helper in `flex-store.ts`:

```ts
// Extract identifier-like tokens from text: camelCase, snake_case, kebab-case,
// dotted paths, and file paths split on / \ .
function extractIdentifierTokens(text: string): string {
  const out: string[] = [];
  // Split camelCase → "SearchService" → ["Search", "Service", "SearchService"]
  // Split snake/kebab/dot/slash into constituents but keep the joined form.
  // Preserve the raw token plus its decomposed parts — FlexSearch strict
  // tokenizer indexes each whitespace-separated token.
  const raw = text.match(/[A-Za-z_][A-Za-z0-9_./\\-]{1,63}/g) ?? [];
  for (const tok of raw) {
    out.push(tok);
    // camelCase → individual words
    const camelParts = tok.split(/(?=[A-Z])/).filter((s) => s.length > 0);
    if (camelParts.length > 1) out.push(...camelParts);
    // snake / kebab / dot / path separators
    const parts = tok.split(/[_./\\-]+/).filter((s) => s.length > 0);
    if (parts.length > 1) out.push(...parts);
  }
  return out.join(" ");
}
```

Computed once per document on upsert. Result lives in `identifier_text` (stored *but not re-returned* in `store`, since it's redundant with `text`).

---

## 5. Persistence

FlexSearch exposes `export(key, data)` / `import(key, data)` on the `Document` class. `export` is called once per internal sub-structure (one per indexed field plus tags, cache, and document registry) with a string `key` and a serialisable value. `import` replays them.

### 5.1 On-disk layout

```
<stateDir>/search.flex/
  meta.json              # our meta row — versioning + lastRebuildAt + counts
  index/
    <key>.json           # one file per FlexSearch export key
    <key>.json.tmp       # atomic-rename staging files (never committed state)
```

`stateDir` comes from `SearchServiceOptions.stateDir` — same dir as the current `search.lance`. The directory replaces `search.lance/`; see §8 for migration.

### 5.2 Load on open

```ts
class FlexSearchStore {
  static async open(opts: { dataDir: string }): Promise<FlexSearchStore> {
    await fs.promises.mkdir(path.join(opts.dataDir, "index"), { recursive: true });
    const store = new FlexSearchStore(opts.dataDir);
    await store._loadFromDisk();
    return store;
  }

  private async _loadFromDisk(): Promise<void> {
    const dir = path.join(this.dataDir, "index");
    let entries: string[] = [];
    try { entries = await fs.promises.readdir(dir); } catch { return; }
    for (const file of entries) {
      if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
      const key = file.slice(0, -".json".length);
      let raw: string;
      try { raw = await fs.promises.readFile(path.join(dir, file), "utf-8"); }
      catch { continue; }
      try {
        this._idx.import(key, JSON.parse(raw));
      } catch (err) {
        // Corrupt file → skip this key; upstream meta check triggers rebuild.
        console.warn(`[search] Skipping corrupt index file ${file}:`, err);
      }
    }
  }
}
```

### 5.3 Save on write (debounced)

FlexSearch exports are cheap per-key but non-trivial in aggregate on large corpora. Persist with a **500 ms trailing-edge debounce**, plus a synchronous flush on `close()` and before `SearchService.close()` returns. Per-key atomic writes:

```ts
private _savePending = false;
private _saveTimer: NodeJS.Timeout | null = null;

private _scheduleSave(): void {
  if (this._saveTimer) return;
  this._saveTimer = setTimeout(() => {
    this._saveTimer = null;
    void this._flush().catch((err) =>
      console.error("[search] flex persistence failed:", err));
  }, 500);
  if (typeof this._saveTimer.unref === "function") this._saveTimer.unref();
}

private async _flush(): Promise<void> {
  const dir = path.join(this.dataDir, "index");
  await fs.promises.mkdir(dir, { recursive: true });
  const written: string[] = [];
  await this._idx.export(async (key, data) => {
    const final = path.join(dir, `${key}.json`);
    const tmp = `${final}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(data), "utf-8");
    await fs.promises.rename(tmp, final);  // atomic on same filesystem
    written.push(`${key}.json`);
  });
  // Remove stale export keys that FlexSearch no longer emits.
  const present = new Set(written);
  const entries = await fs.promises.readdir(dir).catch(() => []);
  for (const f of entries) {
    if (f.endsWith(".json") && !present.has(f)) {
      await fs.promises.unlink(path.join(dir, f)).catch(() => void 0);
    }
  }
  await this._writeMeta();
}
```

**Atomic write strategy.** `write <tmp>` → `rename <tmp> <final>`. `fs.rename` is atomic within a single filesystem on Linux/macOS; on Windows it's also atomic when the target exists and is on the same volume (Node's `fs.rename` uses `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`). A crash mid-write leaves `.tmp` files behind — the loader skips anything ending in `.tmp`. A crash between successful per-key renames can leave the on-disk index partially updated relative to `meta.json`; treat that as "corrupt" and rebuild (§8).

### 5.4 Concurrency

All mutations serialise through `SearchService` (already single-threaded per-project). `_flush` is guarded by `_savePending` so only one write pass runs at a time; a second mutation during flush queues another trailing debounced flush.

### 5.5 Size expectations

FlexSearch document JSON for the existing Bobbit-as-a-dogfood corpus (goals + sessions + ~40 K messages) will be well under 100 MB — the removal of 768-dim float vectors (768 × 4 B × rowCount = ~150 MB for 50 K rows) easily dwarfs the FlexSearch postings overhead. No special compaction needed.

---

## 6. API surface preserved — `FlexSearchStore`

`FlexSearchStore` replaces `LanceStore`. Callers (`Indexer`, `SearchService`) change their import and some method shapes but not their *intent*.

```ts
// src/server/search/flex-store.ts
export interface FlexSearchStoreOpenOptions {
  dataDir: string;  // <stateDir>/search.flex
}

export interface FlexSearchStats {
  rowCountsBySource: { goals: number; sessions: number; messages: number; staff: number; files: number };
  totalRows: number;
  datasetBytes: number;
  lastRebuildAt: number | null;
}

export class FlexSearchStore {
  readonly dataDir: string;
  static async open(opts: FlexSearchStoreOpenOptions): Promise<FlexSearchStore>;

  /** Idempotent upsert keyed by id. */
  async upsert(docs: FlexDoc[]): Promise<void>;

  /** Delete rows by id (and any chunk rows with matching parent_id). */
  async deleteByIds(ids: string[]): Promise<void>;

  /**
   * Filter-style delete used by removeMessagesForSession. Structured filter
   * instead of raw SQL — concrete keys only, no injection surface.
   */
  async deleteWhere(filter: {
    source_id?: string;
    session_id?: string;
    project_id?: string;
    parent_id?: string[] | null;
  }): Promise<void>;

  /** Clear the entire index. Called at the start of a full rebuild. */
  async clear(): Promise<void>;

  /** Primary query entry point — see §9 for ranking semantics. */
  async search(q: SearchQuery): Promise<SearchResults>;

  /** Row count, optionally filtered. Powers getStats + orphan scans. */
  count(filter?: { source_id?: string; project_id?: string }): number;

  /** Fetch a subset of docs by filter — powers orphan-row scan. */
  list(opts: {
    source_id?: string;
    project_id?: string;
    limit: number;
  }): FlexDoc[];

  /** Read/write meta.json. */
  async readMeta(): Promise<MetaRow | null>;
  async writeMeta(m: MetaRow): Promise<void>;

  /** No-op compaction (kept for facade compatibility). */
  async compact(): Promise<void>;

  /** Flush pending writes and release handles. */
  async close(): Promise<void>;
}
```

Notes:

- `count` / `list` are **synchronous** in FlexSearch. Keep them synchronous here. The current `LanceStore.count` is async; we adapt the two call sites (search-service.ts:167, server.ts orphan scan).
- `deleteWhere` takes a structured object, not raw SQL. The current call is `removeMessagesForSession` → `deleteByFilter("session_id = '<id>' AND source_id = 'messages'")` (search-service.ts:344). Translate to `{ session_id, source_id: "messages" }`.
- `compact` stays to keep `SearchService.compact()` and `/api/search/compact` working without a 404. It no-ops and returns immediately.

**`SearchService` facade stays unchanged** — same method names, same signatures, same legacy-compat overloads. Internal fields drop `_store: LanceStore | null`, `_hybrid: HybridQuery | null`, `embedder: Embedder` and replace them with `_store: FlexSearchStore | null`.

---

## 7. Embedder removal

### 7.1 Delete

- `src/server/search/embedder.ts` — entire file.
- All imports of `NomicEmbedder` / `createFakeEmbedder` (search-service.ts:31, tests — see §13).
- `Embedder` interface in `types.ts` (lines 43–58).
- `SearchServiceOptions.embedder` field.
- `SearchService.sharedModelCacheDir()` static + `BOBBIT_MODEL_CACHE_DIR` / `BOBBIT_FAKE_EMBEDDER` env handling.

### 7.2 Chunker token counter

Chunker no longer takes a `countTokens` callback — move the counter inline. Replace `chunker.ts`'s `ChunkOptions.countTokens` with a module-local helper:

```ts
// src/server/search/chunker.ts
export function approxTokenCount(text: string): number {
  // ~4 chars per token, same rule-of-thumb approxTokenCount() used today
  // whenever the Nomic tokenizer isn't warm. Deterministic, cheap.
  return Math.ceil(text.length / 4);
}
```

`ChunkOptions.countTokens` becomes optional and defaults to `approxTokenCount`. The `Indexer._expandWithChunks` call site drops the `countTokens: (t) => this.embedder.countTokens(t)` line.

> We keep chunking because messages can still be long (> 2 000 "tokens") and FlexSearch prefers bounded documents for ranking quality. The exact token count no longer matters for embedding context windows, only for "don't index one-MB transcripts as a single BM25 document".

### 7.3 Tests migrating off `createFakeEmbedder`

All five call sites use it purely to satisfy the old `Embedder` parameter on `Indexer` / `SearchService` — after the refactor, `Indexer` and `SearchService` no longer take an embedder at all. Tests delete the `embedder:` line. See §13 for the full list.

---

## 8. Meta / schema migration

### 8.1 New `MetaRow`

```ts
// src/server/search/meta.ts
export interface MetaRow {
  engine: "flexsearch";          // NEW — guards against mixing backends
  engineVersion: string;         // e.g. flexsearch package version
  schemaVersion: number;         // bump to 2
  contentPolicyVersion: number;  // unchanged semantics
  createdAt: number;             // last full rebuild, ms
}
```

Drop `embedderId` and `dim`. `needsRebuild()` becomes:

```ts
export function needsRebuild(stored: MetaRow | null, current: MetaRow): boolean {
  if (!stored) return true;
  if (stored.engine !== current.engine) return true;
  if (stored.schemaVersion !== current.schemaVersion) return true;
  if (stored.contentPolicyVersion !== current.contentPolicyVersion) return true;
  return false;
}
```

Bump `SCHEMA_VERSION` in `types.ts` from `1` to `2`.

### 8.2 On open: kill any old state

In `SearchService._doOpen()`:

```ts
const flexDir = path.join(this.stateDir, "search.flex");
const lanceDir = path.join(this.stateDir, "search.lance");

// One-shot migration: if a LanceDB dataset exists, drop it. It's stale by
// definition — the backend has changed.
if (fs.existsSync(lanceDir)) {
  try { await fs.promises.rm(lanceDir, { recursive: true, force: true }); }
  catch (err) { console.warn(`[search] Could not remove legacy search.lance:`, err); }
}

// Also sweep stray legacy-FTS files; keep the existing search.db cleanup.
// (already present in search-service.ts:296)

this._store = await FlexSearchStore.open({ dataDir: flexDir });
const stored = await this._store.readMeta();
const current = buildCurrentMeta({ engine: "flexsearch", engineVersion: FLEX_VERSION });
if (needsRebuild(stored, current)) {
  // schedule background rebuild — same pattern as today (search-service.ts:331)
}
```

Also add removal of the **shared model cache dir** to maintenance cleanup notes (not auto-run — see §10): `~/.bobbit/models/` is now garbage. Don't touch it automatically; add a line to `docs/internals.md` telling users they can `rm -rf ~/.bobbit/models` to reclaim disk.

### 8.3 Corrupt-index handling

If `FlexSearchStore._loadFromDisk` fails for any key, `_loadFromDisk` logs and continues (leaving that key empty). On the next open, meta is considered "present but untrusted" → if `FlexSearchStore` detects a partial load (meta present but `count() === 0`), treat as `needsRebuild = true`. Concretely:

```ts
if (stored && this._store.count() === 0) return true;
```

Added as an additional check in `needsRebuild` call site in `_doOpen`.

---

## 9. Ranking (folds `HybridQuery` into `FlexSearchStore.search`)

Delete `hybrid-query.ts`. Port its public responsibilities — filter construction, per-source weight multiplier, `parent_id` collapse, snippet highlighting — directly into `FlexSearchStore.search`.

### 9.1 Algorithm

Given `q: SearchQuery`:

1. **Empty query short-circuit** — `q.q.trim() === ""` → `{ results: [], total: 0 }`.

2. **Run three field searches in parallel** via the `Document.search` API:
   ```ts
   const merged = this._idx.search(q.q, {
     limit: fetchLimit,                 // = (q.limit ?? 20) * 3
     suggest: true,                     // partial-match tolerant
     enrich: true,                      // return full stored doc with each hit
     index: ["identifier_text", "title", "text"],
     tag: buildTagFilter(q),            // source_id + project_id + archived
   });
   ```

3. **Blend field scores with a per-field boost.** FlexSearch returns grouped results per field with positional rank (not a raw BM25 score). Convert positional rank into a normalised score using `1 / (rank + 1)` and sum across the three fields with field boosts:
   ```
   fieldBoost: identifier_text = 2.0   // exact-identifier matches rank highest
              title           = 1.5
              text            = 1.0
   score(doc) = Σ_field fieldBoost[field] / (rankInField(doc) + 1)
   ```
   This replaces the RRF+cosine fusion. `k=1` numerator is deliberately simpler than RRF's `k=60` — we have three narrow field lists, not two 10 K-result candidate sets.

4. **Apply per-document `weight`** from the content policy (unchanged value range 0.5 – 3.0):
   `finalScore = score(doc) * doc.weight`.

5. **Recency boost** (new — partial replacement for the semantic signal). Older rows decay to 1.0×, very recent rows float up to 1.2× over a 30-day half-life:
   ```
   ageDays = max(0, (now - doc.timestamp) / 86_400_000)
   recencyMul = 1 + 0.2 * exp(-ageDays / 30)
   finalScore *= recencyMul
   ```
   Tunable via constants at the top of `flex-store.ts`. Required because without embeddings we lose the mild "fresh content matters" bias that nomic picks up through user-authored titles mentioning recent features.

6. **Sort** desc by `finalScore`. Ties broken by `timestamp` desc, then `id` asc (deterministic).

7. **Collapse by `parent_id ?? id`** — keep highest-scoring row per parent. Unchanged from `hybrid-query.ts:260`.

8. **Offset + limit window** — `collapsed.slice(offset, offset + limit)`.

9. **Render** each survivor to `SearchResult` via the same helper as today (`toSearchResult` from `hybrid-query.ts`), with `snippet.highlight(text, query)`. Port the helper into `flex-store.ts` (or move to a new `src/server/search/render-result.ts` — the coder's call; `render-result.ts` keeps `flex-store.ts` under ~400 LOC and makes `toSearchResult` independently testable).

### 9.2 Filter construction

Replace `buildFilter` (hybrid-query.ts:144) with a pure function `buildTagFilter(q: SearchQuery)` that returns a FlexSearch `tag` object:

```ts
function buildTagFilter(q: SearchQuery): Array<{ field: string; tag: string | string[] }> {
  const tags: Array<{ field: string; tag: string | string[] }> = [];
  if (q.projectId) tags.push({ field: "project_id", tag: q.projectId });
  if (!q.includeArchived) tags.push({ field: "archived", tag: "false" });  // stored as string
  if (q.types && q.types.length > 0) tags.push({ field: "source_id", tag: q.types });
  return tags;
}
```

Note: FlexSearch tag values are strings. Store `archived` as `"true" | "false"` strings in the tag domain (the stored doc still carries the boolean).

### 9.3 No ANN index, no lazy index creation

Delete `createIndexes()` + the `ROW_COUNT_FOR_INDEX` / `OPPORTUNISTIC_INDEX_RATIO` / `OPPORTUNISTIC_INDEX_COOLDOWN_MS` machinery from `Indexer`. FlexSearch builds its posting lists at upsert time — there is no "lazy index creation" step.

---

## 10. REST endpoints & UI changes

### 10.1 Server (`src/server/server.ts`)

| Endpoint                                       | Action  | Notes                                                                                          |
|------------------------------------------------|---------|------------------------------------------------------------------------------------------------|
| `GET /api/search/stats`                        | Modify  | Drop `embedderId`, `embedderDim`. Add `engine: "flexsearch"`, `engineVersion`. Keep row counts, `lastRebuildAt`, `datasetBytes`. `state` remains (see 10.3). |
| `POST /api/search/rebuild`                     | Keep    | Signature unchanged.                                                                           |
| `POST /api/search/compact`                     | Modify  | No-op (returns `{ok:true}`) — keep the endpoint to avoid breaking existing clients.            |
| `GET /api/maintenance/orphaned-index-rows`     | Modify  | Replace `ctx.searchIndex.getLanceStore()` with `getStore()`; switch the row scan from `store.query().select(...).toArray()` to `store.list({ limit: 100000 })`. |
| `POST /api/maintenance/cleanup-index-rows`     | Modify  | Same adaptation. Replace `store.deleteByIds(...)` — still supported on `FlexSearchStore`.      |

Delete any references to `getLanceStore()` anywhere. Rename the accessor to `getStore()` returning `FlexSearchStore | null`.

### 10.2 Client API wrapper (`src/app/api.ts`)

`SearchStats` interface:

```ts
export interface SearchStats {
  lastRebuildAt: number | null;
  rowCountsBySource: Record<string, number>;
  datasetBytes: number;
  engine: "flexsearch";
  engineVersion: string;
  state: "ready" | "rebuilding" | "disabled" | "error" | "initializing" | "closed";
}
```

Drop `embedderId` and `embedderDim`.

### 10.3 UI (`src/app/settings-page.ts`, `src/app/components/search-status-dot.ts`, `src/app/search-page.ts`, `src/app/sidebar.ts`)

- **settings-page.ts, Search Index panel (lines 2580–2648):**
  - Replace the `Embedder` row with an `Engine` row: `flexsearch (0.8.158)`.
  - Keep `State`, `Last rebuild`, `Dataset size`, the per-source row-count pills.
  - **Remove** the `Compact Dataset` button (no-op under the new engine). Leave the REST endpoint as a no-op for any stragglers, but the UI control is gone.
  - Keep `Refresh`, `Rebuild Index`, and the progress bar (WS events unchanged).
  - Remove any "model download" / "Retry Download" copy. There is none explicitly named today — the search-status-dot Retry button is re-purposed (§10.3 below).

- **search-status-dot.ts (the red-pill `Retry` affordance):** keep it. It now covers *rebuild* retries (since there's no model to download, "unavailable" really only means "rebuild failed" or "engine disabled"). The existing `searchRebuild()` call is correct.

- **State machine:** collapse the SearchService states from five to three:
  - `initializing` — `_doOpen` in flight.
  - `ready` — normal operation.
  - `disabled` — catastrophic failure (e.g. `search.flex` dir unwritable). Replaces both `disabled-no-native` and `disabled-no-model`.
  - `closed` — unchanged.
  - UI code that distinguished the two disabled states (there are two references in server.ts:6420 `reasonMap`) collapses to a single `disabled` reason. Update `reasonMap` accordingly.

- **search-page.ts:** the `<search-status-dot>` usage is unchanged.
- **sidebar.ts:** the `<search-status-dot>` usage is unchanged.

---

## 11. Config cascade

There are no search-specific cascade fields today (no `searchEmbedderId`, no model path config). Nothing to remove. `BOBBIT_MODEL_CACHE_DIR` and `BOBBIT_FAKE_EMBEDDER` env vars are handled purely inside `search-service.ts` and disappear with the embedder.

---

## 12. `IndexSource` preservation

The `IndexSource`, `IndexSourceContext`, `Indexable`, `SearchQuery`, `SearchResult`, and `SearchResults` types in `src/server/search/types.ts` are **unchanged**. The v2 files source (`src/server/search/sources/files-source.stub.ts`) still drops in unchanged. `Indexer.rebuildFromSources` still accepts the same `IndexSource[]`.

The **only** change to `types.ts`:

- Delete the `Embedder` interface (lines 43–58).
- Update the comment on `SCHEMA_VERSION` — "LanceDB content-table Arrow schema" → "FlexSearch document schema / on-disk layout".
- Bump `SCHEMA_VERSION` to `2`.

---

## 13. Test plan

### 13.1 Delete

- `tests/search/embedder.spec.ts` (fake + real Nomic specifics).
- `tests/search/lance-store.spec.ts` (Lance schema / Arrow specifics).
- `tests/search/hybrid-query.spec.ts` (RRF + reranker logic; most assertions replaced by new ranking tests in §13.3).
- `tests/search/opportunistic-index.spec.ts` (opportunistic IVF_PQ rebuild — gone with Lance).
- `tests/e2e/search-migration.spec.ts` — was gating the legacy FTS → LanceDB migration. Replace with a small spec asserting an old `search.lance/` directory is removed on open (§13.4).

### 13.2 Modify

- `tests/search/indexer.spec.ts` — drop `embedder: createFakeEmbedder()` from all `new Indexer(...)` calls; wire `lance` param to `new FlexSearchStore(...)` or its test-only factory. Adjust expectations where calls to `embedder.embed(...)` were asserted (remove those assertions).
- `tests/search/chunker.spec.ts` — drop the `countTokens` argument from all calls (now optional). Keep the chunk-boundary and overlap assertions.
- `tests/search/content-policy.spec.ts` — unchanged; policy module is orthogonal.
- `tests/search/meta-mismatch.spec.ts` — update fields tested (`engine` / `schemaVersion` / `contentPolicyVersion`).
- `tests/search/weight-apply.spec.ts` — rewrite against the new scoring function in §9 (keep the test's *name*, replace the assertions).
- `tests/search/lexical-parity.spec.ts` — rewrite as a FlexSearch-vs-expected-ranking spec on the same fixtures.
- `tests/search/snippet-highlight.spec.ts` — unchanged (renderer is unchanged).
- `tests/search/scale-smoke.spec.ts` — drop Lance-specific timings; confirm FlexSearch scales to 40 K rows with a `< 1 s` open-time assertion.
- `tests/search/search-service-extras.spec.ts` — delete `BOBBIT_MODEL_CACHE_DIR` / `sharedModelCacheDir` tests. Keep dataset-isolation-per-project test (change `search.lance` → `search.flex`).
- `tests/search/index-source-contract.spec.ts` — unchanged.
- `tests/search/files-source-stub.spec.ts` — unchanged.
- `tests/e2e/search-admin-api.spec.ts` — drop embedderId assertions; add `engine === "flexsearch"`.
- `tests/e2e/ui/search-e2e.spec.ts` — drop the "Compact Dataset" button assertion. Leave the rebuild + stats flow assertions.
- `tests/e2e/ui/search-index-ui.spec.ts` — remove the "Embedder" label assertion, add an "Engine" label assertion.
- `tests/search-box.spec.ts`, `tests/search-results.spec.ts`, `tests/search-status-dot.test.ts` — mostly unaffected; confirm status-dot tests still cover the collapsed-state set (`disabled` replaces the two disabled variants).
- `tests/e2e/in-process-harness.ts:90` — drop `process.env.BOBBIT_FAKE_EMBEDDER = "1"` (env var is gone).

### 13.3 Add

- `tests/search/flex-store.spec.ts` — **new**, core coverage:
  - `open() → upsert() → search()` round-trip.
  - `close()` + reopen preserves index (persistence).
  - `deleteByIds` removes rows and their chunks.
  - `deleteWhere({ session_id, source_id: "messages" })` sweeps a session.
  - `clear()` empties the store; subsequent `count() === 0`.
  - BM25 ranking: `searchService` ranked higher than `searchUtils` when query is `SearchService`.
  - Identifier tokenization: `SearchService`, `search_service`, `search-service`, and `search/service` are all retrievable from the same indexed doc.
  - Per-source weight is applied: a goal (`weight=2.5`) outranks a message (`weight=1.0`) when BM25 alone would tie.
  - Recency boost: of two otherwise-identical docs, the newer one wins.
  - `parent_id` collapse: two chunk rows of the same parent collapse to the single highest-scoring hit.
  - Corrupt index file on open → skipped with a log warning; meta mismatch detection kicks in on the subsequent `_doOpen` → rebuild scheduled.
- `tests/search/flex-persistence.spec.ts` — **new**, focused:
  - Atomic write: simulate a crash after `.tmp` is written but before rename → next open ignores the `.tmp` file.
  - Trailing debounce: N rapid upserts result in exactly one flush after 500 ms.
  - Stale export-key files are removed on flush.
- `tests/e2e/search-legacy-lance-removal.spec.ts` — **new**: create a fake `search.lance/` dir before opening `SearchService`; after `whenReady()`, assert the dir is gone.
- `tests/airgap-install.spec.ts` — **new** (can be a shell script under `scripts/`, but wire it as a Playwright test for consistency): run `npm ci --offline --ignore-scripts=false` against the repo's `package-lock.json` with no network and assert success. Gated by an env var (`RUN_AIRGAP=1`) so it only runs on CI runners configured without egress; local runs skip.

### 13.4 Coverage matrix (summary)

| Area                          | Coverage |
|-------------------------------|----------|
| Store upsert/delete/search    | `flex-store.spec.ts`                    |
| Persistence round-trip        | `flex-store.spec.ts` + `flex-persistence.spec.ts` |
| Ranking — BM25, identifiers   | `flex-store.spec.ts`                    |
| Ranking — weight / recency    | `flex-store.spec.ts` + `weight-apply.spec.ts` (rewritten) |
| Snippet highlighting          | `snippet-highlight.spec.ts` (unchanged) |
| Indexer (chunk, dedup, events)| `indexer.spec.ts` (modified)            |
| SearchService state machine   | `search-service-extras.spec.ts` (modified) |
| Meta mismatch + rebuild       | `meta-mismatch.spec.ts` (modified)      |
| Legacy Lance dir removal      | `search-legacy-lance-removal.spec.ts`   |
| Admin REST                    | `search-admin-api.spec.ts` (modified)   |
| UI panel                      | `search-index-ui.spec.ts` + `search-e2e.spec.ts` (modified) |
| Install portability           | `airgap-install.spec.ts` (new)          |

---

## 14. Quality benchmark (non-gating)

A fixed 20-query evaluation harness under `scripts/search-bench.ts` runs both engines against the same fixture corpus and reports `precision@5` per engine.

Shape:

```
scripts/search-bench.ts
  - load fixtures (scripts/bench-fixtures/corpus.json + queries.json)
  - build a FlexSearchStore, index the corpus
  - for each query, capture top 5 hits, mark relevance against the gold set
  - print a markdown table: query | baseline-p@5 | flex-p@5
```

Baseline numbers (Nomic + Lance) come from a one-off `git stash`-style snapshot: run the same script against the pre-change branch, record results in `scripts/bench-fixtures/baseline.json`, commit alongside the script. Future PRs can re-run the script and diff against `baseline.json`.

**Not a blocking gate.** The goal spec explicitly accepts natural-language-quality regressions. The benchmark exists so future work (e.g. a tokenizer tweak) has a signal to optimise against.

---

## 15. Package changes

Exact `package.json` diff:

```diff
   "dependencies": {
-    "@huggingface/transformers": "^4.1.0",
-    "@lancedb/lancedb": "^0.27.2",
     "@lmstudio/sdk": "^1.5.0",
     …
+    "flexsearch": "0.8.158",
     …
   }
```

`sharp` is not a direct dep (it comes in transitively through `@huggingface/transformers` → `onnxruntime-node`); removing the HF package lifts it automatically. Run `npm install` to regenerate `package-lock.json`.

**Lock audit requirement.** After regeneration, run:

```bash
grep -E '"(sharp|onnxruntime-node|@lancedb/lancedb|@huggingface/transformers)"' package-lock.json
```

Expected: zero matches. The CI job added by `tests/airgap-install.spec.ts` (§13.3) turns this into a hard gate.

Also inspect for postinstall scripts that do network work:

```bash
node -e 'const l=require("./package-lock.json");for (const [k,v] of Object.entries(l.packages||{})) { if (v?.scripts?.postinstall || v?.hasInstallScript) console.log(k, v.scripts?.postinstall || "(hasInstallScript)") }'
```

Any surviving install scripts must be benign (no network). Current known benign: none expected after this change.

---

## 16. File-by-file change list

| Action | Path                                                        | Purpose |
|--------|-------------------------------------------------------------|---------|
| Add    | `src/server/search/flex-store.ts`                           | `FlexSearchStore` + ranking (replaces lance-store + hybrid-query) |
| Add    | `src/server/search/render-result.ts` *(optional)*           | Pure `toSearchResult(doc, query, score)` helper, if `flex-store.ts` grows past ~400 LOC |
| Add    | `docs/design/portable-search.md`                            | This document (committed on this branch) |
| Add    | `tests/search/flex-store.spec.ts`                           | Core store behaviour |
| Add    | `tests/search/flex-persistence.spec.ts`                     | Atomic write, debounce, stale-key cleanup |
| Add    | `tests/e2e/search-legacy-lance-removal.spec.ts`             | Asserts `search.lance/` is removed on open |
| Add    | `tests/airgap-install.spec.ts`                              | Offline `npm ci` smoke (opt-in via `RUN_AIRGAP=1`) |
| Add    | `scripts/search-bench.ts` + `scripts/bench-fixtures/*.json` | Precision@5 harness (non-gating) |
| Modify | `src/server/search/types.ts`                                | Delete `Embedder` iface; bump `SCHEMA_VERSION` to 2; update header comment |
| Modify | `src/server/search/meta.ts`                                 | Replace `embedderId`/`dim` with `engine`/`engineVersion`; update `needsRebuild`, `readMeta`, `writeMeta`, `buildCurrentMeta` |
| Modify | `src/server/search/chunker.ts`                              | Make `countTokens` optional, default `approxTokenCount`; export `approxTokenCount` |
| Modify | `src/server/search/indexer.ts`                              | Remove embedder dependency, remove `createIndexes` + opportunistic machinery, remove embedding batch loop; keep chunking + contentHash dedup + progress emission; switch calls to `FlexSearchStore` |
| Modify | `src/server/search/search-service.ts`                       | Swap `LanceStore` + `HybridQuery` + embedder for `FlexSearchStore`; collapse states to `initializing/ready/disabled/closed`; update `getStats`, `getEmbedderInfo` → `getEngineInfo`; drop `BOBBIT_*` env + `sharedModelCacheDir` |
| Modify | `src/server/server.ts`                                      | Endpoint adaptations (§10.1): `search/stats` shape, `search/compact` no-op, orphan-rows scan using `FlexSearchStore.list`, rename `getLanceStore` → `getStore`, update `reasonMap` |
| Modify | `src/app/api.ts`                                            | Drop `embedderId`/`embedderDim`; add `engine`/`engineVersion` in `SearchStats` |
| Modify | `src/app/settings-page.ts`                                  | Replace Embedder row with Engine row; remove Compact Dataset button |
| Modify | `src/app/components/search-status-dot.ts`                   | No structural change; confirm the single `disabled` kind still renders correctly (no code change expected) |
| Modify | `tests/search/indexer.spec.ts`                              | Drop `embedder:` args; adapt to `FlexSearchStore` |
| Modify | `tests/search/chunker.spec.ts`                              | Drop `countTokens` args |
| Modify | `tests/search/meta-mismatch.spec.ts`                        | New meta fields |
| Modify | `tests/search/weight-apply.spec.ts`                         | New scoring function |
| Modify | `tests/search/lexical-parity.spec.ts`                       | FlexSearch ranking fixtures |
| Modify | `tests/search/scale-smoke.spec.ts`                          | FlexSearch-appropriate perf assertions |
| Modify | `tests/search/search-service-extras.spec.ts`                | Drop model-cache-dir tests; update paths to `search.flex` |
| Modify | `tests/e2e/search-admin-api.spec.ts`                        | New stats shape |
| Modify | `tests/e2e/ui/search-e2e.spec.ts`                           | Drop Compact button; re-baseline stats assertions |
| Modify | `tests/e2e/ui/search-index-ui.spec.ts`                      | Engine label |
| Modify | `tests/e2e/in-process-harness.ts`                           | Drop `BOBBIT_FAKE_EMBEDDER` env set |
| Modify | `docs/internals.md` (search section)                        | Point to this doc; note `~/.bobbit/models/` is safe to delete |
| Modify | `package.json`                                              | Remove 2 deps, add `flexsearch` (§15) |
| Delete | `src/server/search/embedder.ts`                             | Nomic + fake embedder |
| Delete | `src/server/search/lance-store.ts`                          | LanceDB wrapper |
| Delete | `src/server/search/hybrid-query.ts`                         | Folded into `flex-store.ts` |
| Delete | `tests/search/embedder.spec.ts`                             | Nomic-specific |
| Delete | `tests/search/lance-store.spec.ts`                          | Lance-specific |
| Delete | `tests/search/hybrid-query.spec.ts`                         | RRF-specific; coverage moves to `flex-store.spec.ts` |
| Delete | `tests/search/opportunistic-index.spec.ts`                  | Lance-ANN-specific |
| Delete | `tests/e2e/search-migration.spec.ts`                        | Replaced by `search-legacy-lance-removal.spec.ts` |
| Keep   | `src/server/search/content-policy.ts`                       | Unchanged |
| Keep   | `src/server/search/snippet.ts`                              | Unchanged |
| Keep   | `src/server/search/progress-bus.ts`                         | Unchanged |
| Keep   | `src/server/search/sources/*.ts`                            | Unchanged — `Indexable` shape preserved |
| Keep   | `docs/design/semantic-search.md`                            | Kept for historical reference; add a banner linking to this doc |

---

## 17. Risks & open questions

- **FlexSearch memory footprint at scale.** The `Document` index holds the whole forward index in memory as plain JS objects. For Bobbit-scale corpora (< 100 K rows) this is a non-issue — O(100 MB) worst case. If a future user has millions of messages, we'll need to shard the index per-project or move to an external store. Document this threshold in `scale-smoke.spec.ts` so regressions are visible.
- **Persistence format stability.** FlexSearch's `export` format is versioned internally but not formally specified across minor releases. **Mitigation:** the `engineVersion` field in `MetaRow` mismatches on any FlexSearch bump → automatic rebuild from `IndexSource`s. Cost: one full rebuild per FlexSearch upgrade. Acceptable given rebuild times measured in seconds, not minutes.
- **Semantic-quality regression vs. embeddings.** Explicitly accepted per goal requirements. Mitigated partially by (a) strict tokenization on the identifier field, (b) forward tokenization for prefix search, (c) the recency boost in §9.
- **Windows rename atomicity on the same volume** is reliable; across volumes it is not. `stateDir` always lives inside the project root, so we're always on the same volume as `.tmp` files. No cross-volume renames.
- **Open question — case sensitivity on the identifier field.** `encoder: "Simple"` lower-cases tokens but otherwise preserves them. For a codebase with `Session` and `session` as distinct concepts this may be surprising. **Resolution for v1:** lowercase-only matching; if feedback shows user pain, switch to a custom encoder that preserves case on ALL_CAPS tokens. Park as a follow-up — not blocking.
- **Open question — should we delete `~/.bobbit/models/` automatically on first boot of the new engine?** Current plan: no, log a one-line hint instead. Users may want to keep the cache around in case they try an older Bobbit. Documented in `docs/internals.md` update.
