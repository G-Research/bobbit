import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, it } from "vitest";

import {
	rewriteManifestForBasePath,
	rewriteSpaShell,
} from "../../../src/server/base-path-http.ts";
import { CookieStore } from "../../../src/server/auth/cookie.ts";
import { handlePreviewRequest } from "../../../src/server/preview/content-route.ts";
import { mountPath, setPreviewRootForTesting } from "../../../src/server/preview/mount.ts";

const SID = "11111111-2222-3333-4444-555555555555";
let previewRoot: string;

beforeAll(() => {
	previewRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-base-path-preview-"));
	setPreviewRootForTesting(previewRoot);
	const dir = mountPath(SID);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><head><title>Preview</title></head><body><img src=\"asset.png\"></body></html>");
});

afterAll(() => {
	setPreviewRootForTesting(undefined);
	fs.rmSync(previewRoot, { recursive: true, force: true });
});

describe("SPA shell base-path rewriting", () => {
	const marker = '<script>window.__BOBBIT_BASE_PATH__ = "";</script>';

	it("is byte-for-byte identity in root mode", () => {
		const html = `<!doctype html><html><head>${marker}<link href="/assets/app.css"></head></html>`;
		assert.equal(rewriteSpaShell(html, ""), html);
	});

	it("stamps the runtime global and re-anchors both quote styles", () => {
		const html = [
			"<!doctype html><html><head>",
			marker,
			'<link rel="stylesheet" href="/assets/app.css?x=1">',
			"<link rel='manifest' href='/manifest.json'>",
			'<script type="module" src="/assets/app.js"></script>',
			"<img src='/favicon.svg'>",
			"</head></html>",
		].join("");
		const rewritten = rewriteSpaShell(html, "/team/bobbit");

		assert.match(rewritten, /window\.__BOBBIT_BASE_PATH__ = "\/team\/bobbit"/);
		assert.match(rewritten, /href="\/team\/bobbit\/assets\/app\.css\?x=1"/);
		assert.match(rewritten, /href='\/team\/bobbit\/manifest\.json'/);
		assert.match(rewritten, /src="\/team\/bobbit\/assets\/app\.js"/);
		assert.match(rewritten, /src='\/team\/bobbit\/favicon\.svg'/);
	});

	it("does not rewrite protocol-relative, external, inline, fragment, or relative references", () => {
		const references = [
			'<script src="//cdn.example/app.js"></script>',
			'<script src="https://cdn.example/app.js"></script>',
			'<img src="data:image/png;base64,AA==">',
			'<img src="blob:https://example/id">',
			'<a href="#content">skip</a>',
			'<link href="assets/relative.css">',
			'<link href="./assets/relative.css">',
			'<link href="../assets/relative.css">',
		];
		const html = `${marker}${references.join("")}`;
		const rewritten = rewriteSpaShell(html, "/bobbit");
		for (const reference of references) assert.ok(rewritten.includes(reference), reference);
	});

	it("fails closed when the mounted shell marker is absent or ambiguous", () => {
		assert.throws(() => rewriteSpaShell("<html></html>", "/bobbit"), /base.path|marker/i);
		assert.throws(() => rewriteSpaShell(`${marker}${marker}`, "/bobbit"), /base.path|marker/i);
	});
});

describe("manifest base-path rewriting", () => {
	const manifest = {
		name: "Bobbit",
		start_url: "/",
		scope: "/",
		icons: [
			{ src: "/icon-192.png", sizes: "192x192" },
			{ src: "icons/relative.png", sizes: "96x96" },
			{ src: "https://cdn.example/icon.png", sizes: "48x48" },
		],
	};

	it("preserves root-mode launch and icon behavior", () => {
		assert.deepEqual(rewriteManifestForBasePath(manifest, ""), manifest);
	});

	it("rewrites start, scope, and only root-absolute icons without mutating input", () => {
		const rewritten = rewriteManifestForBasePath(manifest, "/team/bobbit");
		assert.equal(rewritten.start_url, "/team/bobbit/");
		assert.equal(rewritten.scope, "/team/bobbit/");
		assert.deepEqual(rewritten.icons, [
			{ src: "/team/bobbit/icon-192.png", sizes: "192x192" },
			{ src: "icons/relative.png", sizes: "96x96" },
			{ src: "https://cdn.example/icon.png", sizes: "48x48" },
		]);
		assert.equal(manifest.start_url, "/");
		assert.equal(manifest.icons[0].src, "/icon-192.png");
	});

	it("URL-encodes a real launch token below the mount", () => {
		const rewritten = rewriteManifestForBasePath(manifest, "/bobbit", "real token+/=?&");
		assert.equal(rewritten.start_url, "/bobbit/?token=real%20token%2B%2F%3D%3F%26");
		assert.equal(rewritten.scope, "/bobbit/");
	});
});

interface FakeResponse {
	statusCode: number;
	headers: Record<string, string | string[] | number>;
	body: Buffer[];
	writeHead(status: number, headers?: Record<string, string | string[] | number>): void;
	setHeader(name: string, value: string | string[]): void;
	getHeader(name: string): string | string[] | number | undefined;
	write(chunk: unknown): boolean;
	end(chunk?: unknown): void;
	on(): void;
	once(): void;
	emit(): boolean;
}

function fakeRequest(url: string): any {
	return { url, method: "GET", headers: { host: "example.test" }, on() {} };
}

function fakeResponse(): FakeResponse {
	const body: Buffer[] = [];
	const sink = new PassThrough();
	sink.on("data", chunk => body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
	const response: FakeResponse = {
		statusCode: 0,
		headers: {},
		body,
		writeHead(status, headers) {
			response.statusCode = status;
			for (const [name, value] of Object.entries(headers ?? {})) response.headers[name.toLowerCase()] = value;
		},
		setHeader(name, value) { response.headers[name.toLowerCase()] = value; },
		getHeader(name) { return response.headers[name.toLowerCase()]; },
		write(chunk) { body.push(Buffer.from(String(chunk))); return true; },
		end(chunk) { if (chunk != null) body.push(Buffer.from(String(chunk))); sink.end(); },
		on() {},
		once() {},
		emit() { return false; },
	};
	return response;
}

function previewOptions(basePath: string) {
	return {
		cookieStore: new CookieStore(Buffer.alloc(32, 0x61)),
		isLocalhost: true,
		basePath,
	};
}

describe("direct preview browser outputs", () => {
	it("mounts redirect Locations below the configured base", async () => {
		const bare = fakeResponse();
		await handlePreviewRequest(fakeRequest(`/preview/${SID}`), bare as any, `/preview/${SID}`, previewOptions("/team/bobbit"));
		assert.equal(bare.statusCode, 301);
		assert.equal(bare.headers.location, `/team/bobbit/preview/${SID}/`);

		const directory = fakeResponse();
		await handlePreviewRequest(fakeRequest(`/preview/${SID}/`), directory as any, `/preview/${SID}/`, previewOptions("/team/bobbit"));
		assert.equal(directory.statusCode, 302);
		assert.equal(directory.headers.location, `/team/bobbit/preview/${SID}/index.html`);
	});

	it("injects one marked mounted base into preview HTML", async () => {
		const response = fakeResponse();
		await handlePreviewRequest(
			fakeRequest(`/preview/${SID}/index.html`),
			response as any,
			`/preview/${SID}/index.html`,
			previewOptions("/team/bobbit"),
		);
		const body = Buffer.concat(response.body).toString("utf8");
		assert.equal(response.statusCode, 200);
		assert.match(body, new RegExp(`<base data-bobbit-preview-base href="/team/bobbit/preview/${SID}/">`));
		assert.equal((body.match(/data-bobbit-preview-base/g) ?? []).length, 1);
	});

	it("retains root-mounted preview output compatibility", async () => {
		const response = fakeResponse();
		await handlePreviewRequest(fakeRequest(`/preview/${SID}`), response as any, `/preview/${SID}`, previewOptions(""));
		assert.equal(response.headers.location, `/preview/${SID}/`);
	});
});
