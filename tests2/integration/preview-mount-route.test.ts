/*
 * Route-contract coverage for the v3 preview mount and content origin.
 *
 * The broad gateway router is covered elsewhere. These declarations run the
 * production preview mount, artifact, content-route, cookie-auth, bridge, and
 * theme-snapshot cores behind a route-shaped fixture. Its sessions and complete
 * filesystem live in one suite-owned memfs volume: no gateway, listener, NTFS
 * workspace, or full preview fixture is created.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHmac } from "node:crypto";
import { Writable } from "node:stream";
import type http from "node:http";
import type { CookieStore } from "../../src/server/auth/cookie.js";
import { COOKIE_NAME } from "../../src/server/auth/cookie.js";
import { handlePreviewRequest, pickEntry } from "../../src/server/preview/content-route.js";
import * as previewArtifacts from "../../src/server/preview/artifacts.js";
import * as previewMount from "../../src/server/preview/mount.js";
import { _resetPreviewThemeSnapshotCache } from "../../src/server/preview/theme-snapshot.js";
import { installScopedMemFs, type NodeFs } from "../core/helpers/scoped-memfs.js";

// Preserve the migrated Playwright declaration identity without importing the
// gateway-backed compatibility harness.
const test = Object.assign(it, { afterAll, beforeAll, describe });

const SESSION_IDS = [
	"11111111-2222-3333-4444-555555555555",
	"22222222-3333-4444-5555-666666666666",
	"33333333-4444-5555-6666-777777777777",
	"44444444-5555-6666-7777-888888888888",
] as const;
const VALID_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const pngBytes = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const SIGNED_COOKIE_VALUE = String.raw`v1\.[1-9]\d*\.[1-9]\d*\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}`;

interface RouteInit {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

class MemoryCookieStore {
	private readonly values = new Set<string>();
	private readonly signingKey = Buffer.alloc(32, 0x5a);
	private sequence = 1;

	mint(): string {
		const issuedAt = 1_700_000_000 + this.sequence;
		const expiresAt = issuedAt + 2_592_000;
		const nonceBytes = Buffer.alloc(16);
		nonceBytes.writeUInt32BE(this.sequence++, 12);
		const prefix = `v1.${issuedAt}.${expiresAt}.${nonceBytes.toString("base64url")}`;
		const signature = createHmac("sha256", this.signingKey).update(prefix, "ascii").digest("base64url");
		const value = `${prefix}.${signature}`;
		this.values.add(value);
		return value;
	}

	verify(value: string): { valid: true; issuedAt: number; expiresAt: number; needsRenewal: false } | undefined {
		if (!this.values.has(value)) return undefined;
		const [, issuedAt, expiresAt] = value.split(".");
		return {
			valid: true,
			issuedAt: Number(issuedAt),
			expiresAt: Number(expiresAt),
			needsRenewal: false,
		};
	}
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
	const match = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
	return match?.[1];
}

function hasTrustedBrowserMetadata(url: URL, headers: Record<string, string> | undefined): boolean {
	const site = headerValue(headers, "sec-fetch-site")?.trim().toLowerCase();
	const mode = headerValue(headers, "sec-fetch-mode")?.trim().toLowerCase();
	const origin = headerValue(headers, "origin");
	return site === "same-origin"
		&& (mode === "cors" || mode === "same-origin")
		&& (origin === undefined || origin === url.origin);
}

class MemoryServerResponse extends Writable {
	statusCode = 200;
	readonly headers = new Map<string, string | string[]>();
	readonly chunks: Buffer[] = [];

	_write(chunk: Buffer | string, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
		this.chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
		done();
	}

	writeHead(status: number, headers?: Record<string, string | string[] | number>): this {
		this.statusCode = status;
		for (const [name, value] of Object.entries(headers ?? {})) {
			this.headers.set(name.toLowerCase(), Array.isArray(value) ? value.map(String) : String(value));
		}
		return this;
	}

	setHeader(name: string, value: string | string[] | number): this {
		this.headers.set(name.toLowerCase(), Array.isArray(value) ? value.map(String) : String(value));
		return this;
	}

	getHeader(name: string): string | string[] | undefined {
		return this.headers.get(name.toLowerCase());
	}

	toResponse(): Response {
		const headers = new Headers();
		for (const [name, value] of this.headers) {
			if (Array.isArray(value)) for (const item of value) headers.append(name, item);
			else headers.set(name, value);
		}
		return new Response(Buffer.concat(this.chunks), { status: this.statusCode, headers });
	}
}

class PreviewMountRouteFixture {
	readonly root = path.resolve("/memfs/preview-mount-route");
	readonly fixtureRoot = path.join(this.root, "fixture");
	readonly fixtureEntry = path.join(this.fixtureRoot, "report.html");
	readonly token = "suite-owned-preview-token";
	private readonly cookies = new MemoryCookieStore();
	private sessionIndex = 0;

	constructor(readonly memfs: NodeFs) {
		previewMount.setPreviewFsForTesting(memfs);
		previewMount.setPreviewRootForTesting(path.join(this.root, "state", "preview"));
		previewArtifacts.setPreviewArtifactRootForTesting(path.join(this.root, "state", "preview-artifacts"));
		_resetPreviewThemeSnapshotCache();

		// The production theme snapshot discovers these canonical source paths.
		// A compact token sheet is enough to prove both light and dark snapshots.
		memfs.mkdirSync(path.join(process.cwd(), "src", "ui"), { recursive: true });
		memfs.writeFileSync(path.join(process.cwd(), "package.json"), "{}");
		memfs.writeFileSync(path.join(process.cwd(), "src", "ui", "app.css"), [
			":root { --background: canvas; --foreground: canvastext; --card: canvas; --muted-foreground: gray; --border: gray; --primary: blue; }",
			".dark { --background: canvastext; --foreground: canvas; --card: canvastext; --muted-foreground: silver; --border: silver; --primary: cyan; }",
		].join("\n"));

		memfs.mkdirSync(path.join(this.fixtureRoot, "thumbs"), { recursive: true });
		memfs.writeFileSync(this.fixtureEntry, `<!DOCTYPE html><body><img src="sibling.png"><img src="thumbs/x.png"></body>`);
		memfs.writeFileSync(path.join(this.fixtureRoot, "sibling.png"), pngBytes);
		memfs.writeFileSync(path.join(this.fixtureRoot, "thumbs", "x.png"), pngBytes);
		memfs.writeFileSync(path.join(this.fixtureRoot, "styles.css"), "body{}");
		memfs.writeFileSync(path.join(this.fixtureRoot, "undeclared.txt"), "should-not-be-copied");
		memfs.writeFileSync(path.join(this.fixtureRoot, "preview-manifest.json"), JSON.stringify({ assets: ["styles.css"] }));
	}

	createSession(): string {
		const sessionId = SESSION_IDS[this.sessionIndex++];
		if (!sessionId) throw new Error("preview route fixture exhausted its static sessions");
		return sessionId;
	}

	deleteSession(_sessionId: string): void {
		// Session state is a static route declaration; the suite-owned volume is
		// discarded atomically in afterAll.
	}

	async fetch(input: string, init: RouteInit = {}): Promise<Response> {
		const url = new URL(input, "http://preview.test");
		const method = (init.method ?? "GET").toUpperCase();

		if (url.pathname === "/api/health") {
			if (init.headers?.Authorization !== `Bearer ${this.token}`) return this.json({ error: "Unauthorized" }, 401);
			if (!hasTrustedBrowserMetadata(url, init.headers)) return this.json({ ok: true });
			const cookie = this.cookies.mint();
			return this.json({ ok: true }, 200, {
				"set-cookie": `${COOKIE_NAME}=${cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000; Secure`,
			});
		}

		if (url.pathname.startsWith("/preview/")) {
			const response = new MemoryServerResponse();
			const req = {
				url: `${url.pathname}${url.search}`,
				method,
				headers: {
					host: "preview.test",
					...(init.headers?.Cookie ? { cookie: init.headers.Cookie } : {}),
				},
			} as http.IncomingMessage;
			await handlePreviewRequest(req, response as unknown as http.ServerResponse, url.pathname, {
				cookieStore: this.cookies as unknown as CookieStore,
				isLocalhost: false,
			});
			return response.toResponse();
		}

		if (url.pathname === "/api/preview/mount" && method === "POST") {
			return this.mount(url.searchParams.get("sessionId") ?? "", this.parseBody(init.body));
		}
		if (url.pathname === "/api/preview/mount" && method === "GET") {
			return this.currentMount(url.searchParams.get("sessionId") ?? "");
		}

		const restore = url.pathname.match(/^\/api\/preview\/artifacts\/([^/]+)\/restore$/);
		if (restore && method === "POST") {
			const sessionId = url.searchParams.get("sessionId") ?? "";
			if (!VALID_SESSION_ID.test(sessionId)) return this.json({ error: "Invalid sessionId" }, 400);
			try {
				return this.json(previewArtifacts.restorePreviewArtifact(sessionId, decodeURIComponent(restore[1]!)));
			} catch (error) {
				return this.coreError(error);
			}
		}

		return this.json({ error: "Not found" }, 404);
	}

	private mount(sessionId: string, body: Record<string, unknown>): Response {
		if (!VALID_SESSION_ID.test(sessionId)) return this.json({ error: "Invalid sessionId" }, 400);
		const hasArtifact = typeof body.artifactId === "string" && body.artifactId.length > 0;
		const hasHtml = typeof body.html === "string";
		const hasFile = typeof body.file === "string" && body.file.length > 0;
		const hasAssets = Array.isArray(body.assets);
		const hasManifest = typeof body.manifest === "string" && body.manifest.length > 0;
		if (hasArtifact && (hasHtml || hasFile || hasAssets || hasManifest)) {
			return this.json({ error: "artifact restore fields are mutually exclusive" }, 400);
		}
		if (!hasArtifact && !hasHtml && !hasFile) return this.json({ error: "Body must contain html, file, or artifactId" }, 400);
		if (hasHtml && (hasAssets || hasManifest)) return this.json({ error: "assets and manifest require file" }, 400);

		try {
			if (hasArtifact) return this.json(previewArtifacts.restorePreviewArtifact(sessionId, body.artifactId as string));

			let result: previewMount.MountResult | previewMount.MountFileResult;
			if (hasHtml) {
				const entry = typeof body.entry === "string" && body.entry.length > 0 ? body.entry : undefined;
				result = previewMount.writeInline(sessionId, body.html as string, entry);
			} else {
				const file = body.file as string;
				if (!path.isAbsolute(file)) return this.json({ error: "file path must be absolute" }, 400);
				if (!this.memfs.existsSync(file)) return this.json({ error: "file not found" }, 404);
				const declared = [...(hasAssets ? body.assets as string[] : [])];
				if (hasManifest) {
					const manifest = body.manifest as string;
					if (path.isAbsolute(manifest) || manifest.includes("\\") || manifest.split("/").includes("..")) {
						return this.json({ error: "Invalid manifest path" }, 400);
					}
					const manifestPath = path.resolve(path.dirname(file), manifest);
					if (!this.memfs.existsSync(manifestPath)) return this.json({ error: "Manifest not found" }, 404);
					const parsed = JSON.parse(this.memfs.readFileSync(manifestPath, "utf-8")) as { assets?: unknown };
					if (!Array.isArray(parsed.assets)) return this.json({ error: "Manifest must contain assets" }, 400);
					declared.push(...parsed.assets as string[]);
				}
				result = previewMount.mountFile(sessionId, file, [...new Set(declared)]);
			}
			const artifact = previewArtifacts.persistPreviewArtifact(sessionId, result);
			return this.json({ ...result, artifactId: artifact.artifactId });
		} catch (error) {
			return this.coreError(error);
		}
	}

	private currentMount(sessionId: string): Response {
		if (!VALID_SESSION_ID.test(sessionId)) return this.json({ error: "Invalid sessionId" }, 400);
		try {
			const dir = previewMount.mountDir(sessionId);
			const entry = pickEntry(dir);
			if (!entry) return this.json({ error: "no preview mount" }, 404);
			const entryPath = path.join(dir, entry);
			const stat = this.memfs.statSync(entryPath);
			const contentHash = previewMount.contentHashForMount(sessionId);
			const artifact = previewArtifacts.findPreviewArtifactByHash(sessionId, contentHash);
			return this.json({
				url: `/preview/${sessionId}/${entry}`,
				path: entryPath,
				relPath: path.posix.join(sessionId, entry),
				entry,
				mtime: Math.floor(stat.mtimeMs),
				contentHash,
				artifactId: artifact?.artifactId,
			});
		} catch (error) {
			return this.coreError(error);
		}
	}

	private parseBody(body: string | undefined): Record<string, unknown> {
		try { return JSON.parse(body ?? "{}") as Record<string, unknown>; }
		catch { return {}; }
	}

	private coreError(error: unknown): Response {
		if (error instanceof previewMount.PreviewMountError || error instanceof previewArtifacts.PreviewArtifactError) {
			return this.json({ error: error.message }, error.statusCode);
		}
		return this.json({ error: error instanceof Error ? error.message : String(error) }, 500);
	}

	private json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json", ...headers },
		});
	}
}

let restoreFs: (() => void) | undefined;
let route: PreviewMountRouteFixture;
let token: string;
let sessionId: string;
let fixtureEntry: string;

function apiFetch(input: string, init: RouteInit = {}): Promise<Response> {
	return route.fetch(input, {
		...init,
		headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
	});
}

function base(): string {
	return "http://preview.test";
}

function createSession(): string {
	return route.createSession();
}

function deleteSession(id: string): void {
	route.deleteSession(id);
}

test.beforeAll(() => {
	const scoped = installScopedMemFs([
		"copyFileSync", "cpSync", "createReadStream", "existsSync", "mkdirSync",
		"readFileSync", "readdirSync", "realpathSync", "renameSync", "rmSync",
		"statSync", "unlinkSync", "writeFileSync",
	]);
	restoreFs = scoped.restore;
	route = new PreviewMountRouteFixture(scoped.fs);
	token = route.token;
	sessionId = createSession();
	fixtureEntry = route.fixtureEntry;
});

test.afterAll(() => {
	deleteSession(sessionId);
	previewMount.setPreviewRootForTesting(undefined);
	previewMount.setPreviewFsForTesting(undefined);
	previewArtifacts.setPreviewArtifactRootForTesting(undefined);
	_resetPreviewThemeSnapshotCache();
	restoreFs?.();
});

/** Use an authenticated, same-origin browser request to bootstrap a signed cookie. */
async function mintCookie(): Promise<string> {
	const resp = await route.fetch(`${base()}/api/health`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Origin: base(),
			"Sec-Fetch-Site": "same-origin",
			"Sec-Fetch-Mode": "cors",
		},
	});
	expect(resp.status).toBe(200);
	const setCookie = resp.headers.get("set-cookie");
	expect(setCookie, "Server must mint bobbit_session for trusted browser auth").toBeTruthy();
	const m = String(setCookie).match(new RegExp(`${COOKIE_NAME}=(${SIGNED_COOKIE_VALUE})(?:;|$)`));
	expect(m, `Set-Cookie did not include a signed bobbit_session: ${setCookie}`).not.toBeNull();
	return `${COOKIE_NAME}=${m![1]}`;
}

test.describe("POST /api/preview/mount (v3)", () => {
	test("html body → 200 with {url, path, entry, mtime, contentHash, artifactId}", async () => {
		const resp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			body: JSON.stringify({ html: "<h1>x</h1>" }),
		});
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(typeof body.url).toBe("string");
		expect(body.url).toBe(`/preview/${sessionId}/inline.html`);
		expect(body.entry).toBe("inline.html");
		expect(typeof body.path).toBe("string");
		expect(body.path.length).toBeGreaterThan(0);
		expect(typeof body.mtime).toBe("number");
		expect(body.mtime).toBeGreaterThan(0);
		expect(body.contentHash).toMatch(/^[a-f0-9]{64}$/);
		expect(body.artifactId).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
	});

	test("artifactId restore rehydrates immutable mounted bytes and rejects wrong sessions", async () => {
		const restoreSessionId = createSession();
		const otherSessionId = createSession();
		try {
			const v1Resp = await apiFetch(`/api/preview/mount?sessionId=${restoreSessionId}`, {
				method: "POST",
				body: JSON.stringify({ html: "<!doctype html><body>artifact-v1</body>", entry: "artifact.html" }),
			});
			expect(v1Resp.status).toBe(200);
			const v1 = await v1Resp.json();
			expect(v1.artifactId).toMatch(/^[A-Za-z0-9_-]{6,64}$/);

			const v2Resp = await apiFetch(`/api/preview/mount?sessionId=${restoreSessionId}`, {
				method: "POST",
				body: JSON.stringify({ html: "<!doctype html><body>current-v2</body>", entry: "artifact.html" }),
			});
			expect(v2Resp.status).toBe(200);
			const v2 = await v2Resp.json();
			expect(v2.contentHash).not.toBe(v1.contentHash);

			const otherMount = await apiFetch(`/api/preview/mount?sessionId=${otherSessionId}`, {
				method: "POST",
				body: JSON.stringify({ html: "<!doctype html><body>other-stable</body>", entry: "artifact.html" }),
			});
			expect(otherMount.status).toBe(200);
			const otherBefore = await otherMount.json();

			const wrongSessionRestore = await apiFetch(`/api/preview/artifacts/${encodeURIComponent(v1.artifactId)}/restore?sessionId=${otherSessionId}`, {
				method: "POST",
				body: JSON.stringify({ artifactId: v1.artifactId }),
			});
			expect(wrongSessionRestore.status).toBe(404);
			const otherAfterResp = await apiFetch(`/api/preview/mount?sessionId=${otherSessionId}`);
			expect(otherAfterResp.status).toBe(200);
			const otherAfter = await otherAfterResp.json();
			expect(otherAfter.contentHash).toBe(otherBefore.contentHash);

			const restoreResp = await apiFetch(`/api/preview/artifacts/${encodeURIComponent(v1.artifactId)}/restore?sessionId=${restoreSessionId}`, {
				method: "POST",
				body: JSON.stringify({ artifactId: v1.artifactId }),
			});
			expect(restoreResp.status).toBe(200);
			const restored = await restoreResp.json();
			expect(restored.artifactId).toBe(v1.artifactId);
			expect(restored.contentHash).toBe(v1.contentHash);
			expect(restored.entry).toBe("artifact.html");

			const cookie = await mintCookie();
			const contentResp = await route.fetch(`${base()}/preview/${restoreSessionId}/artifact.html`, {
				headers: { Cookie: cookie },
			});
			expect(contentResp.status).toBe(200);
			const html = await contentResp.text();
			expect(html).toContain("artifact-v1");
			expect(html).not.toContain("current-v2");
		} finally {
			deleteSession(restoreSessionId);
			deleteSession(otherSessionId);
		}
	});

	test("missing html, file, and artifactId → 400", async () => {
		const resp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(400);
	});

	test("invalid sessionId → 400", async () => {
		const resp = await apiFetch(`/api/preview/mount?sessionId=not-a-uuid`, {
			method: "POST",
			body: JSON.stringify({ html: "<h1>x</h1>" }),
		});
		expect(resp.status).toBe(400);
	});

	test("file= with explicit assets[] copies entry + declared assets only", async () => {
		const resp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			body: JSON.stringify({ file: fixtureEntry, assets: ["sibling.png", "thumbs/x.png"] }),
		});
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.entry).toBe("report.html");
		expect(body.url).toBe(`/preview/${sessionId}/report.html`);
		expect(Array.isArray(body.assets)).toBe(true);
		expect(body.assets.sort()).toEqual(["sibling.png", "thumbs/x.png"]);

		const cookie = await mintCookie();
		const assetResp = await route.fetch(`${base()}/preview/${sessionId}/sibling.png`, {
			headers: { Cookie: cookie },
		});
		expect(assetResp.status).toBe(200);
		expect(assetResp.headers.get("content-type") || "").toMatch(/image\/png/);
		const buf = Buffer.from(await assetResp.arrayBuffer());
		expect(buf.equals(pngBytes)).toBe(true);

		const nested = await route.fetch(`${base()}/preview/${sessionId}/thumbs/x.png`, {
			headers: { Cookie: cookie },
		});
		expect(nested.status).toBe(200);

		// Undeclared sibling must NOT be copied — 404 from content origin.
		const undeclared = await route.fetch(`${base()}/preview/${sessionId}/undeclared.txt`, {
			headers: { Cookie: cookie },
		});
		expect(undeclared.status).toBe(404);
	});

	test("file= without assets copies only entry; siblings 404", async () => {
		const resp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			body: JSON.stringify({ file: fixtureEntry }),
		});
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.entry).toBe("report.html");
		expect(body.assets).toEqual([]);

		const cookie = await mintCookie();
		const entryResp = await route.fetch(`${base()}/preview/${sessionId}/report.html`, {
			headers: { Cookie: cookie },
		});
		expect(entryResp.status).toBe(200);

		const cssResp = await route.fetch(`${base()}/preview/${sessionId}/styles.css`, {
			headers: { Cookie: cookie },
		});
		expect(cssResp.status).toBe(404);
	});

	test("file= with manifest reads assets from JSON file", async () => {
		const resp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			body: JSON.stringify({ file: fixtureEntry, manifest: "preview-manifest.json" }),
		});
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.assets).toEqual(["styles.css"]);

		const cookie = await mintCookie();
		const cssResp = await route.fetch(`${base()}/preview/${sessionId}/styles.css`, {
			headers: { Cookie: cookie },
		});
		expect(cssResp.status).toBe(200);
	});

	test("html= with assets= → 400", async () => {
		const resp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			body: JSON.stringify({ html: "<h1>x</h1>", assets: ["foo.css"] }),
		});
		expect(resp.status).toBe(400);
	});

	test("file= with `..` in assets → 400", async () => {
		const resp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			body: JSON.stringify({ file: fixtureEntry, assets: ["../escape"] }),
		});
		expect(resp.status).toBe(400);
	});

	test("file= with missing literal asset → 404", async () => {
		const resp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			body: JSON.stringify({ file: fixtureEntry, assets: ["missing.css"] }),
		});
		expect(resp.status).toBe(404);
	});
});

test.describe("GET /api/preview/mount (v3)", () => {
	test("current mount response includes a 64-hex contentHash", async () => {
		const currentSessionId = createSession();
		try {
			const mountResp = await apiFetch(`/api/preview/mount?sessionId=${currentSessionId}`, {
				method: "POST",
				body: JSON.stringify({ html: "<h1>bootstrap hash</h1>", entry: "current.html" }),
			});
			expect(mountResp.status).toBe(200);

			const resp = await apiFetch(`/api/preview/mount?sessionId=${currentSessionId}`);
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.url).toBe(`/preview/${currentSessionId}/current.html`);
			expect(body.relPath).toBe(`${currentSessionId}/current.html`);
			expect(body.entry).toBe("current.html");
			expect(typeof body.path).toBe("string");
			expect(body.path.length).toBeGreaterThan(0);
			expect(typeof body.mtime).toBe("number");
			expect(body.mtime).toBeGreaterThan(0);
			expect(body.contentHash).toMatch(/^[a-f0-9]{64}$/);
			expect(body.artifactId).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
		} finally {
			deleteSession(currentSessionId);
		}
	});
});

test.describe("GET /preview/<sid>/* — content origin", () => {
	test.beforeAll(async () => {
		// Ensure inline.html exists for this session.
		const resp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			body: JSON.stringify({ html: "<!DOCTYPE html><html><body>hello</body></html>" }),
		});
		expect(resp.status).toBe(200);
	});

	test("with valid bobbit_session cookie → 200 text/html with bridge scripts injected", async () => {
		const cookie = await mintCookie();
		const resp = await route.fetch(`${base()}/preview/${sessionId}/inline.html`, {
			headers: { Cookie: cookie },
		});
		expect(resp.status).toBe(200);
		expect(resp.headers.get("content-type") || "").toMatch(/text\/html/);
		const body = await resp.text();
		// <base> rewritten to content-origin path.
		expect(body).toContain(`<base href="/preview/${sessionId}/">`);
		// The standalone snapshot retains canonical light/dark theme tokens.
		expect(body).toContain(`data-bobbit-preview-theme="snapshot"`);
		expect(body).toContain("--background: canvas;");
		expect(body).toContain(".dark {");
		// Bridge marker — any of the shared script substrings will do.
		expect(body).toMatch(/preview-swipe-start|MutationObserver/);
	});

	test("without cookie or bearer (forced auth) → 401", async () => {
		const resp = await route.fetch(`${base()}/preview/${sessionId}/inline.html`);
		expect(resp.status).toBe(401);
	});

	test("traversal `/preview/<sid>/../../etc/passwd` → 403 (or 400)", async () => {
		const cookie = await mintCookie();
		// Keep encoded separators intact until the production route's path guard.
		const url = `${base()}/preview/${sessionId}/..%2F..%2Fetc%2Fpasswd`;
		const resp = await route.fetch(url, { headers: { Cookie: cookie } });
		expect([400, 403, 404]).toContain(resp.status);
		expect(resp.status).not.toBe(200);
	});

	test("backslash in path → 403", async () => {
		const cookie = await mintCookie();
		const url = `${base()}/preview/${sessionId}/sub%5Cevil.html`;
		const resp = await route.fetch(url, { headers: { Cookie: cookie } });
		expect(resp.status).toBe(403);
	});

	test("missing file → 404", async () => {
		const cookie = await mintCookie();
		const resp = await route.fetch(`${base()}/preview/${sessionId}/no-such-file.png`, {
			headers: { Cookie: cookie },
		});
		expect(resp.status).toBe(404);
	});
});
