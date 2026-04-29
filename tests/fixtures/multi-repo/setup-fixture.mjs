/**
 * Idempotently initialize the three multi-repo fixture repos.
 *
 *   tests/fixtures/multi-repo/api/      → real git repo with package.json
 *   tests/fixtures/multi-repo/web/      → real git repo with package.json
 *   tests/fixtures/multi-repo/shared/   → real git repo, README only (data-only)
 *
 * Each repo is initialized with `git init -b master`, gets a single
 * commit on `master`, and is left clean. Re-running this script is a
 * no-op once the `.git/` directories exist.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function run(cmd, args, cwd) {
	execFileSync(cmd, args, { cwd, stdio: "ignore" });
}

function initRepo(name) {
	const dir = join(HERE, name);
	if (existsSync(join(dir, ".git"))) return false;
	run("git", ["init", "--quiet", "-b", "master"], dir);
	run("git", ["config", "user.email", "fixture@bobbit.local"], dir);
	run("git", ["config", "user.name", "fixture"], dir);
	run("git", ["add", "."], dir);
	run("git", ["commit", "-m", "init", "--quiet"], dir);
	return true;
}

export function setupMultiRepoFixture() {
	const created = ["api", "web", "shared"].map(initRepo);
	return { created };
}

// Run when invoked directly (cross-platform: compare normalized paths).
const thisFile = fileURLToPath(import.meta.url);
const entry = process.argv[1] ? join(process.argv[1]) : "";
if (thisFile === entry) {
	const { created } = setupMultiRepoFixture();
	console.log(`[setup-fixture] api=${created[0]} web=${created[1]} shared=${created[2]}`);
}
