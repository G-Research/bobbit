import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
		await writeFile(path.join(repoRoot, "README.md"), `${repoKey} root\n`);
		await git(repoRoot, "add", ".");
		await git(repoRoot, "commit", "-m", `${repoKey} fixture`);
	}
	// A distinct history prevents the legacy display SHA from standing in for
	// the per-repository source identity.
	await writeFile(path.join(repositories["services/api"], "api-only.txt"), "second api commit\n");
	await git(repositories["services/api"], "add", ".");
	await git(repositories["services/api"], "commit", "-m", "api-only revision");
	return {
		root,
		state: path.join(base, "state"),
		repositories,
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

	it("fails closed for an escaping repository entry without removing either live repository", async () => {
		const source = await fixture();
		const invalid = layout(source);
		invalid.repositories[1] = { ...invalid.repositories[1]!, sourceRoot: path.join(source.root, "outside") };
		const manager = new VerificationPinnedCheckoutManager(source.state);
		await assert.rejects(
			manager.acquire({ signal: signal(source.heads["services/api"], "a0f0f0f0-0000-4000-8000-0000000000b3"), sourceRoot: source.root, projectId: "test-project-id", layout: invalid }),
			(error: unknown) => error instanceof PinnedCheckoutError && /layout|pinned checkout/i.test(error.message),
		);
		assert.equal(await readFile(path.join(source.repositories["services/api"], "packages", "api", "source.txt"), "utf8"), "services/api original bytes\n");
		assert.equal(await readFile(path.join(source.repositories["apps/web"], "packages", "web", "source.txt"), "utf8"), "apps/web original bytes\n");
	});
});
