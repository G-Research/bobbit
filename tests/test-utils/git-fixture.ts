/**
 * Shared git-fixture helper for E2E / unit tests.
 *
 * `createGitFixtureRepo` scaffolds a throwaway git repo (init → identity →
 * one commit on `master`), optionally creating lightweight tags, extra local
 * branches, and fake `origin/<ref>` remote-tracking refs.
 *
 * HERMETIC + NON-INTERACTIVE — why this matters:
 * Every `git` invocation here runs through {@link runFixtureGit}, which injects
 * a hermetic, non-interactive environment ({@link gitFixtureEnv}) and forces
 * `commit.gpgsign=false`/`tag.gpgsign=false` per call. This makes the host's
 * global git config irrelevant: on a dev host whose `~/.gitconfig` sets
 * `tag.gpgsign = true` and points `GIT_EDITOR` at an interactive editor (e.g.
 * nvim), `git tag <name>` would otherwise become a signed/annotated tag that
 * needs a message → git launches the editor → blocks forever, keeping the
 * Playwright worker's event loop alive after `gw.shutdown()` and wedging the
 * whole E2E run (the "E2E never exits" hang). The hermetic env removes that
 * trap entirely — tags stay lightweight, no editor is ever spawned, and a
 * missing identity can't break commits. See the Issue Analysis gate and
 * docs/debugging.md.
 *
 * Use {@link runFixtureGit} (or {@link gitFixtureEnv}) for any ad-hoc git call
 * in a fixture so it inherits the same protection — never call `git` with a
 * bare `{ cwd }` in test setup.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Hermetic, non-interactive environment for fixture git invocations.
 *
 * - `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` = `/dev/null` → the host's global
 *   and system git config (gpgsign, editor, aliases, hooks) cannot leak in.
 *   git treats an unreadable config path as empty, so this is safe on every
 *   platform (on Windows a missing global config is the normal case).
 * - `GIT_TERMINAL_PROMPT=0` → never block on a credential prompt.
 * - `GIT_EDITOR=true` → if anything ever tries to launch an editor it returns
 *   instantly (exit 0) instead of blocking the worker.
 * - `GIT_AUTHOR_*` / `GIT_COMMITTER_*` → supply an identity, since neutralising
 *   the global config also strips the host's `user.name` / `user.email`.
 */
const HERMETIC_GIT_ENV: Readonly<Record<string, string>> = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	GIT_EDITOR: "true",
	GIT_AUTHOR_NAME: "test",
	GIT_AUTHOR_EMAIL: "test@bobbit.local",
	GIT_COMMITTER_NAME: "test",
	GIT_COMMITTER_EMAIL: "test@bobbit.local",
};

/**
 * Per-invocation `-c` overrides that disable signing regardless of any config
 * git might still see. Passed before the subcommand: `git -c … <subcommand>`.
 */
const NO_SIGN_FLAGS: readonly string[] = ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];

/**
 * Build the hermetic, non-interactive env for a fixture git child process.
 * Spread over the current `process.env` so `PATH` (and thus the git binary)
 * stays resolvable.
 */
export function gitFixtureEnv(): NodeJS.ProcessEnv {
	return { ...process.env, ...HERMETIC_GIT_ENV };
}

/**
 * Run a single `git` command hermetically (see {@link gitFixtureEnv}) and
 * return its trimmed stdout. Always use this for fixture git calls so the
 * host's gpgsign/editor config can never make git block or require an editor.
 */
export function runFixtureGit(cwd: string, args: string[]): string {
	const out = execFileSync("git", [...NO_SIGN_FLAGS, ...args], {
		cwd,
		env: gitFixtureEnv(),
		encoding: "utf-8",
		windowsHide: true,
	});
	return typeof out === "string" ? out.trim() : "";
}

export interface GitFixtureOptions {
	/** Initial branch name for the first commit. Default `"master"`. */
	branch?: string;
	/** Tag names to create (lightweight — never signed/annotated). */
	tags?: string[];
	/** Extra local branches to create after the initial commit. */
	extraBranches?: string[];
	/** Fake `origin/<ref>` remote-tracking refs to write under `.git`. */
	remoteRefs?: string[];
}

/**
 * Create a throwaway git repo at `dir`: init → identity → one commit, then any
 * requested tags / extra branches / fake remote-tracking refs.
 *
 * All git calls are hermetic and non-interactive — see the file header.
 */
export function createGitFixtureRepo(dir: string, opts?: GitFixtureOptions): void {
	const branch = opts?.branch ?? "master";
	mkdirSync(dir, { recursive: true });
	runFixtureGit(dir, ["init", "--quiet"]);
	runFixtureGit(dir, ["config", "user.email", "test@bobbit.local"]);
	runFixtureGit(dir, ["config", "user.name", "test"]);
	runFixtureGit(dir, ["config", "commit.gpgsign", "false"]);
	runFixtureGit(dir, ["config", "tag.gpgsign", "false"]);
	runFixtureGit(dir, ["checkout", "--quiet", "-b", branch]);
	writeFileSync(join(dir, "README.md"), "x\n");
	runFixtureGit(dir, ["add", "."]);
	runFixtureGit(dir, ["commit", "--quiet", "-m", "init"]);
	const head = runFixtureGit(dir, ["rev-parse", "HEAD"]);
	for (const t of opts?.tags ?? []) {
		runFixtureGit(dir, ["tag", t]);
	}
	for (const b of opts?.extraBranches ?? []) {
		runFixtureGit(dir, ["branch", b]);
	}
	for (const r of opts?.remoteRefs ?? []) {
		const refPath = join(dir, ".git", "refs", "remotes", "origin", r);
		mkdirSync(dirname(refPath), { recursive: true });
		writeFileSync(refPath, head + "\n");
	}
}
