// Test entry — bundles prefetch-on-hover helpers for file:// fixture use.
import {
	prefetchUrl,
	prefetchSession,
	prefetchGoal,
	gatewayFetch,
	PREFETCH_DEBOUNCE_MS,
	PREFETCH_TTL_MS,
	PREFETCH_MAX_ENTRIES,
	_resetPrefetchCacheForTest,
	_prefetchCacheSizeForTest,
} from "../../src/app/api.js";
import { setPerfFlag, reloadPerfFlags } from "../../src/app/perf-flags.js";

(window as any).__prefetch = {
	prefetchUrl,
	prefetchSession,
	prefetchGoal,
	gatewayFetch,
	PREFETCH_DEBOUNCE_MS,
	PREFETCH_TTL_MS,
	PREFETCH_MAX_ENTRIES,
	resetCache: _resetPrefetchCacheForTest,
	cacheSize: _prefetchCacheSizeForTest,
	setPerfFlag,
	reloadPerfFlags,
};

// Install a counted-fetch shim. The stub reads `window.__fetchCounts` on
// every call so tests can swap the counts map in beforeEach without
// breaking the stub binding.
(window as any).__fetchCounts = {};
const originalFetch = window.fetch;
(window as any).__originalFetch = originalFetch;
const stubFetch = ((input: any, _init?: any): Promise<Response> => {
	const url = typeof input === "string" ? input : (input?.url ?? String(input));
	const counts = (window as any).__fetchCounts as Record<string, number>;
	counts[url] = (counts[url] ?? 0) + 1;
	const body = JSON.stringify({ url, count: counts[url] });
	return Promise.resolve(new Response(body, {
		status: 200,
		headers: { "Content-Type": "application/json", "content-length": String(body.length) },
	}));
}) as any;
window.fetch = stubFetch;
(window as any).__stubFetch = stubFetch;
