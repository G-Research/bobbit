import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { parseUnifiedDiff, type UnifiedDiffLine } from "../../../src/shared/git-diff/unified.ts";

for (const [name, grammar] of Object.entries({ bash, css, javascript, json, markdown, python, typescript, xml, yaml })) {
	hljs.registerLanguage(name, grammar);
}

const STORE_VERSION = 1;
const STORE_DELAY_MS = 180;
const REFRESH_CONCURRENCY = 4;
const NARROW_WIDTH = 680;
const states = new Map<string, ExplorerState>();

type EntryKind = "directory" | "file" | "symlink" | "other";
type ViewMode = "file" | "diff";
type LoadState = "idle" | "loading" | "ready" | "error";
type RouteErrorCode = "INVALID_PATH" | "NOT_FOUND" | "NOT_DIRECTORY" | "NOT_FILE" | "UNSUPPORTED_FILE" | "READ_FAILED" | "FS_TIMEOUT" | "GIT_TIMEOUT" | "GIT_FAILED";

type HostApi = {
	capabilities?: { callRoute?: boolean; session?: boolean; store?: boolean };
	callRoute?<T = unknown>(name: string, init?: { method?: "GET" | "POST"; body?: unknown }): Promise<T>;
	session?: { subscribe(event: "status", cb: (value: { status: "idle" | "running" | "error" }) => void): () => void };
	store?: {
		read?<T = unknown>(key: string): Promise<{ state: "absent" } | { state: "present"; value: T } | { state: "error" }>;
		get?<T = unknown>(key: string): Promise<T | null>;
		put?<T = unknown>(key: string, value: T): Promise<void>;
	};
};

type TreeEntry = {
	path: string;
	name: string;
	kind: EntryKind;
	virtual?: boolean;
};

type StatusRecord = {
	path: string;
	oldPath?: string;
	index?: string;
	worktree?: string;
	summary?: string;
	staged?: boolean;
	unstaged?: boolean;
	added?: boolean;
	deleted?: boolean;
	renamed?: boolean;
	copied?: boolean;
	conflict?: boolean;
	untracked?: boolean;
};

type DirectoryState = {
	state: LoadState;
	entries: TreeEntry[];
	truncated: boolean;
	error?: PanelFailure;
};

type PanelFailure = {
	code?: string;
	message: string;
	retryable: boolean;
};

type PreviewState = {
	state: LoadState;
	path?: string;
	kind?: string;
	text?: string;
	language?: string;
	bytes?: number;
	limit?: number;
	error?: PanelFailure;
};

type ExplorerState = {
	sid: string;
	root: HTMLElement;
	treePane: HTMLElement;
	tree: HTMLElement;
	previewPane: HTMLElement;
	preview: HTMLElement;
	backButton: HTMLButtonElement;
	refreshButton: HTMLButtonElement;
	live: HTMLElement;
	host?: HostApi;
	directories: Map<string, DirectoryState>;
	expanded: Set<string>;
	statuses: Map<string, StatusRecord>;
	ancestors: Set<string>;
	focused: string;
	selected?: string;
	selectedKind?: EntryKind;
	view: ViewMode;
	filePreview: PreviewState;
	diffPreview: PreviewState;
	refreshGeneration: number;
	selectionGeneration: number;
	initialized: boolean;
	initializing: boolean;
	active: boolean;
	narrow: boolean;
	narrowPane: "tree" | "preview";
	lastSessionStatus?: string;
	pendingIdleRefresh: boolean;
	statusDispose?: () => void;
	resizeObserver?: ResizeObserver;
	detachObserver?: MutationObserver;
	storeTimer?: number;
	lastFocusedElement?: HTMLElement;
};

export default function createFileExplorerPanel() {
	installStyles();
	return {
		render(params: Record<string, unknown> | undefined, host: HostApi | undefined) {
			const sid = typeof params?.__sessionId === "string" ? params.__sessionId : "default";
			let state = states.get(sid);
			if (!state) {
				state = createState(sid);
				states.set(sid, state);
			}
			state.host = host;
			queueMicrotask(() => {
				activate(state!);
				subscribeToStatus(state!);
				if (host?.capabilities?.callRoute && !state!.initialized && !state!.initializing) void initialize(state!);
			});
			return state.root;
		},
	};
}

function createState(sid: string): ExplorerState {
	const root = el("section", "bb-explorer");
	root.dataset.testid = "file-explorer-panel";
	root.setAttribute("aria-label", "File explorer");

	const toolbar = el("header", "bb-explorer-toolbar");
	const titleWrap = el("div", "bb-explorer-heading");
	const title = el("strong", "bb-explorer-title", "Explorer");
	const subtitle = el("span", "bb-explorer-subtitle", "Session files");
	titleWrap.append(title, subtitle);
	const refreshButton = iconButton("refresh", "Refresh explorer", "bb-explorer-refresh");
	refreshButton.dataset.testid = "file-explorer-refresh";
	toolbar.append(titleWrap, refreshButton);

	const content = el("div", "bb-explorer-content");
	const treePane = el("aside", "bb-explorer-tree-pane");
	const treeHeader = el("div", "bb-explorer-section-title", "Files");
	const tree = el("div", "bb-explorer-tree");
	tree.dataset.testid = "file-explorer-tree";
	tree.setAttribute("role", "tree");
	tree.setAttribute("aria-label", "Files");
	tree.setAttribute("aria-busy", "true");
	treePane.append(treeHeader, tree);

	const previewPane = el("main", "bb-explorer-preview-pane");
	const backButton = iconButton("arrow-left", "Back to files", "bb-explorer-back");
	backButton.append(document.createTextNode(" Files"));
	const preview = el("div", "bb-explorer-preview");
	preview.dataset.testid = "file-explorer-preview";
	previewPane.append(backButton, preview);
	content.append(treePane, previewPane);

	const live = el("div", "bb-explorer-live");
	live.setAttribute("role", "status");
	live.setAttribute("aria-live", "polite");
	root.append(toolbar, content, live);

	const state: ExplorerState = {
		sid, root, treePane, tree, previewPane, preview, backButton, refreshButton, live,
		directories: new Map(), expanded: new Set(), statuses: new Map(), ancestors: new Set(),
		focused: "", view: "file", filePreview: idlePreview(), diffPreview: idlePreview(),
		refreshGeneration: 0, selectionGeneration: 0, initialized: false, initializing: false,
		active: false, narrow: false, narrowPane: "tree", pendingIdleRefresh: false,
	};
	refreshButton.addEventListener("click", () => void refresh(state!, true));
	backButton.addEventListener("click", () => showTree(state!, true));
	tree.addEventListener("click", (event) => onTreeClick(state!, event));
	tree.addEventListener("keydown", (event) => onTreeKeydown(state!, event));
	preview.addEventListener("click", (event) => onPreviewClick(state!, event));
	renderTree(state);
	renderPreview(state);
	return state;
}

function activate(state: ExplorerState): void {
	if (state.active) return;
	state.active = true;
	if (typeof ResizeObserver !== "undefined") {
		state.resizeObserver = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width ?? state.root.clientWidth;
			const narrow = width < NARROW_WIDTH;
			if (narrow === state.narrow) return;
			state.narrow = narrow;
			state.root.classList.toggle("is-narrow", narrow);
			applyNarrowPane(state);
		});
		state.resizeObserver.observe(state.root);
	}
	subscribeToStatus(state);
	if (typeof MutationObserver !== "undefined") {
		state.detachObserver = new MutationObserver(() => {
			if (state.root.isConnected) return;
			window.setTimeout(() => { if (!state.root.isConnected) deactivate(state); }, 0);
		});
		state.detachObserver.observe(document.documentElement, { childList: true, subtree: true });
	}
}

function deactivate(state: ExplorerState): void {
	state.active = false;
	state.refreshGeneration += 1;
	state.selectionGeneration += 1;
	state.refreshButton.disabled = false;
	state.refreshButton.classList.remove("is-spinning");
	state.tree.setAttribute("aria-busy", "false");
	state.statusDispose?.();
	state.statusDispose = undefined;
	state.lastSessionStatus = undefined;
	state.pendingIdleRefresh = false;
	state.resizeObserver?.disconnect();
	state.resizeObserver = undefined;
	state.detachObserver?.disconnect();
	state.detachObserver = undefined;
	if (state.storeTimer !== undefined) window.clearTimeout(state.storeTimer);
	state.storeTimer = undefined;
}

async function initialize(state: ExplorerState): Promise<void> {
	state.initializing = true;
	try {
		await restoreUiState(state);
		await refresh(state, false);
		state.initialized = true;
	} finally {
		state.initializing = false;
	}
	if (state.pendingIdleRefresh) {
		state.pendingIdleRefresh = false;
		if (state.active) await refresh(state, false);
	}
}

function subscribeToStatus(state: ExplorerState): void {
	if (!state.host?.capabilities?.session || !state.host.session?.subscribe || state.statusDispose) return;
	try {
		state.statusDispose = state.host.session.subscribe("status", ({ status }) => {
			if (!state.active) return;
			const previous = state.lastSessionStatus;
			state.lastSessionStatus = status;
			if (status !== "idle" || previous === "idle") return;
			if (!state.initialized || state.initializing) {
				state.pendingIdleRefresh = true;
				return;
			}
			void refresh(state, false);
		});
	} catch {
		// Session events are a refresh convenience; manual refresh remains available.
	}
}

async function refresh(state: ExplorerState, announce: boolean): Promise<void> {
	const generation = ++state.refreshGeneration;
	state.refreshButton.disabled = true;
	state.refreshButton.classList.add("is-spinning");
	state.tree.setAttribute("aria-busy", "true");
	if (announce) setLive(state, "Refreshing files…");
	const expanded = [...state.expanded].sort((a, b) => depth(a) - depth(b));
	const rootOkay = await loadDirectory(state, "", true, generation);
	if (rootOkay && generation === state.refreshGeneration) {
		await mapLimit(expanded.filter(Boolean), REFRESH_CONCURRENCY, async (path) => {
			if (generation !== state.refreshGeneration) return;
			await loadDirectory(state, path, false, generation);
		});
	}
	if (generation !== state.refreshGeneration) return;
	pruneState(state);
	renderTree(state);
	if (state.selected) await loadSelectedContent(state, state.selected, true);
	state.refreshButton.disabled = false;
	state.refreshButton.classList.remove("is-spinning");
	state.tree.setAttribute("aria-busy", "false");
	if (announce) setLive(state, rootOkay ? "Explorer refreshed." : "Explorer refresh failed.");
	queueStore(state);
}

async function loadDirectory(state: ExplorerState, path: string, includeStatus: boolean, generation = state.refreshGeneration): Promise<boolean> {
	const previous = state.directories.get(path);
	state.directories.set(path, { state: "loading", entries: previous?.entries ?? [], truncated: previous?.truncated ?? false });
	renderTree(state);
	try {
		const value = await callValue(state, "list", { path, ...(includeStatus ? { includeStatus: true } : {}) });
		if (generation !== state.refreshGeneration) return false;
		const object = recordOf(value);
		const rawEntries = arrayOf(object?.entries ?? object?.children ?? value);
		const entries = rawEntries.map(normalizeEntry).filter((entry): entry is TreeEntry => !!entry);
		state.directories.set(path, {
			state: "ready",
			entries: sortEntries(entries),
			truncated: object?.truncated === true,
		});
		if (includeStatus) applyStatuses(state, object);
		renderTree(state);
		return true;
	} catch (error) {
		if (generation !== state.refreshGeneration) return false;
		state.directories.set(path, {
			state: "error",
			entries: previous?.entries ?? [],
			truncated: previous?.truncated ?? false,
			error: mapRouteFailure(error, path ? "Could not load this folder." : "Could not load files."),
		});
		renderTree(state);
		return false;
	}
}

function applyStatuses(state: ExplorerState, listValue: Record<string, unknown> | undefined): void {
	state.statuses.clear();
	state.ancestors.clear();
	const git = recordOf(listValue?.git ?? listValue?.status);
	if (git?.kind === "none") return;
	const raw = arrayOf(git?.entries ?? git?.files ?? git?.statuses ?? listValue?.statuses ?? listValue?.statusEntries);
	for (const item of raw) {
		const status = normalizeStatus(item);
		if (!status) continue;
		state.statuses.set(status.path, status);
		for (const parent of parentsOf(status.path)) state.ancestors.add(parent);
	}
	for (const item of arrayOf(git?.ancestors ?? listValue?.ancestors)) {
		const path = typeof item === "string" ? safeRelative(item, true) : safeRelative(recordOf(item)?.path, true);
		if (path !== undefined) state.ancestors.add(path);
	}
}

function normalizeEntry(input: unknown): TreeEntry | undefined {
	const value = recordOf(input);
	if (!value) return undefined;
	const path = safeRelative(value.path, false);
	const name = typeof value.name === "string" && value.name ? value.name : path?.split("/").pop();
	const kind = value.kind;
	if (!path || !name || (kind !== "directory" && kind !== "file" && kind !== "symlink" && kind !== "other")) return undefined;
	return { path, name, kind, ...(value.virtual === true ? { virtual: true } : {}) };
}

function normalizeStatus(input: unknown): StatusRecord | undefined {
	const value = recordOf(input);
	const path = safeRelative(value?.path, false);
	if (!value || !path) return undefined;
	const flags = recordOf(value.flags) ?? value;
	const oldPath = safeRelative(value.oldPath, false);
	return {
		path,
		...(oldPath ? { oldPath } : {}),
		...(typeof value.index === "string" ? { index: value.index } : {}),
		...(typeof value.worktree === "string" ? { worktree: value.worktree } : {}),
		...(typeof value.summary === "string" ? { summary: value.summary } : {}),
		staged: flags.staged === true,
		unstaged: flags.unstaged === true,
		added: flags.added === true,
		deleted: flags.deleted === true,
		renamed: flags.renamed === true,
		copied: flags.copied === true,
		conflict: flags.conflict === true,
		untracked: flags.untracked === true,
	};
}

function visibleEntries(state: ExplorerState, parent: string): TreeEntry[] {
	const listed = state.directories.get(parent)?.entries ?? [];
	const merged = new Map(listed.map((entry) => [entry.path, entry]));
	for (const status of state.statuses.values()) {
		if (!isDeleted(status)) continue;
		const segments = status.path.split("/");
		for (let index = 0; index < segments.length; index += 1) {
			const path = segments.slice(0, index + 1).join("/");
			const entryParent = segments.slice(0, index).join("/");
			if (entryParent !== parent || merged.has(path)) continue;
			merged.set(path, { path, name: segments[index], kind: index === segments.length - 1 ? "file" : "directory", virtual: true });
		}
	}
	return sortEntries([...merged.values()]);
}

function flattenRows(state: ExplorerState): Array<{ entry: TreeEntry; level: number }> {
	const rows: Array<{ entry: TreeEntry; level: number }> = [];
	const visit = (parent: string, level: number) => {
		for (const entry of visibleEntries(state, parent)) {
			rows.push({ entry, level });
			if (entry.kind === "directory" && state.expanded.has(entry.path)) visit(entry.path, level + 1);
		}
	};
	visit("", 1);
	return rows;
}

function renderTree(state: ExplorerState): void {
	const restoreFocus = state.tree.contains(document.activeElement);
	state.tree.replaceChildren();
	const rootDirectory = state.directories.get("");
	if (!rootDirectory || (rootDirectory.state === "loading" && rootDirectory.entries.length === 0)) {
		state.tree.append(messageRow("loading", "Loading files…"));
		return;
	}
	if (rootDirectory.state === "error" && rootDirectory.entries.length === 0) {
		state.tree.append(errorRow(rootDirectory.error!, () => void refresh(state, true)));
		return;
	}
	const rows = flattenRows(state);
	if (rows.length === 0) state.tree.append(messageRow("empty", "This folder is empty."));
	const renderChildren = (parent: string, level: number, container: HTMLElement): void => {
		for (const entry of visibleEntries(state, parent)) {
			const item = el("div", "bb-explorer-row");
			item.dataset.path = entry.path;
			item.dataset.kind = entry.kind;
			item.dataset.testid = "file-explorer-treeitem";
			item.id = treeItemId(state, entry.path);
			item.setAttribute("role", "treeitem");
			item.setAttribute("aria-level", String(level));
			item.setAttribute("aria-selected", String(state.selected === entry.path));
			item.tabIndex = state.focused === entry.path || (!state.focused && rows[0]?.entry.path === entry.path) ? 0 : -1;
			if (!state.focused && item.tabIndex === 0) state.focused = entry.path;
			if (entry.kind === "directory") {
				item.setAttribute("aria-expanded", String(state.expanded.has(entry.path)));
				const loading = state.directories.get(entry.path)?.state === "loading";
				if (loading) item.setAttribute("aria-busy", "true");
			}
			item.style.setProperty("--tree-level", String(level));
			const twisty = el("span", "bb-explorer-twisty");
			twisty.setAttribute("aria-hidden", "true");
			twisty.innerHTML = entry.kind === "directory" ? iconSvg(state.expanded.has(entry.path) ? "chevron-down" : "chevron-right") : "";
			const icon = el("span", `bb-explorer-icon kind-${entry.kind}`);
			icon.setAttribute("aria-hidden", "true");
			icon.innerHTML = iconSvg(iconForEntry(entry));
			const label = el("span", "bb-explorer-name", entry.name);
			item.append(twisty, icon, label);
			const status = state.statuses.get(entry.path);
			if (status) item.append(renderBadges(status));
			else if (entry.kind === "directory" && state.ancestors.has(entry.path)) {
				const ancestor = el("span", "bb-explorer-ancestor", "•");
				ancestor.setAttribute("aria-label", "Contains changes");
				ancestor.title = "Contains changes";
				item.append(ancestor);
			}
			container.append(item);
			if (entry.kind === "directory" && state.expanded.has(entry.path)) {
				const group = el("div", "bb-explorer-group");
				group.setAttribute("role", "group");
				group.setAttribute("aria-label", `${entry.name} contents`);
				renderDirectoryMessage(state, entry.path, level + 1, group);
				renderChildren(entry.path, level + 1, group);
				container.append(group);
			}
		}
	};
	renderChildren("", 1, state.tree);
	if (rootDirectory.truncated) state.tree.append(messageRow("truncated", "Showing the first 1,000 entries."));
	if (rootDirectory.state === "error") state.tree.prepend(errorRow(rootDirectory.error!, () => void refresh(state, true), true));
	if (restoreFocus) requestAnimationFrame(() => focusPath(state, state.focused));
}

function renderDirectoryMessage(state: ExplorerState, path: string, level: number, container: HTMLElement): void {
	const directory = state.directories.get(path);
	if (!directory) return;
	if (directory.state === "loading" && directory.entries.length === 0) {
		container.append(indentedMessage("Loading…", level, "loading"));
	} else if (directory.state === "error") {
		const row = errorRow(directory.error!, () => void loadDirectory(state, path, false), directory.entries.length > 0);
		row.style.setProperty("--tree-level", String(level));
		container.append(row);
	} else if (directory.state === "ready" && visibleEntries(state, path).length === 0) {
		container.append(indentedMessage("Empty folder", level, "empty"));
	}
	if (directory.truncated) container.append(indentedMessage("Showing the first 1,000 entries", level, "truncated"));
}

function renderBadges(status: StatusRecord): HTMLElement {
	const wrap = el("span", "bb-explorer-badges");
	const badges = statusBadges(status);
	wrap.setAttribute("aria-label", badges.map((badge) => badge.label).join(", "));
	for (const badge of badges) {
		const node = el("span", `bb-explorer-badge status-${badge.tone}`, badge.code);
		node.setAttribute("aria-hidden", "true");
		node.title = badge.label;
		wrap.append(node);
	}
	return wrap;
}

function statusBadges(status: StatusRecord): Array<{ code: string; label: string; tone: string }> {
	if (status.conflict || status.summary === "conflict" || status.index === "U" || status.worktree === "U") return [{ code: "!", label: "Conflict", tone: "conflict" }];
	if (status.untracked || status.summary === "untracked" || status.index === "?") return [{ code: "?", label: "Untracked", tone: "untracked" }];
	const badges: Array<{ code: string; label: string; tone: string }> = [];
	const rawIndex = normalizeStatusCode(status.index, status);
	const index = status.copied && rawIndex === "A" ? "C" : rawIndex;
	const worktree = normalizeStatusCode(status.worktree, status);
	if (index) badges.push(statusBadge(index, "Staged", status));
	if (worktree) badges.push(statusBadge(worktree, "Unstaged", status));
	if (badges.length === 0) {
		const code = status.copied ? "C" : status.renamed ? "R" : status.deleted ? "D" : status.added ? "A" : "M";
		badges.push(statusBadge(code, undefined, status));
	}
	return badges;
}

function statusBadge(code: string, scope: "Staged" | "Unstaged" | undefined, status: StatusRecord): { code: string; label: string; tone: string } {
	const provenance = code === "C" && status.oldPath ? `copied from ${status.oldPath}` : code === "R" && status.oldPath ? `renamed from ${status.oldPath}` : statusWord(code);
	return { code, label: scope ? `${scope} ${provenance}` : titleCase(provenance), tone: toneForCode(code) };
}

function normalizeStatusCode(code: string | undefined, status: StatusRecord): string | undefined {
	if (code && ![" ", "."].includes(code)) return ["M", "A", "D", "R", "C"].includes(code) ? code : code === "?" ? "?" : "M";
	if (status.staged && !status.unstaged) return status.deleted ? "D" : status.added ? "A" : "M";
	if (status.unstaged && !status.staged) return status.deleted ? "D" : "M";
	return undefined;
}

async function toggleDirectory(state: ExplorerState, entry: TreeEntry, focusChild = false): Promise<void> {
	if (state.expanded.has(entry.path)) {
		state.expanded.delete(entry.path);
		renderTree(state);
		queueStore(state);
		return;
	}
	state.expanded.add(entry.path);
	renderTree(state);
	queueStore(state);
	if (!state.directories.has(entry.path) || state.directories.get(entry.path)?.state === "error") {
		await loadDirectory(state, entry.path, false);
	}
	if (focusChild) {
		const child = visibleEntries(state, entry.path)[0];
		if (child) focusPath(state, child.path);
	}
}

function onTreeClick(state: ExplorerState, event: Event): void {
	const target = event.target as Element | null;
	const retry = target?.closest<HTMLButtonElement>("button[data-retry]");
	if (retry) return;
	const row = target?.closest<HTMLElement>("[role=treeitem][data-path]");
	if (!row) return;
	const entry = findVisibleEntry(state, row.dataset.path ?? "");
	if (!entry) return;
	state.focused = entry.path;
	if (entry.kind === "directory") void toggleDirectory(state, entry);
	else void selectEntry(state, entry);
}

function onTreeKeydown(state: ExplorerState, event: KeyboardEvent): void {
	const row = (event.target as Element | null)?.closest<HTMLElement>("[role=treeitem][data-path]");
	if (!row) return;
	const path = row.dataset.path ?? "";
	const rows = flattenRows(state);
	const index = rows.findIndex((item) => item.entry.path === path);
	if (index < 0) return;
	const entry = rows[index].entry;
	let target: string | undefined;
	switch (event.key) {
		case "ArrowDown": target = rows[Math.min(index + 1, rows.length - 1)]?.entry.path; break;
		case "ArrowUp": target = rows[Math.max(index - 1, 0)]?.entry.path; break;
		case "Home": target = rows[0]?.entry.path; break;
		case "End": target = rows.at(-1)?.entry.path; break;
		case "ArrowRight":
			if (entry.kind === "directory") {
				if (!state.expanded.has(entry.path)) void toggleDirectory(state, entry);
				else target = visibleEntries(state, entry.path)[0]?.path;
			}
			break;
		case "ArrowLeft":
			if (entry.kind === "directory" && state.expanded.has(entry.path)) void toggleDirectory(state, entry);
			else target = parentOf(entry.path) || rows[0]?.entry.path;
			break;
		case "Enter":
		case " ":
			if (entry.kind === "directory") void toggleDirectory(state, entry);
			else void selectEntry(state, entry);
			break;
		default: return;
	}
	event.preventDefault();
	if (target) focusPath(state, target);
}

async function selectEntry(state: ExplorerState, entry: TreeEntry): Promise<void> {
	state.selected = entry.path;
	state.selectedKind = entry.kind;
	state.focused = entry.path;
	const status = state.statuses.get(entry.path);
	state.view = isDeleted(status) ? "diff" : "file";
	state.filePreview = idlePreview(entry.path);
	state.diffPreview = idlePreview(entry.path);
	if (state.narrow) {
		state.lastFocusedElement = state.tree.querySelector(`[data-path="${cssEscape(entry.path)}"]`) as HTMLElement | null ?? undefined;
		state.narrowPane = "preview";
		applyNarrowPane(state);
	}
	renderTree(state);
	renderPreview(state);
	queueStore(state);
	await loadSelectedContent(state, entry.path, false);
}

async function loadSelectedContent(state: ExplorerState, path: string, force: boolean): Promise<void> {
	if (path !== state.selected) return;
	const generation = ++state.selectionGeneration;
	const status = state.statuses.get(path);
	const shouldDiff = state.view === "diff" && isChanged(status);
	if (shouldDiff) {
		if (force) state.diffPreview = idlePreview(path);
		await loadDiff(state, path, generation);
	} else {
		if (force) state.filePreview = idlePreview(path);
		await loadFile(state, path, generation);
	}
}

async function loadFile(state: ExplorerState, path: string, generation = ++state.selectionGeneration): Promise<void> {
	if (state.selectedKind !== "file") {
		state.filePreview = { state: "ready", path, kind: "unsupported" };
		renderPreview(state);
		return;
	}
	state.filePreview = { state: "loading", path };
	renderPreview(state);
	try {
		const value = recordOf(await callValue(state, "read", { path })) ?? {};
		if (generation !== state.selectionGeneration || state.selected !== path) return;
		state.filePreview = normalizePreview(value, path, "text");
	} catch (error) {
		if (generation !== state.selectionGeneration || state.selected !== path) return;
		state.filePreview = { state: "error", path, error: mapRouteFailure(error, "Could not read this file.") };
	}
	renderPreview(state);
}

async function loadDiff(state: ExplorerState, path: string, generation = ++state.selectionGeneration): Promise<void> {
	state.diffPreview = { state: "loading", path };
	renderPreview(state);
	try {
		const value = recordOf(await callValue(state, "diff", { path })) ?? {};
		if (generation !== state.selectionGeneration || state.selected !== path) return;
		state.diffPreview = normalizePreview(value, path, "text");
	} catch (error) {
		if (generation !== state.selectionGeneration || state.selected !== path) return;
		state.diffPreview = { state: "error", path, error: mapRouteFailure(error, "Could not load this diff.") };
	}
	renderPreview(state);
}

function normalizePreview(value: Record<string, unknown>, path: string, fallbackKind: string): PreviewState {
	const kind = typeof value.kind === "string" ? value.kind : typeof value.state === "string" ? value.state : fallbackKind;
	const text = typeof value.text === "string" ? value.text : typeof value.content === "string" ? value.content : typeof value.diff === "string" ? value.diff : undefined;
	return {
		state: "ready", path, kind, ...(text !== undefined ? { text } : {}),
		...(typeof value.language === "string" ? { language: value.language } : {}),
		...(typeof value.bytes === "number" ? { bytes: value.bytes } : {}),
		...(typeof value.limit === "number" ? { limit: value.limit } : {}),
	};
}

function renderPreview(state: ExplorerState): void {
	state.preview.replaceChildren();
	if (!state.selected) {
		const empty = el("div", "bb-explorer-preview-empty");
		empty.innerHTML = `${iconSvg("file-text")}<strong>Select a file to preview</strong><span>Files open read only.</span>`;
		state.preview.append(empty);
		return;
	}
	const header = el("div", "bb-explorer-preview-header");
	const path = el("div", "bb-explorer-preview-path", state.selected);
	path.title = state.selected;
	const readonly = el("span", "bb-explorer-readonly", "Read only");
	readonly.innerHTML = `${iconSvg("lock")}<span>Read only</span>`;
	header.append(path, readonly);
	const status = state.statuses.get(state.selected);
	if (isChanged(status)) header.append(renderViewTabs(state));
	state.preview.append(header);
	const current = state.view === "diff" && isChanged(status) ? state.diffPreview : state.filePreview;
	if (current.state === "idle") {
		state.preview.append(previewMessage("loading", "Loading…"));
		return;
	}
	if (current.state === "loading") {
		state.preview.append(previewMessage("loading", state.view === "diff" ? "Loading diff…" : "Loading file…"));
		return;
	}
	if (current.state === "error") {
		const failure = current.error!;
		const content = previewMessage("error", failure.message);
		if (failure.retryable) {
			const retry = textButton("Retry", "retry-preview");
			content.append(retry);
		}
		state.preview.append(content);
		return;
	}
	if (state.view === "diff" && isChanged(status)) renderDiff(state, current);
	else renderFile(state, current);
}

function renderViewTabs(state: ExplorerState): HTMLElement {
	const tabs = el("div", "bb-explorer-tabs");
	tabs.setAttribute("role", "tablist");
	tabs.setAttribute("aria-label", "Preview mode");
	for (const [mode, label] of [["file", "File"], ["diff", "Diff"]] as const) {
		const button = textButton(label, `view-${mode}`);
		button.setAttribute("role", "tab");
		button.setAttribute("aria-selected", String(state.view === mode));
		button.title = mode === "diff" ? "Working tree vs HEAD" : "Working tree file";
		tabs.append(button);
	}
	return tabs;
}

function renderFile(state: ExplorerState, preview: PreviewState): void {
	const kind = preview.kind ?? "text";
	if (kind === "empty") {
		state.preview.append(previewMessage("empty", "This file is empty."));
		return;
	}
	if (kind === "binary") {
		state.preview.append(previewMessage("binary", "Binary files cannot be previewed."));
		return;
	}
	if (kind === "too-large" || kind === "oversized") {
		state.preview.append(previewMessage("too-large", sizeLimitMessage("File", preview)));
		return;
	}
	if (kind === "deleted") {
		state.preview.append(previewMessage("deleted", "This file was deleted from the working tree. Open Diff to view its previous contents."));
		return;
	}
	if (kind === "unsupported") {
		state.preview.append(previewMessage("unsupported", "Only regular text files can be previewed."));
		return;
	}
	if (preview.text === undefined || preview.text === "") {
		state.preview.append(previewMessage("empty", "This file is empty."));
		return;
	}
	state.preview.append(renderCode(preview.text, preview.language ?? languageForPath(state.selected ?? "")));
}

function renderCode(text: string, language?: string): HTMLElement {
	const scroller = el("div", "bb-explorer-code-scroll");
	const table = el("div", "bb-explorer-code");
	table.setAttribute("role", "region");
	table.setAttribute("aria-label", "Read-only file contents");
	let highlighted: string | undefined;
	try {
		if (language && hljs.getLanguage(language)) highlighted = hljs.highlight(text, { language, ignoreIllegals: true }).value;
	} catch { /* plain text fallback */ }
	const lines = (highlighted ?? escapeHtml(text)).split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const row = el("div", "bb-explorer-code-line");
		const number = el("span", "bb-explorer-line-number", String(index + 1));
		number.setAttribute("aria-hidden", "true");
		const code = el("code", "bb-explorer-line-code");
		code.innerHTML = lines[index] || " ";
		row.append(number, code);
		table.append(row);
	}
	scroller.append(table);
	return scroller;
}

function renderDiff(state: ExplorerState, preview: PreviewState): void {
	const kind = preview.kind ?? "text";
	if (kind === "binary") {
		state.preview.append(previewMessage("binary", "Binary file changed. A text diff is not available."));
		return;
	}
	if (kind === "too-large" || kind === "oversized" || kind === "truncated") {
		state.preview.append(previewMessage("too-large", sizeLimitMessage("Diff", preview)));
		return;
	}
	if (["empty", "empty-added"].includes(kind) || !preview.text) {
		const message = kind === "empty-added" ? "Empty file added." : "No textual changes to display.";
		state.preview.append(previewMessage("empty", message));
		return;
	}
	const parsed = parseUnifiedDiff(preview.text);
	if (parsed.files.length === 0) {
		state.preview.append(previewMessage("empty", parsed.trailingText || "No textual changes to display."));
		return;
	}
	const scroller = el("div", "bb-explorer-diff-scroll");
	scroller.setAttribute("role", "region");
	scroller.setAttribute("aria-label", "Working tree compared with HEAD");
	for (const file of parsed.files) {
		const fileBlock = el("section", "bb-explorer-diff-file");
		const fileHeader = el("div", "bb-explorer-diff-file-header", file.displayPath);
		if (file.status === "renamed" || file.status === "copied") fileHeader.dataset.status = file.status;
		fileBlock.append(fileHeader);
		for (const meta of file.meta.filter((line) => /^(rename|copy|similarity|new file|deleted file)/.test(line))) {
			fileBlock.append(el("div", "bb-explorer-diff-meta", meta));
		}
		if (file.isBinary) fileBlock.append(previewMessage("binary", "Binary diff"));
		for (const hunk of file.hunks) {
			fileBlock.append(el("div", "bb-explorer-hunk", hunk.header));
			for (const line of hunk.lines) fileBlock.append(renderDiffLine(line));
		}
		scroller.append(fileBlock);
	}
	if (parsed.isTruncated) scroller.append(previewMessage("too-large", "Diff output was truncated."));
	state.preview.append(scroller);
}

function renderDiffLine(line: UnifiedDiffLine): HTMLElement {
	const row = el("div", `bb-explorer-diff-line diff-${line.kind}`);
	const oldNumber = el("span", "bb-explorer-diff-number", line.oldLine == null ? "" : String(line.oldLine));
	const newNumber = el("span", "bb-explorer-diff-number", line.newLine == null ? "" : String(line.newLine));
	oldNumber.setAttribute("aria-hidden", "true");
	newNumber.setAttribute("aria-hidden", "true");
	const prefix = line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " ";
	const code = el("code", "bb-explorer-diff-code", `${prefix}${line.text}`);
	row.append(oldNumber, newNumber, code);
	return row;
}

function onPreviewClick(state: ExplorerState, event: Event): void {
	const action = (event.target as Element | null)?.closest<HTMLElement>("[data-action]")?.dataset.action;
	if (!action) return;
	if (action === "view-file" || action === "view-diff") {
		state.view = action === "view-diff" ? "diff" : "file";
		renderPreview(state);
		queueStore(state);
		if (state.selected) void loadSelectedContent(state, state.selected, false);
	} else if (action === "retry-preview" && state.selected) {
		void loadSelectedContent(state, state.selected, true);
	}
}

function showTree(state: ExplorerState, restoreFocus: boolean): void {
	state.narrowPane = "tree";
	applyNarrowPane(state);
	if (restoreFocus) requestAnimationFrame(() => (state.lastFocusedElement?.isConnected ? state.lastFocusedElement.focus() : focusPath(state, state.focused)));
}

function applyNarrowPane(state: ExplorerState): void {
	state.root.dataset.narrowPane = state.narrowPane;
	state.treePane.hidden = state.narrow && state.narrowPane === "preview";
	state.previewPane.hidden = state.narrow && state.narrowPane === "tree";
	state.backButton.hidden = !state.narrow;
}

function pruneState(state: ExplorerState): void {
	const all = new Map(flattenRows(state).map((row) => [row.entry.path, row.entry]));
	for (const path of [...state.expanded]) {
		const entry = all.get(path);
		if (!entry || entry.kind !== "directory") state.expanded.delete(path);
	}
	if (state.selected && !all.has(state.selected) && !state.statuses.has(state.selected)) {
		state.selected = undefined;
		state.selectedKind = undefined;
		state.filePreview = idlePreview();
		state.diffPreview = idlePreview();
		state.narrowPane = "tree";
		renderPreview(state);
	} else if (state.selected) {
		state.selectedKind = all.get(state.selected)?.kind ?? (state.statuses.has(state.selected) ? "file" : undefined);
	}
	if (!state.focused || !all.has(state.focused)) state.focused = nearestFocus(state.focused, [...all.keys()]);
}

async function restoreUiState(state: ExplorerState): Promise<void> {
	if (!state.host?.capabilities?.store || !state.host.store) return;
	try {
		let stored: unknown;
		if (state.host.store.read) {
			const result = await state.host.store.read(`ui/${state.sid}`);
			if (result.state === "present") stored = result.value;
		} else if (state.host.store.get) stored = await state.host.store.get(`ui/${state.sid}`);
		const value = recordOf(stored);
		if (value?.version !== STORE_VERSION) return;
		for (const candidate of arrayOf(value.expanded)) {
			const path = safeRelative(candidate, false);
			if (path) state.expanded.add(path);
		}
		const selected = safeRelative(value.selected, false);
		if (selected) state.selected = selected;
		const focused = safeRelative(value.focused, false);
		if (focused) state.focused = focused;
		if (value.view === "file" || value.view === "diff") state.view = value.view;
	} catch {
		// Persistence is best-effort and never blocks browsing.
	}
}

function queueStore(state: ExplorerState): void {
	if (!state.host?.capabilities?.store || !state.host.store?.put) return;
	if (state.storeTimer !== undefined) window.clearTimeout(state.storeTimer);
	state.storeTimer = window.setTimeout(() => {
		state.storeTimer = undefined;
		const value = {
			version: STORE_VERSION,
			expanded: [...state.expanded].filter((path) => safeRelative(path, false) !== undefined),
			...(state.selected && safeRelative(state.selected, false) ? { selected: state.selected } : {}),
			...(state.focused && safeRelative(state.focused, false) ? { focused: state.focused } : {}),
			view: state.view,
		};
		void state.host?.store?.put?.(`ui/${state.sid}`, value).catch(() => undefined);
	}, STORE_DELAY_MS);
}

async function callValue(state: ExplorerState, route: string, body: Record<string, unknown>): Promise<unknown> {
	if (!state.host?.capabilities?.callRoute || !state.host.callRoute) throw { code: "HOST_UNAVAILABLE", message: "File explorer routes are unavailable.", retryable: true };
	const result = await state.host.callRoute(route, { method: "POST", body });
	const object = recordOf(result);
	if (object?.ok === false) throw object.error ?? object;
	return object?.ok === true && "value" in object ? object.value : result;
}

export function mapRouteFailure(error: unknown, fallback: string): PanelFailure {
	const value = recordOf(error);
	const rawRouteError = value?.routeError ?? value?.error ?? value?.body;
	const routeError = recordOf(rawRouteError);
	const codeValue = routeError?.code ?? value?.code ?? value?.status;
	const code = typeof codeValue === "string" || typeof codeValue === "number" ? String(codeValue) : undefined;
	const safeCode = code as RouteErrorCode | undefined;
	const defaults: Partial<Record<RouteErrorCode, string>> = {
		INVALID_PATH: "The requested path is invalid.", NOT_FOUND: "This item no longer exists.",
		NOT_DIRECTORY: "This item is not a folder.", NOT_FILE: "This item is not a regular file.",
		UNSUPPORTED_FILE: "This file type cannot be previewed.", READ_FAILED: "Could not read this file.",
		FS_TIMEOUT: "The file operation timed out.", GIT_TIMEOUT: "Git took too long to respond.",
		GIT_FAILED: "Git information is temporarily unavailable.",
	};
	const messageValue = routeError?.message ?? (typeof rawRouteError === "string" ? rawRouteError : value?.message);
	const message = defaults[safeCode!] ?? (typeof messageValue === "string" && messageValue ? messageValue : fallback);
	return { code, message, retryable: routeError?.retryable === true || value?.retryable === true || safeCode === "FS_TIMEOUT" || safeCode === "GIT_TIMEOUT" || code === "408" || code === "429" || code === "503" };
}

function safeRelative(input: unknown, allowRoot: boolean): string | undefined {
	if (typeof input !== "string" || input.includes("\0") || input.includes("\\") || input.startsWith("/") || /^[A-Za-z]:/.test(input) || input.startsWith("//")) return undefined;
	if (input === "") return allowRoot ? "" : undefined;
	const parts = input.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) return undefined;
	return parts.join("/");
}

function sortEntries(entries: TreeEntry[]): TreeEntry[] {
	return [...entries].sort((a, b) => {
		const kind = Number(a.kind !== "directory") - Number(b.kind !== "directory");
		if (kind) return kind;
		const folded = a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase());
		return folded || a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
	});
}

function findVisibleEntry(state: ExplorerState, path: string): TreeEntry | undefined {
	return flattenRows(state).find((row) => row.entry.path === path)?.entry;
}
function parentOf(path: string): string { return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""; }
function parentsOf(path: string): string[] { const out: string[] = []; for (let value = parentOf(path); value; value = parentOf(value)) out.push(value); return out; }
function depth(path: string): number { return path ? path.split("/").length : 0; }
function isDeleted(status?: StatusRecord): boolean { return !!status && (status.deleted === true || status.summary === "deleted" || status.index === "D" || status.worktree === "D"); }
function isChanged(status?: StatusRecord): boolean { return !!status; }
function idlePreview(path?: string): PreviewState { return { state: "idle", ...(path ? { path } : {}) }; }
function nearestFocus(previous: string, paths: string[]): string { let value = previous; while (value) { if (paths.includes(value)) return value; value = parentOf(value); } return paths[0] ?? ""; }
function recordOf(value: unknown): Record<string, any> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined; }
function arrayOf(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function titleCase(value: string): string { return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value; }
function statusWord(code: string): string { return code === "A" ? "added" : code === "D" ? "deleted" : code === "R" ? "renamed" : code === "C" ? "copied" : "modified"; }
function toneForCode(code: string): string { return code === "D" ? "deleted" : code === "A" || code === "?" ? "added" : code === "C" ? "copied" : code === "R" ? "renamed" : "modified"; }
function sizeLimitMessage(label: string, preview: PreviewState): string { return preview.limit ? `${label} is too large to display (limit ${formatBytes(preview.limit)}).` : `${label} is too large to display.`; }
function formatBytes(bytes: number): string { return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MiB` : `${Math.round(bytes / 1024)} KiB`; }

function focusPath(state: ExplorerState, path: string): void {
	state.focused = path;
	for (const item of state.tree.querySelectorAll<HTMLElement>("[role=treeitem]")) item.tabIndex = item.dataset.path === path ? 0 : -1;
	const item = state.tree.querySelector<HTMLElement>(`[role=treeitem][data-path="${cssEscape(path)}"]`);
	item?.focus();
}
function treeItemId(state: ExplorerState, path: string): string { return `bb-explorer-${hash(`${state.sid}:${path}`)}`; }
function hash(value: string): string { let result = 2166136261; for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 16777619); return (result >>> 0).toString(36); }
function cssEscape(value: string): string { return typeof globalThis.CSS?.escape === "function" ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&"); }
function setLive(state: ExplorerState, message: string): void { state.live.textContent = ""; requestAnimationFrame(() => { state.live.textContent = message; }); }
function escapeHtml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

async function mapLimit<T>(values: T[], limit: number, action: (value: T) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
		while (next < values.length) { const index = next++; await action(values[index]); }
	}));
}

function languageForPath(path: string): string | undefined {
	const extension = path.split(".").pop()?.toLowerCase();
	if (["js", "jsx", "mjs", "cjs"].includes(extension ?? "")) return "javascript";
	if (["ts", "tsx", "mts", "cts"].includes(extension ?? "")) return "typescript";
	if (extension === "json" || path.endsWith(".jsonc")) return "json";
	if (["html", "htm", "svg", "xml"].includes(extension ?? "")) return "xml";
	if (extension === "css") return "css";
	if (["md", "mdx"].includes(extension ?? "")) return "markdown";
	if (["yml", "yaml"].includes(extension ?? "")) return "yaml";
	if (extension === "py") return "python";
	if (["sh", "bash", "zsh"].includes(extension ?? "")) return "bash";
	return undefined;
}

function iconForEntry(entry: TreeEntry): string {
	if (entry.kind === "directory") return "folder";
	if (entry.kind === "symlink") return "link";
	if (entry.kind === "other") return "box";
	const extension = entry.name.split(".").pop()?.toLowerCase();
	if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension ?? "")) return "image";
	if (["json", "yaml", "yml", "toml", "ini"].includes(extension ?? "")) return "braces";
	if (["js", "jsx", "ts", "tsx", "py", "rs", "go", "java", "css", "html"].includes(extension ?? "")) return "file-code";
	if (["md", "txt", "log"].includes(extension ?? "")) return "file-text";
	return "file";
}

function iconSvg(name: string): string {
	const paths: Record<string, string> = {
		"refresh": '<path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/>',
		"arrow-left": '<path d="m15 18-6-6 6-6"/>', "chevron-right": '<path d="m9 18 6-6-6-6"/>', "chevron-down": '<path d="m6 9 6 6 6-6"/>',
		"folder": '<path d="M3 6h5l2 2h11v10H3z"/>', "file": '<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6"/>',
		"file-text": '<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>',
		"file-code": '<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M11 13l-2 2 2 2M15 13l2 2-2 2"/>',
		"image": '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
		"braces": '<path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"/>',
		"link": '<path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1-1"/>',
		"box": '<path d="m21 8-9-5-9 5 9 5zM3 8v8l9 5 9-5V8M12 13v8"/>', "lock": '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
	};
	return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? paths.file}</svg>`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}
function iconButton(icon: string, label: string, className: string): HTMLButtonElement { const button = el("button", className); button.type = "button"; button.title = label; button.setAttribute("aria-label", label); button.innerHTML = iconSvg(icon); return button; }
function textButton(label: string, action: string): HTMLButtonElement { const button = el("button", "bb-explorer-button", label); button.type = "button"; button.dataset.action = action; return button; }
function messageRow(kind: string, message: string): HTMLElement { const row = el("div", `bb-explorer-tree-message message-${kind}`, message); row.dataset.state = kind; return row; }
function indentedMessage(message: string, level: number, kind: string): HTMLElement { const row = messageRow(kind, message); row.style.setProperty("--tree-level", String(level)); return row; }
function errorRow(failure: PanelFailure, retry: () => void, compact = false): HTMLElement { const row = messageRow("error", failure.message); if (compact) row.classList.add("is-compact"); if (failure.retryable) { const button = textButton("Retry", "retry-tree"); button.dataset.retry = "true"; button.addEventListener("click", retry); row.append(button); } return row; }
function previewMessage(kind: string, message: string): HTMLElement { const box = el("div", `bb-explorer-preview-message message-${kind}`); box.dataset.state = kind; box.append(el("strong", "", message)); return box; }

function installStyles(): void {
	if (document.getElementById("bb-file-explorer-styles")) return;
	const style = document.createElement("style");
	style.id = "bb-file-explorer-styles";
	style.textContent = `
.bb-explorer{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--foreground);background:var(--background);font-size:.8125rem;}
.bb-explorer *{box-sizing:border-box}.bb-explorer button{font:inherit;color:inherit}.bb-explorer svg{width:1rem;height:1rem;display:block}
.bb-explorer-toolbar{display:flex;align-items:center;gap:.75rem;min-height:2.75rem;padding:.45rem .65rem;border-bottom:1px solid var(--border);background:var(--card)}
.bb-explorer-heading{display:flex;align-items:baseline;gap:.5rem;min-width:0;flex:1}.bb-explorer-title{font-size:.875rem}.bb-explorer-subtitle{font-size:.7rem;color:var(--muted-foreground);white-space:nowrap}
.bb-explorer-refresh{display:grid;place-items:center;width:1.85rem;height:1.85rem;padding:0;border:1px solid transparent;border-radius:.4rem;background:transparent;cursor:pointer}
.bb-explorer-refresh:hover:not(:disabled){background:color-mix(in oklch,var(--foreground) 7%,transparent)}.bb-explorer-refresh:focus-visible,.bb-explorer-button:focus-visible,.bb-explorer-back:focus-visible{outline:2px solid var(--primary);outline-offset:1px}.bb-explorer-refresh:disabled{opacity:.55}.bb-explorer-refresh.is-spinning svg{animation:bb-explorer-spin .8s linear infinite}
.bb-explorer-content{display:grid;grid-template-columns:minmax(210px,32%) minmax(0,1fr);flex:1;min-height:0}.bb-explorer-tree-pane{min-width:0;min-height:0;border-right:1px solid var(--border);display:flex;flex-direction:column;background:var(--card)}
.bb-explorer-section-title{padding:.45rem .65rem .35rem;color:var(--muted-foreground);font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em}.bb-explorer-tree{flex:1;min-height:0;overflow:auto;padding:.15rem 0 .5rem;outline:none}
.bb-explorer-row{--indent:calc((var(--tree-level) - 1)*.9rem);height:1.7rem;padding:0 .45rem 0 calc(.3rem + var(--indent));display:flex;align-items:center;gap:.18rem;min-width:max-content;width:100%;cursor:default;border-left:2px solid transparent;user-select:none}
.bb-explorer-row:hover{background:color-mix(in oklch,var(--foreground) 6%,transparent)}.bb-explorer-row[aria-selected=true]{background:color-mix(in oklch,var(--primary) 13%,transparent);border-left-color:var(--primary)}.bb-explorer-row:focus{outline:none;background:color-mix(in oklch,var(--primary) 18%,transparent)}.bb-explorer-row:focus-visible{box-shadow:inset 0 0 0 1px color-mix(in oklch,var(--primary) 65%,transparent)}
.bb-explorer-twisty{width:.9rem;flex:0 0 .9rem;color:var(--muted-foreground)}.bb-explorer-twisty svg{width:.85rem;height:.85rem}.bb-explorer-icon{width:1rem;flex:0 0 1rem;color:var(--muted-foreground)}.bb-explorer-icon.kind-directory{color:var(--chart-3)}.bb-explorer-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:22rem}.bb-explorer-badges{display:flex;margin-left:auto;gap:.14rem;padding-left:.5rem}.bb-explorer-badge{min-width:.9rem;font-size:.68rem;font-weight:700;text-align:center}.status-modified{color:var(--warning)}.status-added,.status-untracked{color:var(--positive)}.status-deleted,.status-conflict{color:var(--negative)}.status-renamed,.status-copied{color:var(--info)}.bb-explorer-ancestor{margin-left:auto;color:var(--warning);font-size:1rem;line-height:1}
.bb-explorer-tree-message{--indent:calc((var(--tree-level,1) - 1)*.9rem);padding:.42rem .6rem .42rem calc(1.75rem + var(--indent));color:var(--muted-foreground);font-size:.73rem;display:flex;align-items:center;gap:.5rem}.bb-explorer-tree-message.message-error{color:var(--negative)}.bb-explorer-tree-message.is-compact{border-bottom:1px solid var(--border)}
.bb-explorer-button{border:1px solid var(--border);border-radius:.35rem;padding:.18rem .48rem;background:var(--background);cursor:pointer}.bb-explorer-button:hover{border-color:var(--primary);color:var(--primary)}
.bb-explorer-preview-pane{min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--background)}.bb-explorer-back{display:none;align-items:center;gap:.25rem;border:0;border-bottom:1px solid var(--border);background:var(--card);padding:.5rem .65rem;cursor:pointer}.bb-explorer-preview{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}.bb-explorer-preview-header{min-height:2.35rem;display:flex;align-items:center;gap:.65rem;padding:.35rem .65rem;border-bottom:1px solid var(--border);background:var(--card)}.bb-explorer-preview-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.74rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}.bb-explorer-readonly{display:flex;align-items:center;gap:.25rem;color:var(--muted-foreground);font-size:.68rem;white-space:nowrap}.bb-explorer-readonly svg{width:.75rem;height:.75rem}
.bb-explorer-tabs{display:flex;align-self:stretch;margin:-.35rem 0}.bb-explorer-tabs .bb-explorer-button{border:0;border-radius:0;background:transparent;padding:.45rem .55rem;border-bottom:2px solid transparent;color:var(--muted-foreground)}.bb-explorer-tabs .bb-explorer-button[aria-selected=true]{border-bottom-color:var(--primary);color:var(--foreground)}
.bb-explorer-preview-empty,.bb-explorer-preview-message{margin:auto;display:flex;flex-direction:column;align-items:center;gap:.35rem;text-align:center;color:var(--muted-foreground);padding:1.5rem}.bb-explorer-preview-empty svg{width:1.6rem;height:1.6rem}.bb-explorer-preview-empty strong,.bb-explorer-preview-message strong{color:var(--foreground);font-weight:500}.bb-explorer-preview-message.message-error strong{color:var(--negative)}
.bb-explorer-code-scroll,.bb-explorer-diff-scroll{flex:1;min-height:0;overflow:auto;background:var(--background);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.75rem;line-height:1.5}.bb-explorer-code{min-width:max-content;padding:.35rem 0}.bb-explorer-code-line{display:grid;grid-template-columns:3.4rem minmax(0,1fr);min-height:1.12rem}.bb-explorer-line-number{position:sticky;left:0;text-align:right;padding-right:.8rem;color:var(--muted-foreground);background:var(--background);border-right:1px solid var(--border);user-select:none}.bb-explorer-line-code{white-space:pre;padding:0 .8rem}.hljs-keyword,.hljs-selector-tag,.hljs-literal{color:var(--chart-1)}.hljs-string,.hljs-attr{color:var(--chart-2)}.hljs-number,.hljs-symbol{color:var(--chart-3)}.hljs-comment,.hljs-quote{color:var(--muted-foreground);font-style:italic}.hljs-title,.hljs-function{color:var(--chart-4)}.hljs-variable,.hljs-template-variable{color:var(--chart-5)}
.bb-explorer-diff-file{min-width:max-content;padding-bottom:.65rem}.bb-explorer-diff-file-header{position:sticky;top:0;z-index:2;padding:.4rem .65rem;background:var(--card);border-bottom:1px solid var(--border);font-weight:600}.bb-explorer-diff-meta,.bb-explorer-hunk{padding:.16rem .65rem;color:var(--muted-foreground);background:color-mix(in oklch,var(--info) 8%,transparent)}.bb-explorer-hunk{color:var(--info);margin-top:.2rem}.bb-explorer-diff-line{display:grid;grid-template-columns:3.2rem 3.2rem minmax(0,1fr);min-height:1.12rem}.bb-explorer-diff-number{text-align:right;padding-right:.55rem;color:var(--muted-foreground);border-right:1px solid color-mix(in oklch,var(--border) 70%,transparent);user-select:none}.bb-explorer-diff-code{white-space:pre;padding:0 .65rem}.bb-explorer-diff-line.diff-add{background:color-mix(in oklch,var(--positive) 12%,transparent)}.bb-explorer-diff-line.diff-remove{background:color-mix(in oklch,var(--negative) 12%,transparent)}.bb-explorer-diff-line.diff-add .bb-explorer-diff-code{color:var(--positive)}.bb-explorer-diff-line.diff-remove .bb-explorer-diff-code{color:var(--negative)}
.bb-explorer-live{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.bb-explorer.is-narrow .bb-explorer-content{display:flex}.bb-explorer.is-narrow .bb-explorer-tree-pane,.bb-explorer.is-narrow .bb-explorer-preview-pane{width:100%;border-right:0}.bb-explorer.is-narrow .bb-explorer-back:not([hidden]){display:flex}
[hidden]{display:none!important}@keyframes bb-explorer-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.bb-explorer-refresh.is-spinning svg{animation:none}}
`;
	document.head.append(style);
}
