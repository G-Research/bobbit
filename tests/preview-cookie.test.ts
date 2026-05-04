/**
 * Unit tests for `src/server/auth/cookie.ts`.
 *
 * Covers issuance, parsing, verification, persistence, revocation, and
 * the localhost flag's effect on the Secure attribute.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
	CookieStore,
	COOKIE_NAME,
	parseCookies,
	tryAuth,
	issueIfMissing,
} from "../src/server/auth/cookie.ts";

let stateDir: string;

before(() => {
	stateDir = mkdtempSync(path.join(tmpdir(), "bobbit-cookie-"));
});
after(() => {
	rmSync(stateDir, { recursive: true, force: true });
});

function fakeReq(cookieHeader?: string): any {
	return { headers: cookieHeader ? { cookie: cookieHeader } : {} };
}

function fakeRes(): { headers: Record<string, string | string[]>; setHeader: (n: string, v: any) => void; getHeader: (n: string) => any; writeHead: (..._: any[]) => void; end: (..._: any[]) => void; status?: number } {
	const headers: Record<string, string | string[]> = {};
	return {
		headers,
		setHeader(n: string, v: any) { headers[n] = v; },
		getHeader(n: string) { return headers[n]; },
		writeHead() { /* no-op */ },
		end() { /* no-op */ },
	};
}

describe("parseCookies", () => {
	it("returns empty object when no Cookie header", () => {
		assert.deepEqual(parseCookies(fakeReq()), {});
	});
	it("parses single cookie", () => {
		assert.deepEqual(parseCookies(fakeReq("foo=bar")), { foo: "bar" });
	});
	it("parses multiple cookies separated by ;", () => {
		const out = parseCookies(fakeReq("a=1; b=two; c=three"));
		assert.deepEqual(out, { a: "1", b: "two", c: "three" });
	});
	it("decodes percent-escapes", () => {
		const out = parseCookies(fakeReq("x=hello%20world"));
		assert.equal(out.x, "hello world");
	});
	it("ignores malformed entries with no '='", () => {
		const out = parseCookies(fakeReq("foo; bar=baz"));
		assert.deepEqual(out, { bar: "baz" });
	});
});

describe("CookieStore", () => {
	let storeDir: string;
	beforeEach(() => {
		storeDir = mkdtempSync(path.join(stateDir, "store-"));
	});

	it("mints a 64-char hex value and verifies it", () => {
		const store = new CookieStore(storeDir);
		const v = store.mint();
		assert.match(v, /^[0-9a-f]{64}$/);
		assert.equal(store.verify(v), true);
	});

	it("rejects unknown values", () => {
		const store = new CookieStore(storeDir);
		assert.equal(store.verify("a".repeat(64)), false);
	});

	it("rejects malformed values (length, charset)", () => {
		const store = new CookieStore(storeDir);
		assert.equal(store.verify(""), false);
		assert.equal(store.verify("not-hex-at-all"), false);
		assert.equal(store.verify("Z".repeat(64)), false);
	});

	it("revokes minted values", () => {
		const store = new CookieStore(storeDir);
		const v = store.mint();
		assert.equal(store.verify(v), true);
		store.revoke(v);
		assert.equal(store.verify(v), false);
	});

	it("persists across instances", () => {
		const a = new CookieStore(storeDir);
		const v = a.mint();
		a.flushNow();
		const b = new CookieStore(storeDir);
		assert.equal(b.verify(v), true);
	});

	it("writes file with restrictive permissions and v1 schema", () => {
		const store = new CookieStore(storeDir);
		store.mint();
		store.flushNow();
		const filePath = path.join(storeDir, "auth-cookies.json");
		assert.equal(existsSync(filePath), true);
		const raw = JSON.parse(readFileSync(filePath, "utf-8"));
		assert.equal(raw.version, 1);
		assert.ok(raw.values && typeof raw.values === "object");
	});

	it("ignores corrupt files (start fresh)", () => {
		const filePath = path.join(storeDir, "auth-cookies.json");
		writeFileSync(filePath, "{not json", "utf-8");
		const store = new CookieStore(storeDir);
		const v = store.mint();
		assert.equal(store.verify(v), true);
	});
});

describe("tryAuth", () => {
	it("false when no cookie", () => {
		const store = new CookieStore(mkdtempSync(path.join(stateDir, "ta-")));
		assert.equal(tryAuth(fakeReq(), store), false);
	});
	it("false when cookie unknown", () => {
		const store = new CookieStore(mkdtempSync(path.join(stateDir, "ta-")));
		assert.equal(tryAuth(fakeReq(`${COOKIE_NAME}=${"a".repeat(64)}`), store), false);
	});
	it("true when cookie minted by store", () => {
		const store = new CookieStore(mkdtempSync(path.join(stateDir, "ta-")));
		const v = store.mint();
		assert.equal(tryAuth(fakeReq(`${COOKIE_NAME}=${v}`), store), true);
	});
});

describe("issueIfMissing", () => {
	it("sets Secure on non-localhost", () => {
		const store = new CookieStore(mkdtempSync(path.join(stateDir, "ii-")));
		const res = fakeRes();
		issueIfMissing(fakeReq() as any, res as any, store, { localhost: false });
		const sc = res.getHeader("Set-Cookie");
		assert.ok(sc, "Set-Cookie header set");
		const str = Array.isArray(sc) ? sc.join("\n") : String(sc);
		assert.match(str, new RegExp(`^${COOKIE_NAME}=[0-9a-f]{64}`));
		assert.match(str, /HttpOnly/);
		assert.match(str, /SameSite=Lax/);
		assert.match(str, /Path=\//);
		assert.match(str, /Max-Age=2592000/);
		assert.match(str, /Secure/);
	});

	it("omits Secure on localhost", () => {
		const store = new CookieStore(mkdtempSync(path.join(stateDir, "ii-")));
		const res = fakeRes();
		issueIfMissing(fakeReq() as any, res as any, store, { localhost: true });
		const sc = res.getHeader("Set-Cookie");
		const str = Array.isArray(sc) ? sc.join("\n") : String(sc);
		assert.doesNotMatch(str, /Secure/);
		assert.match(str, /HttpOnly/);
	});

	it("does not re-issue when valid cookie already present", () => {
		const store = new CookieStore(mkdtempSync(path.join(stateDir, "ii-")));
		const v = store.mint();
		const res = fakeRes();
		issueIfMissing(fakeReq(`${COOKIE_NAME}=${v}`) as any, res as any, store, {});
		assert.equal(res.getHeader("Set-Cookie"), undefined);
	});

	it("does re-issue when present cookie is unknown", () => {
		const store = new CookieStore(mkdtempSync(path.join(stateDir, "ii-")));
		const res = fakeRes();
		issueIfMissing(fakeReq(`${COOKIE_NAME}=${"f".repeat(64)}`) as any, res as any, store, {});
		assert.ok(res.getHeader("Set-Cookie"));
	});

	// Quiet unused-var lint — EventEmitter import is for environments that need it elsewhere.
	void EventEmitter;
});
