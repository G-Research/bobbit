/**
 * Unit tests for the Hindsight REST client (EP G2 / external mode).
 *
 * Drives the client against the deterministic in-process stub
 * (tests/e2e/hindsight-stub.mjs) plus a couple of bespoke servers for the
 * transport-error branches (timeout / http-500 / network). Pins the contract in
 * docs/design/hindsight-pack-external.md §3 + §9.1.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { createClient, HindsightError } from "../market-packs/hindsight/src/hindsight-client.ts";
// @ts-expect-error — .mjs stub has no type declarations; shape documented in the file.
import { startHindsightStub } from "./e2e/hindsight-stub.mjs";

interface Stub {
	url: string;
	calls: Array<{
		method: string;
		path: string;
		bank?: string;
		namespace?: string;
		body: any;
		headers: Record<string, string>;
	}>;
	setHealthy(ok: boolean): void;
	seedMemories(bank: string, mem: Array<{ text: string; id?: string; score?: number; tags?: string[] }>): void;
	retained(bank?: string): Array<{ content: string; tags: string[]; async: boolean }>;
	close(): Promise<void>;
}

describe("hindsight-client — round-trips against the stub", () => {
	let stub: Stub;

	before(async () => {
		stub = (await startHindsightStub({})) as Stub;
	});
	after(async () => {
		await stub.close();
	});
	beforeEach(() => {
		stub.calls.length = 0;
	});

	it("health() returns ok:true when healthy, ok:false when not", async () => {
		const client = createClient({ baseUrl: stub.url });
		stub.setHealthy(true);
		assert.deepEqual(await client.health(), { ok: true });
		stub.setHealthy(false);
		assert.deepEqual(await client.health(), { ok: false });
		stub.setHealthy(true);
		const call = stub.calls.find((c) => c.path === "/health");
		assert.equal(call?.method, "GET");
	});

	it("ensureBank() PUTs the bank with an empty body", async () => {
		const client = createClient({ baseUrl: stub.url });
		await client.ensureBank("bobbit");
		const call = stub.calls.at(-1)!;
		assert.equal(call.method, "PUT");
		assert.equal(call.path, "/v1/default/banks/bobbit");
		assert.equal(call.bank, "bobbit");
		assert.deepEqual(call.body, {});
	});

	it("recall() maps results → memories and posts query/tags/tags_match", async () => {
		const client = createClient({ baseUrl: stub.url });
		stub.seedMemories("bobbit", [
			{ text: "alpha", id: "m1", score: 0.9, tags: ["project:p1"] },
			{ text: "beta", id: "m2", tags: ["project:p2"] },
		]);
		const out = await client.recall("bobbit", "what did we do", {
			maxTokens: 800,
			tags: { project: "p1" },
			tagsMatch: "any",
		});
		assert.deepEqual(out.memories, [{ text: "alpha", id: "m1", score: 0.9 }]);
		const call = stub.calls.at(-1)!;
		assert.equal(call.method, "POST");
		assert.equal(call.path, "/v1/default/banks/bobbit/memories/recall");
		assert.equal(call.body.query, "what did we do");
		assert.equal(call.body.max_tokens, 800);
		assert.deepEqual(call.body.tags, ["project:p1"]);
		assert.equal(call.body.tags_match, "any");
	});

	it("recall() omits tags/tags_token when no tags supplied and defaults are absent", async () => {
		const client = createClient({ baseUrl: stub.url });
		stub.seedMemories("bobbit", [{ text: "gamma", id: "m3" }]);
		await client.recall("bobbit", "q");
		const call = stub.calls.at(-1)!;
		assert.equal("tags" in call.body, false);
		assert.equal("tags_match" in call.body, false);
		assert.equal("max_tokens" in call.body, false);
	});

	it("retain() sends item-level tags and async = !sync", async () => {
		const client = createClient({ baseUrl: stub.url });
		await client.retain("bobbit", "remember this", {
			tags: { project: "p1", kind: "turn" },
			sync: false,
		});
		const recAsync = stub.retained("bobbit").at(-1)!;
		assert.equal(recAsync.content, "remember this");
		assert.deepEqual(recAsync.tags.sort(), ["kind:turn", "project:p1"]);
		assert.equal(recAsync.async, true);

		await client.retain("bobbit", "compacted span", { sync: true });
		const recSync = stub.retained("bobbit").at(-1)!;
		assert.equal(recSync.async, false);

		await client.retain("bobbit", "no opts");
		const recDefault = stub.retained("bobbit").at(-1)!;
		assert.equal(recDefault.async, true);

		const call = stub.calls.findLast((c) => c.path === "/v1/default/banks/bobbit/memories")!;
		assert.equal(call.method, "POST");
	});

	it("reflect() posts query and returns text", async () => {
		const client = createClient({ baseUrl: stub.url });
		const out = await client.reflect("bobbit", "summarise the project");
		assert.equal(out.text, "Reflection on: summarise the project");
		const call = stub.calls.at(-1)!;
		assert.equal(call.method, "POST");
		assert.equal(call.path, "/v1/default/banks/bobbit/reflect");
		assert.equal(call.body.query, "summarise the project");
		// No tags ⇒ no tag filter sent (reflect over the whole bank).
		assert.equal(call.body.tags, undefined);
		assert.equal(call.body.tags_match, undefined);
	});

	it("reflect() forwards a scoped tag filter when provided", async () => {
		const client = createClient({ baseUrl: stub.url });
		await client.reflect("bobbit", "what did we decide", { tags: { project: "p1" } });
		const call = stub.calls.at(-1)!;
		assert.equal(call.path, "/v1/default/banks/bobbit/reflect");
		assert.deepEqual(call.body.tags, ["project:p1"]);
		assert.equal(call.body.tags_match, "any");
	});

	it("listBanks() maps bank items → bank ids", async () => {
		const client = createClient({ baseUrl: stub.url });
		await client.ensureBank("bobbit");
		await client.ensureBank("other");
		const out = await client.listBanks();
		assert.ok(out.banks.includes("bobbit"));
		assert.ok(out.banks.includes("other"));
		const call = stub.calls.at(-1)!;
		assert.equal(call.method, "GET");
		assert.equal(call.path, "/v1/default/banks");
	});

	it("recall() with tags_match=all filters to memories having every tag", async () => {
		const client = createClient({ baseUrl: stub.url });
		stub.seedMemories("scoped", [
			{ text: "both", id: "a", tags: ["project:p1", "kind:turn"] },
			{ text: "one", id: "b", tags: ["project:p1"] },
		]);
		const out = await client.recall("scoped", "q", {
			tags: { project: "p1", kind: "turn" },
			tagsMatch: "all",
		});
		assert.deepEqual(
			out.memories.map((m) => m.id),
			["a"],
		);
	});
});

describe("hindsight-client — auth header", () => {
	let stub: Stub;
	before(async () => {
		stub = (await startHindsightStub({})) as Stub;
	});
	after(async () => {
		await stub.close();
	});
	beforeEach(() => {
		stub.calls.length = 0;
	});

	it("sends Authorization: Bearer only when apiKey is set", async () => {
		const withKey = createClient({ baseUrl: stub.url, apiKey: "secret-123" });
		await withKey.ensureBank("bobbit");
		const authedCall = stub.calls.at(-1)!;
		assert.equal(authedCall.headers["authorization"], "Bearer secret-123");

		stub.calls.length = 0;
		const noKey = createClient({ baseUrl: stub.url });
		await noKey.ensureBank("bobbit");
		const plainCall = stub.calls.at(-1)!;
		assert.equal("authorization" in plainCall.headers, false);
	});
});

describe("hindsight-client — namespace path building", () => {
	let stub: Stub;
	before(async () => {
		stub = (await startHindsightStub({})) as Stub;
	});
	after(async () => {
		await stub.close();
	});
	beforeEach(() => {
		stub.calls.length = 0;
	});

	it("defaults the namespace to 'default'", async () => {
		const client = createClient({ baseUrl: stub.url });
		await client.ensureBank("bobbit");
		assert.equal(stub.calls.at(-1)!.path, "/v1/default/banks/bobbit");
	});

	it("uses a custom namespace and URL-encodes bank ids", async () => {
		const client = createClient({ baseUrl: stub.url, namespace: "team-a" });
		await client.ensureBank("bank/with space");
		const call = stub.calls.at(-1)!;
		assert.equal(call.namespace, "team-a");
		assert.equal(call.path, "/v1/team-a/banks/bank%2Fwith%20space");
		assert.equal(call.bank, "bank/with space");
	});

	it("trims a trailing slash from baseUrl", async () => {
		const client = createClient({ baseUrl: `${stub.url}/` });
		await client.ensureBank("bobbit");
		assert.equal(stub.calls.at(-1)!.path, "/v1/default/banks/bobbit");
	});
});

describe("hindsight-client — transport errors", () => {
	it("throws HindsightError{kind:http,status} on non-2xx", async () => {
		const server = http.createServer((_req, res) => {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ detail: "boom" }));
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		const port = (server.address() as AddressInfo).port;
		const client = createClient({ baseUrl: `http://127.0.0.1:${port}` });
		try {
			await assert.rejects(client.recall("bobbit", "q"), (err: unknown) => {
				assert.ok(err instanceof HindsightError);
				assert.equal(err.kind, "http");
				assert.equal(err.status, 500);
				return true;
			});
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
	});

	it("throws HindsightError{kind:timeout} within budget on a slow server", async () => {
		const server = http.createServer((_req, _res) => {
			// Never respond — let the client's AbortController fire.
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		const port = (server.address() as AddressInfo).port;
		const timeoutMs = 150;
		const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs });
		const start = Date.now();
		try {
			await assert.rejects(client.recall("bobbit", "q"), (err: unknown) => {
				assert.ok(err instanceof HindsightError);
				assert.equal(err.kind, "timeout");
				return true;
			});
			const elapsed = Date.now() - start;
			assert.ok(elapsed < timeoutMs + 400, `timeout fired within budget (elapsed=${elapsed}ms)`);
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
			// Drop any lingering keep-alive sockets so the server closes promptly.
			server.closeAllConnections?.();
		}
	});

	it("throws HindsightError{kind:network} when the connection is refused", async () => {
		// Bind then immediately release a port so the address is reachable-but-closed.
		const probe = http.createServer();
		await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
		const port = (probe.address() as AddressInfo).port;
		await new Promise<void>((r) => probe.close(() => r()));
		const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 1000 });
		await assert.rejects(client.recall("bobbit", "q"), (err: unknown) => {
			assert.ok(err instanceof HindsightError);
			assert.equal(err.kind, "network");
			return true;
		});
	});

	it("health() returns ok:false instead of throwing on a refused connection", async () => {
		const probe = http.createServer();
		await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
		const port = (probe.address() as AddressInfo).port;
		await new Promise<void>((r) => probe.close(() => r()));
		const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 1000 });
		assert.deepEqual(await client.health(), { ok: false });
	});
});
