import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest";

import { previewGatewayRoute, type GatewayRoute } from "../../src/shared/base-path.ts";
import { setPreviewRootForTesting, writeInline } from "../../src/server/preview/mount.ts";

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

async function historicalParser(): Promise<(raw: unknown) => GatewayRoute | null> {
	const boundary = await import("../../src/app/gateway-fetch.ts") as unknown as {
		previewRouteFromStoredValue(raw: unknown): GatewayRoute | null;
	};
	return boundary.previewRouteFromStoredValue;
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

	it.each([
		`https://other.example/team/gw/preview/${SID}/index.html`,
		`/preview-other/${SID}/index.html`,
		"/old/preview/not-a-uuid/index.html",
		`/old/preview/${SID}/../secret`,
		`/old/preview/${SID}/%2e%2e/secret`,
		`javascript:alert(1)/preview/${SID}/index.html`,
	])("rejects historical lookalike %j", async (raw) => {
		installBrowser("/bobbit", "https://gateway.example/team/gw");
		const parse = await historicalParser();
		assert.equal(parse(raw), null);
	});
});
