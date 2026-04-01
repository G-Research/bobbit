import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Select, type SelectOption } from "@mariozechner/mini-lit/dist/Select.js";
import { html } from "lit";
import { ArrowLeft, Brain, Plus, RotateCcw, Sparkles, X } from "lucide";
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
import { renderApp, state } from "./state.js";
import { getRouteFromHash, setHashRoute, toggleConfigPage, type SettingsTabId } from "./routing.js";
import { gatewayFetch, fetchSandboxStatus } from "./api.js";
import { openOAuthDialog } from "./dialogs.js";
import { ModelSelector } from "../ui/dialogs/ModelSelector.js";

type SettingsTab = SettingsTabId;
const DEFAULT_TAB: SettingsTab = "shortcuts";

const SYSTEM_TABS: { id: SettingsTab; label: string }[] = [
	{ id: "shortcuts", label: "Shortcuts" },
	{ id: "general", label: "General" },
	{ id: "models", label: "Models" },
	{ id: "directories", label: "Config Directories" },
	{ id: "palette", label: "Color Palette" },
	{ id: "account", label: "Account" },
];

const PROJECT_TABS: { id: SettingsTab; label: string }[] = [
	{ id: "project", label: "Commands & Sandbox" },
	{ id: "models", label: "Models" },
	{ id: "directories", label: "Config Directories" },
	{ id: "appearance", label: "Appearance" },
];

function getActiveScope(): string {
	return (getRouteFromHash() as any).settingsScope ?? "system";
}

function getTabsForScope(scope: string): { id: SettingsTab; label: string }[] {
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



let settingsShowTimestamps = false;
let settingsShowTimestampsLoaded = false;

// ── Per-project scope config state ──
const projectScopeConfigCache = new Map<string, {
	resolved: Record<string, { value: string; source: string }>;
	raw: Record<string, string>;
	loaded: boolean;
}>();

let projectScopeSaveStatus: "" | "saving" | "saved" | "error" = "";
const _projectScopePending = new Map<string, Record<string, string>>();

function loadProjectScopeConfig(projectId: string): void {
	const cached = projectScopeConfigCache.get(projectId);
	if (cached?.loaded) return;
	if (cached) return; // loading in progress
	projectScopeConfigCache.set(projectId, { resolved: {}, raw: {}, loaded: false });
	(async () => {
		try {
			const [resolvedRes, rawRes] = await Promise.all([
				gatewayFetch(`/api/projects/${projectId}/config/resolved`),
				gatewayFetch(`/api/projects/${projectId}/config`),
			]);
			if (resolvedRes.ok && rawRes.ok) {
				const resolved = await resolvedRes.json();
				const raw = await rawRes.json();
				projectScopeConfigCache.set(projectId, { resolved, raw, loaded: true });
			}
		} catch {}
		renderApp();
	})();
}

async function saveProjectScopeConfig(projectId: string, updates: Record<string, string>): Promise<void> {
	projectScopeSaveStatus = "saving";
	renderApp();
	try {
		// Handle rootPath separately via project update API
		const rootPath = updates._rootPath;
		const configUpdates = { ...updates };
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
			// Invalidate cache to reload
			projectScopeConfigCache.delete(projectId);
			// Refresh project list if rootPath changed
			if (rootPath !== undefined) {
				try {
					const res = await gatewayFetch("/api/projects");
					if (res.ok) state.projects = await res.json();
				} catch {}
			}
			setTimeout(() => { projectScopeSaveStatus = ""; renderApp(); }, 2000);
		} else {
			projectScopeSaveStatus = "error";
		}
	} catch {
		projectScopeSaveStatus = "error";
	}
	renderApp();
}

async function resetProjectScopeField(projectId: string, key: string): Promise<void> {
	await saveProjectScopeConfig(projectId, { [key]: "" });
}

// ── Sandbox section state ──
let sandboxStatusLocal: { available: boolean; error?: string; dockerVersion?: string; imageExists?: boolean; dockerfileExists?: boolean; buildCommand?: string; configured: boolean } | null = null;
let sandboxStatusLoaded = false;
let sandboxBuildInProgress = false;
let sandboxBuildError = "";
let poolStatus: { enabled: boolean; total?: number; idle?: number; claimed?: number; warming?: number } | null = null;
let poolStatusLoaded = false;

// Per-project mutable state for dynamic list editors (credentials, mounts)
const _sandboxCredEntries = new Map<string, { key: string; value: string }[]>();
const _sandboxMountEntries = new Map<string, string[]>();

function loadSandboxStatus(): void {
	if (sandboxStatusLoaded) return;
	sandboxStatusLoaded = true;
	fetchSandboxStatus().then(s => {
		sandboxStatusLocal = s;
		state.sandboxStatus = s;
		renderApp();
	});
}

function loadPoolStatus(): void {
	if (poolStatusLoaded) return;
	poolStatusLoaded = true;
	gatewayFetch("/api/sandbox-pool").then(async (res) => {
		if (res.ok) {
			poolStatus = await res.json();
		} else {
			poolStatus = { enabled: false };
		}
		renderApp();
	}).catch(() => {
		poolStatus = { enabled: false };
		renderApp();
	});
}

/** Initialize credential/mount entries from resolved config if not already tracked. */
function initSandboxEntries(projectId: string, resolved: Record<string, { value: string; source: string }>): void {
	if (!_sandboxCredEntries.has(projectId)) {
		try {
			const raw = resolved.sandbox_credentials?.value || "";
			if (raw) {
				const obj = JSON.parse(raw);
				if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
					_sandboxCredEntries.set(projectId, Object.entries(obj).map(([key, value]) => ({ key, value: String(value) })));
				} else {
					_sandboxCredEntries.set(projectId, []);
				}
			} else {
				_sandboxCredEntries.set(projectId, []);
			}
		} catch { _sandboxCredEntries.set(projectId, []); }
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

function renderSandboxSection(
	projectId: string,
	resolved: Record<string, { value: string; source: string }>,
	pendingChanges: Record<string, string>,
	inputClass: string,
	labelClass: string,
) {
	loadSandboxStatus();
	initSandboxEntries(projectId, resolved);

	const sandboxMode = pendingChanges.sandbox ?? resolved.sandbox?.value ?? "none";
	const imageName = pendingChanges.sandbox_image ?? resolved.sandbox_image?.value ?? "bobbit-agent";
	const allowlistRaw = pendingChanges.sandbox_network_allowlist ?? resolved.sandbox_network_allowlist?.value ?? "";
	let allowlistDisplay = "";
	try {
		const arr = JSON.parse(allowlistRaw);
		if (Array.isArray(arr)) allowlistDisplay = arr.join(", ");
	} catch { allowlistDisplay = allowlistRaw; }

	const credEntries = _sandboxCredEntries.get(projectId)!;
	const mountEntries = _sandboxMountEntries.get(projectId)!;

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
																	const resp = await gatewayFetch("/api/sandbox-image/build", { method: "POST" });
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

			<!-- Network Allowlist -->
			<div class="flex items-start gap-3">
				<span class="${labelClass} pt-1.5">Network Allowlist</span>
				<div class="flex-1 min-w-0 flex flex-col gap-1">
					<input
						type="text"
						class="${inputClass}"
						placeholder="github.com, api.github.com"
						.value=${allowlistDisplay}
						@input=${(e: Event) => {
							const v = (e.target as HTMLInputElement).value;
							const hosts = v.split(",").map(h => h.trim()).filter(Boolean);
							pendingChanges.sandbox_network_allowlist = hosts.length > 0 ? JSON.stringify(hosts) : "";
						}}
					/>
					<span class="text-[10px] text-muted-foreground">Comma-separated hostnames allowed through the network proxy.</span>
				</div>
			</div>

			<!-- Credentials -->
			<div class="flex items-start gap-3">
				<span class="${labelClass} pt-1.5">Credentials</span>
				<div class="flex-1 min-w-0 flex flex-col gap-1.5">
					${credEntries.map((entry, i) => html`
						<div class="flex items-center gap-2">
							<input
								type="text"
								class="w-36 px-2 py-1 rounded-md border border-input bg-background text-sm font-mono
									focus:outline-none focus:ring-2 focus:ring-ring"
								placeholder="ENV_VAR"
								.value=${entry.key}
								@input=${(e: Event) => {
									credEntries[i].key = (e.target as HTMLInputElement).value;
									const obj: Record<string, string> = {};
									for (const e2 of credEntries) { if (e2.key) obj[e2.key] = e2.value; }
									pendingChanges.sandbox_credentials = Object.keys(obj).length > 0 ? JSON.stringify(obj) : "";
									renderApp();
								}}
							/>
							<span class="text-muted-foreground text-xs">=</span>
							<input
								type="text"
								class="${inputClass}"
								placeholder="value"
								.value=${entry.value}
								@input=${(e: Event) => {
									credEntries[i].value = (e.target as HTMLInputElement).value;
									const obj: Record<string, string> = {};
									for (const e2 of credEntries) { if (e2.key) obj[e2.key] = e2.value; }
									pendingChanges.sandbox_credentials = Object.keys(obj).length > 0 ? JSON.stringify(obj) : "";
									renderApp();
								}}
							/>
							<button
								class="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
								title="Remove"
								@click=${() => {
									credEntries.splice(i, 1);
									const obj: Record<string, string> = {};
									for (const e2 of credEntries) { if (e2.key) obj[e2.key] = e2.value; }
									pendingChanges.sandbox_credentials = Object.keys(obj).length > 0 ? JSON.stringify(obj) : "";
									renderApp();
								}}
							>${icon(X, "xs")}</button>
						</div>
					`)}
					<button
						class="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground
							hover:bg-muted rounded-md transition-colors self-start"
						@click=${() => { credEntries.push({ key: "", value: "" }); renderApp(); }}
					>${icon(Plus, "xs")} Add credential</button>
				</div>
			</div>

			<!-- Additional Mounts -->
			<div class="flex items-start gap-3">
				<span class="${labelClass} pt-1.5">Additional Mounts</span>
				<div class="flex-1 min-w-0 flex flex-col gap-1.5">
					${mountEntries.map((mount, i) => html`
						<div class="flex items-center gap-2">
							<input
								type="text"
								class="${inputClass}"
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

			<!-- Container Pool -->
			${sandboxMode === "docker" ? html`
				<div class="border-t border-border pt-2 mt-1 flex flex-col gap-2">
					<div class="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">Container Pool</div>
					<p class="text-xs text-muted-foreground -mt-1">
						Pre-warmed containers reduce sandbox startup time. Changes take effect on gateway restart.
					</p>

					<div class="flex items-center gap-3">
						<span class="${labelClass}">Pool Size</span>
						<input
							type="number"
							min="0"
							class="${inputClass} max-w-32"
							placeholder="2"
							.value=${pendingChanges.sandbox_pool_size ?? resolved.sandbox_pool_size?.value ?? ""}
							@input=${(e: Event) => {
								pendingChanges.sandbox_pool_size = (e.target as HTMLInputElement).value;
							}}
						/>
						<span class="text-xs text-muted-foreground">Pre-warmed containers (0 = disable)</span>
					</div>

					<div class="flex items-center gap-3">
						<span class="${labelClass}">Max Idle Time</span>
						<input
							type="number"
							min="0"
							class="${inputClass} max-w-32"
							placeholder="300"
							.value=${pendingChanges.sandbox_pool_max_idle ?? resolved.sandbox_pool_max_idle?.value ?? ""}
							@input=${(e: Event) => {
								pendingChanges.sandbox_pool_max_idle = (e.target as HTMLInputElement).value;
							}}
						/>
						<span class="text-xs text-muted-foreground">Seconds before excess containers culled</span>
					</div>

					<div class="flex items-center gap-3">
						<span class="${labelClass}">Pool Status</span>
						<div class="flex items-center gap-2 text-sm">
							${(() => {
								loadPoolStatus();
								if (poolStatus === null) return html`<span class="text-muted-foreground">Loading...</span>`;
								if (!poolStatus.enabled) return html`<span class="text-muted-foreground">Pool disabled</span>`;
								return html`
									<span class="text-xs font-mono flex items-center gap-3">
										<span>Total: <span class="text-foreground font-medium">${poolStatus.total}</span></span>
										<span>Idle: <span class="text-foreground font-medium">${poolStatus.idle}</span></span>
										<span>Claimed: <span class="text-foreground font-medium">${poolStatus.claimed}</span></span>
										<span>Warming: <span class="text-foreground font-medium">${poolStatus.warming}</span></span>
									</span>
								`;
							})()}
							<button
								class="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors ml-1"
								title="Refresh pool status"
								@click=${() => { poolStatusLoaded = false; poolStatus = null; loadPoolStatus(); }}
							>${icon(RotateCcw, "xs")}</button>
						</div>
					</div>
				</div>
			` : ""}
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
		<div class="flex gap-6 items-start">
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
			<div class="shrink-0 w-48 rounded-md border border-border/60 bg-secondary/30 p-3 text-xs text-muted-foreground leading-relaxed">
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
let aigwModels: Array<{ id: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean }> = [];
// Preferences
let prefSessionModel = "";   // "provider/modelId" e.g. "aigw/claude-sonnet-4-6" or "anthropic/claude-sonnet-4-6"
let prefReviewModel = "";    // same format
let prefNamingModel = "";    // same format
let prefSessionThinking = "";   // "off"|"minimal"|"low"|"medium"|"high"|""
let prefReviewThinking = "";
let prefNamingThinking = "";
let allModels: Array<{ id: string; provider: string; reasoning: boolean }> = [];
let _modelsLoaded = false;

function loadModelsState(): void {
	if (_modelsLoaded) return;
	_modelsLoaded = true;
	(async () => {
		try {
			const [statusRes, prefsRes, modelsRes] = await Promise.all([
				gatewayFetch("/api/aigw/status"),
				gatewayFetch("/api/preferences"),
				gatewayFetch("/api/models"),
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
				prefSessionThinking = prefs["default.sessionThinkingLevel"] || "";
				prefReviewThinking = prefs["default.reviewThinkingLevel"] || "";
				prefNamingThinking = prefs["default.namingThinkingLevel"] || "";
			}
			if (modelsRes.ok) {
				const models = await modelsRes.json();
				if (Array.isArray(models)) {
					allModels = models;
				}
			}
		} catch {}
		renderApp();
	})();
}

async function savePref(key: string, value: string | null): Promise<void> {
	try {
		await gatewayFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ [key]: value }),
		});
	} catch {}
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

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
	return String(tokens);
}

/** Format a "provider/modelId" pref value for display. Shows just the model ID. */
function formatModelPref(value: string): string {
	if (!value) return "Auto (best available)";
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

function renderModelRow(
	label: string,
	hint: string,
	modelValue: string,
	onModelChange: (v: string) => void,
	thinkingValue: string,
	onThinkingChange: (v: string) => void,
	thinkingDefault: string = "medium",
) {
	const modelDisplay = formatModelPref(modelValue);

	// Determine if selected model supports reasoning
	let thinkingDisabled = false;
	if (modelValue) {
		const model = allModels.find(m => `${m.provider}/${m.id}` === modelValue);
		if (model && !model.reasoning) {
			thinkingDisabled = true;
		}
	}

	return html`
		<div class="flex flex-col gap-1">
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
					</button>
					${modelValue ? html`
						<button
							class="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0"
							title="Reset model to auto"
							@click=${() => onModelChange("")}
						>${icon(X, "xs")}</button>
					` : ""}
					<!-- Divider -->
					<div class="w-px h-5 bg-border shrink-0"></div>
					<!-- Thinking picker -->
					<div class="shrink-0 ${thinkingDisabled ? "opacity-40 pointer-events-none" : ""}"
						title=${thinkingDisabled ? "Selected model does not support thinking" : "Thinking level"}
					>
						${Select({
							value: thinkingValue || thinkingDefault,
							options: [
								{ value: "off", label: "Off", icon: icon(Brain, "sm") },
								{ value: "minimal", label: "Minimal", icon: icon(Brain, "sm") },
								{ value: "low", label: "Low", icon: icon(Brain, "sm") },
								{ value: "medium", label: "Medium", icon: icon(Brain, "sm") },
								{ value: "high", label: "High", icon: icon(Brain, "sm") },
							] as SelectOption[],
							onChange: (value: string) => { onThinkingChange(value); },
							size: "sm",
							variant: "ghost",
							fitContent: true,
						})}
					</div>
				</div>
			</div>
			<p class="text-xs text-muted-foreground">${hint}</p>
		</div>
	`;
}

function renderModelsTab() {
	loadModelsState();

	const busy = aigwStatus !== "idle";
	const hasModels = aigwModels.length > 0;

	return html`
		<div class="flex flex-col gap-6">

			<!-- Default model preferences -->
			<div class="flex flex-col gap-4">
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
					"Lightweight model for auto-generating session titles. Best with a fast, cheap model.",
					prefNamingModel,
					setNamingModel,
					prefNamingThinking,
					setNamingThinking,
					"off",
				)}
			</div>

			<!-- AI Gateway section -->
			<div class="flex flex-col gap-4 pt-4 border-t border-border">
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

				<!-- Available models list -->
				${hasModels ? html`
					<div class="flex flex-col gap-2 mt-1">
						<h4 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
							Available Models (${aigwModels.length})
						</h4>
						<div class="border border-border rounded-md divide-y divide-border max-h-60 overflow-y-auto">
							${aigwModels.map((m: any) => html`
								<div class="px-3 py-1.5 flex items-center justify-between">
									<div class="flex flex-col gap-0 min-w-0">
										<span class="text-sm text-foreground truncate">${m.name}</span>
										<span class="text-[11px] text-muted-foreground font-mono">${m.id}</span>
									</div>
									<div class="flex items-center gap-2 text-xs text-muted-foreground shrink-0 ml-2">
										${m.reasoning ? html`<span class="px-1.5 py-0.5 rounded bg-secondary">Reasoning</span>` : ""}
										<span>${formatTokens(m.contextWindow)} ctx</span>
									</div>
								</div>
							`)}
						</div>
					</div>
				` : ""}
			</div>
		</div>
	`;
}

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
		(async () => {
			try {
				const res = await gatewayFetch("/api/preferences");
				if (res.ok) {
					const prefs = await res.json();
					settingsShowTimestamps = !!prefs.showTimestamps;
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

function renderGeneralTab() {
	loadGeneralSettings();
	return html`
		<div class="flex flex-col gap-4">
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
			const scope = getActiveScope();
			if (scope && scope !== "system") {
				dirParams.set("projectId", scope);
			}
			const res = await gatewayFetch(`/api/config-directories${dirParams.toString() ? '?' + dirParams.toString() : ''}`);
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
			body: JSON.stringify({ config_directories: JSON.stringify(customDirs), skill_directories: null }),
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

let accountStatus: { authenticated: boolean; expires?: number } | null = null;
let accountLoading = false;
let accountReauthing = false;

function loadAccountStatus(): void {
	if (accountLoading) return;
	accountLoading = true;
	(async () => {
		try {
			const res = await gatewayFetch("/api/oauth/status");
			if (res.ok) accountStatus = await res.json();
			else accountStatus = { authenticated: false };
		} catch {
			accountStatus = { authenticated: false };
		} finally {
			accountLoading = false;
			renderApp();
		}
	})();
}

async function handleReauthenticate(): Promise<void> {
	accountReauthing = true;
	renderApp();
	try {
		const success = await openOAuthDialog();
		if (success) {
			// Refresh status after successful re-auth
			accountStatus = null;
			loadAccountStatus();
		}
	} finally {
		accountReauthing = false;
		renderApp();
	}
}

function renderAccountTab() {
	if (!accountStatus && !accountLoading) loadAccountStatus();

	if (accountLoading && !accountStatus) {
		return html`<p class="text-sm text-muted-foreground">Loading...</p>`;
	}

	const authenticated = accountStatus?.authenticated ?? false;
	const expires = accountStatus?.expires;
	const expiresDate = expires ? new Date(expires) : null;
	const isExpired = expires ? Date.now() > expires : false;

	return html`
		<div class="flex flex-col gap-4">
			<div class="flex flex-col gap-1.5">
				<h3 class="text-sm font-semibold text-foreground">Anthropic OAuth</h3>
				<p class="text-xs text-muted-foreground">
					OAuth credentials used by agent sessions to access the Anthropic API.
					Re-authenticate to refresh expired tokens or switch accounts.
				</p>
			</div>

			<div class="flex flex-col gap-2 rounded-md border border-border p-3">
				<div class="flex items-center gap-2">
					<span class="text-sm font-medium text-foreground">Status:</span>
					${authenticated
						? html`<span class="text-sm text-green-600 dark:text-green-400">Authenticated</span>`
						: html`<span class="text-sm text-destructive">${isExpired ? "Expired" : "Not authenticated"}</span>`}
				</div>
				${expiresDate
					? html`<div class="flex items-center gap-2">
						<span class="text-sm font-medium text-foreground">Expires:</span>
						<span class="text-sm ${isExpired ? "text-destructive" : "text-muted-foreground"}">${expiresDate.toLocaleString()}</span>
					</div>`
					: ""}
			</div>

			<div>
				${Button({
					variant: authenticated ? "outline" : "default",
					size: "sm",
					disabled: accountReauthing,
					onClick: handleReauthenticate,
					children: accountReauthing ? "Authenticating..." : authenticated ? "Re-authenticate" : "Log in",
				})}
			</div>
		</div>
	`;
}

function renderScopeRow(currentScope: string, _tabs: { id: SettingsTab; label: string }[]) {
	const projects = state.projects || [];
	// Only show scope row when there are projects to choose between
	if (projects.length === 0) return "";

	return html`
		<div class="shrink-0 flex items-center gap-1 px-4 py-2 border-b border-border overflow-x-auto" style="scrollbar-width:thin;">
			<button
				class="px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap shrink-0
					${currentScope === "system"
						? "bg-background text-foreground shadow-sm border border-border"
						: "text-muted-foreground hover:text-foreground hover:bg-secondary/50"}"
				@click=${() => { setHashRoute("settings", `system/${SYSTEM_TABS[0].id}`, true); }}
			>System</button>
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
						<span class="inline-block w-2 h-2 rounded-full shrink-0" style="background:${color};"></span>
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

	const project = (state.projects || []).find((p: any) => p.id === projectId);
	const resolved = cached.resolved;
	const raw = cached.raw;

	// Keys to show in the Commands & Sandbox tab
	const HIDDEN_KEYS = new Set([
		"default_thinking_level", "sandbox", "sandbox_image", "sandbox_network_allowlist",
		"sandbox_credentials", "sandbox_mounts", "sandbox_pool_size", "sandbox_pool_max_idle",
		"config_directories", "skill_directories",
	]);

	const commandKeys = Object.keys(resolved).filter(k => !HIDDEN_KEYS.has(k));
	const labelClass = "text-sm font-medium text-foreground w-28 sm:w-44 shrink-0";
	const inputClass = `w-full min-w-0 px-3 py-1.5 rounded-md border border-input bg-background text-sm
		font-mono focus:outline-none focus:ring-2 focus:ring-ring`;

	// Track pending changes in a module-level map so they survive re-renders
	if (!_projectScopePending.has(projectId)) _projectScopePending.set(projectId, {});
	const pendingChanges = _projectScopePending.get(projectId)!;

	return html`
		<div class="flex flex-col gap-4">
			<!-- Working Directory -->
			<div class="flex flex-col gap-2">
				<div class="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">Working Directory</div>
				<div class="flex items-center gap-3">
					<span class="${labelClass}">Root Path</span>
					<input
						type="text"
						class="${inputClass} text-foreground"
						.value=${project?.rootPath || ""}
						@input=${(e: Event) => {
							pendingChanges._rootPath = (e.target as HTMLInputElement).value;
						}}
					/>
					<div class="w-7 shrink-0"></div>
				</div>
				<p class="text-xs text-muted-foreground">
					The directory used when creating new sessions and goals for this project.
				</p>
			</div>

			<hr class="border-border" />

			<div class="flex flex-col gap-2">
				<div class="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">Commands</div>
				${commandKeys.map((key) => {
					const entry = resolved[key];
					if (!entry) return "";
					const isInherited = entry.source !== "project";
					const displayValue = raw[key] ?? "";
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
							${!isInherited ? html`
								<button
									class="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
									title="Reset to inherited value"
									@click=${() => resetProjectScopeField(projectId, key)}
								>${icon(X, "xs")}</button>
							` : html`<div class="w-7 shrink-0"></div>`}
						</div>
					`;
				})}
			</div>

			<hr class="border-border" />

			<!-- Docker Sandbox -->
			${renderSandboxSection(projectId, resolved, pendingChanges, inputClass, labelClass)}

			<!-- Save -->
			<div class="flex items-center gap-3 pt-2 border-t border-border">
				<button
					class="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground
						hover:bg-primary/90 transition-colors disabled:opacity-50"
					?disabled=${projectScopeSaveStatus === "saving"}
					@click=${() => {
						if (Object.keys(pendingChanges).length > 0) {
							saveProjectScopeConfig(projectId, pendingChanges);
							_projectScopePending.delete(projectId);
							// Clear sandbox entry caches so they reload from saved config
							_sandboxCredEntries.delete(projectId);
							_sandboxMountEntries.delete(projectId);
						}
					}}
				>${projectScopeSaveStatus === "saving" ? "Saving..." : "Save"}</button>
				${projectScopeSaveStatus === "saved" ? html`<span class="text-xs text-green-600">Saved successfully.</span>` : ""}
				${projectScopeSaveStatus === "error" ? html`<span class="text-xs text-destructive">Failed to save.</span>` : ""}
			</div>
		</div>
	`;
}

function renderProjectScopeModelsTab(_projectId: string) {
	// For now, show a simplified models view indicating inheritance from system
	return html`
		<div class="flex flex-col gap-4">
			<p class="text-sm text-muted-foreground">
				Model preferences for this project. Currently inherits all settings from System.
			</p>
			<p class="text-xs text-muted-foreground">
				Per-project model overrides will be available in a future update. Configure models in
				<button class="text-primary hover:underline" @click=${() => setHashRoute("settings", "system/models", true)}>System &rarr; Models</button>.
			</p>
		</div>
	`;
}

function renderProjectScopeDirectoriesTab(_projectId: string) {
	return renderDirectoriesTab();
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
				if (idx >= 0) state.projects[idx] = { ...state.projects[idx], ...updated };
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
				if (idx >= 0) state.projects[idx] = { ...state.projects[idx], ...updated };
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

export function renderSettingsPage() {
	// Manage keydown listener lifecycle
	updateKeydownListener();

	const currentScope = getActiveScope();
	const tabs = getTabsForScope(currentScope);
	const currentTab = getActiveTab();
	const isProjectScope = currentScope !== "system";

	return html`
		<div class="flex-1 flex flex-col min-h-0 overflow-hidden">
			<!-- Header -->
			<div class="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-border">
				<button
					class="p-1.5 rounded-md hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
					@click=${() => { resetRebindState(); cleanupListener(); toggleSettings(); }}
					title="Back"
				>${icon(ArrowLeft, "sm")}</button>
				<h1 class="text-lg font-semibold">Settings</h1>
			</div>
			<!-- Scope row -->
			${renderScopeRow(currentScope, tabs)}
			<!-- Tab bar -->
			<div class="shrink-0 flex items-center gap-1 px-4 py-2 border-b border-border bg-secondary/20">
				${tabs.map((tab) => html`
					<button
						class="px-3 py-1.5 text-sm rounded-md transition-colors
							${currentTab === tab.id
								? "bg-background text-foreground shadow-sm border border-border"
								: "text-muted-foreground hover:text-foreground hover:bg-secondary/50"}"
						title="${tab.label}"
						@click=${() => { setHashRoute("settings", `${currentScope}/${tab.id}`, true); }}
					>${tab.label}</button>
				`)}
			</div>
			<!-- Tab content -->
			<div class="flex-1 overflow-y-auto">
			 <div class="max-w-5xl mx-auto p-2 sm:p-4">
				<div class="${currentTab === "project" || currentTab === "directories" ? "" : currentTab === "palette" || currentTab === "shortcuts" || currentTab === "appearance" ? "max-w-3xl" : "max-w-xl"}">
					${isProjectScope ? html`
						${currentTab === "appearance" ? renderAppearanceTab(currentScope) : ""}
						${currentTab === "project" ? renderProjectScopeTab(currentScope) : ""}
						${currentTab === "models" ? renderProjectScopeModelsTab(currentScope) : ""}
						${currentTab === "directories" ? renderProjectScopeDirectoriesTab(currentScope) : ""}
					` : html`
						${currentTab === "general" ? renderGeneralTab() : ""}
						${currentTab === "models" ? renderModelsTab() : ""}
						${currentTab === "shortcuts" ? renderShortcutsTab() : ""}
						${currentTab === "palette" ? renderPaletteTab() : ""}
						${currentTab === "directories" ? renderDirectoriesTab() : ""}
						${currentTab === "account" ? renderAccountTab() : ""}
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
