// Theme-token-only HTML helpers shared by all widgets
// (docs/design/experiment-runner-reporting.md §6.3). Widgets emit STRINGS, never
// touch the DOM, never read the network. They use ONLY Bobbit theme tokens — no
// hardcoded #rrggbb / rgb()/ :root / prefers-color-scheme — so the panel iframe
// and the standalone report both theme correctly. Purity lets the same renderer
// run server-side (report route HTML) and client-side (panel).

/** Escape a value for safe interpolation into HTML text/attributes. */
export function escapeHtml(value: unknown): string {
	const s = value === null || value === undefined ? "" : String(value);
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Categorical series colour from the --chart-1..6 palette (1-indexed, wraps). */
export function chartColor(index: number): string {
	const slot = ((index % 6) + 6) % 6; // 0..5
	return `var(--chart-${slot + 1})`;
}

/** Semantic colour for a delta given the optimization direction. */
export function deltaColor(delta: number | null, direction: "max" | "min"): string {
	if (delta === null || delta === 0) return "var(--muted-foreground)";
	const good = direction === "max" ? delta > 0 : delta < 0;
	return good ? "var(--positive)" : "var(--negative)";
}

/** Format a metric value for display (null → an em-dash). */
export function fmtValue(value: number | null | undefined, digits = 4): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return "—";
	if (Number.isInteger(value)) return String(value);
	// Trim trailing zeros from a fixed-precision string.
	return Number.parseFloat(value.toFixed(digits)).toString();
}

/** Format a signed delta with a leading +/-. */
export function fmtDelta(delta: number | null, digits = 4): string {
	if (delta === null || !Number.isFinite(delta)) return "";
	const body = fmtValue(Math.abs(delta), digits);
	return delta >= 0 ? `+${body}` : `-${body}`;
}

/** Format a fractional delta as a percentage. */
export function fmtPct(pct: number | null): string {
	if (pct === null || !Number.isFinite(pct)) return "";
	const v = (pct * 100).toFixed(1);
	return `${pct >= 0 ? "+" : ""}${v}%`;
}

/** Wrap widget body HTML in a themed card with an optional title. */
export function card(title: string | undefined, body: string): string {
	const heading = title
		? `<div class="er-widget__title" style="font-weight:600;color:var(--foreground);margin-bottom:8px;">${escapeHtml(title)}</div>`
		: "";
	return (
		`<section class="er-widget" style="background:var(--card);color:var(--foreground);` +
		`border:1px solid var(--border);border-radius:8px;padding:12px;margin:0 0 12px 0;">` +
		`${heading}${body}</section>`
	);
}

/** A muted "no data" placeholder body. */
export function emptyNote(text = "No data"): string {
	return `<div style="color:var(--muted-foreground);font-size:13px;">${escapeHtml(text)}</div>`;
}
