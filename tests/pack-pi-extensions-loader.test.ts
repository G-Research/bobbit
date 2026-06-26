import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PackManifest } from "../src/server/agent/pack-types.js";
import { PackContributionError } from "../src/server/agent/pack-contributions.js";
import {
	isSafePiExtensionListName,
	loadPiExtensionContributions,
	loadPiExtensionContributionsWithDiscovery,
	resolvePiExtensionEntry,
} from "../src/server/agent/pi-extension-contributions.js";

function tempPack(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pi-ext-pack-"));
}

function manifest(piExtensions: string[]): PackManifest {
	return {
		schema: 2,
		name: "demo-pack",
		description: "demo",
		version: "1.0.0",
		contents: { roles: [], tools: [], skills: [], entrypoints: [], providers: [], hooks: [], mcp: [], piExtensions, runtimes: [], workflows: [] },
	};
}

function write(file: string, text = "export default function () {}\n"): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text, "utf-8");
}

describe("pi extension contribution loader", () => {
	it("uses package.json exports before module/main and default entry filenames", () => {
		const pack = tempPack();
		try {
			write(path.join(pack, "pi-extensions", "demo", "src", "exported.js"));
			write(path.join(pack, "pi-extensions", "demo", "src", "module.js"));
			write(path.join(pack, "pi-extensions", "demo", "src", "main.js"));
			write(path.join(pack, "pi-extensions", "demo", "extension.ts"));
			write(path.join(pack, "pi-extensions", "demo", "package.json"), JSON.stringify({ exports: "./src/exported.js", module: "./src/module.js", main: "./src/main.js" }));
			const [contribution] = loadPiExtensionContributions(pack, manifest(["demo"]));
			assert.equal(contribution.entryRelativePath, "pi-extensions/demo/src/exported.js");
			assert.equal(contribution.diagnostic.status, "ok");
			assert.equal(contribution.discovery.status, "skipped");
		} finally {
			fs.rmSync(pack, { recursive: true, force: true });
		}
	});

	it("falls back through extension.ts/js and index.ts/js/mjs/cjs in deterministic order", () => {
		const pack = tempPack();
		try {
			write(path.join(pack, "pi-extensions", "demo", "extension.js"));
			write(path.join(pack, "pi-extensions", "demo", "index.ts"));
			const first = resolvePiExtensionEntry(pack, "demo", manifest(["demo"]));
			assert.equal(first.entryRelativePath, "pi-extensions/demo/extension.js");

			fs.rmSync(path.join(pack, "pi-extensions", "demo", "extension.js"));
			const second = resolvePiExtensionEntry(pack, "demo", manifest(["demo"]));
			assert.equal(second.entryRelativePath, "pi-extensions/demo/index.ts");
		} finally {
			fs.rmSync(pack, { recursive: true, force: true });
		}
	});

	it("resolves single-file extension entries after directory candidates", () => {
		const pack = tempPack();
		try {
			write(path.join(pack, "pi-extensions", "demo.mjs"));
			const [contribution] = loadPiExtensionContributions(pack, manifest(["demo"]));
			assert.equal(contribution.entryRelativePath, "pi-extensions/demo.mjs");
			assert.equal(contribution.diagnostic.code, "resolved");
		} finally {
			fs.rmSync(pack, { recursive: true, force: true });
		}
	});

	it("returns unresolved catalogue rows for malformed and missing refs", () => {
		const pack = tempPack();
		try {
			const rows = loadPiExtensionContributions(pack, manifest([".hidden", "con", "missing"]));
			assert.equal(rows.length, 3);
			assert.deepEqual(rows.map((row) => row.diagnostic.status), ["unresolved", "unresolved", "unresolved"]);
			assert.equal(rows[0].diagnostic.code, "invalid_list_name");
			assert.equal(rows[1].diagnostic.code, "invalid_list_name");
			assert.equal(rows[2].diagnostic.code, "entry_not_found");
			assert.equal(rows[2].entryPath, undefined);
		} finally {
			fs.rmSync(pack, { recursive: true, force: true });
		}
	});

	it("rejects duplicate list names as a hard pack contribution error", () => {
		const pack = tempPack();
		try {
			write(path.join(pack, "pi-extensions", "demo.js"));
			assert.throws(() => loadPiExtensionContributions(pack, manifest(["demo", "demo"])), PackContributionError);
		} finally {
			fs.rmSync(pack, { recursive: true, force: true });
		}
	});

	it("keeps disabled refs visible but marks diagnostics disabled", () => {
		const pack = tempPack();
		try {
			write(path.join(pack, "pi-extensions", "demo.js"));
			const [row] = loadPiExtensionContributions(pack, manifest(["demo"]), { disabledRefs: ["demo"] });
			assert.equal(row.entryRelativePath, "pi-extensions/demo.js");
			assert.equal(row.diagnostic.status, "disabled");
			assert.equal(row.diagnostic.code, "activation_disabled");
		} finally {
			fs.rmSync(pack, { recursive: true, force: true });
		}
	});

	it("can enrich enabled resolved rows with executable discovery results", async () => {
		const pack = tempPack();
		try {
			write(path.join(pack, "pi-extensions", "demo.mjs"), "export default function (pi) { pi.registerTool({ name: 'demo_tool' }); }\n");
			const [row] = await loadPiExtensionContributionsWithDiscovery(pack, manifest(["demo"]), { trustAccepted: true });
			assert.equal(row.diagnostic.status, "ok");
			assert.equal(row.discovery.status, "ok");
			assert.deepEqual(row.discovery.tools.map((tool) => tool.name), ["demo_tool"]);
		} finally {
			fs.rmSync(pack, { recursive: true, force: true });
		}
	});

	it("enforces stricter pi extension list-name safety", () => {
		assert.equal(isSafePiExtensionListName("demo.ext-1"), true);
		for (const unsafe of [".demo", "../demo", "demo/child", "demo\\child", "con", "nul.txt", "", "a..b"]) {
			assert.equal(isSafePiExtensionListName(unsafe), false, unsafe);
		}
	});

	it("rejects symlink entries that escape pi-extensions containment", { skip: process.platform === "win32" }, () => {
		const pack = tempPack();
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pi-ext-outside-"));
		try {
			write(path.join(outside, "extension.js"));
			fs.mkdirSync(path.join(pack, "pi-extensions"), { recursive: true });
			fs.symlinkSync(outside, path.join(pack, "pi-extensions", "escape"), "dir");
			const [row] = loadPiExtensionContributions(pack, manifest(["escape"]));
			assert.equal(row.diagnostic.status, "unresolved");
			assert.equal(row.diagnostic.code, "entry_path_escapes");
			assert.equal(row.entryPath, undefined);
		} finally {
			fs.rmSync(pack, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});
});
