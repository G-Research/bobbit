import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SYSTEM_PROMPT = path.resolve(import.meta.dirname, "..", "..", "..", "defaults", "system-prompt.md");

describe("system prompt local Markdown images", () => {
	const text = readFileSync(SYSTEM_PROMPT, "utf8");
	const markdownSection = text.match(/## Output is rendered as Markdown[\s\S]*?(?=\n# [^#]|$)/)?.[0] ?? "";

	it("documents the session-relative image syntax without encouraging transcript-sized payloads", () => {
		expect(markdownSection).toContain("![Description](.bobbit-qa/screenshots/example.png)");
		expect(markdownSection).toContain("relative paths are preferred");
		expect(markdownSection).toContain("Do not paste base64 data or use raw HTML");
	});
});
