import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/client-session-write.spec.ts (v2-dom tier).
// Exercises the REAL C2 client session WRITE (host.session.postMessage) and its two
// gates — the trusted-WS transport (session-write-bridge) and the user-activation
// gate (gesture-context / navigator.userActivation) — under happy-dom instead of an
// esbuild file:// bundle. The real getHostApi + gesture + bridge modules are imported
// directly; navigator.userActivation and fetch are mocked exactly as the legacy entry
// did, and SubtleCrypto (globalThis.crypto.subtle) is ensured for the content-hash.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";
// NOTE: session-manager is imported first, before host-api, on purpose. The app's
// client module graph has a circular-init edge (session-manager top-level calls
// pack-panels.setSessionSwitcher; pack-panels transitively re-enters session-manager).
// Letting host-api pull the graph in first evaluates session-manager's top-level call
// while pack-panels is still mid-import → a `sessionSwitcher` TDZ ReferenceError.
// Importing session-manager first makes it own the top of the DFS so pack-panels
// finishes initializing before that top-level call runs.
import "../../src/app/session-manager.js";
import { getHostApi } from "../../src/app/host-api.js";
import { runWithUserGesture } from "../../src/app/gesture-context.js";
import { registerSessionPoster, unregisterSessionPoster, type SessionPostRequest } from "../../src/app/session-write-bridge.js";

const TOKEN = "surface-token-xyz";
const isTokenMint = (u: string) => u.includes("/api/ext/surface-token");

let calls: Array<{ url: string; method: string; body: any }>;
let posted: SessionPostRequest[];
let activation = false;

const fakePoster = async (req: SessionPostRequest): Promise<void> => { posted.push(req); };
const writeFetches = () => calls.filter((c) => !isTokenMint(c.url)).length;
const tokenMinted = () => calls.some((c) => isTokenMint(c.url));
const host = () => getHostApi("sess-1", undefined, { kind: "tool", tool: "sample_action" } as any) as any;

beforeAll(() => {
	// host-api computes the content hash via SubtleCrypto — ensure it exists.
	if (!(globalThis as any).crypto?.subtle) {
		Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
	}
	// Mock navigator.userActivation so the test controls the genuine-activation gate.
	Object.defineProperty(navigator, "userActivation", {
		configurable: true,
		get: () => ({ isActive: activation, hasBeenActive: activation }),
	});
});

beforeEach(() => {
	calls = [];
	posted = [];
	activation = false;
	registerSessionPoster("sess-1", fakePoster);
	vi.stubGlobal("fetch", async (input: any, init?: any) => {
		const url = typeof input === "string" ? input : (input?.url ?? String(input));
		let body: any;
		try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
		calls.push({ url, method: init?.method ?? "GET", body });
		if (isTokenMint(url)) return new Response(JSON.stringify({ token: TOKEN }), { status: 200, headers: { "Content-Type": "application/json" } });
		return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
	});
});

afterEach(() => {
	unregisterSessionPoster("sess-1");
	vi.unstubAllGlobals();
});

describe("host.session.postMessage — trusted WS transport + activation gate", () => {
	it("throws synchronously and sends NOTHING without a user activation", () => {
		activation = false;
		let msg: string | null = null;
		try {
			host().session.postMessage({ role: "user", text: "hi" });
		} catch (e) {
			msg = e instanceof Error ? e.message : String(e);
		}
		expect(msg).toContain("postMessage requires a user gesture");
		expect(posted.length).toBe(0);
		expect(calls.length).toBe(0);
	});

	it("with a genuine activation the post rides the trusted WS poster carrying the surface token — and NO session-write fetch", async () => {
		activation = true;
		await runWithUserGesture(() => host().session.postMessage({ role: "user", text: "hi", resumeTurn: false }));

		const p = posted[0];
		expect(p).toBeTruthy();
		// Identity rides the SERVER-MINTED surface token, never a caller-supplied tool.
		expect(p.surfaceToken).toBe(TOKEN);
		expect((p as any).tool).toBeUndefined();
		expect(p.role).toBe("user");
		expect(p.text).toBe("hi");
		expect(p.resumeTurn).toBe(false);
		// Content-bound permit: sha256(role + "\n" + text) matches Node's createHash.
		const expectedHash = createHash("sha256").update("user\nhi", "utf8").digest("hex");
		expect(p.contentHash).toBe(expectedHash);
		// The token mint is the only sanctioned fetch; the SEND rides the WS bridge.
		expect(tokenMinted()).toBe(true);
		expect(writeFetches()).toBe(0);
	});

	it("with no trusted WS transport registered, the post rejects (no fetch fallback for the SEND)", async () => {
		activation = true;
		unregisterSessionPoster("sess-1");
		let msg: string | null = null;
		try {
			await host().session.postMessage({ role: "user", text: "hi" });
		} catch (e) {
			msg = e instanceof Error ? e.message : String(e);
		}
		expect(msg).toContain("transport unavailable");
		expect(writeFetches()).toBe(0);
	});

	it("subscribe returns an unsubscribe fn (no throw, no round-trip)", () => {
		const unsub = host().session.subscribe("status", () => {});
		expect(typeof unsub).toBe("function");
		unsub();
		expect(calls.length).toBe(0);
	});
});
