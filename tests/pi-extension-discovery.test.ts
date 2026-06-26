import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverPiExtensionTools, discoverPiExtensionToolsSync } from "../src/server/agent/pi-extension-discovery.js";
import {
	computePiExtensionDiscoveryCacheKey,
	computePiExtensionDiscoveryCacheKeyWithDiagnostics,
	PI_EXTENSION_DISCOVERY_HASH_LIMITS,
	loadPiExtensionContributionsWithDiscoverySync,
} from "../src/server/agent/pi-extension-contributions.js";

function tempDir(prefix = "bobbit-pi-ext-discovery-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file: string, text: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text, "utf-8");
	return file;
}

describe("pi extension discovery", () => {
	it("skips executable probing before trust and does not import extension code", async () => {
		const dir = tempDir();
		try {
			const marker = path.join(dir, "executed.txt").replace(/\\/g, "\\\\");
			const entry = write(path.join(dir, "extension.mjs"), `import fs from "node:fs"; fs.writeFileSync("${marker}", "ran"); export default function (pi) { pi.registerTool({ name: "should_not_run" }); }`);
			const result = await discoverPiExtensionTools(entry, { trustAccepted: false });
			assert.equal(result.status, "skipped");
			assert.equal(result.tools.length, 0);
			assert.equal(fs.existsSync(path.join(dir, "executed.txt")), false);
			assert.ok(result.cacheKey);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("records tools from common pi registration APIs in a trusted child process", async () => {
		const dir = tempDir();
		try {
			const entry = write(path.join(dir, "extension.mjs"), `
export default async function (pi) {
  pi.registerTool({ name: "object_tool", description: "object desc", inputSchema: { type: "object", properties: { value: { type: "string" } } } });
  pi.tool("string_tool", { description: "string desc", schema: { type: "object" } }, async () => {});
  pi.tools.register({ name: "nested_tool", parameters: { type: "object", properties: {} } });
}
`);
			const result = await discoverPiExtensionTools(entry, { trustAccepted: true });
			assert.equal(result.status, "ok", result.diagnostic?.message);
			assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ["nested_tool", "object_tool", "string_tool"]);
			assert.equal(result.tools.find((tool) => tool.name === "object_tool")?.description, "object desc");
			assert.deepEqual(result.tools.find((tool) => tool.name === "string_tool")?.inputSchema, { type: "object" });
			assert.ok(result.cacheKey);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("sync contribution discovery preserves static rows without executing untrusted extension code", () => {
		const dir = tempDir();
		try {
			const packRoot = path.join(dir, "pack");
			const marker = path.join(packRoot, "executed.txt").replace(/\\/g, "\\\\");
			write(path.join(packRoot, "pi-extensions", "demo", "extension.js"), `import fs from "node:fs"; fs.writeFileSync("${marker}", "ran"); export default function (pi) { pi.registerTool({ name: "should_not_run" }); }`);
			const rows = loadPiExtensionContributionsWithDiscoverySync(packRoot, { schema: 2, name: "pack", contents: { piExtensions: ["demo"] } } as any, { trustAccepted: false });
			assert.equal(rows.length, 1);
			assert.equal(rows[0].discovery.status, "skipped");
			assert.equal(rows[0].discovery.diagnostic?.code, "trust_required");
			assert.equal(fs.existsSync(path.join(packRoot, "executed.txt")), false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("records tools synchronously for session-start resolver cache misses", () => {
		const dir = tempDir();
		try {
			const entry = write(path.join(dir, "extension.mjs"), "export default function (pi) { pi.registerTool({ name: 'sync_tool' }); }\n");
			const result = discoverPiExtensionToolsSync(entry, { trustAccepted: true });
			assert.equal(result.status, "ok", result.diagnostic?.message);
			assert.deepEqual(result.tools.map((tool) => tool.name), ["sync_tool"]);
			assert.ok(result.cacheKey);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("transpiles trusted TypeScript extension entries without relying on a Node TS loader", () => {
		const dir = tempDir();
		try {
			write(path.join(dir, "helper.ts"), "export const toolName: string = 'ts_tool';\n");
			const entry = write(path.join(dir, "extension.ts"), "import { toolName } from './helper.ts';\nexport default function (pi: any): void { pi.registerTool({ name: toolName, description: 'from ts' }); }\n");
			const result = discoverPiExtensionToolsSync(entry, { trustAccepted: true });
			assert.equal(result.status, "ok", result.diagnostic?.message);
			assert.deepEqual(result.tools.map((tool) => tool.name), ["ts_tool"]);
			assert.equal(result.tools[0]?.description, "from ts");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("confines trusted probes to read-only source access", async () => {
		const dir = tempDir();
		const outside = tempDir("bobbit-pi-ext-outside-");
		try {
			const inPack = path.join(dir, "inside.txt").replace(/\\/g, "\\\\");
			const outPack = path.join(outside, "outside.txt").replace(/\\/g, "\\\\");
			const entry = write(path.join(dir, "extension.mjs"), `import fs from "node:fs"; export default function () { fs.writeFileSync("${inPack}", "x"); fs.writeFileSync("${outPack}", "x"); }\n`);
			const result = await discoverPiExtensionTools(entry, { trustAccepted: true });
			assert.equal(result.status, "failed");
			assert.equal(result.diagnostic?.code, "PROBE_FS_WRITE_DENIED");
			assert.equal(fs.existsSync(path.join(dir, "inside.txt")), false);
			assert.equal(fs.existsSync(path.join(outside, "outside.txt")), false);

			const promisesTarget = path.join(dir, "promises.txt").replace(/\\/g, "\\\\");
			const promisesEntry = write(path.join(dir, "extension-promises.mjs"), `import { writeFile } from "node:fs/promises"; export default async function () { await writeFile("${promisesTarget}", "x"); }\n`);
			const promisesResult = await discoverPiExtensionTools(promisesEntry, { trustAccepted: true });
			assert.equal(promisesResult.status, "failed");
			assert.equal(promisesResult.diagnostic?.code, "PROBE_FS_WRITE_DENIED");
			assert.equal(fs.existsSync(path.join(dir, "promises.txt")), false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it("blocks network and child-process modules during trusted probes", async () => {
		const dir = tempDir();
		try {
			const childEntry = write(path.join(dir, "child.mjs"), `import "node:child_process"; export default function () {}\n`);
			const childResult = await discoverPiExtensionTools(childEntry, { trustAccepted: true });
			assert.equal(childResult.status, "failed");
			assert.equal(childResult.diagnostic?.code, "PROBE_CONFINEMENT_DENIED");

			const httpEntry = write(path.join(dir, "http.mjs"), `import http from "node:http"; export default function () { http.get("http://127.0.0.1/"); }\n`);
			const httpResult = await discoverPiExtensionTools(httpEntry, { trustAccepted: true });
			assert.equal(httpResult.status, "failed");
			assert.equal(httpResult.diagnostic?.code, "PROBE_CONFINEMENT_DENIED");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports syntax and missing dependency failures without throwing", async () => {
		const dir = tempDir();
		try {
			const badSyntax = write(path.join(dir, "bad-syntax.mjs"), "export default function () {\n");
			const syntaxResult = await discoverPiExtensionTools(badSyntax, { trustAccepted: true });
			assert.equal(syntaxResult.status, "failed");
			assert.equal(syntaxResult.diagnostic?.status, "discovery-failed");

			const missingDep = write(path.join(dir, "missing-dep.mjs"), "import 'definitely-not-a-real-package-for-bobbit-test'; export default function () {}\n");
			const missingResult = await discoverPiExtensionTools(missingDep, { trustAccepted: true });
			assert.equal(missingResult.status, "failed");
			assert.match(missingResult.diagnostic?.message ?? "", /package|module|Cannot find/i);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("bounds probing time and returns a timeout diagnostic", async () => {
		const dir = tempDir();
		try {
			const entry = write(path.join(dir, "hang.mjs"), "await new Promise(() => {}); export default function () {}\n");
			const result = await discoverPiExtensionTools(entry, { trustAccepted: true, timeoutMs: 100 });
			assert.equal(result.status, "failed");
			assert.equal(result.diagnostic?.code, "probe_timeout");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not write generated probe metadata into the extension source tree", async () => {
		const dir = tempDir();
		try {
			const entry = write(path.join(dir, "extension.mjs"), "export default function (pi) { pi.registerTool({ name: 'clean_probe' }); }\n");
			const before = fs.readdirSync(dir).sort();
			const result = await discoverPiExtensionTools(entry, { trustAccepted: true });
			assert.equal(result.status, "ok");
			assert.deepEqual(fs.readdirSync(dir).sort(), before);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("changes cache keys when local helper sources change", () => {
		const dir = tempDir();
		try {
			const entry = write(path.join(dir, "extension.mjs"), "import './helper.js'; export default function () {}\n");
			const helper = write(path.join(dir, "helper.js"), "export const value = 1;\n");
			const first = computePiExtensionDiscoveryCacheKey(entry);
			fs.writeFileSync(helper, "export const value = 2;\n", "utf-8");
			const second = computePiExtensionDiscoveryCacheKey(entry);
			assert.ok(first);
			assert.ok(second);
			assert.notEqual(first, second);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("bounds discovery cache key file count", () => {
		const dir = tempDir();
		try {
			const entry = write(path.join(dir, "extension.mjs"), "export default function () {}\n");
			for (let i = 0; i < PI_EXTENSION_DISCOVERY_HASH_LIMITS.maxFiles + 1; i++) {
				write(path.join(dir, `helper-${i}.js`), `export const value${i} = ${i};\n`);
			}
			const result = computePiExtensionDiscoveryCacheKeyWithDiagnostics(entry);
			assert.equal(result.cacheKey, undefined);
			assert.equal(result.diagnostic?.code, "hash_file_count_limit");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("bounds discovery cache key depth and per-file size", () => {
		const dir = tempDir();
		try {
			const entry = write(path.join(dir, "extension.mjs"), "export default function () {}\n");
			let nested = dir;
			for (let i = 0; i < PI_EXTENSION_DISCOVERY_HASH_LIMITS.maxDepth + 1; i++) nested = path.join(nested, `d${i}`);
			write(path.join(nested, "too-deep.js"), "export const deep = true;\n");
			const depthResult = computePiExtensionDiscoveryCacheKeyWithDiagnostics(entry);
			assert.equal(depthResult.diagnostic?.code, "hash_depth_limit");

			fs.rmSync(path.join(dir, "d0"), { recursive: true, force: true });
			write(path.join(dir, "large.js"), "x".repeat(PI_EXTENSION_DISCOVERY_HASH_LIMITS.maxFileBytes + 1));
			const sizeResult = computePiExtensionDiscoveryCacheKeyWithDiagnostics(entry);
			assert.equal(sizeResult.diagnostic?.code, "hash_file_size_limit");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves extension-level visibility when discovery fails", async () => {
		const dir = tempDir();
		try {
			const entry = write(path.join(dir, "throws.mjs"), "export default function () { throw new Error('activation boom'); }\n");
			const result = await discoverPiExtensionTools(entry, { trustAccepted: true });
			assert.equal(result.status, "failed");
			assert.equal(result.tools.length, 0);
			assert.equal(result.diagnostic?.status, "discovery-failed");
			assert.match(result.diagnostic?.message ?? "", /activation boom/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
