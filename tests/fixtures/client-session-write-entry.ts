// Test entry — exercises the C2 client session WRITE (`host.session.postMessage`)
// and its MANDATORY user-gesture gate (src/app/host-api.ts + gesture-context.ts;
// design extension-host-phase2.md §8 C2.1). `window.fetch` is stubbed so we can
// assert WHETHER a POST fired (and with what body) without a live gateway.
//
// Loaded under a file:// fixture so the real `getHostApi` (which transitively
// imports lit/renderer-registry/state) runs in a browser context.
import { getHostApi } from "../../src/app/host-api.js";
import { runWithUserGesture } from "../../src/app/gesture-context.js";

interface Captured { url: string; method: string; body: any }
const calls: Captured[] = [];
(window as any).__calls = (): Captured[] => calls;
(window as any).__reset = (): void => { calls.length = 0; };

// Capture every fetch; return a 200 JSON ok so postMessage resolves.
window.fetch = (async (input: any, init?: any): Promise<Response> => {
	const url = typeof input === "string" ? input : (input?.url ?? String(input));
	let body: any;
	try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
	calls.push({ url, method: init?.method ?? "GET", body });
	return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
}) as any;

// A panel/entrypoint origin binds toolUseId:undefined — postMessage must still work.
const host = (): any => getHostApi("sess-1", undefined, "sample_action");

// No gesture → must throw SYNCHRONOUSLY (mount-time post fails loudly), no POST.
(window as any).__postNoGesture = (): string | null => {
	try {
		// Not awaited: a synchronous throw surfaces here directly.
		host().session.postMessage({ role: "user", text: "hi" });
		return null; // did not throw → failure
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
};

// Inside a genuine gesture → the POST fires to the C2 endpoint with the bound tool.
(window as any).__postWithGesture = async (): Promise<{ posted: boolean; body: any }> => {
	const h = host();
	const p: Promise<void> = runWithUserGesture(() =>
		h.session.postMessage({ role: "user", text: "hi", resumeTurn: false }));
	await p;
	const last = calls[calls.length - 1];
	return { posted: !!last, body: last?.body };
};

// One gesture authorizes exactly ONE post: a second synchronous post throws.
(window as any).__twoPostsOneGesture = (): string[] => {
	const h = host();
	const out: string[] = [];
	runWithUserGesture(() => {
		// First call consumes the gesture (async POST kicked off).
		void h.session.postMessage({ role: "user", text: "a" });
		// Second call's synchronous prologue sees no gesture → throws.
		try { void h.session.postMessage({ role: "user", text: "b" }); out.push("no-throw"); }
		catch (e) { out.push(e instanceof Error ? e.message : String(e)); }
	});
	return out;
};

// subscribe returns an unsubscribe fn (no throw, no server round-trip).
(window as any).__subscribeReturnsUnsub = (): boolean => {
	const unsub = host().session.subscribe("status", () => {});
	const ok = typeof unsub === "function";
	if (ok) unsub();
	return ok;
};

(window as any).__ready = true;
