import { describe, expect, it } from "vitest";
import {
	buildStatusTreeModel,
	classifyFileBytes,
	ExplorerParseError,
	ExplorerPathError,
	joinRelativePath,
	mergeCopyProvenance,
	normalizeRelativePath,
	parsePorcelainStatus,
	parseStagedNameStatus,
	SEARCH_CONCURRENCY_LIMIT,
	SEARCH_DEPTH_LIMIT,
	SEARCH_DIRECTORY_LIMIT,
	SEARCH_ENTRY_LIMIT,
	SEARCH_QUERY_LIMIT,
	SEARCH_RESULT_LIMIT,
	SEARCH_TIMEOUT_MS,
	sortExplorerEntries,
	sortExplorerPaths,
	stableLowercase,
	synthesizeAddedDiff,
	type ExplorerEntry,
} from "../../../market-packs/file-explorer/src/explorer-model.ts";

describe("file explorer relative path protocol", () => {
	it("accepts only canonical relative paths and an explicitly allowed root", () => {
		expect(normalizeRelativePath("", { allowRoot: true })).toBe("");
		expect(normalizeRelativePath("src/nested/file.ts")).toBe("src/nested/file.ts");
		expect(joinRelativePath("src/nested", "file.ts")).toBe("src/nested/file.ts");
		expect(joinRelativePath("", ".env")).toBe(".env");

		for (const candidate of [
			undefined,
			null,
			42,
			"",
			"/etc/passwd",
			"C:/Windows/system.ini",
			"c:\\Windows\\system.ini",
			"\\\\server\\share",
			"../secret",
			"src/../secret",
			"src/./file",
			"src//file",
			"src\\file",
			"src/\0file",
		]) {
			expect(() => normalizeRelativePath(candidate), String(candidate)).toThrow(ExplorerPathError);
		}
	});
});

describe("file explorer entry ordering", () => {
	it("exports the product search bounds and locale-independent full-path helpers", () => {
		expect({
			results: SEARCH_RESULT_LIMIT,
			entries: SEARCH_ENTRY_LIMIT,
			directories: SEARCH_DIRECTORY_LIMIT,
			concurrency: SEARCH_CONCURRENCY_LIMIT,
			depth: SEARCH_DEPTH_LIMIT,
			timeout: SEARCH_TIMEOUT_MS,
			query: SEARCH_QUERY_LIMIT,
		}).toEqual({ results: 200, entries: 20_000, directories: 5_000, concurrency: 4, depth: 100, timeout: 3_000, query: 256 });
		expect(stableLowercase("Web/INDEX.ts")).toBe("web/index.ts");
		const paths: ExplorerEntry[] = [
			{ path: "web/index.ts", name: "index.ts", kind: "file" },
			{ path: "api/index.ts", name: "index.ts", kind: "file" },
			{ path: "API/Index.ts", name: "Index.ts", kind: "file" },
		];
		expect(sortExplorerPaths(paths).map((entry) => entry.path)).toEqual(["API/Index.ts", "api/index.ts", "web/index.ts"]);
	});

	it("sorts directories first, then names case-insensitively with deterministic ties", () => {
		const entries: ExplorerEntry[] = [
			{ path: "zeta.txt", name: "zeta.txt", kind: "file" },
			{ path: "alpha-file", name: "Alpha", kind: "file" },
			{ path: "beta", name: "beta", kind: "directory" },
			{ path: ".config", name: ".config", kind: "directory" },
			{ path: "alpha-upper", name: "Alpha", kind: "directory" },
			{ path: "alpha-lower", name: "alpha", kind: "directory" },
			{ path: "link", name: "link", kind: "symlink" },
		];

		expect(sortExplorerEntries(entries).map((entry) => entry.path)).toEqual([
			".config",
			"alpha-upper",
			"alpha-lower",
			"beta",
			"alpha-file",
			"link",
			"zeta.txt",
		]);
		expect(entries[0]?.path).toBe("zeta.txt");
	});
});

describe("file explorer Git status model", () => {
	it("parses staged, unstaged, mixed, rename, deletion, conflict and untracked porcelain records", () => {
		const raw = [
			"M  staged.ts",
			" M unstaged.ts",
			"MM both.ts",
			"AM added-modified.ts",
			"A  added.ts",
			" D deleted.ts",
			"R  renamed.ts",
			"old-name.ts",
			"?? untracked.txt",
			"UU conflicted.txt",
			" T type-changed",
			"",
		].join("\0");
		const statuses = parsePorcelainStatus(raw);
		const byPath = new Map(statuses.map((status) => [status.path, status]));

		expect(byPath.get("staged.ts")).toMatchObject({ index: "M", worktree: " ", staged: true, unstaged: false, summary: "modified" });
		expect(byPath.get("unstaged.ts")).toMatchObject({ index: " ", worktree: "M", staged: false, unstaged: true, summary: "modified" });
		expect(byPath.get("both.ts")).toMatchObject({ staged: true, unstaged: true, modified: true });
		expect(byPath.get("added-modified.ts")).toMatchObject({ added: true, modified: true, staged: true, unstaged: true, summary: "added" });
		expect(byPath.get("added.ts")).toMatchObject({ added: true, summary: "added" });
		expect(byPath.get("deleted.ts")).toMatchObject({ deleted: true, unstaged: true, summary: "deleted" });
		expect(byPath.get("renamed.ts")).toMatchObject({ renamed: true, oldPath: "old-name.ts", summary: "renamed" });
		expect(byPath.get("untracked.txt")).toMatchObject({ untracked: true, added: true, staged: false, unstaged: false, summary: "untracked" });
		expect(byPath.get("conflicted.txt")).toMatchObject({ conflict: true, summary: "conflict" });
		expect(byPath.get("type-changed")).toMatchObject({ modified: true, summary: "modified" });
	});

	it("strips only the verified nested repository prefix and bounds record parsing", () => {
		const statuses = parsePorcelainStatus(" M packages/app/a.ts\0 M packages/other/b.ts\0", "packages/app/");
		expect(statuses.map((status) => status.path)).toEqual(["a.ts"]);
		expect(() => parsePorcelainStatus(" M a.ts\0 M b.ts\0", "", 1)).toThrow(/too many records/i);
		expect(() => parsePorcelainStatus("malformed\0")).toThrow(ExplorerParseError);
		expect(() => parsePorcelainStatus("R  destination.ts\0")).toThrow(/incomplete rename or copy/i);
	});

	it("parses retained-source copy metadata and augments only compatible index-added destinations", () => {
		const porcelain = parsePorcelainStatus([
			"AM copied.ts",
			"A  incompatible-delete.ts",
			"?? untracked.ts",
			"R  renamed.ts",
			"rename-source.ts",
			"UU conflicted.ts",
			"M  modified.ts",
			"",
		].join("\0"));
		const staged = parseStagedNameStatus([
			"C100", "source.ts", "copied.ts",
			"C095", "source.ts", "incompatible-delete.ts",
			"C090", "source.ts", "untracked.ts",
			"C085", "source.ts", "renamed.ts",
			"C080", "source.ts", "conflicted.ts",
			"C075", "source.ts", "modified.ts",
			"",
		].join("\0"));
		const merged = new Map(mergeCopyProvenance(porcelain, staged).map((status) => [status.path, status]));

		expect(merged.get("copied.ts")).toMatchObject({
			index: "A",
			worktree: "M",
			staged: true,
			unstaged: true,
			modified: true,
			copied: true,
			oldPath: "source.ts",
			summary: "copied",
		});
		expect(merged.get("untracked.ts")).toMatchObject({ copied: false, summary: "untracked" });
		expect(merged.get("untracked.ts")).not.toHaveProperty("oldPath");
		expect(merged.get("renamed.ts")).toMatchObject({ copied: false, oldPath: "rename-source.ts", summary: "renamed" });
		expect(merged.get("conflicted.ts")).toMatchObject({ copied: false, summary: "conflict" });
		expect(merged.get("conflicted.ts")).not.toHaveProperty("oldPath");
		expect(merged.get("modified.ts")).toMatchObject({ copied: false, summary: "modified" });
		expect(merged.get("modified.ts")).not.toHaveProperty("oldPath");
	});

	it("rejects malformed copy augmentation and excludes records outside a nested explorer root", () => {
		expect(parseStagedNameStatus("C100\0packages/app/source.ts\0packages/app/dest.ts\0", "packages/app/")).toEqual([
			{ code: "C", score: 100, oldPath: "source.ts", path: "dest.ts" },
		]);
		expect(parseStagedNameStatus("C100\0packages/other/source.ts\0packages/other/dest.ts\0", "packages/app/")).toEqual([]);
		for (const malformed of [
			"C101\0source\0dest\0",
			"C\0source\0dest\0",
			"M100\0file\0",
			"C100\0source\0",
			"wat\0file\0",
		]) {
			expect(() => parseStagedNameStatus(malformed), malformed).toThrow(ExplorerParseError);
		}
		expect(() => parseStagedNameStatus("M\0a\0M\0b\0", "", 1)).toThrow(/too many records/i);
	});

	it("propagates ancestor indicators and creates missing directory/file nodes only for deletions", () => {
		const statuses = parsePorcelainStatus(" D src/deep/deleted.ts\0 M src/live.ts\0R  moved.ts\0src/old.ts\0");
		const tree = buildStatusTreeModel(statuses);

		expect(tree.ancestors).toEqual(["src", "src/deep"]);
		expect(new Set(tree.virtualEntries.map((entry) => `${entry.path}:${entry.kind}:${String(entry.virtual)}`))).toEqual(new Set([
			"src:directory:true",
			"src/deep:directory:true",
			"src/deep/deleted.ts:file:true",
		]));
		expect(tree.virtualEntries.find((entry) => entry.path === "src/deep/deleted.ts")?.status)
			.toMatchObject({ path: "src/deep/deleted.ts", summary: "deleted" });
	});
});

describe("file explorer file and untracked diff classification", () => {
	it("classifies empty, UTF-8 text, NUL/fatal UTF-8 binary, and oversized bytes", () => {
		expect(classifyFileBytes(new Uint8Array())).toEqual({ kind: "empty", text: "", bytes: 0 });
		expect(classifyFileBytes(Buffer.from("hello\n"))).toEqual({ kind: "text", text: "hello\n", bytes: 6 });
		expect(classifyFileBytes(Uint8Array.from([65, 0, 66]))).toEqual({ kind: "binary", bytes: 3 });
		expect(classifyFileBytes(Uint8Array.from([0xc3, 0x28]))).toEqual({ kind: "binary", bytes: 2 });
		expect(classifyFileBytes(Buffer.from("abcd"), 8, 4)).toEqual({ kind: "too-large", bytes: 8, limit: 4 });
	});

	it("synthesizes complete standard added-file diffs, including empty and no-final-newline files", () => {
		expect(synthesizeAddedDiff("new.txt", "one\ntwo\n")).toBe(
			"diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n",
		);
		expect(synthesizeAddedDiff("empty.txt", "")).toBe(
			"diff --git a/empty.txt b/empty.txt\nnew file mode 100644\n--- /dev/null\n+++ b/empty.txt\n",
		);
		expect(synthesizeAddedDiff("space name.txt", "last line")).toContain(
			"@@ -0,0 +1,1 @@\n+last line\n\\ No newline at end of file\n",
		);
		expect(synthesizeAddedDiff("space name.txt", "last line")).toContain("diff --git \"a/space name.txt\" \"b/space name.txt\"");
	});
});
