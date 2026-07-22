// Phase 4b: per-project Components tab — see docs/design/multi-repo-components.md §8.2.
// `renderProjectComponentsTab()` below covers the components list with inline
// edit. Repo scanning + workflow regeneration happen via the project assistant
// (opened by the "Open Project Assistant" button in the components header).
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Select, type SelectOption } from "@mariozechner/mini-lit/dist/Select.js";
import { html } from "lit";
import { live } from "lit/directives/live.js";
import { ArrowLeft, Brain, Bug, Check, FlaskConical, Image as ImageIcon, Loader2, Plus, RotateCcw, Sparkles, Trash2, X } from "lucide";
import { showHeaderToast } from "./header-toast.js";
import {
	getShortcuts,
	formatBinding,
	findConflict,
	isBrowserReserved,
	updateBinding,
	addBinding,
	removeBinding,
	resetBinding,
	resetAllBindings,
	saveBindings,
	bindingsEqual,
	type KeyBinding,
	type ShortcutEntry,
} from "./shortcut-registry.js";
import {
	renderApp,
	setProjects,
	state,
	SIDEBAR_FONT_SCALE_KEY,
	SIDEBAR_FONT_SCALE_DEFAULT,
	SIDEBAR_FONT_SIZE_MIN_PX,
	SIDEBAR_FONT_SIZE_MAX_PX,
	SIDEBAR_FONT_SIZE_STEP_PX,
	loadSidebarFontScale,
	applySidebarFontScaleVar,
	sidebarFontSizePxToScale,
	sidebarFontScaleToDisplayPx,
	SIDEBAR_TREE_INDENT_DEFAULT_PX,
	SIDEBAR_TREE_INDENT_MIN_PX,
	SIDEBAR_TREE_INDENT_MAX_PX,
	SIDEBAR_TREE_INDENT_STEP_PX,
	loadSidebarTreeIndentPx,
	saveSidebarTreeIndentPx,
	resetSidebarTreeIndentPreference,
	applySidebarTreeLayoutVars,
} from "./state.js";
import { HEADQUARTERS_HELPER_TEXT, HEADQUARTERS_PROJECT_ID, HEADQUARTERS_PROJECT_NAME, isHeadquartersProject, projectIconComponent, projectIconKind, projectIconTestId } from "./headquarters.js";
import { getRouteFromHash, setHashRoute, toggleConfigPage, type SettingsTabId } from "./routing.js";
import { renderWorkflowPage, loadWorkflowPageData } from "./workflow-page.js";
import { setConfigScope, getConfigScope, getConfigApiProjectId } from "./config-scope.js";
import { gatewayFetch, fetchSandboxStatus, fetchHarnessStatus, requestHarnessRestart, removeProject, fetchProjects, searchStats, searchRebuild, orphanedIndexRows, cleanupOrphanedIndexRows, type SearchStats, type OrphanedIndexRows } from "./api.js";
import {
	PLAY_FINISH_SOUND_CHANGED,
	PROJECT_PLAY_FINISH_SOUND_KEY,
	captureProjectPlayFinishSoundRead,
	getProjectPlayFinishSoundOverride,
	isPlayFinishSoundEnabled,
	isProjectPlayFinishSoundOverrideLoaded,
	primeProjectPlayFinishSoundOverride,
	setPlayFinishSoundEnabled,
	setProjectPlayFinishSoundOverride,
	type ProjectPlayFinishSoundOverride,
} from "./play-finish-sound.js";
import { applyProjectPalette } from "./session-manager.js";
import { setPerfInstrumentationEnabled, isPerfInstrumentationEnabled } from "./boot-timing.js";
import { isClientDebugEnabled, setClientDebugEnabled } from "./client-debug.js";
import { dispatchIndexEvent } from "./components/search-status-dot.js";
import "./components/search-status-dot.js";
import { openOAuthDialog, confirmAction } from "./dialogs.js";
import { ACCOUNT_OAUTH_PROVIDERS, clearDismissedAccountOAuthExpiryRemindersForProvider, type AccountOAuthProviderId } from "./account-oauth-providers.js";
import "../ui/components/ProviderKeyInput.js";
import { componentToEditState, buildSavePayload, type ComponentEditState } from "./components-editor.js";
import { ModelSelector } from "../ui/dialogs/ModelSelector.js";
import { getSupportedThinkingLevels, clampThinkingLevel, type ThinkingLevel } from "../shared/thinking-levels.js";
import { ImageModelSelector, type ImageGenerationModel } from "../ui/dialogs/ImageModelSelector.js";
import { AigwModelsDialog } from "../ui/dialogs/AigwModelsDialog.js";

type SettingsTab = SettingsTabId;
const DEFAULT_TAB: SettingsTab = "shortcuts";

const SYSTEM_TABS: { id: SettingsTab; label: string }[] = [
	{ id: "shortcuts", label: "Shortcuts" },
	{ id: "general", label: "General" },
	{ id: "models", label: "Models" },
	{ id: "directories", label: "Config Directories" },
	{ id: "palette", label: "Color Palette" },
	{ id: "account", label: "Account" },
	{ id: "maintenance", label: "Maintenance" },
];

const PROJECT_TABS: { id: SettingsTab; label: string }[] = [
	{ id: "general", label: "General" },
	{ id: "project", label: "Commands" },
	{ id: "components", label: "Components" },
	{ id: "workflows", label: "Workflows" },
	{ id: "directories", label: "Config Directories" },
	{ id: "appearance", label: "Appearance" },
];

function getActiveScope(): string {
	const route = getRouteFromHash() as any;
	const scope = route.settingsScope ?? "system";
	// Headquarters is the user-facing server scope. Only Workflows currently use
	// the explicit project id because workflow storage remains project-scoped.
	if (isHeadquartersProject(scope) && route.settingsTab !== "workflows") return "system";
	return scope;
}

function getTabsForScope(scope: string): { id: SettingsTab; label: string }[] {
	if (isHeadquartersProject(scope)) return PROJECT_TABS;
	return scope === "system" ? SYSTEM_TABS : PROJECT_TABS;
}

/** Allow external code to deep-link to a specific settings tab. */
export function setActiveSettingsTab(tab: SettingsTab): void {
	const scope = getActiveScope();
	setHashRoute("settings", `${scope}/${tab}`);
}

function getActiveTab(): SettingsTab {
	const raw = getRouteFromHash().settingsTab ?? DEFAULT_TAB;
	const scope = getActiveScope();
	const tabs = getTabsForScope(scope);
	// If current tab is not valid for this scope, default to first
	if (!tabs.some(t => t.id === raw)) return tabs[0].id;
	return raw;
}

// Rebind state (same as shortcuts-dialog)
let rebindingId: string | null = null;
let rebindingIndex: number | null = null;
let pendingBinding: KeyBinding | null = null;
let conflictEntry: ShortcutEntry | null = null;
let browserReservedWarning = false;
let _listening = false;



let settingsShowTimestamps = true;
let settingsShowTimestampsLoaded = false;
let settingsPlayFinishSound = true;
let settingsReplaceBobbitWithText = false;
let settingsShowHeadquartersInProjectLists = true;
let settingsHeadquartersVisibilityStatus: "" | "saving" | "saved" | "error" = "";
let settingsSubgoalsEnabled = true;
let settingsMaxNestingDepth: number | null = null;
const MAX_NESTING_DEPTH_DEFAULT = 3;
const MAX_NESTING_DEPTH_MIN = 1;
const MAX_NESTING_DEPTH_MAX = 10;
let harnessStatusLoaded = false;
let harnessRestartAvailable = false;
let harnessRestartState: "idle" | "requesting" | "requested" | "error" = "idle";
let harnessRestartError = "";
// Dev perf-instrumentation toggle (harness-only, next to Restart Server).
// Mirrors the `devPerfInstrumentation` server preference; the localStorage
// mirror (see boot-timing.ts) is what actually arms the next reload.
let settingsPerfInstrumentation = false;
// Skills-catalog byte budget override. `null` means "use server default" (no preference set).
let settingsSkillsCatalogBudget: number | null = null;

// Bounds mirror server-side `resolveSkillsCatalogBudget` in src/server/agent/system-prompt.ts.
const SKILLS_CATALOG_BUDGET_DEFAULT_BYTES = 16384;
const SKILLS_CATALOG_BUDGET_MIN_BYTES = 1024;
const SKILLS_CATALOG_BUDGET_MAX_BYTES = 131072;
// Extra trusted GitHub hosts for PR walkthroughs. Persisted under the `githubTrustedHosts`
// preferences key; github.com and its API/raw hosts are always trusted by the server baseline.
let settingsGithubTrustedHosts: string[] = [];
let settingsGithubTrustedHostInput = "";
let customisePromptStatus = "";

// Always-trusted baseline hosts (mirror of DEFAULT_TRUSTED_HOSTS in
// src/shared/pr-walkthrough/url-safety.ts). Kept as a local copy — NOT imported —
// to preserve UI chunk independence (pr-walkthrough has a circular-chunk hazard).
const GITHUB_DEFAULT_TRUSTED_HOSTS = new Set([
	"github.com",
	"www.github.com",
	"api.github.com",
	"raw.githubusercontent.com",
	"gist.githubusercontent.com",
]);

/**
 * Client-side mirror of the server's `normalizeTrustedHost` (src/shared/pr-walkthrough/url-safety.ts).
 * Accepts a bare host or a pasted URL; returns a normalized host or undefined when invalid. The
 * rules MUST match the shared normalizer exactly so the UI never optimistically shows entries the
 * server would silently drop. Baseline DEFAULT hosts are filtered out (the managed list holds only
 * EXTRA hosts; baseline hosts are always trusted server-side regardless of this list).
 */
function normalizeTrustedHost(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	let candidate = value.trim();
	if (!candidate) return undefined;
	if (candidate.includes("://")) {
		try {
			candidate = new URL(candidate).hostname;
		} catch {
			return undefined;
		}
	}
	candidate = candidate.trim().toLowerCase().replace(/\.$/, "");
	if (!candidate) return undefined;
	// Reject anything that is not a bare hostname (paths, whitespace, creds, ports).
	if (/[\s/@:]/.test(candidate) || candidate.includes("://")) return undefined;
	if (!/^[a-z0-9.-]+$/.test(candidate)) return undefined;
	// Require EVERY label to be a valid DNS label: non-empty, <=63 chars, and no
	// leading/trailing hyphen. Rejects ".example.com", "example..com", "-x.com", "bad-.example", etc.
	if (!candidate.split(".").every((label) => label.length > 0 && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-"))) return undefined;
	// Managed list holds only EXTRA hosts; baseline hosts are always trusted server-side.
	if (GITHUB_DEFAULT_TRUSTED_HOSTS.has(candidate)) return undefined;
	return candidate;
}

// ── Per-project scope config state ──
const projectScopeConfigCache = new Map<string, {
	// `value` is widened to `any` because migrated fields (config_directories, qa_env,
	// sandbox_tokens, qa_max_duration_minutes, qa_max_scenarios) come back as native
	// JSON types (array/object/number); other keys remain strings.
	resolved: Record<string, { value: any; source: string }>;
	raw: Record<string, any>;
	loaded: boolean;
}>();

let projectScopeSaveStatus: "" | "saving" | "saved" | "error" = "";
const _projectScopePending = new Map<string, Record<string, any>>();

type ProjectSoundSaveStatus = "" | "saving" | "saved" | "error";
interface ProjectSoundSaveState {
	status: ProjectSoundSaveStatus;
	failedDesired?: ProjectPlayFinishSoundOverride;
	requestId: number;
	clearTimer?: ReturnType<typeof setTimeout>;
}

/** Sound autosave state is project-owned so navigation never shows another project's request. */
const _projectSoundSaveStates = new Map<string, ProjectSoundSaveState>();
const _projectSoundConfigReadStates = new Map<string, "loading" | "settled" | "error">();
let _projectSoundGlobalListenerInstalled = false;

function ensureProjectSoundGlobalListener(): void {
	if (_projectSoundGlobalListenerInstalled || typeof window === "undefined") return;
	_projectSoundGlobalListenerInstalled = true;
	window.addEventListener(PLAY_FINISH_SOUND_CHANGED, () => {
		const scope = getActiveScope();
		if (scope !== "system" && getActiveTab() === "general") renderApp();
	});
}

function getProjectSoundSaveState(projectId: string): ProjectSoundSaveState {
	let save = _projectSoundSaveStates.get(projectId);
	if (!save) {
		save = { status: "", requestId: 0 };
		_projectSoundSaveStates.set(projectId, save);
	}
	return save;
}

function projectSoundOverrideLabel(value: ProjectPlayFinishSoundOverride): string {
	if (value === "on") return "On";
	if (value === "off") return "Off";
	return "Inherit global";
}

async function saveProjectPlayFinishSound(
	projectId: string,
	desired: ProjectPlayFinishSoundOverride,
): Promise<void> {
	const save = getProjectSoundSaveState(projectId);
	if (save.clearTimer) clearTimeout(save.clearTimer);
	const requestId = ++save.requestId;
	save.status = "saving";
	save.failedDesired = desired;

	// The shared setter enqueues synchronously, so rendering after invocation shows
	// the immediately-effective optimistic value while its independent PUT runs.
	const request = setProjectPlayFinishSoundOverride(projectId, desired);
	renderApp();

	let succeeded = false;
	try {
		succeeded = await request;
	} catch {
		// The shared helper is non-throwing, but keep the Settings surface resilient.
	}

	const current = getProjectSoundSaveState(projectId);
	if (current.requestId !== requestId) return;
	if (!succeeded) {
		current.status = "error";
		renderApp();
		return;
	}

	current.status = "saved";
	current.failedDesired = undefined;
	current.clearTimer = setTimeout(() => {
		const latest = _projectSoundSaveStates.get(projectId);
		if (latest?.requestId === requestId && latest.status === "saved") {
			latest.status = "";
			latest.clearTimer = undefined;
			renderApp();
		}
	}, 2000);
	renderApp();
}

/** Per-project structured `base_ref` validation error from the most recent save.
 *  Populated by `saveProjectScopeConfig` when the server returns HTTP 400 with
 *  `{ field: "base_ref", error, details? }`. Cleared on successful save or when
 *  the field is edited. Rendered inline below the base_ref input. */
const _baseRefErrors = new Map<string, { error: string; details?: Array<{ component: string; message: string }> }>();
/** Per-project cache of `GET /api/projects/:id/base-ref/detect`.
 *  `resolved` is exactly what worktrees branch off (shown as the placeholder
 *  for a blank `base_ref`); `detected` is the live remote detection (used to
 *  fill the input on "Detect from remote", null when offline). A `null` cache
 *  entry means a fetch is in flight. Mirrors the `_baseRefErrors` Map pattern. */
const _baseRefDetect = new Map<string, { resolved: string; detected: string | null } | null>();

/** Lazily fetch the resolved/detected base ref for a project (cached). Triggers
 *  a single fetch + re-render when missing, mirroring `loadWorktreePoolStatus`. */
function loadBaseRefDetect(projectId: string): void {
	if (_baseRefDetect.has(projectId)) return; // loaded or loading
	_baseRefDetect.set(projectId, null); // mark in-flight
	gatewayFetch(`/api/projects/${projectId}/base-ref/detect`).then(async (res) => {
		if (res.ok) {
			const data = await res.json();
			_baseRefDetect.set(projectId, {
				resolved: typeof data.resolved === "string" ? data.resolved : "",
				detected: typeof data.detected === "string" ? data.detected : null,
			});
		} else {
			_baseRefDetect.set(projectId, { resolved: "", detected: null });
		}
		renderApp();
	}).catch(() => {
		_baseRefDetect.set(projectId, { resolved: "", detected: null });
		renderApp();
	});
}

/** Force a re-fetch of the detect endpoint (used by the "Detect from remote"
 *  button so a click always queries the live remote). Returns the fresh data. */
async function refetchBaseRefDetect(projectId: string): Promise<{ resolved: string; detected: string | null }> {
	try {
		const res = await gatewayFetch(`/api/projects/${projectId}/base-ref/detect`);
		if (res.ok) {
			const data = await res.json();
			const parsed = {
				resolved: typeof data.resolved === "string" ? data.resolved : "",
				detected: typeof data.detected === "string" ? data.detected : null,
			};
			_baseRefDetect.set(projectId, parsed);
			return parsed;
		}
	} catch { /* fall through */ }
	const fallback = { resolved: "", detected: null };
	_baseRefDetect.set(projectId, fallback);
	return fallback;
}
/** Per-project transient state for the "Add custom key" composer in the Project tab. */
const _projectScopeNewKey = new Map<string, { key: string; value: string }>();

/**
 * Invalidate ALL cached project-config UI state for one project so the next
 * Settings render fetches fresh values. Wipes both the `/config{,/resolved}`
 * cache that drives the Project tab and the `/structured` cache that drives
 * the Components tab. Call this from any site outside `settings-page.ts`
 * that mutates project config — e.g. the `propose_project` accept paths in
 * `session-manager.ts` — to keep the Settings page coherent without forcing
 * a hard page reload. Skips invalidation when the Components tab has unsaved
 * (dirty) edits so the user's in-flight work isn't silently overwritten.
 */
export function invalidateProjectScopeConfig(projectId: string): void {
	projectScopeConfigCache.delete(projectId);
	const comp = _componentsTabState.get(projectId);
	if (comp && !comp.dirty) _componentsTabState.delete(projectId);
}

function loadProjectScopeConfig(projectId: string): void {
	const cached = projectScopeConfigCache.get(projectId);
	if (cached?.loaded) return;
	if (cached) return; // loading in progress
	projectScopeConfigCache.set(projectId, { resolved: {}, raw: {}, loaded: false });
	_projectSoundConfigReadStates.set(projectId, "loading");
	(async () => {
		// Capture immediately before the raw request starts. A concurrent project
		// sound write advances this revision and makes the eventual GET stale.
		const soundReadRevision = captureProjectPlayFinishSoundRead(projectId);
		try {
			const [resolvedRes, rawRes] = await Promise.all([
				gatewayFetch(`/api/projects/${projectId}/config/resolved`),
				gatewayFetch(`/api/projects/${projectId}/config`),
			]);
			let raw: Record<string, any> | undefined;
			if (rawRes.ok) {
				const body = await rawRes.json();
				const parsedRaw: Record<string, any> = body && typeof body === "object" && !Array.isArray(body) ? body : {};
				raw = parsedRaw;
				primeProjectPlayFinishSoundOverride(
					projectId,
					parsedRaw[PROJECT_PLAY_FINISH_SOUND_KEY],
					soundReadRevision,
				);
				_projectSoundConfigReadStates.set(projectId, "settled");
			} else {
				_projectSoundConfigReadStates.set(projectId, "error");
			}
			if (resolvedRes.ok && raw) {
				const resolved = await resolvedRes.json();
				projectScopeConfigCache.set(projectId, { resolved, raw, loaded: true });
			}
		} catch {
			_projectSoundConfigReadStates.set(
				projectId,
				isProjectPlayFinishSoundOverrideLoaded(projectId) ? "settled" : "error",
			);
		}
		renderApp();
	})();
}

async function saveProjectScopeConfig(projectId: string, updates: Record<string, any>): Promise<void> {
	projectScopeSaveStatus = "saving";
	renderApp();
	try {
		// Handle rootPath separately via project update API
		const rootPath = updates._rootPath;
		const configUpdates: Record<string, any> = { ...updates };
		delete configUpdates._rootPath;
		const promises: Promise<Response>[] = [];

		if (Object.keys(configUpdates).length > 0) {
			promises.push(gatewayFetch(`/api/projects/${projectId}/config`, {
				method: "PUT",
				body: JSON.stringify(configUpdates),
			}));
		}

		if (rootPath !== undefined) {
			promises.push(gatewayFetch(`/api/projects/${projectId}`, {
				method: "PUT",
				body: JSON.stringify({ rootPath }),
			}));
		}

		const results = await Promise.all(promises);
		if (results.every(r => r.ok)) {
			projectScopeSaveStatus = "saved";
			// Successful save clears any prior structured `base_ref` error.
			_baseRefErrors.delete(projectId);
			// Invalidate cache to reload
			projectScopeConfigCache.delete(projectId);
			// Refresh project list if rootPath changed
			if (rootPath !== undefined) {
				try {
					const res = await gatewayFetch("/api/projects");
					if (res.ok) setProjects(await res.json());
				} catch {}
			}
			setTimeout(() => { projectScopeSaveStatus = ""; renderApp(); }, 2000);
		} else {
			projectScopeSaveStatus = "error";
			// Inspect each failed response for a structured `base_ref` error so the
			// Settings UI can render it inline next to the input. The server returns
			// `{ field: "base_ref", error, details? }` with HTTP 400.
			for (const r of results) {
				if (r.ok) continue;
				if (r.status !== 400) continue;
				try {
					const body = await r.clone().json();
					if (body && body.field === "base_ref" && typeof body.error === "string") {
						_baseRefErrors.set(projectId, {
							error: body.error,
							details: Array.isArray(body.details) ? body.details : undefined,
						});
						break;
					}
				} catch { /* not JSON, skip */ }
			}
		}
	} catch {
		projectScopeSaveStatus = "error";
	}
	renderApp();
}

async function resetProjectScopeField(projectId: string, key: string): Promise<void> {
	const NATIVE_FIELDS = new Set(["config_directories", "sandbox_tokens"]);
	await saveProjectScopeConfig(projectId, { [key]: NATIVE_FIELDS.has(key) ? null : "" });
}

// ── Sandbox section state ──
let sandboxStatusLocal: { available: boolean; error?: string; dockerVersion?: string; imageExists?: boolean; dockerfileExists?: boolean; buildCommand?: string; configured: boolean } | null = null;
let sandboxStatusLoaded = false;
let sandboxStatusProjectId = "";
let sandboxBuildInProgress = false;
let sandboxBuildError = "";
let worktreePoolStatus: { enabled: boolean; ready?: number; target?: number; filling?: boolean } | null = null;
let worktreePoolStatusLoaded = false;
let worktreePoolLastScope = "";
let hostTokens: { envVar: string; label: string; available: boolean }[] | null = null;
let hostTokensLoaded = false;

// Per-project mutable state for dynamic list editors (tokens, mounts)
const _sandboxTokenEntries = new Map<string, { key: string; value: string; enabled: boolean; isHost: boolean; redacted: boolean }[]>();
const _sandboxMountEntries = new Map<string, string[]>();

function loadSandboxStatus(projectId = getConfigApiProjectId(getActiveScope())): void {
	if (sandboxStatusLoaded && sandboxStatusProjectId === projectId) return;
	sandboxStatusLoaded = true;
	sandboxStatusProjectId = projectId;
	fetchSandboxStatus(projectId).then(s => {
		sandboxStatusLocal = s;
		state.sandboxStatus = s;
		renderApp();
	});
}

function loadHostTokens(): void {
	if (hostTokensLoaded) return;
	hostTokensLoaded = true;
	gatewayFetch("/api/sandbox/host-tokens").then(async (res) => {
		if (res.ok) {
			hostTokens = await res.json();
		} else {
			hostTokens = [];
		}
		renderApp();
	}).catch(() => {
		hostTokens = [];
		renderApp();
	});
}

function loadWorktreePoolStatus(): void {
	const scope = getActiveScope();
	if (worktreePoolStatusLoaded && worktreePoolLastScope === scope) return;
	worktreePoolStatusLoaded = true;
	worktreePoolLastScope = scope;
	const endpoint = scope !== "system"
		? `/api/worktree-pool?projectId=${encodeURIComponent(scope)}`
		: "/api/worktree-pool";
	gatewayFetch(endpoint).then(async (res) => {
		if (res.ok) {
			const data = await res.json();
			if (scope === "system" && data.pools) {
				// System scope: aggregate — pick first pool or show disabled
				const entries = Object.values(data.pools) as any[];
				if (entries.length > 0) {
					worktreePoolStatus = entries[0];
				} else {
					worktreePoolStatus = { enabled: false };
				}
			} else {
				worktreePoolStatus = data;
			}
		} else {
			worktreePoolStatus = { enabled: false };
		}
		renderApp();
	}).catch(() => {
		worktreePoolStatus = { enabled: false };
		renderApp();
	});
}

/** Initialize token/mount entries from resolved config if not already tracked. */
function initSandboxEntries(projectId: string, resolved: Record<string, { value: any; source: string }>): void {
	// Defer token entry init until host tokens have loaded (async),
	// otherwise the list would be seeded with zero host tokens.
	if (!_sandboxTokenEntries.has(projectId) && hostTokens !== null) {
		const tokensVal = resolved.sandbox_tokens?.value;
		const hostEnvVars = new Set((hostTokens || []).map(t => t.envVar));
		// New unified format — may arrive as native array (post-native-YAML) or
		// legacy JSON-encoded string. Accept both for forward+back compat.
		let arr: { key: string; value?: string; enabled: boolean }[] | null = null;
		if (Array.isArray(tokensVal)) {
			arr = tokensVal as Array<{ key: string; value?: string; enabled: boolean }>;
		} else if (typeof tokensVal === "string" && tokensVal.length > 0) {
			try {
				const parsed = JSON.parse(tokensVal);
				if (Array.isArray(parsed)) arr = parsed;
			} catch { arr = null; }
		}
		if (arr) {
			const entries = arr.map(e => ({
				key: e.key || "",
				value: e.value === "__REDACTED__" ? "" : (e.value || ""),
				enabled: !!e.enabled,
				isHost: hostEnvVars.has(e.key),
				redacted: e.value === "__REDACTED__",
			}));
			for (const ht of (hostTokens || [])) {
				if (!entries.some(e => e.key === ht.envVar)) {
					entries.push({ key: ht.envVar, value: "", enabled: false, isHost: true, redacted: false });
				}
			}
			_sandboxTokenEntries.set(projectId, entries);
		} else {
			// Legacy fallback: merge host tokens + sandbox_credentials + sandbox_host_token_overrides
			const entries: { key: string; value: string; enabled: boolean; isHost: boolean; redacted: boolean }[] = [];

			// Parse legacy overrides
			const overridesRaw = resolved.sandbox_host_token_overrides?.value || "";
			let overrides: Record<string, string> = {};
			try { overrides = overridesRaw ? JSON.parse(overridesRaw) : {}; } catch { /* ignore */ }
			const legacyGh = resolved.sandbox_github_token?.value ?? "true";

			// Add host tokens
			for (const ht of (hostTokens || [])) {
				let enabled: boolean;
				if (overrides[ht.envVar] !== undefined) {
					enabled = overrides[ht.envVar] !== "false";
				} else if (ht.envVar === "GITHUB_TOKEN") {
					enabled = legacyGh !== "false";
				} else {
					enabled = true; // default: auto-inject
				}
				entries.push({ key: ht.envVar, value: "", enabled, isHost: true, redacted: false });
			}

			// Add sandbox_credentials entries
			const credRaw = resolved.sandbox_credentials?.value || "";
			try {
				if (credRaw) {
					const obj = JSON.parse(credRaw);
					if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
						for (const [key, value] of Object.entries(obj)) {
							const existing = entries.find(e => e.key === key);
							if (existing) {
								// Override the host token entry with explicit value
								const strVal = String(value);
								existing.value = strVal === "__REDACTED__" ? "" : strVal;
								existing.enabled = true;
								existing.redacted = strVal === "__REDACTED__";
							} else {
								const strVal = String(value);
								entries.push({ key, value: strVal === "__REDACTED__" ? "" : strVal, enabled: true, isHost: false, redacted: strVal === "__REDACTED__" });
							}
						}
					}
				}
			} catch { /* ignore */ }

			_sandboxTokenEntries.set(projectId, entries);
		}
	}
	if (!_sandboxMountEntries.has(projectId)) {
		try {
			const raw = resolved.sandbox_mounts?.value || "";
			if (raw) {
				const arr = JSON.parse(raw);
				if (Array.isArray(arr)) {
					_sandboxMountEntries.set(projectId, arr);
				} else {
					_sandboxMountEntries.set(projectId, []);
				}
			} else {
				_sandboxMountEntries.set(projectId, []);
			}
		} catch { _sandboxMountEntries.set(projectId, []); }
	}
}

/** Serialize token entries to pendingChanges.sandbox_tokens as a structured array.
 *  Server-side `PUT /api/projects/:id/config` rejects JSON-encoded strings for this
 *  field after the native-YAML migration. */
function syncTokenEntries(
	tokenEntries: { key: string; value: string; enabled: boolean; isHost: boolean; redacted: boolean }[],
	pendingChanges: Record<string, any>,
): void {
	const arr = tokenEntries
		.filter(e => e.key) // skip empty key rows
		.map(e => ({ key: e.key, value: e.redacted && !e.value ? "__REDACTED__" : e.value, enabled: e.enabled }));
	pendingChanges.sandbox_tokens = arr.length > 0 ? arr : null;
}

function renderSandboxSection(
	projectId: string,
	resolved: Record<string, { value: any; source: string }>,
	pendingChanges: Record<string, any>,
	inputClass: string,
	labelClass: string,
) {
	const apiProjectId = getConfigApiProjectId(getActiveScope());
	loadSandboxStatus(apiProjectId);
	initSandboxEntries(projectId, resolved);

	const sandboxMode = pendingChanges.sandbox ?? resolved.sandbox?.value ?? "none";
	const imageName = pendingChanges.sandbox_image ?? resolved.sandbox_image?.value ?? "bobbit-agent";
	const tokenEntries = _sandboxTokenEntries.get(projectId) || [];
	const mountEntries = _sandboxMountEntries.get(projectId) || [];

	return html`
		<div class="flex flex-col gap-2">
			<div class="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">Docker Sandbox</div>
			<p class="text-xs text-muted-foreground -mt-1">
				Run agent sessions in isolated Docker containers with restricted filesystem and network access.
			</p>

			<!-- Sandbox Mode -->
			<div class="flex items-center gap-3">
				<span class="${labelClass}">Sandbox Mode</span>
				<select
					class="${inputClass} max-w-48"
					.value=${sandboxMode}
					@change=${(e: Event) => {
						pendingChanges.sandbox = (e.target as HTMLSelectElement).value;
						renderApp();
					}}
				>
					<option value="none">none</option>
					<option value="docker">docker</option>
				</select>
			</div>

			<!-- Docker Status -->
			<div class="flex items-center gap-3">
				<span class="${labelClass}">Docker Status</span>
				<div class="flex items-center gap-2 text-sm">
					${sandboxStatusLocal === null
						? html`<span class="text-muted-foreground">Checking...</span>`
						: sandboxStatusLocal.available
							? html`
								<span class="w-2 h-2 rounded-full bg-green-500"></span>
								<span class="text-foreground">Available${sandboxStatusLocal.dockerVersion ? ` (v${sandboxStatusLocal.dockerVersion})` : ""}</span>
								${sandboxStatusLocal.imageExists !== undefined
									? sandboxStatusLocal.imageExists
										? html`<span class="text-xs text-muted-foreground ml-2">Image "${imageName}": found</span>`
										: html`<span class="text-xs text-orange-500 ml-2">Image "${imageName}": not found</span>
											${sandboxStatusLocal!.buildCommand ? html`
												<div class="flex flex-col gap-1 ml-2">
													<div class="flex items-center gap-2">
														<code class="text-xs bg-secondary px-1.5 py-0.5 rounded font-mono">${sandboxStatusLocal!.buildCommand}</code>
														<button
															class="text-xs px-2 py-0.5 rounded border border-border hover:bg-secondary transition-colors disabled:opacity-50"
															?disabled=${sandboxBuildInProgress}
															@click=${async () => {
																sandboxBuildInProgress = true;
																sandboxBuildError = "";
																renderApp();
																try {
																	const resp = await gatewayFetch("/api/sandbox-image/build", { method: "POST", body: JSON.stringify({ projectId: apiProjectId }) });
																	let result: any = {};
																	try { result = await resp.json(); } catch (_e) { /* non-JSON */ }
																	if (resp.ok && result.success) {
																		sandboxBuildInProgress = false;
																		sandboxStatusLoaded = false;
																		loadSandboxStatus();
																	} else {
																		sandboxBuildInProgress = false;
																		sandboxBuildError = result.error || "Build failed";
																		renderApp();
																	}
																} catch (e: any) {
																	sandboxBuildInProgress = false;
																	sandboxBuildError = e.message || "Build failed";
																	renderApp();
																}
															}}
														>${sandboxBuildInProgress ? "Building..." : "Build Image"}</button>
													</div>
													<span class="text-xs text-muted-foreground">Server restart required after build for sandbox pool.</span>
													${sandboxBuildError ? html`<span class="text-xs text-red-500">${sandboxBuildError}</span>` : ""}
												</div>
											` : ""}`
									: ""}
							`
							: html`
								<span class="w-2 h-2 rounded-full bg-red-500"></span>
								<span class="text-muted-foreground">Not available${sandboxStatusLocal.error ? ` — ${sandboxStatusLocal.error}` : ""}</span>
							`}
					<button
						class="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors ml-1"
						title="Refresh Docker status"
						@click=${() => { sandboxStatusLoaded = false; loadSandboxStatus(); }}
					>${icon(RotateCcw, "xs")}</button>
				</div>
			</div>

			<!-- Image Name -->
			<div class="flex items-center gap-3">
				<span class="${labelClass}">Image Name</span>
				<input
					type="text"
					class="${inputClass} max-w-64"
					placeholder="bobbit-agent"
					.value=${pendingChanges.sandbox_image ?? resolved.sandbox_image?.value ?? ""}
					@input=${(e: Event) => {
						pendingChanges.sandbox_image = (e.target as HTMLInputElement).value;
					}}
				/>
			</div>

			<!-- Tokens -->
			<div class="flex flex-col gap-2">
				<div class="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">Tokens</div>
				<p class="text-xs text-muted-foreground -mt-1">
					Environment variables injected into sandbox containers. Empty values resolve from the host.
				</p>
				${(() => {
					loadHostTokens();
					if (hostTokens === null) return html`<span class="text-xs text-muted-foreground">Detecting...</span>`;
					const hostAvail = new Map((hostTokens || []).map(t => [t.envVar, t.available]));
					return tokenEntries.map((entry, i) => {
						const hasHostValue = hostAvail.get(entry.key) === true;
						return html`
						<div class="flex items-center gap-2 h-8">
							<span class="w-2 h-2 rounded-full shrink-0 ${hasHostValue ? 'bg-green-500' : 'bg-zinc-400'}" title=${hasHostValue ? 'Detected on host' : 'Not detected on host'}></span>
							<input
								type="checkbox"
								class="accent-primary shrink-0"
								.checked=${entry.enabled}
								@change=${(e: Event) => {
									tokenEntries[i].enabled = (e.target as HTMLInputElement).checked;
									syncTokenEntries(tokenEntries, pendingChanges);
									renderApp();
								}}
							/>
							<input
								type="text"
								class="w-52 shrink-0 px-2 py-1 rounded-md border border-input bg-background text-sm font-mono
									focus:outline-none focus:ring-2 focus:ring-ring"
								placeholder="ENV_VAR"
								.value=${entry.key}
								@input=${(e: Event) => {
									tokenEntries[i].key = (e.target as HTMLInputElement).value;
									syncTokenEntries(tokenEntries, pendingChanges);
									renderApp();
								}}
							/>
							${entry.redacted && !entry.value
								? html`
									<div class="flex-1 min-w-0 flex items-center gap-2 px-2">
										<span class="text-sm font-mono text-muted-foreground tracking-widest select-none">••••••••</span>
										<button
											class="text-[11px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0"
											@click=${() => {
												tokenEntries[i].redacted = false;
												tokenEntries[i].value = "";
												syncTokenEntries(tokenEntries, pendingChanges);
												renderApp();
											}}
										>Change</button>
									</div>
								`
								: html`<input
								type="text"
								class="flex-1 min-w-0 px-2 py-1 rounded-md border border-input bg-background text-sm font-mono
									focus:outline-none focus:ring-2 focus:ring-ring ${!entry.value && entry.isHost ? 'text-muted-foreground italic' : ''}"
								placeholder=${entry.isHost ? '(from host)' : 'value'}
								.value=${entry.value}
								@input=${(e: Event) => {
									tokenEntries[i].value = (e.target as HTMLInputElement).value;
									syncTokenEntries(tokenEntries, pendingChanges);
									renderApp();
								}}
							/>`}
							<button
								class="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
								title="Remove"
								@click=${() => {
									tokenEntries.splice(i, 1);
									syncTokenEntries(tokenEntries, pendingChanges);
									renderApp();
								}}
							>${icon(X, "xs")}</button>
						</div>
					`; });
				})()}
				<button
					class="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground
						hover:bg-muted rounded-md transition-colors self-start"
					@click=${() => { tokenEntries.push({ key: "", value: "", enabled: true, isHost: false, redacted: false }); renderApp(); }}
				>${icon(Plus, "xs")} Add token</button>
			</div>

			<!-- Additional Mounts -->
			<div class="flex flex-col gap-2">
				<div class="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">Additional Mounts</div>
				${mountEntries.map((mount, i) => html`
					<div class="flex items-center gap-2 h-8">
						<input
							type="text"
							class="flex-1 min-w-0 px-2 py-1 rounded-md border border-input bg-background text-sm font-mono
								focus:outline-none focus:ring-2 focus:ring-ring"
							placeholder="/host/path:/container/path:ro"
							.value=${mount}
							@input=${(e: Event) => {
								mountEntries[i] = (e.target as HTMLInputElement).value;
								const filtered = mountEntries.filter(Boolean);
								pendingChanges.sandbox_mounts = filtered.length > 0 ? JSON.stringify(filtered) : "";
								renderApp();
							}}
						/>
						<button
							class="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
							title="Remove"
							@click=${() => {
								mountEntries.splice(i, 1);
								const filtered = mountEntries.filter(Boolean);
								pendingChanges.sandbox_mounts = filtered.length > 0 ? JSON.stringify(filtered) : "";
								renderApp();
							}}
						>${icon(X, "xs")}</button>
					</div>
				`)}
				<button
					class="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground
						hover:bg-muted rounded-md transition-colors self-start"
					@click=${() => { mountEntries.push(""); renderApp(); }}
				>${icon(Plus, "xs")} Add mount</button>
			</div>

			</div>
		</div>
	`;
}

/** Worktree section: root override + pre-built pool size + base ref. Used by the General tab. */
function renderWorktreeSection(
	projectId: string,
	resolved: Record<string, any>,
	pendingChanges: Record<string, string>,
	inputClass: string,
	labelClass: string,
): import("lit").TemplateResult {
	const baseRefError = _baseRefErrors.get(projectId);
	const baseRefValue = pendingChanges.base_ref ?? resolved.base_ref?.value ?? "";
	const baseRefBlank = !String(baseRefValue).trim();
	// Only consult the detect endpoint for blank values — when a concrete value
	// is set we don't clutter the field with the resolved-fallback hint.
	if (baseRefBlank) loadBaseRefDetect(projectId);
	const detect = baseRefBlank ? _baseRefDetect.get(projectId) : undefined;
	const resolvedRef = detect?.resolved || "";
	const detectedRef = detect?.detected ?? null;
	return html`
		<div class="flex flex-col gap-2">
			<div class="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">Worktree</div>
			<p class="text-xs text-muted-foreground -mt-1">
				Each session and goal gets its own git worktree under a parent directory. Pre-built worktrees make new sessions start instantly.
			</p>

			<div class="flex items-center gap-3">
				<span class="${labelClass}">Worktree Root</span>
				<input
					type="text"
					class="${inputClass}"
					placeholder="<rootPath>-wt/ (default)"
					.value=${pendingChanges.worktree_root ?? resolved.worktree_root?.value ?? ""}
					@input=${(e: Event) => {
						pendingChanges.worktree_root = (e.target as HTMLInputElement).value;
					}}
				/>
			</div>
			<p class="text-[11px] text-muted-foreground -mt-1 ml-[calc(7rem+0.75rem)] sm:ml-[calc(11rem+0.75rem)]">Custom parent directory for goal/session worktrees. Absolute or relative to rootPath.</p>

			<div class="flex items-center gap-3">
				<span class="${labelClass}">Base Ref</span>
				<input
					data-testid="base-ref-input"
					type="text"
					class="${inputClass}"
					placeholder=${baseRefBlank && resolvedRef ? resolvedRef : "origin/master (default)"}
					.value=${baseRefValue}
					@input=${(e: Event) => {
						pendingChanges.base_ref = (e.target as HTMLInputElement).value;
						// Clear stale inline error as soon as the user edits the field.
						if (_baseRefErrors.has(projectId)) {
							_baseRefErrors.delete(projectId);
							renderApp();
						}
					}}
				/>
			</div>
			${baseRefBlank ? html`
				<div class="flex items-center gap-2 -mt-1 ml-[calc(7rem+0.75rem)] sm:ml-[calc(11rem+0.75rem)]">
					<span data-testid="base-ref-using" class="text-[11px] text-muted-foreground">
						using: <span class="font-mono">${resolvedRef || "origin/master"}</span>
					</span>
					<button
						data-testid="base-ref-detect"
						class="px-2 py-0.5 text-[11px] rounded-md border border-input text-foreground
							hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						?disabled=${detect != null && detectedRef == null}
						title=${detect != null && detectedRef == null
							? "No remote detected (offline or no origin)"
							: "Query the remote and fill the field with origin/<branch>"}
						@click=${async () => {
							const fresh = await refetchBaseRefDetect(projectId);
							if (fresh.detected) {
								pendingChanges.base_ref = fresh.detected;
								if (_baseRefErrors.has(projectId)) _baseRefErrors.delete(projectId);
							}
							renderApp();
						}}
					>Detect from remote</button>
				</div>
			` : ""}
			<p class="text-[11px] text-muted-foreground -mt-1 ml-[calc(7rem+0.75rem)] sm:ml-[calc(11rem+0.75rem)]">
				Branch ref (local or <span class="font-mono">origin/...</span>) that new worktrees are based on and the
				integration target for workflow gates. Empty = project primary. Per-component
				overrides are not supported.
			</p>
			${baseRefError ? html`
				<div data-testid="base-ref-error" class="ml-[calc(7rem+0.75rem)] sm:ml-[calc(11rem+0.75rem)] -mt-1">
					<p class="text-xs text-destructive">${baseRefError.error}</p>
					${baseRefError.details && baseRefError.details.length > 0 ? html`
						<ul class="list-disc ml-5 text-xs text-destructive mt-1">
							${baseRefError.details.map(d => html`<li><span class="font-mono">${d.component}</span>: ${d.message}</li>`)}
						</ul>
					` : ""}
				</div>
			` : ""}

			<div class="flex items-center gap-3 flex-wrap">
				<span class="${labelClass}">Pool Size</span>
				<input
					type="number"
					min="0"
					class="px-2 py-1 rounded-md border border-input bg-background text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
					style="width: 5rem;"
					placeholder="2"
					.value=${pendingChanges.worktree_pool_size ?? resolved.worktree_pool_size?.value ?? ""}
					@input=${(e: Event) => {
						pendingChanges.worktree_pool_size = (e.target as HTMLInputElement).value;
					}}
				/>
				<span class="text-xs text-muted-foreground" style="max-width: 18rem;">Pre-built worktrees (0 = disable). Changes take effect on gateway restart.</span>
			</div>

			<div class="flex items-center gap-3">
				<span class="${labelClass}">Pool Status</span>
				<div class="flex items-center gap-2 text-sm">
					${(() => {
						loadWorktreePoolStatus();
						if (worktreePoolStatus === null) return html`<span class="text-muted-foreground">Loading...</span>`;
						if (!worktreePoolStatus.enabled) return html`<span class="text-muted-foreground">Pool disabled</span>`;
						return html`
							<span class="text-xs font-mono flex items-center gap-3">
								<span>Ready: <span class="text-foreground font-medium">${worktreePoolStatus.ready}</span></span>
								<span>Target: <span class="text-foreground font-medium">${worktreePoolStatus.target}</span></span>
								${worktreePoolStatus.filling ? html`<span class="text-orange-500">Filling…</span>` : ""}
							</span>
						`;
					})()}
					<button
						class="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors ml-1"
						title="Refresh pool status"
						@click=${() => { worktreePoolStatusLoaded = false; worktreePoolStatus = null; loadWorktreePoolStatus(); }}
					>${icon(RotateCcw, "xs")}</button>
				</div>
			</div>
		</div>
	`;
}



function resetRebindState(): void {
	rebindingId = null;
	rebindingIndex = null;
	pendingBinding = null;
	conflictEntry = null;
	browserReservedWarning = false;
}

export function toggleSettings(): void {
	toggleConfigPage(["settings"], () => setHashRoute("settings"));
}

function loadHarnessStatus(): void {
	if (harnessStatusLoaded) return;
	harnessStatusLoaded = true;
	fetchHarnessStatus().then(async status => {
		harnessRestartAvailable = status.restartAvailable;
		// Load the perf-instrumentation toggle state from the server preference
		// and mirror it into localStorage so a fresh browser arms correctly on
		// the next reload. Only meaningful under the harness.
		if (status.restartAvailable) {
			try {
				const res = await gatewayFetch("/api/preferences");
				if (res.ok) {
					const prefs = await res.json();
					settingsPerfInstrumentation = prefs.devPerfInstrumentation === true;
					setPerfInstrumentationEnabled(settingsPerfInstrumentation);
				}
			} catch { /* fall back to localStorage mirror */ }
			// If the server pref was unreadable, reflect the local mirror so the
			// button still shows the truth that governs the next reload.
			if (!settingsPerfInstrumentation) settingsPerfInstrumentation = isPerfInstrumentationEnabled();
		}
		renderApp();
	});
}

async function toggleDebugMode(): Promise<void> {
	const on = !isClientDebugEnabled();
	// Single switch (dev-harness only). Turns on:
	//   • the floating DBG button → dumps a client diagnostics report into the
	//     composer (see client-debug.ts), and
	//   • boot-timing perf instrumentation, so the report's Performance section
	//     has the boot waterfall (and the on-disk sink still records).
	// Both flags are localStorage-backed and persist across reload; the perf
	// server preference is mirrored so a fresh browser re-arms correctly.
	setClientDebugEnabled(on);
	settingsPerfInstrumentation = on;
	setPerfInstrumentationEnabled(on);
	renderApp();
	try {
		await gatewayFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ devPerfInstrumentation: on }),
		});
	} catch { /* the localStorage mirror still governs the next reload */ }
}

async function requestSettingsRestart(): Promise<void> {
	if (!harnessRestartAvailable) return;
	if (harnessRestartState !== "idle" && harnessRestartState !== "error") return;
	harnessRestartState = "requesting";
	harnessRestartError = "";
	renderApp();

	const result = await requestHarnessRestart();
	if (result.ok) {
		harnessRestartState = "requested";
		harnessRestartError = "";
	} else {
		harnessRestartState = "error";
		harnessRestartError = result.error || "Restart request failed";
	}
	renderApp();
}

function renderDebugModeToggle() {
	const on = isClientDebugEnabled();
	return html`
		<button
			class="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border transition-colors ${on
				? "border-primary bg-primary/10 text-primary"
				: "border-border bg-background text-foreground hover:bg-secondary"}"
			role="switch"
			aria-checked=${on ? "true" : "false"}
			data-testid="debug-mode-toggle"
			@click=${toggleDebugMode}
			title="Debug mode: show the floating DBG button (dumps a client diagnostics report — environment, viewport/safe-area, performance, app state — into the composer) and record boot-timing perf stats. Applies on the next reload."
		>
			${icon(Bug, "xs")}
			<span>Debug ${on ? "On" : "Off"}</span>
		</button>
	`;
}

function renderHarnessRestartControl() {
	if (!harnessRestartAvailable) return "";
	const requesting = harnessRestartState === "requesting";
	const requested = harnessRestartState === "requested";
	const label = requesting ? "Requesting..." : requested ? "Restart Requested" : "Restart Server";
	return html`
		<div class="ml-auto flex items-center gap-2">
			${harnessRestartState === "error" && harnessRestartError ? html`
				<span class="text-xs text-destructive max-w-[40vw] sm:max-w-[18rem] truncate" title=${harnessRestartError}>${harnessRestartError}</span>
			` : ""}
			${renderDebugModeToggle()}
			<button
				class="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border bg-background text-foreground hover:bg-secondary transition-colors disabled:opacity-60 disabled:pointer-events-none"
				?disabled=${requesting || requested}
				@click=${requestSettingsRestart}
				title="Restart Server"
			>
				${requesting ? html`<span class="inline-flex animate-spin">${icon(Loader2, "xs")}</span>` : icon(RotateCcw, "xs")}
				<span>${label}</span>
			</button>
		</div>
	`;
}

function handleRebindKeydown(e: KeyboardEvent): void {
	e.preventDefault();
	e.stopPropagation();
	if (["Control", "Meta", "Shift", "Alt"].includes(e.key)) return;
	if (e.key === "Escape") {
		resetRebindState();
		renderApp();
		return;
	}
	const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
	const newBinding: KeyBinding = {
		key: e.key,
		ctrlOrMeta: isMac ? e.metaKey : e.ctrlKey,
		shift: e.shiftKey,
		alt: e.altKey,
	};
	if (rebindingId) {
		const entry = getShortcuts().find((s) => s.id === rebindingId);
		if (entry) {
			const isDuplicate = entry.currentBindings.some((b) => bindingsEqual(b, newBinding));
			if (isDuplicate) {
				resetRebindState();
				renderApp();
				return;
			}
		}
	}
	const conflict = findConflict(newBinding, rebindingId ?? undefined);
	if (conflict) {
		pendingBinding = newBinding;
		conflictEntry = conflict;
		browserReservedWarning = false;
		renderApp();
		return;
	}
	if (isBrowserReserved(newBinding)) {
		pendingBinding = newBinding;
		conflictEntry = null;
		browserReservedWarning = true;
		renderApp();
		return;
	}
	applyBinding(newBinding);
}

async function applyBinding(binding: KeyBinding): Promise<void> {
	if (!rebindingId) return;
	if (rebindingIndex !== null) {
		updateBinding(rebindingId, rebindingIndex, binding);
	} else {
		addBinding(rebindingId, binding);
	}
	resetRebindState();
	await saveBindings();
	renderApp();
}

async function unbindConflictAndApply(): Promise<void> {
	if (!conflictEntry || !pendingBinding || !rebindingId) return;
	const conflictBindingIndex = conflictEntry.currentBindings.findIndex((b) =>
		bindingsEqual(b, pendingBinding!),
	);
	if (conflictBindingIndex >= 0) {
		removeBinding(conflictEntry.id, conflictBindingIndex);
	}
	const binding = pendingBinding;
	pendingBinding = null;
	conflictEntry = null;
	browserReservedWarning = false;
	await applyBinding(binding);
}

async function acceptBrowserReservedAndApply(): Promise<void> {
	if (!pendingBinding) return;
	const binding = pendingBinding;
	pendingBinding = null;
	browserReservedWarning = false;
	await applyBinding(binding);
}

async function handleResetBinding(id: string): Promise<void> {
	resetBinding(id);
	await saveBindings();
	renderApp();
}

async function handleResetAll(): Promise<void> {
	resetAllBindings();
	await saveBindings();
	renderApp();
}

async function handleRemoveBinding(id: string, index: number): Promise<void> {
	removeBinding(id, index);
	await saveBindings();
	renderApp();
}

function startRebind(id: string, index: number | null): void {
	rebindingId = id;
	rebindingIndex = index;
	pendingBinding = null;
	conflictEntry = null;
	browserReservedWarning = false;
	renderApp();
}

function updateKeydownListener(): void {
	const isRebinding = rebindingId !== null && !pendingBinding && !conflictEntry && !browserReservedWarning;
	if (isRebinding && !_listening) {
		window.addEventListener("keydown", handleRebindKeydown, true);
		_listening = true;
	} else if (!isRebinding && _listening) {
		window.removeEventListener("keydown", handleRebindKeydown, true);
		_listening = false;
	}
}

function renderShortcutRow(entry: ShortcutEntry, index = 0) {
	const isActiveRebind = rebindingId === entry.id;
	const showConflict = isActiveRebind && conflictEntry !== null && pendingBinding !== null;
	const showBrowserWarning = isActiveRebind && browserReservedWarning && pendingBinding !== null;
	const isCustom =
		entry.currentBindings.length !== entry.defaultBindings.length ||
		!entry.currentBindings.every((cb, i) => bindingsEqual(cb, entry.defaultBindings[i]));

	return html`
		<div class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-secondary/30 transition-colors group ${index % 2 === 0 ? "bg-secondary/50" : ""}">
			<span class="flex-1 text-sm text-foreground">${entry.label}</span>
			<div class="flex items-center gap-1.5">
				${entry.currentBindings.map((binding, idx) => {
					const isThisRebinding = isActiveRebind && rebindingIndex === idx && !pendingBinding;
					return html`
						<span class="inline-flex items-center gap-0">
							<button
								class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-l text-xs font-mono transition-all
									${isThisRebinding
										? "bg-primary/20 text-primary border border-primary animate-pulse"
										: "bg-secondary text-secondary-foreground hover:bg-secondary/80 border border-transparent"}"
								@click=${() => startRebind(entry.id, idx)}
								title=${isThisRebinding ? "Press a key combo..." : `Click to rebind (${formatBinding(binding)})`}
							>
								${isThisRebinding ? "Press a key combo..." : formatBinding(binding)}
							</button><button
								class="inline-flex items-center px-0.5 py-0.5 rounded-r text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 border border-transparent transition-colors "
								@click=${() => handleRemoveBinding(entry.id, idx)}
								title="Remove binding"
							>${icon(X, "xs")}</button>
						</span>
					`;
				})}
				${isActiveRebind && rebindingIndex === null && !pendingBinding
					? html`<button
							class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-mono bg-primary/20 text-primary border border-primary animate-pulse"
							title="Press a key combo to add a binding"
							@click=${() => startRebind(entry.id, null)}
						>Press a key combo...</button>`
					: html`<button
							class="inline-flex items-center p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors "
							@click=${() => startRebind(entry.id, null)}
							title="Add binding"
						>${icon(Plus, "xs")}</button>`}
				${isCustom
					? html`<button
							class="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors "
							@click=${() => handleResetBinding(entry.id)}
							title="Reset to default"
						>${icon(RotateCcw, "xs")}</button>`
					: ""}
			</div>
		</div>
		${showConflict
			? html`
					<div class="mx-2 mb-1 px-3 py-2 rounded-md bg-destructive/10 border border-destructive/20 text-sm">
						<p class="text-destructive mb-2">
							<strong>${formatBinding(pendingBinding!)}</strong> is already bound to
							<strong>${conflictEntry!.label}</strong>.
						</p>
						<div class="flex gap-2">
							${Button({ size: "sm", onClick: unbindConflictAndApply, children: "Unbind & Assign" })}
							${Button({ variant: "ghost", size: "sm", onClick: () => { resetRebindState(); renderApp(); }, children: "Cancel" })}
						</div>
					</div>
				`
			: ""}
		${showBrowserWarning
			? html`
					<div class="mx-2 mb-1 px-3 py-2 rounded-md bg-yellow-500/10 border border-yellow-500/20 text-sm">
						<p class="text-yellow-600 dark:text-yellow-400 mb-2">
							<strong>${formatBinding(pendingBinding!)}</strong> may be intercepted by the browser.
						</p>
						<div class="flex gap-2">
							${Button({ size: "sm", onClick: acceptBrowserReservedAndApply, children: "Assign Anyway" })}
							${Button({ variant: "ghost", size: "sm", onClick: () => { resetRebindState(); renderApp(); }, children: "Cancel" })}
						</div>
					</div>
				`
			: ""}
	`;
}

// ── General tab (see module-level state and renderGeneralTab above) ──

function renderShortcutsTab() {
	const allShortcuts = getShortcuts();
	const categories = new Map<string, ShortcutEntry[]>();
	for (const entry of allShortcuts) {
		const list = categories.get(entry.category) || [];
		list.push(entry);
		categories.set(entry.category, list);
	}
	const categoryOrder = ["Sessions", "Navigation", "Goals", "UI"];
	const sortedCategories = [...categories.entries()].sort((a, b) => {
		const ai = categoryOrder.indexOf(a[0]);
		const bi = categoryOrder.indexOf(b[0]);
		return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
	});

	return html`
		<div class="flex flex-col md:flex-row gap-4 md:gap-6 md:items-start">
			<div class="flex-1 min-w-0 flex flex-col gap-4">
				${sortedCategories.map(
					([category, entries]) => html`
						<div>
							<div class="text-[10px] text-muted-foreground uppercase tracking-wider font-medium mb-1.5 px-1">
								${category}
							</div>
							<div class="flex flex-col gap-0.5">
								${entries.map((entry, i) => renderShortcutRow(entry, i))}
							</div>
						</div>
					`,
				)}
				<div class="pt-2 border-t border-border">
					${Button({
						variant: "ghost",
						size: "sm",
						onClick: handleResetAll,
						children: html`${icon(RotateCcw, "xs")}<span class="ml-1">Reset All Defaults</span>`,
					})}
				</div>
			</div>
			<div class="w-full md:w-48 md:shrink-0 rounded-md border border-border/60 bg-secondary/30 p-3 text-xs text-muted-foreground leading-relaxed">
				<span class="font-medium text-foreground/80">Tip:</span> When running Bobbit as a browser tab, some shortcut combinations are intercepted by the browser. Install Bobbit as a PWA app to regain complete control.
			</div>
		</div>
	`;
}

// ── Palette chooser ──

interface ColorPalette {
	id: string;
	name: string;
}

const PALETTES: ColorPalette[] = [
	{ id: "forest", name: "Forest" },
	{ id: "ocean",  name: "Ocean" },
	{ id: "dusk",   name: "Dusk" },
	{ id: "ember",  name: "Ember" },
	{ id: "rose",   name: "Rose" },
	{ id: "slate",  name: "Slate" },
	{ id: "sand",   name: "Sand" },
	{ id: "teal",   name: "Teal" },
	{ id: "copper", name: "Copper" },
	{ id: "mono",   name: "Mono" },
];

const PALETTE_PRIMARY_COLORS: Record<string, { light: string; dark: string }> = {
	forest: { light: "oklch(0.42 0.14 148)", dark: "oklch(0.72 0.12 140)" },
	ocean:  { light: "oklch(0.42 0.14 230)", dark: "oklch(0.72 0.12 230)" },
	dusk:   { light: "oklch(0.42 0.14 300)", dark: "oklch(0.72 0.12 300)" },
	ember:  { light: "oklch(0.42 0.14 65)",  dark: "oklch(0.72 0.12 65)"  },
	rose:   { light: "oklch(0.42 0.14 10)",  dark: "oklch(0.72 0.12 10)"  },
	slate:  { light: "oklch(0.38 0.04 260)", dark: "oklch(0.72 0.06 260)" },
	sand:   { light: "oklch(0.42 0.14 85)",  dark: "oklch(0.72 0.12 85)"  },
	teal:   { light: "oklch(0.42 0.14 195)", dark: "oklch(0.72 0.12 195)" },
	copper: { light: "oklch(0.42 0.14 50)",  dark: "oklch(0.72 0.12 50)"  },
	mono:   { light: "oklch(0.38 0 0)",      dark: "oklch(0.72 0 0)"      },
};

function oklchToHex(oklch: string): string {
	if (!oklch || oklch.startsWith('#')) return oklch || '#808080';
	try {
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 1;
		const ctx = canvas.getContext('2d')!;
		ctx.fillStyle = oklch;
		ctx.fillRect(0, 0, 1, 1);
		const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
		return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
	} catch {
		return '#808080';
	}
}

/** Read the active palette from the DOM (source of truth) or fall back to "forest". */
function getActivePaletteId(): string {
	return document.documentElement.dataset.palette || "forest";
}

async function selectPalette(id: string): Promise<void> {
	if (id === "forest") {
		delete document.documentElement.dataset.palette;
		localStorage.removeItem('palette');
	} else {
		document.documentElement.dataset.palette = id;
		localStorage.setItem('palette', id);
	}
	try {
		await gatewayFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ palette: id }),
		});
	} catch {}
	renderApp();
}

function renderPalettePreview(palette: ColorPalette) {
	const isDark = document.documentElement.classList.contains("dark");

	// Each preview gets data-palette + optional dark class so the real
	// CSS variable rules ([data-palette="xxx"]) apply and cascade.
	return html`
		<div
			data-palette=${palette.id}
			class=${isDark ? "dark" : ""}
			style="display:flex; width:100%; height:68px; border-radius:6px; overflow:hidden; border:1px solid var(--border); font-family:system-ui,sans-serif;"
		>
			<!-- Sidebar -->
			<div style="width:44px; background:var(--sidebar); border-right:1px solid var(--sidebar-border); display:flex; flex-direction:column; gap:4px; padding:7px 5px;">
				<div style="display:flex; align-items:center; gap:3px;">
					<div style="width:10px; height:10px; border-radius:50%; background:var(--primary); flex-shrink:0;"></div>
					<div style="height:4px; flex:1; border-radius:2px; background:var(--sidebar-accent);"></div>
				</div>
				<div style="display:flex; align-items:center; gap:3px; opacity:0.7;">
					<div style="width:10px; height:10px; border-radius:50%; background:var(--muted-foreground); flex-shrink:0;"></div>
					<div style="height:4px; flex:1; border-radius:2px; background:var(--sidebar-accent);"></div>
				</div>
				<div style="display:flex; align-items:center; gap:3px; opacity:0.4;">
					<div style="width:10px; height:10px; border-radius:50%; background:var(--muted-foreground); flex-shrink:0;"></div>
					<div style="height:4px; flex:1; border-radius:2px; background:var(--sidebar-accent);"></div>
				</div>
			</div>
			<!-- Chat area -->
			<div style="flex:1; background:var(--background); padding:6px 8px; display:flex; flex-direction:column; gap:4px; justify-content:center;">
				<!-- User message (mirrors .user-message-container) -->
				<div style="display:flex; align-items:center; gap:3px; background:linear-gradient(135deg, var(--user-msg-bg), var(--user-msg-bg2)); border-radius:4px; padding:2px 6px 2px 3px; box-shadow:0 1px 3px var(--user-msg-shadow);">
					<span style="color:var(--user-msg-accent); font-size:7px; font-weight:bold; line-height:1;">❯</span>
					<span style="font-size:7px; color:var(--foreground); line-height:1.3; white-space:nowrap; overflow:hidden;">How do I fix this?</span>
				</div>
				<!-- Assistant response (foreground text) -->
				<div style="padding-left:2px; display:flex; flex-direction:column; gap:2px;">
					<div style="height:4px; width:92%; border-radius:2px; background:var(--muted-foreground); opacity:0.25;"></div>
					<div style="height:4px; width:68%; border-radius:2px; background:var(--muted-foreground); opacity:0.15;"></div>
				</div>
				<!-- Input bar (mirrors real input area) -->
				<div style="display:flex; align-items:center; gap:3px; margin-top:auto;">
					<div style="flex:1; height:9px; border-radius:4px; border:1px solid var(--input); background:var(--background);"></div>
					<div style="width:16px; height:9px; border-radius:4px; background:var(--primary); display:flex; align-items:center; justify-content:center;">
						<span style="color:var(--primary-foreground); font-size:6px; line-height:1;">↑</span>
					</div>
				</div>
			</div>
		</div>
	`;
}

function renderPaletteTab() {
	const currentPalette = getActivePaletteId();

	return html`
		<div class="flex flex-col gap-3">
			<p class="text-sm text-muted-foreground">
				Choose a color palette for the app theme.
			</p>
			<div class="grid gap-2" style="grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));">
				${PALETTES.map((palette) => {
					const isActive = currentPalette === palette.id;
					return html`
						<button
							class="flex flex-col gap-1.5 px-3 py-2.5 rounded-lg border transition-all cursor-pointer text-left w-full
								${isActive
									? "border-primary bg-primary/5 ring-1 ring-primary/30"
									: "border-border hover:border-primary/40 hover:bg-secondary/30"}"
							title="Select ${palette.name} palette"
							@click=${() => selectPalette(palette.id)}
						>
							${renderPalettePreview(palette)}
							<div class="flex items-center gap-1.5">
								<span class="text-sm font-medium ${isActive ? 'text-foreground' : 'text-muted-foreground'}">
									${palette.name}
								</span>
								${isActive ? html`<span class="text-xs text-primary">Active</span>` : ""}
							</div>
						</button>
					`;
				})}
			</div>
		</div>
	`;
}

// ── Models tab ──

let aigwUrl = "";
let aigwStatus: "idle" | "testing" | "saving" | "removing" = "idle";
let aigwError = "";
let aigwConfigured = false;
let aigwConfiguredUrl = "";
let aigwModels: Array<{ id: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean; upstreamProvider?: string }> = [];
let aigwExclusive = true; // hide built-in providers while gateway is configured
// Preferences
let prefSessionModel = "";   // "provider/modelId" e.g. "aigw/claude-sonnet-4-6" or "anthropic/claude-sonnet-4-6"
let prefReviewModel = "";    // same format
let prefNamingModel = "";    // same format
let prefImageModel = "";     // same format, defaults to openai/gpt-image-2 when unset
let prefSessionThinking = "";   // "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|""
let prefReviewThinking = "";
let prefNamingThinking = "";
let allowSessionModelFallback = false; // Global controlled-fallback opt-in; absent preference defaults off.
let allModels: Array<{ id: string; provider: string; reasoning: boolean; upstreamProvider?: string }> = [];
let allImageModels: ImageGenerationModel[] = [];
let _modelsLoaded = false;

// Per-row Test-button state. Keyed by the pref value ("provider/id").
// Cached results live ~30s so repeated clicks don't re-hit the gateway.
type ModelTestResult = { ok: boolean; latencyMs?: number; error?: string; at: number };
let modelTestResults: Record<string, ModelTestResult> = {};
let modelTestInFlight: Record<string, boolean> = {};
const MODEL_TEST_TTL_MS = 30_000;

async function runModelTest(pref: string): Promise<void> {
	if (!pref) return;
	if (modelTestInFlight[pref]) return;
	modelTestInFlight[pref] = true;
	renderApp();
	const started = Date.now();
	try {
		const res = await gatewayFetch("/api/models/test", {
			method: "POST",
			body: JSON.stringify({ pref }),
		});
		const data = await res.json().catch(() => ({}));
		if (res.ok && data?.ok) {
			modelTestResults[pref] = {
				ok: true,
				latencyMs: data.latencyMs ?? Date.now() - started,
				at: Date.now(),
			};
		} else {
			modelTestResults[pref] = {
				ok: false,
				error: data?.error || `HTTP ${res.status}`,
				at: Date.now(),
			};
		}
	} catch (err: any) {
		modelTestResults[pref] = { ok: false, error: err?.message || "Request failed", at: Date.now() };
	}
	delete modelTestInFlight[pref];
	renderApp();
}

function modelIsAvailable(pref: string): boolean {
	if (!pref) return true;
	if (allModels.length === 0) return true; // not loaded yet — don't flag as unavailable
	return allModels.some((m) => `${m.provider}/${m.id}` === pref);
}

function imageModelIsAvailable(pref: string): boolean {
	if (!pref) return true;
	if (allImageModels.length === 0) return true;
	return allImageModels.some((m) => `${m.provider}/${m.id}` === pref);
}

function openAigwModelsDialog(): void {
	AigwModelsDialog.open(aigwModels);
}

function loadModelsState(): void {
	if (_modelsLoaded) return;
	_modelsLoaded = true;
	(async () => {
		try {
			const [statusRes, prefsRes, modelsRes, imageModelsRes] = await Promise.all([
				gatewayFetch("/api/aigw/status"),
				gatewayFetch("/api/preferences"),
				gatewayFetch("/api/models"),
				gatewayFetch("/api/image-models"),
			]);
			if (statusRes.ok) {
				const data = await statusRes.json();
				aigwConfigured = data.configured;
				if (data.configured) {
					aigwConfiguredUrl = data.url;
					aigwUrl = data.url;
					aigwModels = data.models || [];
				}
			}
			if (prefsRes.ok) {
				const prefs = await prefsRes.json();
				prefSessionModel = prefs["default.sessionModel"] || "";
				prefReviewModel = prefs["default.reviewModel"] || "";
				prefNamingModel = prefs["default.namingModel"] || "";
				prefImageModel = prefs["default.imageModel"] || "";
				prefSessionThinking = prefs["default.sessionThinkingLevel"] || "";
				prefReviewThinking = prefs["default.reviewThinkingLevel"] || "";
				prefNamingThinking = prefs["default.namingThinkingLevel"] || "";
				allowSessionModelFallback = prefs.allowSessionModelFallback === true; // default false
				aigwExclusive = prefs["aigw.exclusive"] !== false; // default true
			}
			if (modelsRes.ok) {
				const models = await modelsRes.json();
				if (Array.isArray(models)) {
					allModels = models;
				}
			}
			if (imageModelsRes.ok) {
				const imageModels = await imageModelsRes.json();
				if (Array.isArray(imageModels)) allImageModels = imageModels;
			}
		} catch {}
		renderApp();
	})();
}

async function savePref(key: string, value: string | boolean | null): Promise<void> {
	try {
		await gatewayFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ [key]: value }),
		});
	} catch {}
}

// Exposed for fixture tests to avoid triggering network writes; normal UI path unchanged.
export function __testSetPrefs(p: Partial<{ session: string; review: string; naming: string; image: string; allowFallback: boolean }>): void {
	if (p.session !== undefined) prefSessionModel = p.session;
	if (p.review !== undefined) prefReviewModel = p.review;
	if (p.naming !== undefined) prefNamingModel = p.naming;
	if (p.image !== undefined) prefImageModel = p.image;
	if (p.allowFallback !== undefined) allowSessionModelFallback = p.allowFallback;
}

async function setSessionModel(value: string): Promise<void> {
	prefSessionModel = value;
	await savePref("default.sessionModel", value || null);
	renderApp();
}

async function setReviewModel(value: string): Promise<void> {
	prefReviewModel = value;
	await savePref("default.reviewModel", value || null);
	renderApp();
}

async function setNamingModel(value: string): Promise<void> {
	prefNamingModel = value;
	await savePref("default.namingModel", value || null);
	renderApp();
}

async function setImageModel(value: string): Promise<void> {
	prefImageModel = value;
	await savePref("default.imageModel", value || null);
	renderApp();
}

async function setSessionThinking(value: string): Promise<void> {
	prefSessionThinking = value;
	await savePref("default.sessionThinkingLevel", value || null);
	renderApp();
}
async function setReviewThinking(value: string): Promise<void> {
	prefReviewThinking = value;
	await savePref("default.reviewThinkingLevel", value || null);
	renderApp();
}
async function setNamingThinking(value: string): Promise<void> {
	prefNamingThinking = value;
	await savePref("default.namingThinkingLevel", value || null);
	renderApp();
}

async function setAllowSessionModelFallback(value: boolean): Promise<void> {
	allowSessionModelFallback = value;
	renderApp();
	await savePref("allowSessionModelFallback", value);
}

async function testAigwConnection(): Promise<void> {
	if (!aigwUrl.trim()) return;
	aigwStatus = "testing";
	aigwError = "";
	renderApp();
	try {
		const res = await gatewayFetch("/api/aigw/test", {
			method: "POST",
			body: JSON.stringify({ url: aigwUrl.trim() }),
		});
		const data = await res.json();
		if (!res.ok) {
			aigwError = data.error || `HTTP ${res.status}`;
		} else {
			aigwModels = data.models || [];
			aigwError = "";
		}
	} catch (err: any) {
		aigwError = err.message || "Connection failed";
	}
	aigwStatus = "idle";
	renderApp();
}

async function saveAigwConfig(): Promise<void> {
	if (!aigwUrl.trim()) return;
	aigwStatus = "saving";
	aigwError = "";
	renderApp();
	try {
		const res = await gatewayFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: aigwUrl.trim() }),
		});
		const data = await res.json();
		if (!res.ok) {
			aigwError = data.error || `HTTP ${res.status}`;
		} else {
			aigwConfigured = true;
			aigwConfiguredUrl = aigwUrl.trim();
			aigwModels = data.models || [];
			aigwError = "";
		}
	} catch (err: any) {
		aigwError = err.message || "Save failed";
	}
	aigwStatus = "idle";
	renderApp();
}

async function setAigwExclusive(value: boolean): Promise<void> {
	aigwExclusive = value;
	// Default is true — persist only the explicit "false" override, clear otherwise.
	try {
		await gatewayFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ "aigw.exclusive": value ? null : false }),
		});
	} catch {}
	// Refresh the selector lists used on this page (registry cache is keyed on prefs version).
	try {
		const res = await gatewayFetch("/api/models");
		if (res.ok) {
			const models = await res.json();
			if (Array.isArray(models)) allModels = models;
		}
	} catch {}
	renderApp();
}

async function refreshAigwModels(): Promise<void> {
	aigwStatus = "testing";
	aigwError = "";
	renderApp();
	try {
		const res = await gatewayFetch("/api/aigw/refresh", { method: "POST" });
		const data = await res.json();
		if (!res.ok) {
			aigwError = data.error || `HTTP ${res.status}`;
		} else {
			aigwModels = data.models || [];
			aigwError = "";
		}
	} catch (err: any) {
		aigwError = err.message || "Refresh failed";
	}
	aigwStatus = "idle";
	renderApp();
}

async function removeAigwConfig(): Promise<void> {
	aigwStatus = "removing";
	aigwError = "";
	renderApp();
	try {
		await gatewayFetch("/api/aigw/configure", { method: "DELETE" });
		aigwConfigured = false;
		aigwConfiguredUrl = "";
		aigwUrl = "";
		aigwModels = [];
		aigwError = "";
	} catch (err: any) {
		aigwError = err.message || "Remove failed";
	}
	aigwStatus = "idle";
	renderApp();
}

/** Format a "provider/modelId" pref value for display. Shows just the model ID. */
export function formatModelPref(value: string, fallbackLabel: string = "Auto (best available)"): string {
	if (!value) return fallbackLabel;
	const slash = value.indexOf("/");
	return slash > 0 ? value.slice(slash + 1) : value;
}

function openModelPicker(currentValue: string, onChange: (v: string) => void) {
	// Build a pseudo-Model from the current pref so the selector can highlight it
	let currentModel = null;
	if (currentValue) {
		const slash = currentValue.indexOf("/");
		if (slash > 0) {
			currentModel = { provider: currentValue.slice(0, slash), id: currentValue.slice(slash + 1) } as any;
		}
	}
	ModelSelector.open(currentModel, (model) => {
		onChange(`${model.provider}/${model.id}`);
	});
}

function openImageModelPicker(currentValue: string, onChange: (v: string) => void) {
	let currentModel: ImageGenerationModel | null = null;
	if (currentValue) {
		const slash = currentValue.indexOf("/");
		if (slash > 0) {
			currentModel = { provider: currentValue.slice(0, slash), id: currentValue.slice(slash + 1), name: "", api: "openai-images" };
		}
	}
	ImageModelSelector.open(currentModel, (model) => {
		onChange(`${model.provider}/${model.id}`);
	});
}

export function renderModelRow(
	label: string,
	hint: string,
	modelValue: string,
	onModelChange: (v: string) => void,
	thinkingValue: string,
	onThinkingChange: (v: string) => void,
	thinkingDefault: string = "medium",
	opts?: { fallbackLabel?: string },
) {
	const modelDisplay = formatModelPref(modelValue, opts?.fallbackLabel);

	// Determine the selected model's capabilities. When the model is
	// unknown (not in allModels yet — registry still loading, or the saved
	// pref is stale/unavailable) we fall back to the full reasoning-capable
	// set so the dropdown stays usable; the server clamps defensively.
	let selectedModel: { id: string; provider: string; reasoning: boolean; upstreamProvider?: string } | undefined;
	if (modelValue) {
		selectedModel = allModels.find(m => `${m.provider}/${m.id}` === modelValue);
	}
	const thinkingDisabled = !!selectedModel && !selectedModel.reasoning;
	const upstreamProviderLabel = selectedModel?.provider === "aigw" ? selectedModel.upstreamProvider : undefined;
	const supportedLevels: ThinkingLevel[] = selectedModel
		? getSupportedThinkingLevels(selectedModel)
		: ["off", "minimal", "low", "medium", "high"];

	// Reactive clamp: if the saved thinking value is no longer supported by
	// the currently-selected model (e.g. user switched away from Opus 4.7
	// while xhigh was selected), surface the clamped value in the dropdown
	// AND persist it on the next microtask so the displayed and stored
	// values match. `allowEmpty: true` keeps the "" (inherit) sentinel
	// intact when the caller offers a fallbackLabel option.
	let displayedThinking = thinkingValue;
	if (selectedModel && thinkingValue && thinkingValue !== "") {
		const clamped = clampThinkingLevel(thinkingValue, selectedModel, { allowEmpty: true });
		if (clamped !== undefined && clamped !== thinkingValue) {
			displayedThinking = clamped;
			// Defer the persistence callback to avoid mutating during render.
			queueMicrotask(() => onThinkingChange(clamped));
		}
	}

	const thinkingLabels: Record<ThinkingLevel, string> = {
		off: "Off",
		minimal: "Minimal",
		low: "Low",
		medium: "Medium",
		high: "High",
		xhigh: "Extra high",
		max: "Max",
	};

	// Availability + Test button state
	const available = modelIsAvailable(modelValue);
	const showUnavailable = !!modelValue && allModels.length > 0 && !available;
	const testing = !!modelTestInFlight[modelValue];
	const cached = modelValue ? modelTestResults[modelValue] : undefined;
	const testResult = cached && Date.now() - cached.at < MODEL_TEST_TTL_MS ? cached : undefined;

	return html`
		<div class="flex flex-col gap-1" data-testid="model-row" data-row-label=${label}>
			<div class="flex items-center gap-2">
				<span class="text-sm font-medium text-foreground shrink-0 w-14">${label}</span>
				<div class="flex items-center gap-1.5 rounded-lg border border-input bg-background px-1 py-1 flex-1 min-w-0">
					<!-- Model picker button -->
					<button
						class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm
							hover:bg-secondary transition-colors focus:outline-none focus:ring-2 focus:ring-ring
							flex-1 min-w-0 text-left
							${modelValue ? "text-foreground" : "text-muted-foreground"}"
						title="Choose model"
						@click=${() => openModelPicker(modelValue, onModelChange)}
					>
						<span class="text-muted-foreground shrink-0">${icon(Sparkles, "sm")}</span>
						<span class="truncate">${modelDisplay}</span>
						${upstreamProviderLabel ? html`<span class="text-[10px] font-medium px-1.5 py-0.5 rounded bg-secondary text-muted-foreground shrink-0" title="AIGW provider">${upstreamProviderLabel}</span>` : ""}
					</button>
					${showUnavailable ? html`
						<span
							class="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-destructive/15 text-destructive shrink-0"
							title="This saved preference does not match any currently available model. It may be a stale ID from a previous gateway configuration."
							data-testid="model-unavailable-badge"
						>Unavailable</span>
					` : ""}
					${modelValue ? html`
						<button
							class="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0"
							title=${showUnavailable ? "Clear unavailable model" : "Reset model to auto"}
							data-testid="model-clear-btn"
							@click=${() => {
								delete modelTestResults[modelValue];
								onModelChange("");
							}}
						>${icon(X, "xs")}</button>
					` : ""}
					<!-- Test button -->
					${modelValue ? html`
						<button
							class="p-1 rounded-md shrink-0 transition-colors focus:outline-none focus:ring-2 focus:ring-ring
								${testResult?.ok ? "text-green-600 hover:bg-green-500/10" : ""}
								${testResult && !testResult.ok ? "text-destructive hover:bg-destructive/10" : ""}
								${!testResult ? "text-muted-foreground hover:text-foreground hover:bg-secondary" : ""}"
							title=${testing
								? "Testing…"
								: testResult?.ok
									? `OK (${testResult.latencyMs ?? 0}ms)`
									: testResult?.error
										? `Failed: ${testResult.error}`
										: "Send a 'Reply with OK' test prompt to this model"}
							data-testid="model-test-btn"
							?disabled=${testing || showUnavailable}
							@click=${() => runModelTest(modelValue)}
						>
							${testing
								? html`<span class="inline-flex animate-spin">${icon(Loader2, "xs")}</span>`
								: testResult?.ok
									? icon(Check, "xs")
									: testResult && !testResult.ok
										? icon(X, "xs")
										: icon(FlaskConical, "xs")}
						</button>
					` : ""}
					<!-- Divider -->
					<div class="w-px h-5 bg-border shrink-0"></div>
					<!-- Thinking picker -->
					<div class="shrink-0 ${thinkingDisabled ? "opacity-40 pointer-events-none" : ""}"
						title=${thinkingDisabled ? "Selected model does not support thinking" : "Thinking level"}
					>
						${Select({
							value: displayedThinking || (opts?.fallbackLabel ? "" : thinkingDefault),
							options: [
								...(opts?.fallbackLabel ? [{ value: "", label: opts.fallbackLabel, icon: icon(Brain, "sm") }] : []),
								...supportedLevels.map(lvl => ({ value: lvl, label: thinkingLabels[lvl], icon: icon(Brain, "sm") })),
							] as SelectOption[],
							onChange: (value: string) => { onThinkingChange(value); },
							size: "sm",
							variant: "ghost",
							fitContent: true,
						})}
					</div>
				</div>
			</div>
			${testResult && !testing ? html`
				<p class="text-xs ${testResult.ok ? "text-green-600" : "text-destructive"}" data-testid="model-test-result">
					${testResult.ok
						? `Test OK${testResult.latencyMs != null ? ` (${testResult.latencyMs}ms)` : ""}`
						: `Test failed: ${testResult.error}`}
				</p>
			` : ""}
			${showUnavailable ? html`
				<p class="text-xs text-destructive">
					This model is not in the current available-models list. Clear it or pick another.
				</p>
			` : ""}
			<p class="text-xs text-muted-foreground">${hint}</p>
		</div>
	`;
}

function renderImageModelRow(
	label: string,
	hint: string,
	modelValue: string,
	onModelChange: (v: string) => void,
) {
	const modelDisplay = modelValue ? formatModelPref(modelValue) : "Auto (GPT Image 2)";
	const available = imageModelIsAvailable(modelValue);
	const showUnavailable = !!modelValue && allImageModels.length > 0 && !available;

	return html`
		<div class="flex flex-col gap-1" data-testid="image-model-row" data-row-label=${label}>
			<div class="flex items-center gap-2">
				<span class="text-sm font-medium text-foreground shrink-0 w-14">${label}</span>
				<div class="flex items-center gap-1.5 rounded-lg border border-input bg-background px-1 py-1 flex-1 min-w-0">
					<button
						class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm
							hover:bg-secondary transition-colors focus:outline-none focus:ring-2 focus:ring-ring
							flex-1 min-w-0 text-left
							${modelValue ? "text-foreground" : "text-muted-foreground"}"
						title="Choose image generation model"
						@click=${() => openImageModelPicker(modelValue, onModelChange)}
					>
						<span class="text-muted-foreground shrink-0">${icon(ImageIcon, "sm")}</span>
						<span class="truncate">${modelDisplay}</span>
					</button>
					${showUnavailable ? html`
						<span
							class="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-destructive/15 text-destructive shrink-0"
							title="This saved preference does not match any currently available image model."
							data-testid="image-model-unavailable-badge"
						>Unavailable</span>
					` : ""}
					${modelValue ? html`
						<button
							class="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0"
							title=${showUnavailable ? "Clear unavailable model" : "Reset image model to auto"}
							data-testid="image-model-clear-btn"
							@click=${() => onModelChange("")}
						>${icon(X, "xs")}</button>
					` : ""}
				</div>
			</div>
			${showUnavailable ? html`
				<p class="text-xs text-destructive">
					This image model is not in the current available-models list. Clear it or pick another.
				</p>
			` : ""}
			<p class="text-xs text-muted-foreground">${hint}</p>
		</div>
	`;
}

// Exported for fixture tests (tests/settings-models-tab-redesign.spec.ts).
export function __testResetModelsTab(opts: {
	aigwConfigured?: boolean;
	aigwUrl?: string;
	aigwModels?: Array<{ id: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean; upstreamProvider?: string }>;
	allModels?: Array<{ id: string; provider: string; reasoning: boolean; upstreamProvider?: string }>;
	allImageModels?: ImageGenerationModel[];
	prefSessionModel?: string;
	prefReviewModel?: string;
	prefNamingModel?: string;
	prefImageModel?: string;
	allowSessionModelFallback?: boolean;
} = {}): void {
	_modelsLoaded = true; // skip the fetcher
	aigwConfigured = opts.aigwConfigured ?? false;
	aigwConfiguredUrl = opts.aigwUrl ?? "";
	aigwUrl = opts.aigwUrl ?? "";
	aigwModels = opts.aigwModels ?? [];
	allModels = opts.allModels ?? [];
	allImageModels = opts.allImageModels ?? [];
	prefSessionModel = opts.prefSessionModel ?? "";
	prefReviewModel = opts.prefReviewModel ?? "";
	prefNamingModel = opts.prefNamingModel ?? "";
	prefImageModel = opts.prefImageModel ?? "";
	prefSessionThinking = "";
	prefReviewThinking = "";
	prefNamingThinking = "";
	allowSessionModelFallback = opts.allowSessionModelFallback ?? false;
	modelTestResults = {};
	modelTestInFlight = {};
}

export function renderModelsTab() {
	loadModelsState();

	const busy = aigwStatus !== "idle";
	const hasModels = aigwModels.length > 0;

	return html`
		<div class="flex flex-col gap-6" data-testid="models-tab">

			<!-- AI Gateway section -->
			<div class="flex flex-col gap-4" data-testid="aigw-section">
				<h3 class="text-sm font-semibold text-foreground">AI Gateway</h3>
				<p class="text-sm text-muted-foreground">
					Connect to an AI Gateway for on-prem LLM access through a single
					OpenAI-compatible endpoint. When configured, only gateway models are shown.
				</p>

				<!-- URL input -->
				<div class="flex flex-col gap-2">
					<label class="text-sm font-medium text-foreground">Gateway URL</label>
					<div class="flex gap-2">
						<input
							type="text"
							class="flex-1 px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm
								focus:outline-none focus:ring-2 focus:ring-ring"
							data-testid="aigw-url-input"
							name="bobbit-aigw-url"
							autocomplete="off"
							autocapitalize="off"
							spellcheck="false"
							placeholder="http://gateway-host/v1"
							.value=${aigwUrl}
							?disabled=${busy}
							@input=${(e: Event) => { aigwUrl = (e.target as HTMLInputElement).value; }}
						/>
						<button
							class="px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground
								hover:bg-secondary transition-colors disabled:opacity-50"
							title="Test gateway connection"
							?disabled=${busy || !aigwUrl.trim()}
							@click=${testAigwConnection}
						>${aigwStatus === "testing" ? "Testing..." : "Test"}</button>
					</div>
				</div>

				<!-- Error -->
				${aigwError ? html`
					<div class="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
						${aigwError}
					</div>
				` : ""}

				<!-- Status badge -->
				${aigwConfigured ? html`
					<div class="flex items-center gap-2 px-3 py-2 rounded-md bg-green-500/10 border border-green-500/20">
						<span class="w-2 h-2 rounded-full bg-green-500"></span>
						<span class="text-sm text-foreground">Connected to <code class="text-xs">${aigwConfiguredUrl}</code></span>
					</div>
					<label class="flex items-start gap-2 text-sm text-foreground cursor-pointer">
						<input
							type="checkbox"
							class="mt-0.5"
							.checked=${aigwExclusive}
							?disabled=${busy}
							@change=${(e: Event) => setAigwExclusive((e.target as HTMLInputElement).checked)}
						/>
						<span class="flex flex-col">
							<span>Hide built-in providers while the gateway is configured</span>
							<span class="text-xs text-muted-foreground">
								When enabled (default), the model picker only shows gateway models
								and local custom providers. Turn this off for local dev when you
								want direct API access alongside a dev gateway.
							</span>
						</span>
					</label>
				` : ""}

				<!-- Action buttons -->
				<div class="flex gap-2">
					<button
						class="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground
							hover:bg-primary/90 transition-colors disabled:opacity-50"
						title="Save gateway configuration"
						?disabled=${busy || !aigwUrl.trim()}
						@click=${saveAigwConfig}
					>${aigwStatus === "saving" ? "Saving..." : aigwConfigured ? "Update" : "Enable Gateway"}</button>
					${aigwConfigured ? html`
						<button
							class="px-4 py-2 text-sm rounded-md border border-destructive text-destructive
								hover:bg-destructive/10 transition-colors disabled:opacity-50"
							title="Disconnect gateway"
							?disabled=${busy}
							@click=${removeAigwConfig}
						>${aigwStatus === "removing" ? "Removing..." : "Disconnect"}</button>
						<button
							class="px-4 py-2 text-sm rounded-md border border-input bg-background text-foreground
								hover:bg-secondary transition-colors disabled:opacity-50"
							title="Refresh available models"
							?disabled=${busy}
							@click=${refreshAigwModels}
						>Refresh Models</button>
					` : ""}
				</div>

			</div>

			<!-- Default model preferences -->
			<div class="flex flex-col gap-4 pt-4 border-t border-border" data-testid="defaults-section">
				<h3 class="text-sm font-semibold text-foreground">Default Models</h3>
				${renderModelRow(
					"Session",
					"Model and thinking level for new sessions.",
					prefSessionModel,
					setSessionModel,
					prefSessionThinking,
					setSessionThinking,
				)}
				${renderModelRow(
					"Review",
					"Model and thinking for automated gate verification reviews.",
					prefReviewModel,
					setReviewModel,
					prefReviewThinking,
					setReviewThinking,
					"off",
				)}
				${renderModelRow(
					"Naming",
					"Lightweight model for auto-generating session titles. If unset under an AI Gateway, Bobbit picks the cheapest Claude model automatically.",
					prefNamingModel,
					setNamingModel,
					prefNamingThinking,
					setNamingThinking,
					"off",
				)}
				${renderImageModelRow(
					"Image",
					"Image generation model used by the generate_image tool and as the default for new sessions.",
					prefImageModel,
					setImageModel,
				)}
				<label class="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-3 text-sm text-foreground cursor-pointer">
					<input
						type="checkbox"
						class="mt-0.5 w-4 h-4 rounded border-input accent-primary cursor-pointer"
						data-testid="allow-session-model-fallback-toggle"
						.checked=${allowSessionModelFallback}
						@change=${(e: Event) => setAllowSessionModelFallback((e.target as HTMLInputElement).checked)}
					/>
					<span class="flex flex-col gap-1">
						<span class="font-medium">Allow controlled session-model fallback</span>
						<span class="text-xs text-muted-foreground leading-relaxed">
							Off by default. When enabled, a failed explicit session, review, or role model may try exactly one fallback: <code>default.sessionModel</code>. Image generation is separate and does not use this fallback.
						</span>
					</span>
				</label>
				${hasModels ? html`
					<div>
						<button
							class="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
							data-testid="view-aigw-models-btn"
							@click=${openAigwModelsDialog}
						>View available models… (${aigwModels.length})</button>
					</div>
				` : ""}
			</div>

			<!-- Provider API Keys (API-key fallback, distinct from Account OAuth) -->
			<div class="flex flex-col gap-4 pt-4 border-t border-border" data-testid="provider-keys-section">
				<h3 class="text-sm font-semibold text-foreground">Provider API Keys</h3>
				<p class="text-sm text-muted-foreground">
					Optional. Use a provider API key when you are not using account login
					(e.g. a Google AI Studio key for Gemini). Keys are stored locally. For
					Google or Anthropic account login, use <span class="text-foreground">Settings → Account</span> instead.
				</p>
				<div class="flex flex-col gap-4">
					${PROVIDER_KEY_PROVIDERS.map((p) => html`
						<div data-testid="provider-key-input-${p}">
							<provider-key-input .provider=${p}></provider-key-input>
						</div>
					`)}
				</div>
			</div>
		</div>
	`;
}

// Providers offered in the Models-tab "Provider API Keys" fallback section. Plain
// `google` is the Google AI Studio / Gemini Developer API-key provider (distinct
// from the `google-gemini-cli` account OAuth flow in Settings → Account).
const PROVIDER_KEY_PROVIDERS = ["google", "anthropic", "openai", "openrouter"] as const;

/** Human-readable labels for known project config keys. */
const PROJECT_KEY_LABELS: Record<string, string> = {
	build_command: "Build",
	test_command: "Test",
	typecheck_command: "Type Check",
	test_unit_command: "Test (Unit)",
	test_e2e_command: "Test (E2E)",

	worktree_setup_command: "Worktree Setup",
	skill_directories: "Skill Dirs",
};

function projectKeyLabel(key: string): string {
	return PROJECT_KEY_LABELS[key] || key;
}



function loadGeneralSettings() {
	if (!settingsShowTimestampsLoaded) {
		settingsShowTimestampsLoaded = true;
		// Keep the beep checkbox in sync when the header <bell-toggle> (or a
		// preferences_changed broadcast) flips the preference while Settings is open.
		if (typeof window !== "undefined") {
			window.addEventListener(PLAY_FINISH_SOUND_CHANGED, () => {
				const next = isPlayFinishSoundEnabled();
				if (next !== settingsPlayFinishSound) { settingsPlayFinishSound = next; renderApp(); }
			});
		}
		(async () => {
			try {
				const res = await gatewayFetch("/api/preferences");
				if (res.ok) {
					const prefs = await res.json();
					// Default ON when unset — only an explicit `false` opts out.
					settingsShowTimestamps = prefs.showTimestamps !== false;
					// Default ON when unset — only an explicit `false` opts out.
					settingsPlayFinishSound = prefs.playAgentFinishSound !== false;
					// Replace bobbit sprite with text (chat blob) — default OFF; only an explicit `true` enables.
					settingsReplaceBobbitWithText = prefs.replaceBobbitWithText === true;
					// Headquarters visibility — default ON; only an explicit `false` hides the shortcut.
					settingsShowHeadquartersInProjectLists = prefs.showHeadquartersInProjectLists !== false;
					state.showHeadquartersInProjectLists = settingsShowHeadquartersInProjectLists;
					// Subgoals (Experimental) — default OFF; only an explicit `true` enables. See docs/nested-goals.md.
					settingsSubgoalsEnabled = prefs.subgoalsEnabled === true;
					const rawDepth = prefs.maxNestingDepth;
					settingsMaxNestingDepth = (typeof rawDepth === "number" && Number.isFinite(rawDepth)) ? rawDepth : null;
					const raw = prefs.skillsCatalogBudget;
					settingsSkillsCatalogBudget = (typeof raw === "number" && Number.isFinite(raw)) ? raw : null;
					settingsGithubTrustedHosts = Array.isArray(prefs.githubTrustedHosts)
						? prefs.githubTrustedHosts.filter((h: unknown): h is string => typeof h === "string")
						: [];
					renderApp();
				}
			} catch {}
		})();
	}
}

async function toggleShowTimestamps(): Promise<void> {
	settingsShowTimestamps = !settingsShowTimestamps;
	renderApp();
	try {
		await gatewayFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ showTimestamps: settingsShowTimestamps }),
		});
	} catch {}
}

async function customiseSystemPrompt(): Promise<void> {
	customisePromptStatus = "Working…";
	renderApp();
	try {
		const resp = await gatewayFetch("/api/system-prompt/customise", { method: "POST" });
		if (!resp.ok) {
			customisePromptStatus = `Failed (${resp.status})`;
		} else {
			const data = await resp.json();
			customisePromptStatus = data.created
				? `Created ${data.path}`
				: `Already exists at ${data.path}`;
		}
	} catch (err) {
		customisePromptStatus = `Error: ${(err as Error).message}`;
	}
	renderApp();
}

async function setSkillsCatalogBudget(rawKB: number): Promise<void> {
	if (!Number.isFinite(rawKB)) return;
	let bytes = Math.floor(rawKB * 1024);
	if (bytes < SKILLS_CATALOG_BUDGET_MIN_BYTES) bytes = SKILLS_CATALOG_BUDGET_MIN_BYTES;
	if (bytes > SKILLS_CATALOG_BUDGET_MAX_BYTES) bytes = SKILLS_CATALOG_BUDGET_MAX_BYTES;
	settingsSkillsCatalogBudget = bytes;
	renderApp();
	try {
		await gatewayFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ skillsCatalogBudget: bytes }),
		});
	} catch {}
}

async function resetSkillsCatalogBudget(): Promise<void> {
	settingsSkillsCatalogBudget = null;
	renderApp();
	try {
		await gatewayFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ skillsCatalogBudget: null }),
		});
	} catch {}
}

async function persistGithubTrustedHosts(): Promise<void> {
	try {
		await gatewayFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ githubTrustedHosts: settingsGithubTrustedHosts }),
		});
		// The server normalize-and-stores (lossy); the GET readback is authoritative.
		// Re-fetch so the UI never shows an entry the server silently dropped.
		const res = await gatewayFetch("/api/preferences");
		if (res.ok) {
			const prefs = await res.json();
			settingsGithubTrustedHosts = Array.isArray(prefs.githubTrustedHosts)
				? prefs.githubTrustedHosts.filter((h: unknown): h is string => typeof h === "string")
				: [];
			renderApp();
		}
	} catch {}
}

async function addTrustedHost(): Promise<void> {
	const normalized = normalizeTrustedHost(settingsGithubTrustedHostInput);
	if (!normalized || settingsGithubTrustedHosts.includes(normalized)) {
		// Invalid or duplicate — clear the input and re-render without persisting.
		settingsGithubTrustedHostInput = "";
		renderApp();
		return;
	}
	settingsGithubTrustedHosts = [...settingsGithubTrustedHosts, normalized];
	settingsGithubTrustedHostInput = "";
	renderApp();
	await persistGithubTrustedHosts();
}

async function removeTrustedHost(host: string): Promise<void> {
	settingsGithubTrustedHosts = settingsGithubTrustedHosts.filter((h) => h !== host);
	renderApp();
	await persistGithubTrustedHosts();
}

async function togglePlayFinishSound(): Promise<void> {
	// Route through the shared helper so the dataset, persistence, and the
	// header <bell-toggle> all stay in sync (it fires PLAY_FINISH_SOUND_CHANGED).
	const next = !isPlayFinishSoundEnabled();
	settingsPlayFinishSound = next;
	renderApp();
	await setPlayFinishSoundEnabled(next);
}

async function toggleReplaceBobbitWithText(): Promise<void> {
	settingsReplaceBobbitWithText = !settingsReplaceBobbitWithText;
	// Apply synchronously to the dataset so the chat blob flips without waiting
	// on the preferences_changed broadcast — mirrors togglePlayFinishSound.
	document.documentElement.dataset.replaceBobbitWithText = settingsReplaceBobbitWithText ? "true" : "false";
	renderApp();
	try {
		await gatewayFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ replaceBobbitWithText: settingsReplaceBobbitWithText }),
		});
	} catch {}
}

async function setShowHeadquartersInProjectLists(checked: boolean): Promise<void> {
	const previous = settingsShowHeadquartersInProjectLists;
	settingsShowHeadquartersInProjectLists = checked;
	state.showHeadquartersInProjectLists = checked;
	settingsHeadquartersVisibilityStatus = "saving";
	renderApp();
	try {
		const res = await gatewayFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ showHeadquartersInProjectLists: checked }),
		});
		if (!res.ok) throw new Error(`Failed: ${res.status}`);
		setProjects(await fetchProjects());
		settingsHeadquartersVisibilityStatus = "saved";
		showHeaderToast(checked
			? "Headquarters shown in project lists."
			: "Headquarters hidden from project lists.");
		setTimeout(() => {
			if (settingsHeadquartersVisibilityStatus === "saved") {
				settingsHeadquartersVisibilityStatus = "";
				renderApp();
			}
		}, 2000);
	} catch {
		settingsShowHeadquartersInProjectLists = previous;
		state.showHeadquartersInProjectLists = previous;
		settingsHeadquartersVisibilityStatus = "error";
	}
	renderApp();
}

async function setMaxNestingDepth(raw: number): Promise<void> {
	if (!Number.isFinite(raw)) return;
	let n = Math.floor(raw);
	if (n < MAX_NESTING_DEPTH_MIN) n = MAX_NESTING_DEPTH_MIN;
	if (n > MAX_NESTING_DEPTH_MAX) n = MAX_NESTING_DEPTH_MAX;
	settingsMaxNestingDepth = n;
	document.documentElement.dataset.maxNestingDepth = String(n);
	renderApp();
	try {
		await gatewayFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ maxNestingDepth: n }),
		});
	} catch {}
}

async function resetMaxNestingDepth(): Promise<void> {
	settingsMaxNestingDepth = null;
	document.documentElement.dataset.maxNestingDepth = String(MAX_NESTING_DEPTH_DEFAULT);
	renderApp();
	try {
		await gatewayFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ maxNestingDepth: null }),
		});
	} catch {}
}

async function toggleSubgoalsEnabled(): Promise<void> {
	settingsSubgoalsEnabled = !settingsSubgoalsEnabled;
	// Apply synchronously to the dataset so the six client-side gate sites
	// (workflow picker, Plan/Children tabs, sidebar nesting, mutation card)
	// flip without waiting on the preferences_changed broadcast.
	document.documentElement.dataset.subgoalsEnabled = settingsSubgoalsEnabled ? "true" : "false";
	renderApp();
	try {
		await gatewayFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ subgoalsEnabled: settingsSubgoalsEnabled }),
		});
	} catch {}
}

function setSidebarFontSizePx(px: number): void {
	const scale = sidebarFontSizePxToScale(px);
	try { localStorage.setItem(SIDEBAR_FONT_SCALE_KEY, String(scale)); } catch { /* private mode */ }
	applySidebarFontScaleVar(scale);
	renderApp();
}

function resetSidebarFontScale(): void {
	try { localStorage.setItem(SIDEBAR_FONT_SCALE_KEY, String(SIDEBAR_FONT_SCALE_DEFAULT)); } catch { /* private mode */ }
	applySidebarFontScaleVar(SIDEBAR_FONT_SCALE_DEFAULT);
	renderApp();
}

function handleSidebarFontSizeInput(e: Event): void {
	const input = e.target as HTMLInputElement;
	const raw = input.value.trim();
	const px = Number.parseFloat(raw);
	if (!Number.isFinite(px)) return;
	if (e.type === "input" && px < SIDEBAR_FONT_SIZE_MIN_PX && raw.length < String(SIDEBAR_FONT_SIZE_MIN_PX).length) return;
	setSidebarFontSizePx(px);
}

function renderSidebarFontScaleControl() {
	const currentPx = sidebarFontScaleToDisplayPx(loadSidebarFontScale());
	const defaultPx = sidebarFontScaleToDisplayPx(SIDEBAR_FONT_SCALE_DEFAULT);
	return html`
		<div class="flex flex-col gap-1.5">
			<label for="sidebar-font-size-input" class="text-sm font-medium text-foreground">Sidebar font size</label>
			<p id="sidebar-font-size-help" class="text-xs text-muted-foreground">
				Scale all sidebar text proportionally. Affects only the sidebar — chat, header, and other surfaces are unchanged. Saved per browser.
			</p>
			<div class="flex items-center gap-3">
				<label class="flex items-center gap-2 text-sm text-foreground">
					<input
						id="sidebar-font-size-input"
						type="number"
						min=${String(SIDEBAR_FONT_SIZE_MIN_PX)}
						max=${String(SIDEBAR_FONT_SIZE_MAX_PX)}
						step=${String(SIDEBAR_FONT_SIZE_STEP_PX)}
						.value=${live(String(currentPx))}
						aria-describedby="sidebar-font-size-help"
						data-testid="sidebar-font-size-input"
						class="w-20 px-2 py-1 rounded-md border border-input bg-background text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
						@input=${handleSidebarFontSizeInput}
						@change=${handleSidebarFontSizeInput}
					/>
					<span class="text-sm text-muted-foreground">px</span>
				</label>
				<button
					class="text-xs text-muted-foreground hover:text-foreground underline"
					data-testid="sidebar-font-scale-reset"
					@click=${resetSidebarFontScale}
				>Reset to ${defaultPx} px</button>
			</div>
		</div>
	`;
}

function setSidebarTreeIndentPx(px: number): void {
	const clamped = saveSidebarTreeIndentPx(px);
	applySidebarTreeLayoutVars(clamped);
	renderApp();
}

function resetSidebarTreeIndent(): void {
	const px = resetSidebarTreeIndentPreference();
	applySidebarTreeLayoutVars(px);
	renderApp();
}

function handleSidebarTreeIndentInput(e: Event): void {
	const input = e.target as HTMLInputElement;
	const raw = input.value.trim();
	const px = Number.parseFloat(raw);
	if (!Number.isFinite(px)) return;
	if (e.type === "input" && px < SIDEBAR_TREE_INDENT_MIN_PX) return;
	setSidebarTreeIndentPx(px);
}

function renderSidebarTreeIndentControl() {
	const currentPx = loadSidebarTreeIndentPx();
	return html`
		<div class="flex flex-col gap-1.5">
			<label for="sidebar-tree-indent-input" class="text-sm font-medium text-foreground">Sidebar tree indentation</label>
			<p id="sidebar-tree-indent-help" class="text-xs text-muted-foreground">
				Sets how far each nested sidebar level steps inward. Larger values make goal trees easier to scan; smaller values leave more room for names. Affects only the sidebar. Saved per browser.
			</p>
			<div class="flex items-center gap-3">
				<label class="flex items-center gap-2 text-sm text-foreground">
					<input
						id="sidebar-tree-indent-input"
						type="number"
						min=${String(SIDEBAR_TREE_INDENT_MIN_PX)}
						max=${String(SIDEBAR_TREE_INDENT_MAX_PX)}
						step=${String(SIDEBAR_TREE_INDENT_STEP_PX)}
						.value=${live(String(currentPx))}
						aria-describedby="sidebar-tree-indent-help"
						data-testid="sidebar-tree-indent-input"
						class="w-20 px-2 py-1 rounded-md border border-input bg-background text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
						@input=${handleSidebarTreeIndentInput}
						@change=${handleSidebarTreeIndentInput}
					/>
					<span class="text-sm text-muted-foreground">px</span>
				</label>
				<button
					class="text-xs text-muted-foreground hover:text-foreground underline"
					data-testid="sidebar-tree-indent-reset"
					@click=${resetSidebarTreeIndent}
				>Reset to ${SIDEBAR_TREE_INDENT_DEFAULT_PX} px</button>
			</div>
		</div>
	`;
}

function renderHeadquartersVisibilityControl() {
	return html`
		<label class="flex items-start gap-2 text-sm text-foreground" data-testid="headquarters-visibility-setting">
			<input
				type="checkbox"
				class="mt-0.5 w-4 h-4 rounded border-input accent-primary cursor-pointer"
				.checked=${settingsShowHeadquartersInProjectLists}
				?disabled=${settingsHeadquartersVisibilityStatus === "saving"}
				@change=${(e: Event) => { void setShowHeadquartersInProjectLists((e.target as HTMLInputElement).checked); }}
			/>
			<span class="flex flex-col gap-1">
				<span class="text-sm font-medium text-foreground">Show Headquarters in project lists</span>
				<span class="text-xs text-muted-foreground">
					Displays Headquarters in the sidebar, project pickers, and project lists. Hiding it only removes the shortcut; Headquarters sessions, staff, goals, and server configuration are kept.
				</span>
				${settingsHeadquartersVisibilityStatus === "saved" ? html`<span class="text-xs text-green-600">Saved.</span>` : ""}
				${settingsHeadquartersVisibilityStatus === "error" ? html`<span class="text-xs text-destructive">Failed to save.</span>` : ""}
			</span>
		</label>
	`;
}

function renderGeneralTab() {
	loadGeneralSettings();
	return html`
		<div class="flex flex-col gap-4">
			<div class="flex flex-col gap-2">
				<h2 class="text-sm font-semibold text-foreground uppercase tracking-wider" data-testid="general-appearance-heading">Appearance</h2>
				${renderSidebarFontScaleControl()}
				${renderSidebarTreeIndentControl()}
				${renderHeadquartersVisibilityControl()}
			</div>
			<div class="flex flex-col gap-1.5">
				<label class="flex items-center gap-2 cursor-pointer">
					<input
						type="checkbox"
						class="w-4 h-4 rounded border-input accent-primary cursor-pointer"
						.checked=${settingsShowTimestamps}
						@change=${toggleShowTimestamps}
					/>
					<span class="text-sm font-medium text-foreground">Show message timestamps</span>
				</label>
				<p class="text-xs text-muted-foreground ml-6">
					Display timestamps next to user and assistant messages.
				</p>
			</div>
			<div class="flex flex-col gap-1.5">
				<label class="flex items-center gap-2 cursor-pointer">
					<input
						type="checkbox"
						class="w-4 h-4 rounded border-input accent-primary cursor-pointer"
						data-testid="general-replace-bobbit-with-text"
						.checked=${settingsReplaceBobbitWithText}
						@change=${toggleReplaceBobbitWithText}
					/>
					<span class="text-sm font-medium text-foreground">Replace bobbit sprite with text</span>
				</label>
				<p class="text-xs text-muted-foreground ml-6">
					Replace the animated chat avatar with a status-text label that reflects the agent's current state.
				</p>
			</div>
			<div class="flex flex-col gap-1.5">
				<label class="flex items-center gap-2 cursor-pointer">
					<input
						type="checkbox"
						class="w-4 h-4 rounded border-input accent-primary cursor-pointer"
						data-testid="general-play-finish-sound"
						.checked=${settingsPlayFinishSound}
						@change=${togglePlayFinishSound}
					/>
					<span class="text-sm font-medium text-foreground">Play sound when an agent finishes</span>
				</label>
				<p class="text-xs text-muted-foreground ml-6">
					Play a short notification beep when an agent finishes its turn.
				</p>
			</div>
			<div class="flex flex-col gap-1.5">
				<label class="flex items-center gap-2 cursor-pointer">
					<input
						type="checkbox"
						class="w-4 h-4 rounded border-input accent-primary cursor-pointer"
						data-testid="general-subgoals-enabled"
						.checked=${settingsSubgoalsEnabled}
						@change=${toggleSubgoalsEnabled}
					/>
					<span class="text-sm font-medium text-foreground">Subgoals</span>
					<span
						class="ml-1 text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
						data-testid="experimental-pill"
					>Experimental</span>
				</label>
				<p class="text-xs text-muted-foreground ml-6">
					Enable nested goals (parent / child / DAG subgoals). Surfaces the
					<code>parent</code> workflow, the nine <code>Children</code> tools,
					the Plan tab DAG, and the Children tab on the goal dashboard.
					Currently experimental — behaviour may change.
				</p>
			</div>
			<div class="flex flex-col gap-1.5 ${settingsSubgoalsEnabled ? '' : 'opacity-50'}">
				<span class="text-sm font-medium text-foreground">Max subgoal depth</span>
				<p class="text-xs text-muted-foreground">
					Maximum nesting depth for subgoal trees. Depth 3 = root → child → grandchild.
					Setting this higher risks runaway spawning. The Headquarters setting is the ceiling —
					per-goal overrides can only tighten, not loosen. Range: ${MAX_NESTING_DEPTH_MIN}–${MAX_NESTING_DEPTH_MAX}.
				</p>
				<div class="flex items-center gap-3">
					<input
						type="number"
						min="${MAX_NESTING_DEPTH_MIN}"
						max="${MAX_NESTING_DEPTH_MAX}"
						step="1"
						data-testid="general-max-nesting-depth"
						class="w-24 px-2 py-1 rounded border border-input bg-background text-sm"
						.value=${String(settingsMaxNestingDepth ?? MAX_NESTING_DEPTH_DEFAULT)}
						?disabled=${!settingsSubgoalsEnabled}
						@change=${(e: Event) => setMaxNestingDepth(Number((e.target as HTMLInputElement).value))}
					/>
					<span class="text-xs text-muted-foreground">${settingsMaxNestingDepth === null ? "(default)" : ""}</span>
					<button
						class="text-xs text-muted-foreground hover:text-foreground underline"
						data-testid="general-max-nesting-depth-reset"
						?disabled=${settingsMaxNestingDepth === null || !settingsSubgoalsEnabled}
						@click=${resetMaxNestingDepth}
					>Reset to default</button>
				</div>
			</div>
			<div class="flex flex-col gap-1.5">
				<span class="text-sm font-medium text-foreground">Skills catalog budget</span>
				<p class="text-xs text-muted-foreground">
					Maximum size (KB) of the "Available Skills" catalog injected into every agent system prompt.
					Larger budgets let agents see more skills before the alphabetical tail is truncated. Range: 1–128 KB.
				</p>
				<div class="flex items-center gap-3">
					<input
						type="number"
						min="1"
						max="128"
						step="1"
						data-testid="general-skills-catalog-budget"
						class="w-24 px-2 py-1 rounded border border-input bg-background text-sm"
						.value=${String(Math.round((settingsSkillsCatalogBudget ?? SKILLS_CATALOG_BUDGET_DEFAULT_BYTES) / 1024))}
						@change=${(e: Event) => setSkillsCatalogBudget(Number((e.target as HTMLInputElement).value))}
					/>
					<span class="text-xs text-muted-foreground">KB${settingsSkillsCatalogBudget === null ? " (default)" : ""}</span>
					<button
						class="text-xs text-muted-foreground hover:text-foreground underline"
						data-testid="general-skills-catalog-budget-reset"
						?disabled=${settingsSkillsCatalogBudget === null}
						@click=${resetSkillsCatalogBudget}
					>Reset to default</button>
				</div>
			</div>
			<div class="flex flex-col gap-1.5">
				<span class="text-sm font-medium text-foreground">Trusted GitHub hosts</span>
				<p class="text-xs text-muted-foreground">
					PR walkthroughs fetch repository and pull-request data (metadata and diffs) from these hosts.
					github.com and its API/raw hosts are always trusted. Only add hosts you trust.
				</p>
				<div class="flex flex-col gap-1.5" data-testid="github-trusted-hosts-list">
					${settingsGithubTrustedHosts.length === 0 ? html`
						<p class="text-xs text-muted-foreground italic">No additional hosts trusted.</p>
					` : settingsGithubTrustedHosts.map((host) => html`
						<div class="flex items-center gap-2" data-testid="github-trusted-host-row" data-host=${host}>
							<code class="text-sm text-foreground flex-1 truncate">${host}</code>
							<button
								class="text-xs text-muted-foreground hover:text-destructive underline"
								data-testid="github-trusted-host-remove"
								@click=${() => removeTrustedHost(host)}
							>Remove</button>
						</div>
					`)}
				</div>
				<div class="flex items-center gap-2">
					<input
						type="text"
						placeholder="ghe.example.com"
						data-testid="github-trusted-host-input"
						class="flex-1 px-2 py-1 rounded border border-input bg-background text-sm"
						.value=${live(settingsGithubTrustedHostInput)}
						@input=${(e: Event) => { settingsGithubTrustedHostInput = (e.target as HTMLInputElement).value; }}
						@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); void addTrustedHost(); } }}
					/>
					<button
						class="px-3 py-1.5 rounded border border-input text-sm hover:bg-secondary"
						data-testid="github-trusted-host-add"
						@click=${() => void addTrustedHost()}
					>Add</button>
				</div>
			</div>
			<div class="flex flex-col gap-1.5">
				<span class="text-sm font-medium text-foreground">Default agent prompt</span>
				<p class="text-xs text-muted-foreground">
					Copy the shipped default to <code>.bobbit/config/system-prompt.md</code> so you can edit it.
					If the file already exists it is left unchanged.
				</p>
				<div class="flex items-center gap-3">
					<button
						class="px-3 py-1.5 rounded border border-input text-sm hover:bg-secondary"
						data-testid="general-customise-system-prompt"
						@click=${customiseSystemPrompt}
					>Customise default prompt</button>
					${customisePromptStatus ? html`<span class="text-xs text-muted-foreground">${customisePromptStatus}</span>` : ""}
				</div>
			</div>
		</div>
	`;
}

// ── Config Directories tab state ──

interface ConfigDirectory {
	path: string;
	types: string[];
	scope: "built-in" | "user" | "project" | "custom";
	exists: boolean;
	isRemovable: boolean;
}

let configDirs: ConfigDirectory[] = [];
let configDirsLoaded = false;
let configDirsLoading = false;
let configDirsError = "";
let configDirsSaveStatus: "" | "saving" | "saved" | "error" = "";
let configDirsLastScope = "";

// Add-directory form state
let newDirPath = "";
let newDirTypes: { skills: boolean; mcp: boolean; tools: boolean; agents: boolean } = { skills: false, mcp: false, tools: false, agents: false };

function loadConfigDirs(): void {
	const currentScope = getActiveScope();
	if (currentScope !== configDirsLastScope) {
		configDirsLoaded = false;
		configDirsLoading = false;
		configDirsError = "";
		configDirsLastScope = currentScope;
	}
	if (configDirsLoaded || configDirsLoading || configDirsError) return;
	configDirsLoading = true;
	configDirsError = "";
	(async () => {
		try {
			const dirParams = new URLSearchParams();
			dirParams.set("projectId", getConfigApiProjectId(getActiveScope()));
			const res = await gatewayFetch(`/api/config-directories?${dirParams.toString()}`);
			if (res.ok) {
				configDirs = await res.json();
				configDirsLoaded = true;
			} else {
				configDirsError = "Failed to load directory configuration";
			}
		} catch {
			configDirsError = "Failed to load directory configuration";
		}
		configDirsLoading = false;
		renderApp();
	})();
}

function retryLoadConfigDirs(): void {
	configDirsLoaded = false;
	configDirsLoading = false;
	configDirsError = "";
	loadConfigDirs();
}

async function removeCustomDir(path: string): Promise<void> {
	const remaining = configDirs
		.filter((d) => d.isRemovable && d.path !== path)
		.map((d) => ({ path: d.path, types: d.types }));
	await saveConfigDirs(remaining);
}

async function addCustomDir(): Promise<void> {
	const trimmed = newDirPath.trim();
	if (!trimmed) return;
	const selectedTypes: string[] = [];
	if (newDirTypes.skills) selectedTypes.push("skills");
	if (newDirTypes.mcp) selectedTypes.push("mcp");
	if (newDirTypes.tools) selectedTypes.push("tools");
	if (newDirTypes.agents) selectedTypes.push("agents");
	if (selectedTypes.length === 0) return;

	const currentCustom = configDirs
		.filter((d) => d.isRemovable)
		.map((d) => ({ path: d.path, types: d.types }));
	currentCustom.push({ path: trimmed, types: selectedTypes });
	await saveConfigDirs(currentCustom);
	if (configDirsSaveStatus !== "error") {
		newDirPath = "";
		newDirTypes = { skills: false, mcp: false, tools: false, agents: false };
	}
}

async function saveConfigDirs(customDirs: Array<{ path: string; types: string[] }>): Promise<void> {
	configDirsSaveStatus = "saving";
	renderApp();
	try {
		const scope = getActiveScope();
		const endpoint = scope && scope !== "system"
			? `/api/projects/${scope}/config`
			: "/api/project-config";
		const res = await gatewayFetch(endpoint, {
			method: "PUT",
			// Send structured array (post-native-YAML); server rejects JSON-encoded strings for migrated fields.
			body: JSON.stringify({ config_directories: customDirs, skill_directories: null }),
		});
		if (res.ok) {
			configDirsSaveStatus = "saved";
			renderApp();
			// Reload directories from server after a short delay so "Saved" message is visible
			setTimeout(() => {
				configDirsLoaded = false;
				configDirsLoading = false;
				configDirsError = "";
				loadConfigDirs();
				configDirsSaveStatus = "";
				renderApp();
			}, 1500);
		} else {
			configDirsSaveStatus = "error";
			setTimeout(() => { configDirsSaveStatus = ""; renderApp(); }, 3000);
		}
	} catch {
		configDirsSaveStatus = "error";
		setTimeout(() => { configDirsSaveStatus = ""; renderApp(); }, 3000);
	}
	renderApp();
}

function scopeBadge(scope: string) {
	const colors: Record<string, string> = {
		"built-in": "bg-green-500/15 text-green-700 dark:text-green-400",
		"user": "bg-purple-500/15 text-purple-700 dark:text-purple-400",
		"project": "bg-blue-500/15 text-blue-700 dark:text-blue-400",
		"custom": "bg-teal-500/15 text-teal-700 dark:text-teal-400",
	};
	const cls = colors[scope] || "bg-muted text-muted-foreground";
	return html`<span class="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded-full ${cls}">${scope}</span>`;
}

function existsDot(exists: boolean) {
	return html`<span class="inline-block w-2 h-2 rounded-full ${exists ? "bg-green-500" : "bg-red-500"}" title="${exists ? "Directory exists" : "Directory not found"}"></span>`;
}

function renderDirRow(dir: ConfigDirectory) {
	return html`
		<div class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-secondary/30 transition-colors">
			${existsDot(dir.exists)}
			<code class="flex-1 text-xs break-all min-w-0">${dir.path}</code>
			${scopeBadge(dir.scope)}
			${dir.types.map((t) => html`<span class="text-[10px] px-1 py-0.5 rounded bg-secondary text-secondary-foreground">${t}</span>`)}
			${dir.isRemovable ? html`
				<button
					class="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0"
					title="Remove directory"
					?disabled=${configDirsSaveStatus === "saving"}
					@click=${() => removeCustomDir(dir.path)}
				>${icon(X, "xs")}</button>
			` : html`<div class="w-6 shrink-0"></div>`}
		</div>
	`;
}

function renderDirectoriesTab() {
	loadConfigDirs();

	if (configDirsLoading && !configDirsLoaded) {
		return html`<div class="text-sm text-muted-foreground">Loading directory configuration…</div>`;
	}

	if (configDirsError) {
		return html`
			<div class="flex flex-col items-center justify-center py-12 gap-3">
				<p class="text-sm text-destructive">${configDirsError}</p>
				<button
					class="text-xs text-muted-foreground hover:text-foreground underline"
					@click=${retryLoadConfigDirs}
				>Retry</button>
			</div>
		`;
	}

	const skillsDirs = configDirs.filter((d) => d.types.includes("skills"));
	const mcpDirs = configDirs.filter((d) => d.types.includes("mcp"));
	const toolsDirs = configDirs.filter((d) => d.types.includes("tools"));
	const agentsDirs = configDirs.filter((d) => d.types.includes("agents"));

	const hasAtLeastOneType = newDirTypes.skills || newDirTypes.mcp || newDirTypes.tools || newDirTypes.agents;

	const onlyAgents = newDirTypes.agents && !newDirTypes.skills && !newDirTypes.mcp && !newDirTypes.tools;
	const mixedWithAgents = newDirTypes.agents && (newDirTypes.skills || newDirTypes.mcp || newDirTypes.tools);
	const placeholder = onlyAgents ? "~/path/to/AGENTS.md" : mixedWithAgents ? "~/path/to/dir or file" : "~/my-config-dir";

	return html`
		<div class="flex flex-col gap-5">
			<p class="text-sm text-muted-foreground">
				Locations Bobbit scans for configuration. Custom entries can be added or removed.
			</p>

			<!-- Skills -->
			<div class="flex flex-col gap-1">
				<div class="text-[11px] text-muted-foreground uppercase tracking-wider font-medium px-1">Skills</div>
				<div class="text-xs text-muted-foreground px-1 -mt-0.5 mb-0.5">Directories containing SKILL.md files — slash commands available in chat.</div>
				<div class="flex flex-col gap-0.5">
					${skillsDirs.length > 0 ? skillsDirs.map(renderDirRow) : html`<div class="text-xs text-muted-foreground italic px-2">No skills directories.</div>`}
				</div>
			</div>

			<!-- MCP -->
			<div class="flex flex-col gap-1">
				<div class="text-[11px] text-muted-foreground uppercase tracking-wider font-medium px-1">MCP</div>
				<div class="text-xs text-muted-foreground px-1 -mt-0.5 mb-0.5">Config files defining MCP servers whose tools appear in Bobbit.</div>
				<div class="flex flex-col gap-0.5">
					${mcpDirs.length > 0 ? mcpDirs.map(renderDirRow) : html`<div class="text-xs text-muted-foreground italic px-2">No MCP directories.</div>`}
				</div>
			</div>

			<!-- Tools -->
			<div class="flex flex-col gap-1">
				<div class="text-[11px] text-muted-foreground uppercase tracking-wider font-medium px-1">Tools</div>
				<div class="text-xs text-muted-foreground px-1 -mt-0.5 mb-0.5">Directories containing tool YAML definitions and extension code.</div>
				<div class="flex flex-col gap-0.5">
					${toolsDirs.length > 0 ? toolsDirs.map(renderDirRow) : html`<div class="text-xs text-muted-foreground italic px-2">No tools directories.</div>`}
				</div>
			</div>

			<!-- Agents -->
			<div class="flex flex-col gap-1">
				<div class="text-[11px] text-muted-foreground uppercase tracking-wider font-medium px-1">Agents</div>
				<div class="text-xs text-muted-foreground px-1 -mt-0.5 mb-0.5">Markdown files (e.g. AGENTS.md) concatenated into the system prompt for every session. These are file paths, not directories.</div>
				<div class="flex flex-col gap-0.5">
					${agentsDirs.length > 0 ? agentsDirs.map(renderDirRow) : html`<div class="text-xs text-muted-foreground italic px-2">No agent files.</div>`}
				</div>
			</div>

			<!-- Add directory form -->
			<div class="flex flex-col gap-2 pt-3 border-t border-border">
				<div class="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">Add Custom Path</div>
				<div class="flex items-center gap-2">
					<input
						type="text"
						class="flex-1 px-3 py-1.5 rounded-md border border-input bg-background text-sm font-mono
							focus:outline-none focus:ring-2 focus:ring-ring"
						placeholder="${placeholder}"
						.value=${newDirPath}
						@input=${(e: Event) => { newDirPath = (e.target as HTMLInputElement).value; renderApp(); }}
						@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && newDirPath.trim() && hasAtLeastOneType) addCustomDir(); }}
					/>
				</div>
				<div class="flex items-center gap-4">
					<label class="flex items-center gap-1.5 text-xs cursor-pointer">
						<input type="checkbox" class="accent-primary" .checked=${newDirTypes.skills}
							@change=${(e: Event) => { newDirTypes.skills = (e.target as HTMLInputElement).checked; renderApp(); }} />
						Skills
					</label>
					<label class="flex items-center gap-1.5 text-xs cursor-pointer">
						<input type="checkbox" class="accent-primary" .checked=${newDirTypes.mcp}
							@change=${(e: Event) => { newDirTypes.mcp = (e.target as HTMLInputElement).checked; renderApp(); }} />
						MCP
					</label>
					<label class="flex items-center gap-1.5 text-xs cursor-pointer">
						<input type="checkbox" class="accent-primary" .checked=${newDirTypes.tools}
							@change=${(e: Event) => { newDirTypes.tools = (e.target as HTMLInputElement).checked; renderApp(); }} />
						Tools
					</label>
					<label class="flex items-center gap-1.5 text-xs cursor-pointer">
						<input type="checkbox" class="accent-primary" .checked=${newDirTypes.agents}
							@change=${(e: Event) => { newDirTypes.agents = (e.target as HTMLInputElement).checked; renderApp(); }} />
						Agents
					</label>
					<button
						class="ml-auto px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground
							hover:bg-primary/90 transition-colors disabled:opacity-50"
						?disabled=${!newDirPath.trim() || !hasAtLeastOneType || configDirsSaveStatus === "saving"}
						@click=${addCustomDir}
					>Add</button>
				</div>
				${configDirsSaveStatus === "saved" ? html`<span class="text-xs text-green-600">Saved successfully.</span>` : ""}
				${configDirsSaveStatus === "error" ? html`<span class="text-xs text-destructive">Failed to save.</span>` : ""}
			</div>
		</div>
	`;
}

// ── Account tab state ──

// Canonical Google account OAuth provider id is `google-gemini-cli`. Plain
// `google` is reserved for the Google AI Studio / Gemini Developer API-key
// provider rendered in Settings → Models → Provider API Keys; it is NEVER an
// Account-tab OAuth id. See docs/design/google-oauth-settings-ux.md.
type AccountProviderId = AccountOAuthProviderId;
const ACCOUNT_PROVIDERS = ACCOUNT_OAUTH_PROVIDERS;

let accountStatus: Partial<Record<AccountProviderId, { authenticated: boolean; expires?: number }>> | null = null;
let accountLoading = false;
let accountReauthing: AccountProviderId | null = null;
// Provider whose logout request is in flight (disables that row's Log out button).
let accountLoggingOut: AccountProviderId | null = null;
// Per-provider transient logout error, rendered inline in the row.
const accountLogoutError: Partial<Record<AccountProviderId, boolean>> = {};

/** Test-only: seed account status + reset transient flags so fixtures can drive
 *  the Account tab without hitting the network. Mirrors `__testResetModelsTab`. */
export function __testResetAccountTab(opts: {
	// Seed a status map directly to bypass the network. Omit to leave status
	// `null` so `renderAccountTab()` runs `loadAccountStatus()` (exercises the
	// GET /api/oauth/status fetch path used by reload persistence).
	status?: Partial<Record<AccountProviderId, { authenticated: boolean; expires?: number }>> | null;
} = {}): void {
	accountStatus = opts.status === undefined ? null : opts.status;
	accountLoading = false;
	accountReauthing = null;
	accountLoggingOut = null;
	for (const k of Object.keys(accountLogoutError)) delete accountLogoutError[k as AccountProviderId];
}

function loadAccountStatus(): void {
	if (accountLoading) return;
	accountLoading = true;
	(async () => {
		try {
			const entries = await Promise.all(ACCOUNT_PROVIDERS.map(async (provider) => {
				try {
					const res = await gatewayFetch(`/api/oauth/status?provider=${encodeURIComponent(provider.id)}`);
					return [provider.id, res.ok ? await res.json() : { authenticated: false }] as const;
				} catch {
					return [provider.id, { authenticated: false }] as const;
				}
			}));
			accountStatus = Object.fromEntries(entries) as Partial<Record<AccountProviderId, { authenticated: boolean; expires?: number }>>;
		} catch {
			accountStatus = Object.fromEntries(ACCOUNT_PROVIDERS.map(provider => [provider.id, { authenticated: false }])) as Partial<Record<AccountProviderId, { authenticated: boolean; expires?: number }>>;
		} finally {
			accountLoading = false;
			renderApp();
		}
	})();
}

async function handleReauthenticate(provider: AccountProviderId): Promise<void> {
	accountReauthing = provider;
	renderApp();
	try {
		const success = await openOAuthDialog(provider);
		if (success) {
			clearDismissedAccountOAuthExpiryRemindersForProvider(provider);
			// Refresh status after successful re-auth
			accountStatus = null;
			loadAccountStatus();
		}
	} finally {
		accountReauthing = null;
		renderApp();
	}
}

async function handleAccountLogout(provider: AccountProviderId): Promise<void> {
	const label = ACCOUNT_PROVIDERS.find((accountProvider) => accountProvider.id === provider)?.label ?? provider;
	const confirmed = await confirmAction(
		`Log out of ${label}?`,
		`Agent sessions will lose access to ${label} models until you log in again.`,
		"Log out",
		true,
	);
	if (!confirmed) return;
	delete accountLogoutError[provider];
	accountLoggingOut = provider;
	renderApp();
	try {
		// Provider-partitioned logout: the server deletes only this canonical
		// provider's credential and never echoes token material.
		const res = await gatewayFetch("/api/oauth/logout", {
			method: "POST",
			body: JSON.stringify({ provider }),
		});
		if (!res.ok) throw new Error("logout failed");
		accountStatus = null;
		loadAccountStatus();
	} catch {
		accountLogoutError[provider] = true;
	} finally {
		accountLoggingOut = null;
		renderApp();
	}
}

export function renderAccountTab() {
	if (!accountStatus && !accountLoading) loadAccountStatus();

	if (accountLoading && !accountStatus) {
		return html`<p class="text-sm text-muted-foreground">Loading...</p>`;
	}

	return html`
		<div class="flex flex-col gap-4" data-testid="account-tab">
			${ACCOUNT_PROVIDERS.map((provider) => {
				const status = accountStatus?.[provider.id];
				const authenticated = status?.authenticated ?? false;
				const expires = status?.expires;
				const expiresDate = expires ? new Date(expires) : null;
				const isExpired = expires ? Date.now() > expires : false;
				const isReauthing = accountReauthing === provider.id;
				const isLoggingOut = accountLoggingOut === provider.id;
				const isGoogle = provider.id === "google-gemini-cli";

				return html`
					<div class="flex flex-col gap-4" data-testid="account-row-${provider.id}">
						<div class="flex flex-col gap-1.5">
							<h3 class="text-sm font-semibold text-foreground">${provider.title}</h3>
							<p class="text-xs text-muted-foreground">${provider.description}</p>
						</div>

						<div class="flex flex-col gap-2 rounded-md border border-border p-3">
							<div class="flex items-center gap-2">
								<span class="text-sm font-medium text-foreground">Status:</span>
								${authenticated
									? html`<span class="text-sm text-green-600 dark:text-green-400" data-testid="account-status-${provider.id}">${provider.authenticatedLabel}</span>`
									: html`<span class="text-sm text-destructive" data-testid="account-status-${provider.id}">${isExpired ? "Expired" : "Not authenticated"}</span>`}
							</div>
							${expiresDate
								? html`<div class="flex items-center gap-2">
									<span class="text-sm font-medium text-foreground">Expires:</span>
									<span class="text-sm ${isExpired ? "text-destructive" : "text-muted-foreground"}" data-testid="account-expires-${provider.id}">${expiresDate.toLocaleString()}</span>
								</div>`
								: ""}
						</div>

						${isGoogle
							? html`<p class="text-xs text-muted-foreground" data-testid="account-${provider.id}-limit-note">
								<span class="font-medium">ℹ Note:</span> Gemini through your Google account runs over the unofficial
								Code Assist / Gemini CLI path — it depends on your account's Code Assist quota and Google's terms,
								and sessions may be rate-limited or interrupted. This is separate from a Google AI Studio API key;
								for the official key-based Gemini API, add a key under Models → Provider API Keys.
							</p>`
							: ""}

						<div class="flex items-center gap-2">
							<span data-testid="account-auth-btn-${provider.id}">${Button({
								variant: authenticated ? "outline" : "default",
								size: "sm",
								// Disable every provider's auth button while ANY provider is mid-flow
								// to prevent concurrent OAuth attempts from clobbering each other's
								// pendingFlows entries. Cleared in handleReauthenticate's finally block.
								disabled: accountReauthing !== null || accountLoggingOut !== null,
								onClick: () => handleReauthenticate(provider.id),
								children: isReauthing ? "Authenticating..." : authenticated ? "Re-authenticate" : "Log in",
							})}</span>
							${authenticated
								? html`<span data-testid="account-logout-btn-${provider.id}">${Button({
									variant: "outline",
									size: "sm",
									className: "border border-destructive text-destructive hover:bg-destructive/10",
									disabled: accountReauthing !== null || accountLoggingOut !== null,
									onClick: () => handleAccountLogout(provider.id),
									children: isLoggingOut ? "Logging out..." : "Log out",
								})}</span>`
								: ""}
						</div>
						${accountLogoutError[provider.id]
							? html`<p class="text-xs text-destructive" data-testid="account-logout-error-${provider.id}">Failed to log out — try again.</p>`
							: ""}

						${isGoogle
							? html`<p class="text-xs text-muted-foreground">
								Looking for an API key instead?
								<button
									type="button"
									data-testid="account-apikey-link-${provider.id}"
									class="text-foreground underline underline-offset-2 hover:text-foreground/80"
									@click=${() => setActiveSettingsTab("models")}
								>Go to Models → Provider API Keys.</button>
							</p>`
							: ""}
					</div>
				`;
			})}
		</div>
	`;
}

function renderScopeRow(currentScope: string, _tabs: { id: SettingsTab; label: string }[]) {
	const projects = (state.projects || []).filter((project: any) => !isHeadquartersProject(project));
	const currentTab = getActiveTab();
	const headquartersActive = currentScope === "system" || isHeadquartersProject(currentScope);
	const headquartersTarget = isHeadquartersProject(currentScope) && currentTab === "workflows"
		? `${HEADQUARTERS_PROJECT_ID}/workflows`
		: `system/${SYSTEM_TABS[0].id}`;

	return html`
		<div class="shrink-0 flex items-center gap-1 px-4 py-2 border-b border-border overflow-x-auto" style="scrollbar-width:thin;">
			<button
				data-testid="settings-headquarters-scope"
				class="px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5
					${headquartersActive
						? "bg-background text-foreground shadow-sm border border-border"
						: "text-muted-foreground hover:text-foreground hover:bg-secondary/50"}"
				@click=${() => { setHashRoute("settings", headquartersTarget, true); }}
			>
				<span data-testid="headquarters-icon" data-project-icon="headquarters" class="inline-flex items-center">${icon(projectIconComponent(HEADQUARTERS_PROJECT_ID), "xs")}</span>
				<span class="inline-flex flex-col items-start leading-tight">
					<span>${HEADQUARTERS_PROJECT_NAME}</span>
					<span class="text-[11px] text-muted-foreground">${HEADQUARTERS_HELPER_TEXT}</span>
				</span>
			</button>
			${projects.map((project: any) => {
				const isActive = currentScope === project.id;
				const isDark = document.documentElement.classList.contains("dark");
				const color = isDark ? (project.colorDark || project.color || "var(--muted-foreground)") : (project.colorLight || project.color || "var(--muted-foreground)");
				return html`
					<button
						class="px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5
							${isActive
								? "bg-background text-foreground shadow-sm border border-border"
								: "text-muted-foreground hover:text-foreground hover:bg-secondary/50"}"
						@click=${() => { setHashRoute("settings", `${project.id}/${PROJECT_TABS[0].id}`, true); }}
					>
						<span data-testid=${projectIconTestId(project)} data-project-icon=${projectIconKind(project)} class="inline-flex items-center" style="color:${color};">${icon(projectIconComponent(project), "xs")}</span>
						${project.name}
					</button>
				`;
			})}
		</div>
	`;
}

function renderProjectScopeTab(projectId: string) {
	loadProjectScopeConfig(projectId);
	const cached = projectScopeConfigCache.get(projectId);
	if (!cached?.loaded) {
		return html`<div class="text-sm text-muted-foreground">Loading project configuration…</div>`;
	}

	const resolved = cached.resolved;
	const raw = cached.raw;

	// Keys to show in the Commands & Sandbox tab.
	// Legacy top-level *_command keys (build_command, test_command, etc.) are deliberately
	// hidden after the multi-repo migration — the per-project Components tab is the
	// canonical editor for component build/test commands. Showing them here would create
	// two competing UIs. Migration auto-folds them into components[0].commands.{build,test,...}.
	const HIDDEN_KEYS = new Set([
		PROJECT_PLAY_FINISH_SOUND_KEY,
		"sandbox", "sandbox_image",
		"sandbox_tokens", "sandbox_credentials", "sandbox_github_token", "sandbox_host_token_overrides", "sandbox_mounts",
		"worktree_pool_size",
		"config_directories", "skill_directories",
		// Legacy command keys — use the Components tab instead
		"build_command", "test_command", "typecheck_command", "test_unit_command", "test_e2e_command",
		"worktree_setup_command",
		// Legacy top-level QA keys — moved to components[].config[]; edit on the Components tab
		"qa_start_command", "qa_build_command", "qa_health_check", "qa_browser_entry",
		"qa_env", "qa_max_duration_minutes", "qa_max_scenarios",
	]);

	const labelClass = "text-sm font-medium text-foreground w-28 sm:w-44 shrink-0";
	const inputClass = `w-full min-w-0 px-3 py-1.5 rounded-md border border-input bg-background text-sm
		font-mono focus:outline-none focus:ring-2 focus:ring-ring`;

	// Track pending changes in a module-level map so they survive re-renders
	if (!_projectScopePending.has(projectId)) _projectScopePending.set(projectId, {});
	const pendingChanges = _projectScopePending.get(projectId)!;

	// "Other Commands" section iterates resolved ∪ pendingChanges so that custom
	// keys added via the "Add custom key" composer below show up immediately,
	// not just after Save.
	const commandKeys = Array.from(new Set([
		...Object.keys(resolved),
		...Object.keys(pendingChanges).filter(k => !k.startsWith("_")),
	])).filter(k => !HIDDEN_KEYS.has(k)).sort();

	return html`
		<div class="flex flex-col gap-4">
			${commandKeys.length > 0 ? html`<div class="flex flex-col gap-2">
				<div class="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">Other Commands</div>
				<div class="text-xs text-muted-foreground">Build, test, and lint commands now live on each component — see the <strong>Components</strong> tab.</div>
				${commandKeys.map((key) => {
					const entry = resolved[key];
					const isInherited = entry ? entry.source !== "project" : false;
					// Pending value wins over saved raw value (so the user sees what
					// they're about to commit). For a pending-only custom key, raw is
					// empty and pendingChanges[key] is the value they typed.
					const displayValue = pendingChanges[key] ?? raw[key] ?? "";
					return html`
						<div class="flex items-center gap-3">
							<span class="${labelClass}">${projectKeyLabel(key)}</span>
							<div class="flex-1 min-w-0 relative">
								<input
									type="text"
									class="${inputClass} ${isInherited ? "text-muted-foreground" : "text-foreground"}"
									placeholder=${isInherited ? entry.value : ""}
									.value=${displayValue}
									@input=${(e: Event) => {
										pendingChanges[key] = (e.target as HTMLInputElement).value;
									}}
								/>
								${isInherited ? html`<span class="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60 pointer-events-none">(inherited)</span>` : ""}
							</div>
							${entry && !isInherited ? html`
								<button
									class="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
									title="Reset to inherited value"
									@click=${() => resetProjectScopeField(projectId, key)}
								>${icon(X, "xs")}</button>
							` : !entry ? html`
								<button
									class="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0"
									title="Discard pending key"
									@click=${() => { delete pendingChanges[key]; renderApp(); }}
								>${icon(X, "xs")}</button>
							` : html`<div class="w-7 shrink-0"></div>`}
						</div>
					`;
				})}
			</div>` : ""}



			<!-- Custom keys: lets users add arbitrary project.yaml fields without -->
			<!-- editing the file by hand. Keeps the legacy KV editing surface alive. -->
			${(() => {
				if (!_projectScopeNewKey.has(projectId)) _projectScopeNewKey.set(projectId, { key: "", value: "" });
				const nk = _projectScopeNewKey.get(projectId)!;
				const trimmedKey = nk.key.trim();
				const keyValid = /^[a-z][a-z0-9_]*$/i.test(trimmedKey);
				const keyExists = trimmedKey in resolved || trimmedKey in pendingChanges;
				const canAdd = keyValid && !keyExists;
				return html`
						<details data-testid="custom-key-composer" class="border-t border-border pt-3">
							<summary class="text-xs text-muted-foreground cursor-pointer select-none font-medium">Add custom key</summary>
							<p class="text-[11px] text-muted-foreground mt-2 mb-3">Add an arbitrary <code class="font-mono">project.yaml</code> field. The new row will appear in the section above; click <strong>Save</strong> to persist.</p>
							<div class="flex items-center gap-3">
								<input
									type="text"
									class="${inputClass} text-foreground"
									style="width: 11rem; flex: 0 0 auto;"
									placeholder="key_name"
									data-testid="custom-key-name"
									.value=${nk.key}
									@input=${(e: Event) => { nk.key = (e.target as HTMLInputElement).value; renderApp(); }}
								/>
								<div class="flex-1 min-w-0">
									<input
										type="text"
										class="${inputClass} text-foreground"
										placeholder="value"
										data-testid="custom-key-value"
										.value=${nk.value}
										@input=${(e: Event) => { nk.value = (e.target as HTMLInputElement).value; renderApp(); }}
										@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && canAdd) { pendingChanges[trimmedKey] = nk.value; nk.key = ""; nk.value = ""; renderApp(); } }}
									/>
								</div>
								<button
									class="p-1 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors shrink-0 disabled:opacity-30 disabled:pointer-events-none"
									data-testid="custom-key-add"
									title="Add field"
									?disabled=${!canAdd}
									@click=${() => {
										pendingChanges[trimmedKey] = nk.value;
										nk.key = "";
										nk.value = "";
										renderApp();
									}}
								>${icon(Plus, "sm")}</button>
							</div>
							${trimmedKey && !keyValid ? html`<p class="text-[11px] text-destructive mt-2">Key must start with a letter and contain only letters, digits, and underscores.</p>` : ""}
							${keyValid && keyExists ? html`<p class="text-[11px] text-amber-600 mt-2">A field named <code class="font-mono">${trimmedKey}</code> already exists. Edit it above.</p>` : ""}
						</details>
					`;
			})()}

			<!-- Save -->
			<div class="flex items-center gap-3 pt-2 border-t border-border">
				<button
					class="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground
						hover:bg-primary/90 transition-colors disabled:opacity-50"
					?disabled=${projectScopeSaveStatus === "saving"}
					@click=${() => {
						if (Object.keys(pendingChanges).length > 0) {
							saveProjectScopeConfig(projectId, pendingChanges).then(() => {
								_projectScopePending.delete(projectId);
								projectScopeConfigCache.delete(projectId);
								renderApp();
							});
						}
					}}
				>${projectScopeSaveStatus === "saving" ? "Saving..." : "Save"}</button>
				${projectScopeSaveStatus === "saved" ? html`<span class="text-xs text-green-600">Saved successfully.</span>` : ""}
				${projectScopeSaveStatus === "error" ? html`<span class="text-xs text-destructive">Failed to save.</span>` : ""}
			</div>

		</div>
	`;
}

function retryProjectPlayFinishSoundLoad(projectId: string): void {
	projectScopeConfigCache.delete(projectId);
	_projectSoundConfigReadStates.delete(projectId);
	loadProjectScopeConfig(projectId);
	renderApp();
}

function renderProjectPlayFinishSoundSetting(projectId: string, projectName: string) {
	ensureProjectSoundGlobalListener();
	const loaded = isProjectPlayFinishSoundOverrideLoaded(projectId);
	const override = getProjectPlayFinishSoundOverride(projectId) ?? "inherit";
	const save = getProjectSoundSaveState(projectId);
	const saving = save.status === "saving";
	const globalEnabled = isPlayFinishSoundEnabled();
	const effectiveEnabled = override === "on" || (override === "inherit" && globalEnabled);
	const readState = _projectSoundConfigReadStates.get(projectId);
	const loadFailed = !loaded && (readState === "error" || readState === "settled");

	const overrideHelp = override === "on"
		? html`<strong class="text-foreground font-medium">On:</strong> Always play a finish beep for ${projectName} sessions, even when the global setting is off.`
		: override === "off"
			? html`<strong class="text-foreground font-medium">Off:</strong> Never play a finish beep for ${projectName} sessions, even when the global setting is on.`
			: html`<strong class="text-foreground font-medium">Inherit global:</strong> Use the header bell setting, currently <strong class="text-foreground font-medium">${globalEnabled ? "On" : "Off"}</strong>.`;
	const effectiveSource = override === "on"
		? "forced on for this project"
		: override === "off"
			? "forced off for this project"
			: `inherited from global (${globalEnabled ? "On" : "Off"})`;

	return html`
		<section class="flex flex-col gap-2" aria-labelledby="project-play-finish-sound-heading">
			<div id="project-play-finish-sound-heading" class="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">Notifications</div>
			<p class="text-xs text-muted-foreground -mt-1">Choose how this project handles agent-finish audio.</p>
			<div class="flex items-center gap-3">
				<label for="project-play-finish-sound" class="text-sm font-medium text-foreground w-28 sm:w-44 shrink-0">Agent finish sound</label>
				<select
					id="project-play-finish-sound"
					data-testid="project-play-finish-sound"
					class="w-full max-w-56 min-w-0 px-2 py-1 rounded-md border border-input bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
					.value=${live(override)}
					?disabled=${!loaded || saving}
					aria-busy=${!loaded || saving ? "true" : "false"}
					aria-describedby="project-play-finish-sound-help project-play-finish-sound-effective project-play-finish-sound-audio project-play-finish-sound-status"
					@change=${(event: Event) => {
						const desired = (event.target as HTMLSelectElement).value as ProjectPlayFinishSoundOverride;
						if (desired === "inherit" || desired === "on" || desired === "off") {
							void saveProjectPlayFinishSound(projectId, desired);
						}
					}}
				>
					<option value="inherit">Inherit global</option>
					<option value="on">On</option>
					<option value="off">Off</option>
				</select>
			</div>
			<p id="project-play-finish-sound-help" class="text-[11px] text-muted-foreground ml-[calc(7rem+0.75rem)] sm:ml-[calc(11rem+0.75rem)]">
				${overrideHelp} Sessions owned by ${projectName} use this setting even when another project is open.
			</p>
			<div
				id="project-play-finish-sound-effective"
				class="inline-flex items-center gap-1.5 self-start px-2 py-0.5 rounded-full border border-border bg-secondary/30 text-[11px] text-muted-foreground ml-[calc(7rem+0.75rem)] sm:ml-[calc(11rem+0.75rem)]"
			>
				<span class="w-1.5 h-1.5 rounded-full ${effectiveEnabled ? "bg-green-500" : "bg-muted-foreground"}" aria-hidden="true"></span>
				<span>Effective: <strong class="text-foreground font-medium">${effectiveEnabled ? "On" : "Off"}</strong> — ${effectiveSource}.</span>
			</div>
			<p id="project-play-finish-sound-audio" class="text-[11px] text-muted-foreground ml-[calc(7rem+0.75rem)] sm:ml-[calc(11rem+0.75rem)]">
				Audio only. Favicon badges, unread indicators, and other notifications are unaffected.
			</p>
			<div
				id="project-play-finish-sound-status"
				data-testid="project-play-finish-sound-status"
				class="min-h-5 ml-[calc(7rem+0.75rem)] sm:ml-[calc(11rem+0.75rem)] text-xs"
				role="status"
				aria-live="polite"
				aria-atomic="true"
			>
				${!loaded && !loadFailed ? html`<span class="text-muted-foreground">Loading sound setting…</span>` : ""}
				${loadFailed ? html`
					<span class="inline-flex items-center gap-2 text-destructive" role="alert">
						Couldn’t load the sound setting.
						<button
							type="button"
							data-testid="project-play-finish-sound-retry"
							class="px-2 py-0.5 rounded border border-input text-foreground hover:bg-secondary transition-colors"
							@click=${() => retryProjectPlayFinishSoundLoad(projectId)}
						>Retry</button>
					</span>
				` : ""}
				${loaded && save.status === "saving" ? html`<span class="text-muted-foreground">Saving…</span>` : ""}
				${loaded && save.status === "saved" ? html`<span class="text-green-600">Saved.</span>` : ""}
				${loaded && save.status === "error" ? html`
					<span class="inline-flex items-center gap-2 text-destructive" role="alert">
						Couldn’t save. Reverted to ${projectSoundOverrideLabel(override)}.
						<button
							type="button"
							data-testid="project-play-finish-sound-retry"
							class="px-2 py-0.5 rounded border border-input text-foreground hover:bg-secondary transition-colors"
							@click=${() => {
								if (save.failedDesired) void saveProjectPlayFinishSound(projectId, save.failedDesired);
							}}
						>Retry</button>
					</span>
				` : ""}
			</div>
		</section>
	`;
}

function renderProjectGeneralTab(projectId: string) {
	const project = (state.projects || []).find((p: any) => p.id === projectId);

	// Reuse the per-project pending changes map for rootPath edits + sandbox config
	if (!_projectScopePending.has(projectId)) _projectScopePending.set(projectId, {});
	const pendingChanges = _projectScopePending.get(projectId)!;

	const inputClass = "flex-1 min-w-0 px-2 py-1 rounded-md border border-input bg-background text-sm font-mono text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring";
	const labelClass = "text-sm font-medium text-foreground w-28 sm:w-44 shrink-0";

	// Load project config for sandbox section (shared with Commands tab)
	loadProjectScopeConfig(projectId);
	const cached = projectScopeConfigCache.get(projectId);
	const resolved = cached?.loaded ? cached.resolved : {};

	const hasPendingChanges = Object.keys(pendingChanges).length > 0;

	return html`
		<div class="flex flex-col gap-6">
			<div class="flex flex-col gap-1">
				<h3 class="text-sm font-medium text-foreground">${project?.name || "Project"}</h3>
			</div>

			<!-- Working Directory -->
			<div class="flex flex-col gap-2">
				<div class="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">Working Directory</div>
				<div class="flex items-center gap-3">
					<input
						type="text"
						class="${inputClass} text-foreground"
						.value=${pendingChanges._rootPath ?? project?.rootPath ?? ""}
						@input=${(e: Event) => {
							pendingChanges._rootPath = (e.target as HTMLInputElement).value;
						}}
					/>
				</div>
				<p class="text-xs text-muted-foreground">
					The directory used when creating new sessions and goals for this project.
				</p>
			</div>

			<hr class="border-border" />

			${renderProjectPlayFinishSoundSetting(projectId, project?.name || "this project")}

			<hr class="border-border" />

			<!-- Worktree (root override + pre-built pool) -->
			${renderWorktreeSection(projectId, resolved, pendingChanges, inputClass, labelClass)}

			<hr class="border-border" />

			<!-- Docker Sandbox -->
			${renderSandboxSection(projectId, resolved, pendingChanges, inputClass, labelClass)}

			<!-- Save -->
			${hasPendingChanges ? html`
				<div class="flex items-center gap-3 pt-2 border-t border-border">
					<button
						class="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground
							hover:bg-primary/90 transition-colors disabled:opacity-50"
						?disabled=${projectScopeSaveStatus === "saving"}
						@click=${() => {
							if (hasPendingChanges) {
								saveProjectScopeConfig(projectId, pendingChanges).then(() => {
									// Invalidate all caches so UI reloads fresh (redacted) data from server
									_projectScopePending.delete(projectId);
									_sandboxTokenEntries.delete(projectId);
									_sandboxMountEntries.delete(projectId);
									projectScopeConfigCache.delete(projectId);
									renderApp();
								});
							}
						}}
					>${projectScopeSaveStatus === "saving" ? "Saving..." : "Save"}</button>
					${projectScopeSaveStatus === "saved" ? html`<span class="text-xs text-green-600">Saved.</span>` : ""}
					${projectScopeSaveStatus === "error" ? html`<span class="text-xs text-destructive">Failed to save.</span>` : ""}
				</div>
			` : ""}

			<hr class="border-border" />
			<div class="flex flex-col gap-1">
				<div class="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">Danger Zone</div>
			</div>
			<div class="flex items-center gap-3">
				<button
					class="px-4 py-2 text-sm rounded-md border border-input bg-background text-foreground
						hover:bg-destructive hover:text-destructive-foreground hover:border-destructive transition-colors"
					@click=${async () => {
						const ok = confirm("Remove project '" + (project?.name || "") + "' from this server? This won't delete any files on disk.");
						if (!ok) return;
						const success = await removeProject(projectId);
						if (success) {
							setProjects(await fetchProjects());
							setHashRoute("settings", "system/general", true);
							renderApp();
						}
					}}
				>Remove Project</button>
				<span class="text-xs text-muted-foreground">Unregister this project. No files will be deleted.</span>
			</div>
		</div>
	`;
}

// ── Per-project Components tab (Phase 4b) ─────────────────────────────
//
// Editable list of `components[]` plus the optional `worktree_root` parent
// directory. Below the list is a read-only "Workflows" disclosure that
// shows each gate's resolved (component, command) pairs and a button to
// regenerate workflows via the project assistant. Single-repo projects
// still see a single component with `repo: "."` — nothing is hidden.

interface ComponentsTabState {
	loaded: boolean;
	components: ComponentEditState[];
	workflows: Record<string, unknown>;
	worktreeRoot: string;
	dirty: boolean;
	saving: "" | "saving" | "saved" | "error";
	errorMessage: string;
	workflowsExpanded: boolean;
	/** Indices of components currently expanded in the list view. */
	expanded: Set<number>;
}

const _componentsTabState = new Map<string, ComponentsTabState>();

function emptyComponentsTabState(): ComponentsTabState {
	return {
		loaded: false,
		components: [],
		workflows: {},
		worktreeRoot: "",
		dirty: false,
		saving: "",
		errorMessage: "",
		workflowsExpanded: false,
		expanded: new Set<number>(),
	};
}

function loadComponentsTab(projectId: string): void {
	const existing = _componentsTabState.get(projectId);
	if (existing?.loaded || existing?.dirty) return;
	if (!existing) _componentsTabState.set(projectId, emptyComponentsTabState());
	(async () => {
		try {
			const res = await gatewayFetch(`/api/projects/${projectId}/structured`);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				const s = _componentsTabState.get(projectId)!;
				s.loaded = true;
				s.errorMessage = data?.error || `Load failed (${res.status})`;
				renderApp();
				return;
			}
			const data = await res.json();
			const s = _componentsTabState.get(projectId)!;
			s.components = (data.components || []).map(componentToEditState);
			s.workflows = data.workflows || {};
			s.worktreeRoot = data.worktree_root || "";
			s.loaded = true;
			renderApp();
		} catch (err: any) {
			const s = _componentsTabState.get(projectId)!;
			s.loaded = true;
			s.errorMessage = err?.message || String(err);
			renderApp();
		}
	})();
}

function markComponentsDirty(projectId: string): void {
	const s = _componentsTabState.get(projectId);
	if (s) { s.dirty = true; s.saving = ""; }
}

async function saveComponentsTab(projectId: string): Promise<void> {
	const s = _componentsTabState.get(projectId);
	if (!s) return;
	s.saving = "saving";
	s.errorMessage = "";
	renderApp();
	try {
		const body = buildSavePayload(s.components, s.workflows, s.worktreeRoot);
		const res = await gatewayFetch(`/api/projects/${projectId}/config`, {
			method: "PUT",
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			const details = Array.isArray(data?.details) && data.details.length > 0
				? data.details.map((d: any) => d?.message ?? String(d)).join("\n")
				: "";
			s.saving = "error";
			s.errorMessage = details ? `${data?.error || "Validation failed"}\n${details}` : (data?.error || `Save failed (${res.status})`);
		} else {
			s.saving = "saved";
			s.dirty = false;
			setTimeout(() => { const cur = _componentsTabState.get(projectId); if (cur) { cur.saving = ""; renderApp(); } }, 2000);
		}
	} catch (err: any) {
		s.saving = "error";
		s.errorMessage = err?.message || String(err);
	}
	renderApp();
}

function renderProjectComponentsTab(projectId: string) {
	loadComponentsTab(projectId);
	const s = _componentsTabState.get(projectId);
	if (!s || !s.loaded) {
		return html`<div class="text-sm text-muted-foreground">Loading components…</div>`;
	}

	const toggleExpand = (index: number) => {
		if (s.expanded.has(index)) s.expanded.delete(index);
		else s.expanded.add(index);
		renderApp();
	};

	const renderComponentCard = (c: ComponentEditState, index: number) => {
		const isExpanded = s.expanded.has(index);
		const pathSummary = [c.repo && c.repo !== "." ? c.repo : null, c.relative_path].filter(Boolean).join(" / ") || ". (project root)";
		const dataOnly = c.commands.length === 0;
		const cmdCountLabel = dataOnly ? "data-only" : `${c.commands.length} cmd${c.commands.length === 1 ? "" : "s"}`;
		return html`
			<div class="wf-gate-card ${isExpanded ? "expanded" : ""}" data-testid="component-card" data-component-name=${c.name}>
				<div class="wf-gate-header" @click=${() => toggleExpand(index)}>
					<span class="wf-gate-idx">${index + 1}</span>
					<span class="wf-gate-chevron">▸</span>
					<span class="wf-gate-name">${c.name || "(unnamed)"}</span>
					<span class="wf-gate-pill" title=${pathSummary}>${pathSummary}</span>
					${dataOnly ? html`<span class="wf-gate-pill" data-testid="data-only-hint">${cmdCountLabel}</span>` : html`<span class="wf-gate-pill">${cmdCountLabel}</span>`}
					<input type="checkbox" class="sr-only" tabindex="-1"
						data-testid="data-only-toggle" .checked=${dataOnly} disabled
						@click=${(e: Event) => e.stopPropagation()}/>
					<button
						class="wf-gate-delete"
						title="Remove component"
						data-testid="delete-component"
						@click=${(e: Event) => {
							e.stopPropagation();
							if (!confirm(`Delete component "${c.name}"?`)) return;
							s.components.splice(index, 1);
							s.expanded.delete(index);
							markComponentsDirty(projectId);
							renderApp();
						}}
					>${icon(Trash2, "sm")}</button>
				</div>
				<div class="wf-gate-body">
					<div class="wf-gate-body-inner">
						<div class="wf-identity-row">
							<label class="wf-field-label">Name</label>
							<input class="wf-input" style="flex:1;min-width:0;" .value=${c.name} placeholder="Component name"
								data-testid="component-name"
								@click=${(e: Event) => e.stopPropagation()}
								@input=${(e: Event) => { c.name = (e.target as HTMLInputElement).value; markComponentsDirty(projectId); renderApp(); }}/>
						</div>
						<div class="wf-identity-row">
							<label class="wf-field-label">Git repo</label>
							<input class="wf-input" style="width:160px;" .value=${c.repo} placeholder="."
								@click=${(e: Event) => e.stopPropagation()}
								@input=${(e: Event) => { c.repo = (e.target as HTMLInputElement).value; markComponentsDirty(projectId); renderApp(); }}/>
							<label class="wf-field-label" style="margin-left:8px;">Component path</label>
							<input class="wf-input" style="flex:1;min-width:0;" .value=${c.relative_path ?? ""} placeholder="e.g. packages/api"
								@click=${(e: Event) => e.stopPropagation()}
								@input=${(e: Event) => { c.relative_path = (e.target as HTMLInputElement).value; markComponentsDirty(projectId); renderApp(); }}/>
						</div>
						<div class="wf-identity-row">
							<label class="wf-field-label">Worktree setup</label>
							<input class="wf-input" style="flex:1;min-width:0;" .value=${c.worktree_setup_command ?? ""} placeholder="e.g. npm ci --prefer-offline"
								@click=${(e: Event) => e.stopPropagation()}
								@input=${(e: Event) => { c.worktree_setup_command = (e.target as HTMLInputElement).value; markComponentsDirty(projectId); renderApp(); }}/>
						</div>
						<div class="wf-field" data-testid="commands-list">
								<span class="wf-verify-label">Commands (${c.commands.length})</span>
								<div class="flex flex-col gap-1.5">
									${c.commands.map((cmd, ci) => html`
										<div class="flex items-center gap-2" data-testid="command-row" @click=${(e: Event) => e.stopPropagation()}>
											<input type="text" class="wf-input" style="width:140px;" .value=${cmd.key} placeholder="name"
												data-testid="command-key"
												@input=${(e: Event) => { cmd.key = (e.target as HTMLInputElement).value; markComponentsDirty(projectId); renderApp(); }}/>
											<input type="text" class="wf-input" style="flex:1;min-width:0;" .value=${cmd.value} placeholder="shell command"
												data-testid="command-value"
												@input=${(e: Event) => { cmd.value = (e.target as HTMLInputElement).value; markComponentsDirty(projectId); renderApp(); }}/>
											<button
												class="wf-gate-delete"
												title="Remove command"
												@click=${() => { c.commands.splice(ci, 1); markComponentsDirty(projectId); renderApp(); }}
											>${icon(X, "sm")}</button>
										</div>
									`)}
									<button
										class="wf-criteria-add-btn"
										data-testid="add-command"
										@click=${(e: Event) => { e.stopPropagation(); c.commands.push({ key: "", value: "" }); markComponentsDirty(projectId); renderApp(); }}
								>Add Command</button>
							</div>
							${dataOnly ? html`<div class="text-[11px] text-muted-foreground italic pl-1 mt-1">No commands defined — this is a data-only component (e.g. docs, fixtures, schemas).</div>` : ""}
						</div>
						<div class="wf-field" data-testid=${`component-config-${c.name}`}>
							<span class="wf-verify-label">Config (${c.config.length})</span>
							<div class="text-[11px] text-muted-foreground italic pl-1 mb-1">Opaque key→string map consumed by skills (e.g. <code>qa_start_command</code>, <code>qa_health_check</code>, <code>qa_max_duration_minutes</code>).</div>
							<div class="flex flex-col gap-1.5">
								${c.config.map((cfg, ci) => html`
									<div class="flex items-center gap-2" data-testid="config-row" @click=${(e: Event) => e.stopPropagation()}>
										<input type="text" class="wf-input" style="width:200px;" .value=${cfg.key} placeholder="qa_start_command"
											data-testid="config-key"
											@input=${(e: Event) => { cfg.key = (e.target as HTMLInputElement).value; markComponentsDirty(projectId); renderApp(); }}/>
										<input type="text" class="wf-input" style="flex:1;min-width:0;" .value=${cfg.value} placeholder="value"
											data-testid="config-value"
											@input=${(e: Event) => { cfg.value = (e.target as HTMLInputElement).value; markComponentsDirty(projectId); renderApp(); }}/>
										<button
											class="wf-gate-delete"
											title="Remove config entry"
											data-testid="delete-config"
											@click=${() => { c.config.splice(ci, 1); markComponentsDirty(projectId); renderApp(); }}
										>${icon(X, "sm")}</button>
									</div>
								`)}
								<button
									class="wf-criteria-add-btn"
									data-testid="add-config"
									@click=${(e: Event) => { e.stopPropagation(); c.config.push({ key: "", value: "" }); markComponentsDirty(projectId); renderApp(); }}
								>Add Config Entry</button>
							</div>
						</div>
					</div>
				</div>
			</div>
		`;
	};

	return html`
		<div class="flex flex-col gap-5" data-testid="components-tab">
			${s.errorMessage ? html`<div class="text-sm text-destructive whitespace-pre-wrap" data-testid="components-error">${s.errorMessage}</div>` : ""}

			<div class="flex items-start gap-4">
				<p class="text-sm text-muted-foreground flex-1 m-0">Components are the build targets in this project — each one has its own commands (build, test, check) and may live in its own git repo or sub-path. Workflow steps reference these commands so they stay in sync as the project evolves.</p>
				<div class="flex items-center gap-2 shrink-0">
					${Button({
						variant: "default",
						size: "sm",
						onClick: async () => {
							const project = (state.projects || []).find((p: any) => p.id === projectId) as any;
							if (!project?.rootPath) return;
							const { createProjectAssistantSession } = await import("./dialogs.js");
							await createProjectAssistantSession(project.rootPath, false, { projectId, existingProjectName: project.name || "" });
						},
						children: html`<span class="inline-flex items-center gap-1.5 font-semibold" data-testid="open-project-assistant">${icon(Sparkles, "sm")} Open Project Assistant</span>`,
					})}
				</div>
			</div>
			<div class="flex flex-col gap-3">
				${s.components.length === 0
					? html`<div class="text-sm text-muted-foreground italic">No components defined. Use "Re-scan repos" or "Add Component" to get started.</div>`
					: s.components.map((c, i) => renderComponentCard(c, i))}
				<button
					class="wf-add-card-btn"
					data-testid="add-component"
					@click=${() => {
						s.components.push({
							name: `component-${s.components.length + 1}`,
							repo: ".",
							relative_path: "",
							worktree_setup_command: "",
							commands: [],
							config: [],
						});
						s.expanded.add(s.components.length - 1);
						markComponentsDirty(projectId);
						renderApp();
					}}
				>${icon(Plus, "sm")}<span>Add Component</span></button>
			</div>

			<div class="flex items-center gap-3 pt-2 border-t border-border">
				<button
					class="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
					?disabled=${!s.dirty || s.saving === "saving"}
					data-testid="save-components"
					@click=${() => saveComponentsTab(projectId)}
				>${s.saving === "saving" ? "Saving…" : "Save"}</button>
				${s.saving === "saved" ? html`<span class="text-xs text-green-600" data-testid="save-status">Saved.</span>` : ""}
				${s.saving === "error" ? html`<span class="text-xs text-destructive" data-testid="save-status">Failed.</span>` : ""}
			</div>
		</div>
	`;
}

function renderProjectScopeDirectoriesTab(_projectId: string) {
	return renderDirectoriesTab();
}

/** Workflows tab — renders the same UI as the standalone workflows page.
 *  Workflows are project-scoped only, so this is just a tab-shaped wrapper
 *  around the existing renderWorkflowPage() / loadWorkflowPageData() module.
 *  We sync the shared config scope to the active settings project so the
 *  workflow page fetches the right project's workflows. */
let _workflowsTabLoadedFor: string | null = null;
function renderProjectScopeWorkflowsTab(projectId: string) {
	if (getConfigScope() !== projectId) {
		setConfigScope(projectId);
		_workflowsTabLoadedFor = null;
	}
	if (_workflowsTabLoadedFor !== projectId) {
		_workflowsTabLoadedFor = projectId;
		loadWorkflowPageData();
	}
	return html`<div data-testid="workflows-tab">${renderWorkflowPage({ embedded: true })}</div>`;
}

function renderAppearanceTab(projectId: string) {
	const project = (state.projects || []).find((p: any) => p.id === projectId) as any;
	if (!project) return html`<div class="text-sm text-muted-foreground">Project not found.</div>`;

	const currentPalette: string | null = project.palette || null;

	const savePaletteAndColors = async (palette: string | undefined, colorLight?: string, colorDark?: string) => {
		const body: any = { palette: palette ?? null };
		if (colorLight) body.colorLight = colorLight;
		if (colorDark) body.colorDark = colorDark;
		try {
			const res = await gatewayFetch(`/api/projects/${projectId}`, {
				method: "PUT",
				body: JSON.stringify(body),
			});
			if (res.ok) {
				const updated = await res.json();
				const idx = state.projects.findIndex((p: any) => p.id === projectId);
				if (idx >= 0) state.projects[idx] = updated;
				applyProjectPalette(projectId);
				renderApp();
			}
		} catch { /* ignore */ }
	};

	const saveColor = async (field: "colorLight" | "colorDark", value: string) => {
		try {
			const res = await gatewayFetch(`/api/projects/${projectId}`, {
				method: "PUT",
				body: JSON.stringify({ [field]: value }),
			});
			if (res.ok) {
				const updated = await res.json();
				const idx = state.projects.findIndex((p: any) => p.id === projectId);
				if (idx >= 0) state.projects[idx] = updated;
				applyProjectPalette(projectId);
				renderApp();
			}
		} catch { /* ignore */ }
	};

	return html`
		<div class="flex flex-col gap-6">
			<!-- Palette Picker -->
			<div class="flex flex-col gap-3">
				<div>
					<h3 class="text-sm font-medium text-foreground">Color Palette</h3>
					<p class="text-xs text-muted-foreground mt-1">
						Override the global color palette when viewing this project's sessions and goals.
					</p>
				</div>
				<div class="grid gap-2" style="grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));">
					<!-- None option -->
					<button
						class="flex flex-col gap-1.5 px-3 py-2.5 rounded-lg border transition-all cursor-pointer text-left w-full
							${currentPalette === null
								? 'border-primary bg-primary/5 ring-1 ring-primary/30'
								: 'border-border hover:border-primary/40 hover:bg-secondary/30'}"
						@click=${() => savePaletteAndColors(undefined)}
					>
						<div class="flex items-center justify-center w-full rounded-md border border-dashed border-border" style="height:68px;">
							<span class="text-sm text-muted-foreground">No override</span>
						</div>
						<div class="flex items-center gap-1.5">
							<span class="text-sm font-medium ${currentPalette === null ? 'text-foreground' : 'text-muted-foreground'}">
								None (use global)
							</span>
							${currentPalette === null ? html`<span class="text-xs text-primary">Active</span>` : ""}
						</div>
					</button>
					<!-- Palette cards -->
					${PALETTES.map((palette) => {
						const isActive = currentPalette === palette.id;
						const colors = PALETTE_PRIMARY_COLORS[palette.id];
						return html`
							<button
								class="flex flex-col gap-1.5 px-3 py-2.5 rounded-lg border transition-all cursor-pointer text-left w-full
									${isActive
										? 'border-primary bg-primary/5 ring-1 ring-primary/30'
										: 'border-border hover:border-primary/40 hover:bg-secondary/30'}"
								title="Select ${palette.name} palette"
								@click=${() => savePaletteAndColors(palette.id, colors?.light, colors?.dark)}
							>
								${renderPalettePreview(palette)}
								<div class="flex items-center gap-1.5">
									<span class="text-sm font-medium ${isActive ? 'text-foreground' : 'text-muted-foreground'}">
										${palette.name}
									</span>
									${isActive ? html`<span class="text-xs text-primary">Active</span>` : ""}
								</div>
							</button>
						`;
					})}
				</div>
			</div>

			<!-- Project Accent Color -->
			<div class="flex flex-col gap-3">
				<div>
					<h3 class="text-sm font-medium text-foreground">Project Accent Color</h3>
					<p class="text-xs text-muted-foreground mt-1">
						Used for the project header in the sidebar. Automatically seeded when you pick a palette.
					</p>
				</div>
				<div class="flex items-center gap-6">
					<div class="flex items-center gap-2">
						<label class="text-sm text-muted-foreground">Light mode</label>
						<input type="color"
							.value=${oklchToHex(project.colorLight || '')}
							@change=${(e: Event) => { const hex = (e.target as HTMLInputElement).value; saveColor("colorLight", hex); }}
							class="w-10 h-8 rounded border border-input cursor-pointer"
							title="Light mode accent color"
						/>
						<span class="text-xs text-muted-foreground font-mono">${project.colorLight || ''}</span>
					</div>
					<div class="flex items-center gap-2">
						<label class="text-sm text-muted-foreground">Dark mode</label>
						<input type="color"
							.value=${oklchToHex(project.colorDark || '')}
							@change=${(e: Event) => { const hex = (e.target as HTMLInputElement).value; saveColor("colorDark", hex); }}
							class="w-10 h-8 rounded border border-input cursor-pointer"
							title="Dark mode accent color"
						/>
						<span class="text-xs text-muted-foreground font-mono">${project.colorDark || ''}</span>
					</div>
				</div>
			</div>
		</div>
	`;
}

// ── Maintenance tab state ──

type WorktreeInventorySource =
	| "runtime-session"
	| "persisted-live-session"
	| "archived-session"
	| "goal"
	| "team"
	| "delegate"
	| "staff"
	| "pool"
	| "git-worktree"
	| "filesystem";

type WorktreeInventoryClassification =
	| "ready-to-clean"
	| "protected-in-use"
	| "archived-owned"
	| "unowned-git-worktree"
	| "pool-entry"
	| "already-cleaned"
	| "stale-filesystem-only"
	| "scan-error";

type WorktreeInventoryDisposition = "ready-to-clean" | "protected" | "already-cleaned" | "needs-attention" | "failed";

type WorktreeInventoryOwner = { type: string; id: string; title?: string; archived?: boolean };

type WorktreeMaintenanceItem = {
	id: string;
	classification: WorktreeInventoryClassification;
	disposition: WorktreeInventoryDisposition;
	actionable: boolean;
	selectable: boolean;
	defaultSelected: boolean;
	projectId?: string;
	projectName?: string;
	componentName?: string;
	repo?: string;
	repoPath?: string;
	repoDisplayName?: string;
	worktreeRoot?: string;
	path: string;
	branch?: string;
	sources: WorktreeInventorySource[];
	owners?: WorktreeInventoryOwner[];
	reason: string;
	detail: string;
	pathExists?: boolean;
	gitWorktreeMetadataExists?: boolean;
	localBranchExists?: boolean;
	willDeleteBranch: boolean;
	branchDeleteBlockedReason?: string;
	legacy?: Record<string, unknown>;
};

type WorktreeMaintenanceCounts = {
	total: number;
	readyToClean: number;
	protectedInUse: number;
	archivedOwned: number;
	unownedGitWorktrees: number;
	poolEntries: number;
	alreadyCleaned: number;
	needsAttention: number;
	scanErrors: number;
	defaultSelected: number;
	byClassification: Record<string, number>;
	byReason: Record<string, number>;
	bySource: Record<string, number>;
};

type WorktreeInventoryReport = {
	items: WorktreeMaintenanceItem[];
	counts: WorktreeMaintenanceCounts;
	generatedAt: number;
	scanned?: { projects?: number; repos?: number; worktreeRoots?: number };
	projectCount?: number;
	repoCount?: number;
	worktreeRootCount?: number;
};

type WorktreeCleanupResponse = {
	counts: {
		requested: number;
		cleaned: number;
		branchDeleted: number;
		skipped: number;
		alreadyCleaned: number;
		failed: number;
	};
	results?: Array<{
		id?: string;
		itemId?: string;
		path?: string;
		branch?: string;
		repo?: string;
		repoPath?: string;
		projectId?: string;
		projectName?: string;
		classification?: string;
		disposition?: WorktreeInventoryDisposition;
		status?: "cleaned" | "skipped" | "already-cleaned" | "failed";
		reason?: string;
		detail?: string;
		error?: string;
		worktreeRemoved?: boolean;
		branchDeleted?: boolean;
	}>;
};

let maintenanceSessions: Array<{ id: string; title: string; createdAt: number }> | null = null;
let maintenanceArchives: { count: number; totalSizeBytes: number } | null = null;
let maintenanceLoading: "worktreeInventory" | "sessions" | "archives" | "search" | "orphanRows" | null = null;
let worktreeInventoryReport: WorktreeInventoryReport | null = null;
let worktreeInventorySelection = new Set<string>();
let worktreeInventoryCleanup: WorktreeCleanupResponse | null = null;
let worktreeInventoryError: string | null = null;
let worktreeInventoryShowDiagnostics = false;
const worktreeInventoryExpandedGroups = new Set<string>();

// Search Index panel state
let searchIndexStats: SearchStats | null = null;
let searchIndexStatsLoaded = false;
let searchIndexProgress: { completed: number; total: number } | null = null;
let searchIndexError: string | null = null;
let searchIndexWsSubscribed = false;
let orphanIndexRows: OrphanedIndexRows | null = null;

// Agent directory settings (system Maintenance). Settings are restart-gated: this
// UI only saves the next-start preference and optionally copy-migrates data.
type AgentDirDisplayState = {
	activePath: string;
	startupSource: string;
	defaultPath: string;
	persistedPath: string | null;
	pendingPath: string | null;
	nextStartPath: string;
	nextStartSource: string;
	restartRequired: boolean;
	envOverride: string | null;
	history: string[];
	guidance?: string;
};

type AgentDirValidationState = {
	ok: boolean;
	resolvedPath?: string;
	message?: string;
	code?: string;
};

type AgentDirMigrationReport = {
	copied?: number | unknown[];
	skipped?: number | unknown[];
	overwritten?: number | unknown[];
	missing?: number | unknown[];
	warnings?: string[];
	errors?: string[];
	[key: string]: unknown;
};

let agentDirState: AgentDirDisplayState | null = null;
let agentDirLoaded = false;
let agentDirLoading = false;
let agentDirError = "";
let agentDirInput = "";
let agentDirValidation: AgentDirValidationState | null = null;
let agentDirSaving = false;
let agentDirSaveMessage = "";
let agentDirSaveIsError = false;
let agentDirMigrating = false;
let agentDirMigrateOverwrite = false;
let agentDirMigrationReport: AgentDirMigrationReport | null = null;
let agentDirMigrationError = "";

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTimestamp(ts: number | null): string {
	if (!ts) return "never";
	try { return new Date(ts).toLocaleString(); } catch { return "unknown"; }
}

function currentProjectIdForSearch(): string | undefined {
	// Panel is in system-scope Maintenance tab, but search data is per-project.
	// Fall back to the active project selected in the sidebar.
	return state.activeProjectId ?? undefined;
}

async function loadSearchStats(): Promise<void> {
	maintenanceLoading = "search";
	renderApp();
	try {
		searchIndexStats = await searchStats(currentProjectIdForSearch());
		searchIndexStatsLoaded = true;
	} catch {
		searchIndexStats = null;
	}
	maintenanceLoading = null;
	renderApp();
}

/** Subscribe to index:* events to drive the live progress bar + error state. */
function ensureSearchIndexWsSubscribed(): void {
	if (searchIndexWsSubscribed) return;
	searchIndexWsSubscribed = true;
	window.addEventListener("bobbit-index-event", (e: Event) => {
		const evt = (e as CustomEvent).detail;
		if (!evt) return;
		if (evt.type === "index:progress") {
			searchIndexProgress = { completed: evt.completed, total: evt.total };
			searchIndexError = null;
			renderApp();
		} else if (evt.type === "index:complete") {
			searchIndexProgress = null;
			searchIndexError = null;
			// Refresh stats so row counts / lastRebuildAt catch up.
			void loadSearchStats();
		} else if (evt.type === "index:error") {
			searchIndexError = evt.message || "Search index error";
			searchIndexProgress = null;
			renderApp();
		}
	});
}

async function rebuildSearchIndex(): Promise<void> {
	if (!window.confirm("Rebuild the search index? This re-embeds every goal, session, message, and staff record for the active project. It runs in the background.")) return;
	maintenanceLoading = "search";
	renderApp();
	try {
		const projectId = currentProjectIdForSearch();
		const res = await searchRebuild(projectId);
		if (res.ok) {
			// Optimistic yellow dot — the WS event stream will take over.
			searchIndexProgress = { completed: 0, total: 0 };
			searchIndexError = null;
			dispatchIndexEvent({
				type: "index:progress",
				projectId: projectId ?? "",
				phase: "rebuild",
				total: 0,
				completed: 0,
				backlog: 0,
			});
		} else if (res.status === 503) {
			searchIndexError = res.error || "Search unavailable";
			dispatchIndexEvent({
				type: "index:error",
				projectId: projectId ?? "",
				message: res.error || "Search unavailable",
				recoverable: false,
			});
		} else {
			searchIndexError = res.error || `Rebuild failed (HTTP ${res.status})`;
		}
	} catch (err) {
		searchIndexError = (err as Error).message;
	}
	maintenanceLoading = null;
	renderApp();
}

async function scanOrphanIndexRows(): Promise<void> {
	maintenanceLoading = "orphanRows";
	renderApp();
	try {
		orphanIndexRows = await orphanedIndexRows(currentProjectIdForSearch());
	} catch {
		orphanIndexRows = { count: 0, sample: [] };
	}
	maintenanceLoading = null;
	renderApp();
}

async function cleanupOrphanRows(): Promise<void> {
	maintenanceLoading = "orphanRows";
	renderApp();
	try {
		await cleanupOrphanedIndexRows(currentProjectIdForSearch());
	} catch { /* ignore */ }
	maintenanceLoading = null;
	await scanOrphanIndexRows();
}

function emptyWorktreeMaintenanceCounts(): WorktreeMaintenanceCounts {
	return {
		total: 0,
		readyToClean: 0,
		protectedInUse: 0,
		archivedOwned: 0,
		unownedGitWorktrees: 0,
		poolEntries: 0,
		alreadyCleaned: 0,
		needsAttention: 0,
		scanErrors: 0,
		defaultSelected: 0,
		byClassification: {},
		byReason: {},
		bySource: {},
	};
}

function emptyWorktreeInventoryReport(): WorktreeInventoryReport {
	return { items: [], counts: emptyWorktreeMaintenanceCounts(), generatedAt: Date.now() };
}

function isWorktreeInventoryActionable(item: WorktreeMaintenanceItem): boolean {
	return item.actionable !== false && item.selectable !== false && item.disposition === "ready-to-clean";
}

function worktreeReasonDetail(reason: string): string {
	const details: Record<string, string> = {
		"safe-archived-session-worktree": "Archived-session-owned worktrees that the server classified as safe to remove.",
		"safe-unowned-session-worktree": "Git metadata contains Bobbit session worktrees that no durable Bobbit record owns.",
		"safe-pool-entry": "Pool-owned worktrees are shown for audit and reclaim diagnostics, not selected by maintenance by default.",
		"pool-entry": "Pool-owned worktrees are shown for audit and reclaim diagnostics, not selected by maintenance by default.",
		"already-cleaned": "Bobbit remembers metadata for this worktree, but no host cleanup remains.",
		"filesystem-only-needs-attention": "A directory exists under a worktree root without enough Bobbit/Git provenance for automatic cleanup. Inspect it manually.",
		"stale-filesystem-only": "A filesystem-only directory needs manual inspection before deletion.",
		"sandbox-container-path": "This path is inside a sandbox/container and is not a host cleanup target.",
		"scan-error": "The server could not safely classify one or more worktrees.",
		"git-scan-error": "Git worktree metadata could not be scanned for this repo.",
		"fs-scan-error": "A worktree-root directory could not be scanned.",
		"cleanup-failed": "Cleanup was requested, but Git or filesystem operations did not complete for this record.",
	};
	return details[reason] ?? "These records are shown for troubleshooting and audit only.";
}

function normalizeWorktreeInventoryReport(data: Partial<WorktreeInventoryReport> | null | undefined): WorktreeInventoryReport {
	const items = Array.isArray(data?.items) ? data!.items.map((item, index) => ({
		...item,
		id: String(item.id || `${item.projectId || "unknown"}:${item.repo || "."}:${item.path || item.branch || index}`),
		path: item.path || "",
		sources: Array.isArray(item.sources) ? item.sources : [],
		owners: Array.isArray(item.owners) ? item.owners : [],
		reason: item.reason || item.classification || "unknown",
		detail: item.detail || worktreeReasonDetail(item.reason || item.classification || "unknown"),
		actionable: Boolean(item.actionable),
		selectable: item.selectable !== false,
		defaultSelected: item.defaultSelected !== false,
		willDeleteBranch: Boolean(item.willDeleteBranch),
	})) : [];
	const raw = data?.counts ?? emptyWorktreeMaintenanceCounts();
	const counts: WorktreeMaintenanceCounts = {
		...emptyWorktreeMaintenanceCounts(),
		...raw,
		total: raw.total ?? items.length,
		readyToClean: raw.readyToClean ?? items.filter(isWorktreeInventoryActionable).length,
		protectedInUse: raw.protectedInUse ?? items.filter(item => item.disposition === "protected" || item.classification === "protected-in-use").length,
		archivedOwned: raw.archivedOwned ?? items.filter(item => item.classification === "archived-owned").length,
		unownedGitWorktrees: raw.unownedGitWorktrees ?? items.filter(item => item.classification === "unowned-git-worktree").length,
		poolEntries: raw.poolEntries ?? items.filter(item => item.classification === "pool-entry").length,
		alreadyCleaned: raw.alreadyCleaned ?? items.filter(item => item.disposition === "already-cleaned" || item.classification === "already-cleaned").length,
		needsAttention: raw.needsAttention ?? items.filter(item => item.disposition === "needs-attention" || item.disposition === "failed" || item.classification === "stale-filesystem-only" || item.classification === "scan-error").length,
		scanErrors: raw.scanErrors ?? items.filter(item => item.classification === "scan-error").length,
		defaultSelected: raw.defaultSelected ?? items.filter(item => isWorktreeInventoryActionable(item) && item.defaultSelected !== false).length,
		byClassification: raw.byClassification ?? {},
		byReason: raw.byReason ?? {},
		bySource: raw.bySource ?? {},
	};
	return {
		items,
		counts,
		generatedAt: data?.generatedAt ?? Date.now(),
		scanned: data?.scanned,
		projectCount: data?.projectCount,
		repoCount: data?.repoCount,
		worktreeRootCount: data?.worktreeRootCount,
	};
}

function worktreeInventoryActionableRows(): WorktreeMaintenanceItem[] {
	return (worktreeInventoryReport?.items ?? []).filter(isWorktreeInventoryActionable);
}

function selectedWorktreeInventoryItemIds(): string[] {
	const ids = new Set(worktreeInventoryActionableRows().map(item => item.id));
	return Array.from(worktreeInventorySelection).filter(id => ids.has(id));
}

function toggleWorktreeInventorySelection(id: string, checked: boolean): void {
	if (checked) worktreeInventorySelection.add(id);
	else worktreeInventorySelection.delete(id);
	renderApp();
}

function setWorktreeInventorySelection(items: WorktreeMaintenanceItem[]): void {
	worktreeInventorySelection = new Set(items.filter(isWorktreeInventoryActionable).map(item => item.id));
	renderApp();
}

async function scanWorktreeInventory(options: { preserveCleanupResult?: boolean } = {}): Promise<void> {
	maintenanceLoading = "worktreeInventory";
	worktreeInventoryError = null;
	if (!options.preserveCleanupResult) worktreeInventoryCleanup = null;
	const previousScan = worktreeInventoryReport;
	const previousSelection = new Set(worktreeInventorySelection);
	renderApp();
	try {
		const res = await gatewayFetch("/api/maintenance/worktrees");
		if (res.ok) {
			const data = await res.json() as WorktreeInventoryReport;
			worktreeInventoryReport = normalizeWorktreeInventoryReport(data);
			const actionable = worktreeInventoryActionableRows();
			worktreeInventorySelection = previousScan
				? new Set(actionable.filter(item => previousSelection.has(item.id)).map(item => item.id))
				: new Set(actionable.filter(item => item.defaultSelected !== false).map(item => item.id));
			worktreeInventoryExpandedGroups.clear();
			if (!options.preserveCleanupResult) worktreeInventoryShowDiagnostics = false;
		} else {
			worktreeInventoryReport = emptyWorktreeInventoryReport();
			worktreeInventorySelection = new Set();
			worktreeInventoryError = `Worktree scan failed (HTTP ${res.status})`;
		}
	} catch (err) {
		worktreeInventoryReport = emptyWorktreeInventoryReport();
		worktreeInventorySelection = new Set();
		worktreeInventoryError = `Worktree scan failed: ${(err as Error).message || "Scan failed"}`;
	}
	maintenanceLoading = null;
	renderApp();
}

function normalizeWorktreeCleanupResponse(data: Partial<WorktreeCleanupResponse> | null | undefined): WorktreeCleanupResponse {
	return {
		counts: {
			requested: data?.counts?.requested ?? 0,
			cleaned: data?.counts?.cleaned ?? 0,
			branchDeleted: data?.counts?.branchDeleted ?? 0,
			skipped: data?.counts?.skipped ?? 0,
			alreadyCleaned: data?.counts?.alreadyCleaned ?? 0,
			failed: data?.counts?.failed ?? 0,
		},
		results: Array.isArray(data?.results) ? data!.results : [],
	};
}

async function cleanupWorktreeInventory(mode: "selected" | "all-safe" = "selected"): Promise<void> {
	const itemIds = selectedWorktreeInventoryItemIds();
	const readyToClean = worktreeInventoryReport?.counts.readyToClean ?? 0;
	if (mode === "selected" && itemIds.length === 0) return;
	if (mode === "all-safe" && readyToClean === 0) return;
	if (mode === "all-safe") {
		const confirmed = await confirmAction(
			`Clean ${readyToClean} worktree${readyToClean === 1 ? "" : "s"}?`,
			"Bobbit will rescan before deleting and will remove only server-classified safe candidates. Transcripts, archived sessions, goals, proposals, prompts, and search records are preserved.",
			"Clean worktrees",
			true,
		);
		if (!confirmed) return;
	}
	maintenanceLoading = "worktreeInventory";
	worktreeInventoryError = null;
	let shouldRescan = false;
	renderApp();
	try {
		const res = await gatewayFetch("/api/maintenance/cleanup-worktrees", {
			method: "POST",
			body: JSON.stringify(mode === "all-safe" ? { mode: "all-safe" } : { mode: "selected", itemIds }),
		});
		if (res.ok) {
			worktreeInventoryCleanup = normalizeWorktreeCleanupResponse(await res.json());
			worktreeInventoryShowDiagnostics = (worktreeInventoryCleanup.counts.failed + worktreeInventoryCleanup.counts.skipped) > 0;
			shouldRescan = true;
		} else {
			worktreeInventoryCleanup = null;
			worktreeInventoryError = `Cleanup failed (HTTP ${res.status})`;
		}
	} catch (err) {
		worktreeInventoryCleanup = null;
		worktreeInventoryError = (err as Error).message || "Cleanup failed";
	}
	maintenanceLoading = null;
	if (shouldRescan) await scanWorktreeInventory({ preserveCleanupResult: true });
	else renderApp();
}

function worktreeStatusClass(itemOrDisposition: WorktreeMaintenanceItem | WorktreeInventoryDisposition | string): string {
	const disposition = typeof itemOrDisposition === "string" ? itemOrDisposition : itemOrDisposition.disposition;
	if (disposition === "ready-to-clean") return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20";
	if (disposition === "already-cleaned") return "bg-secondary text-muted-foreground border border-border";
	if (disposition === "failed") return "bg-destructive/10 text-destructive border border-destructive/20";
	return "bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20";
}

function worktreeStatusLabel(item: WorktreeMaintenanceItem): string {
	if (item.disposition === "ready-to-clean") return "Ready to clean";
	if (item.classification === "pool-entry") return "Pool entry";
	if (item.disposition === "protected") return "Protected/in use";
	if (item.disposition === "already-cleaned") return "Already cleaned";
	if (item.disposition === "failed") return "Cleanup failed";
	return "Needs attention";
}

function humanizeWorktreeToken(value: string): string {
	return (value || "unknown").replace(/-/g, " ").replace(/\b\w/g, ch => ch.toUpperCase());
}

function worktreeClassificationLabel(value: string): string {
	const labels: Record<string, string> = {
		"ready-to-clean": "Ready to clean",
		"protected-in-use": "Protected/in use",
		"archived-owned": "Archived-owned",
		"unowned-git-worktree": "Unowned Git worktree",
		"pool-entry": "Pool entry",
		"already-cleaned": "Already cleaned",
		"stale-filesystem-only": "Filesystem-only",
		"scan-error": "Scan error",
	};
	return labels[value] ?? humanizeWorktreeToken(value);
}

function worktreeReasonLabel(reason: string): string {
	const labels: Record<string, string> = {
		"safe-archived-session-worktree": "Archived cleanup target",
		"safe-unowned-session-worktree": "Unowned Git worktree",
		"safe-pool-entry": "Pool entry",
		"referenced-by-live-session": "Referenced by live session",
		"referenced-by-live-goal": "Referenced by live goal",
		"referenced-by-live-team": "Referenced by live team",
		"referenced-by-delegate": "Referenced by delegate",
		"referenced-by-staff": "Referenced by staff",
		"referenced-by-pool": "Referenced by pool",
		"branch-referenced-by-live-record": "Branch referenced by live record",
		"branch-referenced-by-archived-record": "Branch referenced by archived record",
		"git-worktree-metadata-missing": "Git metadata missing",
		"filesystem-only-needs-attention": "Filesystem-only needs attention",
		"sandbox-container-path": "Sandbox/container path",
		"primary-worktree": "Primary worktree",
		"missing-repo-path": "Missing repo path",
		"missing-worktree-path": "Missing worktree path",
		"git-scan-error": "Git scan error",
		"fs-scan-error": "Filesystem scan error",
		"cleanup-failed": "Cleanup failed",
		"pool-entry": "Pool entries",
		"already-cleaned": "Already cleaned",
		"scan-error": "Scan errors",
	};
	return labels[reason] ?? humanizeWorktreeToken(reason);
}

function worktreeSourceLabel(source: string): string {
	const labels: Record<string, string> = {
		"runtime-session": "Runtime session",
		"persisted-live-session": "Live session",
		"archived-session": "Archived session",
		goal: "Goal",
		team: "Team",
		delegate: "Delegate",
		staff: "Staff",
		pool: "Pool",
		"git-worktree": "Git metadata",
		filesystem: "Filesystem",
	};
	return labels[source] ?? humanizeWorktreeToken(source);
}

function worktreeSourcesLabel(sources: string[]): string {
	return sources.length > 0 ? sources.map(worktreeSourceLabel).join(", ") : "Unknown";
}

function sanitizeWorktreeGroupId(value: string): string {
	return (value || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function shortWorktreeId(id: string): string {
	return id.length > 12 ? id.slice(0, 8) : id;
}

function worktreeItemTitle(item: WorktreeMaintenanceItem): string {
	const ownerTitle = item.owners?.find(owner => owner.title)?.title;
	if (ownerTitle) return ownerTitle;
	if (item.branch) return item.branch;
	const path = item.path || "Worktree";
	return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function worktreeRepoLabel(item: WorktreeMaintenanceItem): string {
	return item.repoDisplayName || item.componentName || item.repo || ".";
}

function worktreeProjectLabel(item: WorktreeMaintenanceItem): string {
	return item.projectName || item.projectId || "No project";
}

function worktreeBranchOutcome(item: WorktreeMaintenanceItem): string {
	if (item.willDeleteBranch) return "Branch will be deleted";
	if (item.branchDeleteBlockedReason) return `Branch will be kept: ${item.branchDeleteBlockedReason}`;
	return item.branch ? "Branch will be kept" : "No branch recorded";
}

function focusWorktreeCleanupElement(id: string): void {
	window.setTimeout(() => {
		const el = document.getElementById(id) as HTMLElement | null;
		el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
		el?.focus({ preventScroll: true });
	}, 0);
}

function showWorktreeDiagnosticsAndFocus(groupId?: string): void {
	worktreeInventoryShowDiagnostics = true;
	renderApp();
	focusWorktreeCleanupElement(groupId ? `worktree-cleanup-group-${sanitizeWorktreeGroupId(groupId)}` : "worktree-cleanup-troubleshooting-panel");
}

function renderWorktreeSummaryChip(label: string, value: number, testId: string, onClick?: () => void) {
	const content = html`
		<span class="text-[11px] text-muted-foreground">${label}:</span>
		<span class="text-sm font-semibold text-foreground">${value}</span>
	`;
	const classes = "flex min-w-[8rem] flex-col gap-0.5 rounded-md border border-border bg-secondary/30 px-3 py-2 text-left";
	return onClick && value > 0 ? html`
		<button type="button" class="${classes} hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-ring" data-testid=${testId} aria-controls="worktree-cleanup-actionable-list worktree-cleanup-troubleshooting-panel" @click=${onClick}>${content}</button>
	` : html`
		<div class="${classes}" data-testid=${testId}>${content}</div>
	`;
}

function renderWorktreeCleanupRow(item: WorktreeMaintenanceItem, options: { selectable: boolean }) {
	const selected = worktreeInventorySelection.has(item.id);
	const repoLabel = worktreeRepoLabel(item);
	const title = worktreeItemTitle(item);
	const checkboxLabel = `Select worktree ${title} repo ${repoLabel} branch ${item.branch || "none"} path ${item.path || "none"}`;
	const ownerIds = (item.owners ?? []).map(owner => `${owner.type}:${owner.id}`).join(", ");
	const body = html`
		<div class="min-w-0 flex-1 flex flex-col gap-1">
			<div class="flex flex-wrap items-center gap-1.5">
				<span class="text-[10px] px-1.5 py-0.5 rounded ${worktreeStatusClass(item)}">${worktreeStatusLabel(item)}</span>
				<span class="font-medium text-foreground truncate max-w-full">${title}</span>
				<span class="font-mono text-[10px] text-muted-foreground">${shortWorktreeId(item.id)}</span>
				<span class="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground">${worktreeProjectLabel(item)}</span>
				<span class="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground">${repoLabel}</span>
				<span class="text-[10px] px-1.5 py-0.5 rounded bg-background text-muted-foreground border border-border">${worktreeClassificationLabel(item.classification)}</span>
			</div>
			<div class="text-muted-foreground">${item.detail || worktreeReasonDetail(item.reason)}</div>
			<div class="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1 font-mono text-muted-foreground">
				<div class="break-all">repo: ${repoLabel}</div>
				<div class="break-all">branch: ${item.branch || "none"}</div>
				<div class="sm:col-span-2 break-all">worktree: ${item.path || "No worktree path recorded"}</div>
				${item.repoPath ? html`<div class="sm:col-span-2 break-all">repo path: ${item.repoPath}</div>` : ""}
				<div class="sm:col-span-2 break-all">sources: ${worktreeSourcesLabel(item.sources)}</div>
				${ownerIds ? html`<div class="sm:col-span-2 break-all">owners: ${ownerIds}</div>` : ""}
			</div>
			<div class="text-muted-foreground">${worktreeBranchOutcome(item)}</div>
			<details class="mt-1">
				<summary class="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">Technical details</summary>
				<div class="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
					<div>classification: ${item.classification}</div>
					<div>disposition: ${item.disposition}</div>
					<div>reason: ${item.reason}</div>
					<div>sources: ${item.sources.join(", ") || "none"}</div>
					<div class="sm:col-span-2 break-all">item id: ${item.id}</div>
					${ownerIds ? html`<div class="sm:col-span-2 break-all">owner ids: ${ownerIds}</div>` : ""}
				</div>
			</details>
		</div>
	`;
	return options.selectable ? html`
		<label
			class="flex items-start gap-2 rounded border border-border bg-background/70 p-2 text-xs cursor-pointer"
			data-testid="worktree-cleanup-row"
			data-worktree-id=${item.id}
			data-disposition=${item.disposition}
			data-classification=${item.classification}
			data-reason=${item.reason}
		>
			<input
				type="checkbox"
				class="mt-0.5 w-4 h-4 rounded border-input accent-primary shrink-0"
				aria-label=${checkboxLabel}
				.checked=${selected}
				?disabled=${maintenanceLoading === "worktreeInventory"}
				@change=${(e: Event) => toggleWorktreeInventorySelection(item.id, (e.target as HTMLInputElement).checked)}
			/>
			${body}
		</label>
	` : html`
		<div
			class="flex items-start gap-2 rounded border border-border bg-background/70 p-2 text-xs opacity-90"
			data-testid="worktree-cleanup-row"
			data-worktree-id=${item.id}
			data-disposition=${item.disposition}
			data-classification=${item.classification}
			data-reason=${item.reason}
		>
			${body}
		</div>
	`;
}

type WorktreeDiagnosticExample = {
	key: string;
	groupKey: string;
	label: string;
	detail: string;
	item?: WorktreeMaintenanceItem;
	status?: "skipped" | "already-cleaned" | "failed";
	path?: string;
	branch?: string;
	repo?: string;
};

function worktreeTroubleshootingGroupKey(item: WorktreeMaintenanceItem): string {
	if (item.classification === "pool-entry") return "pool-entry";
	if (item.classification === "already-cleaned" || item.disposition === "already-cleaned") return "already-cleaned";
	if (item.classification === "scan-error" || item.disposition === "failed") return "scan-error";
	return item.reason || item.classification;
}

function worktreeDiagnosticsByGroup(): Array<{ key: string; label: string; detail: string; count: number; examples: WorktreeDiagnosticExample[] }> {
	const buckets = new Map<string, WorktreeDiagnosticExample[]>();
	const add = (example: WorktreeDiagnosticExample) => {
		buckets.set(example.groupKey, [...(buckets.get(example.groupKey) || []), example]);
	};
	for (const item of worktreeInventoryReport?.items ?? []) {
		if (isWorktreeInventoryActionable(item)) continue;
		const groupKey = worktreeTroubleshootingGroupKey(item);
		add({ key: item.id, groupKey, label: worktreeItemTitle(item), detail: item.detail || worktreeReasonDetail(groupKey), item });
	}
	for (const result of worktreeInventoryCleanup?.results ?? []) {
		if (result.status !== "failed" && result.status !== "skipped" && result.status !== "already-cleaned") continue;
		const groupKey = result.status === "failed" ? "cleanup-failed" : (result.reason || result.status);
		add({
			key: result.itemId || result.id || `${groupKey}:${result.path || "unknown"}`,
			groupKey,
			label: result.path || result.itemId || result.id || "Cleanup result",
			detail: result.error || result.detail || result.reason || worktreeReasonDetail(groupKey),
			status: result.status === "already-cleaned" ? "already-cleaned" : result.status === "failed" ? "failed" : "skipped",
			path: result.path,
			branch: result.branch,
			repo: result.repo,
		});
	}
	const order = (key: string): number => {
		if (/referenced|protected|branch-referenced|primary-worktree/.test(key)) return 1;
		if (key === "pool-entry" || /pool/.test(key)) return 2;
		if (/filesystem|missing|sandbox|needs-attention|metadata/.test(key)) return 3;
		if (key === "already-cleaned") return 4;
		if (/scan-error|cleanup-failed|failed|error/.test(key)) return 5;
		return 6;
	};
	return Array.from(buckets.entries()).map(([key, examples]) => ({
		key,
		label: worktreeReasonLabel(key),
		detail: worktreeReasonDetail(key),
		count: examples.length,
		examples,
	})).sort((a, b) => order(a.key) - order(b.key) || a.label.localeCompare(b.label));
}

function renderWorktreeDiagnosticExample(example: WorktreeDiagnosticExample) {
	if (example.item) return renderWorktreeCleanupRow(example.item, { selectable: false });
	const disposition = example.status === "failed" ? "failed" : example.status === "already-cleaned" ? "already-cleaned" : "needs-attention";
	return html`
		<div
			class="rounded border border-border bg-background/70 p-2 text-xs"
			data-testid="worktree-cleanup-row"
			data-worktree-id=${example.key}
			data-disposition=${disposition}
			data-classification="cleanup-result"
			data-reason=${example.groupKey}
		>
			<div class="flex flex-wrap items-center gap-1.5">
				<span class="text-[10px] px-1.5 py-0.5 rounded ${worktreeStatusClass(disposition)}">${example.status === "already-cleaned" ? "Already cleaned" : example.status === "failed" ? "Cleanup failed" : "Needs attention"}</span>
				<span class="font-medium text-foreground">${example.label}</span>
			</div>
			<div class="mt-1 text-muted-foreground">${example.detail}</div>
			<div class="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1 font-mono text-muted-foreground">
				${example.repo ? html`<div class="break-all">repo: ${example.repo}</div>` : ""}
				${example.branch ? html`<div class="break-all">branch: ${example.branch}</div>` : ""}
				${example.path ? html`<div class="sm:col-span-2 break-all">worktree: ${example.path}</div>` : ""}
			</div>
		</div>
	`;
}

function renderWorktreeTroubleshooting() {
	const groups = worktreeDiagnosticsByGroup();
	if (groups.length === 0) return html``;
	return html`
		<div id="worktree-cleanup-troubleshooting-panel" tabindex="-1" class="flex flex-col gap-2 rounded-md border border-border bg-secondary/20 p-3" data-testid="worktree-cleanup-troubleshooting">
			<p class="text-xs text-muted-foreground">These records are not cleanup actions. They are shown for troubleshooting and audit only.</p>
			${groups.map(group => {
				const id = sanitizeWorktreeGroupId(group.key);
				const expanded = worktreeInventoryExpandedGroups.has(id);
				const visible = expanded ? group.examples : group.examples.slice(0, 5);
				return html`
					<section
						id="worktree-cleanup-group-${id}"
						tabindex="-1"
						class="flex flex-col gap-1 rounded-md border border-border bg-background/60 p-2"
						data-testid="worktree-cleanup-group-${id}"
						data-reason=${group.key}
					>
						<div class="flex flex-wrap items-start justify-between gap-2">
							<div>
								<h4 class="text-xs font-semibold text-foreground">${group.label} (${group.count})</h4>
								<p class="text-[11px] text-muted-foreground">${group.detail}</p>
							</div>
							${group.examples.length > 5 ? html`
								<button
									type="button"
									class="px-2 py-1 text-[11px] rounded-md border border-input bg-background text-foreground hover:bg-secondary transition-colors"
									data-testid="worktree-cleanup-show-all-${id}"
									data-action="show-all-worktree-cleanup-examples"
									data-reason=${group.key}
									@click=${() => {
										if (expanded) worktreeInventoryExpandedGroups.delete(id);
										else worktreeInventoryExpandedGroups.add(id);
										renderApp();
									}}
								>${expanded ? "Show first 5" : `Show all (${group.examples.length})`}</button>
							` : ""}
						</div>
						<div class="flex flex-col gap-1 mt-1">
							${visible.map(renderWorktreeDiagnosticExample)}
						</div>
					</section>
				`;
			})}
		</div>
	`;
}

function renderWorktreeCleanupResult() {
	const cleanup = worktreeInventoryCleanup;
	if (!cleanup) return html``;
	const attention = cleanup.counts.failed + cleanup.counts.skipped;
	return html`
		<div class="rounded-md bg-secondary/30 border border-border p-2 text-xs text-muted-foreground mt-1" data-testid="worktree-cleanup-result" aria-live=${attention > 0 ? "assertive" : "polite"}>
			<div class="text-foreground font-medium">${attention > 0 ? "Cleanup finished with attention needed" : "Cleanup complete"}</div>
			<div>
				Cleaned: ${cleanup.counts.cleaned}, branches deleted: ${cleanup.counts.branchDeleted}, skipped: ${cleanup.counts.skipped}, already cleaned: ${cleanup.counts.alreadyCleaned}, failed: ${cleanup.counts.failed}.
			</div>
			${attention > 0 ? html`<div class="mt-1 text-muted-foreground">Open diagnostics to inspect skipped or failed cleanup examples.</div>` : ""}
		</div>
	`;
}

function renderWorktreeCleanupMaintenance(scanBtnClass: string, actionBtnClass: string) {
	const actionableRows = worktreeInventoryActionableRows();
	const counts = worktreeInventoryReport?.counts ?? emptyWorktreeMaintenanceCounts();
	const selectedCount = selectedWorktreeInventoryItemIds().length;
	const hasScan = !!worktreeInventoryReport;
	const loading = maintenanceLoading === "worktreeInventory";
	const currentProjectRows = state.activeProjectId ? actionableRows.filter(item => item.projectId === state.activeProjectId) : [];
	const archivedOwnedRows = actionableRows.filter(item => item.classification === "archived-owned" || item.sources.includes("archived-session"));
	const gitOrphanRows = actionableRows.filter(item => item.classification === "unowned-git-worktree");
	const diagnosticsGroups = worktreeDiagnosticsByGroup();
	const cleanupHelper = !hasScan
		? "Scan first to find safe cleanup candidates."
		: counts.readyToClean === 0
			? "Cleanup is disabled because there are 0 safe candidates."
			: selectedCount === 0
				? "Select at least one safe candidate. Bobbit will rescan before deleting anything."
				: "Bobbit will rescan before deleting and remove only server-classified safe candidates; records and transcripts are preserved.";
	const scanLabel = loading && !hasScan ? "Scanning..." : hasScan ? "Rescan" : "Scan";
	const scannedProjects = worktreeInventoryReport?.scanned?.projects ?? worktreeInventoryReport?.projectCount;
	const scannedRepos = worktreeInventoryReport?.scanned?.repos ?? worktreeInventoryReport?.repoCount;
	const scannedRoots = worktreeInventoryReport?.scanned?.worktreeRoots ?? worktreeInventoryReport?.worktreeRootCount;
	const metadataParts = [
		scannedProjects !== undefined ? `${scannedProjects} projects` : "known projects",
		scannedRepos !== undefined ? `${scannedRepos} repos` : "component repos",
		scannedRoots !== undefined ? `${scannedRoots} worktree-root directories` : "worktree-root directories",
	];
	return html`
		<div class="flex flex-col gap-2 rounded-md border border-border p-4" data-section="worktree-cleanup" data-testid="worktree-cleanup-maintenance" role="region" aria-labelledby="worktree-cleanup-title">
			<div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
				<div>
					<h3 id="worktree-cleanup-title" class="text-sm font-semibold text-foreground" data-testid="worktree-cleanup-title">Worktree Cleanup</h3>
					<p class="text-xs text-muted-foreground">
						Reclaim safe Bobbit worktrees from archived sessions, orphaned Git metadata, and known worktree roots while surfacing pool entries and protected paths for troubleshooting.
					</p>
				</div>
				<div class="flex flex-wrap items-center gap-2">
					<button
						class="${scanBtnClass}"
						?disabled=${loading}
						@click=${() => scanWorktreeInventory()}
						data-testid="worktree-cleanup-scan"
						data-action="scan-worktrees"
					>${scanLabel}</button>
					<button
						class="${actionBtnClass}"
						?disabled=${loading || !hasScan || counts.readyToClean === 0}
						@click=${() => cleanupWorktreeInventory("all-safe")}
						data-testid="worktree-cleanup-clean-all"
						data-action="cleanup-all-worktrees"
					>${loading && hasScan ? "Cleaning..." : `Clean all safe candidates${counts.readyToClean > 0 ? ` (${counts.readyToClean})` : ""}`}</button>
				</div>
			</div>

			<div aria-live="polite" class="flex flex-col gap-2">
				${hasScan ? html`
					<div class="grid grid-cols-2 lg:grid-cols-5 gap-2 mt-1" aria-controls="worktree-cleanup-actionable-list worktree-cleanup-troubleshooting-panel">
						${renderWorktreeSummaryChip("Ready to clean", counts.readyToClean, "worktree-cleanup-summary-ready", counts.readyToClean > 0 ? () => focusWorktreeCleanupElement("worktree-cleanup-actionable-list") : undefined)}
						${renderWorktreeSummaryChip("Selected", selectedCount, "worktree-cleanup-summary-selected")}
						${renderWorktreeSummaryChip("Protected/in use", counts.protectedInUse, "worktree-cleanup-summary-protected", counts.protectedInUse > 0 ? () => showWorktreeDiagnosticsAndFocus(diagnosticsGroups.find(group => /referenced|protected|branch-referenced|primary-worktree/.test(group.key))?.key) : undefined)}
						${renderWorktreeSummaryChip("Already cleaned", counts.alreadyCleaned, "worktree-cleanup-summary-already-cleaned", counts.alreadyCleaned > 0 ? () => showWorktreeDiagnosticsAndFocus("already-cleaned") : undefined)}
						${renderWorktreeSummaryChip("Needs attention", counts.needsAttention, "worktree-cleanup-summary-needs-attention", counts.needsAttention > 0 ? () => showWorktreeDiagnosticsAndFocus(diagnosticsGroups.find(group => !/referenced|protected|already-cleaned/.test(group.key))?.key) : undefined)}
					</div>
					<p class="text-[11px] text-muted-foreground" data-testid="worktree-cleanup-metadata-count">
						Scanned ${metadataParts.join(", ")}. Last scanned ${formatTimestamp(worktreeInventoryReport?.generatedAt ?? null)}. Pool entries: ${counts.poolEntries}. Default selected: ${counts.defaultSelected}.
					</p>
				` : ""}

				${renderWorktreeCleanupResult()}

				${worktreeInventoryError ? html`
					<p class="text-xs text-destructive mt-1" data-testid="worktree-cleanup-error" aria-live="assertive">${worktreeInventoryError}</p>
				` : ""}

				<p class="text-xs text-muted-foreground" data-testid="worktree-cleanup-helper">${cleanupHelper}</p>

				${hasScan && counts.readyToClean === 0 ? html`
					<div class="rounded-md border border-border bg-secondary/20 p-3 text-xs" data-testid="worktree-cleanup-empty-state">
						<h4 class="text-sm font-semibold text-foreground">${counts.total === counts.alreadyCleaned && counts.total > 0 ? "Worktree inventory is clean" : "Nothing safe to clean right now"}</h4>
						<p class="mt-1 text-muted-foreground">Bobbit scanned known sessions, archives, goals, teams, delegates, staff, pool entries, Git worktree metadata, and worktree-root directories. No server-classified safe worktree cleanup candidates were found.</p>
					</div>
				` : ""}

				${hasScan && counts.readyToClean > 0 ? html`
					<div id="worktree-cleanup-actionable-list" tabindex="-1" class="flex flex-col gap-2 mt-1" data-testid="worktree-cleanup-actionable-list">
						<div class="flex flex-wrap items-center gap-2">
							<button type="button" class="px-2 py-1 text-xs rounded-md border border-input bg-background text-foreground hover:bg-secondary transition-colors" data-testid="worktree-cleanup-select-all-safe" data-action="select-all-safe-worktrees" @click=${() => setWorktreeInventorySelection(actionableRows)}>Select all safe (${actionableRows.length})</button>
							<button type="button" class="px-2 py-1 text-xs rounded-md border border-input bg-background text-foreground hover:bg-secondary transition-colors disabled:opacity-50" ?disabled=${currentProjectRows.length === 0} data-testid="worktree-cleanup-select-current-project" data-action="select-current-project-worktrees" @click=${() => setWorktreeInventorySelection(currentProjectRows)}>Current project (${currentProjectRows.length})</button>
							<button type="button" class="px-2 py-1 text-xs rounded-md border border-input bg-background text-foreground hover:bg-secondary transition-colors disabled:opacity-50" ?disabled=${archivedOwnedRows.length === 0} data-testid="worktree-cleanup-select-archived-owned" data-action="select-archived-owned-worktrees" @click=${() => setWorktreeInventorySelection(archivedOwnedRows)}>Archived-owned (${archivedOwnedRows.length})</button>
							<button type="button" class="px-2 py-1 text-xs rounded-md border border-input bg-background text-foreground hover:bg-secondary transition-colors disabled:opacity-50" ?disabled=${gitOrphanRows.length === 0} data-testid="worktree-cleanup-select-git-orphan" data-action="select-git-orphan-worktrees" @click=${() => setWorktreeInventorySelection(gitOrphanRows)}>Git orphan (${gitOrphanRows.length})</button>
							<button type="button" class="px-2 py-1 text-xs rounded-md border border-input bg-background text-foreground hover:bg-secondary transition-colors disabled:opacity-50" ?disabled=${selectedCount === 0} data-testid="worktree-cleanup-clear-selection" data-action="clear-worktree-cleanup-selection" @click=${() => setWorktreeInventorySelection([])}>Clear selection</button>
						</div>
						<div class="flex flex-col gap-1 max-h-96 overflow-y-auto">
							${actionableRows.map(item => renderWorktreeCleanupRow(item, { selectable: true }))}
						</div>
						<div class="flex items-center gap-2">
							<button
								class="${actionBtnClass}"
								?disabled=${loading || selectedCount === 0}
								@click=${() => cleanupWorktreeInventory("selected")}
								data-testid="worktree-cleanup-clean-selected"
								data-action="cleanup-selected-worktrees"
							>${loading ? "Cleaning..." : `Clean selected (${selectedCount})`}</button>
							<span class="text-xs text-muted-foreground">${selectedCount} selected</span>
						</div>
					</div>
				` : html`
					<button
						type="button"
						class="self-start px-2 py-1 text-xs rounded-md border border-input bg-background text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
						data-testid="worktree-cleanup-clean-selected"
						data-action="cleanup-selected-worktrees"
						?disabled=${true}
					>Clean selected${hasScan ? " (0)" : ""}</button>
				`}

				${hasScan && diagnosticsGroups.length > 0 ? html`
					<div class="flex flex-col gap-2 mt-1">
						<button
							type="button"
							class="self-start px-2 py-1 text-xs rounded-md border border-input bg-background text-foreground hover:bg-secondary transition-colors"
							aria-expanded=${worktreeInventoryShowDiagnostics ? "true" : "false"}
							aria-controls="worktree-cleanup-troubleshooting-panel"
							data-testid="worktree-cleanup-show-diagnostics"
							@click=${() => { worktreeInventoryShowDiagnostics = !worktreeInventoryShowDiagnostics; renderApp(); }}
						>${worktreeInventoryShowDiagnostics ? "Hide diagnostics" : counts.readyToClean === 0 ? "Show why not removable" : "Show protected, already cleaned, and needs-attention diagnostics"}</button>
						${worktreeInventoryShowDiagnostics ? renderWorktreeTroubleshooting() : ""}
					</div>
				` : ""}
			</div>
		</div>
	`;
}

async function scanSessions(): Promise<void> {
	maintenanceLoading = "sessions";
	renderApp();
	try {
		const res = await gatewayFetch("/api/maintenance/orphaned-sessions");
		if (res.ok) {
			const data = await res.json();
			maintenanceSessions = data.sessions ?? [];
		} else {
			maintenanceSessions = [];
		}
	} catch {
		maintenanceSessions = [];
	}
	maintenanceLoading = null;
	renderApp();
}

async function cleanupSessions(): Promise<void> {
	maintenanceLoading = "sessions";
	renderApp();
	try {
		await gatewayFetch("/api/maintenance/cleanup-sessions", { method: "POST" });
	} catch { /* ignore */ }
	maintenanceLoading = null;
	await scanSessions();
}

async function scanArchives(): Promise<void> {
	maintenanceLoading = "archives";
	renderApp();
	try {
		const res = await gatewayFetch("/api/maintenance/expired-archives");
		if (res.ok) {
			maintenanceArchives = await res.json();
		} else {
			maintenanceArchives = { count: 0, totalSizeBytes: 0 };
		}
	} catch {
		maintenanceArchives = { count: 0, totalSizeBytes: 0 };
	}
	maintenanceLoading = null;
	renderApp();
}

async function purgeArchives(): Promise<void> {
	maintenanceLoading = "archives";
	renderApp();
	try {
		await gatewayFetch("/api/maintenance/purge-archives", { method: "POST" });
	} catch { /* ignore */ }
	maintenanceLoading = null;
	await scanArchives();
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		const s = stringField(value);
		if (s) return s;
	}
	return undefined;
}

function parseAgentDirState(data: any): AgentDirDisplayState {
	const source = data?.state ?? data?.agentDir ?? data;
	const activePath = firstString(source?.activePath, source?.activeDir, source?.active?.dir, source?.startup?.dir) ?? "";
	const startupSource = firstString(source?.startupSource, source?.activeSource, source?.active?.source, source?.startup?.source) ?? "unknown";
	const defaultPath = firstString(source?.defaultPath, source?.defaultDir, source?.startup?.defaultDir, source?.nextStart?.defaultDir) ?? "";
	const persistedPath = firstString(source?.persistedPath, source?.persisted, source?.pendingPersistedPath) ?? null;
	const pendingPath = firstString(source?.pendingPath, source?.pendingDir, source?.pending?.dir, source?.pending) ?? persistedPath;
	const nextStartPath = firstString(source?.nextStartPath, source?.nextStartDir, source?.nextStart?.dir, source?.effectiveNextStartPath, pendingPath, activePath) ?? "";
	const nextStartSource = firstString(source?.nextStartSource, source?.nextStart?.source, source?.effectiveNextStartSource) ?? startupSource;
	const envOverride = (() => {
		const raw = source?.envOverride;
		if (raw === true) return startupSource === "BOBBIT_AGENT_DIR" ? startupSource : "environment variable";
		if (!raw) return startupSource === "BOBBIT_AGENT_DIR" ? startupSource : null;
		if (typeof raw === "string") return raw;
		return firstString(raw.name, raw.source, raw.key, raw.variable) ?? (startupSource === "BOBBIT_AGENT_DIR" ? startupSource : null);
	})();
	return {
		activePath,
		startupSource,
		defaultPath,
		persistedPath,
		pendingPath,
		nextStartPath,
		nextStartSource,
		restartRequired: source?.restartRequired === true,
		envOverride,
		history: Array.isArray(source?.history) ? source.history.filter((x: unknown): x is string => typeof x === "string") : [],
		guidance: firstString(source?.guidance, source?.restartGuidance, source?.message, data?.guidance, data?.restartGuidance, data?.message),
	};
}

function agentDirInputFromState(s: AgentDirDisplayState): string {
	return s.persistedPath ?? s.pendingPath ?? "";
}

function samePathForDisplay(a: string | null | undefined, b: string | null | undefined): boolean {
	if (!a || !b) return false;
	return a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
}

function agentDirMigrationDestination(s: AgentDirDisplayState): string {
	return s.pendingPath || s.persistedPath || s.nextStartPath;
}

function loadAgentDirState(force = false): void {
	if ((agentDirLoaded && !force) || agentDirLoading) return;
	agentDirLoading = true;
	agentDirError = "";
	(async () => {
		try {
			const res = await gatewayFetch("/api/agent-dir");
			if (!res.ok) throw new Error(`Failed to load agent directory settings (HTTP ${res.status})`);
			agentDirState = parseAgentDirState(await res.json());
			agentDirLoaded = true;
			agentDirInput = agentDirInputFromState(agentDirState);
		} catch (err) {
			agentDirError = (err as Error).message || "Failed to load agent directory settings";
		} finally {
			agentDirLoading = false;
			renderApp();
		}
	})();
}

function resetAgentDirFlowState(): void {
	agentDirValidation = null;
	agentDirSaveMessage = "";
	agentDirSaveIsError = false;
	agentDirMigrationReport = null;
	agentDirMigrationError = "";
}

async function validateAgentDirInput(): Promise<void> {
	const path = agentDirInput.trim();
	if (!path) return;
	agentDirValidation = null;
	agentDirSaving = true;
	agentDirSaveMessage = "";
	renderApp();
	try {
		const res = await gatewayFetch("/api/agent-dir/validate", {
			method: "POST",
			body: JSON.stringify({ path }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok || data?.ok === false) {
			agentDirValidation = {
				ok: false,
				resolvedPath: firstString(data?.resolvedPath, data?.error?.resolvedPath),
				code: firstString(data?.error?.code, data?.code),
				message: firstString(data?.error?.message, data?.message) ?? `Validation failed (HTTP ${res.status})`,
			};
		} else {
			agentDirValidation = {
				ok: true,
				resolvedPath: firstString(data?.resolvedPath, data?.path) ?? path,
				message: "Directory is valid and writable.",
			};
		}
	} catch (err) {
		agentDirValidation = { ok: false, message: (err as Error).message || "Validation failed" };
	} finally {
		agentDirSaving = false;
		renderApp();
	}
}

async function saveAgentDirPending(path: string | null): Promise<void> {
	agentDirSaving = true;
	agentDirSaveMessage = "";
	agentDirSaveIsError = false;
	agentDirValidation = null;
	agentDirMigrationReport = null;
	agentDirMigrationError = "";
	renderApp();
	try {
		const res = await gatewayFetch("/api/agent-dir/pending", {
			method: "PUT",
			body: JSON.stringify({ path }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(firstString(data?.error?.message, data?.message) ?? `Save failed (HTTP ${res.status})`);
		agentDirState = parseAgentDirState(data);
		agentDirLoaded = true;
		agentDirInput = agentDirInputFromState(agentDirState);
		agentDirSaveMessage = agentDirState.guidance || "Saved for the next server start.";
	} catch (err) {
		agentDirSaveIsError = true;
		agentDirSaveMessage = (err as Error).message || "Save failed";
	} finally {
		agentDirSaving = false;
		renderApp();
	}
}

async function saveAgentDirInput(): Promise<void> {
	await saveAgentDirPending(agentDirInput.trim() || null);
}

async function clearAgentDirPending(): Promise<void> {
	agentDirInput = "";
	await saveAgentDirPending(null);
}

function reportCount(value: unknown): number {
	if (Array.isArray(value)) return value.length;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return 0;
}

async function migrateAgentDirData(): Promise<void> {
	if (!agentDirState) return;
	const destinationPath = agentDirMigrationDestination(agentDirState);
	if (!destinationPath || samePathForDisplay(agentDirState.activePath, destinationPath)) return;
	agentDirMigrating = true;
	agentDirMigrationReport = null;
	agentDirMigrationError = "";
	renderApp();
	try {
		const res = await gatewayFetch("/api/agent-dir/migrate", {
			method: "POST",
			body: JSON.stringify({
				sourcePath: agentDirState.activePath,
				destinationPath,
				overwrite: agentDirMigrateOverwrite,
			}),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(firstString(data?.error?.message, data?.message) ?? `Migration failed (HTTP ${res.status})`);
		agentDirMigrationReport = (data?.report && typeof data.report === "object" ? data.report : data) as AgentDirMigrationReport;
	} catch (err) {
		agentDirMigrationError = (err as Error).message || "Migration failed";
	} finally {
		agentDirMigrating = false;
		renderApp();
	}
}

function renderAgentDirPathRow(label: string, value: string | null | undefined, testId: string, badge?: string) {
	return html`
		<div class="flex flex-col gap-0.5 min-w-0">
			<div class="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
				<span>${label}</span>
				${badge ? html`<span class="normal-case tracking-normal px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground">${badge}</span>` : ""}
			</div>
			<code class="text-xs text-foreground font-mono break-all" data-testid=${testId}>${value || "—"}</code>
		</div>
	`;
}

function renderAgentDirMigrationReport(report: AgentDirMigrationReport) {
	const counts = [
		["Copied", reportCount(report.copied), "agent-dir-migrate-copied"],
		["Skipped", reportCount(report.skipped), "agent-dir-migrate-skipped"],
		["Overwritten", reportCount(report.overwritten), "agent-dir-migrate-overwritten"],
		["Missing", reportCount(report.missing), "agent-dir-migrate-missing"],
		["Warnings", reportCount(report.warnings), "agent-dir-migrate-warnings"],
		["Errors", reportCount(report.errors), "agent-dir-migrate-errors"],
	] as const;
	return html`
		<div class="rounded-md bg-secondary/30 border border-border p-2 text-xs text-muted-foreground" data-testid="agent-dir-migration-report">
			<div class="flex flex-wrap gap-1.5">
				${counts.map(([label, count, testId]) => html`
					<span class="px-1.5 py-0.5 rounded bg-background border border-border" data-testid=${testId}>${label}: <span class="text-foreground font-medium">${count}</span></span>
				`)}
			</div>
			${Array.isArray(report.warnings) && report.warnings.length > 0 ? html`
				<div class="mt-2 flex flex-col gap-1">
					${report.warnings.map((warning) => html`<div class="text-amber-600 dark:text-amber-300 break-all">${warning}</div>`)}
				</div>
			` : ""}
			${Array.isArray(report.errors) && report.errors.length > 0 ? html`
				<div class="mt-2 flex flex-col gap-1">
					${report.errors.map((error) => html`<div class="text-destructive break-all">${error}</div>`)}
				</div>
			` : ""}
		</div>
	`;
}

function renderAgentDirSettingsCard(scanBtnClass: string, actionBtnClass: string) {
	loadAgentDirState();
	const s = agentDirState;
	const destinationPath = s ? agentDirMigrationDestination(s) : "";
	const showMigration = !!s && !!destinationPath && !samePathForDisplay(s.activePath, destinationPath);
	const envMessage = s?.envOverride
		? `${s.envOverride} is active. Saved paths remain pending until that environment override is removed and the server is restarted.`
		: "No environment override is active; saved settings determine the next server start before the default path.";
	const restartGuidance = s
		? `Active now: ${s.activePath || "unknown"}. After restart: ${s.nextStartPath || "unknown"}.`
		: "";

	return html`
		<div class="flex flex-col gap-3 rounded-md border border-border p-4" data-section="agent-dir" data-testid="agent-dir-settings">
			<div class="flex items-start justify-between gap-3">
				<div>
					<h3 class="text-sm font-semibold text-foreground">Agent Directory</h3>
					<p class="text-xs text-muted-foreground mt-1">
						Stores agent sessions, provider caches, model metadata, and staged agent binaries. Changes apply on the next server start; current sessions keep using the active directory.
					</p>
				</div>
				<button
					class="${scanBtnClass} shrink-0"
					?disabled=${agentDirLoading}
					@click=${() => loadAgentDirState(true)}
					data-testid="agent-dir-refresh"
				>${agentDirLoading ? "Refreshing…" : "Refresh"}</button>
			</div>

			${agentDirError ? html`<p class="text-xs text-destructive" data-testid="agent-dir-load-error">${agentDirError}</p>` : ""}
			${!s && agentDirLoading ? html`<p class="text-xs text-muted-foreground italic">Loading agent directory settings…</p>` : ""}
			${s ? html`
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
					${renderAgentDirPathRow("Active directory", s.activePath, "agent-dir-active")}
					${renderAgentDirPathRow("Startup source", s.startupSource, "agent-dir-startup-source")}
					${renderAgentDirPathRow("Default", s.defaultPath, "agent-dir-default")}
					${renderAgentDirPathRow("Persisted / pending", s.pendingPath || s.persistedPath, "agent-dir-persisted")}
					${renderAgentDirPathRow("Effective after restart", s.nextStartPath, "agent-dir-next-start", s.nextStartSource)}
				</div>

				<div class="rounded-md border ${s.restartRequired ? "border-amber-500/30 bg-amber-500/10" : "border-border bg-secondary/20"} p-3 text-xs" data-testid="agent-dir-restart-guidance">
					<div class="font-medium ${s.restartRequired ? "text-amber-700 dark:text-amber-300" : "text-foreground"}">
						${s.restartRequired ? "Restart required" : "No restart required"}
					</div>
					<div class="mt-1 text-muted-foreground break-all">${s.guidance || restartGuidance}</div>
					<div class="mt-1 text-muted-foreground" data-testid="agent-dir-env-override">${envMessage}</div>
				</div>

				<div class="flex flex-col gap-2">
					<label class="text-sm font-medium text-foreground" for="agent-dir-path-input">Directory for next server start</label>
					<p class="text-xs text-muted-foreground">
						Leave empty and save to clear the persisted setting and use environment/default precedence. Relative paths are resolved by the server against the project root.
					</p>
					<div class="flex flex-col sm:flex-row gap-2">
						<input
							id="agent-dir-path-input"
							type="text"
							placeholder=${s.defaultPath ? `Use default: ${s.defaultPath}` : "Use default"}
							class="flex-1 min-w-0 px-2 py-1.5 rounded-md border border-input bg-background text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
							.value=${live(agentDirInput)}
							@input=${(e: Event) => { agentDirInput = (e.target as HTMLInputElement).value; resetAgentDirFlowState(); renderApp(); }}
							@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); void saveAgentDirInput(); } }}
							data-testid="agent-dir-path-input"
						/>
						<div class="flex items-center gap-2 shrink-0">
							<button class="${scanBtnClass}" ?disabled=${agentDirSaving || !agentDirInput.trim()} @click=${validateAgentDirInput} data-testid="agent-dir-validate">Validate</button>
							<button class="${actionBtnClass}" ?disabled=${agentDirSaving} @click=${saveAgentDirInput} data-testid="agent-dir-save">${agentDirSaving ? "Saving…" : "Save for next restart"}</button>
						</div>
					</div>
					<div>
						<button
							class="text-xs text-muted-foreground hover:text-foreground underline disabled:opacity-50"
							?disabled=${agentDirSaving || (!s.persistedPath && !agentDirInput.trim())}
							@click=${clearAgentDirPending}
							data-testid="agent-dir-clear-default"
						>Clear to default/env precedence</button>
					</div>
					${agentDirValidation ? html`
						<p class="text-xs ${agentDirValidation.ok ? "text-emerald-600 dark:text-emerald-300" : "text-destructive"}" data-testid="agent-dir-validation-result">
							${agentDirValidation.ok ? "Valid" : "Invalid"}${agentDirValidation.code ? ` (${agentDirValidation.code})` : ""}: ${agentDirValidation.message || ""}${agentDirValidation.resolvedPath ? ` Resolved: ${agentDirValidation.resolvedPath}` : ""}
						</p>
					` : ""}
					${agentDirSaveMessage ? html`
						<p class="text-xs ${agentDirSaveIsError ? "text-destructive" : "text-muted-foreground"}" data-testid="agent-dir-save-message">${agentDirSaveMessage}</p>
					` : ""}
				</div>

				${showMigration ? html`
					<div class="flex flex-col gap-3 rounded-md border border-border bg-secondary/20 p-3" data-testid="agent-dir-migration-card">
						<div>
							<h4 class="text-sm font-semibold text-foreground">Copy data to pending directory</h4>
							<p class="text-xs text-muted-foreground mt-1">
								Copies selected agent data from the active directory to the pending directory. The source directory is preserved.
							</p>
						</div>
						<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
							${renderAgentDirPathRow("Source active", s.activePath, "agent-dir-migrate-source")}
							${renderAgentDirPathRow("Destination pending", destinationPath, "agent-dir-migrate-destination")}
						</div>
						<div class="text-xs text-muted-foreground">
							<div class="font-medium text-foreground mb-1">Copy allowlist</div>
							<div class="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1" data-testid="agent-dir-migration-allowlist">
								${["sessions/", "auth.json", "models.json", "settings.json", "google-code-assist.json", "bin/"].map(item => html`
									<div class="flex items-center gap-1.5"><span class="text-emerald-600 dark:text-emerald-300">✓</span><code>${item}</code></div>
								`)}
							</div>
						</div>
						<label class="flex items-start gap-2 text-xs text-muted-foreground">
							<input
								type="checkbox"
								class="mt-0.5 w-4 h-4 rounded border-input accent-primary"
								.checked=${agentDirMigrateOverwrite}
								@change=${(e: Event) => { agentDirMigrateOverwrite = (e.target as HTMLInputElement).checked; renderApp(); }}
								data-testid="agent-dir-migrate-overwrite"
							/>
							<span><span class="font-medium text-foreground">Overwrite existing destination files</span><br />Default is skip existing files.</span>
						</label>
						<div class="flex items-center gap-2">
							<button class="${actionBtnClass}" ?disabled=${agentDirMigrating} @click=${migrateAgentDirData} data-testid="agent-dir-migrate-start">${agentDirMigrating ? "Copying…" : "Copy data"}</button>
							<span class="text-xs text-muted-foreground">Restart after saving/migrating to use the next-start directory.</span>
						</div>
						${agentDirMigrationReport ? renderAgentDirMigrationReport(agentDirMigrationReport) : ""}
						${agentDirMigrationError ? html`<p class="text-xs text-destructive" data-testid="agent-dir-migration-error">${agentDirMigrationError}</p>` : ""}
					</div>
				` : ""}
			` : ""}
		</div>
	`;
}

function renderMaintenanceTab() {
	const scanBtnClass = "px-3 py-1.5 text-sm rounded-md border border-input bg-background text-foreground hover:bg-secondary transition-colors disabled:opacity-50";
	const actionBtnClass = "px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50";

	ensureSearchIndexWsSubscribed();
	if (!searchIndexStatsLoaded && maintenanceLoading !== "search") {
		void loadSearchStats();
	}

	const progressPct = (() => {
		if (!searchIndexProgress) return null;
		const { completed, total } = searchIndexProgress;
		if (total <= 0) return 0; // indeterminate
		return Math.min(100, Math.round((completed / total) * 100));
	})();
	return html`
		<div class="flex flex-col gap-6">
			<p class="text-sm text-muted-foreground">
				Review and clean up orphaned resources. No cleanup happens automatically on server restart — use these tools to manage resources manually.
			</p>

			${renderAgentDirSettingsCard(scanBtnClass, actionBtnClass)}

			<!-- Search Index -->
			<div class="flex flex-col gap-2 rounded-md border border-border p-4" data-section="search-index">
				<div class="flex items-center gap-2">
					<h3 class="text-sm font-semibold text-foreground">Search Index</h3>
					<search-status-dot></search-status-dot>
				</div>
				<p class="text-xs text-muted-foreground">
					Semantic + lexical search over goals, sessions, messages, and staff. Rebuild after upgrading or if results look stale.
				</p>
				${searchIndexStats ? html`
					<div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 mt-1 text-xs">
						<div class="flex justify-between gap-2"><span class="text-muted-foreground">State</span><span class="text-foreground font-medium" data-search-state="${searchIndexStats.state}">${searchIndexStats.state}</span></div>
						<div class="flex justify-between gap-2"><span class="text-muted-foreground">Last rebuild</span><span class="text-foreground">${formatTimestamp(searchIndexStats.lastRebuildAt)}</span></div>
						<div class="flex justify-between gap-2"><span class="text-muted-foreground">Engine</span><span class="text-foreground font-mono truncate" title="${searchIndexStats.engine}">${searchIndexStats.engine} (${searchIndexStats.engineVersion})</span></div>
						<div class="flex justify-between gap-2"><span class="text-muted-foreground">Dataset size</span><span class="text-foreground">${formatBytes(searchIndexStats.datasetBytes)}</span></div>
					</div>
					${Object.keys(searchIndexStats.rowCountsBySource || {}).length > 0 ? html`
						<div class="flex flex-wrap gap-1.5 mt-1">
							${Object.entries(searchIndexStats.rowCountsBySource).map(([src, n]) => html`
								<span class="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground font-mono">${src}: ${n}</span>
							`)}
						</div>
					` : ""}
				` : searchIndexStatsLoaded ? html`
					<p class="text-xs text-muted-foreground italic mt-1">Stats unavailable.</p>
				` : html`
					<p class="text-xs text-muted-foreground italic mt-1">Loading stats…</p>
				`}
				${searchIndexProgress ? html`
					<div class="mt-2" data-search-progress>
						<div class="flex items-center justify-between text-[11px] text-muted-foreground mb-1">
							<span>Rebuilding…</span>
							<span>${searchIndexProgress.total > 0 ? `${searchIndexProgress.completed} / ${searchIndexProgress.total}` : `${searchIndexProgress.completed} items`}</span>
						</div>
						<div class="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
							${progressPct === 0 ? html`
								<div class="h-full w-1/3 bg-amber-500 animate-pulse"></div>
							` : html`
								<div class="h-full bg-amber-500 transition-all" style="width: ${progressPct}%"></div>
							`}
						</div>
					</div>
				` : ""}
				${searchIndexError ? html`
					<p class="text-xs text-destructive mt-1" data-search-error>${searchIndexError}</p>
				` : ""}
				<div class="flex items-center gap-2 mt-2">
					<button
						class="${scanBtnClass}"
						?disabled=${maintenanceLoading === "search"}
						@click=${loadSearchStats}
						data-action="refresh-search-stats"
					>Refresh</button>
					<button
						class="${actionBtnClass}"
						?disabled=${maintenanceLoading === "search" || !!searchIndexProgress}
						@click=${rebuildSearchIndex}
						data-action="rebuild-search-index"
					>Rebuild Index</button>
				</div>
			</div>

			<!-- Worktree Cleanup -->
			${renderWorktreeCleanupMaintenance(scanBtnClass, actionBtnClass)}

			<!-- Orphaned Sessions -->
			<div class="flex flex-col gap-2 rounded-md border border-border p-4">
				<h3 class="text-sm font-semibold text-foreground">Orphaned Sessions</h3>
				<p class="text-xs text-muted-foreground">
					Non-interactive sessions (e.g. verification reviewers) with no tracking.
				</p>
				${maintenanceSessions !== null && maintenanceSessions.length > 0 ? html`
					<div class="flex flex-col gap-1 mt-1 max-h-40 overflow-y-auto">
						${maintenanceSessions.map(s => html`
							<div class="flex items-center gap-2 text-xs px-2 py-1 rounded bg-secondary/30">
								<span class="truncate flex-1 text-foreground">${s.title || "Untitled"}</span>
								<span class="text-[10px] font-mono text-muted-foreground shrink-0">${s.id.slice(0, 8)}</span>
							</div>
						`)}
					</div>
				` : maintenanceSessions !== null ? html`
					<p class="text-xs text-muted-foreground italic mt-1">No orphaned sessions found.</p>
				` : ""}
				<div class="flex items-center gap-2 mt-2">
					<button
						class="${scanBtnClass}"
						?disabled=${maintenanceLoading === "sessions"}
						@click=${scanSessions}
					>${maintenanceLoading === "sessions" && maintenanceSessions === null ? "Scanning..." : "Scan"}</button>
					<button
						class="${actionBtnClass}"
						?disabled=${maintenanceLoading === "sessions" || !maintenanceSessions || maintenanceSessions.length === 0}
						@click=${cleanupSessions}
					>${maintenanceLoading === "sessions" && maintenanceSessions !== null ? "Terminating..." : `Terminate${maintenanceSessions && maintenanceSessions.length > 0 ? ` (${maintenanceSessions.length})` : ""}`}</button>
				</div>
			</div>

			<!-- Expired Archives -->
			<div class="flex flex-col gap-2 rounded-md border border-border p-4">
				<h3 class="text-sm font-semibold text-foreground">Expired Archives</h3>
				<p class="text-xs text-muted-foreground">
					Archived sessions past the retention period.
				</p>
				${maintenanceArchives !== null ? html`
					<p class="text-sm text-foreground mt-1">
						${maintenanceArchives.count > 0
							? html`${maintenanceArchives.count} session${maintenanceArchives.count !== 1 ? "s" : ""} (${formatBytes(maintenanceArchives.totalSizeBytes)})`
							: html`<span class="text-muted-foreground italic text-xs">No expired archives found.</span>`}
					</p>
				` : ""}
				<div class="flex items-center gap-2 mt-2">
					<button
						class="${scanBtnClass}"
						?disabled=${maintenanceLoading === "archives"}
						@click=${scanArchives}
					>${maintenanceLoading === "archives" && maintenanceArchives === null ? "Scanning..." : "Scan"}</button>
					<button
						class="${actionBtnClass}"
						?disabled=${maintenanceLoading === "archives" || !maintenanceArchives || maintenanceArchives.count === 0}
						@click=${purgeArchives}
					>${maintenanceLoading === "archives" && maintenanceArchives !== null ? "Purging..." : `Purge${maintenanceArchives && maintenanceArchives.count > 0 ? ` (${maintenanceArchives.count})` : ""}`}</button>
				</div>
			</div>

			<!-- Orphaned Search-Index Rows -->
			<div class="flex flex-col gap-2 rounded-md border border-border p-4" data-section="orphaned-index-rows">
				<h3 class="text-sm font-semibold text-foreground">Orphaned Index Rows</h3>
				<p class="text-xs text-muted-foreground">
					Search-index rows whose source entity (goal, session, staff, or message) no longer exists.
				</p>
				${orphanIndexRows !== null && orphanIndexRows.count > 0 ? html`
					<p class="text-sm text-foreground mt-1">${orphanIndexRows.count} orphaned row${orphanIndexRows.count !== 1 ? "s" : ""}.</p>
					${orphanIndexRows.sample.length > 0 ? html`
						<div class="flex flex-col gap-1 mt-1 max-h-40 overflow-y-auto">
							${orphanIndexRows.sample.map(row => html`
								<div class="flex items-center gap-2 text-xs font-mono text-muted-foreground px-2 py-1 rounded bg-secondary/30">
									<span class="truncate flex-1">${row.id}</span>
									<span class="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground shrink-0">${row.source_id}</span>
								</div>
							`)}
						</div>
					` : ""}
				` : orphanIndexRows !== null ? html`
					<p class="text-xs text-muted-foreground italic mt-1">No orphaned rows found.</p>
				` : ""}
				<div class="flex items-center gap-2 mt-2">
					<button
						class="${scanBtnClass}"
						?disabled=${maintenanceLoading === "orphanRows"}
						@click=${scanOrphanIndexRows}
						data-action="scan-orphan-index-rows"
					>${maintenanceLoading === "orphanRows" && orphanIndexRows === null ? "Scanning..." : "Scan"}</button>
					<button
						class="${actionBtnClass}"
						?disabled=${maintenanceLoading === "orphanRows" || !orphanIndexRows || orphanIndexRows.count === 0}
						@click=${cleanupOrphanRows}
						data-action="cleanup-orphan-index-rows"
					>${maintenanceLoading === "orphanRows" && orphanIndexRows !== null ? "Cleaning..." : `Remove Orphan Rows${orphanIndexRows && orphanIndexRows.count > 0 ? ` (${orphanIndexRows.count})` : ""}`}</button>
				</div>
			</div>
		</div>
	`;
}

export function renderSettingsPage() {
	// Manage keydown listener lifecycle
	updateKeydownListener();
	loadHarnessStatus();

	const currentScope = getActiveScope();
	const tabs = getTabsForScope(currentScope);
	const currentTab = getActiveTab();
	const isHeadquartersScope = isHeadquartersProject(currentScope);
	const isProjectScope = currentScope !== "system" && !isHeadquartersScope;

	return html`
		<div class="flex-1 flex flex-col min-h-0 overflow-hidden">
			<!-- Header -->
			<div class="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-border">
				<div class="flex items-center gap-3 min-w-0">
					<button
						class="p-1.5 rounded-md hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
						@click=${() => { resetRebindState(); cleanupListener(); toggleSettings(); }}
						title="Back"
					>${icon(ArrowLeft, "sm")}</button>
					<h1 class="text-lg font-semibold truncate">Settings</h1>
				</div>
				${renderHarnessRestartControl()}
			</div>
			<!-- Scope row -->
			${renderScopeRow(currentScope, tabs)}
			<!-- Tab bar -->
			<div class="shrink-0 flex items-center gap-1 px-4 py-2 border-b border-border bg-secondary/20 overflow-x-auto" style="scrollbar-width:thin;" data-testid="settings-tab-bar">
				${tabs.map((tab) => html`
					<button
						class="px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap shrink-0
							${currentTab === tab.id
								? "bg-background text-foreground shadow-sm border border-border"
								: "text-muted-foreground hover:text-foreground hover:bg-secondary/50"}"
						title="${tab.label}"
						@click=${() => { setHashRoute("settings", `${currentScope}/${tab.id}`, true); }}
					>${tab.label}</button>
				`)}
			</div>
			<!-- Tab content — every tab gets the same centered max-width column for
			     visual consistency, matching the Workflows tab feel. Workflows itself
			     self-centers via .wf-list so a wider outer wrapper is fine. -->
			<div class="flex-1 overflow-y-auto">
			 <div class="max-w-3xl mx-auto p-2 sm:p-4">
				<div>
					${isProjectScope ? html`
						${currentTab === "general" ? renderProjectGeneralTab(currentScope) : ""}
						${currentTab === "appearance" ? renderAppearanceTab(currentScope) : ""}
						${currentTab === "project" ? renderProjectScopeTab(currentScope) : ""}
						${currentTab === "components" ? renderProjectComponentsTab(currentScope) : ""}
						${currentTab === "workflows" ? renderProjectScopeWorkflowsTab(currentScope) : ""}
						${currentTab === "directories" ? renderProjectScopeDirectoriesTab(currentScope) : ""}
					` : isHeadquartersScope && currentTab === "workflows" ? html`
						${renderProjectScopeWorkflowsTab(HEADQUARTERS_PROJECT_ID)}
					` : html`
						${currentTab === "general" ? renderGeneralTab() : ""}
						${currentTab === "models" ? renderModelsTab() : ""}
						${currentTab === "shortcuts" ? renderShortcutsTab() : ""}
						${currentTab === "palette" ? renderPaletteTab() : ""}
						${currentTab === "directories" ? renderDirectoriesTab() : ""}
						${currentTab === "account" ? renderAccountTab() : ""}
						${currentTab === "maintenance" ? renderMaintenanceTab() : ""}
					`}
				</div>
			 </div>
			</div>
		</div>
	`;
}

function cleanupListener(): void {
	if (_listening) {
		window.removeEventListener("keydown", handleRebindKeydown, true);
		_listening = false;
	}
}
