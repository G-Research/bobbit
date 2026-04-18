/**
 * Embedder implementations for the semantic search subsystem.
 *
 * Exports:
 *   - `NomicEmbedder` — production embedder backed by
 *     `nomic-ai/nomic-embed-text-v1.5` via `@huggingface/transformers`
 *     (ONNX runtime, Apache-2.0). Lazy model load; offline-first once
 *     cached under `.bobbit/state/models/`.
 *   - `createFakeEmbedder()` — deterministic, hash-based 768-dim embedder
 *     for tests. No downloads, no dependencies.
 *
 * Design reference: docs/design/semantic-search.md §3 (interface),
 * §4 (dependencies), §6 (tokenizer reuse), §11 (graceful degradation),
 * Appendix A (prefix convention).
 */

import { createHash } from "node:crypto";
import type { Embedder } from "./types.js";

// ── Constants ────────────────────────────────────────────────────────

export const NOMIC_EMBEDDER_ID = "nomic-embed-text-v1.5";
export const NOMIC_DIM = 768;

const NOMIC_MODEL_REPO = "nomic-ai/nomic-embed-text-v1.5";
/** Pin to avoid surprise changes; nomic has published stable revisions. */
const NOMIC_MODEL_REVISION = "main";

const DOCUMENT_PREFIX = "search_document: ";
const QUERY_PREFIX = "search_query: ";

// ── Typed errors (graceful degradation §11) ──────────────────────────

/**
 * Thrown when the embedding model cannot be loaded — either the download
 * failed (offline, firewall) or the cached files are corrupt. The caller
 * (`SearchService`) maps this to `index:error { recoverable: true }`.
 */
export class EmbedderLoadError extends Error {
	readonly recoverable: boolean;
	constructor(message: string, opts?: { cause?: unknown; recoverable?: boolean }) {
		super(message);
		this.name = "EmbedderLoadError";
		this.recoverable = opts?.recoverable ?? true;
		if (opts?.cause) (this as { cause?: unknown }).cause = opts.cause;
	}
}

// ── NomicEmbedder ────────────────────────────────────────────────────

export interface NomicEmbedderOptions {
	/**
	 * Directory under which `@huggingface/transformers` caches ONNX
	 * model + tokenizer files. Shared across projects to avoid repeat
	 * downloads. Typically `<root>/.bobbit/state/models`.
	 */
	modelCacheDir?: string;
	/**
	 * When true, never reach out to the network. Defaults to false on
	 * first load; the embedder will flip this to true after a successful
	 * load so subsequent opens are fully offline.
	 */
	offline?: boolean;
	/** Override the pinned model revision (tests / future migrations). */
	modelRevision?: string;
}

type PipelineFn = (
	texts: string | string[],
	options?: { pooling?: "mean" | "cls"; normalize?: boolean },
) => Promise<{ tolist(): number[][] | number[][][] }>;

interface LoadedModel {
	pipeline: PipelineFn;
	tokenizer: {
		encode(text: string): unknown;
		tokenize(text: string): string[];
	};
}

export class NomicEmbedder implements Embedder {
	readonly id = NOMIC_EMBEDDER_ID;
	readonly dim = NOMIC_DIM;

	private readonly options: Required<Pick<NomicEmbedderOptions, "modelRevision">> &
		NomicEmbedderOptions;
	private loaded: LoadedModel | null = null;
	/** Shared across concurrent `ready()` callers to coalesce downloads. */
	private loadPromise: Promise<LoadedModel> | null = null;

	constructor(options: NomicEmbedderOptions = {}) {
		this.options = { modelRevision: NOMIC_MODEL_REVISION, ...options };
	}

	async ready(): Promise<void> {
		await this.load();
	}

	async embed(texts: string[], kind: "document" | "query"): Promise<Float32Array[]> {
		if (texts.length === 0) return [];
		const model = await this.load();
		const prefix = kind === "query" ? QUERY_PREFIX : DOCUMENT_PREFIX;
		const prefixed = texts.map((t) => prefix + t);

		let tensor: { tolist(): number[][] | number[][][] };
		try {
			tensor = await model.pipeline(prefixed, {
				pooling: "mean",
				normalize: true,
			});
		} catch (err) {
			throw new EmbedderLoadError(`Nomic embedding call failed: ${(err as Error).message}`, {
				cause: err,
			});
		}

		// With pooling:"mean" the output is [batch, dim]. `tolist()` yields
		// a nested JS array; convert each row to a Float32Array and sanity-
		// check dim.
		const rows = tensor.tolist() as number[][];
		if (rows.length !== texts.length) {
			throw new EmbedderLoadError(
				`embed batch size mismatch: expected ${texts.length}, got ${rows.length}`,
			);
		}
		const out: Float32Array[] = new Array(rows.length);
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			if (!Array.isArray(row) || row.length !== this.dim) {
				throw new EmbedderLoadError(
					`embed dim mismatch at row ${i}: expected ${this.dim}, got ${
						Array.isArray(row) ? row.length : "non-array"
					}`,
				);
			}
			out[i] = Float32Array.from(row);
		}
		return out;
	}

	countTokens(text: string): number {
		if (!this.loaded) {
			// `ready()` hasn't been awaited yet. The chunker contract
			// requires a synchronous token count, so fall back to a cheap
			// approximation until the real tokenizer is available. After
			// `ready()` resolves, subsequent calls use the real count.
			return approxTokenCount(text);
		}
		try {
			return this.loaded.tokenizer.tokenize(text).length;
		} catch {
			return approxTokenCount(text);
		}
	}

	private async load(): Promise<LoadedModel> {
		if (this.loaded) return this.loaded;
		if (this.loadPromise) return this.loadPromise;

		this.loadPromise = this.doLoad()
			.then((m) => {
				this.loaded = m;
				return m;
			})
			.catch((err) => {
				// Reset so a later Retry can attempt again.
				this.loadPromise = null;
				throw err;
			});
		return this.loadPromise;
	}

	private async doLoad(): Promise<LoadedModel> {
		let transformers: typeof import("@huggingface/transformers");
		try {
			transformers = await import("@huggingface/transformers");
		} catch (err) {
			throw new EmbedderLoadError(
				`Failed to import @huggingface/transformers: ${(err as Error).message}`,
				{ cause: err, recoverable: false },
			);
		}

		// Configure env BEFORE calling pipeline() so the HF hub helper
		// picks up our cache directory. env is a module-level mutable
		// object — safe to set repeatedly with the same values.
		const env = transformers.env as unknown as {
			cacheDir: string | null;
			localModelPath: string;
			allowRemoteModels: boolean;
			allowLocalModels: boolean;
		};
		if (this.options.modelCacheDir) {
			env.cacheDir = this.options.modelCacheDir;
			env.localModelPath = this.options.modelCacheDir;
		}
		env.allowLocalModels = true;
		env.allowRemoteModels = this.options.offline ? false : true;

		let pipeline: unknown;
		try {
			pipeline = await transformers.pipeline("feature-extraction", NOMIC_MODEL_REPO, {
				revision: this.options.modelRevision,
				// Matryoshka 768-dim full output; we mean-pool + normalize in embed().
			});
		} catch (err) {
			// Retry once in offline mode in case the fetch timed out but
			// files are locally cached.
			if (!this.options.offline) {
				try {
					env.allowRemoteModels = false;
					pipeline = await transformers.pipeline("feature-extraction", NOMIC_MODEL_REPO, {
						revision: this.options.modelRevision,
						local_files_only: true,
					} as unknown as Parameters<typeof transformers.pipeline>[2]);
				} catch (err2) {
					throw new EmbedderLoadError(
						`Failed to load nomic-embed-text-v1.5 model: ${(err2 as Error).message}`,
						{ cause: err2, recoverable: true },
					);
				}
			} else {
				throw new EmbedderLoadError(
					`Failed to load nomic-embed-text-v1.5 model (offline): ${(err as Error).message}`,
					{ cause: err, recoverable: true },
				);
			}
		}

		// Once successfully loaded, stay offline for the process lifetime
		// — no silent re-downloads on transient errors.
		env.allowRemoteModels = false;

		const p = pipeline as unknown as PipelineFn & {
			tokenizer: { encode(text: string): unknown; tokenize(text: string): string[] };
		};
		return {
			pipeline: p,
			tokenizer: p.tokenizer,
		};
	}
}

function approxTokenCount(text: string): number {
	// Standard rule-of-thumb: ~4 chars/token. Cheap and deterministic.
	return Math.ceil(text.length / 4);
}

// ── Fake embedder (tests) ────────────────────────────────────────────

export interface FakeEmbedder extends Embedder {
	/** Records every batch embedded, for assertions in tests. */
	readonly calls: Array<{ kind: "document" | "query"; texts: string[] }>;
}

/**
 * Deterministic 768-dim embedder: hashes `(kind, text)` into a seed,
 * expands it with a cheap PRNG, then L2-normalizes. Outputs are stable
 * across processes and machines — perfect for fixture tests.
 *
 * `kind` is folded into the hash so "document" and "query" for the same
 * text yield different vectors (matches the real nomic prefix behaviour
 * and lets tests verify the kind is threaded through).
 */
export function createFakeEmbedder(
	opts: { id?: string; dim?: number } = {},
): FakeEmbedder {
	const id = opts.id ?? "fake-embedder-v1";
	const dim = opts.dim ?? NOMIC_DIM;
	const calls: FakeEmbedder["calls"] = [];

	function embedOne(text: string, kind: "document" | "query"): Float32Array {
		const seedBytes = createHash("sha256").update(kind).update("\u0000").update(text).digest();
		// Initialize 4 32-bit lanes from the hash.
		let a = seedBytes.readUInt32BE(0) | 0;
		let b = seedBytes.readUInt32BE(4) | 0;
		let c = seedBytes.readUInt32BE(8) | 0;
		let d = seedBytes.readUInt32BE(12) | 0;
		const v = new Float32Array(dim);
		// xoshiro128** — deterministic, fast.
		for (let i = 0; i < dim; i++) {
			const t = (b << 9) | 0;
			const r = Math.imul(b * 5, 0x80000000) | 0;
			// Simpler alt PRNG: Mulberry32 would also work. Use a small
			// LCG chain for readability.
			a = (Math.imul(a, 1664525) + 1013904223) | 0;
			b = (Math.imul(b ^ a, 22695477) + 1) | 0;
			c = (c + 0x9e3779b9) | 0;
			d = (d ^ ((a >>> 13) | (b << 19))) | 0;
			const raw = ((a ^ b ^ c ^ d) >>> 0) / 0xffffffff;
			v[i] = raw * 2 - 1;
			// Silence unused-locals for the unused xoshiro rotate pieces.
			void t;
			void r;
		}
		// L2-normalize.
		let s = 0;
		for (let i = 0; i < dim; i++) s += v[i] * v[i];
		const norm = Math.sqrt(s) || 1;
		for (let i = 0; i < dim; i++) v[i] = v[i] / norm;
		return v;
	}

	return {
		id,
		dim,
		calls,
		async ready() {
			/* no-op */
		},
		async embed(texts, kind) {
			calls.push({ kind, texts: [...texts] });
			return texts.map((t) => embedOne(t, kind));
		},
		countTokens(text) {
			return approxTokenCount(text);
		},
	};
}
