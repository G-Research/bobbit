/**
 * Reproducing test for goal "Production-grade PWA resume" §6.5 + §9.3.
 *
 * Symptom: on iOS, a half-dead socket can keep the SW's `fetch(req)` pending
 * for tens of seconds. The current `public/sw.js` has NO race against a
 * timeout — `event.respondWith(fetch(req).then(...).catch(...))` — so the
 * navigation is held hostage indefinitely before `index.html` ever reaches
 * the parser.
 *
 * Fix: race the network fetch against a 4 s timeout for navigation requests
 * (`req.mode === "navigate"`) and fall back to the cached `/` shell when the
 * timeout fires first.
 *
 * THIS TEST FAILS TODAY — the SW is loaded into a sandboxed `vm` context with
 * a stubbed `fetch` that NEVER resolves. We then dispatch a synthetic
 * navigation `fetch` event and `await` whatever was passed to
 * `event.respondWith(...)` with a 5 s wall-clock deadline. Today the awaited
 * promise never settles, so the test fails with the literal error
 * `sw fetch timeout missing` (deadline reached). After the fix lands the
 * promise resolves to the cached `/` Response within ~4 s and the test
 * passes.
 *
 * Run: `npx tsx --test tests/pwa-sw-fetch-timeout.test.ts`
 *
 * Expected error today (substring): `sw fetch timeout missing`
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const SW_SOURCE = readFileSync(resolve(here, "..", "public", "sw.js"), "utf8");

// Build a minimal SW global scope and load `public/sw.js` into it.
function loadServiceWorker(opts: {
	fetch: (req: any) => Promise<Response>;
	cachedRoot: Response | null;
}) {
	type Listener = (evt: any) => void;
	const listeners: Record<string, Listener[]> = {};

	const cacheStorage = {
		match: async (key: any) => {
			// Honor both Request objects and string URLs by their pathname.
			const path = typeof key === "string"
				? new URL(key, "http://x").pathname
				: new URL((key as any).url ?? "/", "http://x").pathname;
			if (path === "/" && opts.cachedRoot) return opts.cachedRoot;
			return undefined;
		},
		open: async () => ({
			put: async () => {},
			match: async () => undefined,
		}),
		keys: async () => [],
		delete: async () => true,
	};

	const swSelf: any = {
		addEventListener: (name: string, cb: Listener) => {
			(listeners[name] ??= []).push(cb);
		},
		skipWaiting: () => {},
		clients: { claim: async () => {} },
		registration: {},
	};
	swSelf.self = swSelf; // sw uses `self.addEventListener(...)`

	const ctx = vm.createContext({
		self: swSelf,
		caches: cacheStorage,
		fetch: opts.fetch,
		URL,
		Promise,
		Response,
		Request,
		setTimeout,
		clearTimeout,
		console,
	});
	new vm.Script(SW_SOURCE, { filename: "public/sw.js" }).runInContext(ctx);

	return { listeners, swSelf };
}

function dispatchNavFetch(
	listeners: Record<string, ((e: any) => void)[]>,
	url = "https://example.test/",
): Promise<Response> {
	const cbs = listeners["fetch"] ?? [];
	let respPromise: Promise<Response> | null = null;
	const evt: any = {
		request: { url, method: "GET", mode: "navigate" },
		respondWith: (p: Promise<Response>) => { respPromise = p; },
	};
	for (const cb of cbs) cb(evt);
	if (!respPromise) {
		return Promise.reject(new Error("sw did not call event.respondWith — fetch handler not registered"));
	}
	return respPromise;
}

describe("public/sw.js — navigation fetch races a 4 s timeout (reproducing-test)", () => {
	it("never-resolving fetch → cached / served within ~4 s (today: sw fetch timeout missing)", async () => {
		// Stub fetch to NEVER resolve — simulates the iOS half-dead socket.
		const neverFetch = (_req: any): Promise<Response> => new Promise(() => {});

		const cachedRoot = new Response("<!doctype html><body>cached-shell</body>", {
			status: 200,
			headers: { "Content-Type": "text/html" },
		});

		const { listeners } = loadServiceWorker({ fetch: neverFetch, cachedRoot });
		const respPromise = dispatchNavFetch(listeners);

		// Hard deadline: must settle within 5 s. Fix uses 4 s timeout so 5 s
		// gives a comfortable margin without hiding a regression.
		const DEADLINE_MS = 5_000;
		const result = await Promise.race([
			respPromise.then((r) => ({ ok: true as const, r })),
			new Promise<{ ok: false }>((r) => setTimeout(() => r({ ok: false }), DEADLINE_MS)),
		]);

		assert.equal(
			result.ok,
			true,
			`sw fetch timeout missing — navigation respondWith promise did not settle within ${DEADLINE_MS}ms while fetch hung`,
		);
		const resp = (result as { ok: true; r: Response }).r;
		const body = await resp.text();
		assert.match(body, /cached-shell/, "expected cached / shell to be served when fetch times out");
	});

	it("non-navigation requests are NOT held by the timeout (regression guard)", async () => {
		// Asset / api requests that aren't navigations should keep their existing
		// behavior. We just want to be sure adding the timeout to navigations
		// doesn't accidentally swallow other fetches.
		// This test is informational; today it passes either way.
		const fastFetch = async () => new Response("ok", { status: 200 });
		const cachedRoot = null;
		const { listeners } = loadServiceWorker({ fetch: fastFetch, cachedRoot });
		const cbs = listeners["fetch"] ?? [];
		let respPromise: Promise<Response> | null = null;
		const evt: any = {
			request: { url: "https://example.test/foo.png", method: "GET", mode: "no-cors" },
			respondWith: (p: Promise<Response>) => { respPromise = p; },
		};
		for (const cb of cbs) cb(evt);
		if (respPromise) {
			const r = await Promise.race([
				respPromise!,
				new Promise<Response>((_res, rej) => setTimeout(() => rej(new Error("non-nav fetch hung")), 2_000)),
			]);
			assert.equal(r.status, 200);
		}
	});
});
