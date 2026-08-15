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
import {
	ArrowLeft, Box, Braces, ChevronDown, ChevronRight, Diff, File, FileCode2, FileText,
	Folder, FolderUp, Image, Link, ListCollapse, Lock, Pencil, Search, X, type IconNode,
} from "lucide";
import { parseUnifiedDiff, type UnifiedDiffLine } from "../../../src/shared/git-diff/unified.ts";

for (const [name, grammar] of Object.entries({ bash, css, javascript, json, markdown, python, typescript, xml, yaml })) {
	hljs.registerLanguage(name, grammar);
}

const STORE_VERSION = 1;
const STORE_DELAY_MS = 180;
const REFRESH_CONCURRENCY = 4;
const SEARCH_DEBOUNCE_MS = 200;
const COPY_FEEDBACK_MS = 2_000;
const NARROW_WIDTH = 680;
const states = new Map<string, ExplorerState>();

type EntryKind = "directory" | "file" | "symlink" | "other";
type LocationKind = "root" | EntryKind;
type ViewMode = "file" | "diff";
type LoadState = "idle" | "loading" | "ready" | "error";
type SearchPhase = "idle" | "debounce" | "loading" | "ready" | "error";
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

type BrowseSnapshot = {
	expanded: Set<string>;
	focused: string;
	selected?: string;
	selectedKind?: EntryKind;
	location: { path: string; kind: LocationKind };
	view: ViewMode;
	preferredView: ViewMode;
	narrowPane: "tree" | "preview";
	filePreview: PreviewState;
	diffPreview: PreviewState;
};

type SearchState = {
	query: string;
	phase: SearchPhase;
	results: TreeEntry[];
	activeIndex: number;
	count: number;
	limit?: number;
	truncated: boolean;
	error?: PanelFailure;
	generation: number;
	timer?: number;
	snapshot?: BrowseSnapshot;
};

type ExplorerState = {
	sid: string;
	root: HTMLElement;
	treePane: HTMLElement;
	tree: HTMLElement;
	previewPane: HTMLElement;
	preview: HTMLElement;
	content: HTMLElement;
	splitter: HTMLElement;
	pathBar: HTMLElement;
	searchInput: HTMLInputElement;
	clearSearchButton: HTMLButtonElement;
	changedButton: HTMLButtonElement;
	collapseButton: HTMLButtonElement;
	feedback: HTMLElement;
	alert: HTMLElement;
	backButton: HTMLButtonElement;
	upButton: HTMLButtonElement;
	live: HTMLElement;
	host?: HostApi;
	rootPath?: string;
	directories: Map<string, DirectoryState>;
	discovered: Map<string, TreeEntry>;
	expanded: Set<string>;
	statuses: Map<string, StatusRecord>;
	ancestors: Set<string>;
	gitAvailable?: boolean;
	changedOnly: boolean;
	focused: string;
	selected?: string;
	selectedKind?: EntryKind;
	view: ViewMode;
	preferredView: ViewMode;
	filePreview: PreviewState;
	diffPreview: PreviewState;
	refreshGeneration: number;
	selectionGeneration: number;
	navigationGeneration: number;
	pendingFocus?: { path: string; generation: number };
	location: { path: string; kind: LocationKind };
	pathEditing: boolean;
	pathDraft: string;
	pathOrigin?: { path: string; kind: LocationKind };
	pathInvoker?: HTMLElement;
	pathLoading: boolean;
	pathError?: PanelFailure;
	search: SearchState;
	menu?: { target: TreeEntry; invoker?: HTMLElement; pointer: boolean; x: number; y: number };
	menuDocumentClick?: (event: MouseEvent) => void;
	copyMessage?: { text: string; error: boolean };
	copyTimer?: number;
	liveFrame?: number;
	alertFrame?: number;
	initialized: boolean;
	initializing: boolean;
	uiStateRestored: boolean;
	durableMutationGeneration: number;
	initializingLifecycle?: number;
	initializationQueued: boolean;
	lifecycleGeneration: number;
	active: boolean;
	narrow: boolean;
	narrowPane: "tree" | "preview";
	lastSessionStatus?: string;
	pendingIdleRefresh: boolean;
	statusDispose?: () => void;
	resizeObserver?: ResizeObserver;
	treePaneWidth?: number;
	storeTimer?: number;
	lastFocusedElement?: HTMLElement;
};

const EXPLORER_ROOT_TAG = "bobbit-file-explorer-root";

type ExplorerRootElement = HTMLElement & { onDetached?: () => void };

function createExplorerRoot(): ExplorerRootElement {
	if (!customElements.get(EXPLORER_ROOT_TAG)) {
		customElements.define(EXPLORER_ROOT_TAG, class extends HTMLElement {
			onDetached?: () => void;

			disconnectedCallback(): void {
				window.setTimeout(() => {
					if (!this.isConnected) this.onDetached?.();
				}, 0);
			}
		});
	}
	return document.createElement(EXPLORER_ROOT_TAG) as ExplorerRootElement;
}

export default function createFileExplorerPanel() {
	installStyles();
	return {
		render(params: Record<string, unknown> | undefined, host: HostApi | undefined) {
			const sid = typeof params?.__sessionId === "string" ? params.__sessionId : "default";
			let state = states.get(sid);
			if (!state) {
				state = createState(sid);
				states.set(sid, state);
			} else if (state.active && !state.root.isConnected) {
				// The panel instance is cached by session. Reconcile a detached instance
				// synchronously so a same-turn remount cannot expose transient search/path
				// state while its MutationObserver cleanup is still queued.
				deactivate(state);
			}
			state.host = host;
			queueMicrotask(() => {
				activate(state!);
				subscribeToStatus(state!);
				requestInitialize(state!);
			});
			return state.root;
		},
		async refresh(params: Record<string, unknown> | undefined, host: HostApi | undefined) {
			const sid = typeof params?.__sessionId === "string" ? params.__sessionId : "default";
			const state = states.get(sid);
			if (!state) return;
			state.host = host;
			await refresh(state, true);
		},
	};
}

function createState(sid: string): ExplorerState {
	const root = createExplorerRoot();
	root.className = "bb-explorer";
	root.dataset.testid = "file-explorer-panel";
	root.setAttribute("role", "region");
	root.setAttribute("aria-label", "File explorer");

	const pathBar = el("header", "bb-explorer-pathbar");
	pathBar.dataset.testid = "file-explorer-pathbar";
	const upButton = iconButton("arrow-up", "Up one level", "bb-explorer-path-button");
	upButton.dataset.action = "up-path";

	const content = el("div", "bb-explorer-content");
	const treePane = el("aside", "bb-explorer-tree-pane");
	const controls = el("div", "bb-explorer-tree-toolbar");
	controls.setAttribute("role", "toolbar");
	controls.setAttribute("aria-label", "File explorer controls");
	const searchWrap = el("div", "bb-explorer-search");
	searchWrap.innerHTML = iconSvg("search");
	const searchInput = el("input", "bb-explorer-search-input");
	searchInput.type = "search";
	searchInput.placeholder = "Search files and folders…";
	searchInput.setAttribute("aria-label", "Search files and folders");
	searchInput.setAttribute("role", "combobox");
	searchInput.setAttribute("aria-autocomplete", "list");
	searchInput.setAttribute("aria-controls", `bb-explorer-search-${hash(sid)}`);
	searchInput.setAttribute("aria-expanded", "false");
	const clearSearchButton = iconButton("x", "Clear search", "bb-explorer-control bb-explorer-clear-search");
	clearSearchButton.hidden = true;
	searchWrap.append(searchInput, clearSearchButton);
	const changedButton = iconButton("diff", "Changed files only", "bb-explorer-control bb-explorer-changed");
	changedButton.setAttribute("aria-pressed", "false");
	changedButton.append(el("span", "bb-explorer-control-label", "Changed"));
	const collapseButton = iconButton("collapse", "Collapse all", "bb-explorer-control bb-explorer-collapse");
	collapseButton.append(el("span", "bb-explorer-control-label", "Collapse"));
	controls.append(searchWrap, changedButton, collapseButton);
	const feedback = el("div", "bb-explorer-feedback");
	const tree = el("div", "bb-explorer-tree");
	tree.dataset.testid = "file-explorer-tree";
	tree.id = `bb-explorer-search-${hash(sid)}`;
	tree.setAttribute("role", "tree");
	tree.setAttribute("aria-label", "Files");
	tree.setAttribute("aria-busy", "true");
	treePane.append(controls, feedback, tree);

	const previewPane = el("main", "bb-explorer-preview-pane");
	const backButton = iconButton("arrow-left", "Back to files", "bb-explorer-back");
	backButton.append(document.createTextNode(" Files"));
	const preview = el("div", "bb-explorer-preview");
	preview.dataset.testid = "file-explorer-preview";
	previewPane.append(backButton, preview);
	const splitter = el("div", "bb-explorer-splitter");
	splitter.dataset.testid = "file-explorer-splitter";
	splitter.setAttribute("role", "separator");
	splitter.setAttribute("aria-label", "Resize file tree");
	splitter.setAttribute("aria-orientation", "vertical");
	splitter.tabIndex = 0;
	content.append(treePane, splitter, previewPane);

	const live = el("div", "bb-explorer-live");
	live.setAttribute("role", "status");
	live.setAttribute("aria-live", "polite");
	const alert = el("div", "bb-explorer-live");
	alert.setAttribute("role", "alert");
	alert.setAttribute("aria-live", "assertive");
	root.append(pathBar, content, live, alert);

	const state: ExplorerState = {
		sid, root, treePane, tree, previewPane, preview, content, splitter, pathBar, searchInput, clearSearchButton,
		changedButton, collapseButton, feedback, alert, backButton, upButton, live,
		directories: new Map(), discovered: new Map(), expanded: new Set(), statuses: new Map(), ancestors: new Set(),
		changedOnly: false, focused: "", view: "file", preferredView: "file", filePreview: idlePreview(), diffPreview: idlePreview(),
		refreshGeneration: 0, selectionGeneration: 0, navigationGeneration: 0,
		location: { path: "", kind: "root" }, pathEditing: false, pathDraft: "", pathLoading: false,
		search: { query: "", phase: "idle", results: [], activeIndex: -1, count: 0, truncated: false, generation: 0 },
		initialized: false, initializing: false, uiStateRestored: false, durableMutationGeneration: 0, initializationQueued: false, lifecycleGeneration: 0,
		active: false, narrow: false, narrowPane: "tree", pendingIdleRefresh: false,
	};
	root.onDetached = () => deactivate(state);
	backButton.addEventListener("click", () => showTree(state!, true));
	splitter.addEventListener("pointerdown", (event) => beginSplitResize(state!, event));
	splitter.addEventListener("keydown", (event) => resizeSplitByKeyboard(state!, event));
	splitter.addEventListener("dblclick", () => setTreePaneWidth(state!, undefined));
	searchInput.addEventListener("input", () => onSearchInput(state!));
	searchInput.addEventListener("keydown", (event) => onSearchKeydown(state!, event));
	clearSearchButton.addEventListener("click", () => clearSearch(state!, true));
	changedButton.addEventListener("click", () => toggleChangedOnly(state!));
	collapseButton.addEventListener("click", () => collapseAll(state!));
	pathBar.addEventListener("click", (event) => onPathBarClick(state!, event));
	pathBar.addEventListener("input", (event) => {
		const input = (event.target as Element | null)?.closest<HTMLInputElement>(".bb-explorer-path-input");
		if (!input) return;
		state!.pathDraft = input.value;
		state!.pathError = undefined;
		input.setAttribute("aria-invalid", "false");
		state!.pathBar.querySelector(".bb-explorer-path-help")!.textContent = "Enter a path relative to the session root.";
	});
	pathBar.addEventListener("keydown", (event) => onPathBarKeydown(state!, event));
	root.addEventListener("keydown", (event) => {
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
			event.preventDefault();
			enterPathEdit(state!, event.target as HTMLElement | null);
		}
	});
	tree.addEventListener("click", (event) => onTreeClick(state!, event));
	tree.addEventListener("keydown", (event) => onTreeKeydown(state!, event));
	tree.addEventListener("contextmenu", (event) => onTreeContextMenu(state!, event));
	preview.addEventListener("click", (event) => onPreviewClick(state!, event));
	renderPathBar(state);
	renderTree(state);
	renderPreview(state);
	return state;
}

function setTreePaneWidth(state: ExplorerState, width?: number): void {
	if (width === undefined) {
		state.treePaneWidth = undefined;
		state.content.style.removeProperty("--tree-pane-width");
		state.splitter.removeAttribute("aria-valuenow");
		return;
	}
	const total = state.content.getBoundingClientRect().width || state.root.getBoundingClientRect().width;
	const maximum = Math.max(180, total - 247);
	const value = Math.round(Math.min(maximum, Math.max(180, width)));
	state.treePaneWidth = value;
	state.content.style.setProperty("--tree-pane-width", `${value}px`);
	state.splitter.setAttribute("aria-valuemin", "180");
	state.splitter.setAttribute("aria-valuemax", String(Math.round(maximum)));
	state.splitter.setAttribute("aria-valuenow", String(value));
}

function beginSplitResize(state: ExplorerState, event: PointerEvent): void {
	if (state.narrow || event.button !== 0) return;
	event.preventDefault();
	const startX = event.clientX;
	const startWidth = state.treePane.getBoundingClientRect().width;
	try { state.splitter.setPointerCapture(event.pointerId); } catch { /* optional in DOM fixtures */ }
	document.body.style.cursor = "col-resize";
	document.body.style.userSelect = "none";
	state.splitter.classList.add("is-dragging");
	const move = (next: PointerEvent) => setTreePaneWidth(state, startWidth + next.clientX - startX);
	const end = () => {
		document.removeEventListener("pointermove", move);
		document.removeEventListener("pointerup", end);
		document.removeEventListener("pointercancel", end);
		document.body.style.removeProperty("cursor");
		document.body.style.removeProperty("user-select");
		state.splitter.classList.remove("is-dragging");
	};
	document.addEventListener("pointermove", move);
	document.addEventListener("pointerup", end);
	document.addEventListener("pointercancel", end);
}

function resizeSplitByKeyboard(state: ExplorerState, event: KeyboardEvent): void {
	if (state.narrow || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
	event.preventDefault();
	const current = state.treePaneWidth ?? state.treePane.getBoundingClientRect().width;
	if (event.key === "Home") setTreePaneWidth(state, 180);
	else if (event.key === "End") setTreePaneWidth(state, Number.MAX_SAFE_INTEGER);
	else setTreePaneWidth(state, current + (event.key === "ArrowLeft" ? -16 : 16));
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
}

function deactivate(state: ExplorerState): void {
	state.active = false;
	state.lifecycleGeneration += 1;
	state.initializationQueued = false;
	state.refreshGeneration += 1;
	state.selectionGeneration += 1;
	invalidateNavigation(state);
	state.search.generation += 1;
	if (state.search.timer !== undefined) window.clearTimeout(state.search.timer);
	state.search.timer = undefined;
	if (state.copyTimer !== undefined) window.clearTimeout(state.copyTimer);
	state.copyTimer = undefined;
	if (state.liveFrame !== undefined) cancelAnimationFrame(state.liveFrame);
	state.liveFrame = undefined;
	if (state.alertFrame !== undefined) cancelAnimationFrame(state.alertFrame);
	state.alertFrame = undefined;
	state.live.textContent = "";
	state.alert.textContent = "";
	if (state.pathEditing) {
		if (state.pathOrigin) state.location = { ...state.pathOrigin };
		state.pathEditing = false;
		state.pathLoading = false;
		state.pathError = undefined;
		state.pathDraft = "";
		state.pathOrigin = undefined;
		state.pathInvoker = undefined;
		renderPathBar(state);
	}
	if (state.search.query) clearSearch(state, true);
	state.copyMessage = undefined;
	renderDiscoveryControls(state);
	closeContextMenu(state, false);
	state.tree.setAttribute("aria-busy", "false");
	state.statusDispose?.();
	state.statusDispose = undefined;
	state.lastSessionStatus = undefined;
	state.pendingIdleRefresh = false;
	state.resizeObserver?.disconnect();
	state.resizeObserver = undefined;
	if (state.storeTimer !== undefined) window.clearTimeout(state.storeTimer);
	state.storeTimer = undefined;
}

function requestInitialize(state: ExplorerState): void {
	if (!state.active || state.initialized || !state.host?.capabilities?.callRoute) return;
	if (state.initializing) {
		if (state.initializingLifecycle !== state.lifecycleGeneration) state.initializationQueued = true;
		return;
	}
	void initialize(state);
}

async function initialize(state: ExplorerState): Promise<void> {
	const lifecycle = state.lifecycleGeneration;
	state.initializing = true;
	state.initializingLifecycle = lifecycle;
	try {
		if (!state.uiStateRestored) {
			await restoreUiState(state, lifecycle);
			if (!ownsLifecycle(state, lifecycle)) return;
			state.uiStateRestored = true;
		}
		const completed = await refresh(state, false);
		if (!ownsLifecycle(state, lifecycle)) return;
		if (!completed) {
			state.initializationQueued = true;
			return;
		}
		state.initialized = true;
	} finally {
		state.initializing = false;
		state.initializingLifecycle = undefined;
		if (state.initializationQueued) {
			state.initializationQueued = false;
			requestInitialize(state);
		}
	}
	if (!state.initializing && state.initialized && state.pendingIdleRefresh) {
		state.pendingIdleRefresh = false;
		if (state.active) await refresh(state, false);
	}
}

function ownsLifecycle(state: ExplorerState, lifecycle: number): boolean {
	return state.active && state.lifecycleGeneration === lifecycle;
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

async function refresh(state: ExplorerState, announce: boolean): Promise<boolean> {
	closeContextMenu(state, false);
	invalidateNavigation(state);
	const activeQuery = state.search.query;
	state.search.generation += 1;
	if (state.search.timer !== undefined) window.clearTimeout(state.search.timer);
	if (activeQuery) {
		state.search.phase = "loading";
		state.search.results = [];
		state.search.activeIndex = -1;
	}
	if (state.pathLoading) {
		state.pathLoading = false;
		renderPathBar(state);
	}
	const generation = ++state.refreshGeneration;
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
	if (generation !== state.refreshGeneration) return false;
	pruneState(state);
	renderTree(state);
	if (state.selected) await loadSelectedContent(state, state.selected, true);
	state.tree.setAttribute("aria-busy", "false");
	if (activeQuery) scheduleSearch(state, true);
	if (announce) setLive(state, rootOkay ? "Explorer refreshed." : "Explorer refresh failed.");
	queueStore(state, false);
	return true;
}

function nativePath(value: string): string {
	return /^[A-Za-z]:\//.test(value) || value.startsWith("//") ? value.replace(/\//g, "\\") : value;
}
function rootedBody(state: ExplorerState, body: Record<string, unknown>): Record<string, unknown> {
	return state.rootPath ? { ...body, rootPath: nativePath(state.rootPath) } : body;
}

async function loadDirectory(state: ExplorerState, path: string, includeStatus: boolean, generation = state.refreshGeneration): Promise<boolean> {
	const previous = state.directories.get(path);
	state.directories.set(path, { state: "loading", entries: previous?.entries ?? [], truncated: previous?.truncated ?? false });
	renderTree(state);
	try {
		const value = await callValue(state, "list", rootedBody(state, { path, ...(includeStatus ? { includeStatus: true } : {}) }));
		if (generation !== state.refreshGeneration) return false;
		const object = recordOf(value);
		const rawEntries = arrayOf(object?.entries ?? object?.children ?? value);
		const entries = rawEntries.map(normalizeEntry).filter((entry): entry is TreeEntry => !!entry);
		const truncated = object?.truncated === true;
		if (path === "" && typeof object?.rootPath === "string" && object.rootPath) {
			state.rootPath = object.rootPath;
			renderPathBar(state);
		}
		state.directories.set(path, {
			state: "ready",
			entries: sortEntries(entries),
			truncated,
		});
		if (!truncated) {
			const listedPaths = new Set(entries.map((entry) => entry.path));
			for (const discoveredPath of [...state.discovered.keys()]) {
				if (parentOf(discoveredPath) === path && !listedPaths.has(discoveredPath)) state.discovered.delete(discoveredPath);
			}
		}
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
	state.gitAvailable = git?.kind === "git" || git?.kind === "repository"
		? true
		: git?.kind === "none" ? false : undefined;
	if (state.gitAvailable !== true) return;
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
	const merged = new Map<string, TreeEntry>();
	for (const entry of state.discovered.values()) {
		if (parentOf(entry.path) === parent) merged.set(entry.path, entry);
	}
	for (const entry of listed) merged.set(entry.path, entry);
	for (const status of state.statuses.values()) {
		const segments = status.path.split("/");
		for (let index = 0; index < segments.length; index += 1) {
			const path = segments.slice(0, index + 1).join("/");
			const entryParent = segments.slice(0, index).join("/");
			if (entryParent !== parent || merged.has(path)) continue;
			if (isDeleted(status) || state.changedOnly) {
				merged.set(path, { path, name: segments[index], kind: index === segments.length - 1 ? "file" : "directory", virtual: true });
			}
		}
	}
	const entries = [...merged.values()];
	if (!state.changedOnly || state.gitAvailable !== true) return sortEntries(entries);
	return sortEntries(entries.filter((entry) => state.statuses.has(entry.path) || state.ancestors.has(entry.path)));
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
	const menuInvokerPath = state.menu?.invoker?.closest<HTMLElement>("[role=treeitem][data-path]")?.dataset.path;
	const finishRender = (): void => {
		reconcileContextMenuAfterTreeRender(state, menuInvokerPath);
		consumePendingFocus(state);
	};
	renderDiscoveryControls(state);
	state.tree.replaceChildren();
	if (state.search.query) {
		renderSearchResults(state);
		finishRender();
		return;
	}
	state.tree.setAttribute("role", "tree");
	state.tree.setAttribute("aria-label", "Files");
	state.tree.removeAttribute("aria-activedescendant");
	const rootDirectory = state.directories.get("");
	state.tree.setAttribute("aria-busy", String(!rootDirectory || rootDirectory.state === "loading"));
	if (!rootDirectory || (rootDirectory.state === "loading" && rootDirectory.entries.length === 0)) {
		state.tree.append(messageRow("loading", "Loading files…"));
		finishRender();
		return;
	}
	if (rootDirectory.state === "error" && rootDirectory.entries.length === 0) {
		state.tree.append(errorRow(rootDirectory.error!, () => void refresh(state, true)));
		finishRender();
		return;
	}
	const rows = flattenRows(state);
	if (rows.length === 0) state.tree.append(messageRow("empty", state.changedOnly && state.gitAvailable ? "No changed files. Working tree changes will appear here." : "This folder is empty."));
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
			const decoration = gitDecorationForEntry(state, entry);
			icon.innerHTML = entry.kind === "directory" && decoration?.kind === "descendant"
				? folderOutlineSvg(decoration.tones, `${state.sid}:${entry.path}`)
				: iconSvg(iconForEntry(entry));
			if (entry.kind === "directory" && decoration?.kind === "descendant") icon.classList.add("has-git-outline");
			const label = el("span", "bb-explorer-name", entry.name);
			if (decoration?.kind === "direct") item.classList.add(`git-${decoration.tone}`);
			item.append(twisty, icon, label);
			const status = state.statuses.get(entry.path);
			if (status) item.append(renderBadges(status));
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
	finishRender();
	if (restoreFocus) requestAnimationFrame(() => focusPath(state, state.focused));
}

function consumePendingFocus(state: ExplorerState): void {
	const pending = state.pendingFocus;
	if (!pending) return;
	if (pending.generation !== state.navigationGeneration) {
		state.pendingFocus = undefined;
		return;
	}
	if (!state.tree.querySelector(`[role=treeitem][data-path="${cssEscape(pending.path)}"]`)) return;
	state.pendingFocus = undefined;
	requestAnimationFrame(() => {
		if (pending.generation !== state.navigationGeneration || state.focused !== pending.path) return;
		focusPath(state, pending.path);
	});
}

function reconcileContextMenuAfterTreeRender(state: ExplorerState, invokerPath?: string): void {
	if (!state.menu) return;
	const targetRow = state.tree.querySelector<HTMLElement>(`[data-path="${cssEscape(state.menu.target.path)}"]`);
	if (!targetRow) {
		closeContextMenu(state, false);
		return;
	}
	targetRow.classList.add("is-context-target");
	if (invokerPath !== undefined) {
		state.menu.invoker = state.tree.querySelector<HTMLElement>(`[data-path="${cssEscape(invokerPath)}"]`) ?? state.menu.invoker;
	}
}

function renderDiscoveryControls(state: ExplorerState): void {
	state.searchInput.value = state.search.query;
	state.searchInput.setAttribute("aria-expanded", String(!!state.search.query));
	state.searchInput.setAttribute("aria-busy", String(state.search.phase === "loading"));
	if (!state.search.query || state.search.activeIndex < 0) state.searchInput.removeAttribute("aria-activedescendant");
	state.clearSearchButton.hidden = !state.search.query;
	state.changedButton.disabled = state.gitAvailable !== true;
	state.changedButton.setAttribute("aria-pressed", String(state.changedOnly));
	state.changedButton.title = state.gitAvailable === false
		? "Changed files are unavailable because this folder is not a Git worktree."
		: state.gitAvailable === undefined
			? "Changed files are temporarily unavailable. Your preference is preserved."
			: "Changed files only";
	state.collapseButton.setAttribute("aria-disabled", String(state.expanded.size === 0 || !!state.search.query));
	state.feedback.replaceChildren();
	if (state.copyMessage) {
		const feedback = el("div", `bb-explorer-inline-feedback${state.copyMessage.error ? " is-error" : ""}`, state.copyMessage.text);
		if (state.copyMessage.error) {
			feedback.setAttribute("role", "alert");
			const dismiss = textButton("Dismiss", "dismiss-copy");
			dismiss.addEventListener("click", () => { state.copyMessage = undefined; renderDiscoveryControls(state); });
			feedback.append(dismiss);
		}
		state.feedback.append(feedback);
	}
}

function renderSearchResults(state: ExplorerState): void {
	state.tree.setAttribute("role", "listbox");
	state.tree.setAttribute("aria-label", `Search results for ${state.search.query}`);
	state.tree.setAttribute("aria-busy", String(state.search.phase === "loading"));
	if (state.search.phase === "debounce") return;
	if (state.search.phase === "loading") {
		state.tree.append(messageRow("loading", "Searching…"));
		return;
	}
	if (state.search.phase === "error") {
		const failure = state.search.error ?? { message: "Couldn’t search Session files.", retryable: false };
		const row = messageRow("error", failure.message);
		if (failure.retryable) {
			const retry = textButton("Retry", "retry-search");
			retry.addEventListener("click", () => scheduleSearch(state, true));
			row.append(retry);
		}
		state.tree.append(row);
		return;
	}
	if (state.search.results.length === 0) {
		state.tree.append(messageRow("empty", `No files or folders match “${state.search.query}”.`));
		return;
	}
	state.search.results.forEach((entry, index) => {
		const option = el("div", "bb-explorer-search-result");
		const decoration = gitDecorationForEntry(state, entry);
		if (decoration?.kind === "direct") option.classList.add(`git-${decoration.tone}`);
		option.id = `${state.tree.id}-option-${index}`;
		option.dataset.path = entry.path;
		option.dataset.kind = entry.kind;
		option.setAttribute("role", "option");
		option.setAttribute("aria-selected", String(index === state.search.activeIndex));
		option.setAttribute("aria-label", `${entry.name}, in ${parentOf(entry.path) || "Session files"}`);
		option.title = entry.path;
		const icon = el("span", `bb-explorer-icon kind-${entry.kind}`);
		icon.setAttribute("aria-hidden", "true");
		icon.innerHTML = entry.kind === "directory" && decoration?.kind === "descendant"
			? folderOutlineSvg(decoration.tones, `${state.sid}:search:${entry.path}`)
			: iconSvg(iconForEntry(entry));
		if (entry.kind === "directory" && decoration?.kind === "descendant") icon.classList.add("has-git-outline");
		const text = el("span", "bb-explorer-search-result-text");
		text.append(el("span", "bb-explorer-search-result-name", entry.name), el("span", "bb-explorer-search-result-parent", parentOf(entry.path) || "Session files"));
		option.append(icon, text);
		if (index === state.search.activeIndex && entry.kind === "file") {
			const reveal = textButton("Reveal in tree", "reveal-search");
			reveal.addEventListener("click", (event) => { event.stopPropagation(); void revealSearchResult(state, entry); });
			option.append(reveal);
		}
		const status = state.statuses.get(entry.path);
		if (status) option.append(renderBadges(status));
		option.addEventListener("mousedown", (event) => event.preventDefault());
		option.addEventListener("click", () => void activateSearchResult(state, index, true));
		state.tree.append(option);
	});
	if (state.search.activeIndex >= 0) state.searchInput.setAttribute("aria-activedescendant", `${state.tree.id}-option-${state.search.activeIndex}`);
	else state.searchInput.removeAttribute("aria-activedescendant");
	const summary = messageRow("count", state.search.truncated
		? `Showing the first ${state.search.limit ?? state.search.results.length} results. More matches exist. Refine your search.`
		: `${state.search.count} ${state.search.count === 1 ? "result" : "results"}${state.changedOnly ? ". Search includes all files." : ""}`);
	state.tree.prepend(summary);
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
	const rawIndex = normalizeStatusCode(status.index);
	const index = status.copied && rawIndex === "A" ? "C" : rawIndex;
	const worktree = normalizeStatusCode(status.worktree);
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

function normalizeStatusCode(code: string | undefined): string | undefined {
	if (!code || [" ", "."].includes(code)) return undefined;
	return ["M", "A", "D", "R", "C"].includes(code) ? code : code === "?" ? "?" : "M";
}

async function toggleDirectory(state: ExplorerState, entry: TreeEntry, focusChild = false): Promise<void> {
	invalidateNavigation(state);
	state.location = { path: entry.path, kind: "directory" };
	renderPathBar(state);
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
	if (row && ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu")) {
		event.preventDefault();
		const entry = findVisibleEntry(state, row.dataset.path ?? "");
		if (entry) openContextMenu(state, entry, row, false);
		return;
	}
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
	if (target) {
		markDurableMutation(state);
		focusPath(state, target);
	}
}

function isAbsolutePath(value: string): boolean {
	return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function displayPath(value: string): string { return value.replace(/\\/g, "/"); }
function absolutePathForRelative(state: ExplorerState, relativePath: string): string {
	const rootPath = displayPath(state.rootPath ?? "");
	return rootPath ? `${rootPath.replace(/\/$/, "")}/${relativePath}` : relativePath;
}
function absoluteLocation(state: ExplorerState): string {
	if (!state.rootPath) return state.location.path;
	const rootPath = displayPath(state.rootPath);
	if (!state.location.path) return rootPath;
	return `${rootPath.replace(/\/$/, "")}/${state.location.path}`;
}

function filesystemParent(rootPath?: string): string | undefined {
	if (!rootPath) return undefined;
	const normalized = rootPath.replace(/[\\/]+$/, "");
	if (/^[A-Za-z]:$/.test(normalized) || normalized === "" || normalized === "/") return undefined;
	const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
	if (index < 0) return undefined;
	const parent = normalized.slice(0, index) || "/";
	return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

function resetForRootChange(state: ExplorerState, rootPath: string): void {
	state.rootPath = rootPath;
	// Fence every request issued under the previous root. The current absolute
	// navigation owns navigationGeneration, so leave that counter untouched.
	state.refreshGeneration += 1;
	state.selectionGeneration += 1;
	state.search.generation += 1;
	if (state.search.timer !== undefined) window.clearTimeout(state.search.timer);
	state.search = { query: "", phase: "idle", results: [], activeIndex: -1, count: 0, truncated: false, generation: state.search.generation };
	state.searchInput.value = "";
	state.directories.clear();
	state.discovered.clear();
	state.expanded.clear();
	state.statuses.clear();
	state.ancestors.clear();
	state.gitAvailable = undefined;
	state.selected = undefined;
	state.selectedKind = undefined;
	state.focused = "";
	state.filePreview = idlePreview();
	state.diffPreview = idlePreview();
}

function absoluteBreadcrumbSegments(rootPath: string): Array<{ label: string; relativePath: string }> {
	const displayed = displayPath(rootPath);
	const windows = /^[A-Za-z]:\//.test(displayed) || displayed.startsWith("//");
	const rootParts = displayed.split(/\/+/).filter(Boolean);
	if (!windows && displayed.startsWith("/")) rootParts.unshift("/");
	return rootParts.map((label, index) => {
		let absolute = rootParts.slice(0, index + 1).join("/");
		if (!windows && displayed.startsWith("/")) absolute = index === 0 ? "/" : `/${rootParts.slice(1, index + 1).join("/")}`;
		if (windows && displayed.startsWith("//")) absolute = `//${absolute}`;
		if (windows && index === 0 && /^[A-Za-z]:$/.test(label)) absolute = `${label}/`;
		return { label, relativePath: absolute };
	});
}

function renderPathBar(state: ExplorerState): void {
	state.pathBar.replaceChildren();
	state.upButton.disabled = !state.location.path && !filesystemParent(state.rootPath);
	if (state.pathEditing) {
		const form = el("div", "bb-explorer-path-edit");
		form.setAttribute("aria-busy", String(state.pathLoading));
		const input = el("input", "bb-explorer-path-input");
		input.type = "text";
		input.value = state.pathDraft;
		input.placeholder = state.rootPath ? displayPath(state.rootPath) : "Enter an absolute path";
		input.setAttribute("aria-label", "Relative path");
		input.setAttribute("aria-describedby", `bb-explorer-path-help-${hash(state.sid)}`);
		input.setAttribute("aria-invalid", String(!!state.pathError));
		input.readOnly = state.pathLoading;
		form.append(input);
		state.pathBar.append(form);
		const help = el("span", "bb-explorer-path-help", state.pathError?.message ?? "Enter an absolute filesystem path.");
		help.id = `bb-explorer-path-help-${hash(state.sid)}`;
		if (state.pathError) {
			help.classList.add("is-error");
			if (state.pathError.retryable) {
				const retry = textButton("Retry", "retry-path");
				help.append(retry);
			}
		}
		state.pathBar.append(help);
		return;
	}
	const nav = el("nav", "bb-explorer-breadcrumbs");
	nav.setAttribute("aria-label", "Current absolute path");
	nav.title = absoluteLocation(state);
	const segments = state.location.path ? state.location.path.split("/") : [];
	const absoluteSegments = state.rootPath ? absoluteBreadcrumbSegments(state.rootPath) : [{ label: "Session files", relativePath: "" }];
	absoluteSegments.forEach((segment, index) => {
		if (index) {
			const separator = el("span", "bb-explorer-path-separator", "/");
			separator.setAttribute("aria-hidden", "true");
			nav.append(separator);
		}
		const button = el("button", "bb-explorer-crumb", segment.label);
		button.type = "button";
		button.dataset.absolutePath = segment.relativePath;
		button.setAttribute("aria-label", segments.length || index < absoluteSegments.length - 1 ? `Go to ${segment.relativePath}` : `Current root, ${segment.relativePath}`);
		if (!segments.length && index === absoluteSegments.length - 1) button.setAttribute("aria-current", "location");
		nav.append(button);
	});
	segments.forEach((segment, index) => {
		const separator = el("span", "bb-explorer-path-separator", "/");
		separator.setAttribute("aria-hidden", "true");
		const button = el("button", "bb-explorer-crumb", segment);
		button.type = "button";
		button.dataset.path = segments.slice(0, index + 1).join("/");
		button.title = segment;
		const current = index === segments.length - 1;
		button.setAttribute("aria-label", current ? `Current ${state.location.kind === "file" ? "file" : "item"}, ${segment}` : `Go to ${segment}`);
		if (current) button.setAttribute("aria-current", "location");
		nav.append(separator, button);
	});
	const edit = iconButton("edit", "Edit path (Ctrl+L)", "bb-explorer-path-button");
	edit.dataset.action = "edit-path";
	state.pathBar.append(state.upButton, nav, edit);
	requestAnimationFrame(() => nav.querySelector("[aria-current]")?.scrollIntoView?.({ inline: "nearest", block: "nearest" }));
}

function onPathBarClick(state: ExplorerState, event: Event): void {
	const target = event.target as Element | null;
	const retry = target?.closest<HTMLElement>("[data-action=retry-path]");
	if (retry) { void navigateToPath(state, state.pathDraft, "path"); return; }
	if (target?.closest("[data-action=up-path]")) {
		if (state.location.path) void navigateToPath(state, parentOf(state.location.path), "breadcrumb");
		else {
			const parent = filesystemParent(state.rootPath);
			if (parent) void navigateToPath(state, parent, "path");
		}
		return;
	}
	const crumb = target?.closest<HTMLButtonElement>("button.bb-explorer-crumb");
	if (crumb) {
		if (state.search.query) clearSearch(state, true);
		void navigateToPath(state, crumb.dataset.absolutePath ?? crumb.dataset.path ?? "", crumb.dataset.absolutePath ? "path" : "breadcrumb");
		return;
	}
	if (target?.closest("[data-action=edit-path]") || target === state.pathBar || target?.classList.contains("bb-explorer-breadcrumbs")) enterPathEdit(state, target as HTMLElement | null);
}

function onPathBarKeydown(state: ExplorerState, event: KeyboardEvent): void {
	const input = (event.target as Element | null)?.closest<HTMLInputElement>(".bb-explorer-path-input");
	if (input) {
		if (event.key === "Enter" && !state.pathLoading) {
			event.preventDefault();
			state.pathDraft = input.value;
			void navigateToPath(state, input.value, "path");
		} else if (event.key === "Escape") {
			event.preventDefault();
			cancelPathEdit(state, true);
		} else if (event.key !== "Tab") {
			state.pathDraft = input.value;
			state.pathError = undefined;
		}
		return;
	}
	const crumb = (event.target as Element | null)?.closest<HTMLButtonElement>(".bb-explorer-crumb");
	if (crumb && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
		const buttons = [...state.pathBar.querySelectorAll<HTMLButtonElement>(".bb-explorer-crumb")];
		const index = buttons.indexOf(crumb);
		buttons[index + (event.key === "ArrowRight" ? 1 : -1)]?.focus();
		event.preventDefault();
	}
}

function enterPathEdit(state: ExplorerState, invoker?: HTMLElement | null): void {
	if (state.pathEditing) return;
	if (state.search.query) clearSearch(state, true);
	state.pathEditing = true;
	state.pathDraft = absoluteLocation(state);
	state.pathOrigin = { ...state.location };
	state.pathInvoker = invoker?.closest<HTMLElement>("button") ?? undefined;
	state.pathError = undefined;
	state.pathLoading = false;
	renderPathBar(state);
	requestAnimationFrame(() => {
		const input = state.pathBar.querySelector<HTMLInputElement>(".bb-explorer-path-input");
		input?.focus();
		input?.select();
	});
}

function cancelPathEdit(state: ExplorerState, restoreFocus: boolean): void {
	invalidateNavigation(state);
	if (state.pathOrigin) state.location = { ...state.pathOrigin };
	const invoker = state.pathInvoker;
	state.pathEditing = false;
	state.pathLoading = false;
	state.pathError = undefined;
	state.pathDraft = "";
	state.pathOrigin = undefined;
	state.pathInvoker = undefined;
	renderPathBar(state);
	if (restoreFocus) requestAnimationFrame(() => {
		if (invoker?.isConnected) invoker.focus();
		else state.pathBar.querySelector<HTMLButtonElement>("[data-action=edit-path]")?.focus();
	});
}

async function navigateToPath(state: ExplorerState, rawPath: string, source: "path" | "breadcrumb" | "search"): Promise<boolean> {
	closeContextMenu(state, false);
	if (source === "path" && state.pathLoading) return false;
	const absolute = source === "path" && isAbsolutePath(rawPath);
	const path = absolute ? rawPath : rawPath;
	if ((!absolute && safeRelative(path, true) === undefined) || (!absolute && path.split("/").includes(".git"))) {
		if (source === "path") {
			state.pathDraft = rawPath;
			state.pathError = { code: "INVALID_PATH", message: "Enter an absolute filesystem path.", retryable: false };
			renderPathBar(state);
			requestAnimationFrame(() => state.pathBar.querySelector<HTMLInputElement>(".bb-explorer-path-input")?.focus());
			setAlert(state, state.pathError.message);
		}
		return false;
	}
	const generation = beginNavigation(state);
	if (source === "path") {
		state.pathDraft = rawPath;
		state.pathLoading = true;
		state.pathError = undefined;
		renderPathBar(state);
		requestAnimationFrame(() => state.pathBar.querySelector<HTMLInputElement>(".bb-explorer-path-input")?.focus());
		setLive(state, `Opening ${path || "Session files"}…`);
	}
	try {
		const value = recordOf(await callValue(state, "resolve", absolute ? { absolutePath: nativePath(path) } : rootedBody(state, { path }))) ?? {};
		if (generation !== state.navigationGeneration) return false;
		const resolvedPath = safeRelative(value.path, true);
		const kind = value.kind;
		const nextRootPath = typeof value.rootPath === "string" && value.rootPath ? value.rootPath : state.rootPath;
		if (resolvedPath === undefined || !["root", "directory", "file", "symlink", "other"].includes(kind)) throw { code: "READ_FAILED" };
		if (absolute && nextRootPath) resetForRootChange(state, nextRootPath);
		for (const rawEntry of arrayOf(value.chain)) {
			const entry = normalizeEntry(rawEntry);
			if (entry) state.discovered.set(entry.path, entry);
		}
		for (const parent of parentsOf(resolvedPath)) state.expanded.add(parent);
		if (kind === "directory" && state.directories.get(resolvedPath)?.state !== "ready") state.expanded.delete(resolvedPath);
		if (source !== "search" && state.changedOnly && state.gitAvailable === true && resolvedPath && !state.statuses.has(resolvedPath) && !state.ancestors.has(resolvedPath)) {
			state.changedOnly = false;
			setLive(state, "Showing all files so the requested path can be revealed.");
		}
		state.location = { path: resolvedPath, kind: kind as LocationKind };
		if (absolute) {
			const listed = await loadDirectory(state, "", true, state.refreshGeneration);
			if (!listed || generation !== state.navigationGeneration) return false;
		}
		if (source === "path") commitPathEdit(state);
		if (kind === "root") {
			state.focused = nearestFocus(state.focused, flattenRows(state).map((row) => row.entry.path));
			if (state.narrow) showTree(state, false);
		} else {
			state.focused = resolvedPath;
			if (source !== "search") state.pendingFocus = { path: resolvedPath, generation };
			if (kind === "file") {
				const entry = state.discovered.get(resolvedPath) ?? normalizeEntry({ path: resolvedPath, name: resolvedPath.split("/").pop(), kind });
				if (entry) await selectEntry(state, entry, generation);
				if (generation !== state.navigationGeneration || state.selected !== resolvedPath) return false;
			} else {
				if (state.narrow) showTree(state, false);
				if (kind !== "directory") setLive(state, "This item cannot be opened. It can still be revealed in the tree.");
			}
		}
		if (generation !== state.navigationGeneration) return false;
		renderPathBar(state);
		renderTree(state);
		queueStore(state);
		return true;
	} catch (error) {
		if (generation !== state.navigationGeneration) return false;
		if (source === "path") {
			state.pathLoading = false;
			state.pathError = mapNavigationFailure(error);
			renderPathBar(state);
			requestAnimationFrame(() => state.pathBar.querySelector<HTMLInputElement>(".bb-explorer-path-input")?.focus());
			setAlert(state, state.pathError.message);
		} else setAlert(state, mapNavigationFailure(error).message);
		return false;
	}
}

function beginNavigation(state: ExplorerState): number {
	state.pendingFocus = undefined;
	return ++state.navigationGeneration;
}

function invalidateNavigation(state: ExplorerState): void {
	state.pendingFocus = undefined;
	state.navigationGeneration += 1;
}

function commitPathEdit(state: ExplorerState): void {
	state.pathEditing = false;
	state.pathLoading = false;
	state.pathError = undefined;
	state.pathDraft = "";
	state.pathOrigin = undefined;
	state.pathInvoker = undefined;
	renderPathBar(state);
}

function mapNavigationFailure(error: unknown): PanelFailure {
	const failure = mapRouteFailure(error, "Could not open this path.");
	const messages: Record<string, string> = {
		INVALID_PATH: "Enter an absolute filesystem path.",
		NOT_FOUND: "No file or folder exists at this path.",
		NOT_DIRECTORY: "This path is not a folder.",
		UNSUPPORTED_FILE: "This item cannot be opened. It can still be revealed in the tree.",
		FS_TIMEOUT: "Path lookup timed out.",
		READ_FAILED: "Could not open this path.",
	};
	return { ...failure, message: failure.code ? messages[failure.code] ?? failure.message : failure.message };
}

function onSearchInput(state: ExplorerState): void {
	if (state.pathEditing) cancelPathEdit(state, false);
	const query = state.searchInput.value;
	if (!state.search.query && query) state.search.snapshot = captureBrowseSnapshot(state);
	state.search.query = query;
	state.search.generation += 1;
	if (state.search.timer !== undefined) window.clearTimeout(state.search.timer);
	state.search.results = [];
	state.search.activeIndex = -1;
	state.search.error = undefined;
	if (!query) {
		clearSearch(state, true);
		return;
	}
	state.search.phase = "debounce";
	renderTree(state);
	state.search.timer = window.setTimeout(() => void runSearch(state, state.search.generation, query), SEARCH_DEBOUNCE_MS);
}

function scheduleSearch(state: ExplorerState, immediate: boolean): void {
	if (!state.search.query) return;
	state.search.generation += 1;
	if (state.search.timer !== undefined) window.clearTimeout(state.search.timer);
	const generation = state.search.generation;
	const query = state.search.query;
	state.search.phase = immediate ? "loading" : "debounce";
	state.search.results = [];
	state.search.error = undefined;
	renderTree(state);
	if (immediate) void runSearch(state, generation, query);
	else state.search.timer = window.setTimeout(() => void runSearch(state, generation, query), SEARCH_DEBOUNCE_MS);
}

async function runSearch(state: ExplorerState, generation: number, query: string): Promise<void> {
	if (generation !== state.search.generation || query !== state.search.query) return;
	state.search.phase = "loading";
	renderTree(state);
	setLive(state, "Searching Session files.");
	try {
		const value = recordOf(await callValue(state, "search", rootedBody(state, { query }))) ?? {};
		if (generation !== state.search.generation || query !== state.search.query) return;
		state.search.results = arrayOf(value.results).map(normalizeEntry).filter((entry): entry is TreeEntry => !!entry);
		state.search.count = typeof value.count === "number" ? value.count : state.search.results.length;
		state.search.limit = typeof value.limit === "number" ? value.limit : undefined;
		state.search.truncated = value.truncated === true;
		state.search.activeIndex = -1;
		state.search.phase = "ready";
		renderTree(state);
		setLive(state, `${state.search.count} ${state.search.count === 1 ? "result" : "results"} for ${query}.${state.search.truncated ? " Results truncated." : ""}`);
	} catch (error) {
		if (generation !== state.search.generation || query !== state.search.query) return;
		const failure = mapRouteFailure(error, "Couldn’t search Session files.");
		state.search.error = { ...failure, message: failure.code === "FS_TIMEOUT" ? "Search timed out." : "Couldn’t search Session files." };
		state.search.phase = "error";
		renderTree(state);
		setAlert(state, state.search.error.message);
	}
}

function onSearchKeydown(state: ExplorerState, event: KeyboardEvent): void {
	const length = state.search.results.length;
	if (event.key === "Escape" && state.search.query) {
		event.preventDefault();
		clearSearch(state, true);
		state.searchInput.focus();
		return;
	}
	if (!state.search.query || !length) return;
	let next: number | undefined;
	if (event.key === "ArrowDown") next = state.search.activeIndex < 0 ? 0 : (state.search.activeIndex + 1) % length;
	else if (event.key === "ArrowUp") next = state.search.activeIndex < 0 ? length - 1 : (state.search.activeIndex - 1 + length) % length;
	else if ((event.ctrlKey || event.metaKey) && event.key === "Home") next = 0;
	else if ((event.ctrlKey || event.metaKey) && event.key === "End") next = length - 1;
	else if (event.key === "Enter") {
		event.preventDefault();
		void activateSearchResult(state, state.search.activeIndex < 0 ? 0 : state.search.activeIndex, false);
		return;
	} else return;
	event.preventDefault();
	state.search.activeIndex = next;
	renderTree(state);
	state.searchInput.focus();
}

async function activateSearchResult(state: ExplorerState, index: number, pointer: boolean): Promise<void> {
	const entry = state.search.results[index];
	if (!entry) return;
	state.search.activeIndex = index;
	if (entry.kind === "file") {
		await navigateToPath(state, entry.path, "search");
		if (!pointer) state.searchInput.focus();
		return;
	}
	await revealSearchResult(state, entry);
}

async function revealSearchResult(state: ExplorerState, entry: TreeEntry): Promise<void> {
	clearSearch(state, true);
	if (state.changedOnly && !state.statuses.has(entry.path) && !state.ancestors.has(entry.path)) {
		state.changedOnly = false;
		setLive(state, "Showing all files so the search result can be revealed.");
		queueStore(state);
	}
	await navigateToPath(state, entry.path, "breadcrumb");
}

function captureBrowseSnapshot(state: ExplorerState): BrowseSnapshot {
	return {
		expanded: new Set(state.expanded), focused: state.focused, selected: state.selected, selectedKind: state.selectedKind,
		location: { ...state.location }, view: state.view, preferredView: state.preferredView, narrowPane: state.narrowPane,
		filePreview: { ...state.filePreview }, diffPreview: { ...state.diffPreview },
	};
}

function clearSearch(state: ExplorerState, restore: boolean): void {
	state.search.generation += 1;
	invalidateNavigation(state);
	state.selectionGeneration += 1;
	if (state.search.timer !== undefined) window.clearTimeout(state.search.timer);
	const snapshot = state.search.snapshot;
	let previewToReload: string | undefined;
	if (restore && snapshot) {
		state.expanded = new Set(snapshot.expanded);
		state.focused = snapshot.focused;
		state.selected = snapshot.selected;
		state.selectedKind = snapshot.selectedKind;
		state.location = { ...snapshot.location };
		state.view = snapshot.view;
		state.preferredView = snapshot.preferredView;
		state.narrowPane = snapshot.narrowPane;
		state.filePreview = { ...snapshot.filePreview };
		state.diffPreview = { ...snapshot.diffPreview };
		const status = state.selected ? state.statuses.get(state.selected) : undefined;
		const activePreview = state.view === "diff" && isChanged(status) ? state.diffPreview : state.filePreview;
		if (state.selected && activePreview.state === "loading" && activePreview.path === state.selected) {
			previewToReload = state.selected;
		}
		applyNarrowPane(state);
		renderPreview(state);
		renderPathBar(state);
	}
	state.search.query = "";
	state.search.phase = "idle";
	state.search.results = [];
	state.search.activeIndex = -1;
	state.search.count = 0;
	state.search.truncated = false;
	state.search.error = undefined;
	state.search.snapshot = undefined;
	renderTree(state);
	if (restore && snapshot) queueStore(state);
	if (state.active && previewToReload) void loadSelectedContent(state, previewToReload, false);
}

function toggleChangedOnly(state: ExplorerState): void {
	if (state.gitAvailable !== true) return;
	closeContextMenu(state, false);
	state.changedOnly = !state.changedOnly;
	const paths = flattenRows(state).map((row) => row.entry.path);
	state.focused = nearestFocus(state.focused, paths);
	renderTree(state);
	queueStore(state);
	const count = state.statuses.size;
	setLive(state, state.changedOnly ? `Showing changed files only, ${count} changed ${count === 1 ? "file" : "files"}.` : "Showing all files.");
}

function collapseAll(state: ExplorerState): void {
	if (!state.expanded.size || state.search.query) return;
	closeContextMenu(state, false);
	state.expanded.clear();
	const paths = flattenRows(state).map((row) => row.entry.path);
	state.focused = nearestFocus(state.focused, paths);
	renderTree(state);
	queueStore(state);
	setLive(state, "All folders collapsed.");
}

function onTreeContextMenu(state: ExplorerState, event: MouseEvent): void {
	const row = (event.target as Element | null)?.closest<HTMLElement>("[role=treeitem][data-path]");
	if (!row) return;
	const entry = findVisibleEntry(state, row.dataset.path ?? "");
	if (!entry) return;
	event.preventDefault();
	openContextMenu(state, entry, document.activeElement as HTMLElement | null, true, event.clientX, event.clientY);
}

function openContextMenu(state: ExplorerState, target: TreeEntry, invoker?: HTMLElement | null, pointer = false, x?: number, y?: number): void {
	closeContextMenu(state, false);
	const row = state.tree.querySelector<HTMLElement>(`[data-path="${cssEscape(target.path)}"]`);
	const rect = row?.getBoundingClientRect();
	state.menu = {
		target, invoker: invoker ?? undefined, pointer,
		x: x ?? rect?.left ?? 8, y: y ?? rect?.bottom ?? 8,
	};
	row?.classList.add("is-context-target");
	const menu = el("div", "bb-explorer-context-menu");
	menu.setAttribute("role", "menu");
	menu.setAttribute("aria-label", "Path actions");
	const actions: Array<{ action: "set-root" | "copy-path" | "copy-name"; label: string }> = [
		...(target.kind === "directory" && !target.virtual ? [{ action: "set-root" as const, label: "Set root" }] : []),
		{ action: "copy-path", label: "Copy relative path" },
		{ action: "copy-name", label: target.kind === "directory" ? "Copy folder name" : "Copy filename" },
	];
	for (const { action, label } of actions) {
		const item = el("button", "bb-explorer-menuitem", label);
		item.type = "button";
		item.setAttribute("role", "menuitem");
		item.dataset.action = action;
		item.addEventListener("click", () => action === "set-root" ? void setDirectoryRoot(state) : void copyPathAction(state, action));
		menu.append(item);
	}
	menu.addEventListener("keydown", (event) => onContextMenuKeydown(state, event));
	state.root.append(menu);
	state.menuDocumentClick = () => closeContextMenu(state, true);
	document.addEventListener("click", state.menuDocumentClick);
	const width = menu.offsetWidth || 200;
	const height = menu.offsetHeight || 70;
	menu.style.left = `${Math.max(8, Math.min(state.menu.x, window.innerWidth - width - 8))}px`;
	menu.style.top = `${Math.max(8, Math.min(state.menu.y, window.innerHeight - height - 8))}px`;
	requestAnimationFrame(() => menu.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus());
}

function onContextMenuKeydown(state: ExplorerState, event: KeyboardEvent): void {
	const items = [...state.root.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
	const index = items.indexOf(document.activeElement as HTMLButtonElement);
	let next: number | undefined;
	if (event.key === "ArrowDown") next = (index + 1) % items.length;
	else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
	else if (event.key === "Home") next = 0;
	else if (event.key === "End") next = items.length - 1;
	else if (event.key === "Escape") { event.preventDefault(); closeContextMenu(state, true); return; }
	else if (event.key === "Tab") { closeContextMenu(state, true); return; }
	else return;
	event.preventDefault();
	items[next]?.focus();
}

function closeContextMenu(state: ExplorerState, restoreFocus: boolean): void {
	if (!state.menu) return;
	const invoker = state.menu.invoker;
	if (state.menuDocumentClick) document.removeEventListener("click", state.menuDocumentClick);
	state.menuDocumentClick = undefined;
	state.root.querySelector(".bb-explorer-context-menu")?.remove();
	state.tree.querySelector(".is-context-target")?.classList.remove("is-context-target");
	state.menu = undefined;
	if (restoreFocus) requestAnimationFrame(() => invoker?.isConnected && invoker.focus());
}

async function setDirectoryRoot(state: ExplorerState): Promise<void> {
	const menu = state.menu;
	if (!menu || menu.target.kind !== "directory" || menu.target.virtual) return;
	const absolutePath = absolutePathForRelative(state, menu.target.path);
	closeContextMenu(state, false);
	await navigateToPath(state, absolutePath, "path");
}

async function copyPathAction(state: ExplorerState, action: "copy-path" | "copy-name"): Promise<void> {
	const menu = state.menu;
	if (!menu) return;
	const value = action === "copy-path" ? menu.target.path : menu.target.path.split("/").pop() ?? menu.target.name;
	const invoker = menu.invoker;
	closeContextMenu(state, false);
	try {
		if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
		await navigator.clipboard.writeText(value);
		state.copyMessage = { text: action === "copy-path" ? "Relative path copied" : "Filename copied", error: false };
		if (state.copyTimer !== undefined) window.clearTimeout(state.copyTimer);
		state.copyTimer = window.setTimeout(() => { state.copyMessage = undefined; renderDiscoveryControls(state); }, COPY_FEEDBACK_MS);
		setLive(state, state.copyMessage.text);
	} catch {
		state.copyMessage = { text: "Couldn’t copy. Clipboard access is unavailable.", error: true };
	}
	renderDiscoveryControls(state);
	requestAnimationFrame(() => invoker?.isConnected && invoker.focus());
}

async function selectEntry(state: ExplorerState, entry: TreeEntry, navigationGeneration?: number): Promise<void> {
	if (navigationGeneration === undefined) invalidateNavigation(state);
	else if (navigationGeneration !== state.navigationGeneration) return;
	state.selected = entry.path;
	state.selectedKind = entry.kind;
	state.focused = entry.path;
	state.location = { path: entry.path, kind: entry.kind };
	renderPathBar(state);
	const status = state.statuses.get(entry.path);
	state.view = isDeleted(status) ? "diff" : state.preferredView;
	state.filePreview = idlePreview(entry.path);
	state.diffPreview = idlePreview(entry.path);
	if (state.narrow) {
		state.lastFocusedElement = state.search.query
			? state.searchInput
			: state.tree.querySelector(`[data-path="${cssEscape(entry.path)}"]`) as HTMLElement | null ?? undefined;
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
		const value = recordOf(await callValue(state, "read", rootedBody(state, { path }))) ?? {};
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
		const value = recordOf(await callValue(state, "diff", rootedBody(state, { path }))) ?? {};
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
		state.preferredView = state.view;
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
	const all = new Map<string, TreeEntry>();
	for (const directory of state.directories.values()) for (const entry of directory.entries) all.set(entry.path, entry);
	for (const entry of state.discovered.values()) all.set(entry.path, entry);
	for (const status of state.statuses.values()) {
		if (!all.has(status.path)) all.set(status.path, { path: status.path, name: status.path.split("/").pop()!, kind: "file", virtual: true });
	}
	for (const path of [...state.expanded]) {
		const entry = all.get(path);
		if (!entry || entry.kind !== "directory") state.expanded.delete(path);
	}
	if (state.selected && !all.has(state.selected)) {
		state.selected = undefined;
		state.selectedKind = undefined;
		state.filePreview = idlePreview();
		state.diffPreview = idlePreview();
		state.narrowPane = "tree";
		renderPreview(state);
	} else if (state.selected) {
		state.selectedKind = all.get(state.selected)?.kind;
	}
	if (state.location.path) {
		const locationEntry = all.get(state.location.path);
		if (locationEntry) state.location = { path: locationEntry.path, kind: locationEntry.kind };
		else if (state.selected && all.has(state.selected)) state.location = { path: state.selected, kind: all.get(state.selected)!.kind };
		else state.location = { path: "", kind: "root" };
	}
	renderPathBar(state);
	const visible = flattenRows(state).map((row) => row.entry.path);
	if (!state.focused || !visible.includes(state.focused)) state.focused = nearestFocus(state.focused, visible);
}

async function restoreUiState(state: ExplorerState, lifecycle: number): Promise<void> {
	if (!state.host?.capabilities?.store || !state.host.store) return;
	const store = state.host.store;
	const mutationGeneration = state.durableMutationGeneration;
	try {
		let stored: unknown;
		if (store.read) {
			const result = await store.read(`ui/${state.sid}`);
			if (result.state === "present") stored = result.value;
		} else if (store.get) stored = await store.get(`ui/${state.sid}`);
		if (!ownsLifecycle(state, lifecycle)) return;
		if (mutationGeneration !== state.durableMutationGeneration) return;
		const value = recordOf(stored);
		if (value?.version !== STORE_VERSION) return;
		if (typeof value.rootPath === "string" && isAbsolutePath(value.rootPath)) state.rootPath = value.rootPath;
		for (const candidate of arrayOf(value.expanded)) {
			const path = safeRelative(candidate, false);
			if (path) state.expanded.add(path);
		}
		const selected = safeRelative(value.selected, false);
		if (selected) state.selected = selected;
		const focused = safeRelative(value.focused, false);
		if (focused) state.focused = focused;
		if (value.view === "file" || value.view === "diff") state.view = state.preferredView = value.view;
		state.changedOnly = value.changedOnly === true;
	} catch {
		// Persistence is best-effort and never blocks browsing.
	}
}

function markDurableMutation(state: ExplorerState): void {
	state.durableMutationGeneration += 1;
}

function queueStore(state: ExplorerState, userMutation = true): void {
	if (userMutation) markDurableMutation(state);
	if (!state.host?.capabilities?.store || !state.host.store?.put) return;
	if (state.storeTimer !== undefined) window.clearTimeout(state.storeTimer);
	state.storeTimer = window.setTimeout(() => {
		state.storeTimer = undefined;
		const value = {
			version: STORE_VERSION,
			...(state.rootPath ? { rootPath: state.rootPath } : {}),
			expanded: [...state.expanded].filter((path) => safeRelative(path, false) !== undefined),
			...(state.selected && safeRelative(state.selected, false) ? { selected: state.selected } : {}),
			...(state.focused && safeRelative(state.focused, false) ? { focused: state.focused } : {}),
			view: state.view,
			changedOnly: state.changedOnly,
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
function gitToneForStatus(status: StatusRecord): "added" | "deleted" | "modified" {
	if (status.conflict || status.summary === "conflict" || status.deleted || status.summary === "deleted" || status.index === "D" || status.worktree === "D" || status.index === "U" || status.worktree === "U") return "deleted";
	if (status.summary === "modified" || status.renamed || status.copied || status.index === "M" || status.worktree === "M" || status.index === "R" || status.worktree === "R" || status.index === "C" || status.worktree === "C") return "modified";
	return "added";
}
type GitTone = "added" | "deleted" | "modified";
type GitDecoration = { kind: "direct"; tone: GitTone } | { kind: "descendant"; tones: GitTone[] };
function gitDecorationForEntry(state: ExplorerState, entry: TreeEntry): GitDecoration | undefined {
	const direct = state.statuses.get(entry.path);
	if (direct) return { kind: "direct", tone: gitToneForStatus(direct) };
	if (entry.kind !== "directory") return undefined;
	const tones = new Set<GitTone>();
	const prefix = `${entry.path}/`;
	for (const [path, status] of state.statuses) {
		if (path.startsWith(prefix)) tones.add(gitToneForStatus(status));
	}
	const ordered = (["added", "modified", "deleted"] as const).filter((tone) => tones.has(tone));
	if (entry.virtual && ordered.length === 1 && ordered[0] === "deleted") return { kind: "direct", tone: "deleted" };
	return ordered.length ? { kind: "descendant", tones: ordered } : undefined;
}
function folderOutlineSvg(tones: GitTone[], key: string): string {
	const colors: Record<GitTone, string> = { added: "var(--positive)", modified: "var(--warning)", deleted: "var(--negative)" };
	if (tones.length === 1) return iconSvg("folder", colors[tones[0]]);
	const id = `folder-gradient-${hash(key)}`;
	const count = tones.length;
	const stops = tones.map((tone, index) => {
		const start = Math.round(index * 100 / count);
		const end = Math.round((index + 1) * 100 / count);
		return `<stop offset="${start}%" stop-color="${colors[tone]}"/><stop offset="${end}%" stop-color="${colors[tone]}"/>`;
	}).join("");
	const defs = `<defs><linearGradient id="${id}" x1="0" y1="1" x2="1" y2="0">${stops}</linearGradient></defs>`;
	return iconSvg("folder", `url(#${id})`, defs);
}
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
function setLive(state: ExplorerState, message: string): void {
	if (state.liveFrame !== undefined) cancelAnimationFrame(state.liveFrame);
	state.live.textContent = "";
	state.liveFrame = requestAnimationFrame(() => {
		state.liveFrame = undefined;
		if (state.active) state.live.textContent = message;
	});
}
function setAlert(state: ExplorerState, message: string): void {
	if (state.alertFrame !== undefined) cancelAnimationFrame(state.alertFrame);
	state.alert.textContent = "";
	state.alertFrame = requestAnimationFrame(() => {
		state.alertFrame = undefined;
		if (state.active) state.alert.textContent = message;
	});
}
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

const icons: Record<string, IconNode> = {
	"arrow-up": FolderUp,
	"search": Search,
	"x": X,
	"diff": Diff,
	"collapse": ListCollapse,
	"edit": Pencil,
	"arrow-left": ArrowLeft,
	"chevron-right": ChevronRight,
	"chevron-down": ChevronDown,
	"folder": Folder,
	"file": File,
	"file-text": FileText,
	"file-code": FileCode2,
	"image": Image,
	"braces": Braces,
	"link": Link,
	"box": Box,
	"lock": Lock,
};

function iconSvg(name: string, stroke = "currentColor", prefix = ""): string {
	const nodes = icons[name] ?? File;
	const body = nodes.map(([tag, attrs]) => {
		const attributes = Object.entries(attrs).map(([key, value]) => `${key}="${String(value)}"`).join(" ");
		return `<${tag} ${attributes}/>`;
	}).join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${prefix}${body}</svg>`;
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
.bb-explorer-pathbar{min-height:2.75rem;display:flex;align-items:center;gap:.15rem;border-bottom:1px solid var(--border);background:var(--card);position:relative;padding:0 .35rem}.bb-explorer-breadcrumbs{display:flex;align-items:center;min-width:0;flex:1;overflow-x:auto;white-space:nowrap;padding:.25rem .2rem;scrollbar-width:thin;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.72rem}.bb-explorer-crumb,.bb-explorer-path-button{border:0;background:transparent;border-radius:.35rem;cursor:pointer;height:1.8rem}.bb-explorer-crumb{max-width:14rem;min-width:1.5rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:.15rem .3rem;color:var(--muted-foreground)}.bb-explorer-crumb:hover,.bb-explorer-path-button:hover:not(:disabled){background:color-mix(in oklch,var(--foreground) 7%,transparent)}.bb-explorer-crumb[aria-current]{font-weight:600;color:var(--foreground)}.bb-explorer-path-separator{color:var(--muted-foreground)}.bb-explorer-path-button{display:grid;place-items:center;flex:0 0 2rem}.bb-explorer-path-button:disabled{opacity:.4;cursor:default}.bb-explorer-button:focus-visible,.bb-explorer-back:focus-visible,.bb-explorer-path-button:focus-visible,.bb-explorer-control:focus-visible,.bb-explorer-crumb:focus-visible,.bb-explorer-menuitem:focus-visible{outline:2px solid var(--primary);outline-offset:1px}.bb-explorer-control:disabled,.bb-explorer-control[aria-disabled=true]{opacity:.55}.bb-explorer-path-edit{display:flex;align-items:center;gap:.35rem;min-width:0;width:100%;padding:.25rem .15rem}.bb-explorer-path-prefix{color:var(--muted-foreground);white-space:nowrap}.bb-explorer-path-input{min-width:0;flex:1;height:1.75rem;border:1px solid var(--border);border-radius:.35rem;background:var(--background);color:var(--foreground);padding:.2rem .4rem;font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.bb-explorer-path-input:focus{outline:2px solid var(--primary);outline-offset:-1px}.bb-explorer-path-input[aria-invalid=true]{border-color:var(--negative)}.bb-explorer-path-help{position:absolute;z-index:5;top:calc(100% + 1px);left:.5rem;right:.5rem;padding:.35rem .5rem;border:1px solid var(--border);border-radius:0 0 .35rem .35rem;background:var(--card);color:var(--muted-foreground);font-size:.72rem;display:flex;align-items:center;gap:.5rem}.bb-explorer-path-help:not(.is-error){position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0)}.bb-explorer-path-help.is-error{color:var(--negative)}
.bb-explorer-content{display:grid;grid-template-columns:var(--tree-pane-width,minmax(210px,32%)) 7px minmax(0,1fr);flex:1;min-height:0}.bb-explorer-tree-pane{min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--card)}.bb-explorer-splitter{position:relative;cursor:col-resize;touch-action:none;background:transparent}.bb-explorer-splitter::before{content:"";position:absolute;inset:0 3px;background:var(--border);transition:background 120ms ease}.bb-explorer-splitter:hover::before,.bb-explorer-splitter:focus-visible::before,.bb-explorer-splitter.is-dragging::before{inset-inline:2px;background:var(--primary)}.bb-explorer-splitter:focus-visible{outline:none}
.bb-explorer-tree-toolbar{display:flex;align-items:center;gap:.3rem;padding:.4rem .45rem;border-bottom:1px solid var(--border);flex-wrap:wrap}.bb-explorer-search{position:relative;display:flex;align-items:center;min-width:7.5rem;flex:1}.bb-explorer-search>svg{position:absolute;left:.45rem;width:.85rem;height:.85rem;color:var(--muted-foreground);pointer-events:none}.bb-explorer-search-input{width:100%;height:2rem;padding:.25rem 1.8rem .25rem 1.65rem;border:1px solid var(--border);border-radius:.4rem;background:transparent;color:var(--foreground);font:inherit;font-size:.75rem}.bb-explorer-search-input:focus{outline:2px solid var(--primary);outline-offset:-1px}.bb-explorer-search-input::-webkit-search-cancel-button{display:none}.bb-explorer-control{height:2rem;min-width:2rem;display:flex;align-items:center;justify-content:center;gap:.28rem;border:1px solid transparent;border-radius:.4rem;padding:0 .4rem;background:transparent;cursor:pointer}.bb-explorer-control:hover:not(:disabled):not([aria-disabled=true]){background:color-mix(in oklch,var(--foreground) 7%,transparent)}.bb-explorer-control[aria-pressed=true]{border-color:var(--primary);background:color-mix(in oklch,var(--primary) 13%,transparent);color:var(--primary)}.bb-explorer-clear-search{position:absolute;right:.1rem;padding:0;width:1.75rem;height:1.75rem}.bb-explorer-control-label{font-size:.7rem}.bb-explorer-feedback:empty{display:none}.bb-explorer-inline-feedback{display:flex;align-items:center;justify-content:space-between;gap:.5rem;padding:.3rem .55rem;border-bottom:1px solid var(--border);color:var(--positive);font-size:.72rem}.bb-explorer-inline-feedback.is-error{color:var(--negative)}.bb-explorer-tree{flex:1;min-height:0;overflow:auto;padding:.15rem 0 .5rem;outline:none}
.bb-explorer-row{--indent:calc((var(--tree-level) - 1)*.9rem);height:1.7rem;padding:0 .45rem 0 calc(.3rem + var(--indent));display:flex;align-items:center;gap:.28rem;min-width:max-content;width:100%;cursor:default;border-left:2px solid transparent;user-select:none}
.bb-explorer-row:hover{background:color-mix(in oklch,var(--foreground) 6%,transparent)}.bb-explorer-row[aria-selected=true]{background:color-mix(in oklch,var(--primary) 13%,transparent);border-left-color:var(--primary)}.bb-explorer-row:focus{outline:none;background:color-mix(in oklch,var(--primary) 18%,transparent)}.bb-explorer-row:focus-visible{box-shadow:inset 0 0 0 1px color-mix(in oklch,var(--primary) 65%,transparent)}.bb-explorer-row.is-context-target{box-shadow:inset 0 0 0 1px var(--primary)}
.bb-explorer-search-result{min-height:2.5rem;padding:.3rem .55rem;display:flex;align-items:center;gap:.35rem;cursor:pointer}.bb-explorer-search-result:hover,.bb-explorer-search-result[aria-selected=true]{background:color-mix(in oklch,var(--primary) 13%,transparent)}.bb-explorer-search-result-text{display:flex;flex-direction:column;min-width:0;flex:1}.bb-explorer-search-result-name,.bb-explorer-search-result-parent{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bb-explorer-search-result-parent{font-size:.68rem;color:var(--muted-foreground)}
.bb-explorer-twisty{width:.9rem;flex:0 0 .9rem;color:var(--muted-foreground);margin-right:-.1rem}.bb-explorer-twisty svg{width:.85rem;height:.85rem}.bb-explorer-icon{width:1rem;flex:0 0 1rem;color:var(--muted-foreground)}.bb-explorer-icon.kind-directory{color:var(--foreground)}.bb-explorer-icon.kind-directory.has-git-outline{color:inherit}.bb-explorer-name{position:relative;top:-1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:22rem}.bb-explorer-row.git-modified .bb-explorer-icon,.bb-explorer-row.git-modified .bb-explorer-name,.bb-explorer-search-result.git-modified .bb-explorer-icon,.bb-explorer-search-result.git-modified .bb-explorer-search-result-name{color:var(--warning)}.bb-explorer-row.git-added .bb-explorer-icon,.bb-explorer-row.git-added .bb-explorer-name,.bb-explorer-search-result.git-added .bb-explorer-icon,.bb-explorer-search-result.git-added .bb-explorer-search-result-name{color:var(--positive)}.bb-explorer-row.git-deleted .bb-explorer-icon,.bb-explorer-row.git-deleted .bb-explorer-name,.bb-explorer-search-result.git-deleted .bb-explorer-icon,.bb-explorer-search-result.git-deleted .bb-explorer-search-result-name{color:var(--negative)}.bb-explorer-badges{display:flex;margin-left:auto;gap:.14rem;padding-left:.5rem}.bb-explorer-badge{min-width:.9rem;font-size:.68rem;font-weight:700;text-align:center}.status-modified{color:var(--warning)}.status-added,.status-untracked{color:var(--positive)}.status-deleted,.status-conflict{color:var(--negative)}.status-renamed,.status-copied{color:var(--info)}.bb-explorer-ancestor{margin-left:auto;color:var(--warning);font-size:1rem;line-height:1}
.bb-explorer-tree-message{--indent:calc((var(--tree-level,1) - 1)*.9rem);padding:.42rem .6rem .42rem calc(1.75rem + var(--indent));color:var(--muted-foreground);font-size:.73rem;display:flex;align-items:center;gap:.5rem}.bb-explorer-tree-message.message-error{color:var(--negative)}.bb-explorer-tree-message.is-compact{border-bottom:1px solid var(--border)}
.bb-explorer-button{border:1px solid var(--border);border-radius:.35rem;padding:.18rem .48rem;background:var(--background);cursor:pointer}.bb-explorer-button:hover{border-color:var(--primary);color:var(--primary)}
.bb-explorer-preview-pane{min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--background)}.bb-explorer-back{display:none;align-items:center;gap:.25rem;border:0;border-bottom:1px solid var(--border);background:var(--card);padding:.5rem .65rem;cursor:pointer}.bb-explorer-preview{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}.bb-explorer-preview-header{min-height:2.35rem;display:flex;align-items:center;gap:.65rem;padding:.35rem .65rem;border-bottom:1px solid var(--border);background:var(--card)}.bb-explorer-preview-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.74rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}.bb-explorer-readonly{display:flex;align-items:center;gap:.25rem;color:var(--muted-foreground);font-size:.68rem;white-space:nowrap}.bb-explorer-readonly svg{width:.75rem;height:.75rem}
.bb-explorer-tabs{display:flex;align-self:stretch;margin:-.35rem 0}.bb-explorer-tabs .bb-explorer-button{border:0;border-radius:0;background:transparent;padding:.45rem .55rem;border-bottom:2px solid transparent;color:var(--muted-foreground)}.bb-explorer-tabs .bb-explorer-button[aria-selected=true]{border-bottom-color:var(--primary);color:var(--foreground)}
.bb-explorer-preview-empty,.bb-explorer-preview-message{margin:auto;display:flex;flex-direction:column;align-items:center;gap:.35rem;text-align:center;color:var(--muted-foreground);padding:1.5rem}.bb-explorer-preview-empty svg{width:1.6rem;height:1.6rem}.bb-explorer-preview-empty strong,.bb-explorer-preview-message strong{color:var(--foreground);font-weight:500}.bb-explorer-preview-message.message-error strong{color:var(--negative)}
.bb-explorer-code-scroll,.bb-explorer-diff-scroll{flex:1;min-height:0;overflow:auto;background:var(--background);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.75rem;line-height:1.5}.bb-explorer-code{min-width:max-content;padding:.35rem 0}.bb-explorer-code-line{display:grid;grid-template-columns:3.4rem minmax(0,1fr);min-height:1.12rem}.bb-explorer-line-number{position:sticky;left:0;text-align:right;padding-right:.8rem;color:var(--muted-foreground);background:var(--background);border-right:1px solid var(--border);user-select:none}.bb-explorer-line-code{white-space:pre;padding:0 .8rem}.hljs-keyword,.hljs-selector-tag,.hljs-literal{color:var(--chart-1)}.hljs-string,.hljs-attr{color:var(--chart-2)}.hljs-number,.hljs-symbol{color:var(--chart-3)}.hljs-comment,.hljs-quote{color:var(--muted-foreground);font-style:italic}.hljs-title,.hljs-function{color:var(--chart-4)}.hljs-variable,.hljs-template-variable{color:var(--chart-5)}
.bb-explorer-diff-file{min-width:max-content;padding-bottom:.65rem}.bb-explorer-diff-meta,.bb-explorer-hunk{padding:.16rem .65rem;color:var(--muted-foreground);background:color-mix(in oklch,var(--info) 8%,transparent)}.bb-explorer-hunk{color:var(--info);margin-top:.2rem}.bb-explorer-diff-line{display:grid;grid-template-columns:3.2rem 3.2rem minmax(0,1fr);min-height:1.12rem}.bb-explorer-diff-number{text-align:right;padding-right:.55rem;color:var(--muted-foreground);border-right:1px solid color-mix(in oklch,var(--border) 70%,transparent);user-select:none}.bb-explorer-diff-code{white-space:pre;padding:0 .65rem}.bb-explorer-diff-line.diff-add{background:color-mix(in oklch,var(--positive) 12%,transparent)}.bb-explorer-diff-line.diff-remove{background:color-mix(in oklch,var(--negative) 12%,transparent)}.bb-explorer-diff-line.diff-add .bb-explorer-diff-code{color:var(--positive)}.bb-explorer-diff-line.diff-remove .bb-explorer-diff-code{color:var(--negative)}
.bb-explorer-context-menu{position:fixed;z-index:1000;width:min(15rem,calc(100vw - 1rem));display:flex;flex-direction:column;gap:.125rem;padding:.25rem;border:1px solid var(--border);border-radius:.5rem;background:var(--popover,var(--background));box-shadow:0 .5rem 1.5rem color-mix(in oklch,var(--foreground) 16%,transparent)}.bb-explorer-menuitem{border:0;border-radius:.3rem;background:transparent;text-align:left;padding:.42rem .55rem;cursor:pointer}.bb-explorer-menuitem:hover,.bb-explorer-menuitem:focus{background:color-mix(in oklch,var(--primary) 12%,transparent);outline:none}
.bb-explorer-live{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.bb-explorer.is-narrow .bb-explorer-content{display:flex}.bb-explorer.is-narrow .bb-explorer-splitter{display:none}.bb-explorer.is-narrow .bb-explorer-tree-pane,.bb-explorer.is-narrow .bb-explorer-preview-pane{width:100%;border-right:0}.bb-explorer.is-narrow .bb-explorer-back:not([hidden]){display:flex}
[hidden]{display:none!important}@media (max-width:480px){.bb-explorer-breadcrumbs .bb-explorer-crumb:not(:last-child),.bb-explorer-breadcrumbs .bb-explorer-path-separator:not(:nth-last-child(2)){display:none}}@media (max-width:360px){.bb-explorer-control-label{display:none}}@media (max-width:300px){.bb-explorer-search{flex-basis:100%}.bb-explorer-tree-toolbar{justify-content:flex-end}.bb-explorer-search{order:-1}}
`;
	document.head.append(style);
}
