// Test entry — exercises the C2 client session WRITE (`host.session.postMessage`)
// and its two unforgeable gates: a REAL user activation (navigator.userActivation)
// + the trusted per-session SECRET attached as `x-bobbit-session-secret`
// (src/app/host-api.ts + gesture-context.ts; design extension-host-phase2.md §8
// C2.1 / Fix A). `window.fetch` is stubbed so we can assert WHETHER a POST fired
// (and with what body/headers) without a live gateway.
//
// `navigator.userActivation` is mocked so the test can toggle a genuine activation
// on/off (page.evaluate is not itself a user gesture). The trusted secret is
// injected via `setSessionSecret` (the same module-closure trusted app code uses);
// pack code cannot reach that closure.
import { getHostApi } from "../../src/app/host-api.js";
import { runWithUserGesture, setSessionSecret } from "../../src/app/gesture-context.js";

interface Captured { url: string; method: string; body: any; headers: Record<string, string> }
const calls: Captured[] = [];
(window as any).__calls = (): Captured[] => calls;
(window as any).__reset = (): void => {
	calls.length = 0;
	setActivation(false);
	// Trusted app code holds the per-session secret in a gesture-context closure.
	setSessionSecret("sess-1", "test-secret");
};

// Mock navigator.userActivation so we control whether a genuine activation is
// "active" (true only inside a real user gesture in production; mocked here).
let activation = false;
function setActivation(b: boolean): void { activation = b; }
Object.defineProperty(navigator, "userActivation", {
	configurable: true,
	get: () => ({ isActive: activation, hasBeenActive: activation }),
});

// Capture every fetch; return 200 JSON ok so postMessage resolves.
window.fetch = (async (input: any, init?: any): Promise<Response> => {
	const url = typeof input === "string" ? input : (input?.url ?? String(input));
	let body: any;
	try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
	const headers = (init?.headers ?? {}) as Record<string, string>;
	calls.push({ url, method: init?.method ?? "GET", body, headers });
	return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
}) as any;

// Helper: the captured POST to /api/ext/session/message (if any).
const messageCall = (): Captured | undefined => calls.find((c) => c.url.includes("/api/ext/session/message"));
(window as any).__messageCall = messageCall;

// A panel/entrypoint origin binds toolUseId:undefined — postMessage must still work.
const host = (): any => getHostApi("sess-1", undefined, "sample_action");

// No activation → must throw SYNCHRONOUSLY (mount-time post fails loudly), no POST.
(window as any).__postNoGesture = (): string | null => {
	setActivation(false);
	try {
		// Not awaited: a synchronous throw surfaces here directly.
		host().session.postMessage({ role: "user", text: "hi" });
		return null; // did not throw → failure
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
};

// With a genuine activation → the POST fires to the C2 endpoint with the bound tool
// AND carries the trusted per-session secret header (Fix A).
(window as any).__postWithGesture = async (): Promise<{ posted: boolean; body: any; secretHeader: string | undefined }> => {
	setActivation(true);
	const h = host();
	const p: Promise<void> = runWithUserGesture(() =>
		h.session.postMessage({ role: "user", text: "hi", resumeTurn: false }));
	await p;
	const msg = messageCall();
	const secretHeader = msg?.headers?.["x-bobbit-session-secret"];
	return { posted: !!msg, body: msg?.body, secretHeader };
};

// Without the trusted secret in the closure, no header is attached (the server then
// rejects). Proves the secret is sourced from trusted closure state, not the body.
(window as any).__postWithoutSecret = async (): Promise<{ posted: boolean; secretHeader: string | undefined }> => {
	setActivation(true);
	setSessionSecret("sess-1", undefined); // pretend the trusted secret is absent
	const h = host();
	await h.session.postMessage({ role: "user", text: "hi" });
	const msg = messageCall();
	return { posted: !!msg, secretHeader: msg?.headers?.["x-bobbit-session-secret"] };
};

// subscribe returns an unsubscribe fn (no throw, no server round-trip).
(window as any).__subscribeReturnsUnsub = (): boolean => {
	const unsub = host().session.subscribe("status", () => {});
	const ok = typeof unsub === "function";
	if (ok) unsub();
	return ok;
};

(window as any).__ready = true;
