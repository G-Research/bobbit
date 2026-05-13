/**
 * Pinning test for `_syncThinkingTriggerLabel()` in
 * `src/ui/components/AgentInterface.ts`.
 *
 * Background: the thinking-selector trigger label is post-processed in
 * `_syncThinkingTriggerLabel()` after every render so that on narrow viewports
 * it can be abbreviated. The function looks the current level up in two local
 * Record literals (`abbrev` and `full`) and falls back to `*.off` when the
 * level isn't a key. If a new `ThinkingLevel` is added to `THINKING_LEVELS`
 * (e.g. "xhigh") but is *not* added to these two maps, the trigger silently
 * displays "Off" until the popover is reopened. This test pins both maps to
 * cover every level in `THINKING_LEVELS`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { THINKING_LEVELS } from "../src/shared/thinking-levels.js";

const ROOT = join(import.meta.dirname ?? ".", "..");
const SRC = join(ROOT, "src", "ui", "components", "AgentInterface.ts");

function extractFunctionBody(src: string, name: string): string {
	const idx = src.indexOf(`private ${name}(`);
	if (idx < 0) throw new Error(`Could not find function "${name}" in source`);
	// Find the opening brace of the function body.
	let i = src.indexOf("{", idx);
	if (i < 0) throw new Error(`No opening brace for "${name}"`);
	let depth = 0;
	const start = i;
	for (; i < src.length; i++) {
		const c = src[i];
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return src.slice(start, i + 1);
		}
	}
	throw new Error(`No closing brace for "${name}"`);
}

/** Extract keys from `const <name>: Record<...> = { foo: ..., bar: ... };` */
function extractRecordKeys(body: string, varName: string): Set<string> {
	const re = new RegExp(`const\\s+${varName}\\s*:\\s*Record<[^>]+>\\s*=\\s*\\{([\\s\\S]*?)\\}\\s*;`);
	const m = body.match(re);
	if (!m) throw new Error(`Could not find Record literal for "${varName}"`);
	const inner = m[1];
	const keys = new Set<string>();
	// Match either `key:` or `"key":` at the start of an entry.
	const keyRe = /(?:^|[,{\s])(?:"([^"]+)"|([A-Za-z_][\w]*))\s*:/g;
	let km: RegExpExecArray | null;
	while ((km = keyRe.exec(inner)) !== null) {
		keys.add(km[1] ?? km[2]);
	}
	return keys;
}

describe("_syncThinkingTriggerLabel: trigger-label maps cover every ThinkingLevel", () => {
	const src = readFileSync(SRC, "utf8");
	const body = extractFunctionBody(src, "_syncThinkingTriggerLabel");

	it("abbrev map has an entry for every ThinkingLevel", () => {
		const keys = extractRecordKeys(body, "abbrev");
		const missing = THINKING_LEVELS.filter(l => !keys.has(l));
		assert.deepEqual(
			missing,
			[],
			`abbrev map is missing keys: ${missing.join(", ")}. ` +
				`Every level in THINKING_LEVELS (${THINKING_LEVELS.join(", ")}) ` +
				`must have an abbreviation so the narrow-viewport trigger label ` +
				`doesn't silently fall back to "Off".`,
		);
	});

	it("full map has an entry for every ThinkingLevel", () => {
		const keys = extractRecordKeys(body, "full");
		const missing = THINKING_LEVELS.filter(l => !keys.has(l));
		assert.deepEqual(
			missing,
			[],
			`full map is missing keys: ${missing.join(", ")}. ` +
				`Every level in THINKING_LEVELS (${THINKING_LEVELS.join(", ")}) ` +
				`must have a full label so the wide-viewport trigger label ` +
				`doesn't silently fall back to "Off" after selecting that level.`,
		);
	});
});
