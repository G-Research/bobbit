/**
 * Guardrail test for `defaults/roles/qa-tester.yaml`.
 *
 * The QA role must NOT instruct the agent to embed screenshots as base64
 * data URIs in the HTML report — screenshots are spilled to disk via
 * `browser_screenshot(includeBase64=true)` and referenced as file:// paths,
 * which the server inlines when the report is submitted.
 *
 * We allow:
 *  - the literal parameter name `includeBase64` (it's an API surface)
 *  - prohibitions ("never paste base64", "Do NOT paste base64 data URIs")
 *
 * We reject:
 *  - any instruction to EMBED / EMIT base64 / data URIs in the report.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const roleFile = path.resolve(__dirname, "../defaults/roles/qa-tester.yaml");

test("qa-tester.yaml does not instruct the agent to embed base64 / data URIs", () => {
	const text = fs.readFileSync(roleFile, "utf-8");

	// Split into lines so we can classify each occurrence in context.
	const lines = text.split(/\r?\n/);
	const offenders: string[] = [];

	const BAD_INSTRUCTIONS = [
		/embed\s+screenshots?\s+(as\s+)?base64/i,
		/embed\s+.*base64\s+data\s+uri/i,
		/paste\s+.*data:image/i,
		/insert\s+.*data:image/i,
		/include\s+screenshots?\s+(as\s+)?base64/i,
		// Direct reference to data URIs as the mechanism (not a prohibition)
		/use\s+.*data:image.*(in|for)\s+.*report/i,
	];

	for (const [idx, raw] of lines.entries()) {
		const line = raw;
		// Skip lines that are prohibitions.
		const isProhibition = /\b(never|do not|don't|do NOT)\b/i.test(line);
		if (isProhibition) continue;

		for (const re of BAD_INSTRUCTIONS) {
			if (re.test(line)) {
				offenders.push(`line ${idx + 1}: ${line.trim()}`);
				break;
			}
		}
	}

	assert.deepEqual(
		offenders,
		[],
		`qa-tester.yaml contains instructions to embed base64/data URIs:\n${offenders.join("\n")}`,
	);

	// Also assert the positive guidance is present: the role must tell the
	// agent to reference screenshots via file:// absolute paths.
	assert.match(
		text,
		/file:\/\/\/?<path>|file:\/\/\/?<path>\"|\[screenshot_file\]/,
		"qa-tester.yaml must document the [screenshot_file] / file:// mechanism",
	);
	assert.match(
		text,
		/server\s+inlines/i,
		"qa-tester.yaml must mention that the server inlines file:// refs",
	);
});
