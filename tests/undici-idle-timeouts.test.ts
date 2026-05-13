/**
 * Unit tests for the undici idle-stream timeout preload.
 *
 * Loads the CommonJS preload via `createRequire` so its side-effects
 * (monkey-patching undici.setGlobalDispatcher) land in a fresh require
 * cache scope. We exercise the exported pure helpers directly; the
 * monkey-patch itself is verified in manual integration.
 *
 * Why this is named *.test.ts (not *.spec.ts as the design doc suggested):
 * `npm run test:unit` runs `tests/*.test.ts` via `node --test`. The
 * `*.spec.ts` files are Playwright/browser tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.resolve(__dirname, "..", "defaults", "agent-preload", "undici-idle-timeouts.cjs");

const req = createRequire(import.meta.url);
const mod = req(PRELOAD) as {
	isLocalOrigin(s: string): boolean;
	isTrustedNoTimeout(s: string): boolean;
	IdleTimeoutDispatcher: new (inner: any, bodyMs: number, headersMs: number) => any;
	wrapWithIdleTimeouts(d: any): any;
	_bodyMs: number;
	_headersMs: number;
};

describe("isLocalOrigin", () => {
	const LOCAL = [
		"http://localhost:1111",
		"http://127.0.0.1:8080",
		"http://[::1]/",
		"http://10.0.0.5",
		"http://192.168.1.20",
		"http://172.20.0.5",
		"http://100.100.1.1",
		"http://printer.local",
		"http://[fc00::1]/",
		"http://service.localhost",
		"http://0.0.0.0:8000",
		"http://[fd12:3456:789a::1]/",
	];

	const REMOTE = [
		"https://api.anthropic.com",
		"https://api.openai.com",
		"https://ai-gateway.c3.zone",
		"https://bedrock-runtime.us-east-1.amazonaws.com",
		"https://gateway.ai.cloudflare.com",
		"https://aigw.example.com",
		"https://172.32.0.5", // outside 172.16/12
		"https://11.0.0.1",
		"https://192.169.0.1",
		"https://100.63.0.1", // just below Tailscale CGNAT
		"https://100.128.0.1", // just above Tailscale CGNAT
	];

	for (const o of LOCAL) {
		it(`treats ${o} as local`, () => {
			assert.equal(mod.isLocalOrigin(o), true);
		});
	}
	for (const o of REMOTE) {
		it(`treats ${o} as remote`, () => {
			assert.equal(mod.isLocalOrigin(o), false);
		});
	}

	it("returns false for unparsable origin strings", () => {
		assert.equal(mod.isLocalOrigin("not a url"), false);
		assert.equal(mod.isLocalOrigin(""), false);
	});
});

describe("isTrustedNoTimeout", () => {
	const SAVED = process.env.BOBBIT_TRUSTED_NO_TIMEOUT_ORIGINS;

	function withEnv(value: string | undefined, fn: () => void) {
		if (value === undefined) delete process.env.BOBBIT_TRUSTED_NO_TIMEOUT_ORIGINS;
		else process.env.BOBBIT_TRUSTED_NO_TIMEOUT_ORIGINS = value;
		try { fn(); } finally {
			if (SAVED === undefined) delete process.env.BOBBIT_TRUSTED_NO_TIMEOUT_ORIGINS;
			else process.env.BOBBIT_TRUSTED_NO_TIMEOUT_ORIGINS = SAVED;
		}
	}

	it("empty env matches nothing", () => {
		withEnv("", () => {
			assert.equal(mod.isTrustedNoTimeout("https://api.anthropic.com"), false);
			assert.equal(mod.isTrustedNoTimeout("https://aigw.example.com"), false);
		});
	});

	it("unset env matches nothing", () => {
		withEnv(undefined, () => {
			assert.equal(mod.isTrustedNoTimeout("https://aigw.example.com"), false);
		});
	});

	it("exact-origin match (case-insensitive)", () => {
		withEnv("https://aigw.example.com", () => {
			assert.equal(mod.isTrustedNoTimeout("https://aigw.example.com"), true);
			assert.equal(mod.isTrustedNoTimeout("https://AIGW.example.com"), true);
			assert.equal(mod.isTrustedNoTimeout("HTTPS://aigw.example.com/"), true);
			assert.equal(mod.isTrustedNoTimeout("https://other.com"), false);
		});
	});

	it("multiple comma-separated origins", () => {
		withEnv(" https://a.example.com , https://b.example.com ", () => {
			assert.equal(mod.isTrustedNoTimeout("https://a.example.com"), true);
			assert.equal(mod.isTrustedNoTimeout("https://b.example.com"), true);
			assert.equal(mod.isTrustedNoTimeout("https://c.example.com"), false);
		});
	});

	it("ignores port mismatches (origin includes port)", () => {
		withEnv("https://aigw.example.com:8443", () => {
			assert.equal(mod.isTrustedNoTimeout("https://aigw.example.com:8443"), true);
			assert.equal(mod.isTrustedNoTimeout("https://aigw.example.com"), false);
		});
	});

	it("ignores malformed entries", () => {
		withEnv("not a url, https://ok.example.com", () => {
			assert.equal(mod.isTrustedNoTimeout("https://ok.example.com"), true);
		});
	});
});

describe("IdleTimeoutDispatcher.dispatch", () => {
	function makeInner() {
		const calls: Array<{ opts: any; handler: any }> = [];
		const inner = {
			dispatch(opts: any, handler: any) {
				calls.push({ opts, handler });
				return true;
			},
			close() { return Promise.resolve(); },
			destroy() { return Promise.resolve(); },
		};
		return { inner, calls };
	}

	it("injects bodyTimeout/headersTimeout for remote origin", () => {
		const { inner, calls } = makeInner();
		const d = new mod.IdleTimeoutDispatcher(inner, 120_000, 60_000);
		d.dispatch({ origin: "https://api.anthropic.com", path: "/v1" }, {});
		assert.equal(calls.length, 1);
		assert.equal(calls[0].opts.bodyTimeout, 120_000);
		assert.equal(calls[0].opts.headersTimeout, 60_000);
	});

	it("does not inject for localhost", () => {
		const { inner, calls } = makeInner();
		const d = new mod.IdleTimeoutDispatcher(inner, 120_000, 60_000);
		d.dispatch({ origin: "http://localhost:8080", path: "/v1", bodyTimeout: 0 }, {});
		assert.equal(calls.length, 1);
		assert.equal(calls[0].opts.bodyTimeout, 0);
		assert.equal(calls[0].opts.headersTimeout, undefined);
	});

	it("does not inject for RFC1918 IPv4 origin", () => {
		const { inner, calls } = makeInner();
		const d = new mod.IdleTimeoutDispatcher(inner, 120_000, 60_000);
		d.dispatch({ origin: "http://10.0.0.5:11434", path: "/" }, {});
		assert.equal(calls[0].opts.bodyTimeout, undefined);
		assert.equal(calls[0].opts.headersTimeout, undefined);
	});

	it("does not inject when origin is in BOBBIT_TRUSTED_NO_TIMEOUT_ORIGINS", () => {
		const SAVED = process.env.BOBBIT_TRUSTED_NO_TIMEOUT_ORIGINS;
		process.env.BOBBIT_TRUSTED_NO_TIMEOUT_ORIGINS = "https://aigw.example.com";
		try {
			const { inner, calls } = makeInner();
			const d = new mod.IdleTimeoutDispatcher(inner, 120_000, 60_000);
			d.dispatch({ origin: "https://aigw.example.com", path: "/v1" }, {});
			assert.equal(calls[0].opts.bodyTimeout, undefined);
			assert.equal(calls[0].opts.headersTimeout, undefined);
		} finally {
			if (SAVED === undefined) delete process.env.BOBBIT_TRUSTED_NO_TIMEOUT_ORIGINS;
			else process.env.BOBBIT_TRUSTED_NO_TIMEOUT_ORIGINS = SAVED;
		}
	});

	it("preserves a caller-supplied positive bodyTimeout", () => {
		const { inner, calls } = makeInner();
		const d = new mod.IdleTimeoutDispatcher(inner, 120_000, 60_000);
		d.dispatch({ origin: "https://api.openai.com", bodyTimeout: 5000, headersTimeout: 3000 }, {});
		assert.equal(calls[0].opts.bodyTimeout, 5000);
		assert.equal(calls[0].opts.headersTimeout, 3000);
	});

	it("forwards opts unchanged when origin is missing", () => {
		const { inner, calls } = makeInner();
		const d = new mod.IdleTimeoutDispatcher(inner, 120_000, 60_000);
		d.dispatch({ path: "/v1" }, {});
		assert.equal(calls[0].opts.bodyTimeout, undefined);
	});

	it("close()/destroy() forward to inner", async () => {
		let closed = 0, destroyed = 0;
		const inner = {
			dispatch() { return true; },
			close() { closed++; return Promise.resolve(); },
			destroy() { destroyed++; return Promise.resolve(); },
		};
		const d = new mod.IdleTimeoutDispatcher(inner, 1, 1);
		await d.close();
		await d.destroy();
		assert.equal(closed, 1);
		assert.equal(destroyed, 1);
	});
});

describe("wrapWithIdleTimeouts", () => {
	it("wraps a plain dispatcher exactly once", () => {
		const inner = { dispatch() { return true; } };
		const w1 = mod.wrapWithIdleTimeouts(inner);
		const w2 = mod.wrapWithIdleTimeouts(w1);
		assert.ok(w1 instanceof mod.IdleTimeoutDispatcher);
		assert.equal(w1, w2);
	});

	it("returns falsy inputs unchanged", () => {
		assert.equal(mod.wrapWithIdleTimeouts(null), null);
		assert.equal(mod.wrapWithIdleTimeouts(undefined), undefined);
	});
});
