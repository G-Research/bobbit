/**
 * Translate a published gateway URL only for a Docker sandbox callback.
 *
 * Docker gives containers a host route through `host.docker.internal`; a host
 * loopback listener is otherwise the container's own loopback. The returned
 * URL is suitable only for the sandbox's scoped callback authority. Invalid or
 * credential-bearing URLs deliberately return undefined so callers fail closed.
 */
export function translateSandboxGatewayUrl(raw: string): string | undefined {
	if (typeof raw !== "string" || raw.length === 0 || raw !== raw.trim()) return undefined;

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return undefined;
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) {
		return undefined;
	}

	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const loopback = hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
	if (!loopback) return raw;

	// Replace only the parsed authority host so explicit/default ports, the mount
	// path, and any deployment query remain byte-for-byte intact.
	const schemeEnd = raw.indexOf("://");
	const authorityStart = schemeEnd + 3;
	const suffixOffset = raw.slice(authorityStart).search(/[/?#]/);
	const authorityEnd = suffixOffset < 0 ? raw.length : authorityStart + suffixOffset;
	const authority = raw.slice(authorityStart, authorityEnd);
	const port = authority.startsWith("[")
		? authority.slice(authority.indexOf("]") + 1)
		: authority.includes(":") ? authority.slice(authority.indexOf(":")) : "";
	return `${raw.slice(0, authorityStart)}host.docker.internal${port}${raw.slice(authorityEnd)}`;
}
