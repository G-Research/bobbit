import { afterAll, beforeAll, describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	COOKIE_FUTURE_SKEW_SECONDS,
	COOKIE_MAX_AGE_SECONDS,
	COOKIE_NAME,
	COOKIE_NONCE_BYTES,
	COOKIE_RENEWAL_WINDOW_SECONDS,
	CookieStore,
	issueIfMissing,
	parseCookies,
	tryAuth,
} from "../../src/server/auth/cookie.ts";
import {
	COOKIE_SIGNING_KEY_FILE,
	loadOrCreateCookieSigningKey,
	type CookieSigningKeyFileSystem,
} from "../../src/server/auth/cookie-signing-key.ts";

const BASE_NOW = 1_800_000_000;
const KEY = Buffer.alloc(32, 0x11);
const OTHER_KEY = Buffer.alloc(32, 0x22);
const NONCE = Buffer.alloc(COOKIE_NONCE_BYTES, 0x33).toString("base64url");
let stateDir: string;

beforeAll(() => {
	stateDir = fs.mkdtempSync(path.join(tmpdir(), "bobbit-cookie-"));
});

afterAll(() => {
	fs.rmSync(stateDir, { recursive: true, force: true });
});

function mutableClock(initialSeconds = BASE_NOW) {
	let seconds = initialSeconds;
	return {
		clock: { now: () => seconds * 1_000 },
		setSeconds(value: number) { seconds = value; },
	};
}

function signRaw(
	key: Buffer,
	issuedAt: string | number,
	expiresAt: string | number,
	nonce = NONCE,
	version = "v1",
): string {
	const payload = `${version}.${issuedAt}.${expiresAt}.${nonce}`;
	const signature = createHmac("sha256", key).update(payload, "ascii").digest("base64url");
	return `${payload}.${signature}`;
}

function fakeReq(cookieHeader?: string): any {
	return { headers: cookieHeader === undefined ? {} : { cookie: cookieHeader } };
}

function fakeRes(initialSetCookie?: string) {
	const headers: Record<string, string | string[]> = {};
	if (initialSetCookie !== undefined) headers["Set-Cookie"] = initialSetCookie;
	return {
		headers,
		setHeader(name: string, value: string | string[]) { headers[name] = value; },
		getHeader(name: string) { return headers[name]; },
	};
}

function cookieValueFromHeader(header: string | string[]): string {
	const serialized = Array.isArray(header) ? header.at(-1)! : header;
	const match = serialized.match(new RegExp(`^${COOKIE_NAME}=([^;]+)`));
	assert.ok(match);
	return match[1];
}

function signingKeyDir(): string {
	return fs.mkdtempSync(path.join(stateDir, "key-"));
}

function errno(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

describe("parseCookies", () => {
	it("parses, decodes, and ignores malformed entries", () => {
		assert.deepEqual(parseCookies(fakeReq()), {});
		assert.deepEqual(parseCookies(fakeReq("foo=bar")), { foo: "bar" });
		assert.deepEqual(parseCookies(fakeReq("a=1; b=hello%20world; malformed")), {
			a: "1",
			b: "hello world",
		});
	});

	it("preserves a value whose percent encoding is malformed", () => {
		assert.deepEqual(parseCookies(fakeReq("bad=%ZZ")), { bad: "%ZZ" });
	});
});

describe("stateless signed cookies", () => {
	it("keeps request-path authentication isolated from filesystem and legacy registry code", () => {
		const source = fs.readFileSync(new URL("../../src/server/auth/cookie.ts", import.meta.url), "utf8");
		assert.doesNotMatch(source, /node:fs|auth-cookies|stateDir|readFile|writeFile|flushNow/);
	});

	it("mints the documented canonical v1 HMAC-SHA-256 format", () => {
		const { clock } = mutableClock();
		const store = new CookieStore(KEY, {
			clock,
			randomBytes: (size) => Buffer.alloc(size, 0x44),
		});
		const value = store.mint();
		const parts = value.split(".");

		assert.equal(parts.length, 5);
		assert.deepEqual(parts.slice(0, 4), [
			"v1",
			String(BASE_NOW),
			String(BASE_NOW + COOKIE_MAX_AGE_SECONDS),
			Buffer.alloc(COOKIE_NONCE_BYTES, 0x44).toString("base64url"),
		]);
		assert.match(parts[3], /^[A-Za-z0-9_-]{22}$/);
		assert.match(parts[4], /^[A-Za-z0-9_-]{43}$/);
		const expected = createHmac("sha256", KEY).update(parts.slice(0, 4).join("."), "ascii").digest("base64url");
		assert.equal(parts[4], expected);
		assert.deepEqual(store.verify(value), {
			issuedAt: BASE_NOW,
			expiresAt: BASE_NOW + COOKIE_MAX_AGE_SECONDS,
			needsRenewal: false,
		});
	});

	it("keeps cookies valid across stores with the same key and rejects a changed key", () => {
		const { clock } = mutableClock();
		const value = new CookieStore(KEY, { clock }).mint();
		assert.ok(new CookieStore(Buffer.from(KEY), { clock }).verify(value));
		assert.equal(new CookieStore(OTHER_KEY, { clock }).verify(value), undefined);
	});

	it("copies and validates the exact 32-byte signing key", () => {
		assert.throws(() => new CookieStore(Buffer.alloc(31)), /exactly 32 bytes/);
		assert.throws(() => new CookieStore(Buffer.alloc(33)), /exactly 32 bytes/);

		const mutableKey = Buffer.from(KEY);
		const { clock } = mutableClock();
		const store = new CookieStore(mutableKey, { clock });
		mutableKey.fill(0xff);
		assert.ok(store.verify(store.mint()));
	});

	it("rejects malformed, unsupported, and non-canonical encodings", () => {
		const { clock } = mutableClock();
		const store = new CookieStore(KEY, { clock });
		const exp = BASE_NOW + COOKIE_MAX_AGE_SECONDS;
		const signature31 = Buffer.alloc(31).toString("base64url");
		const malformed = [
			"",
			"v1.only.two",
			signRaw(KEY, BASE_NOW, exp, NONCE, "v2"),
			signRaw(KEY, `0${BASE_NOW}`, exp),
			signRaw(KEY, `+${BASE_NOW}`, exp),
			signRaw(KEY, ` ${BASE_NOW}`, exp),
			signRaw(KEY, `${BASE_NOW}.0`, exp),
			signRaw(KEY, "1e9", exp),
			signRaw(KEY, "9007199254740992", "9007199254740993"),
			signRaw(KEY, BASE_NOW, exp, `${NONCE}=`),
			signRaw(KEY, BASE_NOW, exp, Buffer.alloc(15).toString("base64url")),
			signRaw(KEY, BASE_NOW, exp, `${NONCE.slice(0, -1)}+`),
			`${signRaw(KEY, BASE_NOW, exp)}.extra`,
			`v1.${BASE_NOW}.${exp}.${NONCE}.${signature31}`,
		];
		for (const value of malformed) assert.equal(store.verify(value), undefined, value);
	});

	it("rejects tampered payloads and signatures", () => {
		const { clock } = mutableClock();
		const store = new CookieStore(KEY, { clock });
		const value = signRaw(KEY, BASE_NOW, BASE_NOW + COOKIE_MAX_AGE_SECONDS);
		const parts = value.split(".");

		const tamperedPayload = [parts[0], String(BASE_NOW + 1), ...parts.slice(2)].join(".");
		const firstSignatureChar = parts[4][0] === "A" ? "B" : "A";
		const tamperedSignature = [...parts.slice(0, 4), firstSignatureChar + parts[4].slice(1)].join(".");
		assert.equal(store.verify(tamperedPayload), undefined);
		assert.equal(store.verify(tamperedSignature), undefined);
	});

	it("enforces the 30-day maximum lifetime", () => {
		const { clock } = mutableClock();
		const store = new CookieStore(KEY, { clock });
		assert.ok(store.verify(signRaw(KEY, BASE_NOW, BASE_NOW + COOKIE_MAX_AGE_SECONDS)));
		assert.equal(store.verify(signRaw(KEY, BASE_NOW, BASE_NOW)), undefined);
		assert.equal(store.verify(signRaw(KEY, BASE_NOW, BASE_NOW - 1)), undefined);
		assert.equal(store.verify(signRaw(KEY, BASE_NOW, BASE_NOW + COOKIE_MAX_AGE_SECONDS + 1)), undefined);
	});

	it("accepts exactly five minutes of positive clock skew and rejects more", () => {
		const { clock } = mutableClock();
		const store = new CookieStore(KEY, { clock });
		const boundary = BASE_NOW + COOKIE_FUTURE_SKEW_SECONDS;
		assert.ok(store.verify(signRaw(KEY, boundary, boundary + COOKIE_MAX_AGE_SECONDS)));
		assert.equal(store.verify(signRaw(KEY, boundary + 1, boundary + 1 + COOKIE_MAX_AGE_SECONDS)), undefined);
	});

	it("rejects at expiry and applies the inclusive seven-day renewal boundary", () => {
		const time = mutableClock();
		const store = new CookieStore(KEY, { clock: time.clock });
		const value = store.mint();
		const expiresAt = BASE_NOW + COOKIE_MAX_AGE_SECONDS;

		time.setSeconds(expiresAt - COOKIE_RENEWAL_WINDOW_SECONDS - 1);
		assert.equal(store.verify(value)?.needsRenewal, false);
		time.setSeconds(expiresAt - COOKIE_RENEWAL_WINDOW_SECONDS);
		assert.equal(store.verify(value)?.needsRenewal, true);
		time.setSeconds(expiresAt - 1);
		assert.equal(store.verify(value)?.needsRenewal, true);
		time.setSeconds(expiresAt);
		assert.equal(store.verify(value), undefined);
	});

	it("keeps tryAuth as a boolean request helper", () => {
		const { clock } = mutableClock();
		const store = new CookieStore(KEY, { clock });
		const value = store.mint();
		assert.equal(tryAuth(fakeReq(), store), false);
		assert.equal(tryAuth(fakeReq(`${COOKIE_NAME}=${"a".repeat(64)}`), store), false);
		assert.equal(tryAuth(fakeReq(`${COOKIE_NAME}=${value}`), store), true);
	});
});

describe("cookie response attributes and renewal", () => {
	it("sets the exact attributes and Secure outside localhost HTTP mode", () => {
		const { clock } = mutableClock();
		const store = new CookieStore(KEY, { clock });
		const response = fakeRes();
		const value = issueIfMissing(fakeReq(), response as any, store, { localhost: false });
		assert.ok(value);
		assert.equal(response.getHeader("Set-Cookie"), [
			`${COOKIE_NAME}=${value}`,
			"HttpOnly",
			"SameSite=Lax",
			"Path=/",
			`Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
			"Secure",
		].join("; "));
	});

	it("omits Secure only in localhost HTTP mode", () => {
		const { clock } = mutableClock();
		const response = fakeRes();
		issueIfMissing(fakeReq(), response as any, new CookieStore(KEY, { clock }), { localhost: true });
		const header = String(response.getHeader("Set-Cookie"));
		assert.doesNotMatch(header, /(?:^|; )Secure(?:;|$)/);
		assert.match(header, /; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
	});

	it("does not reissue a valid cookie before the renewal window", () => {
		const time = mutableClock();
		const store = new CookieStore(KEY, { clock: time.clock });
		const value = store.mint();
		time.setSeconds(BASE_NOW + COOKIE_MAX_AGE_SECONDS - COOKIE_RENEWAL_WINDOW_SECONDS - 1);
		const response = fakeRes();
		assert.equal(issueIfMissing(fakeReq(`${COOKIE_NAME}=${value}`), response as any, store), undefined);
		assert.equal(response.getHeader("Set-Cookie"), undefined);
	});

	it("refreshes exactly at the renewal boundary, then does not reissue", () => {
		const time = mutableClock();
		const store = new CookieStore(KEY, { clock: time.clock });
		const oldValue = store.mint();
		time.setSeconds(BASE_NOW + COOKIE_MAX_AGE_SECONDS - COOKIE_RENEWAL_WINDOW_SECONDS);

		const firstResponse = fakeRes();
		const replacement = issueIfMissing(fakeReq(`${COOKIE_NAME}=${oldValue}`), firstResponse as any, store);
		assert.ok(replacement);
		assert.notEqual(replacement, oldValue);

		const secondResponse = fakeRes();
		assert.equal(issueIfMissing(fakeReq(`${COOKIE_NAME}=${replacement}`), secondResponse as any, store), undefined);
		assert.equal(secondResponse.getHeader("Set-Cookie"), undefined);
	});

	it("replaces invalid and legacy cookies and preserves prior Set-Cookie values", () => {
		const { clock } = mutableClock();
		const response = fakeRes("other=value; Path=/");
		issueIfMissing(
			fakeReq(`${COOKIE_NAME}=${"f".repeat(64)}`),
			response as any,
			new CookieStore(KEY, { clock }),
		);
		const header = response.getHeader("Set-Cookie");
		assert.ok(Array.isArray(header));
		assert.equal(header[0], "other=value; Path=/");
		assert.ok(new CookieStore(KEY, { clock }).verify(cookieValueFromHeader(header)));
	});
});

describe("cookie signing-key lifecycle", () => {
	it("creates one exact 32-byte key and reuses it across restarts", () => {
		const secretsDir = signingKeyDir();
		const first = loadOrCreateCookieSigningKey(secretsDir);
		const second = loadOrCreateCookieSigningKey(secretsDir);
		const keyPath = path.join(secretsDir, COOKIE_SIGNING_KEY_FILE);

		assert.equal(first.length, 32);
		assert.deepEqual(second, first);
		assert.deepEqual(fs.readFileSync(keyPath), first);
		assert.deepEqual(fs.readdirSync(secretsDir), [COOKIE_SIGNING_KEY_FILE]);
		if (process.platform !== "win32") {
			assert.equal(fs.statSync(secretsDir).mode & 0o777, 0o700);
			assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
		}

		const time = mutableClock();
		const cookie = new CookieStore(first, { clock: time.clock }).mint();
		assert.ok(new CookieStore(second, { clock: time.clock }).verify(cookie));
	});

	it("publishes generated material only after complete writes, including partial writeSync calls", () => {
		const secretsDir = signingKeyDir();
		const nativeWriteSync = fs.writeSync.bind(fs);
		const fileSystem = Object.assign(Object.create(fs), {
			writeSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null) {
				return nativeWriteSync(fd, buffer, offset, Math.min(length, 3), position);
			},
		}) as CookieSigningKeyFileSystem;
		const expected = Buffer.alloc(32, 0x5a);
		const key = loadOrCreateCookieSigningKey(secretsDir, {
			fileSystem,
			randomBytes: (size) => size === 32 ? Buffer.from(expected) : randomBytes(size),
		});
		assert.deepEqual(key, expected);
		assert.deepEqual(fs.readdirSync(secretsDir), [COOKIE_SIGNING_KEY_FILE]);
	});

	it("loads the winning complete key when atomic link publication loses an EEXIST race", () => {
		const secretsDir = signingKeyDir();
		const keyPath = path.join(secretsDir, COOKIE_SIGNING_KEY_FILE);
		const winner = Buffer.alloc(32, 0x77);
		const fileSystem = Object.assign(Object.create(fs), {
			linkSync(_source: fs.PathLike, destination: fs.PathLike) {
				fs.writeFileSync(destination, winner, { flag: "wx", mode: 0o600 });
				throw errno("EEXIST");
			},
		}) as CookieSigningKeyFileSystem;

		const loaded = loadOrCreateCookieSigningKey(secretsDir, { fileSystem });
		assert.deepEqual(loaded, winner);
		assert.deepEqual(fs.readFileSync(keyPath), winner);
		assert.deepEqual(fs.readdirSync(secretsDir), [COOKIE_SIGNING_KEY_FILE]);
	});

	it("fails closed for short and long existing key material without changing it", () => {
		for (const length of [0, 31, 33, 1024]) {
			const secretsDir = signingKeyDir();
			const keyPath = path.join(secretsDir, COOKIE_SIGNING_KEY_FILE);
			const original = Buffer.alloc(length, 0x66);
			fs.writeFileSync(keyPath, original);
			assert.throws(() => loadOrCreateCookieSigningKey(secretsDir), /exactly 32 bytes/);
			assert.deepEqual(fs.readFileSync(keyPath), original);
		}
	});

	it("fails closed when existing key material is not a regular file", () => {
		const secretsDir = signingKeyDir();
		fs.mkdirSync(path.join(secretsDir, COOKIE_SIGNING_KEY_FILE));
		assert.throws(() => loadOrCreateCookieSigningKey(secretsDir), /regular file/);
	});

	it("fails closed when an existing key cannot be read", () => {
		const secretsDir = signingKeyDir();
		const keyPath = path.join(secretsDir, COOKIE_SIGNING_KEY_FILE);
		fs.writeFileSync(keyPath, KEY, { mode: 0o600 });
		const nativeReadFileSync = fs.readFileSync.bind(fs);
		const fileSystem = Object.assign(Object.create(fs), {
			readFileSync(target: fs.PathOrFileDescriptor, ...args: any[]) {
				if (path.resolve(String(target)) === path.resolve(keyPath)) throw errno("EACCES");
				return (nativeReadFileSync as any)(target, ...args);
			},
		}) as CookieSigningKeyFileSystem;

		assert.throws(() => loadOrCreateCookieSigningKey(secretsDir, { fileSystem }), /EACCES/);
		assert.deepEqual(fs.readFileSync(keyPath), KEY);
	});

	it("fails when random sources do not return exact Buffer lengths", () => {
		const secretsDir = signingKeyDir();
		expect(() => loadOrCreateCookieSigningKey(secretsDir, {
			randomBytes: (size) => Buffer.alloc(size - 1),
		})).toThrow(/exactly 32 bytes/);
		assert.deepEqual(fs.readdirSync(secretsDir), []);
	});
});
