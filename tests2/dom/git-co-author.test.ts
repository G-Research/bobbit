// Migrated from tests/git-co-author.spec.ts (v2-dom tier).
// The legacy Playwright fixture exposed `injectCoAuthorTrailer(command, model)`
// on `window`. The real implementation in defaults/tools/shell/extension.ts is
// module-private and has a different signature (it reads the model from a
// per-session file via `sessionId`), so — as the legacy spec did — we exercise
// the fixture's faithful copy of the trailer-injection logic directly. No DOM.
import { describe, expect, it } from "vitest";

function injectCoAuthorTrailer(command: string, modelName: string): string {
	// Match git commit commands
	const gitCommitPattern = /\bgit\s+commit\b/;
	if (!gitCommitPattern.test(command)) return command;

	// Don't add if already has Co-Authored-By trailer
	if (/--trailer\s+["']?Co-Authored/i.test(command)) return command;

	// Don't intercept merge/revert/cherry-pick
	if (/\bgit\s+(merge|revert|cherry-pick)\b/.test(command)) return command;

	// Strip provider suffix like " (anthropic)" to keep it clean
	const cleanModel = modelName ? modelName.replace(/\s*\([^)]*\)\s*$/, "") : "";
	const author = cleanModel ? `Bobbit (${cleanModel})` : "Bobbit";
	const trailer = `--trailer "Co-Authored-By: ${author} <bobbit@bobbit.ai>"`;

	return command.replace(
		/(\bgit\s+commit\b(?:\s+[^&|;]*)?)/g,
		(match) => {
			if (match.includes("--trailer")) return match;
			return match.trimEnd() + " " + trailer;
		},
	);
}

function inject(command: string, modelName = "Claude Sonnet 4.6 (aws)"): string {
	return injectCoAuthorTrailer(command, modelName);
}

describe("injectCoAuthorTrailer", () => {
	it("appends trailer to simple git commit", () => {
		expect(inject('git commit -m "msg"')).toContain(
			'--trailer "Co-Authored-By: Bobbit (Claude Sonnet 4.6) <bobbit@bobbit.ai>"',
		);
	});

	it("uses plain Bobbit when no model name", () => {
		expect(inject('git commit -m "msg"', "")).toContain(
			'--trailer "Co-Authored-By: Bobbit <bobbit@bobbit.ai>"',
		);
	});

	it("handles chained commands", () => {
		const result = inject('git add . && git commit -m "msg"');
		expect(result).toContain("git add .");
		expect(result).toContain("--trailer");
	});

	it("does not modify git log", () => {
		expect(inject("git log --oneline")).toBe("git log --oneline");
	});

	it("does not modify git merge", () => {
		expect(inject("git merge --no-edit")).toBe("git merge --no-edit");
	});

	it("does not modify git revert", () => {
		expect(inject("git revert HEAD")).toBe("git revert HEAD");
	});

	it("does not modify git cherry-pick", () => {
		expect(inject("git cherry-pick abc123")).toBe("git cherry-pick abc123");
	});

	it("skips if already has Co-Authored-By trailer", () => {
		const cmd = 'git commit -m "msg" --trailer "Co-Authored-By: Someone"';
		expect(inject(cmd)).toBe(cmd);
	});

	it("handles git commit --amend", () => {
		expect(inject("git commit --amend")).toContain("--trailer");
	});

	it("handles git commit --amend -m", () => {
		expect(inject('git commit --amend -m "new msg"')).toContain("--trailer");
	});

	it("handles piped input", () => {
		expect(inject("echo msg | git commit -F -")).toContain("--trailer");
	});

	it("does not match git log --grep=commit", () => {
		expect(inject("git log --grep=commit")).toBe("git log --grep=commit");
	});

	it("modifies only commit in chained git diff && git commit", () => {
		const result = inject('git diff && git commit -m "x"');
		expect(result).toMatch(/^git diff && git commit/);
		expect(result).toContain("--trailer");
	});
});
