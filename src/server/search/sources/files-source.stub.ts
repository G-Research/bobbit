/**
 * `FilesIndexSourceStub` — **test-only** stub that proves the v2 (file
 * indexing) path flows through the same `IndexSource` → `Indexable` →
 * `Indexer` → `LanceStore` pipeline used by v1 sources.
 *
 * This file is NEVER wired into production. Its sole purpose is to satisfy
 * the v2-readiness contract in design §12 / §15-T6: show that adding a
 * new source for files requires zero changes to the core modules.
 *
 * For real file indexing, v2 will ship a proper `FilesIndexSource` with a
 * gitignore-aware walker, size limits, chokidar watching, and the shared
 * chunker. This stub is intentionally minimal.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { IndexSource, IndexSourceContext, Indexable } from "../types.js";
import { contentHashOf } from "./hash.js";

export interface FilesSourceStubOptions {
	/** Absolute path to a fixture directory to walk. */
	fixtureDir: string;
	/** Override the projectId on emitted Indexables (defaults to ctx.projectId). */
	projectId?: string;
	/**
	 * Maximum bytes per file (default 1 MiB). Files above this are skipped
	 * so the stub can't accidentally slurp a binary blob during tests.
	 */
	maxBytes?: number;
}

export class FilesIndexSourceStub implements IndexSource {
	readonly sourceId = "files" as const;

	constructor(private readonly opts: FilesSourceStubOptions) {
		if (!opts.fixtureDir) {
			throw new Error("FilesIndexSourceStub: fixtureDir is required");
		}
	}

	async *iterate(ctx: IndexSourceContext): AsyncIterable<Indexable> {
		const rootAbs = path.resolve(this.opts.fixtureDir);
		const maxBytes = this.opts.maxBytes ?? 1_048_576;
		const projectId = this.opts.projectId ?? ctx.projectId;

		const walk = (dir: string): string[] => {
			const out: string[] = [];
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return out;
			}
			for (const e of entries) {
				const abs = path.join(dir, e.name);
				if (e.isDirectory()) {
					out.push(...walk(abs));
				} else if (e.isFile()) {
					out.push(abs);
				}
			}
			return out;
		};

		const files = walk(rootAbs);
		for (const abs of files) {
			let stat: fs.Stats;
			try {
				stat = fs.statSync(abs);
			} catch {
				continue;
			}
			if (stat.size > maxBytes) continue;
			let text: string;
			try {
				text = fs.readFileSync(abs, "utf-8");
			} catch {
				continue;
			}
			if (!text.trim()) continue;

			const relPath = path.relative(rootAbs, abs).split(path.sep).join("/");
			const lines = text.split(/\r?\n/).length;
			const weight = 1.0;
			// v2 will define a proper Role for files; "profile" is a placeholder
			// that the Indexer accepts today without any type-system changes.
			const role = "profile" as const;
			const timestamp = stat.mtimeMs | 0;

			const indexable: Indexable = {
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
			yield indexable;
		}
	}
}
