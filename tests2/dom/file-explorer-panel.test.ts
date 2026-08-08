import { afterEach, describe, expect, it, vi } from "vitest";
import createFileExplorerPanel, { mapRouteFailure } from "../../market-packs/file-explorer/src/file-explorer-panel.js";

type Entry = { path: string; name: string; kind: "directory" | "file" | "symlink" | "other" };
type Status = Record<string, unknown> & { path: string };
type RouteHandler = (body: Record<string, unknown>) => unknown | Promise<unknown>;

const mounted: HTMLElement[] = [];
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
const list = (entries: Entry[], statuses: Status[] = [], truncated = false) => ({ entries, truncated, git: { kind: "repository", entries: statuses } });

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

afterEach(async () => {
	for (const root of mounted.splice(0)) root.remove();
	await tick();
	vi.restoreAllMocks();
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
		expect(row(root, "src").getAttribute("aria-expanded")).toBe("false");
		expect(row(root, "src").getAttribute("aria-level")).toBe("1");
		expect(row(root, "src").querySelector('[aria-label="Contains changes"]')).not.toBeNull();
		expect(root.querySelectorAll('[role="treeitem"][tabindex="0"]')).toHaveLength(1);

		click(row(root, "src"));
		await tick();
		expect(row(root, "src").getAttribute("aria-expanded")).toBe("true");
		expect(root.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("src contents");
		expect(row(root, "src/app.ts").getAttribute("aria-level")).toBe("2");
		expect(row(root, "src/app.ts").querySelector(".bb-explorer-badges")?.getAttribute("aria-label")).toBe("Staged copied from src/base.ts, Unstaged modified");

		click(row(root, "src/app.ts"));
		await tick();
		expect(row(root, "src/app.ts").getAttribute("aria-selected")).toBe("true");
		expect(root.querySelector(".bb-explorer-preview-path")?.textContent).toBe("src/app.ts");
		expect(root.textContent).toContain("Read only");
		expect(root.querySelector('[aria-label="Read-only file contents"]')).not.toBeNull();
		expect([...root.querySelectorAll(".bb-explorer-line-number")].map((node) => node.textContent)).toEqual(["1", "2"]);
		expect(root.querySelector("textarea, input, [contenteditable=true]")).toBeNull();
		expect(fakeHost.callRoute).toHaveBeenCalledWith("list", expect.objectContaining({ body: { path: "src" } }));
		expect(fakeHost.callRoute).toHaveBeenCalledWith("read", expect.objectContaining({ body: { path: "src/app.ts" } }));
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
			const badges = row(root, path).querySelector(".bb-explorer-badges");
			expect(badges?.getAttribute("aria-label")).toBe("Conflict");
			expect(badges?.querySelectorAll(".bb-explorer-badge")).toHaveLength(1);
			expect(badges?.textContent).toBe("!");
		}
		expect(row(root, "src").querySelector('[aria-label="Contains changes"]')).not.toBeNull();

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
		expect(root.textContent).toContain("−old value");
		expect(root.textContent).toContain("+new value");
		expect(fakeHost.callRoute).toHaveBeenCalledWith("diff", expect.objectContaining({ body: { path: "changed.ts" } }));
		click(root.querySelector('[data-action="view-file"]')!);
		await tick();
		expect(root.textContent).toContain("new value");
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
		expect(root.querySelector(".bb-explorer-diff-file-header")?.textContent).toBe("base.ts → copied.ts");
		expect(root.textContent).toContain("copy from base.ts");
		expect(root.textContent).toContain("copy to copied.ts");

		click(row(root, "renamed.ts"));
		await tick();
		click(root.querySelector('[data-action="view-diff"]')!);
		await tick();
		expect(root.querySelector(".bb-explorer-diff-file-header")?.textContent).toBe("old.ts → renamed.ts");
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
		await tick();
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
		click(root.querySelector('[data-testid="file-explorer-refresh"]')!);
		await tick();
		expect(root.textContent).toContain("This folder is empty.");
		expect(root.textContent).toContain("Select a file to preview");
		expect(root.querySelector('[role="status"]')?.textContent).toBe("Explorer refreshed.");

		root.remove();
		await tick();
		await tick();
		expect(statusDispose).toHaveBeenCalledTimes(1);
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
