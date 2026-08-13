import { afterEach, describe, expect, it, vi } from "vitest";
import createFileExplorerPanel, { mapRouteFailure } from "../../market-packs/file-explorer/src/file-explorer-panel.js";

type Entry = { path: string; name: string; kind: "directory" | "file" | "symlink" | "other" };
type Status = Record<string, unknown> & { path: string };
type RouteHandler = (body: Record<string, unknown>) => unknown | Promise<unknown>;

const mounted: HTMLElement[] = [];
let mountAttempt = 0;
const tick = async (ms = 0) => {
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
	await Promise.resolve();
};

function host(routes: Record<string, RouteHandler>, options: {
	stored?: unknown;
	onStatus?: (cb: (value: { status: "idle" | "running" | "error" }) => void) => void;
	put?: ReturnType<typeof vi.fn>;
	statusDispose?: ReturnType<typeof vi.fn>;
} = {}) {
	return {
		capabilities: { callRoute: true, session: true, store: true },
		callRoute: vi.fn(async (name: string, init?: { body?: unknown }) => {
			const handler = routes[name];
			if (!handler) throw new Error(`Unexpected route: ${name}`);
			return { ok: true, value: await handler((init?.body ?? {}) as Record<string, unknown>) };
		}),
		session: {
			subscribe: vi.fn((_event: "status", cb: (value: { status: "idle" | "running" | "error" }) => void) => {
				options.onStatus?.(cb);
				return options.statusDispose ?? vi.fn();
			}),
		},
		store: {
			read: vi.fn(async () => options.stored === undefined ? { state: "absent" as const } : { state: "present" as const, value: options.stored }),
			put: options.put ?? vi.fn(async () => undefined),
		},
	};
}

function mount(sid: string, fakeHost: ReturnType<typeof host>): HTMLElement {
	const root = createFileExplorerPanel().render({ __sessionId: sid }, fakeHost as Parameters<ReturnType<typeof createFileExplorerPanel>["render"]>[1]) as HTMLElement;
	document.body.append(root);
	mounted.push(root);
	return root;
}

const row = (root: HTMLElement, path: string) => root.querySelector<HTMLElement>(`[role="treeitem"][data-path="${path}"]`)!;
const click = (element: Element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const key = (element: Element, value: string) => element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
const list = (entries: Entry[], statuses: Status[] = [], truncated = false) => ({ rootPath: "C:\\Users\\tester\\worktrees\\bobbit", entries, truncated, git: { kind: "repository", entries: statuses } });

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

afterEach(async () => {
	for (const root of mounted.splice(0)) root.remove();
	await tick();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("built-in file explorer panel", () => {
	it("renders an accessible lazy tree, status decorations, and a line-numbered read-only preview", async () => {
		const routes = {
			list: ({ path }: Record<string, unknown>) => path === "src"
				? list([{ path: "src/app.ts", name: "app.ts", kind: "file" }])
				: list([
					{ path: "src", name: "src", kind: "directory" },
					{ path: "README.md", name: "README.md", kind: "file" },
				], [
					{ path: "src/app.ts", oldPath: "src/base.ts", copied: true, index: "A", worktree: "M" },
				]),
			read: () => ({ kind: "text", text: "const answer = 42;\nexport { answer };", language: "typescript" }),
			diff: () => ({ kind: "empty" }),
		};
		const fakeHost = host(routes);
		const root = mount("accessible-tree", fakeHost);

		expect(root.querySelector('[role="tree"]')?.getAttribute("aria-busy")).toBe("true");
		await tick();
		const tree = root.querySelector('[role="tree"]')!;
		expect(tree.getAttribute("aria-label")).toBe("Files");
		expect(tree.getAttribute("aria-busy")).toBe("false");
		const rootPath = root.querySelector('[aria-label="Current absolute path"]');
		expect(rootPath?.textContent).toBe("C:/Users/tester/worktrees/bobbit");
		expect(rootPath?.getAttribute("title")).toBe("C:/Users/tester/worktrees/bobbit");
		expect(root.textContent).not.toContain("Explorer");
		expect(row(root, "src").getAttribute("aria-expanded")).toBe("false");
		expect(row(root, "src").getAttribute("aria-level")).toBe("1");
		expect(row(root, "src").querySelector('[aria-label="Contains changes"]')).toBeNull();
		expect(row(root, "src").classList.contains("git-modified")).toBe(false);
		expect(row(root, "src").querySelector(".bb-explorer-name")?.getAttribute("style")).toBeNull();
		expect(row(root, "src").querySelector(".bb-explorer-icon")?.classList.contains("kind-directory")).toBe(true);
		expect(row(root, "src").querySelector(".bb-explorer-icon svg")?.getAttribute("stroke")).toBe("var(--warning)");
		expect(row(root, "README.md").classList.contains("git-modified")).toBe(false);
		expect(root.querySelectorAll('[role="treeitem"][tabindex="0"]')).toHaveLength(1);

		click(row(root, "src"));
		await tick();
		expect(row(root, "src").getAttribute("aria-expanded")).toBe("true");
		expect(root.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("src contents");
		expect(row(root, "src/app.ts").getAttribute("aria-level")).toBe("2");
		expect(row(root, "src/app.ts").querySelector(".bb-explorer-badges")?.getAttribute("aria-label")).toBe("Staged copied from src/base.ts, Unstaged modified");
		expect(row(root, "src/app.ts").classList.contains("git-modified")).toBe(true);

		click(row(root, "src/app.ts"));
		await tick();
		expect(row(root, "src/app.ts").getAttribute("aria-selected")).toBe("true");
		expect(root.querySelector(".bb-explorer-preview-path")?.textContent).toBe("src/app.ts");
		expect(root.textContent).toContain("Read only");
		expect(root.querySelector('[aria-label="Read-only file contents"]')).not.toBeNull();
		expect([...root.querySelectorAll(".bb-explorer-line-number")].map((node) => node.textContent)).toEqual(["1", "2"]);
		expect(root.querySelector("textarea, [contenteditable=true], input[aria-label=\"Relative path\"]")).toBeNull();
		expect(root.querySelector('input[aria-label="Search files and folders"]')).not.toBeNull();
		expect(fakeHost.callRoute).toHaveBeenCalledWith("list", expect.objectContaining({ body: { path: "src", rootPath: "C:\\Users\\tester\\worktrees\\bobbit" } }));
		expect(fakeHost.callRoute).toHaveBeenCalledWith("read", expect.objectContaining({ body: { path: "src/app.ts", rootPath: "C:\\Users\\tester\\worktrees\\bobbit" } }));
	});

	it("resizes the file tree with pointer and keyboard controls", async () => {
		const root = mount("split-resize", host({ list: () => list([]) }));
		await tick();
		const content = root.querySelector<HTMLElement>(".bb-explorer-content")!;
		const treePane = root.querySelector<HTMLElement>(".bb-explorer-tree-pane")!;
		const splitter = root.querySelector<HTMLElement>('[role="separator"][aria-label="Resize file tree"]')!;
		Object.defineProperty(content, "getBoundingClientRect", { value: () => ({ width: 1000 }) });
		Object.defineProperty(treePane, "getBoundingClientRect", { value: () => ({ width: 320 }) });

		splitter.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 320 }));
		document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 400 }));
		document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
		expect(content.style.getPropertyValue("--tree-pane-width")).toBe("400px");
		expect(splitter.getAttribute("aria-valuenow")).toBe("400");
		key(splitter, "ArrowLeft");
		expect(content.style.getPropertyValue("--tree-pane-width")).toBe("384px");
		splitter.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		expect(content.style.getPropertyValue("--tree-pane-width")).toBe("");
	});

	it("renders descendant Git states as single, split, and three-way folder outlines", async () => {
		const fakeHost = host({
			list: () => list([
				{ path: "added", name: "added", kind: "directory" },
				{ path: "added-modified", name: "added-modified", kind: "directory" },
				{ path: "added-deleted", name: "added-deleted", kind: "directory" },
				{ path: "modified-deleted", name: "modified-deleted", kind: "directory" },
				{ path: "all", name: "all", kind: "directory" },
			], [
				{ path: "added/new.ts", index: "A", added: true },
				{ path: "added-modified/new.ts", index: "A", added: true },
				{ path: "added-modified/edit.ts", worktree: "M", summary: "modified" },
				{ path: "added-deleted/new.ts", index: "A", added: true },
				{ path: "added-deleted/old.ts", worktree: "D", deleted: true },
				{ path: "modified-deleted/edit.ts", worktree: "M", summary: "modified" },
				{ path: "modified-deleted/old.ts", worktree: "D", deleted: true },
				{ path: "all/new.ts", index: "A", added: true },
				{ path: "all/edit.ts", worktree: "M", summary: "modified" },
				{ path: "all/old.ts", worktree: "D", deleted: true },
			]),
		});
		const root = mount("folder-outlines", fakeHost);
		await tick();

		const stroke = (path: string) => row(root, path).querySelector(".bb-explorer-icon svg")?.getAttribute("stroke") ?? "";
		expect(stroke("added")).toBe("var(--positive)");
		for (const path of ["added-modified", "added-deleted", "modified-deleted", "all"]) {
			expect(stroke(path)).toMatch(/^url\(#folder-gradient-/);
			expect(row(root, path).className).not.toMatch(/git-(added|modified|deleted)/);
		}
		const stops = (path: string) => [...row(root, path).querySelectorAll("stop")].map((stop) => stop.getAttribute("stop-color"));
		expect(new Set(stops("added-modified"))).toEqual(new Set(["var(--positive)", "var(--warning)"]));
		expect(new Set(stops("added-deleted"))).toEqual(new Set(["var(--positive)", "var(--negative)"]));
		expect(new Set(stops("modified-deleted"))).toEqual(new Set(["var(--warning)", "var(--negative)"]));
		expect(new Set(stops("all"))).toEqual(new Set(["var(--positive)", "var(--warning)", "var(--negative)"]));
	});

	it("renders conflicts once and scopes clean and mixed copy and rename badges to their Git columns", async () => {
		const fakeHost = host({
			list: ({ path }) => path === "src"
				? list([
					{ path: "src/base.ts", name: "base.ts", kind: "file" },
					{ path: "src/clean-copied.ts", name: "clean-copied.ts", kind: "file" },
					{ path: "src/clean-renamed.ts", name: "clean-renamed.ts", kind: "file" },
					{ path: "src/copied.ts", name: "copied.ts", kind: "file" },
					{ path: "src/renamed.ts", name: "renamed.ts", kind: "file" },
				])
				: list([
					{ path: "src", name: "src", kind: "directory" },
					{ path: "aa.txt", name: "aa.txt", kind: "file" },
					{ path: "dd.txt", name: "dd.txt", kind: "file" },
				], [
					{ path: "aa.txt", index: "A", worktree: "A", conflict: true, summary: "conflict", staged: true, unstaged: true, added: true },
					{ path: "dd.txt", index: "D", worktree: "D", conflict: true, summary: "conflict", staged: true, unstaged: true, deleted: true },
					{ path: "src/clean-copied.ts", oldPath: "src/base.ts", index: "A", worktree: " ", copied: true, staged: true, unstaged: false, added: true },
					{ path: "src/clean-renamed.ts", oldPath: "src/old.ts", index: "R", worktree: " ", renamed: true, staged: true, unstaged: false },
					{ path: "src/copied.ts", oldPath: "src/base.ts", index: "A", worktree: "M", copied: true, staged: true, unstaged: true, added: true },
					{ path: "src/renamed.ts", oldPath: "src/old.ts", index: "R", worktree: "M", renamed: true, staged: true, unstaged: true },
				]),
			read: () => ({ kind: "text", text: "value" }),
			diff: () => ({ kind: "empty" }),
		});
		const root = mount("combined-statuses", fakeHost);
		await tick();

		for (const path of ["aa.txt", "dd.txt"]) {
			expect(row(root, path).classList.contains("git-deleted")).toBe(true);
			const badges = row(root, path).querySelector(".bb-explorer-badges");
			expect(badges?.getAttribute("aria-label")).toBe("Conflict");
			expect(badges?.querySelectorAll(".bb-explorer-badge")).toHaveLength(1);
			expect(badges?.textContent).toBe("!");
		}
		expect(row(root, "src").querySelector('[aria-label="Contains changes"]')).toBeNull();

		click(row(root, "src"));
		await tick();
		expect(row(root, "src/base.ts").querySelector(".bb-explorer-badges")).toBeNull();
		expect(row(root, "src/clean-copied.ts").querySelector(".bb-explorer-badges")?.getAttribute("aria-label")).toBe("Staged copied from src/base.ts");
		expect([...row(root, "src/clean-copied.ts").querySelectorAll(".bb-explorer-badge")].map((badge) => badge.textContent)).toEqual(["C"]);
		expect(row(root, "src/clean-renamed.ts").querySelector(".bb-explorer-badges")?.getAttribute("aria-label")).toBe("Staged renamed from src/old.ts");
		expect([...row(root, "src/clean-renamed.ts").querySelectorAll(".bb-explorer-badge")].map((badge) => badge.textContent)).toEqual(["R"]);
		expect(row(root, "src/copied.ts").querySelector(".bb-explorer-badges")?.getAttribute("aria-label")).toBe("Staged copied from src/base.ts, Unstaged modified");
		expect([...row(root, "src/copied.ts").querySelectorAll(".bb-explorer-badge")].map((badge) => badge.textContent)).toEqual(["C", "M"]);
		expect(row(root, "src/renamed.ts").querySelector(".bb-explorer-badges")?.getAttribute("aria-label")).toBe("Staged renamed from src/old.ts, Unstaged modified");
		expect([...row(root, "src/renamed.ts").querySelectorAll(".bb-explorer-badge")].map((badge) => badge.textContent)).toEqual(["R", "M"]);
	});

	it("supports roving focus and Arrow, Home, End, Enter, and Space keyboard behavior", async () => {
		const fakeHost = host({
			list: ({ path }) => path === "folder"
				? list([{ path: "folder/child.txt", name: "child.txt", kind: "file" }])
				: list([
					{ path: "folder", name: "folder", kind: "directory" },
					{ path: "a.txt", name: "a.txt", kind: "file" },
					{ path: "z.txt", name: "z.txt", kind: "file" },
				]),
			read: ({ path }) => ({ kind: "text", text: String(path) }),
			diff: () => ({ kind: "empty" }),
		});
		const root = mount("keyboard-tree", fakeHost);
		await tick();
		const folder = row(root, "folder");
		folder.focus();
		expect(key(folder, "ArrowRight")).toBe(false);
		await tick();
		expect(row(root, "folder").getAttribute("aria-expanded")).toBe("true");
		key(row(root, "folder"), "ArrowRight");
		expect(document.activeElement).toBe(row(root, "folder/child.txt"));
		key(row(root, "folder/child.txt"), "ArrowDown");
		expect(document.activeElement).toBe(row(root, "a.txt"));
		key(row(root, "a.txt"), "End");
		expect(document.activeElement).toBe(row(root, "z.txt"));
		key(row(root, "z.txt"), "Home");
		expect(document.activeElement).toBe(row(root, "folder"));
		key(row(root, "folder"), "ArrowDown");
		key(row(root, "folder/child.txt"), "ArrowUp");
		expect(document.activeElement).toBe(row(root, "folder"));
		key(row(root, "folder"), "ArrowLeft");
		await tick();
		expect(row(root, "folder").getAttribute("aria-expanded")).toBe("false");
		key(row(root, "folder"), " ");
		await tick();
		expect(row(root, "folder").getAttribute("aria-expanded")).toBe("true");
		key(row(root, "folder/child.txt"), "Enter");
		await tick();
		expect(row(root, "folder/child.txt").getAttribute("aria-selected")).toBe("true");
		expect(root.querySelectorAll('[role="treeitem"][tabindex="0"]')).toHaveLength(1);
	});

	it("toggles a changed file between File and complete HEAD diff views", async () => {
		const fakeHost = host({
			list: () => list([{ path: "changed.ts", name: "changed.ts", kind: "file" }], [{ path: "changed.ts", index: "M", worktree: "M", staged: true, unstaged: true }]),
			read: () => ({ kind: "text", text: "new value" }),
			diff: () => ({ kind: "text", text: "diff --git a/changed.ts b/changed.ts\n--- a/changed.ts\n+++ b/changed.ts\n@@ -1 +1 @@\n-old value\n+new value\n" }),
		});
		const root = mount("diff-toggle", fakeHost);
		await tick();
		click(row(root, "changed.ts"));
		await tick();
		expect(root.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Preview mode");
		expect(root.querySelector('[data-action="view-file"]')?.getAttribute("aria-selected")).toBe("true");
		expect(row(root, "changed.ts").querySelector(".bb-explorer-badges")?.getAttribute("aria-label")).toBe("Staged modified, Unstaged modified");

		click(root.querySelector('[data-action="view-diff"]')!);
		await tick();
		expect(root.querySelector('[data-action="view-diff"]')?.getAttribute("aria-selected")).toBe("true");
		expect(root.querySelector('[aria-label="Working tree compared with HEAD"]')).not.toBeNull();
		expect(root.querySelector(".bb-explorer-diff-file-header")).toBeNull();
		expect(root.textContent).toContain("−old value");
		expect(root.textContent).toContain("+new value");
		expect(fakeHost.callRoute).toHaveBeenCalledWith("diff", expect.objectContaining({ body: { path: "changed.ts", rootPath: "C:\\Users\\tester\\worktrees\\bobbit" } }));
		click(root.querySelector('[data-action="view-file"]')!);
		await tick();
		expect(root.textContent).toContain("new value");
	});

	it("remembers the File or Diff choice across file navigation", async () => {
		const fakeHost = host({
			list: () => list([
				{ path: "first.ts", name: "first.ts", kind: "file" },
				{ path: "clean.ts", name: "clean.ts", kind: "file" },
				{ path: "second.ts", name: "second.ts", kind: "file" },
			], [
				{ path: "first.ts", worktree: "M", summary: "modified" },
				{ path: "second.ts", worktree: "M", summary: "modified" },
			]),
			read: ({ path }) => ({ kind: "text", text: `file ${path}` }),
			diff: ({ path }) => ({ kind: "text", text: `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-old\n+new\n` }),
		});
		const root = mount("remember-preview-mode", fakeHost);
		await tick();

		click(row(root, "first.ts"));
		await tick();
		click(root.querySelector('[data-action="view-diff"]')!);
		await tick();
		click(row(root, "clean.ts"));
		await tick();
		expect(root.querySelector('[data-action="view-diff"]')).toBeNull();
		expect(root.textContent).toContain("file clean.ts");
		click(row(root, "second.ts"));
		await tick();
		expect(root.querySelector('[data-action="view-diff"]')?.getAttribute("aria-selected")).toBe("true");
		expect(root.querySelector('[aria-label="Working tree compared with HEAD"]')).not.toBeNull();

		click(root.querySelector('[data-action="view-file"]')!);
		await tick();
		click(row(root, "first.ts"));
		await tick();
		expect(root.querySelector('[data-action="view-file"]')?.getAttribute("aria-selected")).toBe("true");
		expect(root.textContent).toContain("file first.ts");
	});

	it("renders non-empty metadata-only copy and rename diffs through the shared parser", async () => {
		const fakeHost = host({
			list: () => list([
				{ path: "copied.ts", name: "copied.ts", kind: "file" },
				{ path: "renamed.ts", name: "renamed.ts", kind: "file" },
			], [
				{ path: "copied.ts", oldPath: "base.ts", index: "C", worktree: " ", copied: true, staged: true },
				{ path: "renamed.ts", oldPath: "old.ts", index: "R", worktree: " ", renamed: true, staged: true },
			]),
			read: () => ({ kind: "text", text: "unchanged" }),
			diff: ({ path }) => path === "copied.ts"
				? { kind: "metadata-only", text: "diff --git a/base.ts b/copied.ts\nsimilarity index 100%\ncopy from base.ts\ncopy to copied.ts\n" }
				: { kind: "metadata-only", text: "diff --git a/old.ts b/renamed.ts\nsimilarity index 100%\nrename from old.ts\nrename to renamed.ts\n" },
		});
		const root = mount("metadata-only-diffs", fakeHost);
		await tick();

		click(row(root, "copied.ts"));
		await tick();
		click(root.querySelector('[data-action="view-diff"]')!);
		await tick();
		expect(root.querySelector(".bb-explorer-diff-file-header")).toBeNull();
		expect(root.textContent).toContain("copy from base.ts");
		expect(root.textContent).toContain("copy to copied.ts");

		click(row(root, "renamed.ts"));
		await tick();
		click(root.querySelector('[data-action="view-diff"]')!);
		await tick();
		expect(root.querySelector(".bb-explorer-diff-file-header")).toBeNull();
		expect(root.textContent).toContain("rename from old.ts");
		expect(root.textContent).toContain("rename to renamed.ts");
	});

	it("renders explicit root, folder, and preview boundary states with local retry", async () => {
		let rootAttempts = 0;
		const fakeHost = host({
			list: ({ path }) => {
				if (path === "broken") throw { routeError: { code: "FS_TIMEOUT", retryable: true } };
				if (rootAttempts++ === 0) throw { routeError: { code: "FS_TIMEOUT", retryable: true } };
				return list([
					{ path: "broken", name: "broken", kind: "directory" },
					{ path: "binary.dat", name: "binary.dat", kind: "file" },
					{ path: "empty.txt", name: "empty.txt", kind: "file" },
					{ path: "large.log", name: "large.log", kind: "file" },
				], [], true);
			},
			read: ({ path }) => path === "binary.dat" ? { kind: "binary" } : path === "empty.txt" ? { kind: "empty" } : { kind: "too-large", limit: 1024 * 1024 },
			diff: () => ({ kind: "empty" }),
		});
		const root = mount("boundary-states", fakeHost);
		await tick();
		expect(root.textContent).toContain("The file operation timed out.");
		click(root.querySelector("button[data-retry]")!);
		await tick();
		expect(root.textContent).toContain("Showing the first 1,000 entries.");

		click(row(root, "broken"));
		await tick();
		expect(root.querySelector('[role="group"]')?.textContent).toContain("The file operation timed out.");
		for (const [path, message] of [
			["binary.dat", "Binary files cannot be previewed."],
			["empty.txt", "This file is empty."],
			["large.log", "File is too large to display (limit 1 MiB)."],
		] as const) {
			click(row(root, path));
			await tick();
			expect(root.textContent).toContain(message);
		}
	});

	it("refreshes on the first idle and later non-idle to idle transitions while pruning vanished selection", async () => {
		let statusCallback: ((value: { status: "idle" | "running" | "error" }) => void) | undefined;
		let entries: Entry[] = [{ path: "keep.txt", name: "keep.txt", kind: "file" }];
		const statusDispose = vi.fn();
		const fakeHost = host({
			list: () => list(entries),
			read: ({ path }) => ({ kind: "text", text: String(path) }),
			diff: () => ({ kind: "empty" }),
		}, { onStatus: (cb) => { statusCallback = cb; }, statusDispose });
		const root = mount("refresh-lifecycle", fakeHost);
		await vi.waitFor(() => {
			expect(statusCallback).toBeTypeOf("function");
			expect(row(root, "keep.txt")).not.toBeNull();
		});
		click(row(root, "keep.txt"));
		await tick();
		const rootStatusCount = () => fakeHost.callRoute.mock.calls.filter(([name, init]) => name === "list" && (init?.body as Record<string, unknown> | undefined)?.includeStatus === true).length;
		const initial = rootStatusCount();
		statusCallback!({ status: "idle" });
		await tick();
		expect(rootStatusCount()).toBe(initial + 1);
		statusCallback!({ status: "idle" });
		await tick();
		expect(rootStatusCount()).toBe(initial + 1);
		statusCallback!({ status: "running" });
		statusCallback!({ status: "idle" });
		await tick();
		expect(rootStatusCount()).toBe(initial + 2);
		expect(row(root, "keep.txt").getAttribute("aria-selected")).toBe("true");

		entries = [];
		await createFileExplorerPanel().refresh?.({ __sessionId: "refresh-lifecycle" }, fakeHost as Parameters<ReturnType<typeof createFileExplorerPanel>["render"]>[1]);
		await tick();
		expect(root.textContent).toContain("This folder is empty.");
		expect(root.textContent).toContain("Select a file to preview");
		expect(root.querySelector('[role="status"]')?.textContent).toBe("Explorer refreshed.");

		root.remove();
		await vi.waitFor(() => expect(statusDispose).toHaveBeenCalledTimes(1));
	});

	it("queues one first-idle refresh that arrives during initialization", async () => {
		let statusCallback: ((value: { status: "idle" | "running" | "error" }) => void) | undefined;
		const initialList = deferred<unknown>();
		let listCalls = 0;
		const fakeHost = host({
			list: () => ++listCalls === 1 ? initialList.promise : list([]),
			read: () => ({ kind: "text", text: "value" }),
			diff: () => ({ kind: "empty" }),
		}, { onStatus: (cb) => { statusCallback = cb; } });
		mount("queued-first-idle", fakeHost);
		await tick();
		expect(listCalls).toBe(1);

		statusCallback!({ status: "idle" });
		statusCallback!({ status: "idle" });
		expect(listCalls).toBe(1);
		initialList.resolve(list([]));
		await tick();
		await tick();
		expect(listCalls).toBe(2);
		statusCallback!({ status: "idle" });
		await tick();
		expect(listCalls).toBe(2);
	});

	it("replaces initialization invalidated by an immediate detach and remount", async () => {
		const staleList = deferred<unknown>();
		const replacementList = deferred<unknown>();
		const statusDispose = vi.fn();
		let listCalls = 0;
		const fakeHost = host({
			list: () => {
				listCalls += 1;
				if (listCalls === 1) return staleList.promise;
				if (listCalls === 2) return replacementList.promise;
				throw new Error("Unexpected duplicate initialization");
			},
			read: () => ({ kind: "text", text: "value" }),
			diff: () => ({ kind: "empty" }),
		}, { statusDispose });
		const sid = `init-remount-${++mountAttempt}`;
		const root = mount(sid, fakeHost);
		await tick();
		expect(listCalls).toBe(1);
		expect(fakeHost.session.subscribe).toHaveBeenCalledTimes(1);

		root.remove();
		const remounted = mount(sid, fakeHost);
		expect(remounted).toBe(root);
		await tick();
		expect(listCalls).toBe(1);
		expect(fakeHost.session.subscribe).toHaveBeenCalledTimes(2);
		expect(statusDispose).toHaveBeenCalledTimes(1);

		staleList.resolve(list([{ path: "stale.txt", name: "stale.txt", kind: "file" }]));
		await tick();
		await tick();
		expect(listCalls).toBe(2);
		expect(remounted.textContent).not.toContain("stale.txt");
		expect(remounted.querySelector('[role="tree"]')?.getAttribute("aria-busy")).toBe("true");

		replacementList.resolve(list([{ path: "ready.txt", name: "ready.txt", kind: "file" }]));
		await tick();
		await tick();
		expect(row(remounted, "ready.txt")).not.toBeNull();
		expect(remounted.textContent).not.toContain("stale.txt");
		expect(remounted.querySelector('[role="tree"]')?.getAttribute("aria-busy")).toBe("false");
		expect(listCalls).toBe(2);
		expect(fakeHost.session.subscribe).toHaveBeenCalledTimes(2);
		expect(statusDispose).toHaveBeenCalledTimes(1);
	});

	it("preserves remount navigation when deferred replacement initialization completes", async () => {
		const staleList = deferred<unknown>();
		const replacementList = deferred<unknown>();
		const pendingResolve = deferred<unknown>();
		let listCalls = 0;
		const fakeHost = host({
			list: () => ++listCalls === 1 ? staleList.promise : replacementList.promise,
			resolve: () => pendingResolve.promise,
			read: ({ path }) => ({ kind: "text", text: `preview ${path}` }),
			diff: () => ({ kind: "empty" }),
		}, {
			stored: { version: 1, expanded: [], selected: "old.txt", focused: "old.txt", view: "file" },
		});
		const sid = `remount-navigation-${++mountAttempt}`;
		const root = mount(sid, fakeHost);
		await tick();
		expect(fakeHost.store.read).toHaveBeenCalledTimes(1);
		expect(listCalls).toBe(1);

		root.remove();
		const remounted = mount(sid, fakeHost);
		expect(remounted).toBe(root);
		await tick();

		click(remounted.querySelector('[aria-label="Edit path (Ctrl+L)"]')!);
		await tick();
		const input = remounted.querySelector<HTMLInputElement>('[aria-label="Relative path"]')!;
		input.value = "new.txt";
		input.dispatchEvent(new InputEvent("input", { bubbles: true }));
		key(input, "Enter");
		await tick();
		pendingResolve.resolve({
			path: "new.txt",
			kind: "file",
			chain: [{ path: "new.txt", name: "new.txt", kind: "file" }],
		});
		await tick();
		await tick();
		expect(remounted.querySelector(".bb-explorer-preview-path")?.textContent).toBe("new.txt");
		expect(remounted.textContent).toContain("preview new.txt");
		expect(remounted.querySelector('[aria-label="Current absolute path"]')?.textContent).toContain("new.txt");

		staleList.resolve(list([{ path: "stale.txt", name: "stale.txt", kind: "file" }]));
		await tick();
		await tick();
		expect(listCalls).toBe(2);
		expect(fakeHost.store.read).toHaveBeenCalledTimes(1);

		replacementList.resolve(list([
			{ path: "new.txt", name: "new.txt", kind: "file" },
			{ path: "old.txt", name: "old.txt", kind: "file" },
		]));
		await tick();
		await tick();
		expect(row(remounted, "new.txt").getAttribute("aria-selected")).toBe("true");
		expect(row(remounted, "old.txt").getAttribute("aria-selected")).not.toBe("true");
		expect(remounted.querySelector(".bb-explorer-preview-path")?.textContent).toBe("new.txt");
		expect(remounted.querySelector('[aria-label="Current absolute path"]')?.textContent).toContain("new.txt");
		expect(remounted.textContent).toContain("preview new.txt");
		expect(remounted.textContent).not.toContain("stale.txt");
		expect(listCalls).toBe(2);
		expect(fakeHost.store.read).toHaveBeenCalledTimes(1);
	});

	it("retries a deferred durable-state read after its lifecycle is invalidated", async () => {
		const staleStore = deferred<{ state: "present"; value: Record<string, unknown> }>();
		const replacementStore = deferred<{ state: "present"; value: Record<string, unknown> }>();
		const fakeHost = host({
			list: () => list([
				{ path: "stale.txt", name: "stale.txt", kind: "file" },
				{ path: "restored.txt", name: "restored.txt", kind: "file" },
			]),
			read: ({ path }) => ({ kind: "text", text: `preview ${path}` }),
			diff: () => ({ kind: "empty" }),
		});
		fakeHost.store.read.mockImplementationOnce(() => staleStore.promise).mockImplementationOnce(() => replacementStore.promise);
		const sid = `deferred-store-remount-${++mountAttempt}`;
		const root = mount(sid, fakeHost);
		await tick();
		expect(fakeHost.store.read).toHaveBeenCalledTimes(1);
		expect(fakeHost.callRoute).not.toHaveBeenCalledWith("list", expect.anything());

		root.remove();
		const remounted = mount(sid, fakeHost);
		expect(remounted).toBe(root);
		await tick();
		staleStore.resolve({
			state: "present",
			value: { version: 1, expanded: [], selected: "stale.txt", focused: "stale.txt", view: "file" },
		});
		await tick();
		await tick();
		expect(fakeHost.store.read).toHaveBeenCalledTimes(2);
		expect(fakeHost.callRoute).not.toHaveBeenCalledWith("list", expect.anything());

		replacementStore.resolve({
			state: "present",
			value: { version: 1, expanded: [], selected: "restored.txt", focused: "restored.txt", view: "file" },
		});
		await tick();
		await tick();
		expect(row(remounted, "restored.txt").getAttribute("aria-selected")).toBe("true");
		expect(row(remounted, "stale.txt").getAttribute("aria-selected")).not.toBe("true");
		expect(fakeHost.store.read).toHaveBeenCalledTimes(2);
		expect(fakeHost.callRoute.mock.calls.filter(([route]) => route === "list")).toHaveLength(1);

		remounted.remove();
		const hydratedRemount = mount(sid, fakeHost);
		expect(hydratedRemount).toBe(root);
		await tick();
		expect(row(hydratedRemount, "restored.txt").getAttribute("aria-selected")).toBe("true");
		expect(fakeHost.store.read).toHaveBeenCalledTimes(2);
	});

	it("does not let a current-lifecycle durable read overwrite newer remount navigation", async () => {
		const staleStore = deferred<{ state: "present"; value: Record<string, unknown> }>();
		const currentStore = deferred<{ state: "present"; value: Record<string, unknown> }>();
		const rootList = deferred<unknown>();
		const fakeHost = host({
			list: () => rootList.promise,
			resolve: ({ path }) => ({
				path,
				kind: "file",
				chain: [{ path, name: String(path).split("/").pop(), kind: "file" }],
			}),
			read: ({ path }) => ({ kind: "text", text: `preview ${path}` }),
			diff: () => ({ kind: "empty" }),
		});
		fakeHost.store.read.mockImplementationOnce(() => staleStore.promise).mockImplementationOnce(() => currentStore.promise);
		const sid = `current-store-navigation-${++mountAttempt}`;
		const root = mount(sid, fakeHost);
		await tick();
		expect(fakeHost.store.read).toHaveBeenCalledTimes(1);

		root.remove();
		const remounted = mount(sid, fakeHost);
		expect(remounted).toBe(root);
		await tick();
		staleStore.resolve({
			state: "present",
			value: { version: 1, expanded: [], selected: "stale.txt", focused: "stale.txt", view: "file" },
		});
		await tick();
		await tick();
		expect(fakeHost.store.read).toHaveBeenCalledTimes(2);
		expect(fakeHost.callRoute).not.toHaveBeenCalledWith("list", expect.anything());

		click(remounted.querySelector('[aria-label="Edit path (Ctrl+L)"]')!);
		await tick();
		const input = remounted.querySelector<HTMLInputElement>('[aria-label="Relative path"]')!;
		input.value = "new.txt";
		input.dispatchEvent(new InputEvent("input", { bubbles: true }));
		key(input, "Enter");
		await tick();
		await tick();
		expect(remounted.querySelector(".bb-explorer-preview-path")?.textContent).toBe("new.txt");
		expect(remounted.querySelector('[aria-label="Current absolute path"]')?.textContent).toContain("new.txt");
		expect(remounted.textContent).toContain("preview new.txt");

		currentStore.resolve({
			state: "present",
			value: { version: 1, expanded: [], selected: "old.txt", focused: "old.txt", view: "diff", changedOnly: true },
		});
		await tick();
		await tick();
		expect(fakeHost.callRoute.mock.calls.filter(([route]) => route === "list")).toHaveLength(1);
		rootList.resolve(list([
			{ path: "new.txt", name: "new.txt", kind: "file" },
			{ path: "old.txt", name: "old.txt", kind: "file" },
		]));
		await tick();
		await tick();
		expect(row(remounted, "new.txt").getAttribute("aria-selected")).toBe("true");
		expect(row(remounted, "old.txt").getAttribute("aria-selected")).not.toBe("true");
		expect(remounted.querySelector(".bb-explorer-preview-path")?.textContent).toBe("new.txt");
		expect(remounted.querySelector('[aria-label="Current absolute path"]')?.textContent).toContain("new.txt");
		expect(remounted.textContent).toContain("preview new.txt");
		expect(remounted.textContent).not.toContain("preview old.txt");

		remounted.remove();
		const consumedRemount = mount(sid, fakeHost);
		expect(consumedRemount).toBe(root);
		await tick();
		expect(fakeHost.store.read).toHaveBeenCalledTimes(2);
		expect(row(consumedRemount, "new.txt").getAttribute("aria-selected")).toBe("true");
	});

	it("ignores a late preview response after a newer file selection", async () => {
		const slow = deferred<unknown>();
		const fakeHost = host({
			list: () => list([
				{ path: "slow.txt", name: "slow.txt", kind: "file" },
				{ path: "fast.txt", name: "fast.txt", kind: "file" },
			]),
			read: ({ path }) => path === "slow.txt" ? slow.promise : { kind: "text", text: "fast result" },
			diff: () => ({ kind: "empty" }),
		});
		const root = mount("stale-preview", fakeHost);
		await tick();
		click(row(root, "slow.txt"));
		await tick();
		click(row(root, "fast.txt"));
		await tick();
		expect(root.textContent).toContain("fast result");
		slow.resolve({ kind: "text", text: "stale result" });
		await tick();
		expect(root.textContent).toContain("fast result");
		expect(root.textContent).not.toContain("stale result");
	});

	it("restores relative UI state, persists it, and uses Back in the narrow flow", async () => {
		let resizeCallback: ((entries: Array<{ contentRect: { width: number } }>) => void) | undefined;
		class FakeResizeObserver {
			constructor(callback: typeof resizeCallback) { resizeCallback = callback; }
			observe() { resizeCallback?.([{ contentRect: { width: 500 } }]); }
			disconnect() {}
		}
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		const put = vi.fn(async () => undefined);
		const fakeHost = host({
			list: ({ path }) => path === "src"
				? list([{ path: "src/restored.txt", name: "restored.txt", kind: "file" }])
				: list([{ path: "src", name: "src", kind: "directory" }]),
			read: () => ({ kind: "text", text: "restored" }),
			diff: () => ({ kind: "empty" }),
		}, {
			stored: { version: 1, expanded: ["src", "../escape", "C:\\bad"], selected: "src/restored.txt", focused: "src/restored.txt", view: "file" },
			put,
		});
		const root = mount("restored-narrow", fakeHost);
		await tick();
		expect(root.classList.contains("is-narrow")).toBe(true);
		expect(row(root, "src").getAttribute("aria-expanded")).toBe("true");
		expect(row(root, "src/restored.txt").getAttribute("aria-selected")).toBe("true");
		click(row(root, "src/restored.txt"));
		await tick();
		expect(root.dataset.narrowPane).toBe("preview");
		expect(root.querySelector<HTMLElement>(".bb-explorer-tree-pane")?.hidden).toBe(true);
		click(root.querySelector(".bb-explorer-back")!);
		await tick();
		expect(root.dataset.narrowPane).toBe("tree");
		expect(root.querySelector<HTMLElement>(".bb-explorer-preview-pane")?.hidden).toBe(true);
		await tick(200);
		expect(put).toHaveBeenCalledWith("ui/restored-narrow", expect.objectContaining({ version: 1, expanded: ["src"], selected: "src/restored.txt" }));
		expect(root.querySelector('[aria-label="Current absolute path"]')).not.toBeNull();
		const search = root.querySelector<HTMLInputElement>('[aria-label="Search files and folders"]')!;
		search.value = "transient";
		search.dispatchEvent(new InputEvent("input", { bubbles: true }));
		root.remove();
		const restoredRoot = mount("restored-narrow", fakeHost);
		expect(restoredRoot).toBe(root);
		expect(restoredRoot.querySelector<HTMLInputElement>('[aria-label="Search files and folders"]')?.value).toBe("");
		expect(restoredRoot.querySelector('[role="listbox"]')).toBeNull();
		expect(row(restoredRoot, "src").getAttribute("aria-expanded")).toBe("true");
		expect(row(restoredRoot, "src/restored.txt").getAttribute("aria-selected")).toBe("true");
		await tick();
		expect(row(restoredRoot, "src/restored.txt")).not.toBeNull();
	});

	it("synchronously reconciles cached same-session remounts without losing durable browse state", async () => {
		const staleSearch = deferred<unknown>();
		const statusCallbacks: Array<(value: { status: "idle" | "running" | "error" }) => void> = [];
		const statusDispose = vi.fn();
		const writeText = vi.fn(async () => undefined);
		const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		const sid = `rapid-remount-${++mountAttempt}`;
		const fakeHost = host({
			list: ({ path }) => path === "src"
				? list([{ path: "src/restored.txt", name: "restored.txt", kind: "file" }])
				: list([{ path: "src", name: "src", kind: "directory" }], [{ path: "src/restored.txt", worktree: "M" }]),
			search: () => staleSearch.promise,
			read: () => ({ kind: "text", text: "durable file" }),
			diff: () => ({ kind: "text", text: "diff --git a/src/restored.txt b/src/restored.txt\n--- a/src/restored.txt\n+++ b/src/restored.txt\n@@ -1 +1 @@\n-old\n+durable diff\n" }),
		}, {
			onStatus: (callback) => statusCallbacks.push(callback),
			statusDispose,
		});
		const root = mount(sid, fakeHost);
		await tick();
		click(row(root, "src"));
		await tick();
		click(row(root, "src/restored.txt"));
		await tick();
		click(root.querySelector('[data-action="view-diff"]')!);
		await tick();
		expect(fakeHost.session.subscribe).toHaveBeenCalledTimes(1);
		expect(root.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Diff");

		click(root.querySelector('[aria-label="Edit path (Ctrl+L)"]')!);
		await tick();
		const pathInput = root.querySelector<HTMLInputElement>('[aria-label="Relative path"]')!;
		pathInput.value = "../transient";
		pathInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
		key(pathInput, "Enter");
		expect(root.querySelector('[aria-label="Relative path"]')).not.toBeNull();
		root.remove();
		const pathRemount = mount(sid, fakeHost);
		expect(pathRemount).toBe(root);
		expect(pathRemount.querySelector('[aria-label="Relative path"]')).toBeNull();
		expect(pathRemount.querySelector('[aria-label="Current absolute path"]')).not.toBeNull();
		expect(row(pathRemount, "src").getAttribute("aria-expanded")).toBe("true");
		expect(row(pathRemount, "src/restored.txt").getAttribute("aria-selected")).toBe("true");
		expect(pathRemount.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Diff");
		await tick();
		expect(pathRemount.querySelector('[role="alert"]')?.textContent).toBe("");
		expect(fakeHost.session.subscribe).toHaveBeenCalledTimes(2);
		expect(statusDispose).toHaveBeenCalledTimes(1);

		row(pathRemount, "src/restored.txt").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		await tick();
		click([...pathRemount.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Copy relative path")!);
		await tick();
		expect(pathRemount.textContent).toContain("Relative path copied");
		row(pathRemount, "src/restored.txt").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		await tick();
		expect(pathRemount.querySelector('[role="menu"]')).not.toBeNull();
		const search = pathRemount.querySelector<HTMLInputElement>('[aria-label="Search files and folders"]')!;
		search.value = "transient";
		search.dispatchEvent(new InputEvent("input", { bubbles: true }));
		await tick(220);
		expect(search.getAttribute("aria-busy")).toBe("true");

		pathRemount.remove();
		const searchRemount = mount(sid, fakeHost);
		expect(searchRemount).toBe(root);
		expect(search.value).toBe("");
		expect(searchRemount.querySelector('[role="listbox"]')).toBeNull();
		expect(searchRemount.querySelector('[role="menu"]')).toBeNull();
		expect(searchRemount.querySelector(".bb-explorer-inline-feedback")).toBeNull();
		expect(searchRemount.querySelector('[role="status"]')?.textContent).toBe("");
		expect(searchRemount.querySelector('[role="alert"]')?.textContent).toBe("");
		expect(row(searchRemount, "src").getAttribute("aria-expanded")).toBe("true");
		expect(row(searchRemount, "src/restored.txt").getAttribute("aria-selected")).toBe("true");
		expect(searchRemount.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Diff");

		staleSearch.resolve({
			query: "transient", count: 1, limit: 200, truncated: false,
			results: [{ path: "stale.txt", name: "stale.txt", kind: "file" }],
		});
		await tick();
		expect(searchRemount.textContent).not.toContain("stale.txt");
		expect(fakeHost.session.subscribe).toHaveBeenCalledTimes(3);
		expect(statusDispose).toHaveBeenCalledTimes(2);
		const listCallsBeforeIdle = fakeHost.callRoute.mock.calls.filter(([route]) => route === "list").length;
		statusCallbacks.at(-1)!({ status: "running" });
		statusCallbacks.at(-1)!({ status: "idle" });
		await tick();
		expect(fakeHost.callRoute.mock.calls.filter(([route]) => route === "list").length).toBeGreaterThan(listCallsBeforeIdle);
		expect(fakeHost.session.subscribe).toHaveBeenCalledTimes(3);
		expect(statusDispose).toHaveBeenCalledTimes(2);
		expect(row(searchRemount, "src/restored.txt")).not.toBeNull();

		if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
		else Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
	});

	it("navigates canonical paths with breadcrumbs and cancels invalid path edits without losing selection", async () => {
		const fakeHost = host({
			list: () => list([{ path: "keep.txt", name: "keep.txt", kind: "file" }]),
			resolve: ({ path }) => path === "deep/nested/file.ts"
				? { path, kind: "file", chain: [
					{ path: "deep", name: "deep", kind: "directory" },
					{ path: "deep/nested", name: "nested", kind: "directory" },
					{ path, name: "file.ts", kind: "file" },
				] }
				: path === "deep/nested" ? { path, kind: "directory", chain: [
					{ path: "deep", name: "deep", kind: "directory" },
					{ path, name: "nested", kind: "directory" },
				] }
					: path === "deep" ? { path, kind: "directory", chain: [{ path: "deep", name: "deep", kind: "directory" }] }
						: { path: "", kind: "root", chain: [] },
			read: ({ path }) => ({ kind: "text", text: String(path) }),
			diff: () => ({ kind: "empty" }),
		});
		const root = mount("path-navigation", fakeHost);
		await tick();
		click(row(root, "keep.txt"));
		await tick();
		const selectedBefore = root.querySelector('[aria-selected="true"]')?.getAttribute("data-path");

		const edit = root.querySelector<HTMLButtonElement>('[aria-label="Edit path (Ctrl+L)"]')!;
		edit.focus();
		expect(edit.dispatchEvent(new KeyboardEvent("keydown", { key: "l", ctrlKey: true, bubbles: true, cancelable: true }))).toBe(false);
		await tick();
		let input = root.querySelector<HTMLInputElement>('[aria-label="Relative path"]')!;
		expect(document.activeElement).toBe(input);
		input.value = "../outside";
		input.dispatchEvent(new InputEvent("input", { bubbles: true }));
		key(input, "Enter");
		await tick();
		expect(root.textContent).toContain("Enter an absolute filesystem path.");
		expect(root.querySelector('[aria-selected="true"]')?.getAttribute("data-path")).toBe(selectedBefore);
		input = root.querySelector<HTMLInputElement>('[aria-label="Relative path"]')!;
		key(input, "Escape");
		await tick();
		expect(root.querySelector('[aria-label="Relative path"]')).toBeNull();
		expect(document.activeElement).toBe(root.querySelector('[aria-label="Edit path (Ctrl+L)"]'));

		click(root.querySelector('[aria-label="Edit path (Ctrl+L)"]')!);
		await tick();
		input = root.querySelector<HTMLInputElement>('[aria-label="Relative path"]')!;
		input.value = "deep/nested/file.ts";
		input.dispatchEvent(new InputEvent("input", { bubbles: true }));
		key(input, "Enter");
		await tick();
		expect(row(root, "deep/nested/file.ts").getAttribute("aria-selected")).toBe("true");
		expect(root.querySelector('[aria-label="Current absolute path"]')?.textContent).toContain("C:/Users/tester/worktrees/bobbit/deep/nested/file.ts");
		expect(root.querySelector('[aria-label="Up one level"]')?.hasAttribute("disabled")).toBe(false);
		click(root.querySelector('[aria-label="Up one level"]')!);
		await tick();
		expect(root.querySelector('[aria-label="Current absolute path"]')?.textContent).toContain("C:/Users/tester/worktrees/bobbit/deep/nested");
		expect(root.textContent).toContain("deep/nested/file.ts");
		click(root.querySelector<HTMLButtonElement>('.bb-explorer-crumb[data-path="deep"]')!);
		await tick();
		expect(document.activeElement).toBe(row(root, "deep"));
		expect(root.querySelector('[aria-label="Current absolute path"]')?.textContent).toContain("C:/Users/tester/worktrees/bobbit/deep");
	});

	it("preserves exact spaced paths and commits a resolved file before its preview read settles", async () => {
		const pendingRead = deferred<unknown>();
		const exactPath = " report ";
		const fakeHost = host({
			list: () => list([{ path: "keep.txt", name: "keep.txt", kind: "file" }]),
			resolve: ({ path }) => ({ path, kind: "file", chain: [{ path, name: path, kind: "file" }] }),
			read: ({ path }) => path === exactPath ? pendingRead.promise : { kind: "text", text: "keep" },
			diff: () => ({ kind: "empty" }),
		});
		const root = mount("exact-spaced-path", fakeHost);
		await tick();
		click(row(root, "keep.txt"));
		await tick();
		click(root.querySelector('[aria-label="Edit path (Ctrl+L)"]')!);
		await tick();
		const input = root.querySelector<HTMLInputElement>('[aria-label="Relative path"]')!;
		input.value = exactPath;
		key(input, "Enter");
		await tick();

		expect(fakeHost.callRoute).toHaveBeenCalledWith("resolve", expect.objectContaining({ body: { path: exactPath, rootPath: "C:\\Users\\tester\\worktrees\\bobbit" } }));
		expect(root.querySelector('[aria-label="Relative path"]')).toBeNull();
		expect(root.querySelector('.bb-explorer-crumb[data-path=" report "]')?.textContent).toBe(exactPath);
		expect(row(root, exactPath).getAttribute("aria-selected")).toBe("true");
		key(root, "Escape");
		expect(root.querySelector('.bb-explorer-crumb[data-path=" report "]')).not.toBeNull();
		expect(row(root, exactPath).getAttribute("aria-selected")).toBe("true");

		pendingRead.resolve({ kind: "text", text: "spaced path preview" });
		await tick();
		expect(root.textContent).toContain("spaced path preview");
	});

	it("focuses a resolved nested row after the initial root listing makes it renderable", async () => {
		const initialList = deferred<unknown>();
		const fakeHost = host({
			list: () => initialList.promise,
			resolve: ({ path }) => ({ path, kind: "directory", chain: [
				{ path: "deep", name: "deep", kind: "directory" },
				{ path, name: "nested", kind: "directory" },
			] }),
			read: () => ({ kind: "text", text: "unused" }),
			diff: () => ({ kind: "empty" }),
		});
		const root = mount("pending-navigation-focus", fakeHost);
		await tick();
		click(root.querySelector('[aria-label="Edit path (Ctrl+L)"]')!);
		await tick();
		const input = root.querySelector<HTMLInputElement>('[aria-label="Relative path"]')!;
		input.value = "deep/nested";
		key(input, "Enter");
		await tick();
		expect(root.querySelector('[role="treeitem"][data-path="deep/nested"]')).toBeNull();

		initialList.resolve(list([{ path: "deep", name: "deep", kind: "directory" }]));
		await tick();
		await tick();
		expect(document.activeElement).toBe(row(root, "deep/nested"));
		expect(row(root, "deep/nested").tabIndex).toBe(0);
	});

	it("does not let an older navigation steal focus after a newer tree selection", async () => {
		const pendingRead = deferred<unknown>();
		const fakeHost = host({
			list: () => list([
				{ path: "a.txt", name: "a.txt", kind: "file" },
				{ path: "b.txt", name: "b.txt", kind: "file" },
			]),
			resolve: ({ path }) => ({ path, kind: "file", chain: [{ path, name: path, kind: "file" }] }),
			read: ({ path }) => path === "a.txt" ? pendingRead.promise : { kind: "text", text: "newer B" },
			diff: () => ({ kind: "empty" }),
		});
		const root = mount("superseded-navigation-focus", fakeHost);
		await tick();
		click(root.querySelector('[aria-label="Edit path (Ctrl+L)"]')!);
		await tick();
		const input = root.querySelector<HTMLInputElement>('[aria-label="Relative path"]')!;
		input.value = "a.txt";
		key(input, "Enter");
		await tick();

		row(root, "b.txt").focus();
		key(row(root, "b.txt"), "Enter");
		await tick();
		pendingRead.resolve({ kind: "text", text: "stale A" });
		await tick();
		await tick();
		expect(row(root, "b.txt").getAttribute("aria-selected")).toBe("true");
		expect(row(root, "b.txt").tabIndex).toBe(0);
		expect(document.activeElement).toBe(row(root, "b.txt"));
		expect(root.textContent).toContain("newer B");
		expect(root.textContent).not.toContain("stale A");
	});

	it("cancels an in-flight path resolve, fences its late response, and prevents duplicate submits", async () => {
		const pending = deferred<unknown>();
		const fakeHost = host({
			list: () => list([{ path: "keep.txt", name: "keep.txt", kind: "file" }]),
			resolve: ({ path }) => path === "slow" ? pending.promise : { path, kind: "directory", chain: [{ path, name: path, kind: "directory" }] },
			read: () => ({ kind: "text", text: "keep" }),
			diff: () => ({ kind: "empty" }),
		});
		const root = mount("cancel-resolve", fakeHost);
		await tick();
		click(root.querySelector('[aria-label="Edit path (Ctrl+L)"]')!);
		await tick();
		let input = root.querySelector<HTMLInputElement>('[aria-label="Relative path"]')!;
		input.value = "slow";
		key(input, "Enter");
		await tick();
		input = root.querySelector<HTMLInputElement>('[aria-label="Relative path"]')!;
		expect(input.readOnly).toBe(true);
		expect(document.activeElement).toBe(input);
		key(input, "Enter");
		expect(fakeHost.callRoute.mock.calls.filter(([name]) => name === "resolve")).toHaveLength(1);
		key(input, "Escape");
		await tick();
		expect(root.querySelector('[aria-label="Relative path"]')).toBeNull();
		expect(document.activeElement).toBe(root.querySelector('[aria-label="Edit path (Ctrl+L)"]'));
		pending.resolve({ path: "slow", kind: "directory", chain: [{ path: "slow", name: "slow", kind: "directory" }] });
		await tick();
		expect(root.querySelector('[aria-label="Current absolute path"]')?.textContent).toBe("C:/Users/tester/worktrees/bobbit");
		expect(root.querySelector('[data-path="slow"]')).toBeNull();
	});

	it("shows distinct path failures and retries a timeout without losing browse state", async () => {
		let failure: { code: string; retryable: boolean } | undefined = { code: "NOT_FOUND", retryable: false };
		const fakeHost = host({
			list: () => list([{ path: "keep.txt", name: "keep.txt", kind: "file" }]),
			resolve: ({ path }) => {
				if (failure) throw failure;
				return { path, kind: "directory", chain: [{ path, name: path, kind: "directory" }] };
			},
			read: () => ({ kind: "text", text: "keep" }),
			diff: () => ({ kind: "empty" }),
		});
		const root = mount("path-failures", fakeHost);
		await tick();
		click(row(root, "keep.txt"));
		await tick();
		click(root.querySelector('[aria-label="Edit path (Ctrl+L)"]')!);
		await tick();
		let input = root.querySelector<HTMLInputElement>('[aria-label="Relative path"]')!;
		input.value = "missing";
		key(input, "Enter");
		await tick();
		expect(root.textContent).toContain("No file or folder exists at this path.");
		expect(row(root, "keep.txt").getAttribute("aria-selected")).toBe("true");

		for (const [code, message] of [
			["NOT_DIRECTORY", "This path is not a folder."],
			["UNSUPPORTED_FILE", "This item cannot be opened. It can still be revealed in the tree."],
		] as const) {
			failure = { code, retryable: false };
			input = root.querySelector<HTMLInputElement>('[aria-label="Relative path"]')!;
			input.value = code.toLowerCase();
			input.dispatchEvent(new InputEvent("input", { bubbles: true }));
			key(input, "Enter");
			await tick();
			expect(root.textContent).toContain(message);
		}
		failure = { code: "FS_TIMEOUT", retryable: true };
		input = root.querySelector<HTMLInputElement>('[aria-label="Relative path"]')!;
		input.value = "eventual";
		input.dispatchEvent(new InputEvent("input", { bubbles: true }));
		key(input, "Enter");
		await tick();
		expect(root.textContent).toContain("Path lookup timed out.");
		failure = undefined;
		click(root.querySelector('[data-action="retry-path"]')!);
		await tick();
		expect(root.querySelector('[aria-label="Current absolute path"]')?.textContent).toContain("eventual");
	});

	it("keeps a navigated directory location through refresh while preserving the selected preview", async () => {
		const fakeHost = host({
			list: () => list([{ path: "folder", name: "folder", kind: "directory" }, { path: "keep.txt", name: "keep.txt", kind: "file" }]),
			resolve: ({ path }) => ({ path, kind: "directory", chain: [{ path, name: path, kind: "directory" }] }),
			read: () => ({ kind: "text", text: "selected preview" }),
			diff: () => ({ kind: "empty" }),
		});
		const root = mount("location-refresh", fakeHost);
		await tick();
		click(row(root, "keep.txt"));
		await tick();
		click(root.querySelector('[aria-label="Edit path (Ctrl+L)"]')!);
		await tick();
		const input = root.querySelector<HTMLInputElement>('[aria-label="Relative path"]')!;
		input.value = "folder";
		key(input, "Enter");
		await tick();
		expect(root.querySelector('[aria-label="Current absolute path"]')?.textContent).toContain("folder");
		await createFileExplorerPanel().refresh?.({ __sessionId: "location-refresh" }, fakeHost as Parameters<ReturnType<typeof createFileExplorerPanel>["render"]>[1]);
		await tick();
		expect(root.querySelector('[aria-label="Current absolute path"]')?.textContent).toContain("folder");
		expect(root.querySelector(".bb-explorer-preview-path")?.textContent).toBe("keep.txt");
		expect(root.textContent).toContain("selected preview");
	});

	it("reveals clean direct targets by disabling changed-only and leaves resolved directories collapsed until activation", async () => {
		const fakeHost = host({
			list: ({ path }) => path === "clean"
				? list([{ path: "clean/child.txt", name: "child.txt", kind: "file" }])
				: list([{ path: "clean", name: "clean", kind: "directory" }, { path: "changed.txt", name: "changed.txt", kind: "file" }], [{ path: "changed.txt", index: "M" }]),
			resolve: ({ path }) => ({ path, kind: "directory", chain: [{ path, name: path, kind: "directory" }] }),
			read: () => ({ kind: "text", text: "preview" }),
			diff: () => ({ kind: "empty" }),
		});
		const root = mount("changed-reveal", fakeHost);
		await tick();
		click(root.querySelector('[aria-label="Changed files only"]')!);
		expect(root.querySelector('[data-path="clean"]')).toBeNull();
		click(root.querySelector('[aria-label="Edit path (Ctrl+L)"]')!);
		await tick();
		const input = root.querySelector<HTMLInputElement>('[aria-label="Relative path"]')!;
		input.value = "clean";
		key(input, "Enter");
		await tick();
		expect(root.querySelector('[aria-label="Changed files only"]')?.getAttribute("aria-pressed")).toBe("false");
		expect(root.querySelector('[role="status"]')?.textContent).toBe("Showing all files so the requested path can be revealed.");
		expect(row(root, "clean").getAttribute("aria-expanded")).toBe("false");
		expect(fakeHost.callRoute.mock.calls.filter(([name, init]) => name === "list" && (init?.body as Record<string, unknown>)?.path === "clean")).toHaveLength(0);
		click(row(root, "clean"));
		await tick();
		expect(row(root, "clean").getAttribute("aria-expanded")).toBe("true");
		expect(row(root, "clean/child.txt")).not.toBeNull();
	});

	it("debounces recursive search, fences stale responses, supports keyboard activation, and restores browse state on clear", async () => {
		const stale = deferred<unknown>();
		const fakeHost = host({
			list: ({ path }) => path === "src"
				? list([{ path: "src/original.txt", name: "original.txt", kind: "file" }])
				: list([{ path: "src", name: "src", kind: "directory" }]),
			search: ({ query }) => query === "old" ? stale.promise : {
				query, count: 2, limit: 200, truncated: false, results: [
					{ path: "api/index.ts", name: "index.ts", kind: "file" },
					{ path: "web/index.ts", name: "index.ts", kind: "file" },
				],
			},
			resolve: ({ path }) => ({ path, kind: "file", chain: [
				{ path: String(path).split("/")[0], name: String(path).split("/")[0], kind: "directory" },
				{ path, name: String(path).split("/").pop(), kind: "file" },
			] }),
			read: ({ path }) => ({ kind: "text", text: `opened ${path}` }),
			diff: () => ({ kind: "empty" }),
		});
		const root = mount("recursive-search", fakeHost);
		await tick();
		click(row(root, "src"));
		await tick();
		click(row(root, "src/original.txt"));
		await tick();
		const search = root.querySelector<HTMLInputElement>('[aria-label="Search files and folders"]')!;
		search.value = "old";
		search.dispatchEvent(new InputEvent("input", { bubbles: true }));
		await tick(220);
		search.value = "index";
		search.dispatchEvent(new InputEvent("input", { bubbles: true }));
		await tick(220);
		expect(root.querySelector('[role="listbox"]')).not.toBeNull();
		expect(root.querySelectorAll('[role="option"]')).toHaveLength(2);
		expect(root.textContent).toContain("api");
		expect(root.textContent).toContain("web");
		stale.resolve({ query: "old", count: 1, limit: 200, truncated: false, results: [{ path: "stale.txt", name: "stale.txt", kind: "file" }] });
		await tick();
		expect(root.textContent).not.toContain("stale.txt");
		key(search, "ArrowDown");
		key(search, "Enter");
		await tick();
		expect(root.textContent).toContain("opened api/index.ts");
		key(search, "Escape");
		await tick();
		expect(root.querySelector('[role="tree"]')).not.toBeNull();
		expect(row(root, "src/original.txt").getAttribute("aria-selected")).toBe("true");
		expect(root.textContent).toContain("opened src/original.txt");
	});

	it("restarts an in-flight file preview when search clear restores its browse snapshot", async () => {
		const originalRead = deferred<unknown>();
		const restoredRead = deferred<unknown>();
		let readCalls = 0;
		const fakeHost = host({
			list: ({ path }) => path === "src"
				? list([{ path: "src/original.txt", name: "original.txt", kind: "file" }])
				: list([{ path: "src", name: "src", kind: "directory" }]),
			search: ({ query }) => ({ query, count: 0, limit: 200, truncated: false, results: [] }),
			read: () => ++readCalls === 1 ? originalRead.promise : restoredRead.promise,
			diff: () => ({ kind: "empty" }),
		});
		const root = mount("search-clear-loading-file", fakeHost);
		await tick();
		click(row(root, "src"));
		await tick();
		click(row(root, "src/original.txt"));
		await tick();
		expect(root.textContent).toContain("Loading file…");

		const search = root.querySelector<HTMLInputElement>('[aria-label="Search files and folders"]')!;
		search.value = "missing";
		search.dispatchEvent(new InputEvent("input", { bubbles: true }));
		await tick(220);
		click(root.querySelector('[aria-label="Clear search"]')!);
		await tick();

		expect(readCalls).toBe(2);
		expect(search.value).toBe("");
		expect(row(root, "src").getAttribute("aria-expanded")).toBe("true");
		expect(row(root, "src/original.txt").getAttribute("aria-selected")).toBe("true");
		expect(root.querySelector('[aria-label="Current absolute path"]')?.textContent).toContain("C:/Users/tester/worktrees/bobbit/src/original.txt");
		originalRead.resolve({ kind: "text", text: "stale original read" });
		await tick();
		expect(root.textContent).toContain("Loading file…");
		expect(root.textContent).not.toContain("stale original read");

		restoredRead.resolve({ kind: "text", text: "restored file preview" });
		await tick();
		expect(root.textContent).toContain("restored file preview");
		expect(root.textContent).not.toContain("Loading file…");
	});

	it("restarts an in-flight diff preview when search clear restores its browse snapshot", async () => {
		const originalDiff = deferred<unknown>();
		const restoredDiff = deferred<unknown>();
		let diffCalls = 0;
		const fakeHost = host({
			list: ({ path }) => path === "src"
				? list([{ path: "src/changed.ts", name: "changed.ts", kind: "file" }])
				: list([{ path: "src", name: "src", kind: "directory" }], [{ path: "src/changed.ts", index: "M" }]),
			search: ({ query }) => ({ query, count: 0, limit: 200, truncated: false, results: [] }),
			read: () => ({ kind: "text", text: "working tree file" }),
			diff: () => ++diffCalls === 1 ? originalDiff.promise : restoredDiff.promise,
		});
		const root = mount("search-clear-loading-diff", fakeHost);
		await tick();
		click(row(root, "src"));
		await tick();
		click(row(root, "src/changed.ts"));
		await tick();
		click(root.querySelector('[data-action="view-diff"]')!);
		await tick();
		expect(root.textContent).toContain("Loading diff…");

		const search = root.querySelector<HTMLInputElement>('[aria-label="Search files and folders"]')!;
		search.value = "missing";
		search.dispatchEvent(new InputEvent("input", { bubbles: true }));
		await tick(220);
		click(root.querySelector('[aria-label="Clear search"]')!);
		await tick();

		expect(diffCalls).toBe(2);
		expect(search.value).toBe("");
		expect(row(root, "src").getAttribute("aria-expanded")).toBe("true");
		expect(row(root, "src/changed.ts").getAttribute("aria-selected")).toBe("true");
		expect(root.querySelector('[aria-label="Current absolute path"]')?.textContent).toContain("C:/Users/tester/worktrees/bobbit/src/changed.ts");
		expect(root.querySelector('[data-action="view-diff"]')?.getAttribute("aria-selected")).toBe("true");
		originalDiff.resolve({ kind: "text", text: "stale original diff" });
		await tick();
		expect(root.textContent).toContain("Loading diff…");
		expect(root.textContent).not.toContain("stale original diff");

		restoredDiff.resolve({
			kind: "text",
			text: "diff --git a/src/changed.ts b/src/changed.ts\n--- a/src/changed.ts\n+++ b/src/changed.ts\n@@ -1 +1 @@\n-before\n+restored after clear\n",
		});
		await tick();
		expect(root.textContent).toContain("+restored after clear");
		expect(root.textContent).not.toContain("Loading diff…");
	});

	it("keeps Changed files only active while a clean search file is previewed and restores the filtered snapshot", async () => {
		const put = vi.fn(async (_key: string, _value: unknown) => undefined);
		const fakeHost = host({
			list: () => list([
				{ path: "changed.txt", name: "changed.txt", kind: "file" },
				{ path: "clean.txt", name: "clean.txt", kind: "file" },
			], [{ path: "changed.txt", index: "M" }]),
			search: ({ query }) => ({
				query, count: 1, limit: 200, truncated: false,
				results: [{ path: "clean.txt", name: "clean.txt", kind: "file" }],
			}),
			resolve: ({ path }) => ({ path, kind: "file", chain: [{ path, name: path, kind: "file" }] }),
			read: ({ path }) => ({ kind: "text", text: `opened ${path}` }),
			diff: () => ({ kind: "empty" }),
		}, { put });
		const root = mount("search-keeps-filter", fakeHost);
		await tick();
		click(row(root, "changed.txt"));
		await tick();
		click(root.querySelector('[aria-label="Changed files only"]')!);
		await tick(200);
		put.mockClear();

		const search = root.querySelector<HTMLInputElement>('[aria-label="Search files and folders"]')!;
		search.value = "clean";
		search.dispatchEvent(new InputEvent("input", { bubbles: true }));
		await tick(220);
		key(search, "Enter");
		await tick(200);

		expect(root.querySelector('[aria-label="Changed files only"]')?.getAttribute("aria-pressed")).toBe("true");
		expect(root.textContent).toContain("Search includes all files.");
		expect(root.textContent).toContain("opened clean.txt");
		expect(put.mock.calls.some(([, value]) => (value as { changedOnly?: boolean }).changedOnly === false)).toBe(false);

		click(root.querySelector('[aria-label="Clear search"]')!);
		await tick();
		expect(root.querySelector('[aria-label="Changed files only"]')?.getAttribute("aria-pressed")).toBe("true");
		expect(row(root, "changed.txt").getAttribute("aria-selected")).toBe("true");
		expect(root.querySelector('[data-path="clean.txt"]')).toBeNull();
		expect(root.textContent).toContain("opened changed.txt");
	});

	it("persists a restored browse snapshot after search clear and lets directory navigation supersede that write", async () => {
		let persisted: unknown;
		const put = vi.fn(async (_key: string, value: unknown) => { persisted = value; });
		const routes = {
			list: ({ path }: Record<string, unknown>) => path === "src"
				? list([{ path: "src/original.txt", name: "original.txt", kind: "file" }])
				: list([{ path: "src", name: "src", kind: "directory" }]),
			search: ({ query }: Record<string, unknown>) => ({
				query, count: 1, limit: 200, truncated: false,
				results: query === "folder"
					? [{ path: "destination", name: "destination", kind: "directory" }]
					: [{ path: "result.txt", name: "result.txt", kind: "file" }],
			}),
			resolve: ({ path }: Record<string, unknown>) => ({ path, kind: path === "destination" ? "directory" : "file", chain: [
				{ path, name: path, kind: path === "destination" ? "directory" : "file" },
			] }),
			read: ({ path }: Record<string, unknown>) => ({ kind: "text", text: `opened ${path}` }),
			diff: () => ({ kind: "empty" }),
		};
		const fakeHost = host(routes, { put });
		const root = mount("search-clear-persistence", fakeHost);
		await tick();
		click(row(root, "src"));
		await tick();
		click(row(root, "src/original.txt"));
		await tick(200);
		const search = root.querySelector<HTMLInputElement>('[aria-label="Search files and folders"]')!;
		search.value = "file";
		search.dispatchEvent(new InputEvent("input", { bubbles: true }));
		await tick(220);
		key(search, "Enter");
		await tick(200);
		expect(persisted).toEqual(expect.objectContaining({ selected: "result.txt", focused: "result.txt" }));

		click(root.querySelector('[aria-label="Clear search"]')!);
		await tick(200);
		expect(persisted).toEqual(expect.objectContaining({ expanded: ["src"], selected: "src/original.txt", focused: "src/original.txt" }));
		const restoredHost = host(routes, { stored: persisted });
		const restored = mount("search-clear-remount", restoredHost);
		await tick();
		expect(row(restored, "src").getAttribute("aria-expanded")).toBe("true");
		expect(row(restored, "src/original.txt").getAttribute("aria-selected")).toBe("true");
		expect(restored.querySelector<HTMLInputElement>('[aria-label="Search files and folders"]')?.value).toBe("");
		expect(restored.querySelector('[role="listbox"]')).toBeNull();

		search.value = "folder";
		search.dispatchEvent(new InputEvent("input", { bubbles: true }));
		await tick(220);
		click(root.querySelector('[role="option"][data-path="destination"]')!);
		await tick(200);
		expect(persisted).toEqual(expect.objectContaining({ selected: "src/original.txt", focused: "destination" }));
	});

	it("renders bounded search states, fences cleared work, and wraps composite keyboard navigation", async () => {
		const pending = deferred<unknown>();
		let timeoutFails = true;
		const fakeHost = host({
			list: () => list([{ path: "browse.txt", name: "browse.txt", kind: "file" }]),
			search: ({ query }) => {
				if (query === "pending") return pending.promise;
				if (query === "empty") return { query, count: 0, limit: 200, truncated: false, results: [] };
				if (query === "many") return { query, count: 20, limit: 2, truncated: true, results: [
					{ path: "a.txt", name: "a.txt", kind: "file" }, { path: "z.txt", name: "z.txt", kind: "file" },
				] };
				if (query === "timeout" && timeoutFails) throw { code: "FS_TIMEOUT", retryable: true };
				if (query === "denied") throw { code: "READ_FAILED", retryable: false };
				return { query, count: 1, limit: 200, truncated: false, results: [{ path: "ok.txt", name: "ok.txt", kind: "file" }] };
			},
			resolve: ({ path }) => ({ path, kind: "file", chain: [{ path, name: path, kind: "file" }] }),
			read: () => ({ kind: "text", text: "preview" }),
			diff: () => ({ kind: "empty" }),
		});
		const root = mount("search-states", fakeHost);
		await tick();
		const search = root.querySelector<HTMLInputElement>('[aria-label="Search files and folders"]')!;
		const submitQuery = async (query: string) => {
			search.value = query;
			search.dispatchEvent(new InputEvent("input", { bubbles: true }));
			await tick(220);
		};

		await submitQuery("pending");
		expect(search.getAttribute("aria-busy")).toBe("true");
		expect(root.textContent).toContain("Searching…");
		click(root.querySelector('[aria-label="Clear search"]')!);
		expect(root.querySelector('[role="tree"]')?.getAttribute("aria-busy")).toBe("false");
		expect(row(root, "browse.txt")).not.toBeNull();
		pending.resolve({ query: "pending", count: 1, limit: 200, truncated: false, results: [{ path: "late.txt", name: "late.txt", kind: "file" }] });
		await tick();
		expect(root.querySelector('[role="listbox"]')).toBeNull();
		expect(root.querySelector('[role="tree"]')?.getAttribute("aria-busy")).toBe("false");
		expect(row(root, "browse.txt")).not.toBeNull();
		expect(root.textContent).not.toContain("late.txt");

		await submitQuery("empty");
		expect(root.textContent).toContain("No files or folders match “empty”.");
		await submitQuery("many");
		expect(root.textContent).toContain("Showing the first 2 results. More matches exist.");
		key(search, "ArrowUp");
		expect(search.getAttribute("aria-activedescendant")).toContain("option-1");
		key(search, "ArrowDown");
		expect(search.getAttribute("aria-activedescendant")).toContain("option-0");
		search.dispatchEvent(new KeyboardEvent("keydown", { key: "End", ctrlKey: true, bubbles: true, cancelable: true }));
		expect(search.getAttribute("aria-activedescendant")).toContain("option-1");
		search.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", ctrlKey: true, bubbles: true, cancelable: true }));
		expect(search.getAttribute("aria-activedescendant")).toContain("option-0");

		await submitQuery("timeout");
		expect(root.textContent).toContain("Search timed out.");
		expect(root.querySelector('[data-action="retry-search"]')).not.toBeNull();
		timeoutFails = false;
		click(root.querySelector('[data-action="retry-search"]')!);
		await tick();
		expect(root.textContent).toContain("1 result");
		await submitQuery("denied");
		expect(root.textContent).toContain("Couldn’t search Session files.");
		expect(root.querySelector('[data-action="retry-search"]')).toBeNull();
	});

	it("returns narrow search previews to the combobox for keyboard and pointer activation", async () => {
		class FakeResizeObserver {
			constructor(private readonly callback: (entries: Array<{ contentRect: { width: number } }>) => void) {}
			observe() { this.callback([{ contentRect: { width: 500 } }]); }
			disconnect() {}
		}
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		const fakeHost = host({
			list: () => list([{ path: "browse.txt", name: "browse.txt", kind: "file" }]),
			search: ({ query }) => ({
				query, count: 1, limit: 200, truncated: false,
				results: [{ path: "nested/result.txt", name: "result.txt", kind: "file" }],
			}),
			resolve: ({ path }) => ({ path, kind: "file", chain: [
				{ path: "nested", name: "nested", kind: "directory" },
				{ path, name: "result.txt", kind: "file" },
			] }),
			read: () => ({ kind: "text", text: "narrow search preview" }),
			diff: () => ({ kind: "empty" }),
		});
		const root = mount("narrow-search-focus", fakeHost);
		await tick();
		const search = root.querySelector<HTMLInputElement>('[aria-label="Search files and folders"]')!;
		const searchForResult = async () => {
			search.value = "result";
			search.dispatchEvent(new InputEvent("input", { bubbles: true }));
			await tick(220);
		};

		await searchForResult();
		key(search, "ArrowDown");
		const activeDescendant = search.getAttribute("aria-activedescendant");
		key(search, "Enter");
		await tick();
		expect(root.dataset.narrowPane).toBe("preview");
		click(root.querySelector('[aria-label="Back to files"]')!);
		await tick();
		expect(document.activeElement).toBe(search);
		expect(search.getAttribute("aria-activedescendant")).toBe(activeDescendant);
		key(search, "ArrowDown");
		expect(search.getAttribute("aria-activedescendant")).toBe(activeDescendant);
		key(search, "Escape");
		expect(search.value).toBe("");
		expect(root.querySelector('[role="tree"]')?.getAttribute("aria-busy")).toBe("false");

		await searchForResult();
		click(root.querySelector('[role="option"][data-path="nested/result.txt"]')!);
		await tick();
		expect(root.dataset.narrowPane).toBe("preview");
		click(root.querySelector('[aria-label="Back to files"]')!);
		await tick();
		expect(document.activeElement).toBe(search);
		expect(search.getAttribute("aria-activedescendant")).toContain("option-0");
	});

	it("filters changed paths, collapses all with a valid tree tab stop, and persists only the durable preference", async () => {
		const put = vi.fn(async () => undefined);
		const fakeHost = host({
			list: ({ path }) => path === "src"
				? list([{ path: "src/changed.ts", name: "changed.ts", kind: "file" }, { path: "src/clean.ts", name: "clean.ts", kind: "file" }])
				: list([{ path: "src", name: "src", kind: "directory" }, { path: "clean.txt", name: "clean.txt", kind: "file" }], [
					{ path: "src/changed.ts", index: "M" }, { path: "gone/deleted.ts", worktree: "D", deleted: true },
				]),
			read: () => ({ kind: "text", text: "preview" }),
			diff: () => ({ kind: "empty" }),
		}, { put });
		const root = mount("changed-collapse", fakeHost);
		await tick();
		click(row(root, "src"));
		await tick();
		click(root.querySelector('[aria-label="Changed files only"]')!);
		await tick();
		expect(root.querySelector('[aria-label="Changed files only"]')?.getAttribute("aria-pressed")).toBe("true");
		expect(row(root, "src/changed.ts")).not.toBeNull();
		expect(root.querySelector('[data-path="src/clean.ts"]')).toBeNull();
		expect(row(root, "gone")).not.toBeNull();
		const collapse = root.querySelector<HTMLButtonElement>('[aria-label="Collapse all"]')!;
		collapse.focus();
		click(collapse);
		await tick();
		expect(document.activeElement).toBe(collapse);
		expect(collapse.getAttribute("aria-disabled")).toBe("true");
		expect(row(root, "src").getAttribute("aria-expanded")).toBe("false");
		expect(root.querySelectorAll('[role="treeitem"][tabindex="0"]')).toHaveLength(1);
		expect(root.querySelector('[role="status"]')?.textContent).toBe("All folders collapsed.");
		await tick(200);
		expect(put).toHaveBeenLastCalledWith("ui/changed-collapse", expect.objectContaining({ changedOnly: true, expanded: [] }));
		const lastStored = (put.mock.calls.at(-1) as unknown as [string, unknown] | undefined)?.[1];
		expect(JSON.stringify(lastStored)).not.toContain("query");
	});

	it("suspends a restored changed-only preference while Git is unavailable, distinguishes non-Git, and recovers", async () => {
		let git: Record<string, unknown> = { kind: "unavailable", error: { code: "GIT_TIMEOUT", retryable: true } };
		const fakeHost = host({
			list: () => ({
				entries: [{ path: "clean.txt", name: "clean.txt", kind: "file" }, { path: "changed.txt", name: "changed.txt", kind: "file" }],
				truncated: false,
				git,
			}),
			read: () => ({ kind: "text", text: "preview" }),
			diff: () => ({ kind: "empty" }),
		}, { stored: { version: 1, expanded: [], view: "file", changedOnly: true } });
		const root = mount("git-availability", fakeHost);
		await tick();
		const changed = root.querySelector<HTMLButtonElement>('[aria-label="Changed files only"]')!;
		expect(changed.disabled).toBe(true);
		expect(changed.getAttribute("aria-pressed")).toBe("true");
		expect(changed.title).toContain("temporarily unavailable");
		expect(row(root, "clean.txt")).not.toBeNull();

		git = { kind: "none" };
		await createFileExplorerPanel().refresh?.({ __sessionId: "git-availability" }, fakeHost as Parameters<ReturnType<typeof createFileExplorerPanel>["render"]>[1]);
		await tick();
		expect(changed.disabled).toBe(true);
		expect(changed.title).toContain("not a Git worktree");
		expect(row(root, "clean.txt")).not.toBeNull();

		git = { kind: "git", head: "present", entries: [{ path: "changed.txt", index: "M" }] };
		await createFileExplorerPanel().refresh?.({ __sessionId: "git-availability" }, fakeHost as Parameters<ReturnType<typeof createFileExplorerPanel>["render"]>[1]);
		await tick();
		expect(changed.disabled).toBe(false);
		expect(changed.getAttribute("aria-pressed")).toBe("true");
		expect(root.querySelector('[data-path="clean.txt"]')).toBeNull();
		expect(row(root, "changed.txt")).not.toBeNull();
	});

	it("fences old-root list, search, and preview responses after rebasing", async () => {
		const oldList = deferred<unknown>();
		const oldSearch = deferred<unknown>();
		const oldRead = deferred<unknown>();
		const nextRoot = "C:\\Users\\tester\\other";
		const fakeHost = host({
			list: ({ path, rootPath }) => rootPath === nextRoot
				? { rootPath: nextRoot, entries: [{ path: "fresh.txt", name: "fresh.txt", kind: "file" }], truncated: false, git: { kind: "none" } }
				: path === "folder" ? oldList.promise : list([
					{ path: "folder", name: "folder", kind: "directory" },
					{ path: "old.txt", name: "old.txt", kind: "file" },
				]),
			read: () => oldRead.promise,
			search: () => oldSearch.promise,
			resolve: ({ absolutePath }) => absolutePath === nextRoot
				? { path: "", rootPath: nextRoot, kind: "root", chain: [] }
				: { path: "", kind: "root", chain: [] },
		});
		const root = mount("root-response-fence", fakeHost);
		await tick();

		click(row(root, "folder"));
		click(row(root, "old.txt"));
		await tick();
		const search = root.querySelector<HTMLInputElement>('[aria-label="Search files and folders"]')!;
		search.value = "stale";
		search.dispatchEvent(new InputEvent("input", { bubbles: true }));
		await tick(220);
		click(root.querySelector('[aria-label="Edit path (Ctrl+L)"]')!);
		await tick();
		const input = root.querySelector<HTMLInputElement>('[aria-label="Relative path"]')!;
		input.value = "C:/Users/tester/other";
		key(input, "Enter");
		await tick();
		await tick();

		oldList.resolve(list([{ path: "folder/stale.ts", name: "stale.ts", kind: "file" }]));
		oldSearch.resolve({ query: "stale", results: [{ path: "stale-search.ts", name: "stale-search.ts", kind: "file" }], count: 1, truncated: false });
		oldRead.resolve({ kind: "text", text: "stale preview" });
		await tick();
		await tick();

		expect(root.querySelector('[aria-label="Current absolute path"]')?.textContent).toBe("C:/Users/tester/other");
		expect(row(root, "fresh.txt")).not.toBeNull();
		expect(root.textContent).not.toContain("stale.ts");
		expect(root.textContent).not.toContain("stale-search.ts");
		expect(root.textContent).not.toContain("stale preview");
		expect(root.querySelector<HTMLInputElement>('[aria-label="Search files and folders"]')?.value).toBe("");
	});

	it("sets a real directory as the explorer root from its context menu", async () => {
		const nextRoot = "C:\\Users\\tester\\worktrees\\bobbit\\folder";
		const fakeHost = host({
			list: ({ rootPath }) => rootPath === nextRoot
				? { rootPath: nextRoot, entries: [{ path: "inside.txt", name: "inside.txt", kind: "file" }], truncated: false, git: { kind: "none" } }
				: list([{ path: "folder", name: "folder", kind: "directory" }]),
			resolve: ({ absolutePath }) => absolutePath === nextRoot
				? { path: "", rootPath: nextRoot, kind: "root", chain: [] }
				: { path: "", kind: "root", chain: [] },
		});
		const root = mount("set-directory-root", fakeHost);
		await tick();

		row(root, "folder").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 16 }));
		await tick();
		expect([...root.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(["Set root", "Copy relative path", "Copy folder name"]);
		click([...root.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Set root")!);
		await tick();
		await tick();

		expect(fakeHost.callRoute).toHaveBeenCalledWith("resolve", expect.objectContaining({ body: { absolutePath: nextRoot } }));
		expect(root.querySelector('[aria-label="Current absolute path"]')?.textContent).toBe("C:/Users/tester/worktrees/bobbit/folder");
		expect(row(root, "inside.txt")).not.toBeNull();
		expect(root.querySelector('[data-path="folder"]')).toBeNull();
	});

	it("opens row path actions by mouse and keyboard, copies both canonical values, and reports clipboard failure", async () => {
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		const fakeHost = host({
			list: () => list([
				{ path: "one.txt", name: "one.txt", kind: "file" },
				{ path: "folder/two.ts", name: "two.ts", kind: "file" },
			]),
			read: ({ path }) => ({ kind: "text", text: String(path) }),
			diff: () => ({ kind: "empty" }),
		});
		const root = mount("path-actions", fakeHost);
		await tick();
		click(row(root, "one.txt"));
		await tick();
		row(root, "one.txt").focus();
		row(root, "folder/two.ts").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 16 }));
		await tick();
		expect(root.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("Path actions");
		let items = [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
		expect(document.activeElement).toBe(items[0]);
		key(items[0], "ArrowUp");
		expect(document.activeElement).toBe(items[1]);
		key(items[1], "Home");
		expect(document.activeElement).toBe(items[0]);
		key(items[0], "End");
		expect(document.activeElement).toBe(items[1]);
		key(items[1], "Escape");
		await tick();
		expect(root.querySelector('[role="menu"]')).toBeNull();
		expect(document.activeElement).toBe(row(root, "one.txt"));

		row(root, "folder/two.ts").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 16 }));
		await tick();
		document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
		expect(root.querySelector('[role="menu"]')).not.toBeNull();
		click(document.body);
		await tick();
		expect(root.querySelector('[role="menu"]')).toBeNull();
		expect(document.activeElement).toBe(row(root, "one.txt"));

		row(root, "folder/two.ts").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 16 }));
		await tick();
		click([...root.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Copy relative path")!);
		await tick();
		expect(writeText).toHaveBeenCalledWith("folder/two.ts");
		expect(row(root, "one.txt").getAttribute("aria-selected")).toBe("true");

		const selected = row(root, "one.txt");
		selected.focus();
		selected.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
		await tick();
		click([...root.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Copy filename")!);
		await tick();
		expect(writeText).toHaveBeenCalledWith("one.txt");
		writeText.mockRejectedValueOnce(new Error("denied"));
		selected.dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }));
		await tick();
		items = [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
		key(items[0], "Tab");
		await tick();
		expect(root.querySelector('[role="menu"]')).toBeNull();
		expect(document.activeElement).toBe(selected);

		selected.dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }));
		await tick();
		click(root.querySelector('[role="menuitem"]')!);
		await tick();
		expect(root.textContent).toContain("Couldn’t copy. Clipboard access is unavailable.");
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
		selected.dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }));
		await tick();
		click(root.querySelector('[role="menuitem"]')!);
		await tick();
		expect(root.textContent).toContain("Couldn’t copy. Clipboard access is unavailable.");
	});

	it("keeps path actions stable across a late lazy-tree render and lets the action click close first", async () => {
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		const folderList = deferred<unknown>();
		const fakeHost = host({
			list: ({ path }) => path === "folder"
				? folderList.promise
				: list([{ path: "folder", name: "folder", kind: "directory" }], [
					{ path: "folder/deleted.ts", worktree: "D", deleted: true },
				]),
			read: () => ({ kind: "text", text: "preview" }),
			diff: () => ({ kind: "empty" }),
		});
		const root = mount(`late-list-path-actions-${++mountAttempt}`, fakeHost);
		await tick();

		const folder = row(root, "folder");
		folder.focus();
		click(folder);
		await tick();
		const deleted = row(root, "folder/deleted.ts");
		deleted.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 16 }));
		await tick();
		const copyPath = [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === "Copy relative path")!;

		folderList.resolve(list([]));
		await vi.waitFor(() => expect(row(root, "folder").hasAttribute("aria-busy")).toBe(false));
		expect(root.querySelector('[role="menu"]')).not.toBeNull();
		expect(row(root, "folder/deleted.ts").classList.contains("is-context-target")).toBe(true);

		const order: string[] = [];
		copyPath.addEventListener("click", () => order.push(`item:${root.querySelector('[role="menu"]') === null ? "closed" : "open"}`), { once: true });
		document.addEventListener("click", () => order.push(`document:${root.querySelector('[role="menu"]') === null ? "closed" : "open"}`), { once: true });
		copyPath.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, composed: true }));
		copyPath.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, composed: true }));
		copyPath.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
		await tick();

		expect(order).toEqual(["item:closed", "document:closed"]);
		expect(writeText).toHaveBeenCalledWith("folder/deleted.ts");
		expect(document.activeElement).toBe(row(root, "folder"));
	});

	it("keeps narrow controls wrap-safe without fixed-height clipping", async () => {
		const fakeHost = host({
			list: () => list([{ path: "file.txt", name: "file.txt", kind: "file" }]),
			read: () => ({ kind: "text", text: "preview" }),
			diff: () => ({ kind: "empty" }),
		});
		const root = mount("narrow-wrap", fakeHost);
		await tick();
		const styles = document.getElementById("bb-file-explorer-styles")?.textContent ?? "";
		expect(styles).toContain("@media (max-width:300px)");
		expect(styles).toContain(".bb-explorer-search{flex-basis:100%}");
		expect(getComputedStyle(root.querySelector(".bb-explorer-tree-toolbar")!).height).not.toMatch(/^\d+px$/);
		expect(getComputedStyle(root.querySelector(".bb-explorer-tree-pane")!).minHeight).toBe("0");
	});

	it("maps structured route failures to safe, retryable panel errors", () => {
		expect(mapRouteFailure({ routeError: { code: "FS_TIMEOUT", message: "raw absolute path", retryable: true } }, "fallback")).toEqual({
			code: "FS_TIMEOUT", message: "The file operation timed out.", retryable: true,
		});
		expect(mapRouteFailure({ status: 503, message: "Unavailable" }, "fallback")).toEqual({
			code: "503", message: "Unavailable", retryable: true,
		});
	});
});
