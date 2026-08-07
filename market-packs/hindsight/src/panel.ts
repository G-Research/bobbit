// Native Hindsight side-panel. This is deliberately a pure pack client: every
// dynamic operation goes through the host's pack-scoped typed route API.

type Toolkit = {
	html: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
	nothing: unknown;
	renderHeader: unknown;
};
type Host = {
	capabilities?: { callRoute?: boolean };
	callRoute?<T = unknown>(name: string, init?: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown; query?: Record<string, string | number | boolean> }): Promise<T>;
	requestRender?: () => void;
};
type RuntimeState = "stopped" | "starting" | "ready" | "degraded" | "blocked" | "unavailable";
type RouteRecord = Record<string, unknown>;
type Entry = {
	key: string;
	host?: Host;
	activeTab: "service" | "memories" | "access";
	generation: number;
	busy?: string;
	message?: string;
	error?: string;
	runtime?: RouteRecord;
	logs?: string[];
	memories: RouteRecord[];
	selected?: RouteRecord;
	detail?: RouteRecord;
	search: string;
	reflectPrompt: string;
	reflection?: string;
	retain: string;
	outcome: string;
	invalidateReason: string;
	confirm?: { action: "start" | "stop" | "restart" | "migrate" | "invalidate"; label: string; restore?: Element | null };
	migration?: RouteRecord;
};

const TABS = ["service", "memories", "access"] as const;
const CAPABILITIES = ["service.manage", "memory.read", "memory.write", "memory.reflect", "memory.invalidate", "memory.read.all"] as const;
const MAX_TEXT = 8_000;

function record(value: unknown): RouteRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as RouteRecord : undefined;
}
function text(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : value == null ? fallback : String(value);
}
function list(value: unknown): RouteRecord[] {
	return Array.isArray(value) ? value.map(record).filter((x): x is RouteRecord => !!x) : [];
}
function errorText(error: unknown): string {
	const body = record(error);
	return text(body?.error || body?.message, "Request unavailable.").slice(0, 280);
}
function statusOf(runtime?: RouteRecord): RuntimeState {
	const state = text(runtime?.state || runtime?.status);
	return state === "stopped" || state === "starting" || state === "ready" || state === "degraded" || state === "blocked" || state === "unavailable" ? state : "unavailable";
}
function memoryId(memory?: RouteRecord): string {
	return text(memory?.id || memory?.memoryId || memory?.documentId);
}
function memoryText(memory?: RouteRecord): string {
	return text(memory?.text || memory?.content || memory?.summary, "Untitled memory");
}
function safeInput(value: string): string { return value.slice(0, MAX_TEXT); }

export default function createHindsightPanel({ html, nothing }: Toolkit) {
	const entries = new Map<string, Entry>();
	let activeKey: string | undefined;

	function entryFor(params: Record<string, unknown> | undefined, host?: Host): Entry {
		const key = typeof params?.__sessionId === "string" && params.__sessionId ? params.__sessionId : "default";
		if (activeKey && activeKey !== key) disposeEntry(entries.get(activeKey));
		activeKey = key;
		const entry = entries.get(key) ?? {
			key, host, activeTab: "service", generation: 0, memories: [], search: "", reflectPrompt: "", retain: "", outcome: "", invalidateReason: "",
		};
		entry.host = host;
		entries.set(key, entry);
		return entry;
	}
	function repaint(entry: Entry): void { entry.host?.requestRender?.(); }
	function disposeEntry(entry?: Entry): void {
		if (!entry) return;
		entry.generation += 1;
		entry.busy = undefined;
		entry.confirm = undefined;
		entry.search = "";
		entry.selected = undefined;
		entry.detail = undefined;
		entry.reflectPrompt = "";
		entry.retain = "";
		entry.outcome = "";
		entry.invalidateReason = "";
	}
	async function call(entry: Entry, route: string, init?: { method?: "GET" | "POST"; body?: unknown; query?: Record<string, string> }): Promise<RouteRecord | undefined> {
		if (!entry.host?.capabilities?.callRoute || !entry.host.callRoute) {
			entry.error = "Hindsight routes are unavailable in this host.";
			repaint(entry);
			return undefined;
		}
		const generation = entry.generation;
		entry.busy = route;
		entry.error = undefined;
		repaint(entry);
		try {
			const result = await entry.host.callRoute<unknown>(route, init);
			if (generation !== entry.generation) return undefined;
			const value = record(result) ?? {};
			if (value.ok === false || value.error) entry.error = text(value.error || value.message, "Request failed.");
			return value;
		} catch (error) {
			if (generation === entry.generation) entry.error = errorText(error);
			return undefined;
		} finally {
			if (generation === entry.generation) {
				entry.busy = undefined;
				repaint(entry);
			}
		}
	}
	async function refreshStatus(entry: Entry): Promise<void> {
		const result = await call(entry, "runtime-status");
		if (result) entry.runtime = result;
		repaint(entry);
	}
	async function showLogs(entry: Entry): Promise<void> {
		const result = await call(entry, "runtime-logs");
		if (result) entry.logs = (Array.isArray(result.lines) ? result.lines : Array.isArray(result.logs) ? result.logs : []).map((line) => text(line)).slice(-100);
		repaint(entry);
	}
	async function browse(entry: Entry): Promise<void> {
		const query = entry.search.trim();
		const result = await call(entry, "browse", query ? { method: "POST", body: { query } } : undefined);
		if (result) {
			entry.memories = list(result.memories || result.items || result.results);
			entry.message = `${entry.memories.length} ${entry.memories.length === 1 ? "memory" : "memories"} loaded.`;
		}
		repaint(entry);
	}
	async function selectMemory(entry: Entry, memory: RouteRecord): Promise<void> {
		entry.selected = memory;
		entry.detail = undefined;
		repaint(entry);
		const id = memoryId(memory);
		if (!id) return;
		const result = await call(entry, "detail", { method: "POST", body: { id } });
		if (result) entry.detail = result;
		repaint(entry);
	}
	function openConfirm(entry: Entry, action: Entry["confirm"]["action"], label: string): void {
		entry.confirm = { action, label, restore: typeof document === "undefined" ? null : document.activeElement };
		repaint(entry);
		queueMicrotask(() => focusDialog(entry));
	}
	function closeConfirm(entry: Entry): void {
		const restore = entry.confirm?.restore;
		entry.confirm = undefined;
		repaint(entry);
		queueMicrotask(() => { if (restore instanceof HTMLElement && restore.isConnected) restore.focus(); });
	}
	function focusDialog(entry: Entry): void {
		if (typeof document === "undefined") return;
		const root = document.querySelector(`[data-hindsight-panel="${cssEscape(entry.key)}"]`);
		(root?.querySelector("[data-hindsight-confirm-cancel]") as HTMLElement | null)?.focus();
	}
	function trapDialog(event: KeyboardEvent, entry: Entry): void {
		if (!entry.confirm) return;
		if (event.key === "Escape") { event.preventDefault(); closeConfirm(entry); return; }
		if (event.key !== "Tab" || typeof document === "undefined") return;
		const root = document.querySelector(`[data-hindsight-panel="${cssEscape(entry.key)}"] [role="dialog"]`);
		const focusable = root ? Array.from(root.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")) : [];
		if (!focusable.length) return;
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
		else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
	}
	async function confirm(entry: Entry): Promise<void> {
		const intent = entry.confirm;
		if (!intent) return;
		if (intent.action === "invalidate") {
			const id = memoryId(entry.selected);
			if (!id || !entry.invalidateReason.trim()) { entry.error = "A reason is required to invalidate a memory."; repaint(entry); return; }
			const result = await call(entry, "invalidate", { method: "POST", body: { id, reason: entry.invalidateReason.trim(), confirmed: true } });
			if (result && result.ok !== false) { entry.message = "Memory invalidated."; entry.selected = undefined; entry.detail = undefined; entry.memories = entry.memories.filter((m) => memoryId(m) !== id); }
		} else if (intent.action === "migrate") {
			const result = await call(entry, "migration-execute", { method: "POST", body: { planFingerprint: text(entry.migration?.fingerprint), confirmed: true } });
			if (result && result.ok !== false) entry.message = "Migration request completed.";
		} else {
			const result = await call(entry, "runtime-control", { method: "POST", body: { action: intent.action, consent: true } });
			if (result) entry.runtime = result.status && record(result.status) ? record(result.status) : result;
		}
		closeConfirm(entry);
		repaint(entry);
	}
	function selectTab(entry: Entry, tab: Entry["activeTab"]): void { entry.activeTab = tab; repaint(entry); }
	function tabKey(event: KeyboardEvent, entry: Entry): void {
		const index = TABS.indexOf(entry.activeTab);
		let next = index;
		if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
		else if (event.key === "ArrowLeft") next = (index + TABS.length - 1) % TABS.length;
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = TABS.length - 1;
		else return;
		event.preventDefault();
		selectTab(entry, TABS[next]);
		queueMicrotask(() => {
			if (typeof document === "undefined") return;
			(document.querySelector(`[data-hindsight-panel="${cssEscape(entry.key)}"] [data-hindsight-tab="${TABS[next]}"]`) as HTMLElement | null)?.focus();
		});
	}
	function statusLabel(entry: Entry): string {
		const runtime = entry.runtime;
		const state = statusOf(runtime);
		const diagnostic = record(runtime?.diagnostic);
		return [state, text(diagnostic?.message || diagnostic?.code || runtime?.message)].filter(Boolean).join(" · ");
	}
	function renderService(entry: Entry): unknown {
		const state = statusOf(entry.runtime);
		const desired = text(entry.runtime?.desired || entry.runtime?.desiredState);
		const mode = text(entry.runtime?.mode || entry.runtime?.runtimeMode);
		const endpoint = state === "ready" ? text(entry.runtime?.endpoint) : "";
		return html`<section class="hindsight-section" role="tabpanel" id="hindsight-service-${entry.key}" aria-labelledby="hindsight-tab-service-${entry.key}">
			<div class="hindsight-card"><div><h3>Service</h3><p>Configured services remain stopped until you explicitly choose a control.</p></div><span class="hindsight-state hindsight-state--${state}" data-testid="hindsight-runtime-state">${statusLabel(entry)}</span></div>
			<div class="hindsight-meta"><span>Mode: ${mode || "not configured"}</span>${desired ? html`<span>Desired: ${desired}</span>` : nothing}${endpoint ? html`<code>Endpoint: ${endpoint}</code>` : nothing}</div>
			<div class="hindsight-actions"><button type="button" @click=${() => void refreshStatus(entry)} ?disabled=${!!entry.busy}>${entry.busy === "runtime-status" ? "Refreshing…" : "Refresh status"}</button><button type="button" @click=${() => openConfirm(entry, "start", "Start service")}>Start</button><button type="button" @click=${() => openConfirm(entry, "stop", "Stop service")}>Stop</button><button type="button" @click=${() => openConfirm(entry, "restart", "Restart service")}>Restart</button><button type="button" @click=${() => void showLogs(entry)}>Logs</button></div>
			${entry.logs?.length ? html`<pre class="hindsight-logs" aria-label="Runtime logs">${entry.logs.join("\n")}</pre>` : nothing}
			<div class="hindsight-migration"><strong>Storage migration</strong><p>Migration uses a logical backup and restore; it never mounts the live PostgreSQL data directory.</p><button type="button" @click=${async () => { const plan = await call(entry, "migration-plan", { method: "POST", body: {} }); if (plan) { entry.migration = plan; entry.message = text(plan.summary, "Migration plan ready for review."); repaint(entry); } }}>Plan migration</button>${entry.migration ? html`<button type="button" @click=${() => openConfirm(entry, "migrate", "Apply the reviewed migration plan")}>Apply plan</button>` : nothing}</div>
		</section>`;
	}
	function renderMemories(entry: Entry): unknown {
		const detail = entry.detail || entry.selected;
		const history = list(detail?.history || detail?.events);
		return html`<section class="hindsight-section" role="tabpanel" id="hindsight-memories-${entry.key}" aria-labelledby="hindsight-tab-memories-${entry.key}">
			<div class="hindsight-search"><label>Search memories<input .value=${entry.search} @input=${(event: Event) => { entry.search = safeInput((event.target as HTMLInputElement).value); }} @keydown=${(event: KeyboardEvent) => { if (event.key === "Enter") { event.preventDefault(); void browse(entry); } }} placeholder="Search this project’s memory" /></label><button type="button" @click=${() => void browse(entry)} ?disabled=${entry.busy === "browse"}>${entry.busy === "browse" ? "Searching…" : "Search"}</button></div>
			<div class="hindsight-quick-retain"><label>Retain a memory<textarea .value=${entry.retain} @input=${(event: Event) => { entry.retain = safeInput((event.target as HTMLTextAreaElement).value); }}></textarea></label><button type="button" ?disabled=${!entry.retain.trim() || entry.busy === "retain"} @click=${async () => { const result = await call(entry, "retain", { method: "POST", body: { content: entry.retain.trim() } }); if (result?.ok !== false) { entry.retain = ""; entry.message = "Memory retained."; repaint(entry); } }}>Retain memory</button></div>
			<div class="hindsight-memory-grid"><div><h3>Memories</h3>${entry.memories.length ? html`<ul class="hindsight-memory-list">${entry.memories.map((memory) => html`<li><button type="button" class=${entry.selected === memory ? "selected" : ""} @click=${() => void selectMemory(entry, memory)}><strong>${memoryText(memory).slice(0, 140)}</strong><small>${text(memory.tags || memory.score)}</small></button></li>`)}</ul>` : html`<p class="hindsight-empty">Search or browse memories when you need them. Nothing is read automatically.</p>`}</div>
				<div class="hindsight-detail">${detail ? html`<h3>Memory detail</h3><p>${memoryText(detail)}</p>${history.length ? html`<details><summary>History (${history.length})</summary><ul>${history.map((event) => html`<li>${text(event.summary || event.reason || event.type, "History event")}</li>`)}</ul></details>` : nothing}<label>Reflection prompt<textarea .value=${entry.reflectPrompt} @input=${(event: Event) => { entry.reflectPrompt = safeInput((event.target as HTMLTextAreaElement).value); }}></textarea></label><button type="button" ?disabled=${!entry.reflectPrompt.trim() || entry.busy === "reflect"} @click=${async () => { const result = await call(entry, "reflect", { method: "POST", body: { prompt: entry.reflectPrompt.trim(), id: memoryId(entry.selected) } }); if (result) { entry.reflection = text(result.text || result.reflection); repaint(entry); } }}>Reflect</button>${entry.reflection ? html`<output class="hindsight-reflection">${entry.reflection}</output>` : nothing}<label>Completed outcome<textarea .value=${entry.outcome} @input=${(event: Event) => { entry.outcome = safeInput((event.target as HTMLTextAreaElement).value); }}></textarea></label><button type="button" ?disabled=${!entry.outcome.trim() || entry.busy === "retain-outcome"} @click=${async () => { const result = await call(entry, "retain-outcome", { method: "POST", body: { content: entry.outcome.trim() } }); if (result?.ok !== false) { entry.outcome = ""; entry.message = "Outcome retained."; repaint(entry); } }}>Retain outcome</button><label>Invalidation reason<input .value=${entry.invalidateReason} @input=${(event: Event) => { entry.invalidateReason = safeInput((event.target as HTMLInputElement).value); }} /></label><button type="button" class="hindsight-danger" ?disabled=${!entry.invalidateReason.trim()} @click=${() => openConfirm(entry, "invalidate", "Invalidate this memory")}>Invalidate</button>` : html`<p class="hindsight-empty">Select a memory to inspect its detail, history, and actions.</p>`}</div></div>
		</section>`;
	}
	function renderAccess(entry: Entry): unknown {
		return html`<section class="hindsight-section" role="tabpanel" id="hindsight-access-${entry.key}" aria-labelledby="hindsight-tab-access-${entry.key}"><div class="hindsight-card"><div><h3>Access</h3><p>Grants are project-scoped and evaluated again by every route. Manage grants and shared tool policy in Marketplace.</p></div><a href="#/market" class="hindsight-link">Open Marketplace</a></div><ul class="hindsight-capabilities">${CAPABILITIES.map((capability) => html`<li><code>${capability}</code><span>${capability === "memory.read.all" ? "Required only for an explicit all-project scope." : "Required when this action is used."}</span></li>`)}</ul></section>`;
	}
	function renderConfirm(entry: Entry): unknown {
		const confirm = entry.confirm;
		if (!confirm) return nothing;
		return html`<div class="hindsight-modal-backdrop"><section class="hindsight-modal" role="dialog" aria-modal="true" aria-labelledby="hindsight-confirm-title"><h3 id="hindsight-confirm-title">${confirm.label}?</h3><p>${confirm.action === "invalidate" ? "This hides the selected memory from future recall. The reason is recorded." : "This explicit action may change service state. Saving settings never does this."}</p><div class="hindsight-actions"><button type="button" data-hindsight-confirm-cancel @click=${() => closeConfirm(entry)}>Cancel</button><button type="button" class=${confirm.action === "invalidate" ? "hindsight-danger" : "hindsight-primary"} @click=${() => void confirm(entry)} ?disabled=${!!entry.busy}>${entry.busy ? "Working…" : "Confirm"}</button></div></section></div>`;
	}
	return {
		render(params?: Record<string, unknown>, host?: Host) {
			const entry = entryFor(params, host);
			return html`<section class="hindsight-panel" data-hindsight-panel=${entry.key} data-testid="hindsight-panel" @keydown=${(event: KeyboardEvent) => trapDialog(event, entry)}>
				<style>.hindsight-panel{position:relative;display:grid;gap:1rem;padding:1rem;color:var(--foreground);background:var(--background);min-width:0}.hindsight-tabs{display:flex;gap:.25rem;border-bottom:1px solid var(--border)}.hindsight-tabs button{border:0;border-bottom:2px solid transparent;background:transparent;color:var(--muted-foreground);padding:.5rem .7rem;font:inherit;cursor:pointer}.hindsight-tabs button[aria-selected=true]{color:var(--foreground);border-color:var(--primary);font-weight:600}.hindsight-tabs button:focus-visible,.hindsight-actions button:focus-visible,input:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--primary);outline-offset:2px}.hindsight-section{display:grid;gap:.75rem}.hindsight-card{display:flex;justify-content:space-between;gap:1rem;padding:.85rem;border:1px solid var(--border);border-radius:.5rem;background:var(--card)}.hindsight-card h3,.hindsight-detail h3{margin:0}.hindsight-card p,.hindsight-empty,.hindsight-migration p{margin:.3rem 0;color:var(--muted-foreground);font-size:.875rem}.hindsight-state{align-self:start;border-radius:999px;padding:.2rem .55rem;font-size:.75rem;white-space:nowrap;background:color-mix(in oklch,var(--muted-foreground) 14%,transparent)}.hindsight-state--ready{background:color-mix(in oklch,var(--positive) 20%,transparent)}.hindsight-state--degraded,.hindsight-state--blocked{background:color-mix(in oklch,var(--warning) 20%,transparent)}.hindsight-state--unavailable{background:color-mix(in oklch,var(--negative) 18%,transparent)}.hindsight-meta,.hindsight-actions{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}.hindsight-meta{font-size:.8rem;color:var(--muted-foreground)}.hindsight-actions button,.hindsight-search button{border:1px solid var(--border);border-radius:.35rem;padding:.35rem .55rem;background:var(--card);color:var(--foreground);font:inherit;cursor:pointer}.hindsight-actions button:hover:not(:disabled),.hindsight-search button:hover:not(:disabled){border-color:var(--primary)}button:disabled{opacity:.55;cursor:not-allowed}.hindsight-primary{background:var(--primary)!important;color:var(--primary-foreground,var(--background))!important}.hindsight-danger{border-color:var(--negative)!important;color:var(--negative)!important}.hindsight-logs{max-height:12rem;overflow:auto;margin:0;padding:.65rem;border:1px solid var(--border);border-radius:.4rem;background:var(--card);font-size:.75rem;white-space:pre-wrap}.hindsight-migration{padding:.75rem;border-left:3px solid var(--chart-4);background:color-mix(in oklch,var(--chart-4) 8%,transparent)}.hindsight-search,.hindsight-quick-retain{display:flex;gap:.5rem;align-items:end}.hindsight-search label,.hindsight-quick-retain label,.hindsight-detail label{display:grid;gap:.25rem;font-size:.8rem;color:var(--muted-foreground);flex:1}.hindsight-quick-retain button{border:1px solid var(--border);border-radius:.35rem;padding:.35rem .55rem;background:var(--card);color:var(--foreground);font:inherit;cursor:pointer}.hindsight-search input,.hindsight-detail input,.hindsight-detail textarea,.hindsight-quick-retain textarea{box-sizing:border-box;width:100%;border:1px solid var(--border);border-radius:.35rem;padding:.45rem;background:var(--background);color:var(--foreground);font:inherit}.hindsight-detail textarea,.hindsight-quick-retain textarea{min-height:4rem;resize:vertical}.hindsight-memory-grid{display:grid;grid-template-columns:minmax(12rem,1fr) minmax(16rem,1.2fr);gap:1rem}.hindsight-memory-list,.hindsight-capabilities{padding:0;margin:0;list-style:none}.hindsight-memory-list{display:grid;gap:.35rem}.hindsight-memory-list button{width:100%;text-align:left;border:1px solid var(--border);border-radius:.35rem;padding:.55rem;background:var(--card);color:var(--foreground);cursor:pointer}.hindsight-memory-list button.selected{border-color:var(--primary);background:color-mix(in oklch,var(--primary) 10%,var(--card))}.hindsight-memory-list strong,.hindsight-memory-list small{display:block}.hindsight-memory-list small{margin-top:.2rem;color:var(--muted-foreground)}.hindsight-detail{display:grid;align-content:start;gap:.6rem;padding:.8rem;border:1px solid var(--border);border-radius:.5rem}.hindsight-reflection{white-space:pre-wrap;padding:.6rem;border-left:3px solid var(--chart-2);background:color-mix(in oklch,var(--chart-2) 8%,transparent)}.hindsight-link{align-self:start;color:var(--primary)}.hindsight-capabilities{display:grid;gap:.45rem}.hindsight-capabilities li{display:flex;justify-content:space-between;gap:1rem;padding:.6rem;border-bottom:1px solid var(--border);font-size:.8rem}.hindsight-capabilities span{color:var(--muted-foreground);text-align:right}.hindsight-modal-backdrop{position:absolute;inset:0;z-index:2;display:grid;place-items:center;padding:1rem;background:color-mix(in oklch,var(--background) 74%,transparent)}.hindsight-modal{width:min(26rem,100%);display:grid;gap:.7rem;padding:1rem;border:1px solid var(--border);border-radius:.55rem;background:var(--card);box-shadow:0 .5rem 2rem color-mix(in oklch,var(--foreground) 18%,transparent)}.hindsight-modal h3,.hindsight-modal p{margin:0}.hindsight-modal p{color:var(--muted-foreground)}.hindsight-live{min-height:1.2em;color:var(--muted-foreground);font-size:.85rem}.hindsight-error{color:var(--negative)}@media(max-width:36rem){.hindsight-card,.hindsight-memory-grid{grid-template-columns:1fr;display:grid}.hindsight-card{gap:.6rem}.hindsight-search,.hindsight-quick-retain{align-items:stretch;flex-direction:column}.hindsight-capabilities li{display:grid;gap:.25rem}.hindsight-capabilities span{text-align:left}}</style>
				<div class="hindsight-tabs" role="tablist" aria-label="Hindsight memory panel">${TABS.map((tab) => html`<button type="button" id="hindsight-tab-${tab}-${entry.key}" data-hindsight-tab=${tab} role="tab" tabindex=${entry.activeTab === tab ? "0" : "-1"} aria-selected=${entry.activeTab === tab ? "true" : "false"} aria-controls="hindsight-${tab}-${entry.key}" @keydown=${(event: KeyboardEvent) => tabKey(event, entry)} @click=${() => selectTab(entry, tab)}>${tab[0].toUpperCase() + tab.slice(1)}</button>`)}</div>
				<div class="hindsight-live" role="status" aria-live="polite">${entry.error ? html`<span class="hindsight-error">${entry.error}</span>` : entry.message || ""}</div>
				${entry.activeTab === "service" ? renderService(entry) : entry.activeTab === "memories" ? renderMemories(entry) : renderAccess(entry)}
				${renderConfirm(entry)}
			</section>`;
		},
		dispose() {
			for (const entry of entries.values()) disposeEntry(entry);
			entries.clear();
			activeKey = undefined;
		},
	};
}

function cssEscape(value: string): string {
	return globalThis.CSS?.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}
