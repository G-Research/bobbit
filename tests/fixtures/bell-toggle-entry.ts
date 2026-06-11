// Entry that bundles <bell-toggle> for a file:// fixture so we can drive its
// rendered state, icon swap, persistence call, and cross-surface sync.
import "../../src/ui/components/BellToggle.js";

// Capture the preference PUT (gatewayFetch ultimately calls window.fetch) so the
// test can assert persistence without a real gateway.
(window as any).__putCalls = [];
window.fetch = ((input: unknown, init?: RequestInit) => {
	(window as any).__putCalls.push({ url: String(input), method: init?.method, body: init?.body });
	return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
}) as typeof window.fetch;

(window as any).__ready = true;
