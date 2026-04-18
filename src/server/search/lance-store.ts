/**
 * `LanceStore` — thin wrapper around `@lancedb/lancedb` that owns dataset
 * lifecycle, the content-table Arrow schema, lazy index creation, compaction,
 * and the `search_meta` singleton row.
 *
 * This module is the only part of the search subsystem that touches the
 * LanceDB native binary. Higher-level modules (indexer, hybrid-query,
 * search-service) should talk to `LanceStore` and never import LanceDB
 * directly.
 *
 * See docs/design/semantic-search.md §3 (schema), §9 (meta row),
 * §10 (migration) and §13 (index parameters).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	Schema,
	Field,
	Utf8,
	Int32,
	Int64,
	Float32,
	Bool,
	FixedSizeList,
} from "apache-arrow";
import * as lancedb from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import {
	type MetaRow,
	readMeta as readMetaRow,
	writeMeta as writeMetaRow,
	type MetaRowPersisted,
} from "./meta.js";

// ── Constants ────────────────────────────────────────────────────────

export const EMBED_DIM = 768;

const CONTENT_TABLE = "content";
const META_TABLE = "search_meta";

const ROW_COUNT_FOR_INDEX = 10_000;

// ── Schemas ──────────────────────────────────────────────────────────

/**
 * Authoritative Arrow schema for the `content` table.
 *
 * This is the literal schema from design §3 — nullability and field order
 * are significant. All file-specific fields (file_path / start_line /
 * end_line) are nullable so the v2 files source drops in without a schema
 * migration.
 */
export function buildContentSchema(embedDim: number = EMBED_DIM): Schema {
	return new Schema([
		new Field("id", new Utf8(), false),
		new Field("source_id", new Utf8(), false),
		new Field("project_id", new Utf8(), false),
		new Field("entity_type", new Utf8(), false),
		new Field("parent_id", new Utf8(), true),
		new Field("archived", new Bool(), false),
		new Field("timestamp", new Int64(), false),
		new Field("content_hash", new Utf8(), false),
		new Field("weight", new Float32(), false),
		new Field("role", new Utf8(), true),
		new Field("title", new Utf8(), true),
		new Field("text", new Utf8(), false),
		new Field("goal_id", new Utf8(), true),
		new Field("session_id", new Utf8(), true),
		new Field("session_title", new Utf8(), true),
		new Field("file_path", new Utf8(), true),
		new Field("start_line", new Int32(), true),
		new Field("end_line", new Int32(), true),
		new Field(
			"embedding",
			new FixedSizeList(embedDim, new Field("item", new Float32(), false)),
			false,
		),
	]);
}

export const contentSchema = buildContentSchema(EMBED_DIM);

function buildMetaSchema(): Schema {
	return new Schema([
		new Field("embedder_id", new Utf8(), false),
		new Field("dim", new Int32(), false),
		new Field("schema_version", new Int32(), false),
		new Field("content_policy_version", new Int32(), false),
		new Field("created_at", new Int64(), false),
	]);
}

// ── Row shape ────────────────────────────────────────────────────────

/**
 * TypeScript mirror of the Arrow `content` schema. Field order and
 * nullability match §3 literally. Consumers build rows of this shape and
 * pass them to `upsert`.
 */
export interface ContentRow {
	id: string;
	source_id: string;
	project_id: string;
	entity_type: string;
	parent_id: string | null;
	archived: boolean;
	timestamp: number;
	content_hash: string;
	weight: number;
	role: string | null;
	title: string | null;
	text: string;
	goal_id: string | null;
	session_id: string | null;
	session_title: string | null;
	file_path: string | null;
	start_line: number | null;
	end_line: number | null;
	/** Must have length `embedDim`. Accepts plain array or Float32Array. */
	embedding: number[] | Float32Array;
}

// ── LanceStore ───────────────────────────────────────────────────────

export interface LanceStoreOpenOptions {
	/** Directory holding the LanceDB dataset (e.g. `.bobbit/state/search.lance`). */
	dataDir: string;
	/** Embedding dimension. Must match the active embedder. */
	embedDim: number;
}

/**
 * Lance-backed content + meta store.
 *
 * Design invariants:
 * - One dataset per project.
 * - `content` table has a fixed schema (§3). A corrupt dataset is renamed
 *   aside (§10) and recreated empty.
 * - `search_meta` is a single-row table. Writing replaces the row
 *   atomically.
 * - Indexes (IVF_PQ vector + FTS) are created lazily — only called when the
 *   caller asserts rowCount > 10_000.
 */
export class LanceStore {
	readonly dataDir: string;
	readonly embedDim: number;
	private readonly _schema: Schema;
	private readonly _metaSchema: Schema;
	private _conn: Connection;
	private _content!: Table;
	private _closed = false;

	private constructor(
		dataDir: string,
		embedDim: number,
		conn: Connection,
	) {
		this.dataDir = dataDir;
		this.embedDim = embedDim;
		this._schema = buildContentSchema(embedDim);
		this._metaSchema = buildMetaSchema();
		this._conn = conn;
	}

	/**
	 * Open or create the dataset at `opts.dataDir`.
	 *
	 * - If the directory does not exist, it is created and a fresh `content`
	 *   + `search_meta` pair is initialised.
	 * - If the dataset exists and opens cleanly, both tables are reused
	 *   (missing tables are created empty).
	 * - If the dataset fails to open (corruption), the directory is renamed
	 *   to `<dataDir>.corrupt-<ts>` and a fresh dataset is created in its
	 *   place. Per design §10.
	 */
	static async open(opts: LanceStoreOpenOptions): Promise<LanceStore> {
		if (!Number.isInteger(opts.embedDim) || opts.embedDim <= 0) {
			throw new Error(`LanceStore.open: invalid embedDim ${opts.embedDim}`);
		}
		await fs.promises.mkdir(path.dirname(opts.dataDir), { recursive: true });

		const tryOpen = async (): Promise<LanceStore> => {
			const conn = await lancedb.connect(opts.dataDir);
			// Touch the connection to surface corruption early.
			await conn.tableNames();
			const store = new LanceStore(opts.dataDir, opts.embedDim, conn);
			await store._ensureTables();
			return store;
		};

		try {
			return await tryOpen();
		} catch (err) {
			// Corrupt dataset — rename aside and recreate. Per design §10.
			const ts = Date.now();
			const corruptPath = `${opts.dataDir}.corrupt-${ts}`;
			try {
				if (fs.existsSync(opts.dataDir)) {
					await fs.promises.rename(opts.dataDir, corruptPath);
				}
			} catch (renameErr) {
				throw new Error(
					`LanceStore.open: dataset at ${opts.dataDir} failed to open (${(err as Error).message}) and could not be renamed (${(renameErr as Error).message})`,
				);
			}
			return await tryOpen();
		}
	}

	private async _ensureTables(): Promise<void> {
		const names = new Set(await this._conn.tableNames());
		if (names.has(CONTENT_TABLE)) {
			this._content = await this._conn.openTable(CONTENT_TABLE);
		} else {
			this._content = await this._conn.createEmptyTable(
				CONTENT_TABLE,
				this._schema,
				{ mode: "create", existOk: true },
			);
		}
		if (!names.has(META_TABLE)) {
			await this._conn.createEmptyTable(META_TABLE, this._metaSchema, {
				mode: "create",
				existOk: true,
			});
		}
	}

	/** Release references; no-op if already closed. LanceDB manages its own handles. */
	async close(): Promise<void> {
		this._closed = true;
	}

	private _checkOpen(): void {
		if (this._closed) throw new Error("LanceStore: already closed");
	}

	// ── Upsert ───────────────────────────────────────────────────────

	/**
	 * Idempotent upsert keyed by primary key `id`. Rows with matching
	 * `id` are replaced; new rows are inserted.
	 */
	async upsert(rows: ContentRow[]): Promise<void> {
		this._checkOpen();
		if (rows.length === 0) return;
		const records = rows.map((r) => this._rowToRecord(r));
		await this._content
			.mergeInsert("id")
			.whenMatchedUpdateAll()
			.whenNotMatchedInsertAll()
			.execute(records);
	}

	private _rowToRecord(r: ContentRow): Record<string, unknown> {
		const emb = r.embedding instanceof Float32Array ? Array.from(r.embedding) : r.embedding;
		if (!Array.isArray(emb) || emb.length !== this.embedDim) {
			throw new Error(
				`LanceStore.upsert: row ${r.id} embedding has length ${emb?.length}, expected ${this.embedDim}`,
			);
		}
		return {
			id: r.id,
			source_id: r.source_id,
			project_id: r.project_id,
			entity_type: r.entity_type,
			parent_id: r.parent_id,
			archived: r.archived,
			timestamp: BigInt(r.timestamp),
			content_hash: r.content_hash,
			weight: r.weight,
			role: r.role,
			title: r.title,
			text: r.text,
			goal_id: r.goal_id,
			session_id: r.session_id,
			session_title: r.session_title,
			file_path: r.file_path,
			start_line: r.start_line,
			end_line: r.end_line,
			embedding: emb,
		};
	}

	// ── Delete ───────────────────────────────────────────────────────

	async deleteByIds(ids: string[]): Promise<void> {
		this._checkOpen();
		if (ids.length === 0) return;
		const list = ids.map((id) => `'${escapeSql(id)}'`).join(",");
		await this._content.delete(`id IN (${list})`);
	}

	async deleteByFilter(sql: string): Promise<void> {
		this._checkOpen();
		await this._content.delete(sql);
	}

	// ── Query ────────────────────────────────────────────────────────

	async count(filter?: string): Promise<number> {
		this._checkOpen();
		return this._content.countRows(filter);
	}

	/**
	 * Thin pass-through to the native Lance query builder. Callers chain
	 * `.fullTextSearch(...)`, `.nearestTo(...)`, `.where(...)`, `.rerank(...)`,
	 * `.limit(...)`, `.toArray()` as documented in the LanceDB API.
	 */
	query(): ReturnType<Table["query"]> {
		this._checkOpen();
		return this._content.query();
	}

	// ── Index + compaction ───────────────────────────────────────────

	/**
	 * Create the vector + FTS indexes. IVF_PQ parameters follow §13:
	 *   numPartitions = min(256, ceil(sqrt(rowCount)))
	 *   numSubVectors = 96
	 * FTS is built on `title` + `text` with positions enabled so phrase
	 * queries work.
	 *
	 * Caller is responsible for gating this on `rowCount > 10_000`; we emit
	 * a console warning (but still run) if called below that threshold, to
	 * make accidental misuse visible in logs without breaking tests that
	 * exercise the path on small fixtures.
	 */
	async createIndexes(): Promise<void> {
		this._checkOpen();
		const rowCount = await this._content.countRows();
		if (rowCount <= ROW_COUNT_FOR_INDEX) {
			// eslint-disable-next-line no-console
			console.warn(
				`[search] LanceStore.createIndexes called at ${rowCount} rows — below ${ROW_COUNT_FOR_INDEX}-row threshold; brute-force scan is expected to be faster. Proceeding anyway.`,
			);
		}
		const numPartitions = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(Math.max(1, rowCount)))));

		await this._content.createIndex("embedding", {
			config: lancedb.Index.ivfPq({ numPartitions, numSubVectors: 96 }),
		});
		await this._content.createIndex("text", {
			config: lancedb.Index.fts({ withPosition: true }),
		});
		await this._content.createIndex("title", {
			config: lancedb.Index.fts({ withPosition: true }),
		});
	}

	/** Compact and prune old versions. Safe to run periodically in the background. */
	async compact(): Promise<void> {
		this._checkOpen();
		await this._content.optimize();
	}

	// ── Meta ─────────────────────────────────────────────────────────

	async readMeta(): Promise<MetaRow | null> {
		this._checkOpen();
		const meta = await this._conn.openTable(META_TABLE);
		const rows = (await meta.query().limit(1).toArray()) as unknown as Array<Record<string, unknown>>;
		if (rows.length === 0) return null;
		return readMetaRow(normaliseMetaRow(rows[0]));
	}

	async writeMeta(meta: MetaRow): Promise<void> {
		this._checkOpen();
		const table = await this._conn.openTable(META_TABLE);
		// Single-row semantics: truncate then insert.
		await table.delete("true");
		const persisted = writeMetaRow(meta);
		await table.add([
			{
				embedder_id: persisted.embedder_id,
				dim: persisted.dim,
				schema_version: persisted.schema_version,
				content_policy_version: persisted.content_policy_version,
				created_at: BigInt(persisted.created_at),
			},
		]);
	}
}

// ── Helpers ─────────────────────────────────────────────────────────

function escapeSql(s: string): string {
	return s.replace(/'/g, "''");
}

/**
 * Lance returns `created_at` as a `bigint` (Int64). `readMeta` expects plain
 * `number`, so coerce back where safe.
 */
function normaliseMetaRow(row: Record<string, unknown>): MetaRowPersisted {
	const createdAt = row.created_at;
	return {
		embedder_id: row.embedder_id as string,
		dim: coerceNumber(row.dim),
		schema_version: coerceNumber(row.schema_version),
		content_policy_version: coerceNumber(row.content_policy_version),
		created_at: coerceNumber(createdAt),
	};
}

function coerceNumber(v: unknown): number {
	if (typeof v === "number") return v;
	if (typeof v === "bigint") return Number(v);
	return Number(v);
}
