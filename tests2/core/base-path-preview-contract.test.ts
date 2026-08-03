import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest";

import { previewGatewayRoute, type GatewayRoute } from "../../src/shared/base-path.ts";
import { setPreviewRootForTesting, writeInline } from "../../src/server/preview/mount.ts";
import { buildPreviewSnapshotV3Block, parseSnapshot } from "../../defaults/tools/html/snapshot.ts";

const SID = "11111111-2222-3333-4444-555555555555";
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let previewRoot: string;

beforeAll(() => {
	previewRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-preview-route-contract-"));
	setPreviewRootForTesting(previewRoot);
});

afterAll(() => {
	setPreviewRootForTesting(undefined);
	fs.rmSync(previewRoot, { recursive: true, force: true });
});

afterEach(() => {
	vi.resetModules();
	for (const [name, descriptor] of [
		["window", originalWindow],
		["location", originalLocation],
		["localStorage", originalLocalStorage],
	] as const) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});

class MemoryStorage {
	private readonly values = new Map<string, string>();
	getItem(key: string): string | null { return this.values.get(key) ?? null; }
	setItem(key: string, value: string): void { this.values.set(key, value); }
	removeItem(key: string): void { this.values.delete(key); }
}

function installBrowser(basePath: string, explicitGateway?: string): void {
	const storage = new MemoryStorage();
	if (explicitGateway) storage.setItem("gateway.url", explicitGateway);
	const location = {
		origin: "https://ui.example",
		pathname: `${basePath}/`,
		search: "",
		hash: "",
		href: `https://ui.example${basePath}/`,
	};
	const windowValue = { location, localStorage: storage, __BOBBIT_BASE_PATH__: basePath };
	Object.defineProperty(globalThis, "window", { configurable: true, value: windowValue });
	Object.defineProperty(globalThis, "location", { configurable: true, value: location });
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
}

type StoredPreviewParser = (raw: unknown, entry?: unknown) => GatewayRoute | null;

async function historicalParser(): Promise<StoredPreviewParser> {
	// The production decoder gains the optional `entry` parameter for compact v3
	// markers. Cast at this boundary keeps this regression test compilable before
	// that implementation lands while still exercising the runtime contract.
	const boundary = await import("../../src/app/gateway-fetch.ts") as unknown as {
		previewRouteFromStoredValue: StoredPreviewParser;
	};
	return boundary.previewRouteFromStoredValue;
}

function decodeV3Snapshot(block: string, parse: StoredPreviewParser): GatewayRoute | null {
	const snapshot = parseSnapshot(block);
	assert.ok(snapshot && snapshot.kind === "preview", "writer must emit a readable v3 preview snapshot");
	return parse(snapshot.url, snapshot.entry);
}

describe("preview gateway route decoder", () => {
	it.each([
		`/preview/${SID}/index.html`,
		`/preview/${SID}/_artifact/artifact-1/report.html`,
		`/preview/${SID}/nested/assets/app.js?version=2`,
	])("brands valid mount-relative preview data %j", (raw) => {
		assert.equal(previewGatewayRoute(raw), raw);
	});

	it.each([
		`preview/${SID}/index.html`,
		`/team/bobbit/preview/${SID}/index.html`,
		`https://gw.example/preview/${SID}/index.html`,
		`/preview-other/${SID}/index.html`,
		"/preview/not-a-session/index.html",
		`/preview/${SID}/../secret`,
		`/preview/${SID}/%2e%2e/secret`,
		`/preview/${SID}/path\\secret`,
	])("rejects public, malformed, or traversal-shaped preview data %j", (raw) => {
		assert.throws(() => previewGatewayRoute(raw), /preview|route|path/i);
	});
});

describe("preview producers retain one mount-relative owner", () => {
	it("returns a mount-relative route from the low-level preview writer", async () => {
		const result = await writeInline(SID, "<h1>Mounted</h1>", "report.html");
		assert.equal(result.url, `/preview/${SID}/report.html`);
		assert.equal(previewGatewayRoute(result.url), result.url);
		assert.equal(result.url.includes("/team/bobbit/"), false);
	});

	it("does not let preview storage producers import the public-path joiner", () => {
		const producerFiles = [
			"src/server/preview/mount.ts",
			"src/server/preview/artifacts.ts",
			"src/app/panel-workspace.ts",
			"src/app/side-panel-workspace.ts",
		];
		const violations = producerFiles.filter(relative => {
			const source = fs.readFileSync(path.resolve(relative), "utf8");
			return /\bwithBasePath\b/.test(source);
		});
		assert.deepEqual(
			violations,
			[],
			`Preview API/SSE/workspace data must remain GatewayRoute values; public-path join found in: ${violations.join(", ")}`,
		);
	});
});

describe("historical preview URL-only recovery", () => {
	it("accepts current internal, current runtime mount, and selected explicit gateway forms", async () => {
		installBrowser("/bobbit", "https://gateway.example/team/gw/");
		const parse = await historicalParser();
		const expected = `/preview/${SID}/index.html`;
		assert.equal(parse(expected), expected);
		assert.equal(parse(`/bobbit${expected}`), expected);
		assert.equal(parse(`/team/gw${expected}`), expected);
		assert.equal(parse(`https://gateway.example/team/gw${expected}`), expected);
	});

	it("recovers a validated preview suffix from a retired mount without retaining that prefix", async () => {
		installBrowser("/bobbit", "https://gateway.example/team/gw");
		const parse = await historicalParser();
		assert.equal(
			parse(`/retired/deployment${`/preview/${SID}/_artifact/artifact-1/report.html`}`),
			`/preview/${SID}/_artifact/artifact-1/report.html`,
		);
	});

	it("reconstructs compact v3 directory URLs only when their explicit entry is safe", async () => {
		installBrowser("/bobbit", "https://gateway.example/team/gw");
		const parse = await historicalParser();
		const compact = `/preview/${SID}/`;
		const expected = `/preview/${SID}/roadmap.html`;

		assert.equal(parse(compact), null, "a compact URL without entry is genuinely malformed");
		assert.equal(parse(compact, "roadmap.html"), expected);
		assert.equal(parse(`/bobbit${compact}`, "roadmap.html"), expected);
		assert.equal(parse(`https://gateway.example/team/gw${compact}`, "roadmap.html"), expected);
		assert.equal(parse(`/retired/deployment${compact}`, "roadmap.html"), expected);
		assert.equal(parse(compact, "../secret.html"), null);
		assert.equal(parse(compact, "nested/secret.html"), null);
		assert.equal(parse(compact, "path\\secret.html"), null);
	});

	it.each([
		["empty", ""],
		["current directory", "."],
		["parent directory", ".."],
		["forward slash", "nested/secret.html"],
		["backslash", "nested\\secret.html"],
		["NUL control", "unsafe\0.html"],
		["unit-separator control", "unsafe\u001f.html"],
		["over-length", `${"x".repeat(256)}.html`],
	] as const)("rejects unsafe compact entry: %s", async (_name, entry) => {
		installBrowser("/bobbit", "https://gateway.example/team/gw");
		const parse = await historicalParser();
		assert.equal(parse(`/preview/${SID}/`, entry), null);
	});

	it("round-trips literal percent filenames without collapsing their disk targets", async () => {
		installBrowser("/bobbit", "https://gateway.example/team/gw");
		const parse = await historicalParser();
		const mounted = new Map<string, Awaited<ReturnType<typeof writeInline>>>();

		for (const entry of ["100%.html", "%41.html"]) {
			const result = await writeInline(SID, `<h1>${entry}</h1>`, entry);
			mounted.set(entry, result);
			assert.equal(result.url, `/preview/${SID}/${entry}`);
			assert.equal(fs.readFileSync(result.path, "utf8"), `<h1>${entry}</h1>`);

			const block = buildPreviewSnapshotV3Block(result.url, result.relPath, "a".repeat(64), {
				artifactId: "pa_abc123xyz",
				entry,
			});
			const snapshot = parseSnapshot(block);
			assert.ok(snapshot && snapshot.kind === "preview");
			if (!snapshot || snapshot.kind !== "preview") continue;
			assert.equal(snapshot.url, `/preview/${SID}/`, "the capped marker must compact the URL");
			assert.equal(snapshot.entry, entry, "the compact marker must retain the raw filename");

			const route = parse(snapshot.url, snapshot.entry);
			assert.equal(route, `/preview/${SID}/${encodeURIComponent(entry)}`);
			assert.equal(decodeURIComponent(route!.slice(`/preview/${SID}/`.length)), entry);
		}

		const literalPercent = mounted.get("%41.html")!;
		const decodedName = await writeInline(SID, "<h1>A</h1>", "A.html");
		assert.notEqual(literalPercent.path, decodedName.path, "a literal %41 filename must not target A.html");
		assert.equal(fs.readFileSync(literalPercent.path, "utf8"), "<h1>%41.html</h1>");
		assert.equal(fs.readFileSync(decodedName.path, "utf8"), "<h1>A</h1>");
	});

	it("round-trips every compact and fallback payload shape emitted by the v3 writer", async () => {
		installBrowser("/bobbit", "https://gateway.example/team/gw");
		const parse = await historicalParser();
		const cases = [
			{ name: "compact content hash and artifact id", entry: "x.html", hash: "a".repeat(64), artifactId: "pa_abc123xyz", compact: true, metadata: ["contentHash", "artifactId"] },
			{ name: "compact content hash and aid alias", entry: `${"x".repeat(7)}.html`, hash: "a".repeat(64), artifactId: "pa_abc123xyz", compact: true, metadata: ["contentHash", "aid"] },
			{ name: "compact artifact fallback without hash", entry: `${"x".repeat(20)}.html`, hash: undefined, artifactId: "pa_abc123xyz", compact: true, metadata: ["artifactId"] },
			{ name: "compact aid fallback without hash", entry: `${"x".repeat(47)}.html`, hash: undefined, artifactId: "pa_abc123xyz", compact: true, metadata: ["aid"] },
			{ name: "full URL fallback without optional metadata", entry: "report.html", hash: undefined, artifactId: undefined, compact: false, metadata: [] },
		] as const;

		for (const fixture of cases) {
			const url = `/preview/${SID}/${fixture.entry}`;
			const block = buildPreviewSnapshotV3Block(url, `${SID}/${fixture.entry}`, fixture.hash, {
				artifactId: fixture.artifactId,
				entry: fixture.entry,
			});
			assert.ok(block.length <= 250, `${fixture.name} must respect the marker cap`);
			const snapshot = parseSnapshot(block);
			assert.ok(snapshot && snapshot.kind === "preview");
			if (!snapshot || snapshot.kind !== "preview") continue;
			const payload = JSON.parse(block.slice("__preview_snapshot_v3__\n".length));
			assert.equal(snapshot.url.endsWith("/"), fixture.compact, fixture.name);
			assert.deepEqual(
				["contentHash", "artifactId", "aid"].filter(key => payload[key] !== undefined),
				fixture.metadata,
				fixture.name,
			);
			assert.equal(decodeV3Snapshot(block, parse), url, fixture.name);
		}
	});

	it.each([
		`https://other.example/team/gw/preview/${SID}/index.html`,
		`/preview-other/${SID}/index.html`,
		"/old/preview/not-a-uuid/index.html",
		`/old/preview/${SID}/../secret`,
		`/old/preview/${SID}/%2e%2e/secret`,
		`/old/preview/${SID}//index.html`,
		`javascript:alert(1)/preview/${SID}/index.html`,
	])("rejects historical lookalike %j", async (raw) => {
		installBrowser("/bobbit", "https://gateway.example/team/gw");
		const parse = await historicalParser();
		assert.equal(parse(raw), null);
	});
});
