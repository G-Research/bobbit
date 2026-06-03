/**
 * iOS PWA grey-screen recovery.
 *
 * On iOS, relaunching the installed standalone PWA frequently shows a blank
 * dark-grey screen (the manifest `background_color`) with no UI. When the app
 * is backgrounded, iOS may FREEZE the WebKit process (Page Lifecycle "frozen")
 * or outright KILL it. On relaunch iOS brings forward a dead/frozen page
 * snapshot: the JS event loop was suspended mid-flight, the render loop and
 * WebSocket are dead, and the page is stuck painting only the background color
 * because the app never (re-)mounted — or mounted previously but its reactive
 * machinery never resumed.
 *
 * This module implements three independent, mutually-reinforcing recovery
 * mechanisms, ALL gated to standalone display mode only so normal browser tabs
 * and the dev server are unaffected:
 *
 *   1. bfcache / frozen-restore detection (`pageshow` with persisted === true)
 *      → force a clean reload so the app re-bootstraps from scratch.
 *   2. Resume-staleness watchdog (liveness heartbeat + freeze/resume/
 *      visibilitychange) → on a LONG suspend, if the heartbeat fails to advance
 *      after resume, the page is a frozen mounted snapshot → reload.
 *   3. Boot watchdog (scheduled inline in index.html, reconciled here) →
 *      backstop for a resume that lands mid-bootstrap with nothing painted.
 *
 * DIVISION OF LABOR — do NOT confuse with the existing reconnect/resync:
 *   - This module recovers a DEAD/FROZEN page (the page itself never came back
 *     to life, so there is no live JS to reconnect a socket).
 *   - The existing visibility-driven reconnect/resync in
 *     `src/app/remote-agent.ts` (`_onVisibilityChange`) and the
 *     `visibilitychange` handler in `src/app/main.ts` recover a dead WebSocket
 *     on a LIVE page. A live page whose heartbeat advances after resume is
 *     treated as alive here and is NEVER reloaded — that case is owned by those
 *     handlers and must not be regressed.
 *
 * The "should I reload?" decision (§3.2) is factored out as the PURE,
 * unit-testable `shouldReloadOnResume()` — no DOM, no globals.
 */

declare global {
	interface Window {
		__bobbitBootStart?: number;
		__bobbitBootWatchdog?: ReturnType<typeof setTimeout> | number;
		/** Test seam: number of forced reloads requested via hardReload(). */
		__bobbitHardReloads?: number;
		/** Test seam: reason string for the most recent hardReload(). */
		__bobbitLastReloadReason?: string;
		/**
		 * Test seam: when set, hardReload() invokes this instead of
		 * location.reload(), so E2E can observe forced reloads without actually
		 * navigating (and without fighting the read-only Location object). No-op
		 * in production — nothing ever sets it.
		 */
		__bobbitReloadHook?: (reason: string) => void;
		/** Test seam / field diagnostic: count of completed resume probes (§3.2). */
		__bobbitResumeProbes?: number;
	}
}

/** sessionStorage key holding the timestamp of the last forced reload. */
const RELOAD_GUARD_KEY = "bobbit-pwa-reload-at";

/** Only suspends at least this long are candidates for a stale-resume reload. */
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min

/** Loop guard: at most one forced reload per this window. */
const RELOAD_COOLDOWN_MS = 10_000; // 10 s

/** After a resume, wait this long before probing the liveness heartbeat. */
const LIVENESS_PROBE_MS = 1500;

// ── Module state ─────────────────────────────────────────────────────────────
let installed = false;
let reloaded = false;
let booted = false;
/** When the page was last hidden/frozen (epoch ms), or null. */
let hiddenAtMs: number | null = null;
/** Last liveness-heartbeat tick (epoch ms), or null before the first tick. */
let lastAliveMs: number | null = null;
/** Active requestAnimationFrame handle for the heartbeat, or null. */
let heartbeatRaf: number | null = null;
/** Pending resume-probe timer, or null. */
let probeTimer: ReturnType<typeof setTimeout> | null = null;

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** True when running as an installed/standalone PWA (iOS or Chromium). */
export function isStandalone(): boolean {
	return (
		(typeof window !== "undefined" &&
			window.matchMedia?.("(display-mode: standalone)").matches) === true ||
		(typeof navigator !== "undefined" && (navigator as { standalone?: boolean }).standalone === true)
	);
}

export interface ShouldReloadOnResumeArgs {
	/** Does #app currently have child content (i.e. the app mounted)? */
	appMounted: boolean;
	/** When the page was last hidden/frozen (epoch ms), or null. */
	hiddenAtMs: number | null;
	/** When this resume began (epoch ms). */
	resumeAtMs: number;
	/** Last liveness-heartbeat tick (epoch ms), or null. */
	lastAliveMs: number | null;
	/** Probe time (Date.now()). */
	nowMs: number;
	/** sessionStorage loop-guard timestamp (epoch ms), or null. */
	lastReloadAtMs: number | null;
	/** Only suspends ≥ this qualify (e.g. 30 min). */
	staleThresholdMs: number;
	/** Loop-guard cooldown window (e.g. 10 s). */
	reloadCooldownMs: number;
}

/**
 * PURE decision function — no DOM, no globals. Returns true iff the page should
 * be force-reloaded after a resume. Rules (in order):
 *
 *   - Loop guard (overrides all): within `reloadCooldownMs` of the last
 *     reload → false.
 *   - Dead bootstrap: nothing painted (`!appMounted`) → true.
 *   - Mounted-but-frozen snapshot: mounted AND the suspend was long
 *     (gap ≥ staleThresholdMs) AND the heartbeat did not advance since resume
 *     (lastAliveMs == null || lastAliveMs <= resumeAtMs) → true.
 *   - Otherwise → false. In particular a mounted page whose heartbeat advanced
 *     after resume is treated as ALIVE and is NOT reloaded, regardless of gap.
 */
export function shouldReloadOnResume(args: ShouldReloadOnResumeArgs): boolean {
	const {
		appMounted,
		hiddenAtMs: hiddenAt,
		resumeAtMs,
		lastAliveMs: lastAlive,
		nowMs,
		lastReloadAtMs,
		staleThresholdMs,
		reloadCooldownMs,
	} = args;

	// Loop guard overrides everything.
	if (lastReloadAtMs != null && nowMs - lastReloadAtMs < reloadCooldownMs) {
		return false;
	}

	// Dead bootstrap — nothing painted; page never re-bootstrapped.
	if (!appMounted) return true;

	// Mounted-but-frozen snapshot.
	const longSuspend = hiddenAt != null && nowMs - hiddenAt >= staleThresholdMs;
	const heartbeatStale = lastAlive == null || lastAlive <= resumeAtMs;
	if (longSuspend && heartbeatStale) return true;

	return false;
}

// ── DOM-facing helpers ───────────────────────────────────────────────────────

function readReloadGuard(): number | null {
	try {
		const raw = sessionStorage.getItem(RELOAD_GUARD_KEY);
		if (!raw) return null;
		const n = Number(raw);
		return Number.isFinite(n) ? n : null;
	} catch {
		return null;
	}
}

function writeReloadGuard(ms: number): void {
	try {
		sessionStorage.setItem(RELOAD_GUARD_KEY, String(ms));
	} catch {
		/* sessionStorage unavailable — best effort */
	}
}

function isAppMounted(): boolean {
	if (typeof document === "undefined") return false;
	const app = document.getElementById("app");
	return !!app && app.children.length > 0;
}

/**
 * Single funnel for every forced reload. Honors the module `reloaded` flag and
 * the sessionStorage cooldown guard so we reload at most once per genuine
 * freeze/kill recovery. Logs `reason` for iOS field debugging and bumps a
 * test seam counter so E2E can observe reloads without intercepting navigation.
 */
function hardReload(reason: string): void {
	if (reloaded) return;
	const now = Date.now();
	const last = readReloadGuard();
	if (last != null && now - last < RELOAD_COOLDOWN_MS) return;
	reloaded = true;
	writeReloadGuard(now);
	try {
		// eslint-disable-next-line no-console
		console.warn(`[pwa-lifecycle] hard reload: ${reason}`);
	} catch {
		/* ignore */
	}
	try {
		window.__bobbitHardReloads = (window.__bobbitHardReloads ?? 0) + 1;
		window.__bobbitLastReloadReason = reason;
	} catch {
		/* ignore */
	}
	try {
		const hook = window.__bobbitReloadHook;
		if (typeof hook === "function") {
			hook(reason);
			return;
		}
		location.reload();
	} catch {
		/* ignore */
	}
}

function startHeartbeat(): void {
	if (heartbeatRaf != null) return;
	if (typeof requestAnimationFrame !== "function") {
		// Environments without rAF — stamp once so a live page isn't mistaken
		// for a frozen one.
		lastAliveMs = Date.now();
		return;
	}
	const tick = (): void => {
		lastAliveMs = Date.now();
		heartbeatRaf = requestAnimationFrame(tick);
	};
	heartbeatRaf = requestAnimationFrame(tick);
}

function markHidden(): void {
	hiddenAtMs = Date.now();
}

/**
 * Resume handler. Records when the resume began, (re)starts the liveness
 * heartbeat, and schedules a probe. If by probe time the heartbeat has not
 * advanced past the resume — and the suspend was long — the page is a frozen
 * mounted snapshot and we reload.
 */
function onResume(): void {
	if (reloaded) return;
	const resumeAtMs = Date.now();
	// (Re)start the heartbeat — it stops while the page is hidden.
	startHeartbeat();

	if (probeTimer != null) {
		clearTimeout(probeTimer);
		probeTimer = null;
	}
	probeTimer = setTimeout(() => {
		probeTimer = null;
		try {
			window.__bobbitResumeProbes = (window.__bobbitResumeProbes ?? 0) + 1;
		} catch {
			/* ignore */
		}
		if (reloaded || !isStandalone()) return;
		const decision = shouldReloadOnResume({
			appMounted: isAppMounted(),
			hiddenAtMs,
			resumeAtMs,
			lastAliveMs,
			nowMs: Date.now(),
			lastReloadAtMs: readReloadGuard(),
			staleThresholdMs: STALE_THRESHOLD_MS,
			reloadCooldownMs: RELOAD_COOLDOWN_MS,
		});
		if (decision) hardReload("resume-stale");
	}, LIVENESS_PROBE_MS);
}

/**
 * Wire all recovery listeners. Idempotent. Every listener early-returns unless
 * `isStandalone()`, so a normal browser tab / dev server is untouched.
 */
export function installPwaLifecycleRecovery(): void {
	if (installed) return;
	if (typeof window === "undefined") return;
	installed = true;

	// §3.1 — bfcache / frozen-restore. A persisted restore is inherently
	// loop-safe: the reloaded page is a fresh load, so its next pageshow has
	// persisted === false.
	window.addEventListener("pageshow", (e: PageTransitionEvent) => {
		if (e.persisted && isStandalone()) hardReload("pageshow-persisted");
	});

	// §3.2 — suspend/resume tracking. Redundantly driven by pagehide, freeze,
	// resume and visibilitychange to cover iOS's partial Page Lifecycle support.
	window.addEventListener("pagehide", () => {
		if (isStandalone()) markHidden();
	});
	window.addEventListener("freeze", () => {
		if (isStandalone()) markHidden();
	});
	window.addEventListener("resume", () => {
		if (isStandalone()) onResume();
	});
	document.addEventListener("visibilitychange", () => {
		if (!isStandalone()) return;
		if (document.visibilityState === "hidden") markHidden();
		else onResume();
	});

	// Start the liveness heartbeat now if we're already standalone and visible.
	if (isStandalone() && (typeof document === "undefined" || document.visibilityState !== "hidden")) {
		startHeartbeat();
	}
}

/**
 * Record that the app has mounted content into #app and clear the inline boot
 * watchdog scheduled in index.html. Idempotent — safe to call once after the
 * first renderApp() regardless of standalone mode.
 */
export function markAppBooted(): void {
	if (booted) return;
	booted = true;
	try {
		if (typeof window !== "undefined" && window.__bobbitBootWatchdog != null) {
			clearTimeout(window.__bobbitBootWatchdog as ReturnType<typeof setTimeout>);
			window.__bobbitBootWatchdog = undefined;
		}
	} catch {
		/* ignore */
	}
}
