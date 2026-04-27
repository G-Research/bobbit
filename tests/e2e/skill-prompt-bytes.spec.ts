/**
 * Byte-equality regression test: the model-facing prompt produced by the
 * skill-resolution pipeline must equal the pre-refactor handler block's
 * output for the same inputs.
 *
 * Strategy: place real SKILL.md fixtures under the harness's project root,
 * then for each test case compare:
 *   - the new resolveSkillExpansions(...).modelText
 *   - against a re-implementation of the legacy regex+splice algorithm.
 *
 * If both produce the same text for the same input, the model-facing path
 * is byte-equal (handler.ts now passes modelText to enqueuePrompt which
 * dispatches it via rpcClient.prompt verbatim).
 */
import { test, expect } from "./in-process-harness.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test.setTimeout(15_000);

function writeSkill(rootPath: string, name: string, body: string) {
	const dir = path.join(rootPath, ".claude", "skills", name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), body, "utf-8");
}

// Fresh cwd per file to avoid the 5s skill-discovery TTL cache returning
// stale entries from sibling test files.
const root = path.join(os.tmpdir(), `bobbit-byte-eq-${process.pid}-${Date.now()}`);
fs.mkdirSync(root, { recursive: true });

test.describe("model-prompt byte equality", () => {
	test.beforeAll(() => {
		writeSkill(root, "bytes-mockup",
			"---\nname: bytes-mockup\ndescription: Mockup builder\n---\nMOCKUP $ARGUMENTS"
		);
		writeSkill(root, "bytes-git",
			"---\nname: bytes-git\ndescription: Git rules\n---\nGIT-RULES"
		);
		writeSkill(root, "bytes-foo",
			"---\nname: bytes-foo\ndescription: Foo\n---\nFOO-BODY"
		);
	});

	test("six representative inputs match the legacy algorithm", async () => {
		// Import the new helpers via the dist build that the harness already loaded
		// (the in-process harness imports from dist/server/...).
		const { resolveSkillExpansions } = await import("../../dist/server/skills/resolve-skill-expansions.js");
		const { getSlashSkill, buildSlashSkillPrompt } = await import("../../dist/server/skills/slash-skills.js");
		const { buildActivationHeader } = await import("../../dist/server/skills/skill-manifest.js");

		// Legacy reference algorithm — copied verbatim from the pre-refactor
		// handler.ts inline block. Any change here is a deliberate spec change.
		function legacy(text: string): string {
			let promptText = text;
			const slashPattern = /(^|[\s])\/([\w-]+)/g;
			const replacements: Array<{ start: number; end: number; expanded: string }> = [];
			let m: RegExpExecArray | null;
			while ((m = slashPattern.exec(promptText)) !== null) {
				const skillName = m[2];
				const skill = getSlashSkill(root, skillName);
				if (!skill) continue;
				const prefixLen = m[1].length;
				const tokenStart = m.index + prefixLen;
				const tokenEnd = tokenStart + 1 + skillName.length;
				if (tokenStart === 0 && promptText.match(/^\/([\w-]+)(?:\s+(.*))?$/)) {
					const skillArgs = promptText.slice(tokenEnd).trim();
					promptText = buildActivationHeader(skill) + buildSlashSkillPrompt(skill, skillArgs);
					replacements.length = 0;
					break;
				}
				replacements.push({ start: tokenStart, end: tokenEnd, expanded: buildActivationHeader(skill) + buildSlashSkillPrompt(skill, "") });
			}
			for (let i = replacements.length - 1; i >= 0; i--) {
				const r = replacements[i];
				promptText = promptText.slice(0, r.start) + r.expanded + promptText.slice(r.end);
			}
			return promptText;
		}

		const cases = [
			"/bytes-mockup",                                    // prefix-only no args
			"/bytes-mockup hero header",                        // prefix-only with args
			"see /bytes-git for rules",                         // inline single
			"prefix /bytes-foo middle /bytes-git tail",         // multiple inline
			"just a normal user message",                       // no skills
			"/bytes-foo\nsee /bytes-git",                       // legacy-collapse: prefix-only matches
		];
		for (const c of cases) {
			const got = resolveSkillExpansions(c, root).modelText;
			const want = legacy(c);
			expect(got, `byte-equal failure for input ${JSON.stringify(c)}`).toBe(want);
		}
	});
});
