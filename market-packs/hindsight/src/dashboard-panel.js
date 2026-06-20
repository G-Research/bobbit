// Hindsight pack CLIENT panel — the EMBEDDED DASHBOARD surface (Hindsight
// surfaces & UI goal; design "Hindsight surfaces & embedded dashboard"). This is
// the USE/VIEW/QUERY surface opened by the session-menu entry + the
// `#/ext/hindsight` deep link. It is NOT a configuration surface — configuration
// lives in the Marketplace inline form + guided wizard.
//
// It renders the human Hindsight dashboard (`uiUrl`) inside a SANDBOXED iframe so
// the user can browse/query memory without leaving Bobbit. The dashboard locally
// sends no X-Frame-Options/CSP frame headers, so a direct iframe works; a
// pragmatic load-timeout surfaces a fallback warning when a secured/unreachable
// deployment refuses to embed.
//
// SECURITY + HOST-API INVARIANTS (mirrors panel.js / pr-walkthrough / artifacts):
//   - `uiUrl` is the HUMAN dashboard URL — display/open-ONLY. Bobbit JS NEVER
//     fetches/probes it; the browser only loads it as the iframe `src`. It is
//     resolved ONLY from the redacted status/config routes and is NEVER
//     synthesized from `externalUrl` (the data-plane API URL Bobbit dials).
//   - NO raw fetch for config/status. Both flow through the versioned Host API
//     (`host.callRoute("config"|"status")`). The panel never builds a gateway URL.
//   - NO config form fields here — the entry no longer configures anything. The
//     empty state points the user at the Marketplace (`#/market`).
//   - NO auto-mutation on mount. `render` is a PURE projection; mount kicks only
//     READ calls (`config` GET, `status` GET) once per session.
//   - `lit` is HOST-INJECTED (`{ html, nothing }`) — never imported.
//   - Theme tokens ONLY — no hardcoded palette, no `prefers-color-scheme`.

const asText = (v, d = "") => (v == null ? d : String(v));
const msgOf = (e) => (e && e.message ? String(e.message) : String(e));

// Production iframe load-timeout. A cross-origin XFO/CSP refusal is not reliably
// detectable from the parent, so we use a pragmatic timeout after assigning the
// `src`: no `load` within this window ⇒ surface the embed warning + fallback link.
const DEFAULT_IFRAME_TIMEOUT_MS = 7000;

// Sandbox flags: scripts + same-origin (the dashboard is a real app), forms,
// popups (so in-dashboard links can open). Mandatory — never drop the attribute.
const IFRAME_SANDBOX = "allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox";

// Per-session panel state survives repaints + panel-instance re-creation within a
// page session (module-closure cache keyed by the bound `__sessionId`).
const STATE = globalThis.__bobbitHindsightDashboardState || (globalThis.__bobbitHindsightDashboardState = new Map());

function freshEntry() {
	return {
		mountKicked: false,
		loadState: "loading", // loading | ready | error
		loadError: null,
		uiUrl: "",
		externalUrl: "",
		host: "",
		// iframe load tracking (deterministic timeout hook for E2E).
		frameArmedFor: null, // the uiUrl we armed a load-timeout for
		frameLoaded: false,
		frameTimedOut: false,
		frameTimer: null,
	};
}

/** Pretty host for the "Embedded dashboard from <host>" copy. Falls back to the
 *  raw URL when it is not a parseable absolute URL. */
function hostOf(url) {
	const v = asText(url, "").trim();
	if (!v) return "";
	try {
		return new URL(v).host || v;
	} catch {
		return v;
	}
}

/** Read the deterministic test timeout hook (tests set a tiny value); production
 *  has no hook and uses {@link DEFAULT_IFRAME_TIMEOUT_MS}. */
function iframeTimeoutMs() {
	const v = globalThis.__bobbitHindsightIframeTimeoutMs;
	return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_IFRAME_TIMEOUT_MS;
}

export default function createDashboardPanel({ html, nothing }) {
	const repaint = (host) => {
		try { host && host.requestRender && host.requestRender(); } catch { /* non-DOM */ }
	};
	const get = (key) => STATE.get(key);

	const clearTimer = (entry) => {
		if (entry && entry.frameTimer) {
			try { clearTimeout(entry.frameTimer); } catch { /* noop */ }
			entry.frameTimer = null;
		}
	};

	// ── One-shot load: read redacted config + status and resolve the dashboard
	//    URL. NEVER synthesizes uiUrl from externalUrl; NEVER probes uiUrl. ──
	async function load(host, key) {
		let config = null;
		let status = null;
		let err = null;
		try {
			config = await host.callRoute("config", { method: "GET" });
		} catch (e) {
			err = msgOf(e);
		}
		try {
			status = await host.callRoute("status", { method: "GET" });
		} catch (e) {
			if (!err) err = msgOf(e);
		}
		const entry = get(key);
		if (!entry) return;
		const cfg = (config && config.config) || {};
		const uiUrl = asText((status && status.uiUrl) || cfg.uiUrl || (config && config.uiUrl), "").trim();
		const externalUrl = asText((status && status.externalUrl) || cfg.externalUrl || (config && config.externalUrl), "").trim();
		entry.uiUrl = uiUrl;
		entry.externalUrl = externalUrl;
		entry.host = hostOf(uiUrl);
		// A read failure only matters when we have nothing to show.
		if (!uiUrl && err && !config && !status) {
			entry.loadState = "error";
			entry.loadError = err;
		} else {
			entry.loadState = "ready";
			entry.loadError = null;
		}
		repaint(host);
	}

	// Arm the deterministic load-timeout for a freshly-resolved uiUrl (once per
	// distinct url). Side-effect kept out of the iframe template; mirrors panel.js's
	// mount-kick pattern (guarded so it fires at most once per url).
	const armFrameTimeout = (host, key, uiUrl) => {
		const entry = get(key);
		if (!entry || entry.frameArmedFor === uiUrl) return;
		clearTimer(entry);
		entry.frameArmedFor = uiUrl;
		entry.frameLoaded = false;
		entry.frameTimedOut = false;
		const ms = iframeTimeoutMs();
		entry.frameTimer = setTimeout(() => {
			const e = get(key);
			if (!e) return;
			e.frameTimer = null;
			if (!e.frameLoaded) { e.frameTimedOut = true; repaint(host); }
		}, ms);
	};

	const onFrameLoad = (host, key) => {
		const entry = get(key);
		if (!entry) return;
		clearTimer(entry);
		entry.frameLoaded = true;
		entry.frameTimedOut = false;
		repaint(host);
	};

	const STYLE = html`<style>
		.hd-root { color: var(--foreground); background: var(--background); min-height: 100%; box-sizing: border-box; display: flex; flex-direction: column; font-size: 13px; }
		.hd-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border); flex: 0 0 auto; }
		.hd-head h1 { font-size: 15px; margin: 0; color: var(--foreground); }
		.hd-sub { color: var(--muted-foreground); font-size: 11px; margin: 2px 0 0; }
		.hd-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
		.hd-link { color: var(--primary); text-decoration: none; border: 1px solid var(--border); border-radius: 7px; padding: 6px 12px; font: inherit; }
		.hd-link:hover { border-color: var(--primary); text-decoration: underline; }
		.hd-frame-wrap { position: relative; flex: 1 1 auto; min-height: 320px; display: flex; }
		.hd-frame { border: 0; width: 100%; height: 100%; flex: 1 1 auto; background: var(--background); }
		.hd-warning { padding: 10px 16px; border-bottom: 1px solid color-mix(in oklch, var(--warning) 45%, transparent); background: color-mix(in oklch, var(--warning) 12%, transparent); color: var(--foreground); font-size: 12px; flex: 0 0 auto; }
		.hd-hint { padding: 6px 16px; color: var(--muted-foreground); font-size: 11px; flex: 0 0 auto; }
		.hd-empty { display: flex; flex-direction: column; gap: 12px; padding: 24px 16px; }
		.hd-card { border: 1px solid var(--border); border-radius: 10px; background: var(--card); padding: 16px; display: flex; flex-direction: column; gap: 10px; }
		.hd-card h2 { font-size: 14px; margin: 0; color: var(--foreground); }
		.hd-muted { color: var(--muted-foreground); margin: 0; }
		.hd-error { color: var(--negative); margin: 0; }
		.hd-cta { align-self: flex-start; background: var(--primary); color: var(--background); border: 1px solid var(--primary); border-radius: 7px; padding: 7px 14px; font: inherit; text-decoration: none; }
		.hd-cta:hover { text-decoration: underline; }
		.hd-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
	</style>`;

	const renderEmpty = (entry) => html`
		${STYLE}
		<div class="hd-root" data-testid="hindsight-dashboard" data-state="empty">
			<div class="hd-empty">
				<section class="hd-card" data-testid="hindsight-dashboard-empty">
					<h2>Hindsight dashboard URL is not configured.</h2>
					<p class="hd-muted">
						The embedded Hindsight dashboard opens the human UI at your configured
						dashboard URL. Configure it in the Marketplace to view and query memory
						without leaving Bobbit.
					</p>
					${entry.externalUrl
						? html`<p class="hd-muted">The data-plane API URL (<span class="hd-mono">${entry.externalUrl}</span>) is configured, but the dashboard UI URL is missing.</p>`
						: nothing}
					<a class="hd-cta" data-testid="hindsight-dashboard-configure" href="#/market">Configure in Marketplace</a>
				</section>
			</div>
		</div>`;

	const renderDashboard = (entry, host, key) => {
		const uiUrl = entry.uiUrl;
		const showWarning = entry.frameTimedOut && !entry.frameLoaded;
		return html`
			${STYLE}
			<div class="hd-root" data-testid="hindsight-dashboard" data-state="embedded">
				<div class="hd-head">
					<div>
						<h1>Hindsight Memory</h1>
						<p class="hd-sub" data-testid="hindsight-dashboard-source">Embedded dashboard from ${entry.host || uiUrl}</p>
					</div>
					<div class="hd-actions">
						<a class="hd-link" data-testid="hindsight-dashboard-open-external" href=${uiUrl} target="_blank" rel="noopener noreferrer">Open in browser ↗</a>
					</div>
				</div>
				${showWarning
					? html`<div class="hd-warning" data-testid="hindsight-dashboard-embed-warning">The Hindsight dashboard did not load in-app. It may block embedding or be unreachable — open it in your browser instead.</div>`
					: nothing}
				${entry.frameLoaded
					? html`<div class="hd-hint" data-testid="hindsight-dashboard-loaded-hint">If the frame is blank, open externally.</div>`
					: nothing}
				<div class="hd-frame-wrap">
					<iframe
						class="hd-frame"
						data-testid="hindsight-dashboard-frame"
						src=${uiUrl}
						sandbox=${IFRAME_SANDBOX}
						referrerpolicy="no-referrer"
						title="Hindsight dashboard"
						@load=${() => onFrameLoad(host, key)}
					></iframe>
				</div>
			</div>`;
	};

	return {
		render(params, host) {
			const key = (params && params.__sessionId) || "hindsight-dashboard-default";

			// Feature-detect Phase-2 callRoute; degrade gracefully on a Phase-1 host.
			const canRoute = !!(host && host.capabilities && host.capabilities.callRoute && typeof host.callRoute === "function");
			if (!canRoute) {
				return html`${STYLE}<div class="hd-root" data-testid="hindsight-dashboard" data-state="unavailable"><div class="hd-empty"><p class="hd-muted">Hindsight memory is unavailable on this host.</p></div></div>`;
			}

			let entry = get(key);
			if (!entry) { entry = freshEntry(); STATE.set(key, entry); }

			// Mount: kick READ-only loads ONCE per session (never on repaint, never a
			// write). Pure projection thereafter.
			if (!entry.mountKicked) {
				entry.mountKicked = true;
				load(host, key);
			}

			if (entry.loadState === "loading") {
				return html`${STYLE}<div class="hd-root" data-testid="hindsight-dashboard" data-state="loading"><div class="hd-empty"><p class="hd-muted" data-testid="hindsight-dashboard-loading">Loading Hindsight dashboard…</p></div></div>`;
			}

			if (!entry.uiUrl) return renderEmpty(entry);

			// uiUrl present — arm the deterministic load-timeout for it (once per url).
			armFrameTimeout(host, key, entry.uiUrl);
			return renderDashboard(entry, host, key);
		},
	};
}
