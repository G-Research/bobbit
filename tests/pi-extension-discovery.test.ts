import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverPiExtensionTools } from "../src/server/agent/pi-extension-discovery.js";
import { computePiExtensionDiscoveryCacheKey } from "../src/server/agent/pi-extension-contributions.js";

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
