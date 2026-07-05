export interface FencedFetchOptions {
	fixtures?: Record<string, Response | (() => Response | Promise<Response>)>;
	fetchImpl?: typeof fetch;
}

function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	if (host === "localhost" || host === "::1" || host === "[::1]") return true;
	const match = /^127(?:\.\d{1,3}){3}$/.exec(host);
	if (!match) return false;
	return host.split(".").every(part => Number(part) >= 0 && Number(part) <= 255);
}

export function createFencedFetch(opts: FencedFetchOptions = {}): typeof fetch {
	const inner = opts.fetchImpl ?? globalThis.fetch;
	return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		const fixture = opts.fixtures?.[url.href] ?? opts.fixtures?.[`${url.origin}${url.pathname}`];
		if (fixture) return typeof fixture === "function" ? await fixture() : fixture;
		if (!isLoopbackHost(url.hostname)) {
			throw new Error(`[fenced-fetch] blocked non-loopback fetch: ${url.origin}`);
		}
		return inner(input, init);
	}) as typeof fetch;
}
