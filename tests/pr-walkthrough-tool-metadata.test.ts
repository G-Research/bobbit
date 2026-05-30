import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const groupDir = path.resolve("defaults/tools/pr-walkthrough");

function readToolText(file: string): string {
	return fs.readFileSync(path.join(groupDir, file), "utf-8");
}

function field(text: string, name: string): string | undefined {
	const match = text.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
	return match?.[1]?.replace(/^['\"]|['\"]$/g, "");
}

describe("PR walkthrough tool metadata", () => {
	it("defines readonly_bash as a PR walkthrough extension tool", () => {
		const text = readToolText("readonly_bash.yaml");
		assert.equal(field(text, "name"), "readonly_bash");
		assert.equal(field(text, "group"), "PR Walkthrough");
		assert.match(text, /params:\s*\[command, description\?, timeout\?\]/);
		assert.match(text, /type:\s*bobbit-extension/);
		assert.match(text, /extension:\s*extension\.ts/);
		assert.match(text, /read-only/i);
		assert.match(text, /Blocks writes/i);
		assert.match(text, /recursive searches from `\.`\/the repository root/i);
		assert.match(text, /hidden\/ignore override flags/i);
		assert.match(text, /trusted absolute paths outside the worktree/i);
	});

	it("defines submit_pr_walkthrough_yaml as a PR walkthrough extension tool", () => {
		const text = readToolText("submit.yaml");
		assert.equal(field(text, "name"), "submit_pr_walkthrough_yaml");
		assert.equal(field(text, "group"), "PR Walkthrough");
		assert.match(text, /params:\s*\[yaml\]/);
		assert.match(text, /type:\s*bobbit-extension/);
		assert.match(text, /extension:\s*extension\.ts/);
		assert.match(text, /YAML/);
	});

	it("extension registers only in walkthrough-scoped sessions and posts scoped YAML payloads", () => {
		const source = readToolText("extension.ts");
		assert.match(source, /const sessionId = process\.env\.BOBBIT_SESSION_ID/);
		assert.match(source, /const jobId = process\.env\.BOBBIT_WALKTHROUGH_JOB_ID/);
		assert.match(source, /const submissionProof = process\.env\.BOBBIT_WALKTHROUGH_SUBMIT_PROOF/);
		assert.match(source, /if \(!sessionId \|\| !jobId \|\| !submissionProof\) return/);
		assert.match(source, /name:\s*"readonly_bash"/);
		assert.match(source, /name:\s*"submit_pr_walkthrough_yaml"/);
		assert.match(source, /\/api\/internal\/pr-walkthrough\/submit-yaml/);
		assert.match(source, /X-Bobbit-Walkthrough-Submit-Proof/);
		assert.match(source, /JSON\.stringify\(\{ sessionId, jobId, yaml \}\)/);
	});

	it("readonly_bash extension calls the central policy and returns bounded inline output", () => {
		const source = readToolText("extension.ts");
		assert.match(source, /walkthrough-readonly-policy/);
		assert.match(source, /evaluateWalkthroughReadonlyCommand/);
		assert.match(source, /Command blocked by PR walkthrough read-only policy/);
		assert.match(source, /Use read-only PR\/diff inspection instead/);
		assert.match(source, /truncateTail/);
		assert.doesNotMatch(source, /createWriteStream|tmpdir|tempFilePath|Full output saved to/);
	});

	it("readonly_bash executes resolved trusted executables directly with a sanitized environment", () => {
		const source = readToolText("extension.ts");
		assert.match(source, /resolveTrustedExecutable/);
		assert.match(source, /TRUSTED_COMMANDS/);
		assert.match(source, /isPathInsideOrEqual/);
		assert.match(source, /refusing to use PATH\/current-directory resolution/);
		assert.match(source, /spawn\(executablePath, args, \{/);
		assert.match(source, /shell:\s*false/);
		assert.match(source, /getSanitizedEnv/);
		assert.match(source, /NO_COLOR:\s*"1"/);
		assert.match(source, /FORCE_COLOR:\s*"0"/);
		assert.doesNotMatch(source, /\/bin\/bash|cmd\.exe|\["-c"\]|\["\/c"\]/);
		assert.doesNotMatch(source, /\.\.\.process\.env/);
	});

	it("trusted executable resolution skips repo-local spoofed binaries", () => {
		const source = readToolText("extension.ts");
		assert.match(source, /export function resolveTrustedExecutable/);
		assert.match(source, /TRUSTED_COMMANDS\.has\(command\)/);
		assert.ok(source.includes("if (/[\\\\/]/.test(command)"));
		assert.ok(source.includes("readonly_bash only resolves bare trusted command names"));
		assert.match(source, /candidateExecutableNames\(command, platform, pathExt\)/);
		assert.match(source, /envPath\.split\(delimiter\)/);
		assert.match(source, /if \(!rawDir \|\| rawDir === "\." \|\| !path\.isAbsolute\(rawDir\)\) continue/);
		assert.match(source, /if \(isPathInsideOrEqual\(realDir, cwd, platform\)\) continue/);
		assert.match(source, /if \(isPathInsideOrEqual\(realCandidate, cwd, platform\)\) continue/);
		assert.match(source, /return realCandidate/);
		assert.match(source, /Unable to resolve trusted executable.*refusing to use PATH\/current-directory resolution/);
		assert.match(source, /readonly_bash blocked executable resolution/);
	});
});
