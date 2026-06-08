/**
 * Unit tests for the SERVER Host API handed to action handlers as `ctx.host`
 * (src/server/extension-host/server-host-api.ts) — design
 * docs/design/extension-host.md §4c / §5.1.
 *
 * Pinned invariants:
 *   - gateway.fetch injects the admin bearer + the bound x-bobbit-session-id
 *     header and audits the call (the security/audit boundary, §5 vi).
 *   - gateway.fetch rejects non-gateway-relative paths (no absolute URLs).
 *   - Phase-2 namespaces (session/store) throw a loud "reserved for Phase 2".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	createServerHostApi,
	resolveTrustedGatewayBaseUrl,
	type ServerHostAuditEvent,
} from "../src/server/extension-host/server-host-api.ts";

describe("createServerHostApi — gateway.fetch", () => {
	it("injects the bearer + session header and audits a successful call", async () => {
		const calls: Array<{ url: string; headers: Headers }> = [];
		const audits: ServerHostAuditEvent[] = [];
		const host = createServerHostApi({
			sessionId: "sess-1",
			gatewayBaseUrl: "https://127.0.0.1:3001/",
			authToken: "secret-token",
			audit: (e) => audits.push(e),
			fetchImpl: (async (input: any, init: any) => {
				calls.push({ url: String(input), headers: new Headers(init?.headers) });
				return new Response("ok", { status: 200 });
			}) as unknown as typeof fetch,
		});

		const resp = await host.gateway.fetch("/api/goals/123", { method: "GET" });
		assert.equal(resp.status, 200);
		assert.equal(calls.length, 1);
		// Base URL trailing slash is normalized; path is appended verbatim.
		assert.equal(calls[0].url, "https://127.0.0.1:3001/api/goals/123");
		assert.equal(calls[0].headers.get("authorization"), "Bearer secret-token");
		assert.equal(calls[0].headers.get("x-bobbit-session-id"), "sess-1");
		assert.equal(audits.length, 1);
		assert.deepEqual(
			{ kind: audits[0].kind, sessionId: audits[0].sessionId, method: audits[0].method, path: audits[0].path, status: audits[0].status },
			{ kind: "gateway.fetch", sessionId: "sess-1", method: "GET", path: "/api/goals/123", status: 200 },
		);
	});

	it("rejects an absolute URL / non-relative path", async () => {
		const host = createServerHostApi({ sessionId: "s", gatewayBaseUrl: "https://x", authToken: "t", fetchImpl: (async () => new Response()) as unknown as typeof fetch });
		await assert.rejects(() => host.gateway.fetch("https://evil.example/api"), /gateway-relative path/);
		await assert.rejects(() => host.gateway.fetch("api/no-leading-slash"), /gateway-relative path/);
	});

	it("audits a failed fetch and rethrows", async () => {
		const audits: ServerHostAuditEvent[] = [];
		const host = createServerHostApi({
			sessionId: "sess-2",
			gatewayBaseUrl: "https://127.0.0.1:3001",
			authToken: "t",
			audit: (e) => audits.push(e),
			fetchImpl: (async () => { throw new Error("network down"); }) as unknown as typeof fetch,
		});
		await assert.rejects(() => host.gateway.fetch("/api/x"), /network down/);
		assert.equal(audits.length, 1);
		assert.equal(audits[0].error, "network down");
	});
});

describe("resolveTrustedGatewayBaseUrl — derives the base from the bound socket, NOT headers (token-leak fix)", () => {
	it("uses the trusted socket localAddress + localPort over plaintext", () => {
		assert.equal(
			resolveTrustedGatewayBaseUrl({ localAddress: "127.0.0.1", localPort: 3001, encrypted: false }),
			"http://127.0.0.1:3001",
		);
	});

	it("uses https when the socket is TLS-encrypted", () => {
		assert.equal(
			resolveTrustedGatewayBaseUrl({ localAddress: "127.0.0.1", localPort: 3001, encrypted: true }),
			"https://127.0.0.1:3001",
		);
	});

	it("bracket-wraps an IPv6 loopback literal", () => {
		assert.equal(
			resolveTrustedGatewayBaseUrl({ localAddress: "::1", localPort: 3001, encrypted: true }),
			"https://[::1]:3001",
		);
	});

	it("falls back to loopback when the socket address is unavailable", () => {
		assert.equal(resolveTrustedGatewayBaseUrl(undefined), "http://127.0.0.1");
		assert.equal(resolveTrustedGatewayBaseUrl({}), "http://127.0.0.1");
	});

	it("ignores a forged Host header entirely — the function never reads headers", async () => {
		// Regression for the admin-token exfiltration: the endpoint must build the
		// gateway base from the bound socket, so an attacker-controlled
		// `Host: attacker.example` can NEVER redirect host.gateway.fetch (which
		// injects the admin bearer) off-box. Mirror the endpoint flow: derive the
		// base from a socket while a forged header is present, build the host API,
		// and assert the bearer is sent to the trusted origin, never attacker.example.
		const forgedReq = {
			headers: { host: "attacker.example" },
			socket: { localAddress: "127.0.0.1", localPort: 3001, encrypted: true },
		};
		const gatewayBaseUrl = resolveTrustedGatewayBaseUrl(forgedReq.socket);
		assert.equal(gatewayBaseUrl, "https://127.0.0.1:3001");
		assert.ok(!gatewayBaseUrl.includes("attacker.example"));

		const calls: Array<{ url: string; auth: string | null }> = [];
		const host = createServerHostApi({
			sessionId: "sess-1",
			gatewayBaseUrl,
			authToken: "admin-secret",
			fetchImpl: (async (input: any, init: any) => {
				calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
				return new Response("ok", { status: 200 });
			}) as unknown as typeof fetch,
		});
		await host.gateway.fetch("/api/goals/123");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, "https://127.0.0.1:3001/api/goals/123");
		assert.ok(!calls[0].url.includes("attacker.example"), "bearer must never be sent to the forged host");
		assert.equal(calls[0].auth, "Bearer admin-secret");
	});
});

describe("createServerHostApi — Phase-2 namespaces are frozen-not-implemented", () => {
	const host = createServerHostApi({ sessionId: "s", gatewayBaseUrl: "https://x", authToken: "t" });

	it("store.* throws 'reserved for Phase 2'", () => {
		assert.throws(() => host.store.get("k"), /reserved for Phase 2/);
		assert.throws(() => host.store.put("k", 1), /reserved for Phase 2/);
		assert.throws(() => host.store.list(), /reserved for Phase 2/);
	});

	it("session.* throws 'reserved for Phase 2'", () => {
		assert.throws(() => host.session.readTranscript(), /reserved for Phase 2/);
		assert.throws(() => host.session.readToolCall("tu"), /reserved for Phase 2/);
		assert.throws(() => host.session.postMessage({}), /reserved for Phase 2/);
	});

	it("exposes a frozen version", () => {
		assert.equal(typeof host.version, "number");
	});
});
