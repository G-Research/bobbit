import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { getRunRoot, isOwnedRunChild, isRunRootOwner } from "./run-isolation.js";
import { runFixtureCommand, type FixtureCommandOptions, type FixtureCommandResult } from "./spawn-with-retry.js";

export const GIT_TEMPLATE_PATH_ENV = "BOBBIT_V2_GIT_TEMPLATE_PATH";
export const GIT_TEMPLATE_DIGEST_ENV = "BOBBIT_V2_GIT_TEMPLATE_DIGEST";

const STATE_KEY = Symbol.for("bobbit.tests2.git-template-state");
const BOOTSTRAP_AUDIT_FILENAME = "bootstrap-audit.json";
const README = "# Bobbit test repository\n";
const GITATTRIBUTES = "* text=auto eol=lf\n";

export interface GitTemplateDescriptor {
	path: string;
	digest: string;
}

export interface GitTemplateBootstrapAudit {
	ownerPid: number;
	commands: string[][];
}

export type PrepareGitTemplateOptions =
	| { mode: "create" }
	| { mode: "adopt"; path: string | undefined; expectedDigest: string | undefined };

interface GitTemplateState {
	promise?: Promise<GitTemplateDescriptor>;
	path?: string;
	digest?: string;
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

function invalidTemplate(message: string): Error {
	return new Error(`[tests2/git-template] cannot adopt template: ${message}`);
}

function validateTemplateShape(repository: string): void {
	try {
		if (!statSync(repository).isDirectory()) throw invalidTemplate("source is not a directory");
		if (readFileSync(join(repository, "README.md"), "utf8") !== README) {
			throw invalidTemplate("README.md is missing or invalid");
		}
		if (readFileSync(join(repository, ".gitattributes"), "utf8") !== GITATTRIBUTES) {
			throw invalidTemplate(".gitattributes is missing or invalid");
		}
		if (readFileSync(join(repository, ".git", "HEAD"), "utf8").trim() !== "ref: refs/heads/master") {
			throw invalidTemplate("HEAD is missing or invalid");
		}
		const head = readFileSync(join(repository, ".git", "refs", "heads", "master"), "utf8").trim();
		if (!/^[0-9a-f]{40}$/i.test(head) || !existsSync(join(repository, ".git", "objects", head.slice(0, 2), head.slice(2)))) {
			throw invalidTemplate("initial commit object is missing or invalid");
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("[tests2/git-template]")) throw error;
		throw invalidTemplate("source is missing or incomplete");
	}
}

function adoptGitTemplate(path: string | undefined, expectedDigest: string | undefined): GitTemplateDescriptor {
	if (typeof path !== "string" || path.trim().length === 0) throw invalidTemplate(`missing ${GIT_TEMPLATE_PATH_ENV}`);
	if (typeof expectedDigest !== "string" || expectedDigest.trim().length === 0) {
		throw invalidTemplate(`missing ${GIT_TEMPLATE_DIGEST_ENV}`);
	}
	if (!/^[0-9a-f]{64}$/i.test(expectedDigest)) throw invalidTemplate("expected digest is invalid");

	const runRoot = getRunRoot();
	const requested = resolve(path);
	if (!isOwnedRunChild(runRoot, requested)) throw invalidTemplate("source must be an owned descendant of the run root");
	if (!existsSync(requested)) throw invalidTemplate("source is missing or incomplete");
	const canonical = realpathSync(requested);
	if (!isOwnedRunChild(runRoot, canonical)) throw invalidTemplate("source resolves outside the run root");
	validateTemplateShape(canonical);
	const digest = hashTree(canonical);
	if (digest !== expectedDigest) throw invalidTemplate("source digest does not match the coordinator handoff");

	const shared = state();
	if ((shared.path && shared.path !== canonical) || (shared.digest && shared.digest !== digest)) {
		throw invalidTemplate("handoff conflicts with the template already adopted by this worker");
	}
	shared.path = canonical;
	shared.digest = digest;
	return { path: canonical, digest };
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

/** Read the run-owned coordinator bootstrap audit used by the one-init probe. */
export function readGitTemplateBootstrapAudit(descriptor: GitTemplateDescriptor): GitTemplateBootstrapAudit {
	const source = realpathSync(descriptor.path);
	if (!isOwnedRunChild(getRunRoot(), source)) {
		throw new Error("[tests2/git-template] bootstrap audit source must be an owned descendant of the run root");
	}
	const audit = JSON.parse(readFileSync(join(dirname(source), BOOTSTRAP_AUDIT_FILENAME), "utf8")) as Partial<GitTemplateBootstrapAudit>;
	if (!Number.isSafeInteger(audit.ownerPid) || (audit.ownerPid ?? 0) <= 0
		|| !Array.isArray(audit.commands)
		|| audit.commands.some(command => !Array.isArray(command) || command.some(argument => typeof argument !== "string"))) {
		throw new Error("[tests2/git-template] coordinator bootstrap audit is missing or invalid");
	}
	return audit as GitTemplateBootstrapAudit;
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
 * Create the run-scoped immutable repository in the coordinator, or validate
 * and adopt its inherited descriptor in a worker. Adoption performs filesystem
 * validation only: workers never initialize, repair, or probe the source with
 * Git. The no-argument form remains available to non-Tier-1 fixture runners;
 * inherited handoff data always selects fail-closed adoption.
 */
export async function prepareGitTemplate(options?: PrepareGitTemplateOptions): Promise<GitTemplateDescriptor> {
	const explicitCoordinatorCreate = options?.mode === "create";
	const selected = options ?? (
		process.env[GIT_TEMPLATE_PATH_ENV] || process.env[GIT_TEMPLATE_DIGEST_ENV]
			? {
				mode: "adopt" as const,
				path: process.env[GIT_TEMPLATE_PATH_ENV],
				expectedDigest: process.env[GIT_TEMPLATE_DIGEST_ENV],
			}
			: { mode: "create" as const }
	);
	if (selected.mode === "adopt") return adoptGitTemplate(selected.path, selected.expectedDigest);
	if (explicitCoordinatorCreate && !isRunRootOwner()) {
		throw new Error("[tests2/git-template] explicit template creation is coordinator-only");
	}

	const shared = state();
	if (shared.path && shared.digest) return { path: shared.path, digest: shared.digest };
	if (shared.promise) return shared.promise;

	shared.promise = (async () => {
		const runRoot = getRunRoot();
		const container = explicitCoordinatorCreate
			? join(runRoot, "git-template")
			: mkdtempSync(join(runRoot, "git-template-legacy-"));
		const repository = join(container, "repo");
		const home = join(container, "home");
		if (explicitCoordinatorCreate && existsSync(container)) {
			throw new Error(`[tests2/git-template] coordinator template container already exists: ${container}`);
		}
		mkdirSync(repository, { recursive: true });
		mkdirSync(home);
		writeFileSync(join(home, "gitconfig"), "", "utf8");
		const env = createGitTemplateEnvironment(home);
		const bootstrapCommands: string[][] = [];
		const fixtureGit: GitTemplateCommandRunner = (args, cwd, commandOptions = {}) => {
			bootstrapCommands.push([...args]);
			return runFixtureCommand(
				"git",
				// Both settings are written locally below so every copied fixture remains
				// stable. Supplying them during bootstrap also prevents the committing
				// process itself from launching background maintenance before the local
				// config is available (macOS can otherwise leave maintenance.lock briefly).
				["-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args],
				{ ...commandOptions, cwd, env },
			);
		};
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
			validateTemplateShape(canonical);
			const descriptor = { path: canonical, digest: hashTree(canonical) };
			writeFileSync(join(container, BOOTSTRAP_AUDIT_FILENAME), JSON.stringify({
				ownerPid: process.pid,
				commands: bootstrapCommands,
			}, null, 2) + "\n", "utf8");
			shared.path = descriptor.path;
			shared.digest = descriptor.digest;
			return descriptor;
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
