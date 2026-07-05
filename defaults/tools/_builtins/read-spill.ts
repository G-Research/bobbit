/**
 * Oversized-read spill-to-disk wrapper for pi's builtin `read` tool (F1(a)).
 *
 * pi's `read` tool caps output at DEFAULT_MAX_LINES (2000) / DEFAULT_MAX_BYTES
 * (50KB) and, on overflow, just tells the model to re-call with a bumped
 * `offset` (node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js).
 * For a genuinely large file this forces N sequential paginated read calls,
 * each of which grows the conversation transcript further (every prior
 * chunk stays resident in context for every subsequent turn) -- much more
 * expensive than a single "here's the shape of the file + where the full
 * thing lives on disk" response.
 *
 * This wrapper is a pure post-processing layer around the vendored
 * `execute()` (no vendor patch): when a DEFAULT (no offset/limit given)
 * read hits pi's own truncation cap, it separately reads the full file
 * itself, spills it to a session-scoped scratch path under
 * `<BOBBIT_DIR>/state/read-spill/<sessionId>/`, and replaces the tool
 * result with a head+tail excerpt (using pi's own `truncateHead`/
 * `truncateTail`, so the excerpt is byte/line-bounded the same way pi's
 * own truncation is) plus a pointer to the spilled path.
 *
 * Guardrails (fail-open to correctness -- any doubt means pi's original
 * unmodified truncated result is returned untouched):
 *  - Threshold-gated: only fires when (a) the caller did NOT pass an
 *    explicit offset/limit (i.e. this is a plain "read this file" call, not
 *    deliberate pagination the caller already opted into) and (b) pi's own
 *    `details.truncation.truncated` is true. Every other read -- including
 *    every read of a file under the cap -- is completely untouched: same
 *    object, same bytes, same shape. This is what keeps "normal reads
 *    byte-identical" per the F1(a) guardrail.
 *  - If we can't resolve the path, can't stat it, can't read the full file,
 *    or can't write the spill file, we fall back to pi's original truncated
 *    result unchanged -- the model still gets a usable (if paginated)
 *    response, it just doesn't get the head+tail+spill upgrade.
 *  - Spill directory resolution mirrors the existing per-subprocess
 *    convention used by defaults/tools/shell/extension.ts and
 *    defaults/tools/_shared/gateway.ts: `BOBBIT_DIR/state/...` when
 *    `BOBBIT_DIR` is set (the normal Bobbit-spawned case, sandboxed or not
 *    -- `.bobbit/state/` is bind-mounted into Docker sandbox sessions too),
 *    else `~/.pi/...` (bare pi, e.g. under test).
 *  - Known accepted gap (documented, not fixed here): spilled files are
 *    named `<basename>.<pathHash>.<mtimeMs>.txt`, so re-spilling the SAME
 *    unchanged file overwrites the same path (no unbounded growth for a
 *    single file), but a session that reads many DISTINCT huge files will
 *    accumulate one spill file per distinct (path, mtime) pair with no
 *    pruning. Left as a follow-up rather than gold-plated here; low risk
 *    since `.bobbit/state/` is already excluded from git and per-session.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";
import { resolveAbsolutePath, type ReadDedupResult, type ReadToolDefinitionLike } from "./read-tool-shared.js";

export interface ReadSpillOptions {
	/** Injectable for tests. Default: process.env.BOBBIT_DIR / process.env.BOBBIT_SESSION_ID. */
	env?: { BOBBIT_DIR?: string; BOBBIT_SESSION_ID?: string };
	/** Injectable for tests. Default: fs.promises.readFile(path, "utf-8"). */
	readFile?: (absolutePath: string) => Promise<string>;
	/** Injectable for tests. Default: fs.promises.stat mapped to {mtimeMs}. */
	stat?: (absolutePath: string) => Promise<{ mtimeMs: number }>;
	/** Injectable for tests. Default: fs.promises.mkdir + fs.promises.writeFile. */
	writeSpillFile?: (spillPath: string, content: string) => Promise<void>;
	/** Head/tail excerpt budget (each half of DEFAULT_MAX_BYTES/LINES by default). */
	excerptMaxBytes?: number;
	excerptMaxLines?: number;
}

function isTruncatedNoRange(result: ReadDedupResult | undefined, offset: number | undefined, limit: number | undefined): boolean {
	if (offset !== undefined || limit !== undefined) return false;
	const truncation = result?.details?.truncation as { truncated?: boolean } | undefined;
	return truncation?.truncated === true;
}

function resolveSpillDir(env: { BOBBIT_DIR?: string; BOBBIT_SESSION_ID?: string }): string {
	const stateDir = env.BOBBIT_DIR ? path.join(env.BOBBIT_DIR, "state") : path.join(os.homedir(), ".pi");
	const sessionId = env.BOBBIT_SESSION_ID ?? "no-session";
	return path.join(stateDir, "read-spill", sessionId);
}

function spillFileName(absolutePath: string, mtimeMs: number): string {
	const hash = crypto.createHash("sha1").update(absolutePath).digest("hex").slice(0, 16);
	const base = path.basename(absolutePath).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60) || "file";
	return `${base}.${hash}.${Math.round(mtimeMs)}.txt`;
}

async function defaultReadFile(absolutePath: string): Promise<string> {
	const buf = await fs.readFile(absolutePath);
	return buf.toString("utf-8");
}

async function defaultStat(absolutePath: string): Promise<{ mtimeMs: number }> {
	const st = await fs.stat(absolutePath);
	return { mtimeMs: st.mtimeMs };
}

async function defaultWriteSpillFile(spillPath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(spillPath), { recursive: true });
	await fs.writeFile(spillPath, content, "utf-8");
}

/**
 * Wrap a read-shaped ToolDefinition so that a plain (no offset/limit) read
 * which overflows pi's built-in truncation cap is spilled to disk and
 * replaced with a head+tail excerpt + pointer, instead of just the head
 * truncation pi's own tool already produces.
 */
export function wrapReadToolWithSpill<TDef extends ReadToolDefinitionLike>(definition: TDef, cwd: string, options: ReadSpillOptions = {}): TDef {
	const env = options.env ?? { BOBBIT_DIR: process.env.BOBBIT_DIR, BOBBIT_SESSION_ID: process.env.BOBBIT_SESSION_ID };
	const readFile = options.readFile ?? defaultReadFile;
	const statFn = options.stat ?? defaultStat;
	const writeSpillFile = options.writeSpillFile ?? defaultWriteSpillFile;
	const excerptMaxBytes = options.excerptMaxBytes ?? Math.floor(DEFAULT_MAX_BYTES / 2);
	const excerptMaxLines = options.excerptMaxLines ?? Math.floor(DEFAULT_MAX_LINES / 2);
	const originalExecute = definition.execute.bind(definition);

	const execute: ReadToolDefinitionLike["execute"] = async (toolCallId, params, signal, onUpdate, ctx) => {
		const result = await originalExecute(toolCallId, params, signal, onUpdate, ctx);

		if (!isTruncatedNoRange(result, params?.offset, params?.limit)) return result;

		const absolutePath = resolveAbsolutePath(params?.path, cwd);
		if (!absolutePath) return result;

		try {
			const [stat, fullContent] = await Promise.all([statFn(absolutePath), readFile(absolutePath)]);
			const spillDir = resolveSpillDir(env);
			const spillPath = path.join(spillDir, spillFileName(absolutePath, stat.mtimeMs));
			await writeSpillFile(spillPath, fullContent);

			const head = truncateHead(fullContent, { maxBytes: excerptMaxBytes, maxLines: excerptMaxLines });
			const tail = truncateTail(fullContent, { maxBytes: excerptMaxBytes, maxLines: excerptMaxLines });
			const totalLines = head.totalLines;
			const totalBytes = head.totalBytes;

			const text =
				`[File exceeds the inline read limit (${formatSize(DEFAULT_MAX_BYTES)} / ${DEFAULT_MAX_LINES} lines): ` +
				`${totalLines} lines, ${formatSize(totalBytes)} total. Full content spilled to disk -- see path below.]\n\n` +
				`--- head (first ${head.outputLines} lines) ---\n${head.content}\n\n` +
				`--- tail (last ${tail.outputLines} lines) ---\n${tail.content}\n\n` +
				`[Full content available at: ${spillPath}]\n` +
				`[Use bash (cat/sed/grep) on that path to inspect the rest instead of paginating with offset/limit.]`;

			return {
				content: [{ type: "text", text }],
				details: {
					...(result.details ?? {}),
					spilled: { path: spillPath, totalLines, totalBytes },
				},
			};
		} catch {
			// Any failure (resolve/stat/read/write) -- fall back to pi's own
			// truncated result unchanged. The model still gets a usable response.
			return result;
		}
	};

	return { ...definition, execute };
}
