// src/app/marketplace-page.ts
// ============================================================================
// MARKETPLACE PAGE — register sources, browse + install packs, manage installs
// See docs/design/pack-based-marketplace.md §10. Built against the documented
// REST contracts in §9/§9.1/§9.2; degrades gracefully (shows errors) so it is
// testable before the backend lands.
// ============================================================================

import { icon } from "@mariozechner/mini-lit";
import { html, TemplateResult } from "lit";
import {
	AlertTriangle,
	ArrowLeft,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Circle,
	Database,
	Download,
	ExternalLink,
	GripVertical,
	Package,
	Play,
	Plug,
	Plus,
	RotateCw,
	ScrollText,
	Settings,
	ShoppingCart,
	Square,
	Store,
	Trash2,
	XCircle,
} from "lucide";
import type { IconNode } from "lucide";
import { renderApp, state } from "./state.js";
import { setHashRoute } from "./routing.js";
import {
	addMarketplaceSource,
	browseMarketplacePacks,
	getPackActivation,
	getPackConflicts,
	installMarketplacePack,
	listInstalledPacks,
	listMarketplaceSources,
	removeMarketplaceSource,
	setPackActivation,
	setPackOrder,
	syncMarketplaceSource,
	uninstallMarketplacePack,
	updateInstalledPack,
	fetchContributions,
	fetchTools,
	getPackRuntimeCapabilities,
	getPackRuntimeLogs,
	listPackRuntimes,
	readBuiltinPackRoute,
	writeBuiltinPackRoute,
	startPackRuntime,
	stopPackRuntime,
	type BrowsePackWire,
	type ConflictWire,
	type DisabledRefs,
	type InstalledPackWire,
	type MarketplaceSource,
	type MarketScope,
	type PackActivationResponse,
	type PackEntityDescriptions,
	type PackRuntimeCapabilitySummary,
	type PackRuntimeStatus,
} from "./api.js";

// ============================================================================
// MODULE STATE
// ============================================================================

/** Active sub-tab on the marketplace page. */
export type MarketTab = "installed" | "browse" | "sources";
let activeTab: MarketTab = "installed";

let loading = true;
let sourcesError = "";
let sources: MarketplaceSource[] = [];

let selectedSourceId: string | null = null;
let browsePacks: BrowsePackWire[] = [];
let browseError = "";
let browseLoading = false;

let installed: InstalledPackWire[] = [];
let installedError = "";
let conflicts: ConflictWire[] = [];

/** Per-installed-pack activation catalogue + disabled overrides, keyed by
 *  `${scope}:${packName}` (pack schema V1 §6.7/§9). This is the UNFILTERED
 *  authoritative source for the activation toggles — server-expanded from pack
 *  declarations (tool groups become concrete tool names), NOT from the runtime-
 *  filtered /api/tools or /api/ext/contributions — so a DISABLED entity stays
 *  visible + re-enableable. */
const activationByPack = new Map<string, PackActivationResponse>();

/** Per-runtime capability disclosure for the consent enable-card (P3 design §8),
 *  keyed by {@link runtimeCapabilityCacheKey} (`${scope}:${structuralPackId}:${runtimeId}:${projectId}`).
 *  The key carries the projectId so switching project focus refetches rather than
 *  reusing a stale summary, and the STRUCTURAL pack id so it matches what the
 *  fetch addressed. Derived from the validated
 *  manifest + selected mode (no Docker needed), fetched lazily + best-effort so
 *  the disclosure paints even when Docker is unavailable / the runtime stopped.
 *  `null` = fetch attempted but unavailable (route not present / errored) →
 *  the card falls back to static disclosure copy. */
const runtimeCapabilities = new Map<string, PackRuntimeCapabilitySummary | null>();
/** Guard so we issue at most one in-flight capability fetch per runtime key. */
const runtimeCapabilitiesInFlight = new Set<string>();

// ── Hindsight built-in row: live config/runtime state (design hindsight-ux-polish §5) ──
// Read-only derivation feeding the richer state badge + action bar on the built-in
// `hindsight` row. Fetching status / the runtime list is a PURE read — it NEVER starts
// Docker (the only start path is the explicit Start-runtime click). Invalidated +
// re-fetched alongside the other background loads in loadMarketplaceData.
const HINDSIGHT_PACK = "hindsight";
const HINDSIGHT_RUNTIME = "hindsight";
const HINDSIGHT_PANEL_ID = "hindsight.panel";

/** Subset of the Hindsight `status` route response the marketplace needs. The
 *  `externalUrl`/`uiUrl`/`timeoutMs`/`recallBudget` fields are additive (Partition C)
 *  and optional, so this works whether or not that partition has merged. */
interface HindsightStatusWire {
	configured?: boolean;
	mode?: string;
	bank?: string;
	namespace?: string;
	recallScope?: string;
	autoRecall?: boolean;
	autoRetain?: boolean;
	queueDepth?: number;
	healthy?: boolean;
	// The route persists the last error as a `{ message, ts }` diagnostic object
	// (market-packs/hindsight/src/shared.ts), but legacy/string shapes are tolerated.
	// Render via `hindsightLastErrorText` so an object never stringifies to
	// `[object Object]`.
	lastError?: string | { message?: string; ts?: number } | null;
	externalUrl?: string;
	uiUrl?: string;
	timeoutMs?: number;
	recallBudget?: number;
}

/** The redacted `config` route GET response shape the inline form hydrates from.
 *  Secrets are surfaced as `<field>Set` booleans, never raw values. `externalUrl`/
 *  `uiUrl` are present only when set (resolveConfig omits empty strings). */
interface HindsightConfigWire {
	mode?: string;
	externalUrl?: string;
	uiUrl?: string;
	bank?: string;
	namespace?: string;
	recallScope?: string;
	autoRecall?: boolean;
	autoRetain?: boolean;
	timeoutMs?: number;
	recallBudget?: number;
	dataDir?: string;
	apiKeySet?: boolean;
}

/** The per-project override metadata the `config` GET route exposes when a
 *  `projectId` is supplied (design hindsight-memory-quality §"Per-project override").
 *  Only the safe memory-quality keys are surfaced; absent fields inherit the global
 *  config. Optional everywhere — when the route partition that adds this hasn't
 *  merged, the response simply omits these and the override UI stays dormant. */
interface HindsightProjectOverrideWire {
	recallScope?: string;
	bank?: string;
	tagsMatch?: string;
	recallBudget?: number;
	recallTypes?: string[];
}

/** The full `config` GET response. `config` is the EFFECTIVE (overlay-resolved)
 *  config; `globalConfig`/`projectOverride` are present only when the route was
 *  asked for a specific project AND supports per-project overlays. */
interface HindsightConfigGetWire {
	config?: HindsightConfigWire;
	globalConfig?: HindsightConfigWire;
	projectOverride?: HindsightProjectOverrideWire | null;
	projectId?: string;
}

/** Editable values for the inline Configure form (strings for input binding). */
interface HindsightConfigFormValues {
	mode: string;
	externalUrl: string;
	uiUrl: string;
	bank: string;
	namespace: string;
	recallScope: string;
	autoRecall: boolean;
	autoRetain: boolean;
	timeoutMs: string;
	recallBudget: string;
	apiKey: string;
}

let hindsightStatus: HindsightStatusWire | null = null;
let hindsightStatusLoaded = false;
let hindsightRuntimes: PackRuntimeStatus[] = [];
/** Transient result lozenge for the Test connection / Start / Stop actions. */
let hindsightActionResult: { kind: "test" | "start" | "stop"; ok: boolean; message: string } | null = null;
/** Whether the explicit managed-Start consent disclosure is expanded (start stays a
 *  second explicit click inside it — never auto-fired). */
let hindsightStartConsentOpen = false;
/** Inline runtime logs (View logs), fetched best-effort; null = not loaded. */
let hindsightLogs: string | null = null;

/** Whether the inline Configure form is expanded (Configure click toggles it). */
let hindsightConfigFormOpen = false;
/** The editable form values, hydrated from the `config` route on open. */
let hindsightConfigForm: HindsightConfigFormValues | null = null;
/** The values as loaded from the route (apiKey loaded blank) — the touched-field
 *  baseline so the save only POSTs fields the user actually changed (an untouched
 *  blank secret input never clobbers a stored secret). */
let hindsightConfigLoaded: HindsightConfigFormValues | null = null;
/** Whether a stored apiKey exists (drives the "set/blank" hint on the secret field). */
let hindsightConfigApiKeySet = false;
/** Transient save-result lozenge for the inline config form. */
let hindsightConfigResult: { ok: boolean; message: string } | null = null;

// ── Per-project memory override (design hindsight-memory-quality §"Per-project
// override"). The built-in Hindsight pack is server-scoped, but its memory config
// supports a small project overlay (recallScope + optional bank) layered over the
// global config. The marketplace passes the CURRENT projectId for the built-in row
// so the config route can surface + persist that overlay. All state degrades to a
// dormant section when the route partition exposing it hasn't merged. ──
/** The projectId the override section addresses (current project), if any. */
let hindsightOverrideProjectId: string | undefined;
/** Whether the config route exposed the per-project overlay contract (globalConfig /
 *  projectOverride present). False ⇒ the override section is hidden entirely. */
let hindsightOverrideSupported = false;
/** The server/global base config (used to label "inherit (<global>)" affordances). */
let hindsightGlobalConfig: HindsightConfigWire | null = null;
/** The stored project overlay (null/empty ⇒ no override; inherits global). */
let hindsightProjectOverride: HindsightProjectOverrideWire | null = null;
/** Editable override form values. "" recallScope ⇒ inherit; "" bank ⇒ inherit. */
let hindsightOverrideForm: { recallScope: string; bank: string } | null = null;
/** Transient save-result lozenge for the per-project override save. */
let hindsightOverrideResult: { ok: boolean; message: string } | null = null;

// ── Hindsight guided setup WIZARD (design extension-platform §11 + G3.3) ──────
// Clicking Enable on a DISABLED built-in Hindsight row launches a guided wizard
// (mode → defaults+rationale → test/start with progress → smoke test → finish)
// INSTEAD of flipping the pack enabled immediately. Finish saves config via the
// sessionless config-write seam, THEN enables the pack. Cancel before the
// connect/start action persists nothing and leaves the pack disabled. The wizard
// reuses the existing config-write, status-read, runtime-start and consent
// disclosure paths — it is a guided SEQUENCING on top of them, not a rewrite.
export type HindsightWizardStep = "mode" | "configure" | "connect" | "smoke";
export type HindsightWizardMode = "external" | "managed" | "managed-external-postgres";

/** Editable wizard form. Distinct from the inline-Configure form values so the
 *  wizard can surface the managed-mode fields (llmApiKey/dataDir/externalDatabaseUrl)
 *  and the recall-query clamp (recallMaxInputChars) with their own rationale copy. */
interface HindsightWizardForm {
	mode: HindsightWizardMode;
	externalUrl: string;
	uiUrl: string;
	apiKey: string;
	llmApiKey: string;
	externalDatabaseUrl: string;
	dataDir: string;
	bank: string;
	namespace: string;
	recallScope: string;
	autoRecall: boolean;
	autoRetain: boolean;
	timeoutMs: string;
	recallMaxInputChars: string;
}

let hindsightWizardOpen = false;
/** `${scope}:${packName}` of the pack the wizard targets (so only that row renders it). */
let hindsightWizardPackKey: string | null = null;
let hindsightWizardStep: HindsightWizardStep = "mode";
let hindsightWizardForm: HindsightWizardForm | null = null;
/** Managed-mode consent (must be ticked before the explicit Start). */
let hindsightWizardConsent = false;
/** Whether config has been persisted yet (set by the connect/start action + Finish). */
let hindsightWizardConfigSaved = false;
/** Result of the connect/start action (External: Test; Managed: Start). */
let hindsightWizardConnect: { ok: boolean; message: string } | null = null;
/** Best-effort smoke-test result (non-fatal). */
let hindsightWizardSmoke: { ok: boolean; message: string } | null = null;
/** Surfaced wizard error (config validation / save failure). */
let hindsightWizardError = "";

let newSourceUrl = "";
let newSourceRef = "";
let addingSource = false;

/** Shared scope target for installs in the browse panel. */
let installScope: MarketScope = "server";
let installProjectId: string | undefined = undefined;

/** The project the marketplace currently operates on for the *project* scope
 *  segment. Set whenever the user picks a "Project: X" install target (or
 *  installs into one) so the Installed-list query, update, uninstall and
 *  pack-order all address the SAME project the install targeted — never the
 *  active/first project (finding #2). Defaults (when unset) to the active
 *  project, then the first registered project. */
let focusProjectId: string | undefined = undefined;

/** Per-pack busy flags keyed by `${scope}:${packName}` or `dirName`. */
const busy = new Set<string>();

/** Expanded conflict details keyed by `${scope}:${packName}`. */
const expandedConflicts = new Set<string>();

// Drag-reorder state (market packs within one scope).
let dragScope: MarketScope | null = null;
let dragFromIndex: number | null = null;
let dragOverIndex: number | null = null;

const SCOPE_ORDER: MarketScope[] = ["server", "global-user", "project"];

export function clearMarketplaceState(): void {
	activeTab = "installed";
	loading = true;
	sourcesError = "";
	sources = [];
	selectedSourceId = null;
	browsePacks = [];
	browseError = "";
	browseLoading = false;
	installed = [];
	installedError = "";
	conflicts = [];
	activationByPack.clear();
	hindsightStatus = null;
	hindsightStatusLoaded = false;
	hindsightRuntimes = [];
	hindsightActionResult = null;
	hindsightStartConsentOpen = false;
	hindsightLogs = null;
	hindsightConfigFormOpen = false;
	hindsightConfigForm = null;
	hindsightConfigLoaded = null;
	hindsightConfigApiKeySet = false;
	hindsightConfigResult = null;
	hindsightOverrideProjectId = undefined;
	hindsightOverrideSupported = false;
	hindsightGlobalConfig = null;
	hindsightProjectOverride = null;
	hindsightOverrideForm = null;
	hindsightOverrideResult = null;
	hindsightWizardOpen = false;
	hindsightWizardPackKey = null;
	hindsightWizardStep = "mode";
	hindsightWizardForm = null;
	hindsightWizardConsent = false;
	hindsightWizardConfigSaved = false;
	hindsightWizardConnect = null;
	hindsightWizardSmoke = null;
	hindsightWizardError = "";
	newSourceUrl = "";
	newSourceRef = "";
	addingSource = false;
	installScope = "server";
	installProjectId = undefined;
	focusProjectId = undefined;
	busy.clear();
	expandedConflicts.clear();
}

// ============================================================================
// DATA LOADING
// ============================================================================

function currentProjectId(): string | undefined {
	// The project the marketplace addresses for the *project* scope segment.
	// Prefer the explicitly focused project (set by the install scope picker so
	// install + Installed-list + update/uninstall never diverge — finding #2),
	// else the active project, else the first registered project.
	return focusProjectId || state.activeProjectId || state.projects[0]?.id || undefined;
}

/** The ACTIVE CHAT SESSION's project — the project the GLOBAL tool-renderer
 *  registry must follow (extension-host §4c), NOT the marketplace's focused
 *  project ({@link currentProjectId}). Mirrors what session-manager threads into
 *  `reconcilePackRenderersForProject` on session connect: the active session's
 *  own `projectId`, falling back to the active project, else undefined. Using the
 *  marketplace focus here would let a project-scope install/uninstall for a
 *  NON-active project clobber the renderers the still-active session uses. */
export function activeSessionProjectId(): string | undefined {
	const sid = state.selectedSessionId || state.remoteAgent?.gatewaySessionId;
	const session = sid ? state.gatewaySessions.find((s) => s.id === sid) : undefined;
	return session?.projectId || state.activeProjectId || undefined;
}

/** Re-drive pack-contributed tool-renderer registration after a marketplace
 *  mutation (install/update/uninstall/reorder), extension-host §4a/§4c.
 *
 *  The renderer registry is GLOBAL and must follow the ACTIVE CHAT SESSION's
 *  project ({@link activeSessionProjectId}), NOT the marketplace's focused
 *  project — else a project-scope mutation for a non-active project would clobber
 *  the renderers the still-active session uses (finding #2). We FORCE a re-fetch
 *  + re-register here (the mutation changed the pack set, so the dedupe-guarded
 *  `reconcilePackRenderersForProject` alone would skip it) but ALWAYS scope it to
 *  the active session's project, reconciling the registry back to that project.
 *  `registerPackRenderers` also tears down renderers no longer present — the
 *  uninstall reconciliation path (§4a). Best-effort; never throws. */
export async function reconcileRenderersForActiveSession(): Promise<void> {
	const [
		{ registerPackRenderers },
		{ registerPackPanels, panelInfosFromContributions },
		{ registerPackEntrypoints, entrypointInfosFromContributions },
	] = await Promise.all([
		import("./pack-renderers.js"),
		import("./pack-panels.js"),
		import("./pack-entrypoints.js"),
	]);
	const projectId = activeSessionProjectId();
	// Tool renderers stay TOOL-scoped — reconcile from /api/tools (pack schema V1 §8.3).
	const tools = await fetchTools(projectId);
	registerPackRenderers(tools, projectId);
	// Panels + entrypoints are PACK-scoped — reconcile from /api/ext/contributions
	// (pack schema V1 §8.1/§8.2). Force re-register directly from the freshly-fetched
	// metadata (the dedupe guard would skip an unchanged project); uninstall reconcile
	// drops removed panels/entrypoints/routes so a stale deep-link no longer resolves.
	// `invalidateLoaded` drops cached panel MODULES for surviving panels too: a
	// same-project UPDATE/reinstall re-registers the same {packId, panelId} behind the
	// same serving URL with fresh bytes, so without forcing it the stale module would
	// keep serving until a full reload (this path runs ONLY on real pack mutations /
	// activation toggles, never on a benign session-switch reconcile).
	const packs = await fetchContributions(projectId);
	registerPackPanels(panelInfosFromContributions(packs), projectId, { invalidateLoaded: true });
	registerPackEntrypoints(entrypointInfosFromContributions(packs), projectId);
}

export async function loadMarketplaceData(showLoading = true): Promise<void> {
	if (showLoading) {
		loading = true;
		renderApp();
	}
	// Drop cached runtime capability disclosures so the consent enable-card refetches
	// against the server's CURRENT deployment config. The user may have changed the
	// Hindsight deployment mode (e.g. external → managed) in the panel since this view
	// was last open; without this the stale disclosure would be shown right before the
	// enable toggle (see invalidateRuntimeCapabilities).
	invalidateRuntimeCapabilities();
	const projectId = currentProjectId();

	const [srcRes, instRes, confRes] = await Promise.all([
		listMarketplaceSources(),
		listInstalledPacks(projectId),
		getPackConflicts(projectId),
	]);

	if (srcRes.ok) {
		sources = srcRes.data.sources || [];
		sourcesError = "";
		// Default the browse selection to the first USER source, not the synthetic
		// built-in source (its packs are provided-in-place, not installable, so it's a
		// poor default browse target). Fall back to whatever exists (e.g. only the
		// built-in source is present) so the picker is never empty.
		if (!selectedSourceId && sources.length > 0) {
			selectedSourceId = (sources.find((s) => !s.builtin) ?? sources[0]).id;
		}
	} else {
		sources = [];
		sourcesError = srcRes.error;
	}

	if (instRes.ok) {
		installed = instRes.data.installed || [];
		installedError = "";
	} else {
		installed = [];
		installedError = instRes.error;
	}

	conflicts = confRes.ok ? confRes.data.conflicts || [] : [];

	loading = false;
	renderApp();

	// Activation catalogues are fetched in the background (one GET per installed
	// pack) so the page paints immediately; the toggles appear once they resolve.
	void loadActivationForInstalled();
	// Hindsight built-in row state (config + runtime) — background, best-effort, and a
	// PURE read (never starts Docker). Reset transient action UI on a fresh load.
	hindsightActionResult = null;
	hindsightStartConsentOpen = false;
	hindsightLogs = null;
	void loadHindsightState();

	if (selectedSourceId) await loadBrowse(selectedSourceId);
}

/** Best-effort load of the built-in Hindsight row's live state: the runtime list
 *  (`GET /api/pack-runtimes`, admin-bearer) plus the pack `status` route. BOTH are
 *  pure reads — neither starts Docker. The `status` read goes through the SESSIONLESS
 *  built-in pack-route seam ({@link readBuiltinPackRoute}) rather than the launcher
 *  Host API: after `#/market` navigation there is no active chat session, so the
 *  surface-token mint the Host API needs would 403 and the row would stay stuck on
 *  "Unknown" (the production bug this fix targets). Only runs when the built-in
 *  `hindsight` pack is installed; silently degrades (badge shows "Checking…"/"Unknown")
 *  when a read fails. */
async function loadHindsightState(): Promise<void> {
	const pack = installed.find((p) => p.builtin && p.packName === HINDSIGHT_PACK);
	if (!pack) return;
	const projectId = currentProjectId();
	const runtimesRes = await listPackRuntimes(projectId);
	if (runtimesRes.ok) hindsightRuntimes = runtimesRes.data.runtimes || [];
	// Pass the CURRENT projectId for the built-in row too (not just project-scope
	// packs): the config route overlays the per-project memory override + reports the
	// EFFECTIVE recall scope for it. A route partition that ignores projectId simply
	// returns the global view (override section stays dormant).
	const statusRes = await readBuiltinPackRoute<HindsightStatusWire>({
		packId: runtimeRestPackId(pack),
		routeName: "status",
		projectId,
	});
	if (statusRes.ok) {
		hindsightStatus = statusRes.data ?? null;
		hindsightStatusLoaded = true;
	}
	// Read config (project-scoped) to surface the per-project override badge on the
	// summary WITHOUT opening Configure. Pure read; populates META only (never the
	// editable override form, which Configure seeds on open).
	const cfgRes = await readBuiltinPackRoute<HindsightConfigGetWire>({
		packId: runtimeRestPackId(pack),
		routeName: "config",
		projectId,
	});
	if (cfgRes.ok && cfgRes.data) applyHindsightOverrideMeta(cfgRes.data, projectId);
	renderApp();
}

/** Populate the per-project override METADATA (support flag, global base, stored
 *  overlay) from a `config` GET response. Does NOT touch the editable override form.
 *  The route exposes the overlay contract only when it returns `globalConfig` or a
 *  `projectOverride` field; absent ⇒ the section stays hidden. */
function applyHindsightOverrideMeta(data: HindsightConfigGetWire, projectId: string | undefined): void {
	hindsightOverrideProjectId = projectId;
	const supported = !!projectId && (Object.prototype.hasOwnProperty.call(data, "globalConfig") || Object.prototype.hasOwnProperty.call(data, "projectOverride"));
	hindsightOverrideSupported = supported;
	hindsightGlobalConfig = data.globalConfig ?? null;
	hindsightProjectOverride = data.projectOverride ?? null;
}

/** True when a non-empty per-project overlay is stored (drives the summary badge). */
function hasHindsightProjectOverride(): boolean {
	const o = hindsightProjectOverride;
	if (!o) return false;
	return !!(o.recallScope || (o.bank && o.bank.trim()) || o.tagsMatch || o.recallBudget != null || (o.recallTypes && o.recallTypes.length));
}

/** Resolve the current project's display name for override copy. */
function hindsightProjectName(): string {
	const pid = hindsightOverrideProjectId;
	if (!pid) return "this project";
	return state.projects.find((p) => p.id === pid)?.name || "this project";
}

/** Fetch the UNFILTERED activation catalogue + disabled overrides for every
 *  installed pack (pack schema V1 §6.7/§9). The catalogue is the SINGLE source
 *  for the toggle UI — never the runtime-filtered /api/tools or
 *  /api/ext/contributions, which would hide a disabled entity and make it
 *  impossible to re-enable. Best-effort; repaints when done. */
async function loadActivationForInstalled(): Promise<void> {
	const snapshot = installed.slice();
	const results = await Promise.all(snapshot.map(async (p) => {
		const projectId = p.scope === "project" ? currentProjectId() : undefined;
		const res = await getPackActivation(p.scope, p.packName, projectId);
		return { key: `${p.scope}:${p.packName}`, res };
	}));
	let changed = false;
	for (const { key, res } of results) {
		if (res.ok) { activationByPack.set(key, res.data); changed = true; }
	}
	if (changed) renderApp();
}

/** Toggleable entity kinds (singular testid form). The schema-v2 kinds
 *  (`provider`/`hook`/`mcp`/`pi-extension`/`runtime`/`workflow`) appear only for
 *  schema≥2 packs; `runtime` is the consent-gated managed Docker runtime. */
type ActivationKind = "role" | "tool" | "skill" | "entrypoint" | "provider" | "hook" | "mcp" | "pi-extension" | "runtime" | "workflow";

/** Maps the singular testid kind → the `DisabledRefs` array key. */
const ACTIVATION_KIND_KEY: Record<ActivationKind, keyof DisabledRefs> = {
	role: "roles",
	tool: "tools",
	skill: "skills",
	entrypoint: "entrypoints",
	provider: "providers",
	hook: "hooks",
	mcp: "mcp",
	"pi-extension": "piExtensions",
	runtime: "runtimes",
	workflow: "workflows",
};

/** Memory/trust disclosure shown on the managed-runtime consent enable-card
 *  (design §8). Enabling starts Docker containers that store + recall agent
 *  memory; disabling stops them but keeps data; purge removes the volumes. */
const RUNTIME_MEMORY_DISCLOSURE =
	"Enabling this managed runtime starts local Docker containers that store and recall agent memory — conversation summaries plus project/goal/session tags — in the configured memory bank. Disabling stops the containers but keeps your data on disk; purging removes the Docker volumes and runtime state.";

/** External-mode setup guidance (no Docker). Shown when the runtime is configured
 *  to talk to an already-running Hindsight instead of a Bobbit-managed one. */
const RUNTIME_EXTERNAL_GUIDANCE =
	"External mode does not run Docker. Point Bobbit at an existing Hindsight deployment by configuring its URL, optional API key, namespace and memory bank in the provider settings.";

/** Structural pack id used to address the runtime REST routes
 *  (`/api/pack-runtimes/:id/*`). The extension-host keys packs/runtimes by the
 *  `market-packs/<dir>` STRUCTURAL id, which can diverge from the manifest
 *  `name` for a built-in pack — so passing `packName` would 404 the capability
 *  lookup. Prefer the wire's `packId`; fall back to `packName` only for an older
 *  server that omits it (where the two coincide for installed packs). */
export function runtimeRestPackId(pack: { packId?: string; packName: string }): string {
	return pack.packId ?? pack.packName;
}

/** Cache / in-flight key for a runtime capability fetch. MUST include the
 *  projectId the fetch is scoped to: project-scope packs fetch with
 *  {@link currentProjectId}, so omitting it would reuse one project's disclosure
 *  after the user switches project focus (stale capability summary). Server-scope
 *  packs always fetch with no projectId, so their key carries an empty segment. */
export function runtimeCapabilityCacheKey(
	scope: MarketScope,
	packId: string,
	runtimeId: string,
	projectId: string | undefined,
): string {
	return `${scope}:${packId}:${runtimeId}:${projectId ?? ""}`;
}

/** Drop every cached runtime capability disclosure (and any in-flight guard) so
 *  the consent enable-card refetches fresh from the server. The disclosure is a
 *  function of the SERVER's current deployment config (mode/dataDir/…), which the
 *  user changes elsewhere (the Hindsight panel writes the provider config). The
 *  cache key cannot encode that revision, so a stale `external` disclosure would
 *  otherwise survive a switch to `managed` and be shown immediately before the
 *  enable. Called whenever the marketplace view (re)loads, so the consent text
 *  always matches current server config before the user toggles enable. */
export function invalidateRuntimeCapabilities(): void {
	runtimeCapabilities.clear();
	runtimeCapabilitiesInFlight.clear();
}

/** Lazily fetch + cache the capability disclosure for a managed runtime so the
 *  consent enable-card can render images/services, ports, volume path and trust
 *  copy. Best-effort: a missing route / error caches `null` and the card falls
 *  back to static copy. Repaints once resolved. Exported for the staleness
 *  regression test (drives the fetch/cache via a stubbed window.fetch). */
export function ensureRuntimeCapabilities(pack: InstalledPackWire, runtimeId: string): void {
	const projectId = pack.scope === "project" ? currentProjectId() : undefined;
	const restPackId = runtimeRestPackId(pack);
	// Cache key tracks the STRUCTURAL pack id + the projectId the fetch is scoped
	// to, so a project-focus switch refetches rather than reusing a stale summary.
	const key = runtimeCapabilityCacheKey(pack.scope, restPackId, runtimeId, projectId);
	if (runtimeCapabilities.has(key) || runtimeCapabilitiesInFlight.has(key)) return;
	runtimeCapabilitiesInFlight.add(key);
	void getPackRuntimeCapabilities({ packId: restPackId, runtimeId, projectId }).then((res) => {
		runtimeCapabilitiesInFlight.delete(key);
		runtimeCapabilities.set(key, res.ok ? res.data : null);
		renderApp();
	});
}

/** Toggle a user-facing pack entity's activation. Computes the new `disabled`
 *  set, PUTs it (the response carries the refreshed catalogue + normalized
 *  disabled — no follow-up GET), then re-runs the marketplace reconcile so a
 *  disabled entrypoint disappears from launchers/deep-links WITHOUT a reload
 *  (pack schema V1 §9). Entrypoints are keyed by `listName`. */
async function handleToggleActivation(
	pack: InstalledPackWire,
	kind: ActivationKind,
	name: string,
	enable: boolean,
): Promise<void> {
	const cacheKey = `${pack.scope}:${pack.packName}`;
	const current = activationByPack.get(cacheKey);
	const kindKey = ACTIVATION_KIND_KEY[kind];
	const set = new Set(current?.disabled?.[kindKey] ?? []);
	if (enable) set.delete(name); else set.add(name);
	const disabled: DisabledRefs = { ...(current?.disabled ?? {}), [kindKey]: [...set] };
	await savePackActivation(pack, disabled, `activation:${cacheKey}:${kind}:${name}`);
}

async function handleToggleAllActivation(pack: InstalledPackWire, enable: boolean): Promise<void> {
	const cacheKey = `${pack.scope}:${pack.packName}`;
	const current = activationByPack.get(cacheKey);
	if (!current) return;
	const cat = current.catalogue;
	// Disabling-all MUST cover the schema-v2 arrays too (providers/hooks/mcp/
	// piExtensions/runtimes/workflows) — otherwise the master OFF toggle would
	// leave a managed runtime enabled (and Docker running). Enabling-all clears
	// every kind back to the default-enabled state.
	const disabled: DisabledRefs = enable
		? { roles: [], tools: [], skills: [], entrypoints: [], providers: [], hooks: [], mcp: [], piExtensions: [], runtimes: [], workflows: [] }
		: {
			roles: [...cat.roles],
			tools: [...cat.tools],
			skills: [...cat.skills],
			entrypoints: cat.entrypoints.map((e) => e.listName),
			providers: [...(cat.providers ?? [])],
			hooks: [...(cat.hooks ?? [])],
			mcp: [...(cat.mcp ?? [])],
			piExtensions: [...(cat.piExtensions ?? [])],
			runtimes: [...(cat.runtimes ?? [])],
			workflows: [...(cat.workflows ?? [])],
		};
	await savePackActivation(pack, disabled, `activation:${cacheKey}:all`);
}

async function savePackActivation(pack: InstalledPackWire, disabled: DisabledRefs, busyKey: string): Promise<void> {
	const cacheKey = `${pack.scope}:${pack.packName}`;
	const projectId = pack.scope === "project" ? currentProjectId() : undefined;
	busy.add(busyKey);
	renderApp();
	const res = await setPackActivation({ scope: pack.scope, projectId, packName: pack.packName, disabled });
	busy.delete(busyKey);
	if (res.ok) {
		// The PUT returns the refreshed UNFILTERED catalogue + normalized disabled.
		activationByPack.set(cacheKey, res.data);
		// Re-run the same reconcile a marketplace mutation triggers so the runtime
		// registries (renderers/panels/entrypoints) drop/restore the toggled entity
		// without a reload (the catalogue source above is unaffected).
		await refreshConfigPages();
		renderApp();
	} else {
		installedError = res.error;
		renderApp();
	}
}

async function loadBrowse(sourceId: string): Promise<void> {
	selectedSourceId = sourceId;
	browseLoading = true;
	browseError = "";
	renderApp();
	const res = await browseMarketplacePacks(sourceId);
	if (res.ok) {
		browsePacks = res.data.packs || [];
	} else {
		browsePacks = [];
		browseError = res.error;
	}
	browseLoading = false;
	renderApp();
}

/** Refresh the Roles/Tools/Skills config pages' data so installed entities
 *  appear (or disappear) with their pack origin. Best-effort. */
async function refreshConfigPages(): Promise<void> {
	await Promise.allSettled([
		import("./role-manager-page.js").then((m) => m.loadRolePageData()).catch(() => {}),
		import("./tool-manager-page.js").then((m) => m.loadToolPageData()).catch(() => {}),
		import("./skills-page.js").then((m) => m.loadSkillsPageData(false)).catch(() => {}),
		// Re-drive pack-contributed tool-renderer registration (extension-host
		// §4a/§4c) so an installed/uninstalled pack's renderer appears/updates
		// without a reload — scoped to the ACTIVE CHAT SESSION's project, not the
		// marketplace's focused project (finding #2). Idempotent + best-effort.
		reconcileRenderersForActiveSession().catch(() => {}),
	]);
}

// ============================================================================
// ACTIONS
// ============================================================================

async function handleAddSource(): Promise<void> {
	const url = newSourceUrl.trim();
	if (!url) return;
	addingSource = true;
	sourcesError = "";
	renderApp();
	const res = await addMarketplaceSource(url, newSourceRef.trim() || undefined);
	addingSource = false;
	if (res.ok) {
		newSourceUrl = "";
		newSourceRef = "";
		await loadMarketplaceData(false);
		if (res.data.source?.id) {
			activeTab = "browse";
			await loadBrowse(res.data.source.id);
		}
	} else {
		sourcesError = res.error;
		renderApp();
	}
}

async function handleSyncSource(id: string): Promise<void> {
	const key = `sync:${id}`;
	busy.add(key);
	renderApp();
	const res = await syncMarketplaceSource(id);
	busy.delete(key);
	if (res.ok) {
		await loadMarketplaceData(false);
		if (selectedSourceId === id) await loadBrowse(id);
	} else {
		sourcesError = res.error;
		renderApp();
	}
}

async function handleRemoveSource(id: string): Promise<void> {
	const { confirmAction } = await import("./dialogs.js");
	const ok = await confirmAction("Remove source", "Remove this marketplace source and its cache? Installed packs are not affected.", "Remove", true);
	if (!ok) return;
	const res = await removeMarketplaceSource(id);
	if (res.ok) {
		if (selectedSourceId === id) {
			selectedSourceId = null;
			browsePacks = [];
		}
		await loadMarketplaceData(false);
	} else {
		sourcesError = res.error;
		renderApp();
	}
}

async function handleInstall(pack: BrowsePackWire): Promise<void> {
	const scope = installScope;
	const projectId = scope === "project" ? installProjectId : undefined;
	if (scope === "project" && !projectId) {
		browseError = "Select a project to install into the project scope.";
		renderApp();
		return;
	}
	// Bind the marketplace's project focus to the install target so the pack we
	// install appears in the Installed list and update/uninstall address the
	// same project we installed into (finding #2).
	if (scope === "project" && projectId) focusProjectId = projectId;

	const key = `install:${pack.dirName}`;
	busy.add(key);
	renderApp();
	const res = await installMarketplacePack({ sourceId: selectedSourceId!, dirName: pack.dirName, scope, projectId });
	busy.delete(key);
	if (res.ok) {
		await loadMarketplaceData(false);
		if (selectedSourceId) await loadBrowse(selectedSourceId);
		await refreshConfigPages();
	} else {
		browseError = res.error;
		renderApp();
	}
}

async function handleUpdate(pack: InstalledPackWire): Promise<void> {
	const key = `${pack.scope}:${pack.packName}`;
	busy.add(key);
	renderApp();
	const res = await updateInstalledPack({ scope: pack.scope, packName: pack.packName, projectId: pack.scope === "project" ? currentProjectId() : undefined });
	busy.delete(key);
	if (res.ok) {
		await loadMarketplaceData(false);
		await refreshConfigPages();
	} else {
		installedError = res.error;
		renderApp();
	}
}

async function handleUninstall(pack: InstalledPackWire): Promise<void> {
	const { confirmAction } = await import("./dialogs.js");
	const ok = await confirmAction("Uninstall pack", `Uninstall "${pack.packName}"? This deletes the pack directory and removes its entities.`, "Uninstall", true);
	if (!ok) return;
	const key = `${pack.scope}:${pack.packName}`;
	busy.add(key);
	renderApp();
	const res = await uninstallMarketplacePack({ scope: pack.scope, packName: pack.packName, projectId: pack.scope === "project" ? currentProjectId() : undefined });
	busy.delete(key);
	if (res.ok) {
		await loadMarketplaceData(false);
		await refreshConfigPages();
	} else {
		installedError = res.error;
		renderApp();
	}
}

// ============================================================================
// DRAG REORDER (market packs within one scope) → PUT /api/marketplace/pack-order
// ============================================================================

function packsForScope(scope: MarketScope): InstalledPackWire[] {
	// Built-in first-party packs (§7.4) render in their OWN top group and are NOT
	// in pack_order — exclude them from the per-scope (reorderable) groups.
	return installed.filter((p) => p.scope === scope && !p.builtin);
}

function handleDragStart(e: DragEvent, scope: MarketScope, index: number): void {
	dragScope = scope;
	dragFromIndex = index;
	dragOverIndex = index;
	if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
	renderApp();
}

function handleDragOver(e: DragEvent, scope: MarketScope, index: number): void {
	if (dragScope !== scope || dragFromIndex === null) return;
	e.preventDefault();
	if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
	if (dragOverIndex !== index) {
		dragOverIndex = index;
		renderApp();
	}
}

async function handleDrop(scope: MarketScope): Promise<void> {
	if (dragScope !== scope || dragFromIndex === null || dragOverIndex === null) {
		resetDrag();
		return;
	}
	const scoped = packsForScope(scope).map((p) => p.packName);
	const from = dragFromIndex;
	const to = dragOverIndex;
	resetDrag();
	if (from === to) return;
	const next = [...scoped];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	await persistOrder(scope, next);
}

function resetDrag(): void {
	dragScope = null;
	dragFromIndex = null;
	dragOverIndex = null;
	renderApp();
}

/** Move a pack up/down within its scope (keyboard/click affordance that calls
 *  the same pack-order endpoint as drag). */
async function movePack(scope: MarketScope, packName: string, delta: number): Promise<void> {
	const order = packsForScope(scope).map((p) => p.packName);
	const idx = order.indexOf(packName);
	const target = idx + delta;
	if (idx < 0 || target < 0 || target >= order.length) return;
	const next = [...order];
	[next[idx], next[target]] = [next[target], next[idx]];
	await persistOrder(scope, next);
}

async function persistOrder(scope: MarketScope, order: string[]): Promise<void> {
	const res = await setPackOrder({ scope, projectId: scope === "project" ? currentProjectId() : undefined, order });
	if (res.ok) {
		await loadMarketplaceData(false);
		await refreshConfigPages();
	} else {
		installedError = res.error;
		renderApp();
	}
}

// ============================================================================
// RENDER HELPERS
// ============================================================================

function scopeLabel(scope: MarketScope): string {
	if (scope === "global-user") return "Global (user)";
	if (scope === "server") return "Server";
	return "Project";
}

function renderNavBar(): TemplateResult {
	return html`
		<div class="flex items-center gap-2 px-4 py-3 border-b border-border">
			<button
				class="p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
				@click=${() => setHashRoute("landing")}
				title="Back"
			>${icon(ArrowLeft, "sm")}</button>
			<h1 class="text-lg font-semibold flex items-center gap-2">
				${icon(Store, "sm")}
				Marketplace
			</h1>
		</div>
	`;
}

function renderResearchPreviewBanner(): TemplateResult {
	return html`
		<div class="market-research-preview-banner" data-testid="market-research-preview-banner">
			<div class="market-research-preview-icon">${icon(AlertTriangle, "sm")}</div>
			<div>
				<div class="market-research-preview-title">Research Preview</div>
				<div class="market-research-preview-copy">
					The extension API is still subject to change. Bobbit extensions may need to be re-written against the final extension API in the next release.
				</div>
			</div>
		</div>
	`;
}

function renderTabBar(): TemplateResult {
	const tab = (mode: MarketTab, label: string, tabIcon: IconNode, count?: number) => {
		const isActive = activeTab === mode;
		const cls = [
			"flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-2 text-xs font-medium border-b-2 transition-colors select-none whitespace-nowrap cursor-pointer",
			isActive ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
		].join(" ");
		const badgeCls = isActive
			? "text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium"
			: "text-[10px] px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground font-medium";
		return html`
			<button
				type="button"
				data-testid="market-tab-${mode}"
				class=${cls}
				@click=${() => { activeTab = mode; renderApp(); }}
			>
				${icon(tabIcon, "xs")}
				<span>${label}</span>
				${typeof count === "number" ? html`<span class=${badgeCls}>${count}</span>` : ""}
			</button>
		`;
	};
	return html`
		<div class="flex border-b border-border shrink-0" role="tablist">
			${tab("installed", "Installed", Package, installed.length)}
			${tab("browse", "Browse", ShoppingCart)}
			${tab("sources", "Sources", Database, sources.length)}
		</div>
	`;
}

function entityChips(pack: BrowsePackWire | InstalledPackWire): TemplateResult {
	const contents = "contents" in pack ? pack.contents : (pack as InstalledPackWire).manifest.contents;
	const groups: Array<[string, string[]]> = [
		["role", contents?.roles || []],
		["tool", contents?.tools || []],
		["skill", contents?.skills || []],
	];
	const chips = groups.flatMap(([kind, names]) =>
		names.map((n) => html`<span class="market-entity-chip" data-kind=${kind}>${kind}: ${n}</span>`),
	);
	if (chips.length === 0) return html`<span class="text-[11px] text-muted-foreground italic">no declared entities</span>`;
	return html`<div class="flex flex-wrap gap-1">${chips}</div>`;
}

/** Declared-entity name lists for the description disclosure, across all four
 *  kinds. Entry points carry an optional display `label`. */
interface EntityNameLists {
	roles: string[];
	tools: string[];
	skills: string[];
	entrypoints: Array<{ listName: string; label?: string }>;
}

/** Shared collapsed "Show details" disclosure (R3) — one row per declared
 *  entity that HAS a one-line description, across roles/tools/skills/entry
 *  points. Used by BOTH the Installed activation list and the Browse pack card.
 *  Rows with no description are omitted; the disclosure is omitted entirely when
 *  no row would render. Tool keys follow the provided entity list (manifest groups
 *  for browse chips, concrete tool names for activation); entrypoints use `listName`
 *  (kind `entrypoint`). */
function renderEntityDetails(packName: string, descriptions: PackEntityDescriptions | undefined, entities: EntityNameLists): TemplateResult {
	if (!descriptions) return html``;
	const rows: TemplateResult[] = [];
	const pushRows = (
		kind: "role" | "tool" | "skill" | "entrypoint",
		map: Record<string, string> | undefined,
		names: string[],
		labelFor?: (n: string) => string,
	): void => {
		if (!map) return;
		for (const name of names) {
			const desc = map[name];
			if (!desc) continue;
			rows.push(html`
				<div class="market-entity-desc" data-testid="market-entity-desc-${kind}-${name}">
					<span class="market-entity-desc-name">${labelFor ? labelFor(name) : name}</span>
					<span class="market-entity-desc-text">${desc}</span>
				</div>
			`);
		}
	};
	pushRows("role", descriptions.roles, entities.roles);
	pushRows("tool", descriptions.tools, entities.tools);
	pushRows("skill", descriptions.skills, entities.skills);
	const epLabel = new Map(entities.entrypoints.map((e) => [e.listName, e.label || e.listName]));
	pushRows("entrypoint", descriptions.entrypoints, entities.entrypoints.map((e) => e.listName), (n) => epLabel.get(n) || n);
	if (rows.length === 0) return html``;
	return html`
		<details class="market-entity-details" data-testid="market-entity-details-${packName}">
			<summary>Show details</summary>
			<div class="market-entity-desc-list">${rows}</div>
		</details>
	`;
}

function renderSourcesPanel(): TemplateResult {
	return html`
		<section class="market-panel" data-testid="market-sources-panel">
			<h2 class="market-panel-title">${icon(Package, "sm")} Sources</h2>
			${sourcesError ? html`<div class="market-error" data-testid="market-sources-error">${sourcesError}</div>` : ""}
			${sources.length === 0
				? html`<p class="text-sm text-muted-foreground italic">No marketplace sources registered yet.</p>`
				: html`<div class="flex flex-col gap-1.5">${sources.map(renderSourceRow)}</div>`}

			<div class="flex flex-col gap-2 mt-2 pt-3 border-t border-border">
				<div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Add source</div>
				<div class="market-trust-warning" data-testid="market-trust-warning">
					${icon(AlertTriangle, "xs")}
					<div class="flex flex-col gap-1.5">
						<span>Only add sources you trust. Installing any pack from a source can run code or instruct agents on your machine.</span>
						<details class="market-trust-why" data-testid="market-trust-why">
							<summary>Why?</summary>
							<div class="market-trust-why-body">
								<p data-kind="tool"><strong>Tools</strong> ship <code>extension.ts</code> / <code>_shared/</code> code that runs directly in the Bobbit server process on the host, deterministically, with no LLM and no sandbox in the loop. Highest, most immediate risk.</p>
								<p data-kind="skill"><strong>Skills</strong> are free-form instructions an agent tends to follow literally; an agent with shell access can be directed to do damage.</p>
								<p data-kind="role"><strong>Roles</strong> steer persona/behavior; influential but more diffuse. Still drives an LLM with tool access.</p>
							</div>
						</details>
					</div>
				</div>
				<input
					type="text"
					data-testid="market-source-url"
					class="market-input"
					placeholder="https://github.com/acme/bobbit-packs.git or /abs/local/path"
					.value=${newSourceUrl}
					@input=${(e: Event) => { newSourceUrl = (e.target as HTMLInputElement).value; renderApp(); }}
					@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && newSourceUrl.trim()) handleAddSource(); }}
				/>
				<div class="flex items-center gap-2">
					<input
						type="text"
						data-testid="market-source-ref"
						class="market-input flex-1"
						placeholder="ref (branch/tag, optional)"
						.value=${newSourceRef}
						@input=${(e: Event) => { newSourceRef = (e.target as HTMLInputElement).value; renderApp(); }}
						@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && newSourceUrl.trim()) handleAddSource(); }}
					/>
					<button
						class="market-btn market-btn--primary"
						data-testid="market-add-source"
						?disabled=${!newSourceUrl.trim() || addingSource}
						@click=${handleAddSource}
					>${icon(Plus, "xs")} ${addingSource ? "Adding…" : "Add"}</button>
				</div>
			</div>
		</section>
	`;
}

function renderSourceRow(src: MarketplaceSource): TemplateResult {
	const isSelected = selectedSourceId === src.id;
	const syncing = busy.has(`sync:${src.id}`);
	// The synthetic built-in source (§4.4/§7.4) is non-removable and resolves its
	// packs in place — render it as a distinct "Built-in" row, omit the Remove
	// control entirely, and hide Re-sync (a harmless no-op server-side) to reduce
	// confusion. It stays clickable so users can browse the shipped packs.
	const isBuiltin = src.builtin === true;
	return html`
		<div
			class="market-source-row ${isSelected ? "market-source-row--selected" : ""}"
			data-testid="market-source-row"
			data-builtin=${isBuiltin ? "true" : "false"}
		>
			<button class="flex-1 min-w-0 text-left" @click=${() => { activeTab = "browse"; loadBrowse(src.id); }} title="Browse packs">
				<div class="flex items-center gap-1.5">
					<span class="text-sm font-medium truncate">${src.id}</span>
					${isBuiltin ? html`<span class="market-builtin-badge" data-testid="market-source-builtin-badge">Built-in</span>` : ""}
				</div>
				<div class="text-[11px] text-muted-foreground truncate">${src.url}${src.ref ? html` <span class="opacity-70">@${src.ref}</span>` : ""}</div>
				${isBuiltin
					? html`<div class="text-[10px] text-muted-foreground/80">Shipped core features — always available, enable/disable per pack.</div>`
					: src.lastCommit ? html`<div class="text-[10px] text-muted-foreground/80">commit ${src.lastCommit.slice(0, 7)}</div>` : ""}
			</button>
			${isBuiltin
				? ""
				: html`
					<button class="market-icon-btn" title="Re-sync" data-testid="market-sync-source" ?disabled=${syncing} @click=${() => handleSyncSource(src.id)}>
						${icon(RotateCw, "xs", syncing ? "animate-spin" : "")}
					</button>
					<button class="market-icon-btn market-icon-btn--danger" title="Remove source" data-testid="market-remove-source" @click=${() => handleRemoveSource(src.id)}>
						${icon(Trash2, "xs")}
					</button>
				`}
		</div>
	`;
}

function renderScopePicker(): TemplateResult {
	const projects = state.projects || [];
	return html`
		<label class="flex items-center gap-2 text-xs text-muted-foreground">
			<span>Install to</span>
			<select
				class="market-input"
				data-testid="market-install-scope"
				.value=${installScope === "project" && installProjectId ? `project:${installProjectId}` : installScope}
				@change=${(e: Event) => {
					const v = (e.target as HTMLSelectElement).value;
					if (v.startsWith("project:")) {
						installScope = "project";
						installProjectId = v.slice("project:".length);
						// Re-focus the marketplace on the chosen project and reload the
						// Installed list/conflicts for it so they match the install target.
						if (focusProjectId !== installProjectId) {
							focusProjectId = installProjectId;
							void loadMarketplaceData(false);
							return;
						}
					} else {
						installScope = v as MarketScope;
						installProjectId = undefined;
					}
					renderApp();
				}}
			>
				<option value="server">Server</option>
				<option value="global-user">Global (user)</option>
				${projects.map((p: any) => html`<option value="project:${p.id}">Project: ${p.name}</option>`)}
			</select>
		</label>
	`;
}

function renderBrowsePanel(): TemplateResult {
	return html`
		<section class="market-panel" data-testid="market-browse-panel">
			<div class="flex items-center justify-between gap-2 flex-wrap">
				<h2 class="market-panel-title">${icon(Download, "sm")} Browse${selectedSourceId ? html` <span class="text-xs font-normal text-muted-foreground">— ${selectedSourceId}</span>` : ""}</h2>
				${renderScopePicker()}
			</div>
			${!selectedSourceId
				? html`<p class="text-sm text-muted-foreground italic">Select a source to browse its packs.</p>`
				: browseLoading
					? html`<p class="text-sm text-muted-foreground">Loading packs…</p>`
					: browseError
						? html`<div class="market-error" data-testid="market-browse-error">${browseError}</div>`
						: browsePacks.length === 0
							? html`<p class="text-sm text-muted-foreground italic">This source has no packs.</p>`
							: html`<div class="flex flex-col gap-2">${browsePacks.map(renderBrowsePackCard)}</div>`}
		</section>
	`;
}

/** Find the installed copy of a browse pack AT THE CURRENTLY-SELECTED install
 *  scope (R4). For project scope the Installed list must be loaded for the
 *  picked project — if `installProjectId` and `currentProjectId()` diverge we
 *  treat the pack as not-installed for that project (avoids a wrong-project
 *  false positive; preserves finding #2). */
function installedMatchForBrowse(pack: BrowsePackWire): InstalledPackWire | undefined {
	if (installScope === "project") {
		if (!installProjectId || installProjectId !== currentProjectId()) return undefined;
		return installed.find((p) => p.scope === "project" && p.packName === pack.name);
	}
	return installed.find((p) => p.scope === installScope && p.packName === pack.name);
}

function renderBrowsePackCard(pack: BrowsePackWire): TemplateResult {
	const installing = busy.has(`install:${pack.dirName}`);
	const match = installedMatchForBrowse(pack);
	let action: TemplateResult;
	if (pack.builtin) {
		// Built-in (first-party) packs are resolved in place — provided, not
		// installable; manage them from the Installed tab's toggles (§4.4/§7.4).
		action = html`<span class="market-builtin-badge shrink-0" data-testid="market-browse-provided" title="Shipped with Bobbit — manage it from the Installed tab's toggles">Provided (built-in)</span>`;
	} else if (!match) {
		action = html`
			<button
				class="market-btn market-btn--primary shrink-0"
				data-testid="market-install-pack"
				?disabled=${installing}
				@click=${() => handleInstall(pack)}
			>${icon(Download, "xs")} ${installing ? "Installing…" : "Install"}</button>`;
	} else if (pack.version !== match.meta.version) {
		// Installed but behind the source's latest version → offer an update.
		const isBusy = busy.has(`${match.scope}:${match.packName}`);
		action = html`
			<button
				class="market-btn shrink-0"
				data-testid="market-browse-update-pack"
				?disabled=${isBusy}
				@click=${() => handleUpdate(match)}
			>${icon(RotateCw, "xs", isBusy ? "animate-spin" : "")} Update</button>`;
	} else {
		action = html`<span class="market-lozenge shrink-0" data-testid="market-browse-installed">${icon(Package, "xs")} Installed</span>`;
	}
	const entrypointNames = (pack.contents?.entrypoints ?? []).map((listName) => ({ listName }));
	return html`
		<div class="market-pack-card" data-testid="market-browse-pack" data-pack-name=${pack.name}>
			<div class="flex items-start justify-between gap-3">
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2 flex-wrap">
						<span class="text-sm font-semibold">${pack.name}</span>
						<span class="text-[11px] text-muted-foreground">v${pack.version}</span>
					</div>
					<div class="text-xs text-muted-foreground mt-0.5">${pack.description}</div>
					<div class="mt-1.5">${entityChips(pack)}</div>
					${renderEntityDetails(pack.name, pack.descriptions, {
						roles: pack.contents?.roles ?? [],
						tools: pack.contents?.tools ?? [],
						skills: pack.contents?.skills ?? [],
						entrypoints: entrypointNames,
					})}
				</div>
				${action}
			</div>
		</div>
	`;
}

/** A pack participates in a conflict if its market PackEntry id appears as the
 *  winner or among the shadowed entries of any conflict. */
function conflictsForPack(pack: InstalledPackWire): ConflictWire[] {
	const id = `market:${pack.scope}:${pack.packName}`;
	return conflicts.filter((c) =>
		c.winner.packEntryId === id || c.shadowed.some((s) => s.packEntryId === id),
	);
}

/** §6.4/§7.4 — is the built-in row shadowed by a same-name user install?
 *
 *  The built-in band sits BELOW every user scope band, and the resolver /
 *  contribution registry collapse to ONE winning pack per packId by list position
 *  — so a same-name pack installed at ANY user scope (server/global-user/project)
 *  ALWAYS wins over the built-in, regardless of which entity kinds it ships. We
 *  therefore detect the shadow by the presence of a non-corrupt same-name install,
 *  NOT via `/api/packs/conflicts`: that endpoint only reports role/tool/skill
 *  conflicts, so an ENTRYPOINT/panel/route-only pack with empty role/tool/skill
 *  declarations would never appear there and the built-in row would wrongly stay
 *  live (the winner-owns-the-toggle rule broken).
 *  A `corrupt` install is excluded from resolution, so it never wins and never
 *  suppresses the built-in toggle. With no non-corrupt same-name install, the
 *  built-in row owns the live (server, packName) toggle. */
function builtinRowShadowed(packName: string): boolean {
	return installed.some(
		(p) => !p.builtin && p.packName === packName && p.status !== "corrupt",
	);
}

function renderInstalledPanel(): TemplateResult {
	const builtinPacks = installed.filter((p) => p.builtin);
	const scopesWithPacks = SCOPE_ORDER.filter((s) => packsForScope(s).length > 0);
	const isEmpty = builtinPacks.length === 0 && scopesWithPacks.length === 0;
	return html`
		<section class="market-panel" data-testid="market-installed-panel">
			<h2 class="market-panel-title">${icon(Package, "sm")} Installed</h2>
			${installedError ? html`<div class="market-error" data-testid="market-installed-error">${installedError}</div>` : ""}
			${isEmpty
				? html`<p class="text-sm text-muted-foreground italic">No packs installed.</p>`
				: html`
					${builtinPacks.length > 0 ? renderBuiltinGroup(builtinPacks) : ""}
					${scopesWithPacks.map(renderScopeGroup)}
				`}
		</section>
	`;
}

/** Built-in first-party packs (§7.4) — their own top group. Shipped/core, so the
 *  cards offer enable/disable toggles only (no Uninstall/Update/reorder). */
function renderBuiltinGroup(packs: InstalledPackWire[]): TemplateResult {
	return html`
		<div class="flex flex-col gap-1.5 mb-3" data-testid="market-builtin-group">
			<div class="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
				Built-in (shipped)
			</div>
			<div class="text-[10px] text-muted-foreground/80 -mt-0.5">Core features that ship with Bobbit. Disable to remove a feature; re-enable any time.</div>
			${packs.map(renderBuiltinPackCard)}
		</div>
	`;
}

/** A built-in first-party pack card (§7.4): toggle-only. No Uninstall/Update/
 *  reorder (not in `pack_order`, no install ledger). When a user-installed pack of
 *  the same name wins resolution (§6.4), the built-in row is SHADOWED — its server
 *  activation entry is moot, so the live toggles are suppressed and the winning
 *  installed row keeps its toggles. */
function renderBuiltinPackCard(pack: InstalledPackWire): TemplateResult {
	const isCorrupt = pack.status === "corrupt";
	const shadowed = builtinRowShadowed(pack.packName);
	return html`
		<div
			class="market-pack-card"
			data-testid="market-installed-pack"
			data-pack-name=${pack.packName}
			data-scope=${pack.scope}
			data-builtin="true"
		>
			<div class="flex items-start justify-between gap-3">
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2 flex-wrap">
						<span class="text-sm font-semibold">${pack.packName}</span>
						<span class="market-builtin-badge" data-testid="market-pack-builtin-badge">Built-in</span>
						<span class="text-[11px] text-muted-foreground">v${pack.meta?.version || pack.manifest?.version || "?"}</span>
						${isCorrupt ? html`<span class="market-corrupt" data-testid="market-pack-corrupt">${icon(AlertTriangle, "xs")} corrupt</span>` : ""}
					</div>
					${pack.manifest?.description ? html`<div class="text-xs text-muted-foreground mt-0.5">${pack.manifest.description}</div>` : ""}
				</div>
				${shadowed ? "" : renderPackActivationSummary(pack)}
			</div>
			${shadowed
				? html`<div class="market-activation-help text-[11px] text-muted-foreground/70 italic mt-2" data-testid="market-builtin-shadowed">Shadowed by an installed pack — manage activation on the installed copy.</div>`
				: isHindsightWizardOpenFor(pack)
					? renderHindsightWizard(pack)
					: html`${pack.packName === HINDSIGHT_PACK ? renderHindsightStatusStrip(pack) : ""}${renderActivationControls(pack)}${renderActivationEntityDetails(pack)}`}
		</div>
	`;
}

function renderScopeGroup(scope: MarketScope): TemplateResult {
	const packs = packsForScope(scope);
	return html`
		<div class="flex flex-col gap-1.5 mb-3" data-testid="market-scope-group" data-scope=${scope}>
			<div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">${scopeLabel(scope)}</div>
			${packs.map((p, i) => renderInstalledPackCard(p, scope, i, packs.length))}
		</div>
	`;
}

function renderInstalledPackCard(pack: InstalledPackWire, scope: MarketScope, index: number, total: number): TemplateResult {
	const key = `${pack.scope}:${pack.packName}`;
	const isBusy = busy.has(key);
	const packConflicts = conflictsForPack(pack);
	const hasConflict = packConflicts.length > 0;
	const expanded = expandedConflicts.has(key);
	const isCorrupt = pack.status === "corrupt";
	const dragging = dragScope === scope && dragFromIndex === index;
	const dropTarget = dragScope === scope && dragOverIndex === index && dragFromIndex !== index;

	return html`
		<div
			class="market-pack-card ${dragging ? "opacity-50" : ""} ${dropTarget ? "market-pack-card--drop" : ""}"
			data-testid="market-installed-pack"
			data-pack-name=${pack.packName}
			data-scope=${scope}
			draggable="true"
			@dragstart=${(e: DragEvent) => handleDragStart(e, scope, index)}
			@dragover=${(e: DragEvent) => handleDragOver(e, scope, index)}
			@drop=${() => handleDrop(scope)}
			@dragend=${resetDrag}
		>
			<div class="flex items-start gap-2">
				<span class="market-grip" title="Drag to reorder (changes precedence)">${icon(GripVertical, "xs")}</span>
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2 flex-wrap">
						<span class="text-sm font-semibold">${pack.packName}</span>
						<span class="text-[11px] text-muted-foreground">v${pack.meta?.version || pack.manifest?.version || "?"}</span>
						${isCorrupt ? html`<span class="market-corrupt" data-testid="market-pack-corrupt">${icon(AlertTriangle, "xs")} corrupt</span>` : ""}
						${hasConflict ? html`<button class="market-conflict-icon" data-testid="market-conflict-warning" title="Same-name conflict" @click=${() => { expanded ? expandedConflicts.delete(key) : expandedConflicts.add(key); renderApp(); }}>${icon(AlertTriangle, "xs")} conflict</button>` : ""}
					</div>
					${pack.manifest?.description ? html`<div class="text-xs text-muted-foreground mt-0.5">${pack.manifest.description}</div>` : ""}
					${renderProvenance(pack)}
					${expanded && hasConflict ? renderConflictDetails(packConflicts) : ""}
					${renderActivationControls(pack)}
					${renderActivationEntityDetails(pack)}
				</div>
				<div class="flex flex-col items-end gap-1 shrink-0">
					<div class="flex items-center gap-1">
						<button class="market-icon-btn" data-testid="market-move-up" title="Move up (lower precedence)" ?disabled=${index === 0} @click=${() => movePack(scope, pack.packName, -1)}>${icon(ChevronDown, "xs", "rotate-180")}</button>
						<button class="market-icon-btn" data-testid="market-move-down" title="Move down (higher precedence)" ?disabled=${index === total - 1} @click=${() => movePack(scope, pack.packName, 1)}>${icon(ChevronDown, "xs")}</button>
					</div>
					<div class="flex items-center gap-1">
						${pack.updateAvailable
							? html`<button class="market-btn" data-testid="market-update-pack" ?disabled=${isBusy} @click=${() => handleUpdate(pack)}>${icon(RotateCw, "xs", isBusy ? "animate-spin" : "")} Update</button>`
							: pack.sourceStatus === "unknown"
								? html`<span class="market-lozenge market-lozenge--warning" data-testid="market-source-unknown" title="The originating source is not registered or has not been synced — can't check for updates">${icon(AlertTriangle, "xs")} Source not found</span>`
								: ""}
						<button class="market-btn market-btn--danger" data-testid="market-uninstall-pack" ?disabled=${isBusy} @click=${() => handleUninstall(pack)}>${icon(Trash2, "xs")} Uninstall</button>
					</div>
				</div>
			</div>
		</div>
	`;
}

function renderProvenance(pack: InstalledPackWire): TemplateResult {
	const m = pack.meta;
	if (!m) return html``;
	const installed = m.installedAt ? new Date(m.installedAt).toLocaleDateString() : "?";
	const updated = m.updatedAt ? new Date(m.updatedAt).toLocaleDateString() : installed;
	return html`
		<div class="text-[10px] text-muted-foreground/90 mt-1 flex flex-wrap gap-x-3 gap-y-0.5" data-testid="market-provenance">
			<span title="Source">${m.sourceUrl}${m.sourceRef ? html`@${m.sourceRef}` : ""}</span>
			${m.commit ? html`<span title="Commit">commit ${m.commit.slice(0, 7)}</span>` : ""}
			<span title="Installed">installed ${installed}</span>
			${updated !== installed ? html`<span title="Updated">updated ${updated}</span>` : ""}
		</div>
	`;
}

/** Per-pack activation controls (pack schema V1 §9). Toggles ONLY user-facing
 *  entities — roles, tools, skills, entrypoints. Panels/routes/stores/renderers/
 *  actions/lib are support surfaces and are NOT toggleable (not shown as
 *  switches). Rendered SOLELY from the UNFILTERED `catalogue` returned by
 *  `GET /api/marketplace/pack-activation` (never from /api/tools or
 *  /api/ext/contributions), so a disabled entity stays visible + re-enableable;
 *  each toggle's checked state = `name ∉ disabled[kind]`. */
function renderPackActivationSummary(pack: InstalledPackWire): TemplateResult {
	const activation = activationByPack.get(`${pack.scope}:${pack.packName}`);
	if (!activation || activationEntityTotal(activation) === 0) return html``;
	const total = activationEntityTotal(activation);
	const enabled = activationEntityEnabledCount(activation);
	const label = enabled === total ? "Enabled" : enabled === 0 ? "Disabled" : "Partially enabled";
	const cacheKey = `${pack.scope}:${pack.packName}`;
	const busyKey = `activation:${cacheKey}:all`;
	return html`
		<label class="market-pack-activation-toggle" title="Enable or disable all pack entries">
			<span>${label}</span>
			<span class="market-toggle-switch market-toggle-switch--master">
				<input
					type="checkbox"
					data-testid="market-toggle-pack-${pack.packName}"
					.checked=${enabled > 0}
					?disabled=${busy.has(busyKey)}
					@change=${(e: Event) => handleMasterToggle(pack, e.target as HTMLInputElement)}
				/>
				<span class="market-toggle-slider"></span>
			</span>
		</label>
	`;
}

/** Master enable/disable toggle handler. For a DISABLED built-in Hindsight row,
 *  turning the pack ON launches the guided setup wizard INSTEAD of flipping the
 *  activation — the pack only becomes enabled when the wizard reaches Finish. All
 *  other packs (and disabling Hindsight) toggle activation directly. */
function handleMasterToggle(pack: InstalledPackWire, el: HTMLInputElement): void {
	const checked = el.checked;
	if (checked && shouldLaunchHindsightWizard(pack)) {
		// Intercept: the pack stays disabled (the bound `.checked` value is unchanged),
		// so lit will NOT reset the user-toggled checkbox — reset the DOM element directly
		// so the toggle does not appear "on" while the wizard (and after Cancel) is shown.
		el.checked = false;
		openHindsightWizard(pack);
		return;
	}
	void handleToggleAllActivation(pack, checked);
}

/** Whether clicking Enable on this row should launch the guided wizard rather than
 *  enabling immediately: a built-in `hindsight` row that is currently disabled.
 *  Consumes the sibling server `requiresGuidedSetup` field ADDITIVELY — only an
 *  explicit `false` opts out (absent/true ⇒ launch), so it works whether or not the
 *  default-disabled server change has merged. */
export function shouldLaunchHindsightWizard(pack: InstalledPackWire): boolean {
	if (!(pack.builtin && pack.packName === HINDSIGHT_PACK)) return false;
	if (hindsightEnabled(pack)) return false;
	const requiresGuided = (pack as { requiresGuidedSetup?: boolean }).requiresGuidedSetup;
	if (requiresGuided === false) return false;
	return true;
}

/** Every keyof DisabledRefs that the catalogue counts as a toggleable entity.
 *  Keeps the master-toggle total/enabled count in sync with the schema-v2
 *  arrays (so a managed runtime is part of "Enabled"/"Disabled"). */
const ACTIVATION_COUNT_KINDS: Array<keyof DisabledRefs> = [
	"roles", "tools", "skills", "entrypoints",
	"providers", "hooks", "mcp", "piExtensions", "runtimes", "workflows",
];

export function activationEntityTotal(activation: PackActivationResponse): number {
	const cat = activation.catalogue as Record<keyof DisabledRefs, unknown>;
	let total = 0;
	for (const kind of ACTIVATION_COUNT_KINDS) {
		const arr = cat[kind];
		if (Array.isArray(arr)) total += arr.length;
	}
	return total;
}

export function activationEntityEnabledCount(activation: PackActivationResponse): number {
	const disabled = activation.disabled || {};
	let disabledCount = 0;
	for (const kind of ACTIVATION_COUNT_KINDS) {
		disabledCount += (disabled[kind] ?? []).length;
	}
	return Math.max(0, activationEntityTotal(activation) - disabledCount);
}

function entrypointKindLabel(kind: PackActivationResponse["catalogue"]["entrypoints"][number]["kind"]): string {
	switch (kind) {
		case "composer-slash": return "Slash";
		case "session-menu": return "Session menu";
		case "route": return "Route";
		default: return "Entry point";
	}
}

function entrypointDisplayLabel(entrypoint: PackActivationResponse["catalogue"]["entrypoints"][number]): string {
	if (entrypoint.kind === "route" && entrypoint.routeId) return `#/ext/${entrypoint.routeId}`;
	return entrypoint.label || entrypoint.listName;
}

function renderActivationEntityDetails(pack: InstalledPackWire): TemplateResult {
	const activation = activationByPack.get(`${pack.scope}:${pack.packName}`);
	if (!activation) return html``;
	const cat = activation.catalogue;
	return renderEntityDetails(pack.packName, cat.descriptions, {
		roles: cat.roles,
		tools: cat.tools,
		skills: cat.skills,
		entrypoints: cat.entrypoints.map((e) => ({ listName: e.listName, label: entrypointDisplayLabel(e) })),
	});
}

function renderActivationControls(pack: InstalledPackWire): TemplateResult {
	const activation = activationByPack.get(`${pack.scope}:${pack.packName}`);
	if (!activation) return html``;
	const cat = activation.catalogue;
	const disabled = activation.disabled || {};
	const isEnabled = (kindKey: keyof DisabledRefs, name: string) => !(disabled[kindKey] ?? []).includes(name);

	const toggle = (
		kind: ActivationKind,
		name: string,
		label: string,
		kindLabel?: string,
	): TemplateResult => {
		const kindKey = ACTIVATION_KIND_KEY[kind];
		const checked = isEnabled(kindKey, name);
		const busyKey = `activation:${pack.scope}:${pack.packName}:${kind}:${name}`;
		return html`
			<label class="market-activation-toggle ${checked ? "" : "market-activation-toggle--off"}" title=${kindLabel ? `${kindLabel}: ${name}` : `${kind}: ${name}`}>
				<span class="market-toggle-switch">
					<input
						type="checkbox"
						data-testid="market-toggle-${kind}-${name}"
						.checked=${checked}
						?disabled=${busy.has(busyKey)}
						@change=${(e: Event) => handleToggleActivation(pack, kind, name, (e.target as HTMLInputElement).checked)}
					/>
					<span class="market-toggle-slider"></span>
				</span>
				${kindLabel ? html`<span class="market-entrypoint-kind">${kindLabel}</span>` : ""}
				<span class="market-activation-label">${label}</span>
			</label>
		`;
	};

	const group = (title: string, toggles: TemplateResult[]): TemplateResult => html`
		<div class="market-activation-group">
			<div class="market-activation-group-title">${title}</div>
			<div class="market-activation-toggles">${toggles}</div>
		</div>
	`;

	const groups: TemplateResult[] = [];
	if (cat.roles.length) groups.push(group("Roles", cat.roles.map((n) => toggle("role", n, n))));
	if (cat.tools.length) groups.push(group("Tools", cat.tools.map((n) => toggle("tool", n, n))));
	if (cat.skills.length) groups.push(group("Skills", cat.skills.map((n) => toggle("skill", n, n))));
	if (cat.entrypoints.length) {
		groups.push(group("Entry points", cat.entrypoints.map((e) => toggle("entrypoint", e.listName, entrypointDisplayLabel(e), entrypointKindLabel(e.kind)))));
	}
	// Schema-v2 toggleable arrays (present only for schema≥2 packs).
	if (cat.providers?.length) groups.push(group("Providers", cat.providers.map((n) => toggle("provider", n, n))));
	if (cat.hooks?.length) groups.push(group("Hooks", cat.hooks.map((n) => toggle("hook", n, n))));
	if (cat.mcp?.length) groups.push(group("MCP servers", cat.mcp.map((n) => toggle("mcp", n, n))));
	if (cat.piExtensions?.length) groups.push(group("Extensions", cat.piExtensions.map((n) => toggle("pi-extension", n, n))));
	if (cat.workflows?.length) groups.push(group("Workflows", cat.workflows.map((n) => toggle("workflow", n, n))));
	// Managed runtimes get an explicit consent enable-card per runtime (design §8):
	// the toggle is the explicit on-enable start action, so the disclosure (images/
	// services, ports, volume path, memory/trust copy) renders inline with it.
	if (cat.runtimes?.length) {
		groups.push(html`
			<div class="market-activation-group">
				<div class="market-activation-group-title">Runtimes</div>
				<div class="market-runtime-rows">
					${cat.runtimes.map((runtimeId) => renderRuntimeRow(pack, runtimeId, isEnabled("runtimes", runtimeId)))}
				</div>
			</div>
		`);
	}
	if (groups.length === 0) return html``;

	return html`
		<div class="market-activation" data-testid="market-activation-${pack.packName}">
			${groups}
		</div>
	`;
}

/** A managed-runtime activation row: the explicit on-enable toggle plus the
 *  consent enable-card disclosing what starting it does (design §8). */
function renderRuntimeRow(pack: InstalledPackWire, runtimeId: string, checked: boolean): TemplateResult {
	ensureRuntimeCapabilities(pack, runtimeId);
	const busyKey = `activation:${pack.scope}:${pack.packName}:runtime:${runtimeId}`;
	return html`
		<div class="market-runtime-row" data-testid="market-runtime-${runtimeId}">
			<label class="market-activation-toggle ${checked ? "" : "market-activation-toggle--off"}" title=${`runtime: ${runtimeId}`}>
				<span class="market-toggle-switch">
					<input
						type="checkbox"
						data-testid="market-toggle-runtime-${runtimeId}"
						.checked=${checked}
						?disabled=${busy.has(busyKey)}
						@change=${(e: Event) => handleToggleActivation(pack, "runtime", runtimeId, (e.target as HTMLInputElement).checked)}
					/>
					<span class="market-toggle-slider"></span>
				</span>
				<span class="market-entrypoint-kind">Runtime</span>
				<span class="market-activation-label">${runtimeId}</span>
			</label>
			${renderRuntimeConsentCard(pack, runtimeId)}
		</div>
	`;
}

/** The consent enable-card for a managed runtime (looks up the cached capability
 *  summary, then defers to the pure {@link renderRuntimeConsentCardView}).
 *  Exported for the staleness regression test. */
export function renderRuntimeConsentCard(pack: InstalledPackWire, runtimeId: string): TemplateResult {
	const projectId = pack.scope === "project" ? currentProjectId() : undefined;
	const key = runtimeCapabilityCacheKey(pack.scope, runtimeRestPackId(pack), runtimeId, projectId);
	return renderRuntimeConsentCardView(runtimeId, runtimeCapabilities.get(key));
}

/** Pure view for the managed-runtime consent enable-card. Discloses images/
 *  services, host ports, the data/volume path and the memory/trust copy BEFORE
 *  enabling (design §8). External (no-Docker) mode shows setup guidance instead.
 *  Renders from the capability summary when available, else static fallback copy.
 *  Exported for focused render tests (no module state / fetch). */
export function renderRuntimeConsentCardView(runtimeId: string, cap: PackRuntimeCapabilitySummary | null | undefined): TemplateResult {
	const external = cap?.dockerRequired === false;
	const services = cap?.services ?? [];
	const ports = cap?.ports ?? [];
	const volumePath = cap?.volumePath;
	const trust = cap?.trust || RUNTIME_MEMORY_DISCLOSURE;

	if (external) {
		return html`
			<div class="market-runtime-card market-runtime-card--external" data-testid="market-runtime-card-${runtimeId}">
				<div class="market-runtime-card-title">${icon(Database, "xs")} External mode — no Docker</div>
				<p class="market-runtime-card-text" data-testid="market-runtime-external-guidance">${RUNTIME_EXTERNAL_GUIDANCE}</p>
			</div>
		`;
	}

	// The server only fills `host` once a stable loopback port is persisted; `container`
	// is informational. Render a `127.0.0.1:<port>` loopback URL ONLY for an allocated
	// host port — otherwise disclose the host port is allocated on enable (showing the
	// container port separately when known) so we never imply a loopback bind that does
	// not exist yet.
	const portText = ports.length
		? ports.map((p) => {
			const label = p.env || p.key;
			const prefix = label ? `${label}: ` : "";
			if (typeof p.host === "number") return `${prefix}127.0.0.1:${p.host}`;
			if (typeof p.container === "number") return `${prefix}container :${p.container}, host port allocated on enable`;
			return `${prefix}allocated on enable`;
		}).join(", ")
		: "loopback ports allocated on enable";
	const serviceText = services.length ? services.join(", ") : "api, db";

	return html`
		<div class="market-runtime-card" data-testid="market-runtime-card-${runtimeId}">
			<div class="market-runtime-card-title">${icon(Database, "xs")} Enabling starts a local Docker runtime</div>
			<dl class="market-runtime-card-grid">
				<dt>Services</dt>
				<dd data-testid="market-runtime-services">${serviceText}</dd>
				<dt>Ports</dt>
				<dd data-testid="market-runtime-ports">${portText}</dd>
				<dt>Data</dt>
				<dd data-testid="market-runtime-volume">${volumePath || "~/.hindsight"}</dd>
			</dl>
			<p class="market-runtime-card-text" data-testid="market-runtime-trust">${trust}</p>
		</div>
	`;
}

// ============================================================================
// HINDSIGHT BUILT-IN ROW — derived state badge + state-aware action bar
// (design hindsight-ux-polish §5.2). Read-only derivation; the ONLY Docker-start
// path is the explicit Start-runtime click gated behind the consent disclosure.
// ============================================================================

/** The eight-state model shared with the panel badge (design D1). `unknown` covers
 *  the pre-load window (status not yet read / no active session to read it). */
export type HindsightUiState =
	| "disabled"
	| "dormant"
	| "external-connected"
	| "external-unreachable"
	| "managed-stopped"
	| "managed-starting"
	| "managed-running"
	| "managed-unhealthy"
	| "unknown";

/** Pure derivation feeding the marketplace badge (and mirrored by the panel). Exported
 *  for focused unit tests. Combines activation (Disabled), the pack `status` route
 *  (Dormant / External connected|unreachable) and the managed runtime supervisor status
 *  (Managed stopped|starting|running|unhealthy). NEVER starts Docker — pure projection. */
export function deriveHindsightState(opts: {
	enabled: boolean;
	statusLoaded: boolean;
	status: HindsightStatusWire | null;
	runtime: PackRuntimeStatus | undefined;
}): HindsightUiState {
	if (!opts.enabled) return "disabled";
	const s = opts.status;
	if (!opts.statusLoaded || !s) return "unknown";
	if (!s.configured) return "dormant";
	const mode = s.mode || "external";
	const managed = mode === "managed" || mode === "managed-external-postgres";
	if (!managed) return s.healthy ? "external-connected" : "external-unreachable";
	// Managed: prefer the live supervisor status; fall back to the health probe.
	const rs = opts.runtime?.status;
	if (rs === "running") return s.healthy === false ? "managed-unhealthy" : "managed-running";
	if (rs === "starting") return "managed-starting";
	if (rs === "unhealthy") return "managed-unhealthy";
	if (rs === "stopped" || rs === "docker-unavailable") return "managed-stopped";
	return s.healthy ? "managed-running" : "managed-stopped";
}

/** Badge presentation for a derived state. Colour is NEVER the only signal — each
 *  state pairs a semantic theme token with a distinct icon + plain-language blurb. */
function hindsightStateMeta(state: HindsightUiState): { label: string; token: string; icon: typeof Circle; blurb: string } {
	switch (state) {
		case "disabled":
			return { label: "Disabled", token: "var(--muted-foreground)", icon: Circle, blurb: "Pack disabled — enable it to use memory." };
		case "dormant":
			return { label: "Not configured", token: "var(--warning, var(--chart-4))", icon: AlertTriangle, blurb: "Dormant until you configure a Hindsight deployment." };
		case "external-connected":
			return { label: "Connected (external)", token: "var(--positive)", icon: CheckCircle2, blurb: "Talking to an external Hindsight data plane." };
		case "external-unreachable":
			return { label: "Unreachable (external)", token: "var(--negative, var(--destructive))", icon: XCircle, blurb: "Configured for external mode but the API did not respond." };
		case "managed-stopped":
			return { label: "Stopped (managed)", token: "var(--muted-foreground)", icon: Square, blurb: "Managed runtime configured but not running — Start it to bring Docker up." };
		case "managed-starting":
			return { label: "Starting (managed)", token: "var(--info)", icon: RotateCw, blurb: "Managed Docker runtime is starting up." };
		case "managed-running":
			return { label: "Running (managed)", token: "var(--positive)", icon: CheckCircle2, blurb: "Managed Docker runtime is running and healthy." };
		case "managed-unhealthy":
			return { label: "Unhealthy (managed)", token: "var(--negative, var(--destructive))", icon: XCircle, blurb: "Managed runtime is up but failing health checks." };
		default:
			return { label: "Checking…", token: "var(--muted-foreground)", icon: RotateCw, blurb: "Reading the current Hindsight state." };
	}
}

/** The managed runtime status row for the built-in Hindsight pack (if any). */
function hindsightRuntime(): PackRuntimeStatus | undefined {
	return hindsightRuntimes.find((r) => r.runtimeId === HINDSIGHT_RUNTIME && (r.packId === HINDSIGHT_PACK || r.packName === HINDSIGHT_PACK));
}

/** Whether the built-in Hindsight pack/runtime activation is on. */
function hindsightEnabled(pack: InstalledPackWire): boolean {
	const activation = activationByPack.get(`${pack.scope}:${pack.packName}`);
	if (!activation) return true; // assume enabled until the catalogue resolves
	return activationEntityEnabledCount(activation) > 0;
}

/** The built-in Hindsight row's state badge + active-config summary + action bar. */
function renderHindsightStatusStrip(pack: InstalledPackWire): TemplateResult {
	const runtime = hindsightRuntime();
	const state = deriveHindsightState({
		enabled: hindsightEnabled(pack),
		statusLoaded: hindsightStatusLoaded,
		status: hindsightStatus,
		runtime,
	});
	const meta = hindsightStateMeta(state);
	const s = hindsightStatus;
	const managed = state.startsWith("managed-");
	const isManagedMode = s?.mode === "managed" || s?.mode === "managed-external-postgres";

	return html`
		<div class="market-hindsight-strip" data-testid="market-hindsight-strip" data-state=${state}>
			<div class="flex items-center gap-1.5 flex-wrap">
				<span
					class="market-lozenge"
					data-testid="market-hindsight-state"
					data-state=${state}
					style=${`border-color: color-mix(in oklch, ${meta.token} 35%, transparent); background: color-mix(in oklch, ${meta.token} 12%, transparent); color: ${meta.token};`}
					title=${meta.blurb}
				>${icon(meta.icon, "xs", state === "managed-starting" || state === "unknown" ? "animate-spin" : "")} ${meta.label}</span>
				${hindsightActionResult
					? html`<span
							class="market-lozenge ${hindsightActionResult.ok ? "" : "market-lozenge--warning"}"
							data-testid="market-hindsight-action-result"
							style=${hindsightActionResult.ok ? "border-color: color-mix(in oklch, var(--positive) 35%, transparent); background: color-mix(in oklch, var(--positive) 12%, transparent); color: var(--positive);" : ""}
						>${icon(hindsightActionResult.ok ? CheckCircle2 : XCircle, "xs")} ${hindsightActionResult.message}</span>`
					: ""}
			</div>
			<div class="text-[11px] text-muted-foreground mt-1" data-testid="market-hindsight-blurb">${meta.blurb}</div>
			${renderHindsightConfigSummary()}
			${renderHindsightActions(pack, state, managed, isManagedMode)}
			${hindsightConfigFormOpen ? renderHindsightConfigForm(pack) : ""}
			${hindsightStartConsentOpen && state === "managed-stopped"
				? html`<div class="mt-2" data-testid="market-hindsight-start-consent">
						${renderRuntimeConsentCard(pack, HINDSIGHT_RUNTIME)}
						<div class="flex items-center gap-2 mt-2">
							<button class="market-btn market-btn--primary" data-testid="market-hindsight-start-confirm" ?disabled=${busy.has("hindsight:start")} @click=${() => handleHindsightStart(pack)}>${icon(Play, "xs")} Start (starts Docker)</button>
							<button class="market-btn" data-testid="market-hindsight-start-cancel" @click=${() => { hindsightStartConsentOpen = false; renderApp(); }}>Cancel</button>
						</div>
					</div>`
				: ""}
			${hindsightLogs !== null
				? html`<details class="market-hindsight-logs mt-2" data-testid="market-hindsight-logs" open>
						<summary>Runtime logs</summary>
						<pre class="market-hindsight-logs-pre">${hindsightLogs || "(no output)"}</pre>
					</details>`
				: ""}
		</div>
	`;
}

/** Active configured values surfaced prominently on the row (data-plane URL,
 *  namespace, bank, recall/retain, timeout, queue depth). Read-only projection of the
 *  `status` route; shown once status has loaded and the pack is configured. */
function renderHindsightConfigSummary(): TemplateResult {
	const s = hindsightStatus;
	if (!s || !s.configured) return html``;
	const rows: Array<[string, string]> = [];
	if (s.mode) rows.push(["Mode", s.mode]);
	if (s.externalUrl) rows.push(["API URL", s.externalUrl]);
	if (s.bank) rows.push(["Bank", s.bank]);
	if (s.namespace) rows.push(["Namespace", s.namespace]);
	if (s.recallScope) rows.push(["Recall scope", s.recallScope === "project" ? "project (this project + shared/global)" : "all (every project)"]);
	rows.push(["Auto recall", s.autoRecall ? "on" : "off"]);
	rows.push(["Auto retain", s.autoRetain ? "on" : "off"]);
	if (typeof s.timeoutMs === "number") rows.push(["Timeout", `${s.timeoutMs}ms`]);
	if (typeof s.recallBudget === "number") rows.push(["Recall budget", String(s.recallBudget)]);
	if (typeof s.queueDepth === "number") rows.push(["Queue depth", String(s.queueDepth)]);
	if (rows.length === 0) return html``;
	return html`
		<dl class="market-hindsight-config" data-testid="market-hindsight-config">
			${rows.map(([k, v]) => html`<div class="market-hindsight-config-row"><dt>${k}</dt><dd>${v}</dd></div>`)}
		</dl>
		${hasHindsightProjectOverride()
			? html`<span class="market-lozenge market-hindsight-override-badge mt-1" data-testid="market-hindsight-override-active" title=${`Per-project memory override active for ${hindsightProjectName()}`}>${icon(Settings, "xs")} Project override active</span>`
			: ""}
		${(() => {
			const le = hindsightLastErrorText(s.lastError);
			return le ? html`<div class="market-error mt-1" data-testid="market-hindsight-last-error">${le}</div>` : "";
		})()}
	`;
}

/** Normalise the `status.lastError` field, which the route persists as a
 *  `{ message, ts }` diagnostic object, to a human string. Returns "" when there is
 *  no usable message so the row renders nothing rather than `[object Object]`. */
function hindsightLastErrorText(le: HindsightStatusWire["lastError"]): string {
	if (le == null) return "";
	if (typeof le === "string") return le.trim();
	if (typeof le === "object") {
		const msg = (le as { message?: unknown }).message;
		if (typeof msg === "string" && msg.trim()) return msg.trim();
	}
	return "";
}

/** State-aware action bar. Every action is an explicit click; Start stays gated behind
 *  the consent disclosure and is never auto-invoked. */
function renderHindsightActions(pack: InstalledPackWire, state: HindsightUiState, managed: boolean, isManagedMode: boolean): TemplateResult {
	const s = hindsightStatus;
	const configured = !!s?.configured;
	const testing = busy.has("hindsight:test");
	const stopping = busy.has("hindsight:stop");
	const loadingLogs = busy.has("hindsight:logs");
	const canStop = state === "managed-running" || state === "managed-unhealthy" || state === "managed-starting";
	return html`
		<div class="market-hindsight-actions flex items-center gap-1.5 flex-wrap mt-2" data-testid="market-hindsight-actions">
			<button class="market-btn market-btn--primary" data-testid="market-hindsight-configure" aria-expanded=${hindsightConfigFormOpen ? "true" : "false"} @click=${() => toggleHindsightConfigForm(pack)}>${icon(Settings, "xs")} Configure</button>
			<button class="market-btn" data-testid="market-hindsight-test" ?disabled=${testing || !configured} @click=${() => handleHindsightTest()}>${icon(Plug, "xs", testing ? "animate-spin" : "")} Test connection</button>
			${s?.uiUrl
				? html`<a class="market-btn" data-testid="market-hindsight-open-ui" href=${s.uiUrl} target="_blank" rel="noopener noreferrer">${icon(ExternalLink, "xs")} Open Hindsight UI</a>`
				: ""}
			${isManagedMode && state === "managed-stopped"
				? html`<button class="market-btn" data-testid="market-hindsight-start" @click=${() => { hindsightStartConsentOpen = true; ensureRuntimeCapabilities(pack, HINDSIGHT_RUNTIME); renderApp(); }}>${icon(Play, "xs")} Start runtime</button>`
				: ""}
			${managed && canStop
				? html`<button class="market-btn" data-testid="market-hindsight-stop" ?disabled=${stopping} @click=${() => handleHindsightStop(pack)}>${icon(Square, "xs", stopping ? "animate-spin" : "")} Stop runtime</button>`
				: ""}
			${isManagedMode
				? html`<button class="market-btn" data-testid="market-hindsight-logs-btn" ?disabled=${loadingLogs} @click=${() => handleHindsightLogs(pack)}>${icon(ScrollText, "xs", loadingLogs ? "animate-spin" : "")} View logs</button>`
				: ""}
		</div>
	`;
}

/** Open the native Hindsight config/status panel — the in-session setup path, still
 *  reachable from the command palette / git-widget panel entrypoints. The Marketplace
 *  Configure button uses the inline form ({@link toggleHindsightConfigForm}) instead,
 *  because `#/market` has no active chat session to mount a pack side-panel against. */
function openHindsightPanel(): void {
	void import("./pack-panels.js").then((m) => m.openPackPanel({ panelId: HINDSIGHT_PANEL_ID }, HINDSIGHT_PACK));
}
void openHindsightPanel; // retained: the in-session panel path is unchanged.

/** Default the inline form values (used when the config read hasn't populated a field). */
function defaultHindsightForm(): HindsightConfigFormValues {
	return {
		mode: "external",
		externalUrl: "",
		uiUrl: "",
		bank: "bobbit",
		namespace: "default",
		recallScope: "project",
		autoRecall: true,
		autoRetain: true,
		timeoutMs: "1500",
		recallBudget: "1200",
		apiKey: "",
	};
}

/** Toggle the inline Configure form. Opening hydrates it from the `config` route over
 *  the SESSIONLESS built-in seam (pure read, no Docker). */
function toggleHindsightConfigForm(pack: InstalledPackWire): void {
	if (hindsightConfigFormOpen) {
		hindsightConfigFormOpen = false;
		renderApp();
		return;
	}
	hindsightConfigFormOpen = true;
	hindsightConfigResult = null;
	renderApp();
	void loadHindsightConfigForm(pack);
}

/** Hydrate the inline form + the touched-field baseline from the `config` route GET.
 *  The apiKey input ALWAYS loads blank (the secret is never echoed); leaving it blank
 *  keeps the stored secret on save. */
async function loadHindsightConfigForm(pack: InstalledPackWire): Promise<void> {
	// Always pass the current projectId for the built-in row so the route can return
	// the EFFECTIVE config + the per-project override metadata (when supported).
	const projectId = currentProjectId();
	const res = await readBuiltinPackRoute<HindsightConfigGetWire>({
		packId: runtimeRestPackId(pack),
		routeName: "config",
		projectId,
	});
	const base = defaultHindsightForm();
	if (res.ok && res.data) applyHindsightOverrideMeta(res.data, projectId);
	// Seed the editable per-project override form from the stored overlay ("" =
	// inherit global). Done here (Configure open) rather than in the background load.
	const ov = hindsightProjectOverride;
	hindsightOverrideForm = { recallScope: ov?.recallScope ?? "", bank: ov?.bank ?? "" };
	hindsightOverrideResult = null;
	if (res.ok && res.data?.config) {
		const c = res.data.config;
		const form: HindsightConfigFormValues = {
			mode: c.mode ?? base.mode,
			externalUrl: c.externalUrl ?? "",
			uiUrl: c.uiUrl ?? "",
			bank: c.bank ?? base.bank,
			namespace: c.namespace ?? base.namespace,
			recallScope: c.recallScope ?? base.recallScope,
			autoRecall: typeof c.autoRecall === "boolean" ? c.autoRecall : base.autoRecall,
			autoRetain: typeof c.autoRetain === "boolean" ? c.autoRetain : base.autoRetain,
			timeoutMs: typeof c.timeoutMs === "number" ? String(c.timeoutMs) : base.timeoutMs,
			recallBudget: typeof c.recallBudget === "number" ? String(c.recallBudget) : base.recallBudget,
			apiKey: "",
		};
		hindsightConfigApiKeySet = !!c.apiKeySet;
		hindsightConfigForm = form;
		hindsightConfigLoaded = { ...form };
	} else {
		hindsightConfigApiKeySet = false;
		hindsightConfigForm = base;
		hindsightConfigLoaded = { ...base };
	}
	renderApp();
}

/** Mutate one inline-form field (string/boolean) and repaint. */
function setHindsightFormField<K extends keyof HindsightConfigFormValues>(key: K, value: HindsightConfigFormValues[K]): void {
	if (!hindsightConfigForm) hindsightConfigForm = defaultHindsightForm();
	hindsightConfigForm = { ...hindsightConfigForm, [key]: value };
	renderApp();
}

/** Build the POST body with TOUCHED-FIELD semantics: include a field ONLY when its
 *  current input differs from the loaded baseline. The apiKey baseline is "" — an
 *  untouched blank input is therefore never sent, so it cannot clobber a stored
 *  secret; an explicitly cleared field that previously held a non-empty loaded value
 *  is sent as "" to clear it. */
function buildHindsightConfigDiff(form: HindsightConfigFormValues, loaded: HindsightConfigFormValues): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	if (form.mode !== loaded.mode) body.mode = form.mode;
	if (form.externalUrl !== loaded.externalUrl) body.externalUrl = form.externalUrl;
	if (form.uiUrl !== loaded.uiUrl) body.uiUrl = form.uiUrl;
	if (form.bank !== loaded.bank) body.bank = form.bank;
	if (form.namespace !== loaded.namespace) body.namespace = form.namespace;
	if (form.recallScope !== loaded.recallScope) body.recallScope = form.recallScope;
	if (form.autoRecall !== loaded.autoRecall) body.autoRecall = form.autoRecall;
	if (form.autoRetain !== loaded.autoRetain) body.autoRetain = form.autoRetain;
	if (form.timeoutMs !== loaded.timeoutMs) {
		const n = Number(form.timeoutMs);
		if (Number.isFinite(n) && n > 0) body.timeoutMs = n;
	}
	if (form.recallBudget !== loaded.recallBudget) {
		const n = Number(form.recallBudget);
		if (Number.isFinite(n) && n > 0) body.recallBudget = n;
	}
	// apiKey baseline is always "" — only sent when the user typed something.
	if (form.apiKey !== loaded.apiKey) body.apiKey = form.apiKey;
	return body;
}

/** Save the inline form via the SESSIONLESS config-write seam, then re-read status +
 *  config so the row + form reflect the persisted values. Shows an ok/error lozenge. */
async function handleHindsightConfigSave(pack: InstalledPackWire): Promise<void> {
	if (!hindsightConfigForm || !hindsightConfigLoaded) return;
	const body = buildHindsightConfigDiff(hindsightConfigForm, hindsightConfigLoaded);
	if (Object.keys(body).length === 0) {
		hindsightConfigResult = { ok: true, message: "No changes" };
		renderApp();
		return;
	}
	busy.add("hindsight:config");
	hindsightConfigResult = null;
	renderApp();
	const res = await writeBuiltinPackRoute<{ ok?: boolean; error?: string; errors?: string[] }>({
		packId: runtimeRestPackId(pack),
		routeName: "config",
		body,
		projectId: currentProjectId(),
	});
	busy.delete("hindsight:config");
	if (res.ok && res.data?.ok !== false) {
		hindsightConfigResult = { ok: true, message: "Saved" };
		// Re-hydrate the form baseline + the status/config row from the persisted state.
		await loadHindsightConfigForm(pack);
		await loadHindsightState();
	} else {
		const errs = res.ok ? (res.data?.errors ?? []).join("; ") : res.error;
		hindsightConfigResult = { ok: false, message: errs || "Save failed" };
	}
	renderApp();
}

/** Mutate one per-project override field and repaint. */
function setHindsightOverrideField(key: "recallScope" | "bank", value: string): void {
	if (!hindsightOverrideForm) hindsightOverrideForm = { recallScope: "", bank: "" };
	hindsightOverrideForm = { ...hindsightOverrideForm, [key]: value };
	renderApp();
}

/** Save the per-project memory override via the config route's `projectOverride`
 *  payload (design hindsight-memory-quality). "" recallScope / "" bank CLEAR that key
 *  back to the global value. The global config write path is untouched — this only
 *  ever sends the `projectOverride` envelope, scoped to the current projectId. */
async function handleHindsightOverrideSave(pack: InstalledPackWire): Promise<void> {
	if (!hindsightOverrideForm) return;
	const projectId = currentProjectId();
	if (!projectId) {
		hindsightOverrideResult = { ok: false, message: "No active project" };
		renderApp();
		return;
	}
	const f = hindsightOverrideForm;
	// Empty ⇒ null (clear → inherit global). Non-empty ⇒ the override value.
	const projectOverride: Record<string, unknown> = {
		recallScope: f.recallScope ? f.recallScope : null,
		bank: f.bank.trim() ? f.bank.trim() : null,
	};
	busy.add("hindsight:override");
	hindsightOverrideResult = null;
	renderApp();
	const res = await writeBuiltinPackRoute<{ ok?: boolean; error?: string; errors?: string[] }>({
		packId: runtimeRestPackId(pack),
		routeName: "config",
		body: { projectOverride },
		projectId,
	});
	busy.delete("hindsight:override");
	if (res.ok && res.data?.ok !== false) {
		// loadHindsightConfigForm resets hindsightOverrideResult to null, so set the
		// success lozenge AFTER re-hydrating the form to keep it visible.
		await loadHindsightConfigForm(pack);
		await loadHindsightState();
		hindsightOverrideResult = { ok: true, message: "Saved" };
	} else {
		const errs = res.ok ? (res.data?.errors ?? []).join("; ") : res.error;
		hindsightOverrideResult = { ok: false, message: errs || "Save failed" };
	}
	renderApp();
}

/** The compact per-project memory-override section in the inline Configure form.
 *  Hidden entirely unless the route exposed the overlay contract for a real project.
 *  Recall scope can inherit (global) or pin project/all; bank blank ⇒ inherit global. */
function renderHindsightOverrideSection(pack: InstalledPackWire): TemplateResult | string {
	if (!hindsightOverrideSupported || !hindsightOverrideProjectId) return "";
	const f = hindsightOverrideForm ?? { recallScope: "", bank: "" };
	const saving = busy.has("hindsight:override");
	const globalScope = hindsightGlobalConfig?.recallScope || "project";
	const globalBank = hindsightGlobalConfig?.bank || "bobbit";
	return html`
		<div class="market-hindsight-override mt-1 flex flex-col gap-2" data-testid="market-hindsight-override">
			<div class="market-field-label" style="font-weight:600;">Per-project override — ${hindsightProjectName()}</div>
			<div class="market-field-help">Overrides the global memory config for this project only. Recall scope: <code>project</code> = this project + shared/global memories; <code>all</code> = every project in the shared bank.</div>
			<div class="flex gap-2 flex-wrap">
				<label class="market-field flex-1">
					<span class="market-field-label">Recall scope (this project)</span>
					<select class="market-input" data-testid="market-hindsight-override-recallscope" .value=${f.recallScope} @change=${(e: Event) => setHindsightOverrideField("recallScope", (e.target as HTMLSelectElement).value)}>
						<option value="" ?selected=${f.recallScope === ""}>Inherit global (${globalScope})</option>
						<option value="project" ?selected=${f.recallScope === "project"}>project</option>
						<option value="all" ?selected=${f.recallScope === "all"}>all</option>
					</select>
				</label>
				<label class="market-field flex-1">
					<span class="market-field-label">Bank (this project)</span>
					<input class="market-input" type="text" data-testid="market-hindsight-override-bank" placeholder=${`inherit (${globalBank})`} .value=${f.bank} @input=${(e: Event) => setHindsightOverrideField("bank", (e.target as HTMLInputElement).value)} />
					<span class="market-field-help">Blank inherits the global bank.</span>
				</label>
			</div>
			<div class="flex items-center gap-2 flex-wrap">
				<button class="market-btn" data-testid="market-hindsight-override-save" ?disabled=${saving} @click=${() => handleHindsightOverrideSave(pack)}>${icon(saving ? RotateCw : CheckCircle2, "xs", saving ? "animate-spin" : "")} Save project override</button>
				${hindsightOverrideResult
					? html`<span
							class="market-lozenge ${hindsightOverrideResult.ok ? "" : "market-lozenge--warning"}"
							data-testid="market-hindsight-override-result"
							style=${hindsightOverrideResult.ok ? "border-color: color-mix(in oklch, var(--positive) 35%, transparent); background: color-mix(in oklch, var(--positive) 12%, transparent); color: var(--positive);" : ""}
						>${icon(hindsightOverrideResult.ok ? CheckCircle2 : XCircle, "xs")} ${hindsightOverrideResult.message}</span>`
					: ""}
			</div>
		</div>
	`;
}

/** The inline Configure form rendered in the Hindsight row. Mirrors the panel fields
 *  and distinguishes the API/data-plane URL (dialed by Bobbit) from the Dashboard UI
 *  URL (opened by humans, never dialed). */
function renderHindsightConfigForm(pack: InstalledPackWire): TemplateResult {
	const f = hindsightConfigForm;
	const saving = busy.has("hindsight:config");
	if (!f) {
		return html`<div class="market-hindsight-config-form mt-2" data-testid="market-hindsight-config-form"><div class="text-[11px] text-muted-foreground">Loading configuration…</div></div>`;
	}
	return html`
		<div class="market-hindsight-config-form mt-2 flex flex-col gap-2" data-testid="market-hindsight-config-form">
			<label class="market-field">
				<span class="market-field-label">Deployment mode</span>
				<select class="market-input" data-testid="market-hindsight-form-mode" .value=${f.mode} @change=${(e: Event) => setHindsightFormField("mode", (e.target as HTMLSelectElement).value)}>
					<option value="external" ?selected=${f.mode === "external"}>External (point at existing Hindsight)</option>
					<option value="managed" ?selected=${f.mode === "managed"}>Managed (Bobbit runs Hindsight + Postgres)</option>
					<option value="managed-external-postgres" ?selected=${f.mode === "managed-external-postgres"}>Managed + external Postgres</option>
				</select>
			</label>
			<label class="market-field">
				<span class="market-field-label">API / data-plane URL</span>
				<input class="market-input" type="text" data-testid="market-hindsight-form-externalurl" placeholder="http://localhost:9177" .value=${f.externalUrl} @input=${(e: Event) => setHindsightFormField("externalUrl", (e.target as HTMLInputElement).value)} />
				<span class="market-field-help">The data-plane URL Bobbit dials for recall/retain. Required for external mode.</span>
			</label>
			<label class="market-field">
				<span class="market-field-label">Dashboard UI URL</span>
				<input class="market-input" type="text" data-testid="market-hindsight-form-uiurl" placeholder="http://localhost:19177/banks/bobbit?view=data" .value=${f.uiUrl} @input=${(e: Event) => setHindsightFormField("uiUrl", (e.target as HTMLInputElement).value)} />
				<span class="market-field-help">The human-facing dashboard opened by "Open Hindsight UI". Never dialed by Bobbit.</span>
			</label>
			<div class="flex gap-2 flex-wrap">
				<label class="market-field flex-1">
					<span class="market-field-label">Bank</span>
					<input class="market-input" type="text" data-testid="market-hindsight-form-bank" .value=${f.bank} @input=${(e: Event) => setHindsightFormField("bank", (e.target as HTMLInputElement).value)} />
				</label>
				<label class="market-field flex-1">
					<span class="market-field-label">Namespace</span>
					<input class="market-input" type="text" data-testid="market-hindsight-form-namespace" .value=${f.namespace} @input=${(e: Event) => setHindsightFormField("namespace", (e.target as HTMLInputElement).value)} />
				</label>
			</div>
			<div class="flex gap-2 flex-wrap">
				<label class="market-field flex-1">
					<span class="market-field-label">Recall scope</span>
					<select class="market-input" data-testid="market-hindsight-form-recallscope" .value=${f.recallScope} @change=${(e: Event) => setHindsightFormField("recallScope", (e.target as HTMLSelectElement).value)}>
						<option value="project" ?selected=${f.recallScope === "project"}>project</option>
						<option value="all" ?selected=${f.recallScope === "all"}>all</option>
					</select>
					<span class="market-field-help">project = this project + shared/global memories; all = every project in the shared bank.</span>
				</label>
				<label class="market-field flex-1">
					<span class="market-field-label">Timeout (ms)</span>
					<input class="market-input" type="number" min="1" data-testid="market-hindsight-form-timeoutms" .value=${f.timeoutMs} @input=${(e: Event) => setHindsightFormField("timeoutMs", (e.target as HTMLInputElement).value)} />
				</label>
				<label class="market-field flex-1">
					<span class="market-field-label">Recall budget</span>
					<input class="market-input" type="number" min="1" data-testid="market-hindsight-form-recallbudget" .value=${f.recallBudget} @input=${(e: Event) => setHindsightFormField("recallBudget", (e.target as HTMLInputElement).value)} />
				</label>
			</div>
			<div class="flex gap-3 flex-wrap items-center">
				<label class="flex items-center gap-1.5 text-[12px]">
					<input type="checkbox" data-testid="market-hindsight-form-autorecall" .checked=${f.autoRecall} @change=${(e: Event) => setHindsightFormField("autoRecall", (e.target as HTMLInputElement).checked)} /> Auto recall
				</label>
				<label class="flex items-center gap-1.5 text-[12px]">
					<input type="checkbox" data-testid="market-hindsight-form-autoretain" .checked=${f.autoRetain} @change=${(e: Event) => setHindsightFormField("autoRetain", (e.target as HTMLInputElement).checked)} /> Auto retain
				</label>
			</div>
			<label class="market-field">
				<span class="market-field-label">API key ${hindsightConfigApiKeySet ? html`<span class="text-muted-foreground">(set — leave blank to keep)</span>` : html`<span class="text-muted-foreground">(blank)</span>`}</span>
				<input class="market-input" type="password" autocomplete="off" data-testid="market-hindsight-form-apikey" placeholder=${hindsightConfigApiKeySet ? "••••••••" : "optional"} .value=${f.apiKey} @input=${(e: Event) => setHindsightFormField("apiKey", (e.target as HTMLInputElement).value)} />
			</label>
			${renderHindsightOverrideSection(pack)}
			<div class="flex items-center gap-2 flex-wrap">
				<button class="market-btn market-btn--primary" data-testid="market-hindsight-config-save" ?disabled=${saving} @click=${() => handleHindsightConfigSave(pack)}>${icon(saving ? RotateCw : CheckCircle2, "xs", saving ? "animate-spin" : "")} Save configuration</button>
				<button class="market-btn" data-testid="market-hindsight-config-cancel" @click=${() => { hindsightConfigFormOpen = false; renderApp(); }}>Close</button>
				${hindsightConfigResult
					? html`<span
							class="market-lozenge ${hindsightConfigResult.ok ? "" : "market-lozenge--warning"}"
							data-testid="market-hindsight-config-result"
							style=${hindsightConfigResult.ok ? "border-color: color-mix(in oklch, var(--positive) 35%, transparent); background: color-mix(in oklch, var(--positive) 12%, transparent); color: var(--positive);" : ""}
						>${icon(hindsightConfigResult.ok ? CheckCircle2 : XCircle, "xs")} ${hindsightConfigResult.message}</span>`
					: ""}
			</div>
		</div>
	`;
}

/** Test connection == re-read the pack `status` route (pure, no Docker). Updates the
 *  cached status + a transient ok/fail lozenge. */
async function handleHindsightTest(): Promise<void> {
	busy.add("hindsight:test");
	hindsightActionResult = null;
	renderApp();
	let ok = false;
	let message = "Connection failed";
	const pack = installed.find((p) => p.builtin && p.packName === HINDSIGHT_PACK);
	if (pack) {
		// Re-read the pack `status` route over the SESSIONLESS built-in seam (pure read,
		// no Docker) — the marketplace has no active chat session to mint a surface token.
		const statusRes = await readBuiltinPackRoute<HindsightStatusWire>({
			packId: runtimeRestPackId(pack),
			routeName: "status",
			projectId: pack.scope === "project" ? currentProjectId() : undefined,
		});
		if (statusRes.ok) {
			const status = statusRes.data;
			hindsightStatus = status ?? null;
			hindsightStatusLoaded = true;
			ok = !!status?.healthy;
			message = ok ? "Connected" : status?.configured ? "Not reachable" : "Not configured";
		} else {
			message = statusRes.error || "Connection failed";
		}
	}
	busy.delete("hindsight:test");
	hindsightActionResult = { kind: "test", ok, message };
	renderApp();
}

/** Explicit managed-runtime start — the ONLY Docker-starting path from the marketplace.
 *  Fired only from the consent-disclosure confirm button (a deliberate second click). */
async function handleHindsightStart(pack: InstalledPackWire): Promise<void> {
	busy.add("hindsight:start");
	hindsightActionResult = null;
	renderApp();
	const res = await startPackRuntime({ packId: runtimeRestPackId(pack), runtimeId: HINDSIGHT_RUNTIME, projectId: pack.scope === "project" ? currentProjectId() : undefined });
	busy.delete("hindsight:start");
	hindsightStartConsentOpen = false;
	if (res.ok) {
		hindsightActionResult = { kind: "start", ok: true, message: "Runtime starting" };
	} else {
		hindsightActionResult = { kind: "start", ok: false, message: res.error };
	}
	renderApp();
	await loadHindsightState();
}

/** Stop the managed runtime (brings Docker down; preserves data). */
async function handleHindsightStop(pack: InstalledPackWire): Promise<void> {
	busy.add("hindsight:stop");
	hindsightActionResult = null;
	renderApp();
	const res = await stopPackRuntime({ packId: runtimeRestPackId(pack), runtimeId: HINDSIGHT_RUNTIME, projectId: pack.scope === "project" ? currentProjectId() : undefined });
	busy.delete("hindsight:stop");
	hindsightActionResult = res.ok ? { kind: "stop", ok: true, message: "Runtime stopped" } : { kind: "stop", ok: false, message: res.error };
	renderApp();
	await loadHindsightState();
}

/** View recent runtime logs inline (pure read). */
async function handleHindsightLogs(pack: InstalledPackWire): Promise<void> {
	if (hindsightLogs !== null) { hindsightLogs = null; renderApp(); return; }
	busy.add("hindsight:logs");
	renderApp();
	const res = await getPackRuntimeLogs({ packId: runtimeRestPackId(pack), runtimeId: HINDSIGHT_RUNTIME, projectId: pack.scope === "project" ? currentProjectId() : undefined, tail: 200 });
	busy.delete("hindsight:logs");
	hindsightLogs = res.ok ? res.data.logs : `Failed to load logs: ${res.error}`;
	renderApp();
}

// ============================================================================
// HINDSIGHT GUIDED SETUP WIZARD
// ============================================================================

const WIZARD_STEPS: Array<{ id: HindsightWizardStep; label: string }> = [
	{ id: "mode", label: "Mode" },
	{ id: "configure", label: "Configure" },
	{ id: "connect", label: "Connect" },
	{ id: "smoke", label: "Smoke test" },
];

function defaultWizardForm(): HindsightWizardForm {
	return {
		mode: "external",
		externalUrl: "",
		uiUrl: "",
		apiKey: "",
		llmApiKey: "",
		externalDatabaseUrl: "",
		dataDir: "~/.hindsight",
		bank: "bobbit",
		namespace: "default",
		recallScope: "project",
		autoRecall: true,
		autoRetain: true,
		timeoutMs: "1500",
		recallMaxInputChars: "3000",
	};
}

function isHindsightWizardOpenFor(pack: InstalledPackWire): boolean {
	return hindsightWizardOpen && hindsightWizardPackKey === `${pack.scope}:${pack.packName}`;
}

/** Wizard-scoped runtime capability cache, keyed by the SELECTED deployment mode so
 *  the managed consent disclosure reflects the wizard's chosen mode BEFORE config is
 *  persisted (the row-level {@link runtimeCapabilities} cache keys on the server's
 *  CURRENT effective mode, which is still dormant/external mid-wizard). */
const wizardRuntimeCap = new Map<string, PackRuntimeCapabilitySummary | null>();
const wizardRuntimeCapInFlight = new Set<string>();

function wizardCapKey(pack: InstalledPackWire, runtimeId: string, mode: string): string {
	return `${runtimeRestPackId(pack)}:${runtimeId}:${mode}`;
}

/** Lazily fetch the capability disclosure for the wizard's selected mode (a pure GET
 *  — never starts Docker). Best-effort: a missing route caches `null` and the card
 *  falls back to static copy. */
function ensureWizardCapabilities(pack: InstalledPackWire, runtimeId: string, mode: string): void {
	const key = wizardCapKey(pack, runtimeId, mode);
	if (wizardRuntimeCap.has(key) || wizardRuntimeCapInFlight.has(key)) return;
	wizardRuntimeCapInFlight.add(key);
	const projectId = pack.scope === "project" ? currentProjectId() : undefined;
	void getPackRuntimeCapabilities({ packId: runtimeRestPackId(pack), runtimeId, projectId, mode }).then((res) => {
		wizardRuntimeCapInFlight.delete(key);
		wizardRuntimeCap.set(key, res.ok ? res.data : null);
		renderApp();
	});
}

/** Open the guided wizard for a disabled built-in Hindsight row. Resets all wizard
 *  state to a fresh defaults form (nothing is persisted until the user runs the
 *  connect/start action or Finish). */
function openHindsightWizard(pack: InstalledPackWire): void {
	hindsightWizardOpen = true;
	hindsightWizardPackKey = `${pack.scope}:${pack.packName}`;
	hindsightWizardStep = "mode";
	hindsightWizardForm = defaultWizardForm();
	hindsightWizardConsent = false;
	hindsightWizardConfigSaved = false;
	hindsightWizardConnect = null;
	hindsightWizardSmoke = null;
	hindsightWizardError = "";
	renderApp();
}

/** Cancel/close the wizard. Persists nothing and leaves the pack disabled. */
function cancelHindsightWizard(): void {
	hindsightWizardOpen = false;
	hindsightWizardPackKey = null;
	hindsightWizardForm = null;
	hindsightWizardConsent = false;
	hindsightWizardConfigSaved = false;
	hindsightWizardConnect = null;
	hindsightWizardSmoke = null;
	hindsightWizardError = "";
	renderApp();
}

function setWizardField<K extends keyof HindsightWizardForm>(key: K, value: HindsightWizardForm[K]): void {
	if (!hindsightWizardForm) hindsightWizardForm = defaultWizardForm();
	hindsightWizardForm = { ...hindsightWizardForm, [key]: value };
	// Changing mode invalidates a prior connect/start result + consent.
	if (key === "mode") {
		hindsightWizardConnect = null;
		hindsightWizardSmoke = null;
		hindsightWizardConsent = false;
	}
	renderApp();
}

function wizardGoStep(step: HindsightWizardStep): void {
	hindsightWizardStep = step;
	renderApp();
}

/** Whether the Configure step has the minimum required fields for the chosen mode. */
function wizardConfigureReady(f: HindsightWizardForm): boolean {
	if (f.mode === "external") return f.externalUrl.trim().length > 0;
	if (f.mode === "managed-external-postgres") return f.externalDatabaseUrl.trim().length > 0;
	return true; // managed: dataDir is defaulted; the LLM key is recommended, not required
}

/** Build the config-route POST body for the chosen mode. Sends only the fields
 *  relevant to the mode + the always-relevant shared fields, so an empty optional
 *  secret never clobbers an unrelated stored value. */
function buildWizardConfigBody(f: HindsightWizardForm): Record<string, unknown> {
	const body: Record<string, unknown> = {
		mode: f.mode,
		bank: f.bank.trim() || "bobbit",
		namespace: f.namespace.trim() || "default",
		recallScope: f.recallScope,
		autoRecall: f.autoRecall,
		autoRetain: f.autoRetain,
	};
	const t = Number(f.timeoutMs);
	if (Number.isFinite(t) && t > 0) body.timeoutMs = t;
	const r = Number(f.recallMaxInputChars);
	if (Number.isFinite(r) && r > 0) body.recallMaxInputChars = r;
	if (f.mode === "external") {
		body.externalUrl = f.externalUrl.trim();
		if (f.uiUrl.trim()) body.uiUrl = f.uiUrl.trim();
		if (f.apiKey) body.apiKey = f.apiKey;
	} else {
		if (f.dataDir.trim()) body.dataDir = f.dataDir.trim();
		if (f.llmApiKey) body.llmApiKey = f.llmApiKey;
		if (f.mode === "managed-external-postgres" && f.externalDatabaseUrl.trim()) {
			body.externalDatabaseUrl = f.externalDatabaseUrl.trim();
		}
	}
	return body;
}

/** Persist the wizard's config via the SESSIONLESS config-write seam (the same path
 *  the inline Configure form uses). Sets {@link hindsightWizardError} + returns false
 *  on validation/save failure. */
async function persistWizardConfig(pack: InstalledPackWire): Promise<boolean> {
	if (!hindsightWizardForm) return false;
	const body = buildWizardConfigBody(hindsightWizardForm);
	const res = await writeBuiltinPackRoute<{ ok?: boolean; error?: string; errors?: string[] }>({
		packId: runtimeRestPackId(pack),
		routeName: "config",
		body,
		projectId: pack.scope === "project" ? currentProjectId() : undefined,
	});
	if (res.ok && res.data?.ok !== false) {
		hindsightWizardConfigSaved = true;
		hindsightWizardError = "";
		return true;
	}
	hindsightWizardError = res.ok ? ((res.data?.errors ?? []).join("; ") || res.data?.error || "Save failed") : res.error;
	return false;
}

/** EXTERNAL connect action: persist config, then re-read the `status` route (a PURE
 *  read — no Docker) so the health probe reflects the just-entered data-plane URL. */
async function handleWizardTest(pack: InstalledPackWire): Promise<void> {
	busy.add("hindsight:wizard");
	hindsightWizardConnect = null;
	hindsightWizardError = "";
	renderApp();
	const saved = await persistWizardConfig(pack);
	if (!saved) { busy.delete("hindsight:wizard"); renderApp(); return; }
	const statusRes = await readBuiltinPackRoute<HindsightStatusWire>({
		packId: runtimeRestPackId(pack),
		routeName: "status",
		projectId: pack.scope === "project" ? currentProjectId() : undefined,
	});
	busy.delete("hindsight:wizard");
	if (statusRes.ok) {
		hindsightStatus = statusRes.data ?? null;
		hindsightStatusLoaded = true;
		const ok = !!statusRes.data?.healthy;
		hindsightWizardConnect = { ok, message: ok ? "Connected" : "Unreachable — check the URL" };
	} else {
		hindsightWizardConnect = { ok: false, message: statusRes.error || "Connection failed" };
	}
	renderApp();
}

/** MANAGED connect action — the ONLY Docker-starting path in the wizard. Gated behind
 *  the consent tick; persists config, then issues a single explicit start. Polls the
 *  (pure) status reads afterward to surface stopped→starting→running progress. */
async function handleWizardStart(pack: InstalledPackWire): Promise<void> {
	if (!hindsightWizardConsent || !hindsightWizardForm) return;
	busy.add("hindsight:wizard");
	hindsightWizardConnect = null;
	hindsightWizardError = "";
	renderApp();
	const saved = await persistWizardConfig(pack);
	if (!saved) { busy.delete("hindsight:wizard"); renderApp(); return; }
	const res = await startPackRuntime({
		packId: runtimeRestPackId(pack),
		runtimeId: HINDSIGHT_RUNTIME,
		projectId: pack.scope === "project" ? currentProjectId() : undefined,
		mode: hindsightWizardForm.mode,
	});
	busy.delete("hindsight:wizard");
	if (res.ok) {
		hindsightWizardConnect = { ok: true, message: "Runtime starting…" };
		renderApp();
		await pollWizardManagedStatus(pack);
	} else {
		hindsightWizardConnect = { ok: false, message: res.error };
		renderApp();
	}
}

/** Poll the runtime/status reads (GET only — never starts Docker) until the managed
 *  runtime reaches a terminal state, so the connect step shows live progress. */
async function pollWizardManagedStatus(pack: InstalledPackWire): Promise<void> {
	for (let i = 0; i < 20 && isHindsightWizardOpenFor(pack); i++) {
		await loadHindsightState();
		const rt = hindsightRuntime();
		if (rt && (rt.status === "running" || rt.status === "unhealthy" || rt.status === "docker-unavailable")) break;
		await new Promise((r) => setTimeout(r, 1000));
	}
}

/** Best-effort SMOKE TEST: re-probe the `status` route end-to-end (the only data-plane
 *  round-trip reachable over the sessionless seam — recall/retain are POST-only and the
 *  sessionless seam allows POST only for `config`). Non-fatal: a failure shows a hint
 *  and the user can still Finish. */
async function handleWizardSmoke(pack: InstalledPackWire): Promise<void> {
	busy.add("hindsight:wizard");
	hindsightWizardSmoke = null;
	renderApp();
	const statusRes = await readBuiltinPackRoute<HindsightStatusWire>({
		packId: runtimeRestPackId(pack),
		routeName: "status",
		projectId: pack.scope === "project" ? currentProjectId() : undefined,
	});
	busy.delete("hindsight:wizard");
	if (statusRes.ok) {
		hindsightStatus = statusRes.data ?? null;
		hindsightStatusLoaded = true;
	}
	if (statusRes.ok && statusRes.data?.healthy) {
		hindsightWizardSmoke = { ok: true, message: "Memory data plane reachable" };
	} else {
		hindsightWizardSmoke = { ok: false, message: "Could not reach the data plane yet — you can finish and retry later from the row." };
	}
	renderApp();
}

/** Enable the built-in Hindsight pack by clearing every disabled ref (all entities +
 *  the runtime become active). Reuses the activation PUT seam. */
async function enableHindsightPack(pack: InstalledPackWire): Promise<void> {
	const disabled: DisabledRefs = {
		roles: [], tools: [], skills: [], entrypoints: [],
		providers: [], hooks: [], mcp: [], piExtensions: [], runtimes: [], workflows: [],
	};
	await savePackActivation(pack, disabled, `activation:${pack.scope}:${pack.packName}:all`);
}

/** FINISH: ensure config is persisted (idempotent), then ENABLE the pack. The row
 *  then reflects the connected/running state derived from the live status. */
async function handleWizardFinish(pack: InstalledPackWire): Promise<void> {
	busy.add("hindsight:wizard");
	hindsightWizardError = "";
	renderApp();
	if (!hindsightWizardConfigSaved) {
		const ok = await persistWizardConfig(pack);
		if (!ok) { busy.delete("hindsight:wizard"); renderApp(); return; }
	}
	await enableHindsightPack(pack);
	busy.delete("hindsight:wizard");
	cancelHindsightWizard();
	await loadHindsightState();
}

function renderHindsightWizard(pack: InstalledPackWire): TemplateResult {
	const f = hindsightWizardForm ?? defaultWizardForm();
	return html`
		<div class="market-hindsight-wizard mt-3" data-testid="market-hindsight-wizard" data-step=${hindsightWizardStep}>
			<div class="market-wizard-header">
				<div class="market-wizard-title">Set up Hindsight memory</div>
				<button class="market-icon-btn" data-testid="market-hindsight-wizard-cancel" title="Cancel setup" @click=${() => cancelHindsightWizard()}>${icon(XCircle, "xs")}</button>
			</div>
			${renderWizardStepper()}
			${hindsightWizardError ? html`<div class="market-error mt-2" data-testid="market-hindsight-wizard-error">${hindsightWizardError}</div>` : ""}
			<div class="market-wizard-body mt-2">
				${hindsightWizardStep === "mode"
					? renderWizardModeStep(f)
					: hindsightWizardStep === "configure"
						? renderWizardConfigureStep(f)
						: hindsightWizardStep === "connect"
							? renderWizardConnectStep(pack, f)
							: renderWizardSmokeStep(pack)}
			</div>
		</div>
	`;
}

function renderWizardStepper(): TemplateResult {
	const idx = WIZARD_STEPS.findIndex((s) => s.id === hindsightWizardStep);
	return html`
		<ol class="market-wizard-steps" data-testid="market-hindsight-wizard-step" data-current=${hindsightWizardStep}>
			${WIZARD_STEPS.map((s, i) => html`
				<li class="market-wizard-step ${i === idx ? "market-wizard-step--current" : ""} ${i < idx ? "market-wizard-step--done" : ""}">
					<span class="market-wizard-step-num">${i < idx ? icon(CheckCircle2, "xs") : String(i + 1)}</span>
					<span>${s.label}</span>
				</li>
			`)}
		</ol>
	`;
}

function renderWizardModeStep(f: HindsightWizardForm): TemplateResult {
	const card = (mode: HindsightWizardMode, ic: IconNode, title: string, blurb: string, note: string): TemplateResult => html`
		<button
			type="button"
			class="market-wizard-mode-card ${f.mode === mode ? "market-wizard-mode-card--selected" : ""}"
			data-testid="market-hindsight-wizard-mode-${mode}"
			aria-pressed=${f.mode === mode ? "true" : "false"}
			@click=${() => setWizardField("mode", mode)}
		>
			<div class="market-wizard-mode-title">${icon(ic, "xs")} ${title}</div>
			<div class="market-wizard-mode-blurb">${blurb}</div>
			<div class="market-wizard-mode-note">${note}</div>
		</button>
	`;
	return html`
		<p class="market-wizard-help">Choose how Bobbit talks to Hindsight. You can change this later from Configure.</p>
		<div class="market-wizard-modes">
			${card("external", Plug, "External", "Point Bobbit at an existing Hindsight data-plane URL you already run.", "Bobbit manages nothing — you run Hindsight + Postgres. No Docker.")}
			${card("managed", Database, "Managed (Docker)", "Bobbit runs Hindsight + Postgres locally via Docker.", "Bobbit manages containers, ports & the data volume. You provide an LLM API key + a data dir.")}
			${card("managed-external-postgres", Package, "Managed + external Postgres", "Bobbit runs only the Hindsight container against a Postgres URL you supply.", "Bobbit manages the Hindsight container. You provide a Postgres URL + an LLM API key.")}
		</div>
		<div class="market-wizard-actions">
			<span class="flex-1"></span>
			<button class="market-btn market-btn--primary" data-testid="market-hindsight-wizard-next" @click=${() => wizardGoStep("configure")}>Next ${icon(ChevronRight, "xs")}</button>
		</div>
	`;
}

function renderWizardConfigureStep(f: HindsightWizardForm): TemplateResult {
	const text = (key: keyof HindsightWizardForm, testid: string, placeholder: string, type = "text"): TemplateResult => html`
		<input class="market-input" type=${type} autocomplete="off" data-testid=${testid} placeholder=${placeholder} .value=${String(f[key])} @input=${(e: Event) => setWizardField(key, (e.target as HTMLInputElement).value as HindsightWizardForm[typeof key])} />
	`;
	const field = (label: string, why: string, input: TemplateResult): TemplateResult => html`
		<label class="market-field"><span class="market-field-label">${label}</span>${input}<span class="market-field-help">${why}</span></label>
	`;
	const modeFields = f.mode === "external"
		? html`
			${field("API / data-plane URL", "The data-plane URL Bobbit dials for recall/retain. Required.", text("externalUrl", "market-hindsight-wizard-externalurl", "http://localhost:9177"))}
			${field("Dashboard UI URL (optional)", "The human dashboard opened by 'Open Hindsight UI'. Never dialed by Bobbit.", text("uiUrl", "market-hindsight-wizard-uiurl", "http://localhost:19177/banks/bobbit?view=data"))}
			${field("API key (optional)", "Sent as the data-plane auth header if your Hindsight requires one.", text("apiKey", "market-hindsight-wizard-apikey", "optional", "password"))}
		`
		: html`
			${f.mode === "managed-external-postgres"
				? field("Postgres URL", "Bobbit points the managed Hindsight container at this Postgres. Required.", text("externalDatabaseUrl", "market-hindsight-wizard-externaldburl", "postgresql://user:pass@host:5432/db"))
				: field("Data dir", "Host path the managed Postgres volume bind-mounts to (so data is on a visible local path you can back up).", text("dataDir", "market-hindsight-wizard-datadir", "~/.hindsight"))}
			${field("LLM API key", "Used by Hindsight (not Bobbit) for memory extraction. Stored as a secret.", text("llmApiKey", "market-hindsight-wizard-llmapikey", "sk-…", "password"))}
		`;
	return html`
		<p class="market-wizard-help">Recommended defaults are prefilled — each field explains why.</p>
		<div class="market-wizard-fields">
			${modeFields}
			<div class="flex gap-2 flex-wrap">
				<label class="market-field flex-1"><span class="market-field-label">Bank</span>${text("bank", "market-hindsight-wizard-bank", "bobbit")}<span class="market-field-help">Shared memory bank. Default 'bobbit'; to join an existing bank (e.g. 'hermes') enter it here.</span></label>
				<label class="market-field flex-1"><span class="market-field-label">Namespace</span>${text("namespace", "market-hindsight-wizard-namespace", "default")}<span class="market-field-help">Hindsight namespace. 'default' for most setups.</span></label>
			</div>
			<div class="flex gap-2 flex-wrap">
				<label class="market-field flex-1"><span class="market-field-label">Recall scope</span>
					<select class="market-input" data-testid="market-hindsight-wizard-recallscope" .value=${f.recallScope} @change=${(e: Event) => setWizardField("recallScope", (e.target as HTMLSelectElement).value)}>
						<option value="all" ?selected=${f.recallScope === "all"}>all</option>
						<option value="project" ?selected=${f.recallScope === "project"}>project</option>
					</select>
					<span class="market-field-help">What agents recall by default: project = this project + shared/global memories; all = every project in the shared bank.</span>
				</label>
				<label class="market-field flex-1"><span class="market-field-label">Timeout (ms)</span>${text("timeoutMs", "market-hindsight-wizard-timeoutms", "1500", "number")}<span class="market-field-help">Max time Bobbit waits on a recall/retain call.</span></label>
				<label class="market-field flex-1"><span class="market-field-label">Recall max input chars</span>${text("recallMaxInputChars", "market-hindsight-wizard-recallmaxinputchars", "3000", "number")}<span class="market-field-help">Clamps the recall query so Hindsight's 500-token cap isn't hit. Default 3000.</span></label>
			</div>
			<div class="flex gap-3 flex-wrap items-center">
				<label class="flex items-center gap-1.5 text-[12px]"><input type="checkbox" data-testid="market-hindsight-wizard-autorecall" .checked=${f.autoRecall} @change=${(e: Event) => setWizardField("autoRecall", (e.target as HTMLInputElement).checked)} /> Auto recall <span class="text-muted-foreground">(pull memories into turns)</span></label>
				<label class="flex items-center gap-1.5 text-[12px]"><input type="checkbox" data-testid="market-hindsight-wizard-autoretain" .checked=${f.autoRetain} @change=${(e: Event) => setWizardField("autoRetain", (e.target as HTMLInputElement).checked)} /> Auto retain <span class="text-muted-foreground">(save memories async)</span></label>
			</div>
		</div>
		<div class="market-wizard-actions">
			<button class="market-btn" data-testid="market-hindsight-wizard-back" @click=${() => wizardGoStep("mode")}>${icon(ArrowLeft, "xs")} Back</button>
			<span class="flex-1"></span>
			<button class="market-btn market-btn--primary" data-testid="market-hindsight-wizard-next" ?disabled=${!wizardConfigureReady(f)} @click=${() => wizardGoStep("connect")}>Next ${icon(ChevronRight, "xs")}</button>
		</div>
	`;
}

function renderWizardConnectStep(pack: InstalledPackWire, f: HindsightWizardForm): TemplateResult {
	const busyWizard = busy.has("hindsight:wizard");
	const resultLozenge = hindsightWizardConnect
		? html`<span
				class="market-lozenge ${hindsightWizardConnect.ok ? "" : "market-lozenge--warning"}"
				data-testid="market-hindsight-wizard-connect-result"
				style=${hindsightWizardConnect.ok ? "border-color: color-mix(in oklch, var(--positive) 35%, transparent); background: color-mix(in oklch, var(--positive) 12%, transparent); color: var(--positive);" : ""}
			>${icon(hindsightWizardConnect.ok ? CheckCircle2 : XCircle, "xs")} ${hindsightWizardConnect.message}</span>`
		: "";

	if (f.mode === "external") {
		return html`
			<p class="market-wizard-help">Test that Bobbit can reach your Hindsight data plane.</p>
			<div class="flex items-center gap-2 flex-wrap">
				<button class="market-btn market-btn--primary" data-testid="market-hindsight-wizard-test" ?disabled=${busyWizard} @click=${() => handleWizardTest(pack)}>${icon(Plug, "xs", busyWizard ? "animate-spin" : "")} Test connection</button>
				${resultLozenge}
			</div>
			<div class="market-wizard-actions">
				<button class="market-btn" data-testid="market-hindsight-wizard-back" @click=${() => wizardGoStep("configure")}>${icon(ArrowLeft, "xs")} Back</button>
				<span class="flex-1"></span>
				<button class="market-btn market-btn--primary" data-testid="market-hindsight-wizard-next" ?disabled=${busyWizard} @click=${() => wizardGoStep("smoke")}>Next ${icon(ChevronRight, "xs")}</button>
			</div>
		`;
	}

	// Managed / managed-external-postgres: consent-gated explicit Start (the only
	// Docker-start path). Reuses the runtime consent disclosure card.
	const rt = hindsightRuntime();
	const started = !!hindsightWizardConnect?.ok;
	ensureWizardCapabilities(pack, HINDSIGHT_RUNTIME, f.mode);
	const cap = wizardRuntimeCap.get(wizardCapKey(pack, HINDSIGHT_RUNTIME, f.mode));
	return html`
		<p class="market-wizard-help">Starting brings up local Docker containers. Review what runs, then start it explicitly.</p>
		${renderRuntimeConsentCardView(HINDSIGHT_RUNTIME, cap)}
		<label class="market-wizard-consent" data-testid="market-hindsight-wizard-consent-label">
			<input type="checkbox" data-testid="market-hindsight-wizard-consent" .checked=${hindsightWizardConsent} @change=${(e: Event) => { hindsightWizardConsent = (e.target as HTMLInputElement).checked; renderApp(); }} />
			<span>I understand this starts local Docker containers that store memory.</span>
		</label>
		<div class="flex items-center gap-2 flex-wrap">
			<button class="market-btn market-btn--primary" data-testid="market-hindsight-wizard-start" ?disabled=${busyWizard || !hindsightWizardConsent} @click=${() => handleWizardStart(pack)}>${icon(Play, "xs", busyWizard ? "animate-spin" : "")} Start (starts Docker)</button>
			${resultLozenge}
			${rt ? html`<span class="market-lozenge" data-testid="market-hindsight-wizard-runtime-status">${rt.status}</span>` : ""}
		</div>
		<div class="market-wizard-actions">
			<button class="market-btn" data-testid="market-hindsight-wizard-back" @click=${() => wizardGoStep("configure")}>${icon(ArrowLeft, "xs")} Back</button>
			<span class="flex-1"></span>
			<button class="market-btn market-btn--primary" data-testid="market-hindsight-wizard-next" ?disabled=${busyWizard || !started} @click=${() => wizardGoStep("smoke")}>Next ${icon(ChevronRight, "xs")}</button>
		</div>
	`;
}

function renderWizardSmokeStep(pack: InstalledPackWire): TemplateResult {
	const busyWizard = busy.has("hindsight:wizard");
	return html`
		<p class="market-wizard-help">Quick end-to-end check (best-effort). You can finish even if it fails.</p>
		<div class="flex items-center gap-2 flex-wrap">
			<button class="market-btn" data-testid="market-hindsight-wizard-smoke" ?disabled=${busyWizard} @click=${() => handleWizardSmoke(pack)}>${icon(RotateCw, "xs", busyWizard ? "animate-spin" : "")} Run smoke test</button>
			${hindsightWizardSmoke
				? html`<span
						class="market-lozenge ${hindsightWizardSmoke.ok ? "" : "market-lozenge--warning"}"
						data-testid="market-hindsight-wizard-smoke-result"
						style=${hindsightWizardSmoke.ok ? "border-color: color-mix(in oklch, var(--positive) 35%, transparent); background: color-mix(in oklch, var(--positive) 12%, transparent); color: var(--positive);" : ""}
					>${icon(hindsightWizardSmoke.ok ? CheckCircle2 : XCircle, "xs")} ${hindsightWizardSmoke.message}</span>`
				: ""}
		</div>
		<div class="market-wizard-actions">
			<button class="market-btn" data-testid="market-hindsight-wizard-back" @click=${() => wizardGoStep("connect")}>${icon(ArrowLeft, "xs")} Back</button>
			<span class="flex-1"></span>
			<button class="market-btn market-btn--primary" data-testid="market-hindsight-wizard-finish" ?disabled=${busyWizard} @click=${() => handleWizardFinish(pack)}>${icon(CheckCircle2, "xs")} Finish &amp; enable</button>
		</div>
	`;
}

function renderConflictDetails(packConflicts: ConflictWire[]): TemplateResult {
	return html`
		<div class="market-conflict-details" data-testid="market-conflict-details">
			${packConflicts.map((c) => html`
				<div class="text-[11px] py-0.5">
					<span class="font-medium">${c.type.replace(/s$/, "")}: ${c.name}</span>
					— winner <span class="market-conflict-winner">${c.winner.label}</span>
					${c.shadowed.length > 0 ? html`, shadows ${c.shadowed.map((s) => s.label).join(", ")}` : ""}
				</div>
			`)}
		</div>
	`;
}

// ============================================================================
// PAGE
// ============================================================================

export function renderMarketplacePage(): TemplateResult {
	if (loading) {
		return html`
			<div class="flex-1 flex flex-col h-full">
				${renderNavBar()}
				${renderResearchPreviewBanner()}
				<div class="flex-1 flex items-center justify-center">
					<div class="text-sm text-muted-foreground">Loading marketplace…</div>
				</div>
			</div>
		`;
	}

	const panel =
		activeTab === "sources"
			? renderSourcesPanel()
			: activeTab === "browse"
				? renderBrowsePanel()
				: renderInstalledPanel();

	return html`
		<div class="flex-1 flex flex-col h-full">
			${renderNavBar()}
			${renderResearchPreviewBanner()}
			${renderTabBar()}
			<div class="flex-1 overflow-y-auto">
				<div class="max-w-3xl mx-auto px-4 py-6 flex flex-col gap-6">
					${panel}
				</div>
			</div>
		</div>
	`;
}
