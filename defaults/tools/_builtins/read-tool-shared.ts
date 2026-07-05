/**
 * Shared duck-typed shapes + path resolution used by both read-tool wrappers
 * (read-dedup.ts for F24, read-spill.ts for F1(a)).
 *
 * Deliberately decoupled from pi-coding-agent's exact generic `ToolDefinition`/
 * `AgentToolResult` types so these wrappers keep working across small pi
 * version bumps without depending on those type imports.
 */
import os from "node:os";
import path from "node:path";

export interface ReadDedupContent {
	type: string;
	[key: string]: unknown;
}

export interface ReadDedupResult {
	content: ReadDedupContent[];
	details?: Record<string, unknown>;
	terminate?: boolean;
}

export interface ReadDedupParams {
	path: string;
	offset?: number;
	limit?: number;
}

export type ReadDedupUpdateCallback = (partial: ReadDedupResult) => void;

export interface ReadToolDefinitionLike {
	execute(
		toolCallId: string,
		params: ReadDedupParams,
		signal: AbortSignal | undefined,
		onUpdate: ReadDedupUpdateCallback | undefined,
		ctx: unknown,
	): Promise<ReadDedupResult>;
	[key: string]: unknown;
}

/**
 * Conservative subset of pi's own path resolution (path-utils.ts is not part
 * of pi's public API surface). Handles absolute paths, cwd-relative paths,
 * and `~`/`~/...`. Returns undefined for anything else (e.g. empty path) so
 * the caller falls back to treating the read as unresolvable and skips any
 * wrapper-specific behavior -- the real tool always runs regardless.
 */
export function resolveAbsolutePath(rawPath: unknown, cwd: string): string | undefined {
	if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;
	let p = rawPath;
	if (p === "~") {
		p = os.homedir();
	} else if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) {
		p = path.join(os.homedir(), p.slice(2));
	}
	try {
		return path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
	} catch {
		return undefined;
	}
}

export function isTextOnlyResult(result: ReadDedupResult | undefined): boolean {
	if (!result || !Array.isArray(result.content) || result.content.length === 0) return false;
	return result.content.every((c) => c && c.type === "text");
}
