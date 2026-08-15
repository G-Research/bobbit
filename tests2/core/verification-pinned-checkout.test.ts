import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import type { CommandRunner, ExecFileOptions } from "../../src/server/gateway-deps.ts";
import type { GateSignal } from "../../src/server/agent/gate-store.ts";
import {
	computeVerificationContentDigestFromInventory,
	prefixVerificationSourceInventory,
	type VerificationSourceInventoryEntry,
} from "../../src/server/agent/verification-content-digest.ts";
import {
	PinnedCheckoutError,
	VerificationPinnedCheckoutManager,
} from "../../src/server/agent/verification-pinned-checkout.ts";
import { verificationCheckoutProjectDir, verificationCheckoutProjectScope } from "../../src/server/agent/verification-checkout-scope.ts";
import { copyGitTemplate } from "../harness/git-template.ts";
import { createRunChild } from "../harness/run-isolation.ts";

const HEAD = "a".repeat(40);
const SIGNAL_ID = "a0f0f0f0-0000-4000-8000-000000000001";

interface Fixture {
	base: string;
	root: string;
	state: string;
	head: string;
	inventory: { tracked: string[]; untracked: string[] };
	ignoredTopLevel: Set<string>;
}

interface GitCall {
	args: string[];
	options?: ExecFileOptions;
}

interface FakeGit {
	runner: CommandRunner;
	calls: GitCall[];
	failNextAdd(): void;
	failNextRemove(code?: "EBUSY" | "EACCES" | "EIO"): void;
	failRemoveTimes(count: number, code?: "EBUSY" | "EACCES" | "EIO"): void;
}

/** Deterministic timer seam: scheduled callbacks run only when tests advance it. */
function fakeClock() {
	let now = 0;
	let sequence = 0;
	const timers = new Map<number, { due: number; callback: () => void | Promise<void> }>();
	return {
		now: () => now,
		setTimeout: (callback: () => void | Promise<void>, delayMs: number) => {
			const id = ++sequence;
			timers.set(id, { due: now + delayMs, callback });
			return id as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimeout: (timer: ReturnType<typeof setTimeout>) => { timers.delete(timer as unknown as number); },
		async advance(milliseconds: number): Promise<void> {
			const deadline = now + milliseconds;
			while (true) {
				const due = [...timers.entries()]
					.filter(([, timer]) => timer.due <= deadline)
					.sort(([leftId, left], [rightId, right]) => left.due - right.due || leftId - rightId)[0];
				if (!due) break;
				const [id, timer] = due;
				timers.delete(id);
				now = timer.due;
				// The retry callback resolves only after its serialized cleanup attempt
				// has persisted and scheduled the next backoff (if any).
				await timer.callback();
			}
			now = deadline;
		},
		pending: () => timers.size,
	};
}

const roots: string[] = [];
afterEach(async () => {
	// The coordinator owns run-root cleanup. This removes only a child created by
	// this worker, so failed fixtures never leak into a later test in this file.
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(options: { symlink?: boolean } = {}): Promise<Fixture> {
	const base = createRunChild("pinned-checkout");
	roots.push(base);
	const root = path.join(base, "repo");
	copyGitTemplate(root);
	const state = path.join(base, "state");
	await writeFile(path.join(root, ".gitignore"), "ignored/\n");
	await writeFile(path.join(root, ".gitattributes"), "raw.txt text\n");
	await writeFile(path.join(root, "raw.txt"), "before\n");
	await writeFile(path.join(root, "staged.txt"), "before staging\n");
	await writeFile(path.join(root, "deleted.txt"), "delete me\n");
	await writeFile(path.join(root, "exec.sh"), "#!/bin/sh\necho old\n");
	await chmod(path.join(root, "exec.sh"), 0o755);
	const inventory = {
		tracked: [".gitignore", ".gitattributes", "raw.txt", "staged.txt", "deleted.txt", "exec.sh"],
		untracked: [] as string[],
	};
	if (options.symlink) {
		await symlink("raw.txt", path.join(root, "link"));
		inventory.tracked.push("link");
	}
	return { base, root, state, head: HEAD, inventory, ignoredTopLevel: new Set(["node_modules"]) };
}

function nul(entries: readonly string[]): Buffer {
	return Buffer.concat(entries.flatMap(entry => [Buffer.from(entry), Buffer.from("\0")]));
}

/**
 * A deterministic Git boundary: core tests never spawn, while the manager still
 * receives the exact worktree and NUL-inventory protocol it owns in production.
 */
function fakeGit(source: Fixture | readonly Fixture[]): FakeGit {
	const sources = Array.isArray(source) ? source : [source];
	const sourceFor = (command: string[]): Fixture => {
		const cwd = command[command.indexOf("-C") + 1];
		return sources.find(candidate => cwd && path.resolve(candidate.root) === path.resolve(cwd)) ?? sources[0]!;
	};
	const calls: GitCall[] = [];
	let failAdd = false;
	let failRemove: "EBUSY" | "EACCES" | "EIO" | undefined;
	let remainingRemoveFailures = 0;
	const empty = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
	return {
		calls,
		failNextAdd: () => { failAdd = true; },
		failNextRemove: (code = "EIO") => { failRemove = code; },
		failRemoveTimes: (count, code = "EIO") => { remainingRemoveFailures = count; failRemove = code; },
		runner: {
			execFile: async (file, args, options) => {
				assert.equal(file, "git", "manager invokes Git by executable, never a shell");
				const command = [...args];
				const selected = sourceFor(command);
				calls.push({ args: command, options });
				if (command.includes("--show-toplevel")) return { stdout: `${selected.root}\n`, stderr: "" };
				if (command.includes("--verify") && command.includes("HEAD^{commit}")) return { stdout: `${selected.head}\n`, stderr: "" };
				if (command.includes("ls-files")) {
					return { stdout: nul(command.includes("--cached") ? selected.inventory.tracked : selected.inventory.untracked), stderr: Buffer.alloc(0) };
				}
				if (command.includes("check-ignore")) {
					const candidate = command.at(-1)!;
					const directory = candidate.endsWith("/") ? candidate.slice(0, -1) : candidate;
					if (selected.ignoredTopLevel.has(directory) || candidate === "ignored" || candidate.startsWith("ignored/")) return empty;
					throw Object.assign(new Error("path is not ignored"), { code: 1 });
				}
				if (command.includes("worktree") && command.includes("add")) {
					if (failAdd) {
						failAdd = false;
						throw Object.assign(new Error("worktree add failed"), { code: "EIO" });
					}
					await mkdir(command.at(-2)!, { recursive: true });
					return empty;
				}
				if (command.includes("worktree") && command.includes("remove")) {
					if (failRemove && remainingRemoveFailures > 0) remainingRemoveFailures--;
					if (failRemove) {
						const code = failRemove;
						if (remainingRemoveFailures === 0) failRemove = undefined;
						throw Object.assign(new Error(`worktree cleanup ${code}`), { code });
					}
					await rm(command.at(-1)!, { recursive: true, force: true });
					return empty;
				}
				throw new Error(`unexpected Git command: ${command.join(" ")}`);
			},
		},
	};
}

function signal(head: string): GateSignal {
	return {
		id: SIGNAL_ID, gateId: "implementation", goalId: "goal", sessionId: "session",
		timestamp: Date.now(), commitSha: head,
		verification: { status: "running", steps: [] },
	};
}

const isPinnedError = (code: PinnedCheckoutError["code"]) =>
	(error: unknown) => error instanceof PinnedCheckoutError && error.code === code;

describe("VerificationPinnedCheckoutManager", () => {
	it("prefixes independent repository inventories into a deterministic aggregate witness", async () => {
		const source = await fixture();
		const container = path.join(source.base, "branch-container");
		const apiRoot = path.join(container, "services", "api");
		const webRoot = path.join(container, "apps", "web");
		await mkdir(path.join(apiRoot, "src"), { recursive: true });
		await mkdir(webRoot, { recursive: true });
		await writeFile(path.join(apiRoot, "src", "shared.ts"), "export const source = 'api';\n");
		await writeFile(path.join(webRoot, "shared.ts"), "export const source = 'web';\n");
		const entry = (relativePath: string): VerificationSourceInventoryEntry => ({
			relativePath,
			rawPath: Buffer.from(relativePath),
			membership: "tracked",
		});
		const apiInventory = [entry("src/shared.ts")];
		const webInventory = [entry("shared.ts")];

		const aggregateInventory = prefixVerificationSourceInventory([
			{ repoKey: "services/api", inventory: apiInventory },
			{ repoKey: "apps/web", inventory: webInventory },
		]);
		assert.deepEqual(aggregateInventory.map(item => item.relativePath), [
			"apps/web/shared.ts",
			"services/api/src/shared.ts",
		], "the aggregate preserves each repository key and sorts by the unchanged raw-path rule");
		assert.deepEqual(apiInventory.map(item => item.relativePath), ["src/shared.ts"], "prefixing never mutates a repository's v1 inventory");
		assert.deepEqual(webInventory.map(item => item.relativePath), ["shared.ts"]);

		const aggregate = await computeVerificationContentDigestFromInventory(container, aggregateInventory);
		const reordered = await computeVerificationContentDigestFromInventory(container, prefixVerificationSourceInventory([
			{ repoKey: "apps/web", inventory: webInventory },
			{ repoKey: "services/api", inventory: apiInventory },
		]));
		assert.deepEqual(reordered, aggregate, "repository discovery order cannot change a v2 aggregate identity");

		await writeFile(path.join(webRoot, "shared.ts"), "export const source = 'web changed';\n");
		const changed = await computeVerificationContentDigestFromInventory(container, aggregateInventory);
		assert.notEqual(changed.digest, aggregate.digest, "a mutation in one repository invalidates the complete pinned layout");
		assert.equal(changed.fileCount, 2);

		assert.throws(() => prefixVerificationSourceInventory([{ repoKey: "../escape", inventory: apiInventory }]));
		assert.throws(() => prefixVerificationSourceInventory([
			{ repoKey: "services/api", inventory: apiInventory },
			{ repoKey: "services/api", inventory: apiInventory },
		]), "a malformed aggregate cannot alias two manifest entries to one frozen path");
	});


	it("pins, resumes, audits, and cleans each repository in a multi-repository layout independently", async () => {
		const api = await fixture();
		const web = await fixture();
		web.head = "b".repeat(40);
		const container = path.join(api.base, "branch-container");
		const apiRoot = path.join(container, "services", "api");
		const webRoot = path.join(container, "apps", "web");
		await mkdir(path.dirname(apiRoot), { recursive: true });
		await mkdir(path.dirname(webRoot), { recursive: true });
		await rename(api.root, apiRoot);
		await rename(web.root, webRoot);
		api.root = apiRoot;
		web.root = webRoot;
		await writeFile(path.join(api.root, "raw.txt"), "api frozen bytes\n");
		await writeFile(path.join(web.root, "raw.txt"), "web frozen bytes\n");
		// Direct manager calls bypass resolvePinnedSourceLayout(), which
		// canonicalizes the container and repository roots before producing a layout.
		const [containerRoot, apiSourceRoot, webSourceRoot] = await Promise.all([
			realpath(container), realpath(api.root), realpath(web.root),
		]);
		api.root = apiSourceRoot;
		web.root = webSourceRoot;
		const git = fakeGit([api, web]);
		const layout = {
			version: 2 as const,
			kind: "multi" as const,
			containerRoot,
			repositories: [
				{ repoKey: "services/api", sourceRoot: api.root, commitSha: api.head },
				{ repoKey: "apps/web", sourceRoot: web.root, commitSha: web.head },
			],
		};
		const manager = new VerificationPinnedCheckoutManager(api.state, { commandRunner: git.runner });
		const checkout = await manager.acquire({
			signal: signal(api.head),
			sourceRoot: containerRoot,
			projectId: "test-project-id",
			layout,
		});
		assert.equal(checkout.layout, "multi");
		assert.ok(checkout.repositories, "a multi checkout persists its repository manifest");
		assert.deepEqual(checkout.repositories.map(repository => ({
			repoKey: repository.repoKey,
			commitSha: repository.commitSha,
			publicRelativePath: repository.publicRelativePath,
		})), [
			{ repoKey: "services/api", commitSha: api.head, publicRelativePath: "services/api" },
			{ repoKey: "apps/web", commitSha: web.head, publicRelativePath: "apps/web" },
		]);
		assert.equal(await readFile(path.join(checkout.path, "services", "api", "raw.txt"), "utf8"), "api frozen bytes\n");
		assert.equal(await readFile(path.join(checkout.path, "apps", "web", "raw.txt"), "utf8"), "web frozen bytes\n");
		await manager.assertUnchanged(checkout);

		// A restart may only read the durable lease/public bytes, not a changed
		// live component worktree.
		await writeFile(path.join(web.root, "raw.txt"), "live web changed after signal\n");
		const resumed = await new VerificationPinnedCheckoutManager(api.state, { commandRunner: git.runner })
			.resume(checkout.id, checkout.projectId);
		assert.equal(await readFile(path.join(resumed.path, "apps", "web", "raw.txt"), "utf8"), "web frozen bytes\n");

		// Public source files are intentionally immutable. Model a compromised
		// execution boundary with the same explicit permission change used by the
		// single-repository mutation coverage before altering frozen bytes.
		const publicWebSource = path.join(resumed.path, "apps", "web", "raw.txt");
		await chmod(publicWebSource, 0o644);
		await writeFile(publicWebSource, "public mutation\n");
		await assert.rejects(manager.assertUnchanged(resumed), isPinnedError("PINNED_CHECKOUT_MUTATED"), "a mutation in either repository invalidates the complete aggregate lease");
		await manager.release(resumed.id, resumed.projectId);
		assert.deepEqual(manager.getDiagnostics(), { leaseCount: 0, cleanupPending: 0 });
		assert.equal(git.calls.filter(call => call.args.includes("worktree") && call.args.includes("remove")).length, 2, "cleanup removes exactly one private worktree per persisted repository");
	});

	it("materializes dirty, staged, untracked, deleted, and executable raw source bytes, detects mutation, and releases only its lease", async () => {
		const source = await fixture();
		await writeFile(path.join(source.root, "raw.txt"), "dirty\r\n");
		// Git inventory identifies a staged file by name; D-3 must copy its working
		// bytes rather than a filtered Git blob.
		await writeFile(path.join(source.root, "staged.txt"), "staged source bytes\n");
		await writeFile(path.join(source.root, "new.txt"), "untracked\n");
		await unlink(path.join(source.root, "deleted.txt"));
		await writeFile(path.join(source.root, "exec.sh"), "#!/bin/sh\necho dirty\n");
		await chmod(path.join(source.root, "exec.sh"), 0o755);
		await writeFile(path.join(source.root, "ignored"), "not in the Git inventory");
		source.inventory.untracked.push("new.txt");

		const git = fakeGit(source);
		const manager = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		const checkout = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		assert.equal(await readFile(path.join(checkout.path, "raw.txt"), "utf8"), "dirty\r\n", "does not apply Git text filters");
		assert.equal(await readFile(path.join(checkout.path, "staged.txt"), "utf8"), "staged source bytes\n");
		assert.equal(await readFile(path.join(checkout.path, "new.txt"), "utf8"), "untracked\n");
		await assert.rejects(readFile(path.join(checkout.path, "deleted.txt")), /ENOENT/);
		await assert.rejects(readFile(path.join(checkout.path, "ignored")), /ENOENT/);
		// Windows has no executable mode bit for chmod/lstat to preserve. The
		// Unix assertion remains where that source attribute exists.
		if (process.platform !== "win32") {
			assert.equal((await lstat(path.join(checkout.path, "exec.sh"))).mode & 0o111, 0o111);
		}
		assert.ok(checkout.contentDigest.digest);
		assert.deepEqual(checkout.writableIgnoredDirectories, ["ignored"], "only a literal frozen .gitignore directory is retained");
		assert.ok(git.calls.some(call => call.args.includes("check-ignore") && call.args.includes("--no-index") && call.args.at(-1) === "ignored/"), "the private Git worktree confirms the literal directory");
		await manager.assertUnchanged(checkout);

		const reacquired = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		assert.equal(reacquired.path, checkout.path, "a signal owns one durable checkout");
		await chmod(path.join(checkout.path, "raw.txt"), 0o644);
		await writeFile(path.join(checkout.path, "raw.txt"), "mutated\n");
		await assert.rejects(manager.assertUnchanged(checkout), isPinnedError("PINNED_CHECKOUT_MUTATED"));
		await manager.release(checkout.id, "test-project-id");
		assert.equal(manager.getDiagnostics().leaseCount, 0);
		await assert.rejects(readFile(checkout.path), /ENOENT/);
		assert.ok(git.calls.every(call => call.options?.env?.GIT_DIR === undefined && call.options?.env?.GIT_WORK_TREE === undefined && call.options?.env?.GIT_INDEX_FILE === undefined), "every Git call clears ambient repository selectors");
	});

	it.skipIf(process.platform === "win32")("publishes an exact immutable Git discovery barrier inside an enclosing repository", async () => {
		const source = await fixture();
		// Put the manager state beneath a separate enclosing repository to model
		// the gateway checkout root nested in its own Git repository.
		const enclosingRepository = path.join(source.base, "gateway-repository");
		copyGitTemplate(enclosingRepository);
		source.state = path.join(enclosingRepository, "gateway-state");
		const manager = new VerificationPinnedCheckoutManager(source.state, { commandRunner: fakeGit(source).runner });
		const checkout = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		const barrier = path.join(checkout.path, ".git");
		const info = await lstat(barrier);
		assert.ok(info.isFile() && !info.isSymbolicLink(), "the barrier is an exact root file, never a Git metadata link");
		assert.equal(info.size, 0, "the barrier contains no Git metadata");
		assert.equal(info.mode & 0o222, 0, "the barrier is immutable to sandbox users");
		assert.notEqual((await lstat(checkout.path)).mode & 0o1000, 0, "the writable checkout root is sticky so the sandbox cannot remove the barrier");
		// The real Git discovery probe belongs to the real-Git integration tier;
		// this spawn-free core lane pins the manager's exact barrier bytes.
		await manager.assertUnchanged(checkout);
		await manager.release(checkout.id, "test-project-id");
	});

	it.skipIf(process.platform === "win32")("quarantines sandbox mutations before privileged inventory or Git work while retaining only the Git discovery barrier", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const manager = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		const checkout = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		const outside = path.join(source.base, "outside-canary");
		await mkdir(outside);
		await writeFile(path.join(outside, "sentinel"), "unchanged\n");
		const barrier = await lstat(path.join(checkout.path, ".git"));
		assert.ok(barrier.isFile() && !barrier.isSymbolicLink() && barrier.size === 0, "the sandbox-visible tree exposes only the empty Git discovery barrier, never metadata");

		// This models a sandbox process replacing an entry while it owns the public
		// bind mount. assertUnchanged first renames the whole root into private
		// quarantine, so neither its digest walk nor check-ignore uses the public cwd.
		await symlink(outside, path.join(checkout.path, "attacker-link"));
		await assert.rejects(manager.assertUnchanged(checkout), isPinnedError("PINNED_CHECKOUT_MUTATED"));
		assert.equal(await readFile(path.join(outside, "sentinel"), "utf8"), "unchanged\n");
		const gitCwds = git.calls.flatMap(call => call.args.flatMap((arg, index) => call.args[index - 1] === "-C" ? [arg] : []));
		assert.equal(gitCwds.includes(checkout.path), false, "no Git command may receive the sandbox-public path");
		await manager.release(checkout.id, "test-project-id");
		assert.equal(await readFile(path.join(outside, "sentinel"), "utf8"), "unchanged\n");
	});

	it.skipIf(process.platform === "win32")("atomically quarantines a release-time symlink without traversing its external target", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const manager = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		const checkout = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		const outside = path.join(source.base, "release-outside");
		await mkdir(outside);
		await writeFile(path.join(outside, "sentinel"), "unchanged\n");
		await symlink(outside, path.join(checkout.path, "release-link"));
		await manager.release(checkout.id, "test-project-id");
		assert.equal(await readFile(path.join(outside, "sentinel"), "utf8"), "unchanged\n");
		assert.equal(manager.getDiagnostics().leaseCount, 0);
	});

	it("isolates two authoritative project owners and rejects foreign lease operations", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const manager = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		const first = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "project-alpha" });
		const secondSignal = { ...signal(source.head), id: "b0f0f0f0-0000-4000-8000-000000000002" };
		const second = await manager.acquire({ signal: secondSignal, sourceRoot: source.root, projectId: "project-beta" });

		assert.notEqual(path.dirname(first.path), path.dirname(second.path));
		assert.equal(path.basename(path.dirname(first.path)), verificationCheckoutProjectScope("project-alpha"));
		assert.equal(path.basename(path.dirname(second.path)), verificationCheckoutProjectScope("project-beta"));
		assert.equal(first.path.includes("project-alpha"), false, "host checkout paths never expose project identifiers");
		await assert.rejects(manager.resume(first.id, "project-beta"), isPinnedError("PINNED_CHECKOUT_UNREADABLE"));
		await assert.rejects(manager.release(first.id, "project-beta"), isPinnedError("PINNED_CHECKOUT_UNREADABLE"));
		await manager.release(first.id, "project-alpha");
		await manager.release(second.id, "project-beta");
	});

	it("rejects scope symlinks to outside and foreign project checkout directories", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const manager = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		const checkoutRoot = path.join(source.state, "verification-checkouts");
		const alpha = verificationCheckoutProjectDir(checkoutRoot, "project-alpha")!;
		const beta = verificationCheckoutProjectDir(checkoutRoot, "project-beta")!;
		const outside = path.join(source.base, "outside-checkouts");
		await mkdir(checkoutRoot, { recursive: true });
		await mkdir(outside);
		await writeFile(path.join(outside, "outside-canary"), "do not alias");
		await symlink(outside, alpha);
		await assert.rejects(
			manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "project-alpha" }),
			isPinnedError("PINNED_CHECKOUT_ACQUIRE_FAILED"),
		);
		assert.equal(await readFile(path.join(outside, "outside-canary"), "utf8"), "do not alias");

		await unlink(alpha);
		await mkdir(beta);
		await writeFile(path.join(beta, "foreign-canary"), "project beta only");
		await symlink(beta, alpha);
		await assert.rejects(
			manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "project-alpha" }),
			isPinnedError("PINNED_CHECKOUT_ACQUIRE_FAILED"),
		);
		assert.equal(await readFile(path.join(beta, "foreign-canary"), "utf8"), "project beta only");
	});

	it("exposes only a safe ignored node_modules directory outside the frozen digest", async () => {
		const source = await fixture();
		const dependencies = path.join(source.root, "node_modules");
		await mkdir(dependencies);
		await writeFile(path.join(dependencies, "marker.js"), "module.exports = 'source dependency';\n");
		const git = fakeGit(source);
		const manager = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		const checkout = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		const pinnedDependencies = path.join(checkout.path, "node_modules");

		assert.equal((await lstat(pinnedDependencies)).isSymbolicLink(), true, "only the dependency root is linked into the checkout");
		assert.equal(await readFile(path.join(pinnedDependencies, "marker.js"), "utf8"), "module.exports = 'source dependency';\n");
		await manager.assertUnchanged(checkout);
		assert.equal(checkout.contentDigest.fileCount, source.inventory.tracked.length, "ignored dependency bytes remain outside the source digest");
		assert.deepEqual(git.calls.find(call => call.args.includes("check-ignore") && !call.args.includes("--no-index"))?.args.slice(-2), ["--", "node_modules"], "ignore probing uses a fixed top-level path argument");
		await manager.release(checkout.id, "test-project-id");
	});

	it("keeps manager-owned setup dependencies out of writable output overlays", async () => {
		const source = await fixture();
		await writeFile(path.join(source.root, ".gitignore"), "node_modules/\ndist/\n");
		source.ignoredTopLevel.add("dist");
		await mkdir(path.join(source.root, "node_modules"));
		await writeFile(path.join(source.root, "node_modules", "marker.js"), "module.exports = 'source dependency';\n");
		const manager = new VerificationPinnedCheckoutManager(source.state, { commandRunner: fakeGit(source).runner });
		const checkout = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		try {
			assert.deepEqual(checkout.writableIgnoredDirectories, ["dist"], "the node_modules setup link is never a writable output mount");
			assert.equal((await lstat(path.join(checkout.path, "node_modules"))).isSymbolicLink(), true, "the safe dependency link remains available");
			await mkdir(path.join(checkout.path, "dist"));
			await writeFile(path.join(checkout.path, "dist", "output.js"), "generated\n");
			await manager.assertUnchanged(checkout);
		} finally {
			await manager.release(checkout.id, "test-project-id");
		}
	});

	it("recurses through non-ignored ancestors of nested ignored output while rejecting source siblings", async () => {
		const source = await fixture();
		await writeFile(path.join(source.root, ".gitignore"), "tests/results/tier-2-5/\n");
		source.ignoredTopLevel.add("tests/results/tier-2-5");
		const manager = new VerificationPinnedCheckoutManager(source.state, { commandRunner: fakeGit(source).runner });
		const checkout = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		try {
			assert.deepEqual(checkout.writableIgnoredDirectories, ["tests/results/tier-2-5"]);
			const generated = path.join(checkout.path, "tests", "results", "tier-2-5", "result.json");
			await mkdir(path.dirname(generated), { recursive: true });
			await writeFile(generated, "{}\n");
			await manager.assertUnchanged(checkout);

			await writeFile(path.join(checkout.path, "tests", "stray-source.txt"), "must invalidate\n");
			await assert.rejects(manager.assertUnchanged(checkout), isPinnedError("PINNED_CHECKOUT_MUTATED"));
		} finally {
			await manager.release(checkout.id, "test-project-id");
		}
	});

	it("never links a non-ignored or symlinked dependency directory", async () => {
		const nonIgnored = await fixture();
		await mkdir(path.join(nonIgnored.root, "node_modules"));
		nonIgnored.ignoredTopLevel.delete("node_modules");
		const nonIgnoredManager = new VerificationPinnedCheckoutManager(nonIgnored.state, { commandRunner: fakeGit(nonIgnored).runner });
		const nonIgnoredCheckout = await nonIgnoredManager.acquire({ signal: signal(nonIgnored.head), sourceRoot: nonIgnored.root, projectId: "test-project-id" });
		await assert.rejects(lstat(path.join(nonIgnoredCheckout.path, "node_modules")), /ENOENT/, "non-ignored directories are never shared into a checkout");
		await nonIgnoredManager.release(nonIgnoredCheckout.id, "test-project-id");

		if (process.platform !== "win32") {
			const unsafe = await fixture();
			const outside = path.join(unsafe.base, "outside-dependencies");
			await mkdir(outside);
			await symlink(outside, path.join(unsafe.root, "node_modules"), "dir");
			const unsafeManager = new VerificationPinnedCheckoutManager(unsafe.state, { commandRunner: fakeGit(unsafe).runner });
			await assert.rejects(unsafeManager.acquire({ signal: signal(unsafe.head), sourceRoot: unsafe.root, projectId: "test-project-id" }), isPinnedError("PINNED_CHECKOUT_ACQUIRE_FAILED"));
			assert.deepEqual(unsafeManager.getDiagnostics(), { leaseCount: 0, cleanupPending: 0 });
		}
	});

	it("permits ignored build outputs but detects non-ignored source additions without making materialized files writable", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const manager = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		const checkout = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });

		assert.equal((await lstat(checkout.path)).mode & 0o200, 0o200, "checkout directories remain writable for tool output");
		assert.equal((await lstat(path.join(checkout.path, "raw.txt"))).mode & 0o222, 0, "materialized source files remain read-only");
		const ignoredOutput = path.join(checkout.path, "ignored", "build.txt");
		await mkdir(path.dirname(ignoredOutput));
		await writeFile(ignoredOutput, "generated output\n");
		await manager.assertUnchanged(checkout);
		const ignoredCheck = git.calls.find(call => call.args.includes("check-ignore") && call.args.at(-1) === "ignored/");
		assert.ok(ignoredCheck, "private check-ignore receives a directory marker for ignored/ patterns");
		assert.equal(ignoredCheck!.args.includes(checkout.path), false, "ignore classification never uses the sandbox-public path");

		const addedSource = path.join(checkout.path, "new-source.txt");
		source.inventory.untracked.push("new-source.txt");
		await writeFile(addedSource, "source mutation\n");
		await assert.rejects(manager.assertUnchanged(checkout), isPinnedError("PINNED_CHECKOUT_MUTATED"));
		await manager.release(checkout.id, "test-project-id");
	});

	it.skipIf(process.platform === "win32")("preserves in-root symlinks as source links rather than dereferencing them", async () => {
		const source = await fixture({ symlink: true });
		const git = fakeGit(source);
		const manager = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		const checkout = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		assert.equal((await lstat(path.join(checkout.path, "link"))).isSymbolicLink(), true);
		assert.equal(await readFile(path.join(checkout.path, "link"), "utf8"), "before\n");
		await manager.release(checkout.id, "test-project-id");
	});

	it("fails closed for stale commits, untrusted identifiers, and unsupported nested source roots without creating a lease", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const manager = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		await assert.rejects(manager.acquire({ signal: signal("0".repeat(40)), sourceRoot: source.root, projectId: "test-project-id" }), isPinnedError("PINNED_CHECKOUT_ACQUIRE_FAILED"));
		await assert.rejects(manager.acquire({ signal: { ...signal(source.head), id: "../worktree" }, sourceRoot: source.root, projectId: "test-project-id" }), isPinnedError("PINNED_CHECKOUT_ACQUIRE_FAILED"));
		assert.deepEqual(manager.getDiagnostics(), { leaseCount: 0, cleanupPending: 0 });
		assert.equal(git.calls.some(call => call.args.includes("worktree")), false, "untrusted signal input never reaches Git argv");

		const nested = path.join(source.root, "nested");
		await mkdir(nested);
		await assert.rejects(manager.acquire({ signal: signal(source.head), sourceRoot: nested, projectId: "test-project-id" }), isPinnedError("PINNED_CHECKOUT_UNSUPPORTED_LAYOUT"));
		assert.deepEqual(manager.getDiagnostics(), { leaseCount: 0, cleanupPending: 0 });
	});

	it("fails closed on an escaping or special-file inventory entry before it can materialize outside the lease", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const unsafe = (relativePath: string): VerificationSourceInventoryEntry => ({
			relativePath, rawPath: Buffer.from(relativePath), membership: "tracked",
		});
		for (const entry of [unsafe("../escaped"), unsafe("submodule")]) {
			if (entry.relativePath === "submodule") await mkdir(path.join(source.root, entry.relativePath));
			const manager = new VerificationPinnedCheckoutManager(source.state, {
				commandRunner: git.runner,
				readInventory: async () => [entry],
			});
			await assert.rejects(manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" }), isPinnedError("PINNED_CHECKOUT_ACQUIRE_FAILED"));
			assert.deepEqual(manager.getDiagnostics(), { leaseCount: 0, cleanupPending: 0 });
		}
		assert.equal(git.calls.filter(call => call.args.includes("worktree") && call.args.includes("remove")).length, 2, "each rejected materialization cleans only its own transient lease");
	});

	it("resumes a durable ready lease after restart without consulting live source bytes", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const checkout = await new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner })
			.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		git.calls.splice(0);
		await writeFile(path.join(source.root, "raw.txt"), "live tree changed after signal\n");

		const resumed = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		const restored = await resumed.resume(checkout.id, "test-project-id");
		assert.equal(restored.path, checkout.path);
		assert.equal(await readFile(path.join(restored.path, "raw.txt"), "utf8"), "before\n");
		assert.equal(git.calls.some(call => call.args.includes("ls-files") && call.args[1] === source.root), false, "restart verification reads the lease checkout, not mutable source");
		await resumed.release(restored.id, "test-project-id");
	});

	it("recovers orphaned leases without sweeping active or unrelated worktrees", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const first = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		const checkout = await first.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		const unrelated = path.join(source.base, "unrelated-worktree");
		await mkdir(unrelated);
		await writeFile(path.join(unrelated, "keep.txt"), "must survive\n");

		const active = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		await active.recover(new Map([[checkout.id, "test-project-id"]]));
		assert.equal(active.getLease(checkout.id)?.state, "ready");
		assert.equal(await readFile(path.join(unrelated, "keep.txt"), "utf8"), "must survive\n");

		await active.recover(new Map());
		assert.equal(active.getLease(checkout.id), undefined);
		await assert.rejects(readFile(checkout.path), /ENOENT/);
		assert.equal(await readFile(path.join(unrelated, "keep.txt"), "utf8"), "must survive\n");
		const removes = git.calls.filter(call => call.args.includes("worktree") && call.args.includes("remove"));
		assert.equal(removes.length, 1);
		assert.match(removes[0]!.args.at(-1)!, /\.worktree$/, "Git removal only sees the private worktree");
		assert.notEqual(removes[0]!.args.at(-1), checkout.path);
	});

	it("removes a preparing lease when detached worktree creation fails", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		git.failNextAdd();
		const manager = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		await assert.rejects(
			manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" }),
			(error: unknown) => error instanceof PinnedCheckoutError
				&& error.code === "PINNED_CHECKOUT_ACQUIRE_FAILED"
				&& error.message === "Pinned checkout could not be prepared"
				&& error.name === "PinnedCheckoutError[worktree-add:EIO]"
				&& error.internalDiagnostic?.stage === "worktree-add"
				&& error.internalDiagnostic.causeCode === "EIO",
			"the direct error retains only closed stage/cause enums while its public text stays sanitized",
		);
		assert.deepEqual(manager.getDiagnostics(), { leaseCount: 0, cleanupPending: 0 });
		assert.deepEqual(JSON.parse(await readFile(path.join(source.state, "verification-checkouts.json"), "utf8")), []);
	});

	it("reclaims a checkout after its source repository was deleted", async () => {
		const source = await fixture();
		const manager = new VerificationPinnedCheckoutManager(source.state, { commandRunner: fakeGit(source).runner });
		const checkout = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		await rm(source.root, { recursive: true, force: true });
		const restarted = new VerificationPinnedCheckoutManager(source.state, { commandRunner: fakeGit(source).runner });
		await restarted.recover(new Map());
		assert.deepEqual(restarted.getDiagnostics(), { leaseCount: 0, cleanupPending: 0 });
		await assert.rejects(lstat(checkout.path), /ENOENT/);
	});

	it("makes a read-only published tree writable before removing it", async () => {
		const source = await fixture();
		const manager = new VerificationPinnedCheckoutManager(source.state, { commandRunner: fakeGit(source).runner });
		const checkout = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		await chmod(checkout.path, 0o555);
		await chmod(path.join(checkout.path, "raw.txt"), 0o444);
		await manager.release(checkout.id, "test-project-id");
		assert.deepEqual(manager.getDiagnostics(), { leaseCount: 0, cleanupPending: 0 });
		await assert.rejects(lstat(checkout.path), /ENOENT/);
	});

	it.skipIf(process.platform === "win32")("rejects release and retains a lease rather than cleaning a replaced published root", async () => {
		const source = await fixture();
		const manager = new VerificationPinnedCheckoutManager(source.state, { commandRunner: fakeGit(source).runner });
		const checkout = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		const displaced = path.join(source.base, "displaced-published-root");
		await rename(checkout.path, displaced);
		await mkdir(checkout.path);
		await writeFile(path.join(checkout.path, "replacement-canary"), "do not remove\n");
		const restarted = new VerificationPinnedCheckoutManager(source.state, { commandRunner: fakeGit(source).runner });
		await assert.rejects(restarted.release(checkout.id, "test-project-id"), isPinnedError("PINNED_CHECKOUT_UNREADABLE"));
		assert.deepEqual(restarted.getDiagnostics(), { leaseCount: 1, cleanupPending: 1 });
		assert.equal(restarted.getLease(checkout.id)?.state, "releasing");
		assert.equal(restarted.getLease(checkout.id)?.cleanupAttempts, 1);
		assert.equal(restarted.getLease(checkout.id)?.lastCleanupErrorCode, "GIT_REMOVE_FAILED");
		assert.equal(await readFile(path.join(checkout.path, "replacement-canary"), "utf8"), "do not remove\n");
		assert.equal(await readFile(path.join(displaced, "raw.txt"), "utf8"), "before\n");
	});

	it("rejects a busy checkout release, persists the exact retry lease, and recovers it after restart", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const first = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		const checkout = await first.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		git.failNextRemove("EBUSY");
		await assert.rejects(first.release(checkout.id, checkout.projectId), isPinnedError("PINNED_CHECKOUT_UNREADABLE"));
		assert.deepEqual(first.getDiagnostics(), { leaseCount: 1, cleanupPending: 1 });
		assert.equal(first.getLease(checkout.id)?.state, "releasing");
		assert.equal(first.getLease(checkout.id)?.cleanupAttempts, 1);
		assert.equal(first.getLease(checkout.id)?.lastCleanupErrorCode, "PATH_BUSY");
		const persisted = JSON.parse(await readFile(path.join(source.state, "verification-checkouts.json"), "utf8"));
		assert.deepEqual(persisted.map((lease: { signalId: string; state: string; cleanupAttempts: number; lastCleanupErrorCode: string }) => ({
			signalId: lease.signalId, state: lease.state, cleanupAttempts: lease.cleanupAttempts, lastCleanupErrorCode: lease.lastCleanupErrorCode,
		})), [{ signalId: checkout.id, state: "releasing", cleanupAttempts: 1, lastCleanupErrorCode: "PATH_BUSY" }]);

		const restarted = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		await restarted.recover(new Map());
		assert.deepEqual(restarted.getDiagnostics(), { leaseCount: 0, cleanupPending: 0 });
		await assert.rejects(lstat(checkout.path), /ENOENT/);
	});

	it("rejects access-denied release cleanup without leaking the OS failure and accepts a later retry", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const manager = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		const checkout = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		git.failNextRemove("EACCES");
		await assert.rejects(manager.release(checkout.id, checkout.projectId), (error: unknown) =>
			error instanceof PinnedCheckoutError && error.code === "PINNED_CHECKOUT_UNREADABLE"
				&& error.message === "Pinned checkout cleanup is pending",
		);
		assert.deepEqual(manager.getDiagnostics(), { leaseCount: 1, cleanupPending: 1 });
		assert.equal(manager.getLease(checkout.id)?.lastCleanupErrorCode, "GIT_REMOVE_FAILED");
		await manager.release(checkout.id, checkout.projectId);
		assert.deepEqual(manager.getDiagnostics(), { leaseCount: 0, cleanupPending: 0 });
	});

	it("recovers every orphan independently when one exact lease is busy", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const manager = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		const first = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "project-alpha" });
		const second = await manager.acquire({ signal: { ...signal(source.head), id: "b0f0f0f0-0000-4000-8000-000000000002" }, sourceRoot: source.root, projectId: "project-beta" });
		git.failNextRemove("EBUSY");

		await manager.recover(new Map());
		assert.equal(manager.getLease(first.id)?.state, "releasing");
		assert.equal(manager.getLease(second.id), undefined, "a busy lease cannot block unrelated orphan cleanup");
		assert.deepEqual(manager.getDiagnostics(), { leaseCount: 1, cleanupPending: 1 });
		await assert.rejects(lstat(second.path), /ENOENT/);

		await manager.recover(new Map());
		assert.deepEqual(manager.getDiagnostics(), { leaseCount: 0, cleanupPending: 0 });
	});

	it("reports acquisition failure while retaining a cleanup-pending preparation lease for recovery", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		// A directory inventory entry is unsupported after the detached worktree
		// exists, exercising the acquisition-error plus cleanup-error boundary.
		await mkdir(path.join(source.root, "unsupported-directory"));
		source.inventory.tracked.push("unsupported-directory");
		git.failNextRemove("EBUSY");
		const manager = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		await assert.rejects(
			manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" }),
			(error: unknown) => error instanceof PinnedCheckoutError
				&& error.code === "PINNED_CHECKOUT_ACQUIRE_FAILED"
				&& error.message === "Pinned checkout could not be prepared",
		);
		assert.deepEqual(manager.getDiagnostics(), { leaseCount: 1, cleanupPending: 1 });
		assert.equal(manager.getLease(SIGNAL_ID)?.state, "releasing");
		await manager.recover(new Map());
		assert.deepEqual(manager.getDiagnostics(), { leaseCount: 0, cleanupPending: 0 });
	});

	it("retries a no-step-style public cleanup failure under its own live fake clock", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const clock = fakeClock();
		const manager = new VerificationPinnedCheckoutManager(source.state, {
			commandRunner: git.runner, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
		});
		const checkout = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		git.failNextRemove("EBUSY");
		await assert.rejects(manager.release(checkout.id, checkout.projectId), (error: unknown) =>
			error instanceof PinnedCheckoutError && error.code === "PINNED_CHECKOUT_UNREADABLE"
				&& error.message === "Pinned checkout cleanup is pending",
		);
		assert.equal(clock.pending(), 1, "manager retains the only live retry authority");
		await clock.advance(999);
		assert.equal(manager.getLease(checkout.id)?.cleanupAttempts, 1);
		await clock.advance(1);
		assert.equal(manager.getLease(checkout.id), undefined);
		assert.equal(clock.pending(), 0, "successful deletion cancels the retry timer");
	});

	it("retries a failed acquisition cleanup without returning a checkout", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const clock = fakeClock();
		await mkdir(path.join(source.root, "unsupported-directory"));
		source.inventory.tracked.push("unsupported-directory");
		git.failNextRemove("EBUSY");
		const manager = new VerificationPinnedCheckoutManager(source.state, {
			commandRunner: git.runner, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
		});
		await assert.rejects(manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" }), isPinnedError("PINNED_CHECKOUT_ACQUIRE_FAILED"));
		assert.equal(manager.getLease(SIGNAL_ID)?.state, "releasing");
		await clock.advance(1_000);
		assert.equal(manager.getLease(SIGNAL_ID), undefined);
	});

	it("backs off cleanup retries through 30 seconds without leaking Git failures", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const clock = fakeClock();
		const manager = new VerificationPinnedCheckoutManager(source.state, {
			commandRunner: git.runner, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
		});
		const checkout = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		git.failRemoveTimes(7, "EBUSY");
		await assert.rejects(manager.release(checkout.id, checkout.projectId), isPinnedError("PINNED_CHECKOUT_UNREADABLE"));
		for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000].entries()) {
			await clock.advance(delay - 1);
			assert.equal(manager.getLease(checkout.id)?.cleanupAttempts, index + 1);
			await clock.advance(1);
			assert.equal(manager.getLease(checkout.id)?.cleanupAttempts, index + 2);
			assert.equal(clock.pending(), 1, "the next backoff is scheduled only after this attempt persists");
		}
		assert.equal(manager.getLease(checkout.id)?.lastCleanupErrorCode, "PATH_BUSY", "diagnostics retain only a stable error code");
		await clock.advance(30_000);
		assert.equal(manager.getLease(checkout.id), undefined);
	});

	it("keeps retry timers isolated across retained orphan leases", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const clock = fakeClock();
		const manager = new VerificationPinnedCheckoutManager(source.state, {
			commandRunner: git.runner, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
		});
		const first = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "project-alpha" });
		const second = await manager.acquire({ signal: { ...signal(source.head), id: "b0f0f0f0-0000-4000-8000-000000000002" }, sourceRoot: source.root, projectId: "project-beta" });
		git.failNextRemove("EBUSY");
		await assert.rejects(manager.release(first.id, first.projectId), isPinnedError("PINNED_CHECKOUT_UNREADABLE"));
		git.failNextRemove("EBUSY");
		await assert.rejects(manager.release(second.id, second.projectId), isPinnedError("PINNED_CHECKOUT_UNREADABLE"));
		assert.equal(clock.pending(), 2, "each retained lease owns one independent retry");
		await clock.advance(1_000);
		assert.equal(manager.getLease(first.id), undefined);
		assert.equal(manager.getLease(second.id), undefined);
	});

	it("re-establishes retry ownership on restart and leaves active recovery leases alone", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const firstClock = fakeClock();
		const first = new VerificationPinnedCheckoutManager(source.state, {
			commandRunner: git.runner, now: firstClock.now, setTimeout: firstClock.setTimeout, clearTimeout: firstClock.clearTimeout,
		});
		const checkout = await first.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		git.failRemoveTimes(2, "EBUSY");
		await assert.rejects(first.release(checkout.id, checkout.projectId), isPinnedError("PINNED_CHECKOUT_UNREADABLE"));

		const restartClock = fakeClock();
		const restarted = new VerificationPinnedCheckoutManager(source.state, {
			commandRunner: git.runner, now: restartClock.now, setTimeout: restartClock.setTimeout, clearTimeout: restartClock.clearTimeout,
		});
		await restarted.recover(new Map());
		assert.equal(restartClock.pending(), 1, "recovery restores a manager-owned retry for retained orphan state");
		await restartClock.advance(2_000);
		assert.equal(restarted.getLease(checkout.id), undefined);

		const active = await first.acquire({ signal: { ...signal(source.head), id: "b0f0f0f0-0000-4000-8000-000000000002" }, sourceRoot: source.root, projectId: "test-project-id" });
		git.failNextRemove("EBUSY");
		await assert.rejects(first.release(active.id, active.projectId), isPinnedError("PINNED_CHECKOUT_UNREADABLE"));
		await first.recover(new Map([[active.id, active.projectId]]));
		assert.equal(firstClock.pending(), 0, "active recovery ownership cancels a stale retry");
		await firstClock.advance(60_000);
		assert.equal(first.getLease(active.id)?.state, "releasing", "active recovery never reclaims its authoritative lease");
	});

	it("reclaims a lease when Git lacks its private-worktree registration", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const first = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		const checkout = await first.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		git.failNextRemove();
		await first.release(checkout.id, "test-project-id");
		assert.deepEqual(first.getDiagnostics(), { leaseCount: 0, cleanupPending: 0 });
		await assert.rejects(readFile(checkout.path), /ENOENT/);
	});
});
