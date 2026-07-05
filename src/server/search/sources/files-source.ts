/**
 * `FilesIndexSource` — indexes the repo's static operational-knowledge docs
 * (`docs/**`, root `AGENTS.md`, root `CLAUDE.md`) into the FlexSearch
 * `files` source, so design constraints, debugging walkthroughs, and
 * pinning-test rationale become discoverable through the same
 * BM25/`search` surface as goals/sessions/messages/staff — not just via
 * ripgrep.
 *
 * Scope is intentionally narrow: markdown documentation, not source code.
 * A repo-wide code index/repo-map is a distinct, larger feature (see
 * `docs/design/portable-search.md` §17 and the NAV-doc-knowledge-retrieval /
 * F18 findings). This closes the doc-retrieval gap only.
 *
 * Exclusions (defense in depth even though the walk roots below never touch
 * these directories):
 *   - Anything matched by the project's root `.gitignore`.
 *   - `node_modules/`, `dist/`, `.git/`, `.bobbit/` unconditionally, whether
 *     or not `.gitignore` mentions them.
 *
 * Refresh policy matches the other sources: this source is drained during a
 * full rebuild (`Indexer.rebuildFromSources`, run at startup on a meta
 * mismatch and on-demand via `POST /api/search/rebuild`). There is no
 * per-file watcher yet — unlike goal/session/message mutations, which have a
 * natural store-mutation hook to piggyback on, doc edits happen outside any
 * Bobbit-owned store. A `chokidar` watcher is a natural follow-up (see the
 * v2 file-indexing note in `docs/design/portable-search.md`), not required
 * for this pass.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import ignoreFactory from "ignore";
import type { IndexSource, IndexSourceContext, Indexable } from "../types.js";
import { contentHashOf } from "./hash.js";

/** The `ignore` package exports a factory (`export =`); derive its instance type from it. */
type Ignore = ReturnType<typeof ignoreFactory>;

/** Directories that are never indexed, regardless of .gitignore contents. */
const HARD_EXCLUDED_DIRS = new Set(["node_modules", "dist", ".git", ".bobbit"]);

/** File extensions treated as indexable documentation. */
const DOC_EXTENSIONS = new Set([".md", ".mdx"]);

/** Root-level files (besides `docs/**`) that count as operational knowledge. */
const ROOT_DOC_FILES = ["AGENTS.md", "CLAUDE.md"];

export interface FilesIndexSourceOptions {
	/** Absolute path to the project root to walk for documentation. */
	projectRoot: string;
	/** Override the projectId on emitted Indexables (defaults to ctx.projectId). */
	projectId?: string;
	/**
	 * Maximum bytes per file (default 1 MiB). Files above this are skipped —
	 * documentation should never be this large, so this is a safety valve,
	 * not a real limit in practice.
	 */
	maxBytes?: number;
}

export class FilesIndexSource implements IndexSource {
	readonly sourceId = "files" as const;

	constructor(private readonly opts: FilesIndexSourceOptions) {
		if (!opts.projectRoot) {
			throw new Error("FilesIndexSource: projectRoot is required");
		}
	}

	async *iterate(ctx: IndexSourceContext): AsyncIterable<Indexable> {
		const root = path.resolve(this.opts.projectRoot);
		const maxBytes = this.opts.maxBytes ?? 1_048_576;
		const projectId = this.opts.projectId ?? ctx.projectId;
		const ig = loadGitignore(root);

		for (const relPath of collectDocPaths(root, ig)) {
			const abs = path.join(root, relPath);
			const indexable = readDocIndexable(abs, relPath, projectId, maxBytes);
			if (indexable) yield indexable;
		}
	}
}

// ── Internals ────────────────────────────────────────────────────────

function loadGitignore(root: string): Ignore {
	const ig = ignoreFactory();
	ig.add([...HARD_EXCLUDED_DIRS].map((d) => `${d}/`));
	try {
		const raw = fs.readFileSync(path.join(root, ".gitignore"), "utf-8");
		ig.add(raw);
	} catch {
		// No root .gitignore — hard exclusions above still apply.
	}
	return ig;
}

/** Relative (POSIX-style) doc paths under `docs/` plus root doc files, gitignore-filtered. */
function collectDocPaths(root: string, ig: Ignore): string[] {
	const out: string[] = [];

	for (const name of ROOT_DOC_FILES) {
		const abs = path.join(root, name);
		if (!existsFile(abs)) continue;
		if (ig.ignores(name)) continue;
		out.push(name);
	}

	const docsRoot = path.join(root, "docs");
	if (existsDir(docsRoot)) {
		walk(docsRoot, root, ig, out);
	}

	return out;
}

function walk(dir: string, root: string, ig: Ignore, out: string[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const abs = path.join(dir, entry.name);
		const relPath = path.relative(root, abs).split(path.sep).join("/");
		if (entry.isDirectory()) {
			if (HARD_EXCLUDED_DIRS.has(entry.name)) continue;
			if (ig.ignores(`${relPath}/`)) continue;
			walk(abs, root, ig, out);
		} else if (entry.isFile()) {
			const ext = path.extname(entry.name).toLowerCase();
			if (!DOC_EXTENSIONS.has(ext)) continue;
			if (ig.ignores(relPath)) continue;
			out.push(relPath);
		}
	}
}

function readDocIndexable(
	abs: string,
	relPath: string,
	projectId: string,
	maxBytes: number,
): Indexable | null {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(abs);
	} catch {
		return null;
	}
	if (stat.size > maxBytes) return null;

	let text: string;
	try {
		text = fs.readFileSync(abs, "utf-8");
	} catch {
		return null;
	}
	if (!text.trim()) return null;

	const lines = text.split(/\r?\n/).length;
	const weight = 1.5;
	const role = "profile" as const;
	const timestamp = Math.floor(stat.mtimeMs);

	return {
		id: `file:${relPath}`,
		sourceId: "files",
		text,
		metadata: {
			filePath: relPath,
			startLine: 1,
			endLine: lines,
			bytes: stat.size,
		},
		contentHash: contentHashOf(text, weight, role, timestamp),
		timestamp,
		projectId,
		archived: false,
		weight,
		role,
		display: {
			title: relPath,
			filePath: relPath,
			startLine: 1,
			endLine: lines,
		},
	};
}

function existsFile(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

function existsDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}
