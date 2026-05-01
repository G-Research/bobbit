/**
 * Regression guard for the worktree-setup-cwd fallback bug.
 *
 * Two single-repo creation paths historically bypassed `runComponentSetups()`
 * and either ran the setup hook at the wrong cwd or skipped it entirely:
 *
 *   1. `src/server/agent/session-setup.ts::executeWorktreeAsync` passed
 *      `components[0].worktreeSetupCommand` through `createWorktree()` →
 *      `setupWorktreeDeps()`, which uses `cwd: worktreePath` and ignores
 *      `component.relativePath`.
 *
 *   2. `src/server/agent/goal-manager.ts::setupWorktree` single-repo branch
 *      called `createWorktree(...)` with no `setupCommand` at all, so the
 *      hook silently never ran.
 *
 * Both fallbacks must route through the canonical `runComponentSetups()` in
 * `src/server/skills/worktree-setup.ts` (which delegates cwd resolution to
 * `componentRoot()` honouring `relativePath`).
 *
 * This test is a pure source-grep guard — much cheaper than spinning up an
 * end-to-end worktree.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_ROOT = path.resolve(__dirname, "..", "src");

// Files that legitimately implement / declare the legacy plumbing. Every
// other source file passing `setupCommand` to createWorktree* or calling
// `setupWorktreeDeps(` is a regression.
const ALLOWED_REL = new Set<string>([
	path.join("server", "skills", "git.ts"),
	path.join("server", "skills", "worktree-setup.ts"),
]);

function walkSrc(): string[] {
	const out: string[] = [];
	function walk(dir: string) {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".bobbit") continue;
				walk(p);
				continue;
			}
			if (!entry.name.endsWith(".ts")) continue;
			out.push(p);
		}
	}
	walk(SRC_ROOT);
	return out;
}

function isAllowed(absPath: string): boolean {
	const rel = path.relative(SRC_ROOT, absPath);
	return ALLOWED_REL.has(rel);
}

describe("Worktree setup cwd — fallback paths must route through runComponentSetups()", () => {
	it("(a) no source file outside skills/git.ts and skills/worktree-setup.ts passes setupCommand to createWorktree[Set](", () => {
		const hits: string[] = [];
		// Match `setupCommand` appearing as a property in an options object passed
		// to createWorktree( or createWorktreeSet(. We scan a window of ~400 chars
		// after each createWorktree call so we cover multi-line option literals.
		for (const file of walkSrc()) {
			if (isAllowed(file)) continue;
			const body = fs.readFileSync(file, "utf-8");
			const callRe = /createWorktree(?:Set)?\s*\(/g;
			let m: RegExpExecArray | null;
			while ((m = callRe.exec(body)) !== null) {
				const window = body.slice(m.index, m.index + 600);
				// Stop at the matching closing brace of the options object.
				// Cheap heuristic: look for `setupCommand` before the next semicolon
				// that terminates the call's enclosing statement.
				const semi = window.indexOf(";");
				const slice = semi >= 0 ? window.slice(0, semi) : window;
				if (/\bsetupCommand\b/.test(slice)) {
					const lineNo = body.slice(0, m.index).split("\n").length;
					hits.push(`${path.relative(SRC_ROOT, file)}:${lineNo}`);
				}
			}
		}
		assert.deepEqual(
			hits,
			[],
			`setupCommand must not be passed to createWorktree(Set) outside skills/git.ts; offending sites: ${hits.join(", ")}`,
		);
	});

	it("(b) no source file outside skills/git.ts and skills/worktree-setup.ts calls setupWorktreeDeps(", () => {
		const hits: string[] = [];
		for (const file of walkSrc()) {
			if (isAllowed(file)) continue;
			const body = fs.readFileSync(file, "utf-8");
			if (/\bsetupWorktreeDeps\s*\(/.test(body)) {
				hits.push(path.relative(SRC_ROOT, file));
			}
		}
		assert.deepEqual(
			hits,
			[],
			`setupWorktreeDeps must only be called from skills/git.ts (legacy) — call runComponentSetups instead. Offending files: ${hits.join(", ")}`,
		);
	});

	it("(c) session-setup.ts::executeWorktreeAsync calls runComponentSetups", () => {
		const file = path.join(SRC_ROOT, "server", "agent", "session-setup.ts");
		const body = fs.readFileSync(file, "utf-8");
		// Locate the executeWorktreeAsync function body.
		const fnIdx = body.search(/function\s+executeWorktreeAsync\b|executeWorktreeAsync\s*[:=]\s*(?:async\s*)?\(/);
		assert.notEqual(fnIdx, -1, "executeWorktreeAsync must exist in session-setup.ts");
		// Take a generous window of the function body. The fallback branch must
		// invoke runComponentSetups after createWorktree.
		const tail = body.slice(fnIdx);
		assert.ok(
			/\brunComponentSetups\s*\(/.test(tail),
			"executeWorktreeAsync must call runComponentSetups (fallback path was bypassing per-component cwd resolution)",
		);
	});

	it("(d) goal-manager.ts::setupWorktree calls runComponentSetups in BOTH the multi-repo and single-repo branches", () => {
		const file = path.join(SRC_ROOT, "server", "agent", "goal-manager.ts");
		const body = fs.readFileSync(file, "utf-8");
		const fnIdx = body.search(/setupWorktree\s*\(/);
		assert.notEqual(fnIdx, -1, "setupWorktree must exist in goal-manager.ts");
		// The multi-repo branch already has one runComponentSetups call. After the
		// fix, the single-repo createWorktree branch adds a second. So we expect
		// AT LEAST two calls inside the file.
		const matches = body.match(/\brunComponentSetups\s*\(/g) || [];
		assert.ok(
			matches.length >= 2,
			`goal-manager.ts must call runComponentSetups at least twice (multi-repo + single-repo branches); found ${matches.length}. The single-repo createWorktree fallback is missing the runComponentSetups call.`,
		);
	});
});
