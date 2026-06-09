// Test entry — exercises the C2 client session WRITE (`host.session.postMessage`)
// and its two gates (src/app/host-api.ts + gesture-context.ts + session-write-bridge.ts;
// design extension-host-phase2.md §8 C2.1):
//   1. TRANSPORT (unforgeable): the SEND rides the trusted session WebSocket via the
//      session-write-bridge poster — NOT a `fetch`. We register a fake poster (the
//      real one is supplied by RemoteAgent over its private WS) and assert the post
//      flows through it, carrying the bound `tool`/role/text/resumeTurn AND the
//      `contentHash` (sha256 of role+text via SubtleCrypto) the poster uses to mint a
//      server-minted, one-time, content-bound write permit. `window.fetch` is stubbed
//      only to PROVE no fetch is involved (no capturable secret surface).
//   2. REAL user activation (defense-in-depth): navigator.userActivation is mocked so
//      the test can toggle a genuine activation on/off; postMessage throws SYNCHRONOUSLY
//      with no activation (no mount-time posts).
import { getHostApi } from "../../src/app/host-api.js";
import { runWithUserGesture } from "../../src/app/gesture-context.js";
import { registerSessionPoster, unregisterSessionPoster, type SessionPostRequest } from "../../src/app/session-write-bridge.js";

interface Captured { url: string; method: string; body: any; headers: Record<string, string> }
const calls: Captured[] = [];
const posted: SessionPostRequest[] = [];
(window as any).__calls = (): Captured[] => calls;
(window as any).__posted = (): SessionPostRequest[] => posted;

// Fake trusted WS poster (RemoteAgent registers the real one). Records the request
// and resolves like a server ack.
const fakePoster = async (req: SessionPostRequest): Promise<void> => { posted.push(req); };

(window as any).__reset = (): void => {
	calls.length = 0;
	posted.length = 0;
	setActivation(false);
	registerSessionPoster("sess-1", fakePoster);
};

// Mock navigator.userActivation so we control whether a genuine activation is
// "active" (true only inside a real user gesture in production; mocked here).
let activation = false;
function setActivation(b: boolean): void { activation = b; }
Object.defineProperty(navigator, "userActivation", {
	configurable: true,
	get: () => ({ isActive: activation, hasBeenActive: activation }),
});

// The surface-token MINT is the only sanctioned fetch the post path makes (to learn
// the server-minted identity token). The SEND itself must still ride the trusted WS
// — never a fetch carrying a capturable secret. `isTokenMint` lets the spec assert
// "the SEND is WS-only" without conflating it with the (secret-free) token mint.
const TOKEN = "surface-token-xyz";
const isTokenMint = (u: string): boolean => u.includes("/api/ext/surface-token");
(window as any).__writeFetches = (): number => calls.filter((c) => !isTokenMint(c.url)).length;
(window as any).__tokenMinted = (): boolean => calls.some((c) => isTokenMint(c.url));

// Capture every fetch. The surface-token mint returns an opaque token; any OTHER
// fetch on the SEND path would be a regression (the WRITE must NOT use one).
window.fetch = (async (input: any, init?: any): Promise<Response> => {
	const url = typeof input === "string" ? input : (input?.url ?? String(input));
	let body: any;
	try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
	const headers = (init?.headers ?? {}) as Record<string, string>;
	calls.push({ url, method: init?.method ?? "GET", body, headers });
	if (isTokenMint(url)) {
		return new Response(JSON.stringify({ token: TOKEN }), { status: 200, headers: { "Content-Type": "application/json" } });
	}
	return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
}) as any;

// A panel/entrypoint origin binds toolUseId:undefined — postMessage must still work.
const host = (): any => getHostApi("sess-1", undefined, "sample_action");

// No activation → must throw SYNCHRONOUSLY (mount-time post fails loudly), no send.
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

// With a genuine activation → the post flows through the trusted WS poster carrying
// the bound tool/role/text/resumeTurn — and NO fetch is made.
(window as any).__postWithGesture = async (): Promise<{ posted: SessionPostRequest | undefined; writeFetches: number; tokenMinted: boolean }> => {
	setActivation(true);
	const h = host();
	const p: Promise<void> = runWithUserGesture(() =>
		h.session.postMessage({ role: "user", text: "hi", resumeTurn: false }));
	await p;
	return { posted: posted[0], writeFetches: (window as any).__writeFetches(), tokenMinted: (window as any).__tokenMinted() };
};

// With NO trusted WS poster registered, postMessage rejects (transport unavailable):
// a raw same-realm context cannot drive the agent without the trusted WS.
(window as any).__postNoTransport = async (): Promise<string | null> => {
	setActivation(true);
	unregisterSessionPoster("sess-1");
	try {
		await host().session.postMessage({ role: "user", text: "hi" });
		return null; // resolved → failure
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
};

// subscribe returns an unsubscribe fn (no throw, no server round-trip).
(window as any).__subscribeReturnsUnsub = (): boolean => {
	const unsub = host().session.subscribe("status", () => {});
	const ok = typeof unsub === "function";
	if (ok) unsub();
	return ok;
};

(window as any).__ready = true;
