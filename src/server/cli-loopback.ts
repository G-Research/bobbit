/** Return whether a listener host is a loopback name/address. */
export function isLoopbackHost(host: string): boolean {
	const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
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
