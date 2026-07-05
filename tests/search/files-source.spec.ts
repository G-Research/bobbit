/**
 * `FilesIndexSource` — real (non-stub) implementation tests.
 *
 * Covers the three PIN requirements for NAV-doc-knowledge-retrieval:
 *   - indexing scope (docs/**, root AGENTS.md/CLAUDE.md, .md/.mdx only)
 *   - exclusions (.gitignore, hard-excluded dirs, byte cap, empty files)
 *   - query (flows through the real indexableToDoc → FlexSearchStore path
 *     and returns a bounded snippet, never the whole file)
 *
 * See docs reference: src/server/search/sources/files-source.ts,
 * docs/design/portable-search.md §12/§17.
 */

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FilesIndexSource } from "../../src/server/search/sources/files-source.ts";
import { FlexSearchStore } from "../../src/server/search/flex-store.ts";
import { indexableToDoc } from "../../src/server/search/indexer.ts";
import type { IndexSourceContext, Indexable } from "../../src/server/search/types.ts";
import type { GoalStore } from "../../src/server/agent/goal-store.ts";
import type { SessionStore } from "../../src/server/agent/session-store.ts";
import type { StaffStore } from "../../src/server/agent/staff-store.ts";

function fakeCtx(projectId: string): IndexSourceContext {
	return {
		projectId,
		goalStore: { getAll: () => [] } as unknown as GoalStore,
		sessionStore: { getAll: () => [] } as unknown as SessionStore,
		staffStore: { getAll: () => [] } as unknown as StaffStore,
	};
}

async function collect(src: FilesIndexSource, ctx: IndexSourceContext): Promise<Indexable[]> {
	const out: Indexable[] = [];
	for await (const i of src.iterate(ctx)) out.push(i);
	return out;
}

function makeProjectRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "files-source-proj-"));
}

function filePaths(entries: Indexable[]): string[] {
	return entries.map((e) => e.display?.filePath ?? "").sort();
}

// ── Indexing scope ─────────────────────────────────────────────────────

test.describe("FilesIndexSource — indexing scope", () => {
	test("indexes docs/**/*.md (nested) and root AGENTS.md/CLAUDE.md", async () => {
		const root = makeProjectRoot();
		fs.mkdirSync(path.join(root, "docs", "design"), { recursive: true });
		fs.writeFileSync(path.join(root, "docs", "internals.md"), "# Internals\n\nSearch subsystem details.\n");
		fs.writeFileSync(path.join(root, "docs", "design", "gate-step-cache.md"), "# Gate Step Cache\n\nDetails.\n");
		fs.writeFileSync(path.join(root, "AGENTS.md"), "# Agents\n\nBefore editing anything non-trivial: rg.\n");
		fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Claude\n\nProject instructions.\n");
		fs.writeFileSync(path.join(root, "README.md"), "# Not indexed\n\nRoot README is out of scope.\n");

		const out = await collect(new FilesIndexSource({ projectRoot: root }), fakeCtx("proj-a"));
		expect(filePaths(out)).toEqual([
			"AGENTS.md",
			"CLAUDE.md",
			"docs/design/gate-step-cache.md",
			"docs/internals.md",
		]);
		for (const i of out) {
			expect(i.sourceId).toBe("files");
			expect(i.id).toBe(`file:${i.display?.filePath}`);
			expect(i.projectId).toBe("proj-a");
			expect(i.weight).toBeGreaterThanOrEqual(0.5);
			expect(i.weight).toBeLessThanOrEqual(3.0);
			expect(i.display?.startLine).toBe(1);
			expect(typeof i.display?.endLine).toBe("number");
		}
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("skips non-markdown files and empty files under docs/", async () => {
		const root = makeProjectRoot();
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		fs.writeFileSync(path.join(root, "docs", "notes.md"), "# Notes\n\nSomething.\n");
		fs.writeFileSync(path.join(root, "docs", "diagram.json"), "{}");
		fs.writeFileSync(path.join(root, "docs", "diagram.html"), "<html></html>");
		fs.writeFileSync(path.join(root, "docs", "empty.md"), "");
		fs.writeFileSync(path.join(root, "docs", "whitespace-only.md"), "   \n\t\n");

		const out = await collect(new FilesIndexSource({ projectRoot: root }), fakeCtx("proj-b"));
		expect(filePaths(out)).toEqual(["docs/notes.md"]);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("no docs/ directory and no root doc files yields nothing (not an error)", async () => {
		const root = makeProjectRoot();
		const out = await collect(new FilesIndexSource({ projectRoot: root }), fakeCtx("proj-empty"));
		expect(out).toEqual([]);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("contentHash is stable across repeated iterate() calls with unchanged content", async () => {
		const root = makeProjectRoot();
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		fs.writeFileSync(path.join(root, "docs", "stable.md"), "# Stable\n\nUnchanged content.\n");

		const src = new FilesIndexSource({ projectRoot: root });
		const a = await collect(src, fakeCtx("proj-c"));
		const b = await collect(src, fakeCtx("proj-c"));
		expect(a.map((i) => i.contentHash)).toEqual(b.map((i) => i.contentHash));
		fs.rmSync(root, { recursive: true, force: true });
	});
});

// ── Exclusions ───────────────────────────────────────────────────────────

test.describe("FilesIndexSource — exclusions", () => {
	test("respects the project's root .gitignore", async () => {
		const root = makeProjectRoot();
		fs.mkdirSync(path.join(root, "docs", "internal"), { recursive: true });
		fs.writeFileSync(path.join(root, "docs", "public.md"), "# Public\n\nVisible.\n");
		fs.writeFileSync(path.join(root, "docs", "internal", "secret.md"), "# Secret\n\nHidden by gitignore.\n");
		fs.writeFileSync(path.join(root, ".gitignore"), "docs/internal/\n");

		const out = await collect(new FilesIndexSource({ projectRoot: root }), fakeCtx("proj-d"));
		expect(filePaths(out)).toEqual(["docs/public.md"]);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("a gitignored root doc file (AGENTS.md) is excluded too", async () => {
		const root = makeProjectRoot();
		fs.writeFileSync(path.join(root, "AGENTS.md"), "# Agents\n\nShould be excluded here.\n");
		fs.writeFileSync(path.join(root, ".gitignore"), "AGENTS.md\n");

		const out = await collect(new FilesIndexSource({ projectRoot: root }), fakeCtx("proj-d2"));
		expect(filePaths(out)).toEqual([]);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("never indexes node_modules/dist/.git/.bobbit even without a .gitignore rule", async () => {
		const root = makeProjectRoot();
		fs.mkdirSync(path.join(root, "docs", "node_modules", "pkg"), { recursive: true });
		fs.mkdirSync(path.join(root, "docs", "dist"), { recursive: true });
		fs.mkdirSync(path.join(root, "docs", ".git"), { recursive: true });
		fs.mkdirSync(path.join(root, "docs", ".bobbit", "state"), { recursive: true });
		fs.writeFileSync(path.join(root, "docs", "node_modules", "pkg", "readme.md"), "# Nope\n\nVendored.\n");
		fs.writeFileSync(path.join(root, "docs", "dist", "built.md"), "# Nope\n\nBuild output.\n");
		fs.writeFileSync(path.join(root, "docs", ".git", "leak.md"), "# Nope\n\nVCS internals.\n");
		fs.writeFileSync(path.join(root, "docs", ".bobbit", "state", "leak.md"), "# Nope\n\nRuntime state.\n");
		fs.writeFileSync(path.join(root, "docs", "kept.md"), "# Kept\n\nReal doc.\n");

		const out = await collect(new FilesIndexSource({ projectRoot: root }), fakeCtx("proj-e"));
		expect(filePaths(out)).toEqual(["docs/kept.md"]);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("skips files above the byte cap", async () => {
		const root = makeProjectRoot();
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		fs.writeFileSync(path.join(root, "docs", "huge.md"), "x".repeat(200));
		fs.writeFileSync(path.join(root, "docs", "small.md"), "# Small\n\nFits.\n");

		const out = await collect(new FilesIndexSource({ projectRoot: root, maxBytes: 100 }), fakeCtx("proj-f"));
		expect(filePaths(out)).toEqual(["docs/small.md"]);
		fs.rmSync(root, { recursive: true, force: true });
	});
});

// ── Query end-to-end ───────────────────────────────────────────────────

test.describe("FilesIndexSource — query end-to-end", () => {
	test("flows through the real indexableToDoc → FlexSearchStore path and returns a bounded snippet", async () => {
		const root = makeProjectRoot();
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		const fullText = "# Search subsystem\n\nQuackerFileToken lives in the FlexSearch document index.\n".repeat(1);
		fs.writeFileSync(path.join(root, "docs", "search-subsystem.md"), fullText);

		const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "files-source-store-"));
		const store = await FlexSearchStore.open({ dataDir: path.join(storeDir, "search.flex") });
		try {
			const src = new FilesIndexSource({ projectRoot: root });
			const entries = await collect(src, fakeCtx("proj-query"));
			expect(entries.length).toBe(1);
			await store.upsert(entries.map((e) => indexableToDoc(e, e.text, null)));

			expect(store.count({ source_id: "files" })).toBe(1);

			const results = await store.search({ q: "QuackerFileToken", types: ["files"] });
			expect(results.results.length).toBe(1);
			const hit = results.results[0];
			expect(hit.type).toBe("file");
			expect(hit.filePath).toBe("docs/search-subsystem.md");
			expect(hit.startLine).toBe(1);
			expect(hit.matchedOn).toBe("text");
			// Never the whole file: the raw stored doc text is not what the tool/UI sees.
			expect(hit.snippet).not.toBe(fullText);
			expect(typeof hit.snippet).toBe("string");
			expect(hit.snippet.toLowerCase()).toContain("quackerfiletoken");
		} finally {
			await store.close();
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(storeDir, { recursive: true, force: true });
		}
	});

	test("a query for a term not present in any doc returns no file hits", async () => {
		const root = makeProjectRoot();
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		fs.writeFileSync(path.join(root, "docs", "unrelated.md"), "# Unrelated\n\nNothing to see here.\n");

		const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "files-source-store-miss-"));
		const store = await FlexSearchStore.open({ dataDir: path.join(storeDir, "search.flex") });
		try {
			const entries = await collect(new FilesIndexSource({ projectRoot: root }), fakeCtx("proj-miss"));
			await store.upsert(entries.map((e) => indexableToDoc(e, e.text, null)));

			const results = await store.search({ q: "ZzzNoSuchTokenAnywhere", types: ["files"] });
			expect(results.results.length).toBe(0);
		} finally {
			await store.close();
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(storeDir, { recursive: true, force: true });
		}
	});
});
