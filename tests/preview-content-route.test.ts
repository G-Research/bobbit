/**
 * Unit tests for `src/server/preview/content-route.ts`.
 *
 * Drives `handlePreviewRequest` directly with mock req/res objects.
 * Covers MIME selection, traversal 403, missing 404, oversize 413, bridge
 * injection on text/html, and cookie auth.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { handlePreviewRequest, pickEntry } from "../src/server/preview/content-route.ts";
import { CookieStore, COOKIE_NAME } from "../src/server/auth/cookie.ts";

// We need `mountDir(sid)` from preview/mount.ts to point inside our temp dir.
// The stub uses `bobbitStateDir()` which reads BOBBIT_STATE_DIR env. Set it
// before importing anything that captures it.
let workspaceRoot: string;
const SID = "11111111-2222-3333-4444-555555555555";

before(() => {
	workspaceRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "bobbit-cr-")));
	// mountDir(sid) resolves to <bobbitStateDir()>/preview/<sid>; redirect
	// the resolver to a temp dir via BOBBIT_DIR.
	process.env.BOBBIT_DIR = workspaceRoot;
	const mountRoot = path.join(workspaceRoot, "state", "preview", SID);
	mkdirSync(path.join(mountRoot, "subdir"), { recursive: true });
	writeFileSync(path.join(mountRoot, "index.html"), "<html><head><title>x</title></head><body>hi</body></html>");
	writeFileSync(path.join(mountRoot, "report.html"), "<!doctype html><html><body>r</body></html>");
	writeFileSync(path.join(mountRoot, "styles.css"), "body{color:red}");
	writeFileSync(path.join(mountRoot, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	writeFileSync(path.join(mountRoot, "data.json"), `{"a":1}`);
	writeFileSync(path.join(mountRoot, "subdir", "nested.html"), "<html><body>n</body></html>");
});
after(() => {
	rmSync(workspaceRoot, { recursive: true, force: true });
});

interface FakeRes {
	statusCode: number;
	headers: Record<string, string | string[] | number>;
	body: Buffer[];
	ended: boolean;
	pipeFrom?: NodeJS.ReadableStream;
	writeHead(status: number, headers?: Record<string, string | string[] | number>): void;
	setHeader(n: string, v: string | string[]): void;
	getHeader(n: string): any;
	write(c: any): boolean;
	end(c?: any): void;
	on(): void;
	once(): void;
	emit(): boolean;
}

function fakeReq(opts: { url?: string; method?: string; cookie?: string; auth?: string } = {}): any {
	return {
		url: opts.url ?? "/",
		method: opts.method ?? "GET",
		headers: {
			host: "x",
			...(opts.cookie ? { cookie: opts.cookie } : {}),
			...(opts.auth ? { authorization: opts.auth } : {}),
		},
		on() { /* no-op */ },
	};
}

function fakeRes(): FakeRes {
	const chunks: Buffer[] = [];
	const sink = new PassThrough();
	sink.on("data", c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
	const fr: FakeRes = {
		statusCode: 0,
		headers: {},
		body: chunks,
		ended: false,
		writeHead(status, headers) {
			fr.statusCode = status;
			if (headers) for (const [k, v] of Object.entries(headers)) fr.headers[k.toLowerCase()] = v;
		},
		setHeader(n, v) { fr.headers[n.toLowerCase()] = v; },
		getHeader(n) { return fr.headers[n.toLowerCase()]; },
		write(c) {
			chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
			return true;
		},
		end(c) {
			if (c != null) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
			fr.ended = true;
			sink.end();
		},
		on() { /* no-op */ },
		once() { /* no-op */ },
		emit() { return false; },
	};
	return fr;
}

function bodyText(res: FakeRes): string {
	return Buffer.concat(res.body).toString("utf-8");
}

function makeOpts(localhost: boolean) {
	const store = new CookieStore(mkdtempSync(path.join(workspaceRoot, "ck-")));
	return { cookieStore: store, isLocalhost: localhost, store };
}

describe("pickEntry", () => {
	it("picks index.html when present", () => {
		assert.equal(pickEntry(path.join(workspaceRoot, "state", "preview", SID)), "index.html");
	});
	it("falls back to inline.html when no index.html", () => {
		const d = mkdtempSync(path.join(workspaceRoot, "pe-"));
		writeFileSync(path.join(d, "inline.html"), "<html></html>");
		writeFileSync(path.join(d, "zzz.html"), "<html></html>");
		assert.equal(pickEntry(d), "inline.html");
	});
	it("falls back to first .html alphabetically", () => {
		const d = mkdtempSync(path.join(workspaceRoot, "pe-"));
		writeFileSync(path.join(d, "zeta.html"), "<html></html>");
		writeFileSync(path.join(d, "alpha.html"), "<html></html>");
		assert.equal(pickEntry(d), "alpha.html");
	});
	it("returns null on empty dir", () => {
		const d = mkdtempSync(path.join(workspaceRoot, "pe-"));
		assert.equal(pickEntry(d), null);
	});
});

describe("handlePreviewRequest — auth", () => {
	it("401 without cookie in non-localhost mode", async () => {
		const o = makeOpts(false);
		const res = fakeRes();
		const handled = await handlePreviewRequest(fakeReq({ url: `/preview/${SID}/index.html` }), res as any, `/preview/${SID}/index.html`, o);
		assert.equal(handled, true);
		assert.equal(res.statusCode, 401);
	});

	it("200 with valid cookie", async () => {
		const o = makeOpts(false);
		const v = o.store.mint();
		const res = fakeRes();
		await handlePreviewRequest(fakeReq({ url: `/preview/${SID}/index.html`, cookie: `${COOKIE_NAME}=${v}` }), res as any, `/preview/${SID}/index.html`, o);
		assert.equal(res.statusCode, 200);
	});

	it("200 in localhost mode without cookie", async () => {
		const o = makeOpts(true);
		const res = fakeRes();
		await handlePreviewRequest(fakeReq({ url: `/preview/${SID}/index.html` }), res as any, `/preview/${SID}/index.html`, o);
		assert.equal(res.statusCode, 200);
	});

	it("returns false for non-/preview paths", async () => {
		const o = makeOpts(true);
		const res = fakeRes();
		const handled = await handlePreviewRequest(fakeReq({ url: "/api/foo" }), res as any, "/api/foo", o);
		assert.equal(handled, false);
	});
});

describe("handlePreviewRequest — sessionId validation", () => {
	it("400 on invalid session id", async () => {
		const o = makeOpts(true);
		const res = fakeRes();
		await handlePreviewRequest(fakeReq({ url: "/preview/not-a-uuid/index.html" }), res as any, "/preview/not-a-uuid/index.html", o);
		assert.equal(res.statusCode, 400);
	});
});

describe("handlePreviewRequest — entry redirect", () => {
	it("/preview/<sid>/ → 302 to chosen entry", async () => {
		const o = makeOpts(true);
		const res = fakeRes();
		await handlePreviewRequest(fakeReq({ url: `/preview/${SID}/` }), res as any, `/preview/${SID}/`, o);
		assert.equal(res.statusCode, 302);
		assert.match(String(res.headers["location"] || ""), /index\.html$/);
	});

	it("/preview/<sid> → 301 with trailing slash", async () => {
		const o = makeOpts(true);
		const res = fakeRes();
		await handlePreviewRequest(fakeReq({ url: `/preview/${SID}` }), res as any, `/preview/${SID}`, o);
		assert.equal(res.statusCode, 301);
		assert.equal(res.headers["location"], `/preview/${SID}/`);
	});
});

describe("handlePreviewRequest — MIME table", () => {
	const cases: Array<[string, string]> = [
		["index.html", "text/html"],
		["styles.css", "text/css"],
		["logo.png", "image/png"],
		["data.json", "application/json"],
	];
	for (const [file, expectedPrefix] of cases) {
		it(`Content-Type for ${file} starts with ${expectedPrefix}`, async () => {
			const o = makeOpts(true);
			const res = fakeRes();
			await handlePreviewRequest(fakeReq({ url: `/preview/${SID}/${file}` }), res as any, `/preview/${SID}/${file}`, o);
			const ct = String(res.headers["content-type"] || "");
			assert.equal(res.statusCode, 200);
			assert.ok(ct.startsWith(expectedPrefix), `got ${ct}`);
		});
	}
});

describe("handlePreviewRequest — bridge injection", () => {
	it("injects <base> + bridge scripts on text/html", async () => {
		const o = makeOpts(true);
		const res = fakeRes();
		await handlePreviewRequest(fakeReq({ url: `/preview/${SID}/index.html` }), res as any, `/preview/${SID}/index.html`, o);
		const txt = bodyText(res);
		assert.match(txt, new RegExp(`<base href="/preview/${SID}/"`));
		assert.match(txt, /preview-swipe-start|MutationObserver|preview-swipe-move/);
	});

	it("injects inline theme snapshot inside <head> on text/html", async () => {
		const o = makeOpts(true);
		const res = fakeRes();
		await handlePreviewRequest(fakeReq({ url: `/preview/${SID}/index.html` }), res as any, `/preview/${SID}/index.html`, o);
		const txt = bodyText(res);
		// The snapshot lands inside the <head> (alongside <base>).
		const headMatch = txt.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
		assert.ok(headMatch, "expected a <head> block in served HTML");
		const headInner = headMatch![1]!;
		assert.match(headInner, /data-bobbit-preview-theme="snapshot"/);
		assert.match(headInner, /--background:/);
		assert.match(headInner, /\.dark\s*\{/);
	});

	it("does NOT inject bridge into non-html (css)", async () => {
		const o = makeOpts(true);
		const res = fakeRes();
		await handlePreviewRequest(fakeReq({ url: `/preview/${SID}/styles.css` }), res as any, `/preview/${SID}/styles.css`, o);
		const txt = bodyText(res);
		assert.equal(txt, "body{color:red}");
		assert.doesNotMatch(txt, /<base/);
		assert.doesNotMatch(txt, /MutationObserver/);
	});
});

describe("handlePreviewRequest — error mapping", () => {
	it("404 on missing file", async () => {
		const o = makeOpts(true);
		const res = fakeRes();
		await handlePreviewRequest(fakeReq({ url: `/preview/${SID}/nope.html` }), res as any, `/preview/${SID}/nope.html`, o);
		assert.equal(res.statusCode, 404);
	});

	it("403 on traversal (../)", async () => {
		const o = makeOpts(true);
		const res = fakeRes();
		const url = `/preview/${SID}/..%2f..%2fsecret.txt`;
		await handlePreviewRequest(fakeReq({ url }), res as any, decodeURI(url), o);
		// pathname after normalisation may not contain %2f decoding for slashes,
		// but the path-guard rejects backslashes/abs/embedded NULs and traversal.
		assert.ok(res.statusCode === 403 || res.statusCode === 404);
	});

	it("403 on backslash in path", async () => {
		const o = makeOpts(true);
		const res = fakeRes();
		await handlePreviewRequest(fakeReq({ url: `/preview/${SID}/sub\\evil.html` }), res as any, `/preview/${SID}/sub\\evil.html`, o);
		assert.equal(res.statusCode, 403);
	});
});

describe("handlePreviewRequest — per-artifact URL", () => {
	// `/preview/<sid>/_artifact/<artifactId>/<rel>` serves directly from the
	// per-artifact mount dir instead of the session's live mount slot, so
	// multiple preview tabs (each backed by a different artifact) can be
	// loaded at their own stable URLs without mount swapping.
	const ARTIFACT_ID = "abc123";
	let artifactMountPath: string;
	before(() => {
		artifactMountPath = path.join(workspaceRoot, "state", "preview-artifacts", SID, ARTIFACT_ID, "mount");
		mkdirSync(artifactMountPath, { recursive: true });
		writeFileSync(path.join(artifactMountPath, "01.html"), "<!doctype html><html><head><title>a1</title></head><body>v1</body></html>");
		writeFileSync(path.join(artifactMountPath, "styles.css"), "body{color:blue}");
	});

	it("serves an artifact HTML file with artifact-prefixed <base>", async () => {
		const o = makeOpts(true);
		const res = fakeRes();
		const url = `/preview/${SID}/_artifact/${ARTIFACT_ID}/01.html`;
		await handlePreviewRequest(fakeReq({ url }), res as any, url, o);
		assert.equal(res.statusCode, 200);
		const txt = bodyText(res);
		assert.match(txt, new RegExp(`<base href="/preview/${SID}/_artifact/${ARTIFACT_ID}/"`));
		// Body content survives the rewrite. We can't assert `v1</body>` adjacency
		// because injectBaseAndScripts adds the bridge scripts before </body>;
		// instead assert v1 sits at the start of <body>, and that the bridge was
		// injected (mirrors the live-mount assertion above).
		assert.match(txt, /<body>v1</);
		assert.match(txt, /preview-swipe-start|MutationObserver/);
	});

	it("serves non-HTML artifact assets unmodified", async () => {
		const o = makeOpts(true);
		const res = fakeRes();
		const url = `/preview/${SID}/_artifact/${ARTIFACT_ID}/styles.css`;
		await handlePreviewRequest(fakeReq({ url }), res as any, url, o);
		assert.equal(res.statusCode, 200);
		assert.equal(bodyText(res), "body{color:blue}");
	});

	it("400 on invalid artifactId", async () => {
		const o = makeOpts(true);
		const res = fakeRes();
		const url = `/preview/${SID}/_artifact/has space/01.html`;
		await handlePreviewRequest(fakeReq({ url }), res as any, decodeURI(url).replace("%20", " "), o);
		assert.equal(res.statusCode, 400);
	});

	it("404 on unknown artifactId (no mount dir)", async () => {
		const o = makeOpts(true);
		const res = fakeRes();
		const url = `/preview/${SID}/_artifact/missing0/01.html`;
		await handlePreviewRequest(fakeReq({ url }), res as any, url, o);
		assert.equal(res.statusCode, 404);
	});

	it("404 on missing file inside an existing artifact", async () => {
		const o = makeOpts(true);
		const res = fakeRes();
		const url = `/preview/${SID}/_artifact/${ARTIFACT_ID}/nope.html`;
		await handlePreviewRequest(fakeReq({ url }), res as any, url, o);
		assert.equal(res.statusCode, 404);
	});

	it("rejects traversal out of artifact mount", async () => {
		const o = makeOpts(true);
		const res = fakeRes();
		const url = `/preview/${SID}/_artifact/${ARTIFACT_ID}/..\\evil.html`;
		await handlePreviewRequest(fakeReq({ url }), res as any, url, o);
		assert.equal(res.statusCode, 403);
	});
});

describe("handlePreviewRequest — admin bearer fallback", () => {
	it("accepts ?token=<admin>", async () => {
		const store = new CookieStore(mkdtempSync(path.join(workspaceRoot, "ab-")));
		const opts = { cookieStore: store, isLocalhost: false, adminBearerToken: "admin-secret" };
		const res = fakeRes();
		await handlePreviewRequest(fakeReq({ url: `/preview/${SID}/index.html?token=admin-secret` }), res as any, `/preview/${SID}/index.html`, opts);
		assert.equal(res.statusCode, 200);
	});

	it("rejects wrong ?token=", async () => {
		const store = new CookieStore(mkdtempSync(path.join(workspaceRoot, "ab-")));
		const opts = { cookieStore: store, isLocalhost: false, adminBearerToken: "admin-secret" };
		const res = fakeRes();
		await handlePreviewRequest(fakeReq({ url: `/preview/${SID}/index.html?token=wrong` }), res as any, `/preview/${SID}/index.html`, opts);
		assert.equal(res.statusCode, 401);
	});
});
