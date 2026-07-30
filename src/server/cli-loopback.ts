/**
 * Normalize a host literal only far enough to classify the gateway's supported
 * loopback binds. Brackets are removed only when they are a balanced IPv6
 * wrapper; malformed bracketed values remain non-loopback and therefore fail
 * closed into authenticated mode.
 */
export function isLoopbackHost(host: string): boolean {
	let normalized = host.trim().toLowerCase();
	if (normalized.startsWith("[") && normalized.endsWith("]")) {
		const literal = normalized.slice(1, -1);
		if (literal !== "::1") return false;
		normalized = literal;
	} else if (normalized.includes("[") || normalized.includes("]")) {
		return false;
	}
	return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/** Normalise a bind address to a same-host loopback peer for callbacks.
 *
 * Wildcard bind addresses (`0.0.0.0`, `::`) are valid LISTEN addresses but not
 * valid CONNECT addresses on macOS / BSD — a same-host agent fetching the
 * gateway-url must use a real loopback peer instead.
 *
 * Non-wildcard hosts (`localhost`, `127.0.0.1`, LAN IPs, hostnames) are
 * returned unchanged.
 */
export function loopbackForBind(host: string): string {
	if (host === "0.0.0.0") return "127.0.0.1";
	if (host === "::" || host === "[::]") return "[::1]";
	return host;
}
