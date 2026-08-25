// authoritative metadata retirement guard retained at the historical test path.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

const PRODUCTION_ROOT = path.resolve("src");
const AIGW_MANAGER = path.resolve("src/server/agent/aigw-manager.ts");

function productionTypeScriptFiles(root = PRODUCTION_ROOT): string[] {
	return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const absolute = path.join(root, entry.name);
		if (entry.isDirectory()) return productionTypeScriptFiles(absolute);
		return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
	});
}

function productionSources(): Array<{ file: string; source: string }> {
	return productionTypeScriptFiles().map((file) => ({
		file: path.relative(process.cwd(), file).replaceAll("\\", "/"),
		source: fs.readFileSync(file, "utf8"),
	}));
}

describe("authoritative metadata retirement production boundary", () => {
	it("keeps historical OpenAI additions and context override shims out of production", () => {
		assert.equal(
			fs.existsSync(path.resolve("src/server/agent/openai-model-additions.ts")),
			false,
			"the obsolete historical additions module must remain deleted",
		);

		const retired = [
			"OPENAI_MODEL_ADDITIONS",
			"getOpenAIModelAdditions",
			"writeOpenAIModelAdditions",
			"writeContextWindowOverrides",
			"applyContextWindowOverrides",
			"openai-model-additions",
		];
		for (const { file, source } of productionSources()) {
			for (const symbol of retired) {
				assert.equal(source.includes(symbol), false, `${file} must not reference retired ${symbol}`);
			}
		}
	});

	it("allows model-family inference only at the legacy /v1/models boundary", () => {
		const references = productionSources().flatMap(({ file, source }) =>
			[...source.matchAll(/inferLegacyAigwMeta\s*\(/g)].map((match) => ({ file, index: match.index })),
		);
		assert.equal(references.length, 2, "expected exactly one declaration and one legacy fallback call");
		assert.deepEqual(
			[...new Set(references.map((reference) => reference.file))],
			["src/server/agent/aigw-manager.ts"],
			"no direct-Pi, well-known, custom, state-frame, or thinking path may infer model-family metadata",
		);

		const source = fs.readFileSync(AIGW_MANAGER, "utf8");
		const legacyRequest = source.indexOf("const modelsUrl =");
		assert.ok(legacyRequest >= 0, "legacy /v1/models discovery boundary should remain explicit");
		assert.ok(references[1].index > legacyRequest, "the sole call must remain after legacy /v1/models discovery begins");
		const wellKnown = source.slice(source.indexOf("export function translateWellKnown"), legacyRequest);
		assert.equal(
			/inferLegacyAigwMeta\s*\(/.test(wellKnown),
			false,
			"authoritative well-known translation must never invoke legacy inference",
		);
	});
});
