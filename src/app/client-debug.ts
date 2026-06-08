/*
 * Client debug tool.
 *
 * A flag-gated diagnostic for pulling information out of the running web client
 * when normal inspection is impractical — most importantly on installed mobile
 * PWAs, where there is no DevTools console and things like
 * `env(safe-area-inset-*)`, the iOS viewport "lie", connection state, or which
 * build is live can only be observed on the real device.
 *
 * When enabled, a small button appears in the connected mobile chat view;
 * tapping it dumps a copy-pasteable, sectioned report into the message composer
 * so it can be read or sent to an agent.
 *
 * Deliberately generic: built-in sections cover environment + viewport/layout,
 * and any module can contribute more via `registerDebugSection()` (the app-state
 * section is registered from render.ts, which has access to app state). Add new
 * sections here or via the registry whenever you need a new class of client
 * info — don't make this layout-specific.
 *
 * Gating mirrors the perf-instrumentation pattern (boot-timing.ts): a
 * localStorage flag, flipped from a Settings toggle so it can be turned on
 * directly on a phone.
 *
 * See .claude/skills/client-debug/SKILL.md for the playbook this feeds.
 */

/** localStorage key gating the client-debug button + dump. */
export const CLIENT_DEBUG_KEY = "bobbit-client-debug";

/** True when the client-debug tool is enabled (button shown, dump available). */
export function isClientDebugEnabled(): boolean {
	try {
		return localStorage.getItem(CLIENT_DEBUG_KEY) === "1";
	} catch {
		return false;
	}
}

/** Enable/disable the client-debug tool. Called by the Settings toggle. */
export function setClientDebugEnabled(on: boolean): void {
	try {
		if (on) localStorage.setItem(CLIENT_DEBUG_KEY, "1");
		else localStorage.removeItem(CLIENT_DEBUG_KEY);
	} catch {
		/* localStorage unavailable (private mode etc.) — no-op */
	}
}

/** A debug section provider: returns the section body as plain text (no fence).
 *  Return "" to skip the section. */
export type DebugSectionProvider = () => string;

const sectionProviders = new Map<string, DebugSectionProvider>();

/** Register a named debug section. Re-registering the same name replaces it.
 *  Sections render in registration order, after the built-ins. */
export function registerDebugSection(name: string, provider: DebugSectionProvider): void {
	sectionProviders.set(name, provider);
}

// ── Built-in sections ───────────────────────────────────────────────────────

const num = (n: number | undefined | null): string =>
	typeof n === "number" && Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "n/a";

function environmentSection(): string {
	const standalone =
		(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
		(navigator as any).standalone === true;
	const build = (globalThis as { __BOBBIT_BUILD_ID__?: string }).__BOBBIT_BUILD_ID__ ?? "dev";
	return [
		`build=${build}`,
		`standalone=${standalone}  navigator.standalone=${(navigator as any).standalone}`,
		`dpr=${window.devicePixelRatio}  lang=${navigator.language}  online=${navigator.onLine}`,
		`screen=${screen.width}x${screen.height}  avail=${screen.availWidth}x${screen.availHeight}`,
		`userAgent=${navigator.userAgent}`,
	].join("\n");
}

/** Resolve a CSS height value to pixels via a hidden fixed probe. The single
 *  most useful signal for the iOS "viewport lie" — where 100dvh/100% report the
 *  short layout viewport while 100vh/100lvh report the true screen height. */
function measureHeightUnit(h: string): number {
	const el = document.createElement("div");
	el.style.cssText = `position:fixed;top:0;left:0;width:1px;visibility:hidden;pointer-events:none;height:${h};`;
	document.body.appendChild(el);
	const px = el.getBoundingClientRect().height;
	el.remove();
	return Math.round(px * 100) / 100;
}

function viewportSection(): string {
	const vv = (window as any).visualViewport as VisualViewport | undefined;

	// Resolved safe-area insets via a hidden probe element.
	const probe = document.createElement("div");
	probe.style.cssText =
		"position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;" +
		"padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);" +
		"padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left);";
	document.body.appendChild(probe);
	const cs = getComputedStyle(probe);
	const insets = { top: cs.paddingTop, right: cs.paddingRight, bottom: cs.paddingBottom, left: cs.paddingLeft };
	probe.remove();

	const de = document.documentElement;
	const shell = document.querySelector(".app-shell") as HTMLElement | null;
	const header = document.getElementById("app-header");
	const main = document.getElementById("app-main");
	const editor = document.querySelector("message-editor") as HTMLElement | null;
	const rectY = (el: Element | null): string => {
		if (!el) return "none";
		const b = el.getBoundingClientRect();
		return `top=${num(b.top)} bottom=${num(b.bottom)} h=${num(b.height)}`;
	};
	const shellBottom = shell ? shell.getBoundingClientRect().bottom : NaN;

	return [
		`window.inner=${window.innerWidth}x${window.innerHeight}  outer=${window.outerWidth}x${window.outerHeight}`,
		vv
			? `visualViewport=${num(vv.width)}x${num(vv.height)}  offset=${num(vv.offsetLeft)},${num(vv.offsetTop)}  pageTop=${num((vv as any).pageTop)}  scale=${num(vv.scale)}`
			: "visualViewport=n/a",
		`safe-area insets: top=${insets.top} right=${insets.right} bottom=${insets.bottom} left=${insets.left}`,
		`unit probes (px): 100vh=${measureHeightUnit("100vh")} 100dvh=${measureHeightUnit("100dvh")} 100svh=${measureHeightUnit("100svh")} 100lvh=${measureHeightUnit("100lvh")} fill-avail=${measureHeightUnit("-webkit-fill-available")}`,
		`documentElement client=${de.clientWidth}x${de.clientHeight}  offsetH=${(de as HTMLElement).offsetHeight}  scrollH=${de.scrollHeight}`,
		`body client=${document.body.clientWidth}x${document.body.clientHeight}  offsetH=${document.body.offsetHeight}`,
		`--mobile-header-height=${getComputedStyle(de).getPropertyValue("--mobile-header-height").trim() || "(unset)"}`,
		shell ? `app-shell: ${rectY(shell)}  computedHeight=${getComputedStyle(shell).height}  pos=${getComputedStyle(shell).position}` : "app-shell: none",
		`app-header: ${rectY(header)}`,
		`app-main: ${rectY(main)}`,
		`message-editor: ${rectY(editor)}`,
		`GAP below app-shell (innerHeight - shell.bottom) = ${num(shell ? window.innerHeight - shellBottom : NaN)}`,
	].join("\n");
}

function performanceSection(): string {
	const out: string[] = [];

	// Navigation Timing — available on every load, no flag or reload needed.
	const nav = (performance.getEntriesByType?.("navigation") || [])[0] as PerformanceNavigationTiming | undefined;
	if (nav) {
		out.push(
			`navigation: type=${nav.type}  ttfb=${num(nav.responseStart)}  domInteractive=${num(nav.domInteractive)}  ` +
			`domContentLoaded=${num(nav.domContentLoadedEventEnd)}  load=${num(nav.loadEventEnd)}  ` +
			`transfer=${num(nav.transferSize)}B`,
		);
	}

	// Paint timing — first paint / first-contentful-paint.
	const paints = (performance.getEntriesByType?.("paint") || []) as PerformanceEntry[];
	if (paints.length) {
		out.push("paint: " + paints.map((p) => `${p.name}=${num(p.startTime)}`).join("  "));
	}

	// JS heap (Chromium only).
	const mem = (performance as any).memory as { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number } | undefined;
	if (mem?.usedJSHeapSize != null) {
		const mb = (b?: number) => (typeof b === "number" ? `${Math.round(b / 1048576)}MB` : "n/a");
		out.push(`jsHeap: used=${mb(mem.usedJSHeapSize)} total=${mb(mem.totalJSHeapSize)} limit=${mb(mem.jsHeapSizeLimit)}`);
	}

	// Boot waterfall — only present when perf instrumentation (boot-timing.ts)
	// was armed. Surfacing it here means the common case no longer needs the
	// reload + read-the-jsonl-from-disk round trip; the disk sink remains for
	// cross-reload statistical sampling.
	const boot = (window as any).__bobbitBootTimings as
		| { total_ms?: number; isReload?: boolean; buildId?: string; rows?: Array<Record<string, unknown>> }
		| undefined;
	if (boot?.rows?.length) {
		out.push(`boot waterfall: total=${num(boot.total_ms)}ms  reload=${boot.isReload}  build=${boot.buildId ?? "?"}`);
		for (const row of boot.rows) {
			out.push(`  ${String(row.phase)}: t=${row["t (ms)"]}ms  Δ=${row["Δ prev (ms)"]}ms`);
		}
	} else {
		out.push("boot waterfall: (not recorded — enable Perf instrumentation for the boot-mark breakdown)");
	}

	return out.join("\n");
}

// ── Report assembly ──────────────────────────────────────────────────────────

function renderSection(name: string, body: string): string {
	const trimmed = body.trim();
	if (!trimmed) return "";
	return `── ${name} ──\n${trimmed}`;
}

/** Collect a fenced, copy-pasteable report of all built-in + registered
 *  sections. Safe to call anywhere; reads the live DOM/state. */
export function collectClientDebug(): string {
	const blocks: string[] = [];
	const push = (name: string, fn: DebugSectionProvider) => {
		let body = "";
		try {
			body = fn();
		} catch (err) {
			body = `(section "${name}" threw: ${err instanceof Error ? err.message : String(err)})`;
		}
		const rendered = renderSection(name, body);
		if (rendered) blocks.push(rendered);
	};

	push("Environment", environmentSection);
	push("Viewport / layout", viewportSection);
	push("Performance", performanceSection);
	for (const [name, fn] of sectionProviders) push(name, fn);

	return "```\n" + blocks.join("\n\n") + "\n```";
}

/** Dump the report into the chat composer so it can be read / sent on mobile
 *  (where copying console output is impractical). */
export function dumpClientDebugToComposer(): void {
	const text = collectClientDebug();
	const editor = document.querySelector("message-editor") as (HTMLElement & { value?: string }) | null;
	if (!editor) return;
	(editor as any).value = text;
	requestAnimationFrame(() => {
		const ta = editor.querySelector("textarea") as HTMLTextAreaElement | null;
		if (ta) {
			ta.value = text;
			ta.dispatchEvent(new Event("input", { bubbles: true }));
			ta.focus();
		}
	});
}
