// Migrated from tests/pr-walkthrough-trust-client.test.ts (v2-core tier).
// node:test named imports mapped to vitest; relative specifiers repointed for
// tests/unit/core/. Pure logic (injected fetch/confirm/ensureTrusted seams), node env.
/**
 * Unit tests for the CLIENT PR-walkthrough trust flow
 * (`src/app/pr-walkthrough-trust.ts`, design docs/design/pr-walkthrough-gh-posting.md
 * §4b.3). Drives `ensureGithubHostTrusted` + `callSpawnRouteWithTrust` in isolation
 * from the DOM / gateway via the injected `deps` seams (fetch + confirm + ensureTrusted).
 *
 * Pins the contract:
 *   - default host (github.com) → trusted with NO prompt / NO network.
 *   - the server's effective decision trusts gh-configured hosts with NO prompt/PUT.
 *   - unknown host + accept → PUT persists → trusted.
 *   - false, malformed, or unavailable effective decisions fail closed to prompt.
 *   - unknown host + decline → NOT trusted, NO PUT.
 *   - PUT failure aborts (returns false).
 *   - callSpawnRouteWithTrust: HOST_NOT_TRUSTED → accept → second callRoute carries
 *     trustedHostAck + prUrl; decline → cancelledHost, NO second call; non-untrusted
 *     result passes through unchanged.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
	ensureGithubHostTrusted,
	callSpawnRouteWithTrust,
	type EnsureGithubHostTrustedDeps,
	type SpawnRouteOutcome,
} from "../../../src/app/pr-walkthrough-trust.ts";

/** Minimal Response-like object for the injected fetch seam. */
function jsonResponse(body: unknown, ok = true): Response {
	return { ok, json: async () => body } as unknown as Response;
}
function failedResponse(): Response {
	return { ok: false, json: async () => ({}) } as unknown as Response;
}

interface FetchCall { path: string; init?: RequestInit }

/** Build a fetch stub from an ordered script of responses (one per call). */
function scriptedFetch(responses: Array<Response | Error>): { fetch: EnsureGithubHostTrustedDeps["fetch"]; calls: FetchCall[] } {
	const calls: FetchCall[] = [];
	let i = 0;
	const fetch: EnsureGithubHostTrustedDeps["fetch"] = async (path: string, init?: RequestInit) => {
		calls.push({ path, init });
		const next = responses[i++];
		if (next instanceof Error) throw next;
		if (!next) throw new Error(`scriptedFetch: no response scripted for call ${i}`);
		return next;
	};
	return { fetch, calls };
}

function putBodyHosts(call: FetchCall | undefined): string[] {
	assert.ok(call, "expected a PUT call");
	assert.equal(call!.init?.method, "PUT");
	return JSON.parse(String(call!.init?.body)).githubTrustedHosts as string[];
}

describe("ensureGithubHostTrusted", () => {
	it("trusts the default github.com host with no prompt and no network", async () => {
		const { fetch, calls } = scriptedFetch([]);
		let prompted = false;
		const ok = await ensureGithubHostTrusted("github.com", { fetch, confirm: async () => { prompted = true; return true; } });
		assert.equal(ok, true);
		assert.equal(prompted, false);
		assert.equal(calls.length, 0, "no /api/preferences call for a baseline host");
	});

	it("trusts a gh-configured enterprise host from the server decision without prompting or writing preferences", async () => {
		const { fetch, calls } = scriptedFetch([jsonResponse({ host: "ghe.example.com", trusted: true })]);
		let prompted = false;
		const ok = await ensureGithubHostTrusted("GHE.Example.com.", { fetch, confirm: async () => { prompted = true; return true; } });
		assert.equal(ok, true);
		assert.equal(prompted, false);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].path, "/api/github/trusted-hosts/check?host=ghe.example.com");
		assert.equal(calls[0].init?.method ?? "GET", "GET");
	});

	it("persists + trusts an unknown host on accept", async () => {
		const { fetch, calls } = scriptedFetch([
			jsonResponse({ host: "ghe.corp.net", trusted: false }),
			jsonResponse({ githubTrustedHosts: [] }),
			jsonResponse({ ok: true }),
		]);
		let promptedWith = "";
		const ok = await ensureGithubHostTrusted("ghe.corp.net", {
			fetch,
			confirm: async (_t, _m, label) => { promptedWith = String(label); return true; },
		});
		assert.equal(ok, true);
		assert.equal(promptedWith, "Trust domain");
		assert.deepEqual(putBodyHosts(calls[2]), ["ghe.corp.net"]);
		assert.equal(calls.length, 3);
	});

	it("appends to the existing managed list on the PUT (no clobber)", async () => {
		const { fetch, calls } = scriptedFetch([
			jsonResponse({ trusted: false }),
			jsonResponse({ githubTrustedHosts: ["a.example.com"] }),
			jsonResponse({ ok: true }),
		]);
		const ok = await ensureGithubHostTrusted("b.example.com", { fetch, confirm: async () => true });
		assert.equal(ok, true);
		assert.deepEqual(putBodyHosts(calls[2]), ["a.example.com", "b.example.com"]);
	});

	it("does not persist and returns false on decline", async () => {
		const { fetch, calls } = scriptedFetch([
			jsonResponse({ trusted: false }),
			jsonResponse({ githubTrustedHosts: [] }),
		]);
		const ok = await ensureGithubHostTrusted("ghe.corp.net", { fetch, confirm: async () => false });
		assert.equal(ok, false);
		assert.equal(calls.length, 2, "no PUT after a decline");
	});

	it("aborts (false) when the PUT itself fails", async () => {
		const { fetch, calls } = scriptedFetch([
			jsonResponse({ trusted: false }),
			jsonResponse({ githubTrustedHosts: [] }),
			failedResponse(),
		]);
		const ok = await ensureGithubHostTrusted("ghe.corp.net", { fetch, confirm: async () => true });
		assert.equal(ok, false);
		assert.equal(calls.length, 3);
	});

	it("still prompts when the effective-host lookup throws", async () => {
		const { fetch } = scriptedFetch([
			new Error("offline"),
			jsonResponse({ githubTrustedHosts: [] }),
			jsonResponse({ ok: true }),
		]);
		let prompted = false;
		const ok = await ensureGithubHostTrusted("ghe.corp.net", { fetch, confirm: async () => { prompted = true; return true; } });
		assert.equal(prompted, true);
		assert.equal(ok, true);
	});

	it("still prompts for a malformed successful server decision", async () => {
		const { fetch } = scriptedFetch([
			jsonResponse({ trusted: "yes" }),
			jsonResponse({ githubTrustedHosts: [] }),
		]);
		let prompted = false;
		const ok = await ensureGithubHostTrusted("ghe.corp.net", { fetch, confirm: async () => { prompted = true; return false; } });
		assert.equal(prompted, true);
		assert.equal(ok, false);
	});

	it("returns false for an invalid hostname without any network", async () => {
		const { fetch, calls } = scriptedFetch([]);
		const ok = await ensureGithubHostTrusted("not a host/path", { fetch, confirm: async () => true });
		assert.equal(ok, false);
		assert.equal(calls.length, 0);
	});
});

describe("callSpawnRouteWithTrust", () => {
	const HOST_NOT_TRUSTED: SpawnRouteOutcome = {
		ok: false,
		code: "HOST_NOT_TRUSTED",
		host: "ghe.corp.net",
		prUrl: "https://ghe.corp.net/o/r/pull/7",
	};

	it("re-invokes with trustedHostAck + prUrl on accept and returns the retry result", async () => {
		const routeCalls: Array<{ route: string; init: { method: string; body: Record<string, unknown> } }> = [];
		const outcome = await callSpawnRouteWithTrust({
			route: "run",
			body: { sessionId: "s1" },
			first: HOST_NOT_TRUSTED,
			ensureTrusted: async () => true,
			callRoute: async (route, init) => { routeCalls.push({ route, init }); return { ok: true, childSessionId: "child-1" }; },
		});
		assert.equal(routeCalls.length, 1, "exactly one retry call");
		assert.equal(routeCalls[0].route, "run");
		assert.equal(routeCalls[0].init.method, "POST");
		assert.deepEqual(routeCalls[0].init.body, {
			sessionId: "s1",
			prUrl: "https://ghe.corp.net/o/r/pull/7",
			trustedHostAck: "ghe.corp.net",
		});
		assert.deepEqual(outcome.res, { ok: true, childSessionId: "child-1" });
		assert.equal(outcome.cancelledHost, undefined);
	});

	it("returns cancelledHost and does NOT re-invoke on decline", async () => {
		let called = 0;
		const outcome = await callSpawnRouteWithTrust({
			route: "run",
			body: {},
			first: HOST_NOT_TRUSTED,
			ensureTrusted: async () => false,
			callRoute: async () => { called++; return { ok: true }; },
		});
		assert.equal(called, 0, "no retry after decline");
		assert.equal(outcome.cancelledHost, "ghe.corp.net");
		assert.equal(outcome.res, undefined);
	});

	it("passes a non-HOST_NOT_TRUSTED result through unchanged (no prompt, no retry)", async () => {
		let called = 0;
		let ensured = 0;
		const first: SpawnRouteOutcome = { ok: false, code: "NO_PR", error: "No open GitHub PR" };
		const outcome = await callSpawnRouteWithTrust({
			route: "run",
			body: {},
			first,
			ensureTrusted: async () => { ensured++; return true; },
			callRoute: async () => { called++; return { ok: true }; },
		});
		assert.equal(called, 0);
		assert.equal(ensured, 0);
		assert.deepEqual(outcome.res, first);
		assert.equal(outcome.cancelledHost, undefined);
	});

	it("passes an ok:true result through unchanged", async () => {
		const first: SpawnRouteOutcome = { ok: true, childSessionId: "c9" };
		const outcome = await callSpawnRouteWithTrust({
			route: "run", body: {}, first,
			ensureTrusted: async () => true,
			callRoute: async () => { throw new Error("must not re-invoke"); },
		});
		assert.deepEqual(outcome.res, first);
	});

	it("omits prUrl from the retry body when the run result carried none", async () => {
		const routeCalls: Array<Record<string, unknown>> = [];
		await callSpawnRouteWithTrust({
			route: "run",
			body: { sessionId: "s1" },
			first: { ok: false, code: "HOST_NOT_TRUSTED", host: "ghe.corp.net" },
			ensureTrusted: async () => true,
			callRoute: async (_r, init) => { routeCalls.push(init.body); return { ok: true }; },
		});
		assert.deepEqual(routeCalls[0], { sessionId: "s1", trustedHostAck: "ghe.corp.net" });
		assert.ok(!("prUrl" in routeCalls[0]));
	});
});
