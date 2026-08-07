import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

import type { GateSignal } from "../../src/server/agent/gate-store.ts";
import { PinnedCheckoutError, VerificationPinnedCheckoutManager } from "../../src/server/agent/verification-pinned-checkout.ts";
import { createRunChild } from "../harness/run-isolation.ts";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const SIGNAL_ID = "a0f0f0f0-0000-4000-8000-0000000000b2";

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" });
	return stdout.trim();
}

async function fixture(): Promise<{
	root: string;
	state: string;
	containerHead: string;
	repositories: Record<"services/api" | "apps/web", string>;
	heads: Record<"services/api" | "apps/web", string>;
}> {
	const base = createRunChild("pinned-checkout-multi-real-git");
	roots.push(base);
	const root = path.join(base, "container");
	await mkdir(root);
	const repositories = {
		"services/api": path.join(root, "services", "api"),
		"apps/web": path.join(root, "apps", "web"),
	};
	for (const [repoKey, repoRoot] of Object.entries(repositories)) {
		await mkdir(repoRoot, { recursive: true });
		await git(repoRoot, "init");
		await git(repoRoot, "config", "user.email", "pinned-multi@example.test");
		await git(repoRoot, "config", "user.name", "Pinned multi checkout fixture");
		const relativePath = repoKey === "services/api" ? path.join("packages", "api") : path.join("packages", "web");
		await mkdir(path.join(repoRoot, relativePath), { recursive: true });
		await writeFile(path.join(repoRoot, relativePath, "source.txt"), `${repoKey} original bytes\n`);
		if (repoKey === "apps/web") await writeFile(path.join(repoRoot, ".gitignore"), "test-results/\n");
		await writeFile(path.join(repoRoot, "README.md"), `${repoKey} root\n`);
		await git(repoRoot, "add", ".");
		await git(repoRoot, "commit", "-m", `${repoKey} fixture`);
	}
	// A distinct history prevents the legacy display SHA from standing in for
	// the per-repository source identity.
	await writeFile(path.join(repositories["services/api"], "api-only.txt"), "second api commit\n");
	await git(repositories["services/api"], "add", ".");
	await git(repositories["services/api"], "commit", "-m", "api-only revision");
	// A genuine root repository may own container files while independent nested
	// component repositories remain separately pinned beneath it.
	await git(root, "init");
	await git(root, "config", "user.email", "pinned-multi@example.test");
	await git(root, "config", "user.name", "Pinned multi checkout fixture");
	await writeFile(path.join(root, ".gitignore"), "dist/\n/apps/\n/services/\n");
	await writeFile(path.join(root, "container.txt"), "container original bytes\n");
	await git(root, "add", ".gitignore", "container.txt");
	await git(root, "commit", "-m", "container fixture");
	return {
		root,
		state: path.join(base, "state"),
		repositories,
		containerHead: await git(root, "rev-parse", "HEAD"),
		heads: {
			"services/api": await git(repositories["services/api"], "rev-parse", "HEAD"),
			"apps/web": await git(repositories["apps/web"], "rev-parse", "HEAD"),
		},
	};
}

function signal(commitSha: string, id = SIGNAL_ID): GateSignal {
	return {
		id,
		gateId: "implementation",
		goalId: "goal",
		sessionId: "session",
		timestamp: Date.now(),
		commitSha,
		verification: { status: "running", steps: [] },
	};
}

function layout(source: Awaited<ReturnType<typeof fixture>>) {
	return {
		version: 2 as const,
		kind: "multi" as const,
		containerRoot: source.root,
		repositories: [
			{ repoKey: "services/api", sourceRoot: source.repositories["services/api"], commitSha: source.heads["services/api"] },
			{ repoKey: "apps/web", sourceRoot: source.repositories["apps/web"], commitSha: source.heads["apps/web"] },
		],
	};
}

function containerRootLayout(source: Awaited<ReturnType<typeof fixture>>) {
	return {
		version: 2 as const,
		kind: "multi" as const,
		containerRoot: source.root,
		repositories: [
			{ repoKey: ".", sourceRoot: source.root, commitSha: source.containerHead },
			...layout(source).repositories,
		],
	};
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("VerificationPinnedCheckoutManager multi-repository real Git", () => {
	it("pins distinct repositories into one immutable layout, resumes it, and cleans only its recorded resources", async () => {
		const source = await fixture();
		const sentinel = path.join(source.root, "unrelated-sentinel.txt");
		await writeFile(sentinel, "must survive pinned checkout cleanup\n");
		const first = new VerificationPinnedCheckoutManager(source.state);
		const checkout = await first.acquire({
			signal: signal(source.heads["services/api"]), sourceRoot: source.root,
			projectId: "test-project-id", layout: layout(source),
		});
		try {
			assert.equal(checkout.layout, "multi");
			assert.deepEqual(checkout.repositories?.map(repository => repository.repoKey).sort(), ["apps/web", "services/api"]);
			assert.notEqual(checkout.repositories?.[0]?.commitSha, checkout.repositories?.[1]?.commitSha, "each repository keeps its own commit witness");
			assert.equal(await readFile(path.join(checkout.path, "services", "api", "packages", "api", "source.txt"), "utf8"), "services/api original bytes\n");
			assert.equal(await readFile(path.join(checkout.path, "apps", "web", "packages", "web", "source.txt"), "utf8"), "apps/web original bytes\n");
			await assert.rejects(lstat(path.join(checkout.path, "services", "api", ".git")), /ENOENT/, "public component copies must not expose private Git worktrees");

			await writeFile(path.join(source.repositories["services/api"], "packages", "api", "source.txt"), "live api mutation\n");
			await writeFile(path.join(source.repositories["apps/web"], "packages", "web", "source.txt"), "live web mutation\n");
			const restarted = new VerificationPinnedCheckoutManager(source.state);
			const resumed = await restarted.resume(SIGNAL_ID, "test-project-id");
			assert.equal(resumed.path, checkout.path, "restart must recover the persisted public layout without consulting mutable live roots");
			assert.equal(await readFile(path.join(resumed.path, "services", "api", "packages", "api", "source.txt"), "utf8"), "services/api original bytes\n");
			assert.equal(await readFile(path.join(resumed.path, "apps", "web", "packages", "web", "source.txt"), "utf8"), "apps/web original bytes\n");
			await restarted.assertUnchanged(resumed);
			await restarted.release(SIGNAL_ID, "test-project-id");
			await assert.rejects(lstat(checkout.path), /ENOENT/);
			assert.equal(await readFile(sentinel, "utf8"), "must survive pinned checkout cleanup\n", "cleanup must not broaden past the persisted lease resources");
		} catch (error) {
			await first.release(SIGNAL_ID, "test-project-id").catch(() => {});
			throw error;
		}
	});

	it("pins a container-root repository beside nested repositories and detects mutation in either source subtree", async () => {
		const source = await fixture();
		const manager = new VerificationPinnedCheckoutManager(source.state);
		const rootCheckout = await manager.acquire({ signal: signal(source.containerHead, "a0f0f0f0-0000-4000-8000-0000000000c1"), sourceRoot: source.root, projectId: "test-project-id", layout: containerRootLayout(source) });
		try {
			assert.deepEqual(rootCheckout.repositories?.map(repository => repository.repoKey).sort(), [".", "apps/web", "services/api"]);
			assert.deepEqual(rootCheckout.writableIgnoredDirectories, ["apps/web/test-results", "dist"],
				"multi-repository output directories must be globally sorted, including root-repository entries");
			assert.equal(await readFile(path.join(rootCheckout.path, "container.txt"), "utf8"), "container original bytes\n");
			assert.equal(await readFile(path.join(rootCheckout.path, "apps", "web", "packages", "web", "source.txt"), "utf8"), "apps/web original bytes\n");
			await chmod(path.join(rootCheckout.path, "container.txt"), 0o644);
			await writeFile(path.join(rootCheckout.path, "container.txt"), "changed root bytes\n");
			await assert.rejects(manager.assertUnchanged(rootCheckout), (error: unknown) => error instanceof PinnedCheckoutError && error.code === "PINNED_CHECKOUT_MUTATED");
		} finally {
			await manager.release(rootCheckout.id, "test-project-id").catch(() => {});
		}

		const nestedCheckout = await manager.acquire({ signal: signal(source.containerHead, "a0f0f0f0-0000-4000-8000-0000000000c2"), sourceRoot: source.root, projectId: "test-project-id", layout: containerRootLayout(source) });
		try {
			const nestedFile = path.join(nestedCheckout.path, "services", "api", "packages", "api", "source.txt");
			await chmod(nestedFile, 0o644);
			await writeFile(nestedFile, "changed nested bytes\n");
			await assert.rejects(manager.assertUnchanged(nestedCheckout), (error: unknown) => error instanceof PinnedCheckoutError && error.code === "PINNED_CHECKOUT_MUTATED");
		} finally {
			await manager.release(nestedCheckout.id, "test-project-id").catch(() => {});
		}
	});

	it("rejects container/intermediate additions and a replaced component root without following it", async () => {
		const source = await fixture();
		const manager = new VerificationPinnedCheckoutManager(source.state);
		const checkout = await manager.acquire({ signal: signal(source.heads["services/api"], "a0f0f0f0-0000-4000-8000-0000000000b3"), sourceRoot: source.root, projectId: "test-project-id", layout: layout(source) });
		try {
			await writeFile(path.join(checkout.path, "extra.txt"), "unattested root entry\n");
			await assert.rejects(manager.assertUnchanged(checkout), (error: unknown) => error instanceof PinnedCheckoutError && error.code === "PINNED_CHECKOUT_MUTATED");
			await assert.rejects(
				manager.acquire({ signal: signal(source.heads["services/api"], checkout.id), sourceRoot: source.root, projectId: "test-project-id", layout: layout(source) }),
				(error: unknown) => error instanceof PinnedCheckoutError && error.code === "PINNED_CHECKOUT_MUTATED",
				"existing multi leases are re-audited before reuse",
			);
		} finally {
			await manager.release(checkout.id, "test-project-id").catch(() => {});
		}

		const intermediate = await manager.acquire({ signal: signal(source.heads["services/api"], "a0f0f0f0-0000-4000-8000-0000000000b4"), sourceRoot: source.root, projectId: "test-project-id", layout: layout(source) });
		try {
			// Simulate a host-mode verifier: the public intermediate is read-only for
			// sandbox users, but must still be audited if its owner changes it.
			await chmod(path.join(intermediate.path, "services"), 0o777);
			await writeFile(path.join(intermediate.path, "services", "extra.txt"), "unattested intermediate entry\n");
			await assert.rejects(manager.assertUnchanged(intermediate), (error: unknown) => error instanceof PinnedCheckoutError && error.code === "PINNED_CHECKOUT_MUTATED");
		} finally {
			await manager.release(intermediate.id, "test-project-id").catch(() => {});
		}

		const replaced = await manager.acquire({ signal: signal(source.heads["services/api"], "a0f0f0f0-0000-4000-8000-0000000000b5"), sourceRoot: source.root, projectId: "test-project-id", layout: layout(source) });
		const outside = path.join(source.root, "outside");
		try {
			await mkdir(outside);
			await writeFile(path.join(outside, "must-not-be-read.txt"), "outside sentinel\n");
			await chmod(path.join(replaced.path, "services"), 0o777);
			await rm(path.join(replaced.path, "services", "api"), { recursive: true });
			// If the audit follows this link, it cannot read the locked target and
			// returns UNREADABLE instead of the structural MUTATED result below.
			await chmod(outside, 0o000);
			await symlink(outside, path.join(replaced.path, "services", "api"));
			await assert.rejects(manager.assertUnchanged(replaced), (error: unknown) => error instanceof PinnedCheckoutError && error.code === "PINNED_CHECKOUT_MUTATED");
			await chmod(outside, 0o700);
			assert.equal(await readFile(path.join(outside, "must-not-be-read.txt"), "utf8"), "outside sentinel\n", "the rejected symlink target remains outside the audit traversal");
		} finally {
			await chmod(outside, 0o700).catch(() => {});
			await manager.release(replaced.id, "test-project-id").catch(() => {});
		}
	});

	it("rejects unsafe existing leases and overlapping nested repositories", async () => {
		const source = await fixture();
		const manager = new VerificationPinnedCheckoutManager(source.state);
		const existing = await manager.acquire({ signal: signal(source.heads["services/api"], "a0f0f0f0-0000-4000-8000-0000000000b6"), sourceRoot: source.repositories["services/api"], projectId: "test-project-id" });
		try {
			await assert.rejects(
				manager.acquire({ signal: signal(source.heads["services/api"], existing.id), sourceRoot: source.root, projectId: "test-project-id", layout: layout(source) }),
				(error: unknown) => error instanceof PinnedCheckoutError && error.code === "PINNED_CHECKOUT_ACQUIRE_FAILED",
			);
			await assert.rejects(
				manager.acquire({ signal: signal(source.heads["services/api"], existing.id), sourceRoot: source.root, projectId: "other-project-id", layout: layout(source) }),
				(error: unknown) => error instanceof PinnedCheckoutError && error.code === "PINNED_CHECKOUT_ACQUIRE_FAILED",
			);
		} finally {
			await manager.release(existing.id, "test-project-id").catch(() => {});
		}

		const nested = layout(source);
		const nestedRoot = path.join(source.repositories["services/api"], "nested-repository");
		await mkdir(nestedRoot);
		await git(nestedRoot, "init");
		await git(nestedRoot, "config", "user.email", "pinned-multi@example.test");
		await git(nestedRoot, "config", "user.name", "Pinned multi checkout fixture");
		await writeFile(path.join(nestedRoot, "nested.txt"), "nested\n");
		await git(nestedRoot, "add", ".");
		await git(nestedRoot, "commit", "-m", "nested fixture");
		nested.repositories.push({ repoKey: "services/api/nested-repository", sourceRoot: nestedRoot, commitSha: await git(nestedRoot, "rev-parse", "HEAD") });
		await assert.rejects(
			manager.acquire({ signal: signal(source.heads["services/api"], "a0f0f0f0-0000-4000-8000-0000000000b7"), sourceRoot: source.root, projectId: "test-project-id", layout: nested }),
			(error: unknown) => error instanceof PinnedCheckoutError && error.code === "PINNED_CHECKOUT_ACQUIRE_FAILED",
		);
	});

	it("fails closed for an escaping repository entry without removing either live repository", async () => {
		const source = await fixture();
		const invalid = layout(source);
		invalid.repositories[1] = { ...invalid.repositories[1]!, sourceRoot: path.join(source.root, "outside") };
		const manager = new VerificationPinnedCheckoutManager(source.state);
		await assert.rejects(
			manager.acquire({ signal: signal(source.heads["services/api"], "a0f0f0f0-0000-4000-8000-0000000000b8"), sourceRoot: source.root, projectId: "test-project-id", layout: invalid }),
			(error: unknown) => error instanceof PinnedCheckoutError && /layout|pinned checkout/i.test(error.message),
		);
		assert.equal(await readFile(path.join(source.repositories["services/api"], "packages", "api", "source.txt"), "utf8"), "services/api original bytes\n");
		assert.equal(await readFile(path.join(source.repositories["apps/web"], "packages", "web", "source.txt"), "utf8"), "apps/web original bytes\n");
	});
});
