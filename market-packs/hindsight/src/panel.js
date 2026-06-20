// Hindsight pack CLIENT panel — the native config/status surface (Extension
// Platform P4, design docs/design/hindsight-panel-p4-implementation.md + the
// follow-on UX polish docs/design/hindsight-ux-polish-implementation.md). It
// REPLACES E2E-only store-seeding as the user-facing configuration path: a
// theme-compatible panel to pick the deployment mode, configure the data-plane
// (external API URL / optional UI URL / API key / bank / namespace / managed
// data-dir / external Postgres URL / LLM key) and recall/retain toggles, observe a
// runtime status card (state / queue depth / active config / last error), run a
// guided setup walkthrough, explicitly Start/Stop the managed runtime, and search
// memory via recall.
//
// SECURITY + HOST-API INVARIANTS (mirrors pr-walkthrough/artifacts):
//   - NO raw fetch for CONFIG/STATUS/RECALL. ALL such data flows through the
//     versioned Host API (`host.callRoute("config"|"status"|"recall")`). The panel
//     never builds a gateway URL for data and never reaches another pack's
//     routes/store. The ONLY raw-gateway seam is the server admin runtime surface
//     (`/api/pack-runtimes/:id/{logs,start,stop}`) — read-only logs plus the two
//     EXPLICIT user-gesture runtime actions (Start/Stop). See §4.5 of the UX doc.
//   - NO direct `host.store` config writes — config persistence goes through the
//     `config` route so the server's validation (`validateConfigOverrides`) +
//     redaction (`redactConfig`) apply. The panel trusts the route's redaction.
//   - Secrets are WRITE-ONLY: the `config` GET surface returns only `*Set`
//     booleans (`apiKeySet`/`externalDatabaseUrlSet`/`llmApiKeySet`); the panel
//     renders a "set" placeholder and never echoes a stored secret. `uiUrl` is
//     NON-secret (echoed verbatim). An untouched secret field is OMITTED from the
//     POST body (preserved); an explicit clear sends "".
//   - NO auto-mutation on mount. `render` is a PURE projection; mount kicks only
//     READ calls (`config` GET, `status` GET) once per session, plus a bounded
//     health poll while a managed mode is STARTING. Writes (Save) and runtime
//     Start/Stop are user gestures. NOTHING starts Docker on mount, mode-select,
//     Refresh, or Save — the ONLY start path is the `hindsight-start-runtime`
//     click handler. `retain`/`reflect` are never called.
//   - `lit` is HOST-INJECTED (`{ html, nothing, renderHeader }`) — never imported.
//   - Theme tokens ONLY — no hardcoded palette, no `prefers-color-scheme`.

const msgOf = (e) => (e && e.message ? String(e.message) : String(e));
const asText = (v, d = "") => (v == null ? d : String(v));
const SECRET_FIELDS = ["apiKey", "externalDatabaseUrl", "llmApiKey"];
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_TICKS = 20; // bounded ~30s health poll for managed modes coming up.
const LOGS_TAIL = 200;

// The managed runtime's URL-safe API id (mirrors the server's
// encodePackRuntimeId(packId, runtimeId)). For this first-party pack the
// structural packId and the runtime id are both `hindsight`.
const RUNTIME_API_ID = `${encodeURIComponent("hindsight")}:${encodeURIComponent("hindsight")}`;

// AJ-baked examples surfaced in copy (UX doc §8). API and UI URLs are DISTINCT —
// never fabricate the UI URL from the API URL (different port/path).
const EX_API_URL = "http://localhost:9177";
const EX_UI_URL = "http://localhost:19177/banks/hermes?view=data";

// Resolve the authed gateway base + bearer for the managed-runtime admin surface
// (`/api/pack-runtimes/:id/{logs,start,stop}`). These are SERVER admin routes (NOT
// pack routes), so they are reached the same way the built-in BgProcessPill reaches
// its own logs route: the panel module runs in the app realm and reads the gateway
// url/token the shell persisted. This is the ONLY raw gateway fetch in the panel and
// is confined to the read-only logs affordance + the two EXPLICIT runtime actions
// (Start/Stop) — all CONFIG/STATUS/RECALL data still flows through the Host API.
function gatewayBase() {
	try {
		return (globalThis.localStorage && localStorage.getItem("gateway.url")) || globalThis.location?.origin || "";
	} catch {
		return globalThis.location?.origin || "";
	}
}
function gatewayToken() {
	try {
		return (globalThis.localStorage && localStorage.getItem("gateway.token")) || "";
	} catch {
		return "";
	}
}

/** True iff `s` is a non-empty, well-formed http(s) URL. Used for inline
 *  validation of the external API URL / UI URL fields (display-only; never blocks
 *  Save — a degraded-but-saved config is valid). */
function isHttpUrl(s) {
	const v = asText(s, "").trim();
	if (!v) return false;
	try {
		const u = new URL(v);
		return u.protocol === "http:" || u.protocol === "https:";
	} catch {
		return false;
	}
}

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
		// Non-secret fields the user has ACTUALLY edited this draft session. Save
		// builds the POST body ONLY from touched fields (+ touched secrets), so a
		// stale-but-untouched field can never clobber a config that changed on the
		// server after mount (the headline B2 regression). Reset whenever the draft
		// is re-seeded from the persisted config (clean load / save / discard).
		touched: {},
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
		logsOpen: false,
		logsState: "idle", // idle | loading | loaded | error
		logs: "",
		logsError: null,
		// ── UX polish additions ──
		setupOpen: false, // explicit "Setup guide" toggle (auto-shown when dormant)
		setupProgress: null, // { connection, recall } step states for the smoke test
		setupTesting: false,
		managedConsentAck: false, // managed-runtime consent disclosure acknowledged
		runtimePhase: "idle", // idle | starting | stopping | error (explicit Start/Stop)
		runtimeError: null,
	};
}

/** Editable draft seeded from the redacted GET config. Secrets start empty
 *  (write-only); their "set" state is read from the `*Set` booleans at render. */
function draftFromConfig(cfg) {
	const c = cfg || {};
	return {
		mode: asText(c.mode, "external"),
		externalUrl: asText(c.externalUrl, ""),
		uiUrl: asText(c.uiUrl, ""),
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

	const isManaged = (mode) => mode === "managed" || mode === "managed-external-postgres";

	// ── Bounded managed-mode health poll: flips the badge to Running when the
	//    runtime comes up. Runs ONLY while a managed runtime is STARTING (an explicit
	//    Start was issued, or the runtime reports `starting`); stops on healthy /
	//    running / external / cap / unmount. A KNOWN-stopped runtime is never polled
	//    (no churn). Pure reads only — NEVER starts anything.
	const maybePoll = (host, key) => {
		const entry = get(key);
		if (!entry || !entry.status) { entry && clearPoll(entry); return; }
		const s = entry.status;
		const managed = isManaged(s.mode);
		// Only poll while transitioning up: an explicit Start is in flight, OR the
		// runtime reports `starting`, OR (legacy host without runtimeStatus) it is
		// configured-but-not-healthy. A reported `stopped` runtime is NOT polled.
		const transitioning =
			entry.runtimePhase === "starting" ||
			s.runtimeStatus === "starting" ||
			(s.runtimeStatus === undefined && s.configured && !s.healthy);
		const shouldPoll = managed && s.configured && !s.healthy && transitioning && entry.pollTicks < POLL_MAX_TICKS;
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

	// ── Loads ────────────────────────────────────────────────────────────────
	// loadConfig is DIRTY-AWARE: it always refreshes `entry.config` (the diff base
	// for Save) but only re-seeds the editable draft when the user has NO unsaved
	// edits. This is the core of the stale-form fix (UX doc §7 / impl §4.1):
	//   - clean draft → reseed from the freshly-loaded persisted config (fixes B1).
	//   - dirty draft → keep the user's edits but still update the diff base so a
	//     later Save diffs against the LIVE config, never a stale snapshot (fixes B2).
	// Dirty-aware hydration shared by loadConfig and the pre-save freshness refresh:
	// always refresh `entry.config` (the diff base) but only re-seed the editable
	// draft when the user has no unsaved edits. Pure state mutation (no repaint).
	function applyLoadedConfig(entry, res) {
		entry.config = res && res.config ? res.config : null;
		entry.configured = !!(res && res.configured);
		if (!entry.dirty) {
			entry.draft = draftFromConfig(entry.config);
			entry.secretTouched = { apiKey: false, externalDatabaseUrl: false, llmApiKey: false };
			entry.touched = {};
		} else if (!entry.draft) {
			// Defensive: never leave the form without a draft to render.
			entry.draft = draftFromConfig(entry.config);
		}
	}

	// Returns true on a successful load, false on failure, so callers (Save) can
	// fail-fast instead of proceeding from a stale snapshot.
	async function loadConfig(host, key) {
		try {
			const res = await host.callRoute("config", { method: "GET" });
			const entry = get(key);
			if (!entry) return false;
			applyLoadedConfig(entry, res);
			entry.configState = "ready";
			repaint(host);
			return true;
		} catch (e) {
			const entry = get(key);
			if (!entry) return false;
			entry.configState = "error";
			entry.configError = msgOf(e);
			repaint(host);
			return false;
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
			// Clear the transient explicit-start phase once the runtime is healthy/up.
			if (entry.runtimePhase === "starting" && res && (res.healthy || res.runtimeStatus === "running")) {
				entry.runtimePhase = "idle";
			}
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

	/** Re-hydrate BOTH config and status from the same trigger so the form and the
	 *  status card can never reflect different load generations (UX doc §7.1). */
	const refreshAll = (host, key) => {
		loadConfig(host, key);
		loadStatus(host, key);
	};

	/** Build the POST body from ONLY the fields the user actually edited this draft
	 *  session — `entry.touched[f]` for non-secrets, `entry.secretTouched[f]` for
	 *  secrets. An UNTOUCHED field is NEVER sent, even if its (stale) draft value
	 *  differs from the freshly-loaded config: this is the headline B2 fix. Example:
	 *  the panel mounts dormant (externalUrl="", bank="bobbit", timeoutMs=1500), the
	 *  server config changes out-of-band to external/hermes/15000, the user toggles
	 *  ONLY autoRetain and Saves. A diff-everything body would POST the stale
	 *  externalUrl/bank/timeout and clobber the good config; gating on `touched`
	 *  sends just `{ autoRetain }`. Touched fields are still diffed against the live
	 *  config (refreshed by Save first) so an unchanged value is a harmless no-op. */
	function buildSaveBody(entry) {
		const cfg = entry.config || {};
		const d = entry.draft || {};
		const t = entry.touched || {};
		const body = {};
		if (t.mode && d.mode !== cfg.mode) body.mode = d.mode;
		for (const f of ["externalUrl", "uiUrl", "bank", "namespace", "dataDir"]) {
			if (!t[f]) continue;
			const cur = asText(d[f], "");
			const orig = asText(cfg[f], "");
			if (cur !== orig) body[f] = cur;
		}
		if (t.recallScope && d.recallScope !== (cfg.recallScope === "project" ? "project" : "all")) body.recallScope = d.recallScope;
		for (const f of ["autoRecall", "autoRetain"]) {
			if (t[f] && Boolean(d[f]) !== (cfg[f] !== false)) body[f] = Boolean(d[f]);
		}
		for (const f of ["recallBudget", "timeoutMs"]) {
			if (!t[f]) continue;
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
		// Refresh the diff base from the server BEFORE building the body so a stale
		// snapshot can never send keys that overwrite a good config (B2). This MUST be
		// fail-fast: if the GET fails we abort with a visible save error rather than
		// posting a body diffed against a stale `entry.config`.
		let fresh;
		try {
			fresh = await host.callRoute("config", { method: "GET" });
		} catch (err) {
			const eErr = get(key);
			if (!eErr) return;
			eErr.saving = false;
			eErr.saveErrors = [`Couldn't verify the current configuration before saving: ${msgOf(err)}. Save aborted to avoid overwriting a good config — try again.`];
			repaint(host);
			return;
		}
		const e1 = get(key);
		if (!e1) return;
		applyLoadedConfig(e1, fresh); // dirty-aware: updates diff base, keeps draft.
		const body = buildSaveBody(e1);
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
			e2.touched = {};
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

	/** Discard unsaved edits: re-seed the draft from the last-loaded persisted
	 *  config and clear the dirty flag (UX doc §7 / impl §4.1.4). */
	const discardEdits = (host, key) => {
		const entry = get(key);
		if (!entry) return;
		entry.draft = draftFromConfig(entry.config);
		entry.secretTouched = { apiKey: false, externalDatabaseUrl: false, llmApiKey: false };
		entry.touched = {};
		entry.dirty = false;
		repaint(host);
	};

	// ── Managed-runtime logs: a REAL affordance (not static text). Toggles an
	//    inline view that fetches GET /api/pack-runtimes/:id/logs?tail= from the
	//    server runtime-logs surface. Read-only; only ever a GET. ──
	async function loadLogs(host, key) {
		const entry = get(key);
		if (!entry) return;
		entry.logsState = "loading";
		entry.logsError = null;
		repaint(host);
		try {
			const base = gatewayBase();
			const res = await fetch(`${base}/api/pack-runtimes/${RUNTIME_API_ID}/logs?tail=${LOGS_TAIL}`, {
				headers: { Authorization: `Bearer ${gatewayToken()}` },
			});
			const e2 = get(key);
			if (!e2) return;
			if (!res.ok) {
				e2.logsState = "error";
				e2.logsError = `HTTP ${res.status}`;
				repaint(host);
				return;
			}
			const data = await res.json().catch(() => ({}));
			e2.logs = asText(data && data.logs, "");
			e2.logsState = "loaded";
			e2.logsError = data && data.status === "docker-unavailable" ? "Docker is not available" : null;
			repaint(host);
		} catch (err) {
			const e2 = get(key);
			if (!e2) return;
			e2.logsState = "error";
			e2.logsError = msgOf(err);
			repaint(host);
		}
	}

	const toggleLogs = (host, key) => {
		const entry = get(key);
		if (!entry) return;
		entry.logsOpen = !entry.logsOpen;
		repaint(host);
		if (entry.logsOpen) loadLogs(host, key);
	};

	// ── EXPLICIT managed-runtime Start / Stop (the ONLY Docker-starting path). ──
	//    Both are user gestures; Start is additionally gated in the UI behind the
	//    consent disclosure + required-inputs check (see `renderManagedCard`).
	async function runtimeAction(host, key, action) {
		const entry = get(key);
		if (!entry) return;
		entry.runtimePhase = action === "start" ? "starting" : "stopping";
		entry.runtimeError = null;
		if (action === "start") entry.pollTicks = 0;
		repaint(host);
		try {
			const base = gatewayBase();
			const res = await fetch(`${base}/api/pack-runtimes/${RUNTIME_API_ID}/${action}`, {
				method: "POST",
				headers: { Authorization: `Bearer ${gatewayToken()}`, "Content-Type": "application/json" },
			});
			const e2 = get(key);
			if (!e2) return;
			if (!res.ok) {
				e2.runtimePhase = "error";
				e2.runtimeError = `HTTP ${res.status}`;
				repaint(host);
				return;
			}
			if (action === "stop") e2.runtimePhase = "idle";
			// Re-read live status; the bounded poll flips the badge once healthy.
			loadStatus(host, key);
			repaint(host);
		} catch (err) {
			const e2 = get(key);
			if (!e2) return;
			e2.runtimePhase = "error";
			e2.runtimeError = msgOf(err);
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

	// ── Guided setup: connection + recall smoke test (NO retain auto-fire). Pure
	//    reads through the Host API; renders a per-step progress list. ──
	async function runSetupTest(host, key) {
		const entry = get(key);
		if (!entry || entry.setupTesting) return;
		entry.setupTesting = true;
		entry.setupProgress = { connection: "running", recall: "pending" };
		repaint(host);
		// Step 1 — connection (health probe via status GET).
		try {
			const st = await host.callRoute("status", { method: "GET" });
			const e2 = get(key);
			if (!e2) return;
			e2.status = st || e2.status;
			e2.statusState = "ready";
			e2.setupProgress = { ...e2.setupProgress, connection: st && st.healthy ? "ok" : "fail" };
			repaint(host);
		} catch {
			const e2 = get(key);
			if (e2) { e2.setupProgress = { ...e2.setupProgress, connection: "fail" }; repaint(host); }
		}
		// Step 2 — recall smoke (probe query; retain is NEVER auto-fired).
		const e3 = get(key);
		if (!e3) return;
		e3.setupProgress = { ...e3.setupProgress, recall: "running" };
		repaint(host);
		try {
			const res = await host.callRoute("recall", { method: "POST", body: { query: "hindsight setup smoke test", scope: "all" } });
			const e4 = get(key);
			if (!e4) return;
			const ok = !!res && res.configured !== false && !res.error;
			e4.setupProgress = { ...e4.setupProgress, recall: ok ? "ok" : "fail" };
			e4.setupTesting = false;
			repaint(host);
		} catch {
			const e4 = get(key);
			if (e4) { e4.setupProgress = { ...e4.setupProgress, recall: "fail" }; e4.setupTesting = false; repaint(host); }
		}
	}

	// ── Field mutators (local draft only; never touches host.store). ──
	const setField = (host, key, field, value) => {
		const entry = get(key);
		if (!entry || !entry.draft) return;
		entry.draft = { ...entry.draft, [field]: value };
		entry.touched = { ...entry.touched, [field]: true };
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

	/** Apply a deployment preset from the setup chooser (local draft only). The
	 *  Hermes-local preset bakes AJ's API URL + bank + UI URL. NEVER starts Docker —
	 *  managed presets only set the mode; Start stays an explicit later gesture. */
	const applyDeploymentPreset = (host, key, preset) => {
		const entry = get(key);
		if (!entry || !entry.draft) return;
		const patch = { ...entry.draft };
		const touched = { ...(entry.touched || {}) };
		if (preset === "external") {
			patch.mode = "external";
			touched.mode = true;
		} else if (preset === "managed" || preset === "managed-external-postgres") {
			patch.mode = preset;
			touched.mode = true;
		} else if (preset === "hermes") {
			patch.mode = "external";
			patch.externalUrl = EX_API_URL;
			patch.bank = "hermes";
			touched.mode = true;
			touched.externalUrl = true;
			touched.bank = true;
			if (!asText(patch.uiUrl, "").trim()) { patch.uiUrl = EX_UI_URL; touched.uiUrl = true; }
		}
		entry.draft = patch;
		entry.touched = touched;
		entry.dirty = true;
		repaint(host);
	};

	/** Which deployment preset the current draft matches — VALUE-based, so the
	 *  External and Hermes-local cards (both `mode: external`) are never both shown
	 *  selected. Hermes wins only when the draft carries its baked API URL + bank;
	 *  generic External is "external mode that is NOT the Hermes preset". */
	const matchesPreset = (d, preset) => {
		const mode = asText(d && d.mode, "external");
		const isHermes = mode === "external" && asText(d && d.externalUrl, "") === EX_API_URL && asText(d && d.bank, "") === "hermes";
		if (preset === "hermes") return isHermes;
		if (preset === "external") return mode === "external" && !isHermes;
		return mode === preset;
	};

	// ── Badge derivation — the 8-state model (UX doc §2), status-driven with a
	//    config-snapshot fallback. Splits managed states using the additive
	//    `status.runtimeStatus` when the host supplies it (legacy hosts collapse
	//    managed-up to Running on `healthy`, managed-down to Stopped). ──
	function deriveBadge(entry) {
		const s = entry.status;
		const configured = s ? !!s.configured : !!entry.configured;
		if (!configured) return { state: "dormant", label: "Not configured", hint: "No memory backend configured yet." };
		const mode = (s && s.mode) || (entry.config && entry.config.mode) || "external";
		if (!isManaged(mode)) {
			if (s && s.healthy) return { state: "connected", label: "Connected", hint: "Connected to your Hindsight." };
			return { state: "unreachable", label: "Unreachable", hint: "Can't reach Hindsight at the configured URL." };
		}
		// Managed modes.
		const rs = s && s.runtimeStatus;
		if (rs === "running" || (s && s.healthy)) return { state: "running", label: "Running", hint: "Managed runtime is running." };
		if (rs === "unhealthy") return { state: "unhealthy", label: "Unhealthy", hint: "Managed runtime is up but not healthy." };
		if (rs === "starting" || entry.runtimePhase === "starting") return { state: "starting", label: "Starting…", hint: "Managed runtime is starting…" };
		return { state: "stopped", label: "Stopped", hint: "Managed runtime is stopped." };
	}

	/** Required-inputs check for the managed Start gate. Reads ONLY the PERSISTED,
	 *  redacted config (`*Set` flags + persisted `mode`) — NEVER the unsaved draft.
	 *  Start launches Docker from the server's STORED config, so a freshly-typed but
	 *  unsaved LLM key / Postgres URL (or an unsaved mode switch) must NOT satisfy the
	 *  gate; the user has to Save first. The dirty-draft guard lives in
	 *  `startDisabled`, which additionally blocks Start whenever there are edits. */
	const requiredInputsPresent = (entry) => {
		const c = entry.config || {};
		const mode = c.mode;
		const has = (field) => !!c[`${field}Set`];
		if (mode === "managed") return has("llmApiKey");
		if (mode === "managed-external-postgres") return has("llmApiKey") && has("externalDatabaseUrl");
		return false;
	};

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
			${opts.validity ? opts.validity : nothing}
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

	const renderApiIdentity = (entry) => {
		const s = entry.status || {};
		const mode = asText(s.mode || (entry.config && entry.config.mode), "external");
		if (isManaged(mode)) return "managed runtime (loopback)";
		const url = asText(s.externalUrl || (entry.config && entry.config.externalUrl), "");
		return url || "—";
	};

	const renderStatusCard = (entry, host, key) => {
		const badge = deriveBadge(entry);
		const s = entry.status || {};
		const mode = asText(s.mode || (entry.config && entry.config.mode), "external");
		const queueDepth = Number(s.queueDepth || 0);
		const uiUrl = asText(s.uiUrl || (entry.config && entry.config.uiUrl), "");
		const timeoutMs = asText(s.timeoutMs != null ? s.timeoutMs : (entry.config && entry.config.timeoutMs), "");
		const recallBudget = asText(s.recallBudget != null ? s.recallBudget : (entry.config && entry.config.recallBudget), "");
		const lastError = s.lastError;
		const lastErrMsg = lastError && typeof lastError === "object" ? asText(lastError.message) : asText(lastError, "");
		return html`
			<section class="hs-card" data-testid="hindsight-status-card">
				<div class="hs-card-head">
					<h2 class="hs-card-title">Runtime status</h2>
					<div class="hs-card-actions">
						<span class="hs-badge" data-testid="hindsight-status-badge" data-state=${badge.state} title=${badge.hint || badge.label}>${badge.label}</span>
						<button class="hs-btn" data-testid="hindsight-refresh" type="button" ?disabled=${entry.statusState === "loading"} @click=${() => refreshAll(host, key)}>Refresh</button>
					</div>
				</div>
				${badge.hint ? html`<p class="hs-muted" data-testid="hindsight-state-hint">${badge.hint}</p>` : nothing}
				${entry.statusState === "error"
					? html`<p class="hs-error" data-testid="hindsight-status-error">${asText(entry.statusError, "Status unavailable")}</p>`
					: html`
						<dl class="hs-rows">
							<div class="hs-row"><dt>Mode</dt><dd data-testid="hindsight-status-mode">${mode}</dd></div>
							<div class="hs-row"><dt>API URL</dt><dd class="hs-mono" data-testid="hindsight-api-url">${renderApiIdentity(entry)}</dd></div>
							${uiUrl
								? html`<div class="hs-row"><dt>UI URL</dt><dd><a class="hs-open-ui" data-testid="hindsight-open-ui" href=${uiUrl} target="_blank" rel="noopener noreferrer">Open Hindsight UI ↗</a></dd></div>`
								: nothing}
							<div class="hs-row"><dt>Bank</dt><dd>${asText(s.bank || (entry.config && entry.config.bank), "bobbit")}</dd></div>
							<div class="hs-row"><dt>Namespace</dt><dd>${asText(s.namespace || (entry.config && entry.config.namespace), "default")}</dd></div>
							<div class="hs-row"><dt>Recall scope</dt><dd>${asText(s.recallScope || (entry.config && entry.config.recallScope), "all")}</dd></div>
							<div class="hs-row"><dt>Auto recall / retain</dt><dd>${s.autoRecall === false ? "off" : "on"} / ${s.autoRetain === false ? "off" : "on"}</dd></div>
							${timeoutMs ? html`<div class="hs-row"><dt>Timeout</dt><dd data-testid="hindsight-status-timeout">${timeoutMs} ms</dd></div>` : nothing}
							${recallBudget ? html`<div class="hs-row"><dt>Recall budget</dt><dd>${recallBudget} tokens</dd></div>` : nothing}
						</dl>
						<div class="hs-chips">
							<span class="hs-chip" data-testid="hindsight-queue-depth" data-queue-depth=${String(queueDepth)}>${queueDepth} queued ${queueDepth === 1 ? "retain" : "retains"}</span>
							${isManaged(mode)
								? html`<button class="hs-chip hs-chip-muted hs-chip-btn" data-testid="hindsight-logs-button" type="button" aria-expanded=${entry.logsOpen ? "true" : "false"} @click=${() => toggleLogs(host, key)}>${entry.logsOpen ? "Hide logs" : "View runtime logs"}</button>`
								: nothing}
						</div>
						${isManaged(mode) && entry.logsOpen ? renderLogsView(entry, host, key) : nothing}
						${lastErrMsg ? html`<p class="hs-last-error" data-testid="hindsight-last-error">Last error: ${lastErrMsg}</p>` : nothing}
					`}
			</section>`;
	};

	const renderLogsView = (entry, host, key) => html`
		<div class="hs-logs" data-testid="hindsight-logs-view" data-logs-state=${entry.logsState}>
			<div class="hs-logs-head">
				<span class="hs-label">Runtime logs (tail ${LOGS_TAIL})</span>
				<button class="hs-btn" data-testid="hindsight-logs-refresh" type="button" ?disabled=${entry.logsState === "loading"} @click=${() => loadLogs(host, key)}>${entry.logsState === "loading" ? "Loading…" : "Refresh"}</button>
			</div>
			${entry.logsState === "error"
				? html`<p class="hs-error" data-testid="hindsight-logs-error">${asText(entry.logsError, "Logs unavailable")}</p>`
				: entry.logsState === "loading" && !entry.logs
					? html`<p class="hs-muted">Loading logs…</p>`
					: html`
						${entry.logsError ? html`<p class="hs-muted" data-testid="hindsight-logs-note">${asText(entry.logsError)}</p>` : nothing}
						<pre class="hs-logs-pre" data-testid="hindsight-logs-pre">${entry.logs && entry.logs.length ? entry.logs : "No logs yet."}</pre>`}
		</div>`;

	// ── Guided setup walkthrough (UX doc §6, impl §4.4): deployment chooser +
	//    ownership matrix + recommended-defaults explainer + connection smoke test. ──
	const DEPLOY_CARDS = [
		{ preset: "hermes", title: "Hermes-local / embedded", mode: "external", bobbit: "Nothing — client only", you: "Hermes runs Hindsight for you", note: `Preset: API ${EX_API_URL}, bank hermes. No Docker.` },
		{ preset: "external", title: "Connect existing Hindsight", mode: "external", bobbit: "Nothing — client only", you: "The whole Hindsight deployment", note: "No Docker — Bobbit only talks to a URL you provide." },
		{ preset: "managed", title: "Bobbit-managed (recommended)", mode: "managed", bobbit: "Docker: Hindsight API + Postgres", you: "An LLM API key; a data dir", note: "Starts local Docker containers when you press Start." },
		{ preset: "managed-external-postgres", title: "Bobbit-managed + your Postgres", mode: "managed-external-postgres", bobbit: "Docker: Hindsight API", you: "Postgres URL; LLM key", note: "Starts local Docker containers when you press Start." },
	];

	const renderOwnership = () => html`
		<div class="hs-subcard" data-testid="hindsight-ownership">
			<span class="hs-label">Who manages what</span>
			<dl class="hs-rows">
				<div class="hs-row"><dt>Bobbit-managed Docker runtime</dt><dd>Bobbit runs the Hindsight API + Postgres in Docker; you supply an LLM key + data dir.</dd></div>
				<div class="hs-row"><dt>Bobbit-managed + external Postgres</dt><dd>Bobbit runs the Hindsight API; you supply a Postgres URL + LLM key.</dd></div>
				<div class="hs-row"><dt>Existing external Hindsight</dt><dd>You run the whole deployment; Bobbit is a client of your API URL.</dd></div>
				<div class="hs-row"><dt>Hermes-local / embedded</dt><dd>Hermes runs Hindsight for you (e.g. ${EX_API_URL}); Bobbit just connects.</dd></div>
			</dl>
		</div>`;

	const renderDefaultsExplainer = () => html`
		<div class="hs-subcard" data-testid="hindsight-defaults-explainer">
			<span class="hs-label">Recommended defaults</span>
			<dl class="hs-rows">
				<div class="hs-row"><dt>Data locality</dt><dd>Local / private — your memory stays on your machine unless you point at a shared deployment.</dd></div>
				<div class="hs-row"><dt>Bank</dt><dd><code>bobbit</code> (shared, tag-scoped). Use an existing bank like <code>hermes</code> only when connecting to one.</dd></div>
				<div class="hs-row"><dt>Namespace</dt><dd><code>default</code> unless your Hindsight uses namespaces.</dd></div>
				<div class="hs-row"><dt>Auto-retain</dt><dd>On (async) — memories are saved in the background after each turn; no latency cost.</dd></div>
				<div class="hs-row"><dt>Auto-recall</dt><dd>On — relevant memories are pulled in automatically.</dd></div>
				<div class="hs-row"><dt>Recall scope</dt><dd><code>all</code> — search across everything you've done.</dd></div>
				<div class="hs-row"><dt>Timeout</dt><dd><code>1500 ms</code> — conservative; Hindsight calls never stall a turn.</dd></div>
				<div class="hs-row"><dt>LLM key (managed)</dt><dd>You supply it — Bobbit forwards it to the local runtime only; never hardcodes a provider secret.</dd></div>
			</dl>
		</div>`;

	const renderSetupProgress = (entry) => {
		const p = entry.setupProgress;
		if (!p) return nothing;
		const row = (label, state) => html`
			<li class="hs-progress-row" data-state=${state}>
				<span class="hs-progress-icon" aria-hidden="true">${state === "ok" ? "✓" : state === "fail" ? "✗" : state === "running" ? "…" : "•"}</span>
				<span>${label}</span>
				<span class="hs-progress-state">${state}</span>
			</li>`;
		return html`
			<ul class="hs-progress" data-testid="hindsight-setup-progress">
				${row("Connection (health probe)", p.connection)}
				${row("Recall smoke test", p.recall)}
			</ul>
			<p class="hs-hint">Auto-retain happens on your next turn — Bobbit never writes a memory unsolicited.</p>`;
	};

	const renderSetupCard = (entry, host, key) => {
		const d = entry.draft || draftFromConfig(null);
		return html`
			<section class="hs-card" data-testid="hindsight-setup">
				<div class="hs-card-head">
					<h2 class="hs-card-title">Set up Hindsight</h2>
					${entry.configured
						? html`<button class="hs-btn" data-testid="hindsight-setup-close" type="button" @click=${() => { const e = get(key); if (e) { e.setupOpen = false; repaint(host); } }}>Hide guide</button>`
						: nothing}
				</div>
				<p class="hs-muted">Pick how Hindsight runs. Selecting a managed option only sets the mode — nothing starts until you press <strong>Start runtime</strong>.</p>
				<div class="hs-deploy-grid">
					${DEPLOY_CARDS.map((c) => {
						const selected = matchesPreset(d, c.preset);
						return html`
						<button
							class="hs-deploy-card"
							data-testid=${`hindsight-deploy-${c.preset}`}
							type="button"
							aria-pressed=${selected ? "true" : "false"}
							data-selected=${selected ? "true" : "false"}
							@click=${() => applyDeploymentPreset(host, key, c.preset)}
						>
							<span class="hs-deploy-title">${c.title}</span>
							<span class="hs-deploy-meta"><strong>Bobbit:</strong> ${c.bobbit}</span>
							<span class="hs-deploy-meta"><strong>You:</strong> ${c.you}</span>
							<span class="hs-deploy-note">${c.note}</span>
						</button>`;
					})}
				</div>
				${renderOwnership()}
				${renderDefaultsExplainer()}
				<div class="hs-card-actions">
					<button class="hs-btn" data-testid="hindsight-setup-test" type="button" ?disabled=${entry.setupTesting} @click=${() => runSetupTest(host, key)}>${entry.setupTesting ? "Testing…" : "Test connection"}</button>
				</div>
				${renderSetupProgress(entry)}
			</section>`;
	};

	// ── Managed-runtime control card (UX doc §10, impl §4.5): consent disclosure +
	//    explicit Start/Stop + progress. NO auto-start: the ONLY start call lives in
	//    the Start button handler below. ──
	const renderRuntimeProgress = (entry) => {
		const s = entry.status || {};
		const rs = s.runtimeStatus;
		const phase = entry.runtimePhase;
		const healthy = !!s.healthy;
		const stateFor = (done, active) => (done ? "ok" : active ? "running" : "pending");
		const started = phase === "starting" || rs === "starting" || rs === "running" || healthy;
		const running = rs === "running" || (rs === undefined && healthy);
		const errored = phase === "error";
		const row = (label, state) => html`
			<li class="hs-progress-row" data-state=${state}>
				<span class="hs-progress-icon" aria-hidden="true">${state === "ok" ? "✓" : state === "fail" ? "✗" : state === "running" ? "…" : "•"}</span>
				<span>${label}</span>
				<span class="hs-progress-state">${state}</span>
			</li>`;
		if (phase === "idle" && !started && !errored) return nothing;
		return html`
			<ul class="hs-progress" data-testid="hindsight-runtime-progress">
				${row("Start runtime", errored ? "fail" : stateFor(started && (running || rs === "starting"), phase === "starting"))}
				${row("Health check", errored ? "fail" : stateFor(running, started && !running))}
				${row("Running", running ? "ok" : "pending")}
			</ul>
			${entry.runtimeError ? html`<p class="hs-error" data-testid="hindsight-runtime-error">${asText(entry.runtimeError)}</p>` : nothing}`;
	};

	const renderManagedCard = (entry, host, key) => {
		const d = entry.draft || draftFromConfig(null);
		const s = entry.status || {};
		const rs = s.runtimeStatus;
		const running = rs === "running" || rs === "unhealthy" || rs === "starting" || s.healthy || entry.runtimePhase === "starting";
		const reqOk = requiredInputsPresent(entry);
		// Start launches Docker from the PERSISTED config, so it must be blocked while
		// the form has unsaved edits (e.g. an external→managed switch + an unsaved LLM
		// key): an enabled Start there would dial stale persisted server config.
		const startDisabled = !entry.configured || entry.dirty || !reqOk || !entry.managedConsentAck || entry.runtimePhase === "starting";
		const pgRow = d.mode === "managed-external-postgres";
		return html`
			<section class="hs-card" data-testid="hindsight-managed-card">
				<div class="hs-card-head"><h2 class="hs-card-title">Managed runtime</h2></div>
				<div class="hs-consent" data-testid="hindsight-managed-consent">
					<span class="hs-label">Before you start</span>
					<p class="hs-muted">Pressing <strong>Start runtime</strong> launches local <strong>Docker</strong> containers — the Hindsight API${pgRow ? "" : " + a Postgres database"} on loopback ports. The first start may pull an image and take ~1–2 min. Nothing runs until you press Start; Stop keeps your data.</p>
					<ul class="hs-checklist">
						<li data-ok=${reqOk ? "true" : "false"}>${reqOk ? "✓" : "•"} Required inputs: LLM API key${pgRow ? " + external Postgres URL" : ""} ${reqOk ? "present (saved)" : "missing — set them in Configuration and Save"}</li>
						<li data-ok=${entry.configured && !entry.dirty ? "true" : "false"}>${entry.configured && !entry.dirty ? "✓" : "•"} Configuration saved ${!entry.configured ? "— Save first" : entry.dirty ? "— unsaved changes; Save before starting" : ""}</li>
					</ul>
					${entry.dirty ? html`<p class="hs-hint" data-testid="hindsight-managed-save-first">Save your changes before starting — Start uses the saved configuration, not your unsaved edits.</p>` : nothing}
					<label class="hs-toggle">
						<input type="checkbox" data-testid="hindsight-managed-consent-ack" .checked=${!!entry.managedConsentAck} @change=${(e) => { const en = get(key); if (en) { en.managedConsentAck = e.currentTarget.checked; repaint(host); } }} />
						<span>I understand this starts local Docker containers.</span>
					</label>
				</div>
				<div class="hs-card-actions">
					<button class="hs-btn hs-btn-primary" data-testid="hindsight-start-runtime" type="button" ?disabled=${startDisabled} @click=${() => runtimeAction(host, key, "start")}>${entry.runtimePhase === "starting" ? "Starting…" : "Start runtime (starts Docker)"}</button>
					<button class="hs-btn" data-testid="hindsight-stop-runtime" type="button" ?disabled=${!running || entry.runtimePhase === "stopping"} @click=${() => runtimeAction(host, key, "stop")}>${entry.runtimePhase === "stopping" ? "Stopping…" : "Stop runtime"}</button>
				</div>
				${renderRuntimeProgress(entry)}
			</section>`;
	};

	const renderConfigCard = (entry, host, key) => {
		const d = entry.draft || draftFromConfig(null);
		const mode = d.mode;
		const onMode = (e) => setField(host, key, "mode", e.currentTarget.value);
		const urlVal = asText(d.externalUrl, "").trim();
		const urlValidity = mode === "external" && urlVal
			? html`<span class="hs-hint" data-testid="hindsight-url-validity" data-valid=${isHttpUrl(urlVal) ? "true" : "false"}>${isHttpUrl(urlVal) ? "✓ Looks like a valid URL" : "✗ Must be an http(s) URL"}</span>`
			: nothing;
		const uiVal = asText(d.uiUrl, "").trim();
		const uiValidity = uiVal
			? html`<span class="hs-hint" data-testid="hindsight-ui-url-validity" data-valid=${isHttpUrl(uiVal) ? "true" : "false"}>${isHttpUrl(uiVal) ? "✓ Looks like a valid URL" : "✗ Must be an http(s) URL"}</span>`
			: nothing;
		return html`
			<section class="hs-card" data-testid="hindsight-config-card">
				<div class="hs-card-head">
					<h2 class="hs-card-title">Configuration</h2>
					<button class="hs-btn hs-btn-primary" data-testid="hindsight-save" type="button" ?disabled=${entry.saving} @click=${() => save(host, key)}>${entry.saving ? "Saving…" : "Save"}</button>
				</div>

				${entry.dirty
					? html`<div class="hs-banner" data-testid="hindsight-unsaved">
							<span>You have unsaved changes. Save persists them; Discard reverts to the stored config.</span>
							<button class="hs-btn" data-testid="hindsight-discard" type="button" @click=${() => discardEdits(host, key)}>Discard</button>
						</div>`
					: nothing}

				<label class="hs-field">
					<span class="hs-label">Deployment mode</span>
					<select class="hs-input" data-testid="hindsight-mode" .value=${mode} @change=${onMode}>
						<option value="external" ?selected=${mode === "external"}>External (operator-supplied URL)</option>
						<option value="managed" ?selected=${mode === "managed"}>Managed (Bobbit-run, managed Postgres)</option>
						<option value="managed-external-postgres" ?selected=${mode === "managed-external-postgres"}>Managed + external Postgres</option>
					</select>
				</label>

				${mode === "external"
					? renderField("API / data-plane URL", "hindsight-external-url", d.externalUrl, (e) => setField(host, key, "externalUrl", e.currentTarget.value), { placeholder: EX_API_URL, hint: `API / data-plane URL Bobbit calls to recall & retain (e.g. ${EX_API_URL}). Activates external mode; empty keeps it dormant.`, validity: urlValidity })
					: nothing}

				${renderField("Dashboard UI URL", "hindsight-ui-url", d.uiUrl, (e) => setField(host, key, "uiUrl", e.currentTarget.value), { placeholder: EX_UI_URL, hint: `Optional human dashboard opened by "Open Hindsight UI" — never called by Bobbit (e.g. ${EX_UI_URL}).`, validity: uiValidity })}

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
		void index;
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
		.hs-root code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: color-mix(in oklch, var(--muted-foreground) 12%, transparent); padding: 0 4px; border-radius: 4px; }
		.hs-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
		.hs-card { border: 1px solid var(--border); border-radius: 10px; background: var(--card); padding: 14px; display: flex; flex-direction: column; gap: 12px; }
		.hs-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
		.hs-card-title { color: var(--foreground); }
		.hs-card-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
		.hs-rows { display: grid; grid-template-columns: 1fr; gap: 6px; margin: 0; }
		.hs-row { display: flex; justify-content: space-between; gap: 12px; }
		.hs-row dt { color: var(--muted-foreground); flex: 0 0 auto; }
		.hs-row dd { margin: 0; color: var(--foreground); text-align: right; }
		.hs-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
		.hs-field { display: flex; flex-direction: column; gap: 4px; }
		.hs-label { color: var(--muted-foreground); font-size: 12px; }
		.hs-hint { color: var(--muted-foreground); font-size: 11px; }
		.hs-hint[data-valid="true"] { color: var(--positive); }
		.hs-hint[data-valid="false"] { color: var(--negative); }
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
		.hs-badge[data-state="connected"], .hs-badge[data-state="running"] { color: var(--positive); border-color: color-mix(in oklch, var(--positive) 45%, transparent); background: color-mix(in oklch, var(--positive) 14%, transparent); }
		.hs-badge[data-state="unreachable"], .hs-badge[data-state="unhealthy"] { color: var(--negative); border-color: color-mix(in oklch, var(--negative) 45%, transparent); background: color-mix(in oklch, var(--negative) 14%, transparent); }
		.hs-badge[data-state="starting"] { color: var(--warning); border-color: color-mix(in oklch, var(--warning) 45%, transparent); background: color-mix(in oklch, var(--warning) 14%, transparent); }
		.hs-chips { display: flex; gap: 8px; flex-wrap: wrap; }
		.hs-chip { display: inline-flex; align-items: center; padding: 2px 9px; border-radius: 999px; font-size: 12px; border: 1px solid var(--border); background: color-mix(in oklch, var(--chart-1) 10%, transparent); color: var(--foreground); }
		.hs-chip-muted { background: color-mix(in oklch, var(--muted-foreground) 10%, transparent); color: var(--muted-foreground); }
		.hs-chip-btn { cursor: pointer; font: inherit; }
		.hs-chip-btn:hover:not(:disabled) { border-color: var(--primary); color: var(--foreground); }
		.hs-open-ui { color: var(--primary); text-decoration: none; }
		.hs-open-ui:hover { text-decoration: underline; }
		.hs-banner { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; border-radius: 8px; border: 1px solid color-mix(in oklch, var(--warning) 45%, transparent); background: color-mix(in oklch, var(--warning) 12%, transparent); color: var(--foreground); font-size: 12px; }
		.hs-subcard { border: 1px solid var(--border); border-radius: 8px; background: var(--background); padding: 10px; display: flex; flex-direction: column; gap: 8px; }
		.hs-deploy-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
		.hs-deploy-card { text-align: left; display: flex; flex-direction: column; gap: 4px; border: 1px solid var(--border); border-radius: 8px; background: var(--background); color: var(--foreground); padding: 10px; cursor: pointer; font: inherit; }
		.hs-deploy-card:hover { border-color: var(--primary); }
		.hs-deploy-card[data-selected="true"] { border-color: var(--primary); background: color-mix(in oklch, var(--primary) 10%, transparent); }
		.hs-deploy-title { font-weight: 600; }
		.hs-deploy-meta { color: var(--muted-foreground); font-size: 11px; }
		.hs-deploy-note { color: var(--muted-foreground); font-size: 11px; font-style: italic; }
		.hs-consent { border: 1px solid color-mix(in oklch, var(--warning) 40%, transparent); border-radius: 8px; background: color-mix(in oklch, var(--warning) 8%, transparent); padding: 10px; display: flex; flex-direction: column; gap: 8px; }
		.hs-checklist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
		.hs-checklist li[data-ok="true"] { color: var(--positive); }
		.hs-checklist li[data-ok="false"] { color: var(--muted-foreground); }
		.hs-progress { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
		.hs-progress-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted-foreground); }
		.hs-progress-row[data-state="ok"] { color: var(--positive); }
		.hs-progress-row[data-state="fail"] { color: var(--negative); }
		.hs-progress-row[data-state="running"] { color: var(--warning); }
		.hs-progress-icon { width: 14px; display: inline-flex; justify-content: center; }
		.hs-progress-state { margin-left: auto; font-variant-numeric: tabular-nums; opacity: 0.8; }
		.hs-logs { border: 1px solid var(--border); border-radius: 8px; background: var(--background); padding: 10px; display: flex; flex-direction: column; gap: 8px; }
		.hs-logs-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
		.hs-logs-pre { margin: 0; max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--foreground); }
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
		@media (max-width: 520px) { .hs-deploy-grid { grid-template-columns: 1fr; } }
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
			// never a write, never a runtime start). Pure projection thereafter.
			if (!entry.mountKicked) {
				entry.mountKicked = true;
				loadConfig(host, key);
				loadStatus(host, key);
			}

			const loadingConfig = entry.configState === "loading" && !entry.draft;
			const draftMode = (entry.draft && entry.draft.mode) || "external";
			// Setup guide auto-opens when dormant (first-run); otherwise via the toggle.
			const setupVisible = !entry.configured || entry.setupOpen;
			return html`
				${STYLE}
				<div class="hs-root" data-testid="hindsight-panel" data-config-state=${entry.configState} data-status-state=${entry.statusState}>
					<div class="hs-head">
						<h1>Hindsight Memory</h1>
						${entry.configured && !entry.setupOpen
							? html`<button class="hs-btn" data-testid="hindsight-setup-toggle" type="button" @click=${() => { const e = get(key); if (e) { e.setupOpen = true; repaint(host); } }}>Setup guide</button>`
							: nothing}
					</div>
					${renderStatusCard(entry, host, key)}
					${entry.configState === "error"
						? html`<section class="hs-card"><p class="hs-error" data-testid="hindsight-config-load-error">${asText(entry.configError, "Config unavailable")}</p></section>`
						: loadingConfig
							? html`<section class="hs-card"><p class="hs-muted" data-testid="hindsight-config-loading">Loading configuration…</p></section>`
							: html`
								${setupVisible ? renderSetupCard(entry, host, key) : nothing}
								${renderConfigCard(entry, host, key)}
								${isManaged(draftMode) ? renderManagedCard(entry, host, key) : nothing}`}
					${renderSearchCard(entry, host, key)}
				</div>`;
		},
	};
}
