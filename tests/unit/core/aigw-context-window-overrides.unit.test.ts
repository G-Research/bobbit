// retirement guard retained at the historical test path.

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

describe("AIGW metadata shim retirement", () => {
	it("contains no context-window override writer or generated-catalog parser", () => {
		const source = fs.readFileSync(path.resolve("src/server/agent/aigw-manager.ts"), "utf-8");
		for (const retired of [
			"writeContextWindowOverrides",
			"applyContextWindowOverrides",
			"parseModelsGeneratedText",
			"parseModelsGenerated",
		]) {
			assert.equal(source.includes(retired), false, `${retired} must remain retired`);
		}
	});

	it("confines model-family inference to the legacy /v1/models fallback", () => {
		const source = fs.readFileSync(path.resolve("src/server/agent/aigw-manager.ts"), "utf-8");
		const calls = [...source.matchAll(/inferLegacyAigwMeta\s*\(/g)].map((match) => match.index);
		assert.equal(calls.length, 2, "expected one declaration and one legacy fallback call");
		const fallback = source.indexOf("const modelsUrl =");
		assert.ok(fallback >= 0);
		assert.ok(calls[1] > fallback, "the only call must remain inside legacy /v1/models discovery");
		const translator = source.slice(source.indexOf("export function translateWellKnown"), fallback);
		assert.equal(/inferLegacyAigwMeta\s*\(/.test(translator), false);
	});
});
