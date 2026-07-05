/**
 * Repeat-read dedup wrapper for pi's builtin `read` tool (F24).
 *
 * pi's `read` tool (node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js)
 * has no path+mtime dedup cache: every re-read of an unchanged file re-sends its
 * full (truncated) content into the transcript, even when nothing changed since
 * the agent last read it. This wrapper sits in front of the vendored `execute()`
 * and, on an EXACT repeat of a previous (path, offset, limit) query against a
 * file whose mtime+size have not changed, returns a short stub instead of the
 * full bytes.
 *
 * Guardrails (fail-open to correctness -- any doubt means a full read):
 *  - Cache key includes offset/limit verbatim, so a read covering a DIFFERENT
 *    range than a prior read is never stubbed, even for the same path.
 *  - Only text-only results (no image content) are ever cached/stubbed.
 *  - Path resolution (read-tool-shared.ts) is a conservative subset of pi's
 *    own resolver (path-utils.ts, not part of pi's public API surface) --
 *    absolute paths, cwd-relative paths, and `~/...`. Anything exotic
 *    (unicode-space variants, macOS NFD/curly-quote screenshot names,
 *    `@`-prefixed paths) simply fails to resolve here, so the read always
 *    falls through to the real tool unstubbed.
 *  - Any stat failure (file deleted, permission error, race) falls through
 *    to the real tool so the genuine error surfaces normally.
 *  - The cache lives in the closure created by `wrapReadToolWithDedup` --
 *    since Bobbit spawns one pi subprocess per agent session (see
 *    src/server/agent/session-runtime.ts), this is inherently per-session.
 *    It is also bounded (`maxEntries`, default 500) with FIFO eviction so a
 *    long session cannot grow it unboundedly.
 */
import { stat as fsStat } from "node:fs/promises";
import {
	isTextOnlyResult,
	resolveAbsolutePath,
	type ReadToolDefinitionLike,
} from "./read-tool-shared.js";

// Re-exported for backwards-compat: earlier revisions of this wrapper defined
// these types locally; other modules/tests import them from here.
export type { ReadDedupContent, ReadDedupParams, ReadDedupResult, ReadDedupUpdateCallback, ReadToolDefinitionLike } from "./read-tool-shared.js";

interface StatResult {
	mtimeMs: number;
	size: number;
}

interface CacheEntry extends StatResult {
	readAtIso: string;
	details?: Record<string, unknown>;
}

export interface ReadDedupOptions {
	/** Max distinct (path, offset, limit) entries retained. FIFO eviction beyond this. Default 500. */
	maxEntries?: number;
	/** Injectable for tests. Default: fs.promises.stat mapped to {mtimeMs, size}. */
	stat?: (absolutePath: string) => Promise<StatResult>;
	/** Injectable clock for tests. Default: () => new Date(). */
	now?: () => Date;
}

const DEFAULT_MAX_CACHE_ENTRIES = 500;

async function defaultStat(absolutePath: string): Promise<StatResult> {
	const st = await fsStat(absolutePath);
	return { mtimeMs: st.mtimeMs, size: st.size };
}

function cacheKey(absolutePath: string, offset: number | undefined, limit: number | undefined): string {
	return `${absolutePath} ${offset ?? ""} ${limit ?? ""}`;
}

function formatStubText(rawPath: string, readAtIso: string, stat: StatResult): string {
	return (
		`[unchanged since your last read at ${readAtIso}] ${rawPath} has not changed ` +
		`(size ${stat.size}B, same mtime) since then -- content omitted to save tokens. ` +
		`Re-read only if you have reason to believe it changed outside this session.`
	);
}

/**
 * Wrap a read-shaped ToolDefinition with the dedup cache described above.
 * Preserves every other property of `definition` (name, label, description,
 * parameters, renderCall, renderResult, ...) untouched -- only `execute` is
 * replaced.
 */
export function wrapReadToolWithDedup<TDef extends ReadToolDefinitionLike>(
	definition: TDef,
	cwd: string,
	options: ReadDedupOptions = {},
): TDef {
	const maxEntries = options.maxEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
	const statFn = options.stat ?? defaultStat;
	const now = options.now ?? (() => new Date());
	const cache = new Map<string, CacheEntry>();
	const originalExecute = definition.execute.bind(definition);

	function remember(key: string, entry: CacheEntry): void {
		// Re-insert to refresh recency ordering (Map iteration order == insertion order).
		cache.delete(key);
		cache.set(key, entry);
		while (cache.size > maxEntries) {
			const oldestKey = cache.keys().next().value;
			if (oldestKey === undefined) break;
			cache.delete(oldestKey);
		}
	}

	const execute: ReadToolDefinitionLike["execute"] = async (toolCallId, params, signal, onUpdate, ctx) => {
		const absolutePath = resolveAbsolutePath(params?.path, cwd);
		const offset = params?.offset;
		const limit = params?.limit;

		if (absolutePath) {
			const key = cacheKey(absolutePath, offset, limit);
			const cached = cache.get(key);
			if (cached) {
				try {
					const current = await statFn(absolutePath);
					if (current.mtimeMs === cached.mtimeMs && current.size === cached.size) {
						return {
							content: [{ type: "text", text: formatStubText(params.path, cached.readAtIso, current) }],
							details: cached.details,
						};
					}
					// mtime/size changed -- fall through to a full read below, which
					// will refresh (overwrite) this cache entry with current stats.
				} catch {
					// stat failed (deleted/permission/race) -- fail open, let the real
					// tool surface whatever error it hits.
				}
			}
		}

		const result = await originalExecute(toolCallId, params, signal, onUpdate, ctx);

		if (absolutePath && isTextOnlyResult(result)) {
			try {
				const current = await statFn(absolutePath);
				remember(cacheKey(absolutePath, offset, limit), {
					mtimeMs: current.mtimeMs,
					size: current.size,
					readAtIso: now().toISOString(),
					details: result.details,
				});
			} catch {
				// Can't stat post-read -- just don't cache this one; correctness of
				// the returned result is unaffected.
			}
		}

		return result;
	};

	return { ...definition, execute };
}
