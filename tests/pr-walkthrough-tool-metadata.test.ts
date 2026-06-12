import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
	loadPolicy,
	normalizeReadonlyTimeout,
	readonlyPolicyImportSpecifiers,
} from "../market-packs/pr-walkthrough/tools/pr-walkthrough/extension.ts";

const groupDir = path.resolve("market-packs/pr-walkthrough/tools/pr-walkthrough");

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
		assert.equal(field(text, "renderer"), "src/ui/tools/renderers/BashRenderer.ts");
		assert.match(text, /read-only/i);
		assert.match(text, /Blocks writes/i);
		assert.match(text, /cross-PR\/cross-repo GitHub reads/i);
		assert.match(text, /must match that launched PR/i);
		assert.match(text, /`--repo`\/`-R`, and `--hostname` are rejected/i);
		assert.match(text, /recursive searches from `\.`\/the repository root/i);
		assert.match(text, /hidden\/ignore override flags/i);
		assert.match(text, /tail -f/i);
		assert.match(text, /timeouts must be finite and non-negative/i);
		assert.match(text, /clamped to 300 seconds/i);
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

	it("extension registers in any session and posts session-secret-authenticated YAML payloads (no proof secret)", () => {
		// host.agents reviewer migration (design Decision C): the env-gate + submit-proof
		// secret are GONE. Registration ≠ activation — the boundary is the pr-reviewer role
		// grant + the default-deny `PR Walkthrough` tool group. The tools register whenever
		// a session id is present; the server resolves the jobId from the pack-store binding
		// keyed by the verified X-Bobbit-Session-Secret caller.
		const source = readToolText("extension.ts");
		assert.match(source, /const sessionId = process\.env\.BOBBIT_SESSION_ID/);
		assert.match(source, /const sessionSecret = process\.env\.BOBBIT_SESSION_SECRET/);
		assert.match(source, /BOBBIT_WALKTHROUGH_TARGET_OWNER/);
		assert.match(source, /BOBBIT_WALKTHROUGH_TARGET_REPO/);
		assert.match(source, /BOBBIT_WALKTHROUGH_TARGET_NUMBER/);
		assert.match(source, /if \(!sessionId\) return/);
		assert.match(source, /name:\s*"readonly_bash"/);
		assert.match(source, /name:\s*"submit_pr_walkthrough_yaml"/);
		assert.match(source, /\/api\/internal\/pr-walkthrough\/submit-yaml/);
		assert.match(source, /"X-Bobbit-Session-Secret": sessionSecret/);
		assert.match(source, /JSON\.stringify\(\{ yaml \}\)/);
		// The submit-proof secret must be entirely gone from the tool.
		assert.doesNotMatch(source, /BOBBIT_WALKTHROUGH_JOB_ID/);
		assert.doesNotMatch(source, /BOBBIT_WALKTHROUGH_SUBMIT_PROOF/);
		assert.doesNotMatch(source, /X-Bobbit-Walkthrough-Submit-Proof/);
	});

	it("readonly_bash extension calls the central policy and returns bounded inline output", () => {
		const source = readToolText("extension.ts");
		assert.match(source, /walkthrough-readonly-policy/);
		assert.match(source, /evaluateWalkthroughReadonlyCommand/);
		assert.match(source, /getReadonlyPolicyOptions/);
		assert.match(source, /evaluate\(command, policyOptions\)/);
		assert.match(source, /Command blocked by PR walkthrough read-only policy/);
		assert.match(source, /Use read-only PR\/diff inspection instead/);
		assert.match(source, /truncateTail/);
		assert.match(source, /normalizeReadonlyTimeout/);
		assert.match(source, /Number\.isFinite\(timeout\)/);
		assert.match(source, /timeout < 0/);
		assert.match(source, /Math\.min\(timeout, MAX_TIMEOUT_SECONDS\)/);
		assert.doesNotMatch(source, /createWriteStream|tmpdir|tempFilePath|Full output saved to/);
	});

	it("resolves readonly policy imports for source and shipped built-in pack paths", () => {
		const sourceUrl = pathToFileURL(path.join(process.cwd(), "market-packs", "pr-walkthrough", "tools", "pr-walkthrough", "extension.ts")).href;
		assert.equal(
			readonlyPolicyImportSpecifiers(sourceUrl)[0],
			pathToFileURL(path.join(process.cwd(), "src", "server", "pr-walkthrough", "walkthrough-readonly-policy.ts")).href,
		);

		const distExtensionUrl = pathToFileURL(path.join(process.cwd(), "dist", "server", "builtin-packs", "market-packs", "pr-walkthrough", "tools", "pr-walkthrough", "extension.ts")).href;
		assert.equal(
			readonlyPolicyImportSpecifiers(distExtensionUrl)[1],
			pathToFileURL(path.join(process.cwd(), "dist", "server", "pr-walkthrough", "walkthrough-readonly-policy.js")).href,
		);
	});

	it("loads the readonly policy from the shipped built-in dist path", async () => {
		const distExtensionUrl = pathToFileURL(path.join(process.cwd(), "dist", "server", "builtin-packs", "market-packs", "pr-walkthrough", "tools", "pr-walkthrough", "extension.ts")).href;
		const expectedDistPolicy = pathToFileURL(path.join(process.cwd(), "dist", "server", "pr-walkthrough", "walkthrough-readonly-policy.js")).href;
		const evaluate = await loadPolicy(distExtensionUrl, async (specifier) => {
			if (specifier !== expectedDistPolicy) throw new Error("wrong import path");
			return { evaluateWalkthroughReadonlyCommand: () => ({ allowed: true, argv: ["dist-policy"] }) };
		});

		assert.deepEqual(evaluate("ignored"), { allowed: true, argv: ["dist-policy"] });
	});

	it("falls back to the bundled readonly policy from Docker-remapped pack paths", async () => {
		const attempted: string[] = [];
		const evaluate = await loadPolicy(
			"file:///market-packs-builtin/pr-walkthrough/tools/pr-walkthrough/extension.ts",
			async (specifier) => {
				attempted.push(specifier);
				throw new Error("not mounted in sandbox");
			},
		);

		assert.deepEqual(attempted, readonlyPolicyImportSpecifiers("file:///market-packs-builtin/pr-walkthrough/tools/pr-walkthrough/extension.ts"));
		assert.deepEqual(evaluate("cat README.md"), { allowed: true, argv: ["cat", "README.md"] });
		assert.equal(evaluate("rm README.md").allowed, false);
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
		assert.doesNotMatch(source, /\/bin\/bash|\["-c"\]|\["\/c"\]/);
		assert.doesNotMatch(source, /spawn\([^\n]*cmd\.exe/i);
		assert.doesNotMatch(source, /\.\.\.process\.env/);
	});

	it("readonly_bash clamps and rejects caller-provided timeouts", () => {
		assert.deepEqual(normalizeReadonlyTimeout(undefined), { ok: true, seconds: 300, clamped: false });
		assert.deepEqual(normalizeReadonlyTimeout(1.5), { ok: true, seconds: 1.5, clamped: false });
		assert.deepEqual(normalizeReadonlyTimeout(999), { ok: true, seconds: 300, clamped: true });
		assert.equal(normalizeReadonlyTimeout(-1).ok, false);
		assert.equal(normalizeReadonlyTimeout(Number.NaN).ok, false);
		assert.equal(normalizeReadonlyTimeout(Number.POSITIVE_INFINITY).ok, false);
	});

	it("readonly_bash handles aborts without leaving spawned children running", () => {
		const source = readToolText("extension.ts");
		assert.match(source, /abortSignal\?\.aborted\) return toolText\("readonly_bash interrupted before start\./);
		assert.match(source, /const abortHandler = \(\) => \{/);
		assert.match(source, /if \(child\.pid\) killProcessTree\(child\.pid\)/);
		assert.match(source, /if \(abortSignal\.aborted\) abortHandler\(\)/);
		assert.match(source, /Command interrupted; subprocess tree was killed/);
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
