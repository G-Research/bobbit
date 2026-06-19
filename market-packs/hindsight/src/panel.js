// Hindsight pack CLIENT panel — the native config/status surface (Extension
// Platform P4, design docs/design/hindsight-panel-p4-implementation.md). It
// REPLACES E2E-only store-seeding as the user-facing configuration path: a
// theme-compatible panel to pick the deployment mode, configure the data-plane
// (external URL / API key / bank / namespace / managed data-dir / external
// Postgres URL / LLM key) and recall/retain toggles, observe a runtime status
// card (configured / healthy / mode / queue depth / last error), and search
// memory via recall.
//
// SECURITY + HOST-API INVARIANTS (mirrors pr-walkthrough/artifacts):
//   - NO raw fetch. ALL data flows through the versioned Host API
//     (`host.callRoute("config"|"status"|"recall")`). The panel never builds a
//     gateway URL and never reaches another pack's routes/store.
//   - NO direct `host.store` config writes — config persistence goes through the
//     `config` route so the server's validation (`validateConfigOverrides`) +
//     redaction (`redactConfig`) apply. The panel trusts the route's redaction.
//   - Secrets are WRITE-ONLY: the `config` GET surface returns only `*Set`
//     booleans (`apiKeySet`/`externalDatabaseUrlSet`/`llmApiKeySet`); the panel
//     renders a "set" placeholder and never echoes a stored secret. An untouched
//     secret field is OMITTED from the POST body (preserved); an explicit clear
//     sends "".
//   - NO auto-mutation on mount. `render` is a PURE projection; mount kicks only
//     READ calls (`config` GET, `status` GET) once per session, plus a bounded
//     health poll while a managed mode is configured-but-not-yet-healthy. Writes
//     (Save / Search) are user gestures. `retain`/`reflect` are never called.
//   - `lit` is HOST-INJECTED (`{ html, nothing, renderHeader }`) — never imported.
//   - Theme tokens ONLY — no hardcoded palette, no `prefers-color-scheme`.

const msgOf = (e) => (e && e.message ? String(e.message) : String(e));
const asText = (v, d = "") => (v == null ? d : String(v));
const SECRET_FIELDS = ["apiKey", "externalDatabaseUrl", "llmApiKey"];
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_TICKS = 20; // bounded ~30s health poll for managed modes coming up.

// Per-session panel state survives repaints + panel-instance re-creation within a
// page session (module-closure cache keyed by the bound `__sessionId`).
const STATE = globalThis.__bobbitHindsightPanelState || (globalThis.__bobbitHindsightPanelState = new Map());

function freshEntry() {
	return {
		mountKicked: false,
		configState: "loading", // loading | ready | error
		configError: null,
		config: null, // redacted config from `config` GET
		configured: false,
		draft: null, // editable form values
		secretTouched: { apiKey: false, externalDatabaseUrl: false, llmApiKey: false },
		dirty: false,
		saving: false,
		saveErrors: [],
		statusState: "loading", // loading | ready | error
		status: null,
		statusError: null,
		searchState: "idle", // idle | searching | results | empty | error
		searchResults: [],
		searchError: null,
		searchDormant: false,
		searchQuery: "",
		searchScope: "", // "" → use configured recallScope
		pollTimer: null,
		pollTicks: 0,
	};
}

/** Editable draft seeded from the redacted GET config. Secrets start empty
 *  (write-only); their "set" state is read from the `*Set` booleans at render. */
function draftFromConfig(cfg) {
	const c = cfg || {};
	return {
		mode: asText(c.mode, "external"),
		externalUrl: asText(c.externalUrl, ""),
		bank: asText(c.bank, "bobbit"),
		namespace: asText(c.namespace, "default"),
		dataDir: asText(c.dataDir, "~/.hindsight"),
		recallScope: c.recallScope === "project" ? "project" : "all",
		autoRecall: c.autoRecall !== false,
		autoRetain: c.autoRetain !== false,
		recallBudget: asText(c.recallBudget, "1200"),
		timeoutMs: asText(c.timeoutMs, "1500"),
		apiKey: "",
		externalDatabaseUrl: "",
		llmApiKey: "",
	};
}

export default function createPanel({ html, nothing, renderHeader }) {
	void renderHeader;

	const repaint = (host) => {
		try { host && host.requestRender && host.requestRender(); } catch { /* non-DOM */ }
	};

	const get = (key) => STATE.get(key);

	const clearPoll = (entry) => {
		if (entry && entry.pollTimer) {
			try { clearTimeout(entry.pollTimer); } catch { /* noop */ }
			entry.pollTimer = null;
		}
	};

	// ── Bounded managed-mode health poll: flips the badge to Connected when the
	//    runtime comes up. Runs ONLY while configured && !healthy && managed; stops
	//    on healthy / external / cap / unmount. Pure reads only.
	const maybePoll = (host, key) => {
		const entry = get(key);
		if (!entry || !entry.status) return;
		const s = entry.status;
		const managed = s.mode === "managed" || s.mode === "managed-external-postgres";
		const shouldPoll = managed && s.configured && !s.healthy && entry.pollTicks < POLL_MAX_TICKS;
		if (!shouldPoll) { clearPoll(entry); return; }
		if (entry.pollTimer) return;
		entry.pollTimer = setTimeout(() => {
			const e = get(key);
			if (!e) return;
			e.pollTimer = null;
			e.pollTicks += 1;
			loadStatus(host, key, /*fromPoll*/ true);
		}, POLL_INTERVAL_MS);
	};

	async function loadConfig(host, key) {
		try {
			const res = await host.callRoute("config", { method: "GET" });
			const entry = get(key);
			if (!entry) return;
			entry.config = res && res.config ? res.config : null;
			entry.configured = !!(res && res.configured);
			entry.draft = draftFromConfig(entry.config);
			entry.secretTouched = { apiKey: false, externalDatabaseUrl: false, llmApiKey: false };
			entry.dirty = false;
			entry.configState = "ready";
			repaint(host);
		} catch (e) {
			const entry = get(key);
			if (!entry) return;
			entry.configState = "error";
			entry.configError = msgOf(e);
			repaint(host);
		}
	}

	async function loadStatus(host, key, fromPoll = false) {
		const cur = get(key);
		if (cur && !fromPoll) cur.statusState = cur.status ? "ready" : "loading";
		try {
			const res = await host.callRoute("status", { method: "GET" });
			const entry = get(key);
			if (!entry) return;
			entry.status = res || null;
			entry.statusState = "ready";
			entry.statusError = null;
			maybePoll(host, key);
			repaint(host);
		} catch (e) {
			const entry = get(key);
			if (!entry) return;
			entry.statusState = "error";
			entry.statusError = msgOf(e);
			repaint(host);
		}
	}

	/** Build the POST body: only CHANGED non-secret fields + TOUCHED secrets. */
	function buildSaveBody(entry) {
		const cfg = entry.config || {};
		const d = entry.draft || {};
		const body = {};
		if (d.mode !== cfg.mode) body.mode = d.mode;
		for (const f of ["externalUrl", "bank", "namespace", "dataDir"]) {
			const cur = asText(d[f], "");
			const orig = asText(cfg[f], "");
			if (cur !== orig) body[f] = cur;
		}
		if (d.recallScope !== (cfg.recallScope === "project" ? "project" : "all")) body.recallScope = d.recallScope;
		for (const f of ["autoRecall", "autoRetain"]) {
			if (Boolean(d[f]) !== (cfg[f] !== false)) body[f] = Boolean(d[f]);
		}
		for (const f of ["recallBudget", "timeoutMs"]) {
			const n = Number(d[f]);
			if (Number.isFinite(n) && n > 0 && n !== Number(cfg[f])) body[f] = n;
		}
		for (const f of SECRET_FIELDS) {
			if (entry.secretTouched[f]) body[f] = asText(d[f], "");
		}
		return body;
	}

	async function save(host, key) {
		const entry = get(key);
		if (!entry || !entry.draft || entry.saving) return;
		entry.saving = true;
		entry.saveErrors = [];
		repaint(host);
		const body = buildSaveBody(entry);
		try {
			const res = await host.callRoute("config", { method: "POST", body });
			const e2 = get(key);
			if (!e2) return;
			e2.saving = false;
			if (res && res.ok === false) {
				e2.saveErrors = Array.isArray(res.errors) && res.errors.length ? res.errors : [asText(res.error, "Save failed")];
				repaint(host);
				return;
			}
			e2.config = res && res.config ? res.config : e2.config;
			e2.configured = !!(res && res.configured);
			e2.draft = draftFromConfig(e2.config);
			e2.secretTouched = { apiKey: false, externalDatabaseUrl: false, llmApiKey: false };
			e2.dirty = false;
			e2.pollTicks = 0;
			loadStatus(host, key); // refresh status after a successful save.
			repaint(host);
		} catch (err) {
			const e2 = get(key);
			if (!e2) return;
			e2.saving = false;
			e2.saveErrors = [msgOf(err)];
			repaint(host);
		}
	}

	async function runSearch(host, key) {
		const entry = get(key);
		if (!entry) return;
		const query = asText(entry.searchQuery, "").trim();
		if (!query) return;
		entry.searchState = "searching";
		entry.searchError = null;
		repaint(host);
		const scope = entry.searchScope || (entry.config && entry.config.recallScope) || "all";
		try {
			const res = await host.callRoute("recall", { method: "POST", body: { query, scope } });
			const e2 = get(key);
			if (!e2) return;
			if (res && res.configured === false) {
				e2.searchResults = [];
				e2.searchDormant = true;
				e2.searchState = "empty";
				e2.searchError = null;
			} else if (res && res.error) {
				e2.searchResults = [];
				e2.searchDormant = false;
				e2.searchState = "error";
				e2.searchError = String(res.error);
			} else {
				const mems = res && Array.isArray(res.memories) ? res.memories : [];
				e2.searchResults = mems;
				e2.searchDormant = false;
				e2.searchState = mems.length ? "results" : "empty";
				e2.searchError = null;
			}
			repaint(host);
		} catch (err) {
			const e2 = get(key);
			if (!e2) return;
			e2.searchState = "error";
			e2.searchError = msgOf(err);
			e2.searchResults = [];
			repaint(host);
		}
	}

	// ── Field mutators (local draft only; never touches host.store). ──
	const setField = (host, key, field, value) => {
		const entry = get(key);
		if (!entry || !entry.draft) return;
		entry.draft = { ...entry.draft, [field]: value };
		entry.dirty = true;
		repaint(host);
	};
	const setSecret = (host, key, field, value) => {
		const entry = get(key);
		if (!entry || !entry.draft) return;
		entry.draft = { ...entry.draft, [field]: value };
		entry.secretTouched = { ...entry.secretTouched, [field]: true };
		entry.dirty = true;
		repaint(host);
	};

	// ── Badge derivation (status-driven, falls back to config snapshot). ──
	function deriveBadge(entry) {
		const s = entry.status;
		const configured = s ? !!s.configured : !!entry.configured;
		if (!configured) return { state: "dormant", label: "Dormant", hint: "Not configured" };
		if (s && s.healthy) return { state: "connected", label: "Connected", hint: "" };
		const mode = (s && s.mode) || (entry.config && entry.config.mode) || "external";
		if (mode === "external") return { state: "unreachable", label: "Unreachable", hint: "" };
		return { state: "starting", label: "Starting", hint: "Managed runtime not running" };
	}

	const isManaged = (mode) => mode === "managed" || mode === "managed-external-postgres";

	// ── Rendering ──────────────────────────────────────────────────────────────
	const renderField = (label, testid, value, oninput, opts = {}) => html`
		<label class="hs-field">
			<span class="hs-label">${label}</span>
			<input
				class="hs-input"
				data-testid=${testid}
				type=${opts.type || "text"}
				.value=${asText(value, "")}
				placeholder=${opts.placeholder || ""}
				@input=${oninput}
			/>
			${opts.hint ? html`<span class="hs-hint">${opts.hint}</span>` : nothing}
		</label>`;

	const renderSecret = (label, testid, field, entry, host, key, opts = {}) => {
		const d = entry.draft || {};
		const setFlag = entry.config && entry.config[`${field}Set`];
		const placeholder = !entry.secretTouched[field] && setFlag ? "•••• set" : (opts.placeholder || "");
		return html`
			<label class="hs-field">
				<span class="hs-label">${label}</span>
				<input
					class="hs-input"
					data-testid=${testid}
					type="password"
					autocomplete="off"
					.value=${asText(d[field], "")}
					placeholder=${placeholder}
					@input=${(e) => setSecret(host, key, field, e.currentTarget.value)}
				/>
				${opts.hint ? html`<span class="hs-hint">${opts.hint}</span>` : nothing}
			</label>`;
	};

	const renderToggle = (label, testid, checked, onchange) => html`
		<label class="hs-toggle">
			<input type="checkbox" data-testid=${testid} .checked=${!!checked} @change=${onchange} />
			<span>${label}</span>
		</label>`;

	const renderStatusCard = (entry, host, key) => {
		const badge = deriveBadge(entry);
		const s = entry.status || {};
		const mode = asText(s.mode || (entry.config && entry.config.mode), "external");
		const queueDepth = Number(s.queueDepth || 0);
		const lastError = s.lastError;
		const lastErrMsg = lastError && typeof lastError === "object" ? asText(lastError.message) : asText(lastError, "");
		return html`
			<section class="hs-card" data-testid="hindsight-status-card">
				<div class="hs-card-head">
					<h2 class="hs-card-title">Runtime status</h2>
					<div class="hs-card-actions">
						<span class="hs-badge" data-testid="hindsight-status-badge" data-state=${badge.state} title=${badge.hint || badge.label}>${badge.label}</span>
						<button class="hs-btn" data-testid="hindsight-refresh" type="button" ?disabled=${entry.statusState === "loading"} @click=${() => loadStatus(host, key)}>Refresh</button>
					</div>
				</div>
				${entry.statusState === "error"
					? html`<p class="hs-error" data-testid="hindsight-status-error">${asText(entry.statusError, "Status unavailable")}</p>`
					: html`
						<dl class="hs-rows">
							<div class="hs-row"><dt>Mode</dt><dd data-testid="hindsight-status-mode">${mode}</dd></div>
							<div class="hs-row"><dt>Bank</dt><dd>${asText(s.bank || (entry.config && entry.config.bank), "bobbit")}</dd></div>
							<div class="hs-row"><dt>Namespace</dt><dd>${asText(s.namespace || (entry.config && entry.config.namespace), "default")}</dd></div>
							<div class="hs-row"><dt>Recall scope</dt><dd>${asText(s.recallScope || (entry.config && entry.config.recallScope), "all")}</dd></div>
							<div class="hs-row"><dt>Auto recall / retain</dt><dd>${s.autoRecall === false ? "off" : "on"} / ${s.autoRetain === false ? "off" : "on"}</dd></div>
						</dl>
						<div class="hs-chips">
							<span class="hs-chip" data-testid="hindsight-queue-depth" data-queue-depth=${String(queueDepth)}>${queueDepth} queued ${queueDepth === 1 ? "retain" : "retains"}</span>
							${isManaged(mode) ? html`<span class="hs-chip hs-chip-muted" data-testid="hindsight-logs-link" title="View runtime logs in the Marketplace runtime view">Logs: Marketplace runtime view</span>` : nothing}
						</div>
						${lastErrMsg ? html`<p class="hs-last-error" data-testid="hindsight-last-error">Last error: ${lastErrMsg}</p>` : nothing}
					`}
			</section>`;
	};

	const renderConfigCard = (entry, host, key) => {
		const d = entry.draft || draftFromConfig(null);
		const mode = d.mode;
		const onMode = (e) => setField(host, key, "mode", e.currentTarget.value);
		return html`
			<section class="hs-card" data-testid="hindsight-config-card">
				<div class="hs-card-head">
					<h2 class="hs-card-title">Configuration</h2>
					<button class="hs-btn hs-btn-primary" data-testid="hindsight-save" type="button" ?disabled=${entry.saving} @click=${() => save(host, key)}>${entry.saving ? "Saving…" : "Save"}</button>
				</div>

				<label class="hs-field">
					<span class="hs-label">Deployment mode</span>
					<select class="hs-input" data-testid="hindsight-mode" .value=${mode} @change=${onMode}>
						<option value="external" ?selected=${mode === "external"}>External (operator-supplied URL)</option>
						<option value="managed" ?selected=${mode === "managed"}>Managed (Bobbit-run, managed Postgres)</option>
						<option value="managed-external-postgres" ?selected=${mode === "managed-external-postgres"}>Managed + external Postgres</option>
					</select>
				</label>

				${mode === "external"
					? renderField("External URL", "hindsight-external-url", d.externalUrl, (e) => setField(host, key, "externalUrl", e.currentTarget.value), { placeholder: "https://hindsight.example.com", hint: "Activates external mode; empty keeps it dormant." })
					: nothing}

				${isManaged(mode)
					? renderField("Managed data dir", "hindsight-data-dir", d.dataDir, (e) => setField(host, key, "dataDir", e.currentTarget.value), { placeholder: "~/.hindsight", hint: mode === "managed" ? "Host bind-mount path for managed Postgres data." : "" })
					: nothing}

				${mode === "managed-external-postgres"
					? renderSecret("External Postgres URL", "hindsight-external-db-url", "externalDatabaseUrl", entry, host, key, { hint: "→ runtime HINDSIGHT_API_DATABASE_URL. Required to start." })
					: nothing}

				${isManaged(mode)
					? renderSecret("LLM API key", "hindsight-llm-api-key", "llmApiKey", entry, host, key, { hint: "→ runtime HINDSIGHT_API_LLM_API_KEY. Required to start." })
					: nothing}

				${renderSecret("API key", "hindsight-api-key", "apiKey", entry, host, key, { hint: "Optional bearer token for the Hindsight API." })}

				<div class="hs-grid2">
					${renderField("Bank", "hindsight-bank", d.bank, (e) => setField(host, key, "bank", e.currentTarget.value), { placeholder: "bobbit" })}
					${renderField("Namespace", "hindsight-namespace", d.namespace, (e) => setField(host, key, "namespace", e.currentTarget.value), { placeholder: "default" })}
				</div>

				<label class="hs-field">
					<span class="hs-label">Recall scope</span>
					<select class="hs-input" data-testid="hindsight-recall-scope" .value=${d.recallScope} @change=${(e) => setField(host, key, "recallScope", e.currentTarget.value)}>
						<option value="all" ?selected=${d.recallScope === "all"}>All</option>
						<option value="project" ?selected=${d.recallScope === "project"}>This project</option>
					</select>
				</label>

				<div class="hs-toggles">
					${renderToggle("Auto recall", "hindsight-auto-recall", d.autoRecall, (e) => setField(host, key, "autoRecall", e.currentTarget.checked))}
					${renderToggle("Auto retain", "hindsight-auto-retain", d.autoRetain, (e) => setField(host, key, "autoRetain", e.currentTarget.checked))}
				</div>

				<div class="hs-grid2">
					${renderField("Recall budget (tokens)", "hindsight-recall-budget", d.recallBudget, (e) => setField(host, key, "recallBudget", e.currentTarget.value), { type: "number" })}
					${renderField("Timeout (ms)", "hindsight-timeout", d.timeoutMs, (e) => setField(host, key, "timeoutMs", e.currentTarget.value), { type: "number" })}
				</div>

				${entry.saveErrors && entry.saveErrors.length
					? html`<ul class="hs-errors" data-testid="hindsight-config-error">${entry.saveErrors.map((err) => html`<li>${asText(err)}</li>`)}</ul>`
					: nothing}
			</section>`;
	};

	const renderMemory = (mem, index) => {
		const text = asText(mem && mem.text, "");
		const hasScore = mem && (typeof mem.score === "number");
		const id = mem && mem.id != null ? String(mem.id) : "";
		return html`
			<li class="hs-memory" data-testid="hindsight-memory-result" data-memory-id=${id}>
				<div class="hs-memory-text">${text}</div>
				<div class="hs-memory-meta">
					${hasScore ? html`<span class="hs-chip">score ${Number(mem.score).toFixed(2)}</span>` : nothing}
					${id ? html`<span class="hs-memory-id">${id}</span>` : nothing}
				</div>
			</li>`;
	};

	const renderSearchCard = (entry, host, key) => {
		const onSubmit = (e) => { if (e) e.preventDefault(); runSearch(host, key); };
		const scope = entry.searchScope || (entry.config && entry.config.recallScope) || "all";
		return html`
			<section class="hs-card" data-testid="hindsight-search-card">
				<h2 class="hs-card-title">Search memory</h2>
				<form class="hs-search-row" @submit=${onSubmit}>
					<input
						class="hs-input"
						data-testid="hindsight-search-input"
						type="text"
						placeholder="Search recalled memories…"
						.value=${asText(entry.searchQuery, "")}
						@input=${(e) => { const en = get(key); if (en) en.searchQuery = e.currentTarget.value; }}
					/>
					<select class="hs-input hs-scope" data-testid="hindsight-search-scope" .value=${scope} @change=${(e) => { const en = get(key); if (en) { en.searchScope = e.currentTarget.value; repaint(host); } }}>
						<option value="all" ?selected=${scope === "all"}>All</option>
						<option value="project" ?selected=${scope === "project"}>This project</option>
					</select>
					<button class="hs-btn hs-btn-primary" data-testid="hindsight-search-submit" type="submit" ?disabled=${entry.searchState === "searching"}>${entry.searchState === "searching" ? "Searching…" : "Search"}</button>
				</form>
				${renderSearchResults(entry)}
			</section>`;
	};

	const renderSearchResults = (entry) => {
		if (entry.searchState === "searching") return html`<p class="hs-muted" data-testid="hindsight-search-loading">Searching…</p>`;
		if (entry.searchState === "error") return html`<p class="hs-error" data-testid="hindsight-search-error">${asText(entry.searchError, "Search failed")}</p>`;
		if (entry.searchState === "empty") {
			return entry.searchDormant
				? html`<p class="hs-muted" data-testid="hindsight-search-empty">Configure Hindsight to search memory.</p>`
				: html`<p class="hs-muted" data-testid="hindsight-search-empty">No memories matched.</p>`;
		}
		if (entry.searchState === "results") {
			return html`<ul class="hs-memories">${entry.searchResults.map((mem, i) => renderMemory(mem, i))}</ul>`;
		}
		return nothing;
	};

	const STYLE = html`<style>
		.hs-root { color: var(--foreground); background: var(--background); padding: 16px; min-height: 100%; box-sizing: border-box; display: flex; flex-direction: column; gap: 16px; font-size: 13px; }
		.hs-root h1 { font-size: 16px; margin: 0; }
		.hs-root h2 { font-size: 14px; margin: 0; }
		.hs-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
		.hs-card { border: 1px solid var(--border); border-radius: 10px; background: var(--card); padding: 14px; display: flex; flex-direction: column; gap: 12px; }
		.hs-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
		.hs-card-title { color: var(--foreground); }
		.hs-card-actions { display: flex; align-items: center; gap: 8px; }
		.hs-rows { display: grid; grid-template-columns: 1fr; gap: 6px; margin: 0; }
		.hs-row { display: flex; justify-content: space-between; gap: 12px; }
		.hs-row dt { color: var(--muted-foreground); }
		.hs-row dd { margin: 0; color: var(--foreground); font-variant-numeric: tabular-nums; }
		.hs-field { display: flex; flex-direction: column; gap: 4px; }
		.hs-label { color: var(--muted-foreground); font-size: 12px; }
		.hs-hint { color: var(--muted-foreground); font-size: 11px; }
		.hs-input { width: 100%; box-sizing: border-box; background: var(--background); color: var(--foreground); border: 1px solid var(--border); border-radius: 7px; padding: 7px 9px; font: inherit; }
		.hs-input:focus { outline: none; border-color: var(--primary); }
		.hs-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
		.hs-toggles { display: flex; gap: 18px; flex-wrap: wrap; }
		.hs-toggle { display: inline-flex; align-items: center; gap: 6px; color: var(--foreground); }
		.hs-btn { background: var(--background); color: var(--foreground); border: 1px solid var(--border); border-radius: 7px; padding: 6px 12px; font: inherit; cursor: pointer; }
		.hs-btn:hover:not(:disabled) { border-color: var(--primary); }
		.hs-btn:disabled { opacity: 0.55; cursor: default; }
		.hs-btn-primary { background: var(--primary); color: var(--background); border-color: var(--primary); }
		.hs-badge { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; border: 1px solid var(--border); color: var(--muted-foreground); background: color-mix(in oklch, var(--muted-foreground) 12%, transparent); }
		.hs-badge[data-state="connected"] { color: var(--positive); border-color: color-mix(in oklch, var(--positive) 45%, transparent); background: color-mix(in oklch, var(--positive) 14%, transparent); }
		.hs-badge[data-state="unreachable"] { color: var(--negative); border-color: color-mix(in oklch, var(--negative) 45%, transparent); background: color-mix(in oklch, var(--negative) 14%, transparent); }
		.hs-badge[data-state="starting"] { color: var(--warning); border-color: color-mix(in oklch, var(--warning) 45%, transparent); background: color-mix(in oklch, var(--warning) 14%, transparent); }
		.hs-chips { display: flex; gap: 8px; flex-wrap: wrap; }
		.hs-chip { display: inline-flex; align-items: center; padding: 2px 9px; border-radius: 999px; font-size: 12px; border: 1px solid var(--border); background: color-mix(in oklch, var(--chart-1) 10%, transparent); color: var(--foreground); }
		.hs-chip-muted { background: color-mix(in oklch, var(--muted-foreground) 10%, transparent); color: var(--muted-foreground); }
		.hs-muted { color: var(--muted-foreground); margin: 0; }
		.hs-error { color: var(--negative); margin: 0; }
		.hs-last-error { color: var(--muted-foreground); font-size: 12px; margin: 0; }
		.hs-errors { color: var(--negative); margin: 0; padding-left: 18px; font-size: 12px; }
		.hs-search-row { display: flex; gap: 8px; align-items: center; }
		.hs-search-row .hs-input { flex: 1; }
		.hs-scope { flex: 0 0 auto; width: auto; }
		.hs-memories { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
		.hs-memory { border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: var(--background); display: flex; flex-direction: column; gap: 6px; }
		.hs-memory-text { color: var(--foreground); white-space: pre-wrap; word-break: break-word; }
		.hs-memory-meta { display: flex; gap: 8px; align-items: center; }
		.hs-memory-id { color: var(--muted-foreground); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
	</style>`;

	return {
		render(params, host) {
			const key = (params && params.__sessionId) || "hindsight-default";

			// Feature-detect Phase-2 callRoute; degrade gracefully on a Phase-1 host.
			const canRoute = !!(host && host.capabilities && host.capabilities.callRoute && typeof host.callRoute === "function");
			if (!canRoute) {
				return html`${STYLE}<div class="hs-root" data-testid="hindsight-panel" data-state="unavailable"><p class="hs-muted">Hindsight memory is unavailable on this host.</p></div>`;
			}

			let entry = get(key);
			if (!entry) { entry = freshEntry(); STATE.set(key, entry); }

			// Mount: kick READ-only loads ONCE per session (never on every repaint,
			// never a write). Pure projection thereafter from the cached snapshot.
			if (!entry.mountKicked) {
				entry.mountKicked = true;
				loadConfig(host, key);
				loadStatus(host, key);
			}

			const loadingConfig = entry.configState === "loading" && !entry.draft;
			return html`
				${STYLE}
				<div class="hs-root" data-testid="hindsight-panel" data-config-state=${entry.configState} data-status-state=${entry.statusState}>
					<div class="hs-head">
						<h1>Hindsight Memory</h1>
					</div>
					${renderStatusCard(entry, host, key)}
					${entry.configState === "error"
						? html`<section class="hs-card"><p class="hs-error" data-testid="hindsight-config-load-error">${asText(entry.configError, "Config unavailable")}</p></section>`
						: loadingConfig
							? html`<section class="hs-card"><p class="hs-muted" data-testid="hindsight-config-loading">Loading configuration…</p></section>`
							: renderConfigCard(entry, host, key)}
					${renderSearchCard(entry, host, key)}
				</div>`;
		},
	};
}
