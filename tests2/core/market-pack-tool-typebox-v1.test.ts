import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const marketPacksRoot = path.join(repoRoot, "market-packs");

function findToolExtensions(root: string): string[] {
	const extensions: string[] = [];
	for (const pack of fs.readdirSync(root, { withFileTypes: true })) {
		if (!pack.isDirectory()) continue;
		const toolsRoot = path.join(root, pack.name, "tools");
		if (!fs.existsSync(toolsRoot)) continue;
		for (const tool of fs.readdirSync(toolsRoot, { withFileTypes: true })) {
			if (!tool.isDirectory()) continue;
			for (const filename of ["extension.ts", "extension.js", "extension.mjs", "extension.cjs"]) {
				const candidate = path.join(toolsRoot, tool.name, filename);
				if (fs.existsSync(candidate)) extensions.push(candidate);
			}
		}
	}
	return extensions.sort();
}

describe("shipped market-pack tool TypeBox compatibility", () => {
	it("uses TypeBox v1 schemas for every Pi tool extension", () => {
		const extensions = findToolExtensions(marketPacksRoot);
		assert.ok(extensions.length > 0, "expected at least one shipped market-pack tool extension");

		for (const extension of extensions) {
			const source = fs.readFileSync(extension, "utf8");
			const relativePath = path.relative(repoRoot, extension);
			assert.doesNotMatch(
				source,
				/["']@sinclair\/typebox["']/,
				`${relativePath} must not pass legacy @sinclair/typebox schemas to Pi v1`,
			);
			if (/\bregisterTool\s*\(/.test(source)) {
				assert.match(
					source,
					/\bfrom\s*["']typebox["']/,
					`${relativePath} registers Pi tools and must import TypeBox v1 from typebox`,
				);
			}
		}
	});
});
