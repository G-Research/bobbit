import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { runFixtureCommand } from "./spawn-with-retry.js";

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

function templateEnvironment(): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_CONFIG_NOSYSTEM: "1",
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
		mkdirSync(repository);
		const env = templateEnvironment();
		try {
			await runFixtureCommand("git", ["-c", "init.defaultBranch=master", "init", "--quiet", repository], { cwd: container, env });
			await runFixtureCommand("git", ["config", "user.name", "Bobbit Test"], { cwd: repository, env });
			await runFixtureCommand("git", ["config", "user.email", "bobbit-test@example.invalid"], { cwd: repository, env });
			await runFixtureCommand("git", ["config", "core.autocrlf", "false"], { cwd: repository, env });
			await runFixtureCommand("git", ["config", "commit.gpgsign", "false"], { cwd: repository, env });
			const hooks = join(repository, ".git", "hooks-disabled");
			mkdirSync(hooks);
			await runFixtureCommand("git", ["config", "core.hooksPath", hooks], { cwd: repository, env });
			writeFileSync(join(repository, "README.md"), README, "utf8");
			writeFileSync(join(repository, ".gitattributes"), GITATTRIBUTES, "utf8");
			await runFixtureCommand("git", ["add", "--", "README.md", ".gitattributes"], { cwd: repository, env });
			await runFixtureCommand("git", ["commit", "--quiet", "-m", "Initial fixture"], { cwd: repository, env });

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
