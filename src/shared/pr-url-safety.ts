/**
 * Defensive client-side boundary for server-projected pull-request links.
 * Server validation remains authoritative; this prevents legacy or malformed
 * cached state from reaching an href/window.open sink.
 */
export function sanitizePullRequestUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
	let parsed: URL;
	try { parsed = new URL(value); } catch { return undefined; }
	if ((parsed.protocol !== "https:" && parsed.protocol !== "http:")
		|| parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
	const segments = parsed.pathname.split("/").filter(Boolean);
	if (segments.length !== 4 || segments[2] !== "pull" || !/^[1-9]\d*$/.test(segments[3])) return undefined;
	if (parsed.pathname !== `/${segments.join("/")}`) return undefined;
	return parsed.href;
}
