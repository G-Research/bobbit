import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

import { CookieStore, issueCookie } from "../../src/server/auth/cookie.ts";

function fakeResponse() {
	const headers: Record<string, string | string[]> = {};
	return {
		headers,
		getHeader(name: string) { return headers[name]; },
		setHeader(name: string, value: string | string[]) { headers[name] = value; },
	};
}

function serializedCookie(response: ReturnType<typeof fakeResponse>): string {
	const value = response.headers["Set-Cookie"];
	assert.ok(value, "expected Set-Cookie");
	return Array.isArray(value) ? value.at(-1)! : value;
}

describe("mount-scoped signed browser cookies", () => {
	it("uses root Path in root mode and a trailing-slash mount Path otherwise", () => {
		const store = new CookieStore(Buffer.alloc(32, 0x31));
		const rootResponse = fakeResponse();
		issueCookie(rootResponse as any, store, { localhost: true, basePath: "" });
		assert.match(serializedCookie(rootResponse), /(?:^|; )Path=\/(?:;|$)/);

		const mountedResponse = fakeResponse();
		issueCookie(mountedResponse as any, store, { localhost: true, basePath: "/team/bobbit" });
		assert.match(serializedCookie(mountedResponse), /(?:^|; )Path=\/team\/bobbit\/(?:;|$)/);
		assert.doesNotMatch(serializedCookie(mountedResponse), /; Path=\/(?:;|$)/);
	});
});

describe("service worker mount contracts", () => {
	const worker = fs.readFileSync(path.resolve("public/sw.js"), "utf8");
	const main = fs.readFileSync(path.resolve("src/app/main.ts"), "utf8");

	it("derives its mount from the worker script and re-anchors precache entries", () => {
		assert.match(worker, /const SW_PATH = self\.location\.pathname/);
		assert.match(worker, /const BASE_PATH = SW_PATH\.endsWith\("\/sw\.js"\)/);
		assert.match(worker, /MOUNTED_PRECACHE_ROUTE_CHUNKS = PRECACHE_ROUTE_CHUNKS\.map/);
		assert.match(worker, /`\$\{BASE_PATH\}\$\{pathname\.startsWith\("\/"\)/);
	});

	it("uses mount-relative API and WebSocket bypasses plus a mounted offline fallback", () => {
		assert.match(worker, /const relativePathname = mountRelativePath\(url\)/);
		assert.match(worker, /isGatewayTransport\(relativePathname\)/);
		assert.match(worker, /pathname\.startsWith\("\/api\/"\)/);
		assert.match(worker, /pathname\.startsWith\("\/ws\/"\)/);
		assert.match(worker, /const OFFLINE_NAVIGATION_URL = `\$\{BASE_PATH\}\/`/);
		assert.match(worker, /cache\.match\(OFFLINE_NAVIGATION_URL\)/);
	});

	it("registers the worker below the runtime mount only outside Vite dev mode", () => {
		assert.match(main, /const scopePath = `\$\{runtimeBasePath\(\)\}\/`/);
		assert.match(main, /if \(\(globalThis as any\)\.__BOBBIT_DEV__\)/);
		assert.match(main, /serviceWorker\.register\(appUrl\('\/sw\.js'\), \{ scope: scopePath \}\)/);
	});

	it("unregisters the exact mounted worker and clears only its caches in dev", () => {
		assert.match(main, /navigator\.serviceWorker\.getRegistrations\(\)/);
		assert.match(main, /registration\.scope === scopeUrl/);
		assert.match(main, /registration\.unregister\(\)/);
		assert.match(main, /key\.startsWith\(cachePrefix\)/);
	});
});
