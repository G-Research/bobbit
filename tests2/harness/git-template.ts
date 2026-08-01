import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { runFixtureCommand, type FixtureCommandOptions, type FixtureCommandResult } from "./spawn-with-retry.js";

const STATE_KEY = Symbol.for("bobbit.tests2.git-template-state");
const README = "# Bobbit test repository\n";
const GITATTRIBUTES = "* text=auto eol=lf\n";

interface GitTemplateState {
	promise?: Promise<string>;
	path?: string;
	digest?: string;
	cleanupRegistered?: boolean;
}

type ProcessWithTemplateState = NodeJS.Process & { [STATE_KEY]?: GitTemplateState };

function state(): GitTemplateState {
	const owner = process as ProcessWithTemplateState;
	return owner[STATE_KEY] ??= {};
}

function hashTree(root: string): string {
	const hash = createHash("sha256");
	const visit = (dir: string): void => {
		for (const entry of readdirSync(dir).sort()) {
			const full = join(dir, entry);
			const rel = relative(root, full).replace(/\\/g, "/");
			const stat = statSync(full);
			if (stat.isDirectory()) {
				hash.update(`d\0${rel}\0`);
				visit(full);
			} else if (stat.isFile()) {
				hash.update(`f\0${rel}\0`);
				hash.update(readFileSync(full));
			}
		}
	};
	visit(root);
	return hash.digest("hex");
}

function assertSafeDestination(source: string, destination: string): void {
	const target = resolve(destination);
	if (target === source || relative(source, target).split(/[\\/]/)[0] !== "..") {
		throw new Error(`[tests2/git-template] destination must be outside the immutable template: ${target}`);
	}
	if (existsSync(target)) {
		if (!statSync(target).isDirectory() || readdirSync(target).length > 0) {
			throw new Error(`[tests2/git-template] destination must be an empty directory or absent: ${target}`);
		}
	}
}

/**
 * Build a Git environment that cannot inherit an ambient repository, object
 * store, index, or command-scoped configuration. Fixture bootstrap can run in
 * parallel across Vitest projects, so an inherited GIT_DIR would make their
 * otherwise independent `git config` calls contend for one config.lock.
 */
export function createGitTemplateEnvironment(
	home: string,
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env = { ...source };
	for (const name of Object.keys(env)) {
		if (name.toUpperCase().startsWith("GIT_")) delete env[name];
	}
	return {
		...env,
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "",
		GIT_EDITOR: "true",
	};
}

function removeContainer(container: string): void {
	try {
		rmSync(container, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
	} catch {
		// Cleanup must never turn a green test run red because an antivirus scanner
		// briefly retained a handle. The OS temp directory remains the safe fallback.
	}
}

export type GitTemplateCommandRunner = (
	args: string[],
	cwd: string,
	options?: FixtureCommandOptions,
) => Promise<FixtureCommandResult>;

type InitialFixtureCommitState = "landed" | "absent" | "invalid";

/**
 * A Windows child-process close can report failure after Git has already
 * finalized the commit. Probe the committed tree before trying again: retrying
 * an already-landed initial commit deterministically becomes "nothing to
 * commit" and masks the successful repository initialization.
 *
 * This is exported as a narrow injected-runner seam so the ambiguous-close
 * recovery is testable without a real child process or timing assumptions.
 */
export async function commitInitialFixture(
	runGit: GitTemplateCommandRunner,
	repository: string,
): Promise<void> {
	let failure: unknown;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			// Commit attempts deliberately bypass runFixtureCommand's generic retry.
			// Each retry below is guarded by an authoritative repository-state probe.
			await runGit(["commit", "--quiet", "-m", "Initial fixture"], repository, { attempts: 1 });
			return;
		} catch (error) {
			failure = error;
			const commitState = await initialFixtureCommitState(runGit, repository);
			if (commitState === "landed") return;
			if (commitState === "invalid") {
				throw new Error("[tests2/git-template] initial commit reported failure after creating an unexpected repository state");
			}
		}
	}
	throw failure;
}

/** Classify a failed initial commit without ever retrying an existing HEAD. */
async function initialFixtureCommitState(runGit: GitTemplateCommandRunner, repository: string): Promise<InitialFixtureCommitState> {
	try {
		await runGit(["rev-parse", "--verify", "HEAD^{commit}"], repository, { attempts: 1 });
	} catch {
		return "absent";
	}
	try {
		const readme = await runGit(["show", "HEAD:README.md"], repository, { attempts: 1 });
		const attributes = await runGit(["show", "HEAD:.gitattributes"], repository, { attempts: 1 });
		await runGit(["diff", "--quiet", "--cached", "HEAD", "--"], repository, { attempts: 1 });
		await runGit(["diff", "--quiet", "HEAD", "--"], repository, { attempts: 1 });
		const status = await runGit(["status", "--porcelain", "--untracked-files=all"], repository, { attempts: 1 });
		return readme.stdout === README
			&& attributes.stdout === GITATTRIBUTES
			&& status.stdout.trim() === ""
			? "landed"
			: "invalid";
	} catch {
		return "invalid";
	}
}

/**
 * Prepare one committed `master` repository for this Vitest fork. The promise is
 * stored on `process`, so isolated module contexts in the same fork share the
 * same immutable source. This must run before installTier1SpawnGuard().
 *
 * The returned path is diagnostic only. Tests create writable repositories with
 * copyGitTemplate(); mutating this source is detected before the next copy.
 */
export async function prepareGitTemplate(): Promise<string> {
	const shared = state();
	if (shared.path && shared.digest) return shared.path;
	if (shared.promise) return shared.promise;

	shared.promise = (async () => {
		const container = mkdtempSync(join(tmpdir(), "bb-git-template-"));
		const repository = join(container, "repo");
		const home = join(container, "home");
		mkdirSync(repository);
		mkdirSync(home);
		writeFileSync(join(home, "gitconfig"), "", "utf8");
		const env = createGitTemplateEnvironment(home);
		const fixtureGit: GitTemplateCommandRunner = (args, cwd, options = {}) => runFixtureCommand(
			"git",
			// Both settings are written locally below so every copied fixture remains
			// stable. Supplying them during bootstrap also prevents the committing
			// process itself from launching background maintenance before the local
			// config is available (macOS can otherwise leave maintenance.lock briefly).
			["-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args],
			{ ...options, cwd, env },
		);
		try {
			await fixtureGit(["-c", "init.defaultBranch=master", "init", "--quiet", repository], container);
			await fixtureGit(["config", "user.name", "Bobbit Test"], repository);
			await fixtureGit(["config", "user.email", "bobbit-test@example.invalid"], repository);
			await fixtureGit(["config", "core.autocrlf", "false"], repository);
			await fixtureGit(["config", "commit.gpgsign", "false"], repository);
			await fixtureGit(["config", "maintenance.auto", "false"], repository);
			await fixtureGit(["config", "gc.auto", "0"], repository);
			const hooks = join(repository, ".git", "hooks-disabled");
			mkdirSync(hooks);
			await fixtureGit(["config", "core.hooksPath", hooks], repository);
			writeFileSync(join(repository, "README.md"), README, "utf8");
			writeFileSync(join(repository, ".gitattributes"), GITATTRIBUTES, "utf8");
			await fixtureGit(["add", "--", "README.md", ".gitattributes"], repository);
			await commitInitialFixture(fixtureGit, repository);

			const canonical = realpathSync(repository);
			shared.path = canonical;
			shared.digest = hashTree(canonical);
			if (!shared.cleanupRegistered) {
				shared.cleanupRegistered = true;
				process.once("exit", () => removeContainer(container));
			}
			return canonical;
		} catch (error) {
			removeContainer(container);
			throw error;
		}
	})().catch(error => {
		shared.promise = undefined;
		throw error;
	});
	return shared.promise;
}

/**
 * Copy the prepared repository into an absent or empty destination using only
 * fs.cpSync. The copy is writable and independent; the shared source is checked
 * for mutation before every copy.
 */
export function copyGitTemplate(destination: string): string {
	const shared = state();
	if (!shared.path || !shared.digest) {
		throw new Error("[tests2/git-template] template is not prepared; await prepareGitTemplate() before installing the tier-1 spawn guard");
	}
	if (typeof destination !== "string" || destination.trim().length === 0) {
		throw new TypeError("[tests2/git-template] destination must be a non-empty filesystem path");
	}
	if (hashTree(shared.path) !== shared.digest) {
		throw new Error("[tests2/git-template] immutable template was modified; tests must mutate only copyGitTemplate() destinations");
	}
	const target = resolve(destination);
	assertSafeDestination(shared.path, target);
	mkdirSync(dirname(target), { recursive: true });
	cpSync(shared.path, target, {
		recursive: true,
		force: false,
		errorOnExist: true,
		verbatimSymlinks: true,
	});
	return realpathSync(target);
}
