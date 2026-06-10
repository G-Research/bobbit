/**
 * Unit tests for the SERVER-MINTED surface binding token
 * (src/server/extension-host/surface-binding.ts) — design
 * docs/design/extension-host-phase2.md §2.3 + §10.
 *
 * The token is how a scoped capability (store / session / route / session-write)
 * proves its pack identity WITHOUT a caller-supplied `tool` field. These pins prove:
 *   - a minted token round-trips to its exact {sessionId, packId, contributionId, tool};
 *   - a tampered / truncated / foreign-signed token is rejected;
 *   - an expired token is rejected;
 *   - resolveSurfaceIdentity DERIVES identity from the token (ignoring any caller
 *     tool), rejects a session mismatch (cross-session token use), rejects a token
 *     whose tool no longer resolves to a pack (stale after uninstall), and rejects a
 *     packId mismatch.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	mintSurfaceToken,
	validateSurfaceToken,
	resolveSurfaceIdentity,
} from "../src/server/extension-host/surface-binding.ts";

/** A market-pack baseDir for `<packName>` (the `market-packs/<name>` segment is
 *  what `resolvePackIdentity` keys off). */
function packLoc(packName: string, groupDir = "mytools") {
	return { baseDir: `/proj/.bobbit/config/market-packs/${packName}/tools`, groupDir };
}

/** A tool-location resolver mapping tool → location (or undefined). */
function makeResolver(map: Record<string, { baseDir: string; groupDir: string }>) {
	return { resolveToolLocation: (tool: string) => map[tool] } as never;
}

const BINDING = { sessionId: "sess-1", packId: "cool-pack", contributionId: "mytools/widget", tool: "widget" };

describe("surface-binding — mint + validate round-trip", () => {
	it("a minted token validates back to its exact binding", () => {
		const token = mintSurfaceToken(BINDING);
		const out = validateSurfaceToken(token);
		assert.deepEqual(out, BINDING);
	});

	it("rejects a tampered payload (signature mismatch)", () => {
		const token = mintSurfaceToken(BINDING);
		const [body, sig] = token.split(".");
		// Flip a character in the payload — the HMAC no longer matches.
		const tampered = `${body.slice(0, -1)}${body.slice(-1) === "A" ? "B" : "A"}.${sig}`;
		assert.equal(validateSurfaceToken(tampered), null);
	});

	it("rejects a tampered signature, a malformed token, and non-strings", () => {
		const token = mintSurfaceToken(BINDING);
		const [body] = token.split(".");
		assert.equal(validateSurfaceToken(`${body}.deadbeef`), null);
		assert.equal(validateSurfaceToken(body), null); // no dot
		assert.equal(validateSurfaceToken(""), null);
		assert.equal(validateSurfaceToken(undefined), null);
		assert.equal(validateSurfaceToken(42), null);
	});

	it("rejects an expired token (past its TTL)", () => {
		const token = mintSurfaceToken(BINDING, { now: () => 1_000 });
		// Within TTL.
		assert.deepEqual(validateSurfaceToken(token, { now: () => 1_000 + 5_000, ttlMs: 10_000 }), BINDING);
		// Past TTL.
		assert.equal(validateSurfaceToken(token, { now: () => 1_000 + 20_000, ttlMs: 10_000 }), null);
	});
});

describe("resolveSurfaceIdentity — derives identity from the token, never the caller", () => {
	const resolver = makeResolver({ widget: packLoc("cool-pack") });

	it("derives {packId, tool} from a valid token", () => {
		const token = mintSurfaceToken(BINDING);
		const r = resolveSurfaceIdentity({ token, headerSessionId: "sess-1", resolver });
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.equal(r.packId, "cool-pack");
			assert.equal(r.tool, "widget");
			assert.equal(r.sessionId, "sess-1");
		}
	});

	it("rejects a missing / invalid token", () => {
		const r = resolveSurfaceIdentity({ token: "garbage", headerSessionId: "sess-1", resolver });
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal(r.status, 403);
	});

	it("rejects a session mismatch (cross-session token use)", () => {
		const token = mintSurfaceToken(BINDING); // bound to sess-1
		const r = resolveSurfaceIdentity({ token, headerSessionId: "sess-OTHER", resolver });
		assert.equal(r.ok, false);
		if (!r.ok) assert.match(r.error, /session mismatch/);
	});

	it("rejects a stale token whose tool no longer resolves to a pack (uninstalled)", () => {
		const token = mintSurfaceToken(BINDING);
		// Resolver no longer knows `widget` (pack uninstalled) → non-pack → rejected.
		const r = resolveSurfaceIdentity({ token, headerSessionId: "sess-1", resolver: makeResolver({}) });
		assert.equal(r.ok, false);
		if (!r.ok) assert.match(r.error, /market pack/);
	});

	it("rejects a packId mismatch (token packId ≠ freshly-resolved packId)", () => {
		const token = mintSurfaceToken(BINDING); // token says cool-pack
		// `widget` now resolves under a DIFFERENT pack dir → packId mismatch.
		const r = resolveSurfaceIdentity({ token, headerSessionId: "sess-1", resolver: makeResolver({ widget: packLoc("other-pack") }) });
		assert.equal(r.ok, false);
		if (!r.ok) assert.match(r.error, /pack identity mismatch/);
	});

	it("a token for pack A cannot be used to act as pack B (cross-pack denial)", () => {
		// A token minted for cool-pack/widget, presented against a resolver where the
		// SAME tool name belongs to a different pack, is rejected — a pack cannot borrow
		// another pack's resolution by reusing a tool name.
		const token = mintSurfaceToken({ sessionId: "sess-1", packId: "pack-a", contributionId: "g/shared", tool: "shared" });
		const r = resolveSurfaceIdentity({ token, headerSessionId: "sess-1", resolver: makeResolver({ shared: packLoc("pack-b") }) });
		assert.equal(r.ok, false);
		if (!r.ok) assert.match(r.error, /pack identity mismatch/);
	});
});

// ── Pack-bound surfaces (panel / entrypoint / route) — no carrier tool (§4). ──

/** A minimal PackContributionResolver stub: knows one pack with one panel id. */
function packContribStub(installed: { packId: string; panelId?: string; entrypointId?: string; routeName?: string } | null) {
	const pack = installed
		? { packId: installed.packId, packName: installed.packId, packRoot: `/p/market-packs/${installed.packId}`, panels: installed.panelId ? [{ id: installed.panelId, entry: "x.js", sourceFile: "x", packRoot: "x" }] : [], entrypoints: installed.entrypointId ? [{ id: installed.entrypointId, kind: "route" as const, listName: "ep", sourceFile: "x", packRoot: "x" }] : [] }
		: undefined;
	return {
		list: () => (pack ? [pack] : []),
		getPack: (_pid: string | undefined, packId: string) => (pack && pack.packId === packId ? pack : undefined),
		getPanel: (_pid: string | undefined, packId: string, panelId: string) => (pack && pack.packId === packId ? pack.panels.find((p) => p.id === panelId) : undefined),
		getEntrypoint: (_pid: string | undefined, packId: string, id: string) => (pack && pack.packId === packId ? pack.entrypoints.find((e) => e.id === id) : undefined),
		hasRoute: (_pid: string | undefined, packId: string, name: string) => !!(pack && pack.packId === packId && installed?.routeName === name),
	} as never;
}

describe("resolveSurfaceIdentity — pack-bound (panel/entrypoint/route) tokens (§4.4/§4.5)", () => {
	const PB = { sessionId: "sess-1", packId: "artifacts", contributionId: "panel:artifacts.viewer" };

	it("a pack-bound token round-trips with NO tool", () => {
		const token = mintSurfaceToken(PB);
		assert.deepEqual(validateSurfaceToken(token), PB);
	});

	it("resolves when the pack is installed + active and the contribution exists", () => {
		const token = mintSurfaceToken(PB);
		const r = resolveSurfaceIdentity({
			token, headerSessionId: "sess-1", resolver: makeResolver({}),
			contributions: packContribStub({ packId: "artifacts", panelId: "artifacts.viewer" }),
		});
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.equal(r.packId, "artifacts");
			assert.equal(r.contributionId, "panel:artifacts.viewer");
			assert.equal(r.tool, undefined);
		}
	});

	it("rejects a pack-bound token for an UNINSTALLED/inactive pack", () => {
		const token = mintSurfaceToken(PB);
		const r = resolveSurfaceIdentity({ token, headerSessionId: "sess-1", resolver: makeResolver({}), contributions: packContribStub(null) });
		assert.equal(r.ok, false);
		if (!r.ok) assert.match(r.error, /not installed or active/);
	});

	it("rejects a pack-bound token whose contribution no longer exists", () => {
		const token = mintSurfaceToken(PB);
		// Pack installed but the panel id is gone.
		const r = resolveSurfaceIdentity({ token, headerSessionId: "sess-1", resolver: makeResolver({}), contributions: packContribStub({ packId: "artifacts" }) });
		assert.equal(r.ok, false);
		if (!r.ok) assert.match(r.error, /no longer available/);
	});

	it("rejects a pack-bound token presented on a DIFFERENT session (cross-session)", () => {
		const token = mintSurfaceToken(PB); // bound to sess-1
		const r = resolveSurfaceIdentity({ token, headerSessionId: "sess-OTHER", resolver: makeResolver({}), contributions: packContribStub({ packId: "artifacts", panelId: "artifacts.viewer" }) });
		assert.equal(r.ok, false);
		if (!r.ok) assert.match(r.error, /session mismatch/);
	});

	it("resolves an entrypoint-bound and a route-bound token", () => {
		const epToken = mintSurfaceToken({ sessionId: "sess-1", packId: "artifacts", contributionId: "entrypoint:artifacts.deeplink" });
		const epR = resolveSurfaceIdentity({ token: epToken, headerSessionId: "sess-1", resolver: makeResolver({}), contributions: packContribStub({ packId: "artifacts", entrypointId: "artifacts.deeplink" }) });
		assert.equal(epR.ok, true);

		const rtToken = mintSurfaceToken({ sessionId: "sess-1", packId: "artifacts", contributionId: "route:bundle" });
		const rtR = resolveSurfaceIdentity({ token: rtToken, headerSessionId: "sess-1", resolver: makeResolver({}), contributions: packContribStub({ packId: "artifacts", routeName: "bundle" }) });
		assert.equal(rtR.ok, true);
	});
});
