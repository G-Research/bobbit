/**
 * API E2E — add-time `base_ref` pinning + the read-only detect endpoint.
 *
 * Covers (docs/design/base-ref.md — add-time pinning):
 *  - POST /api/projects on a git repo with a live `origin/HEAD` symref pins a
 *    concrete `origin/<branch>` base_ref.
 *  - A repo with no reachable remote leaves base_ref blank (no failure).
 *  - GET /api/projects/:id/base-ref/detect returns { resolved, detected }.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base, registerProject as registerProjectShared } from "./e2e-setup.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let token: string;

const headers = () => ({
	Authorization: `Bearer ${token}`,
	"Content-Type": "application/json",
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", windowsHide: true }).trim();
}

/** Create a standalone git repo with a single commit on `branch` (default master). */
function gitInit(dir: string, branch = "master"): void {
	fs.mkdirSync(dir, { recursive: true });
	git(dir, "init", "--quiet");
	git(dir, "config", "user.email", "test@bobbit.local");
	git(dir, "config", "user.name", "test");
	git(dir, "config", "commit.gpgsign", "false");
	git(dir, "checkout", "--quiet", "-b", branch);
	fs.writeFileSync(path.join(dir, "README.md"), "x\n");
	git(dir, "add", ".");
	git(dir, "commit", "--quiet", "-m", "init");
}

/**
 * Create a project repo that has a real `origin` remote whose HEAD symref points
 * at `branch`. Done by building a bare remote (with HEAD → branch) and cloning
 * it. `git ls-remote --symref origin HEAD` then returns `ref: refs/heads/<branch>`.
 * Returns the clone dir (the project rootPath).
 */
function makeRepoWithRemote(root: string, branch = "master"): string {
	const src = path.join(root, "src");
	const bare = path.join(root, "remote.git");
	const clone = path.join(root, "clone");
	gitInit(src, branch);
	// Bare clone mirrors src's HEAD (→ branch), giving the remote a HEAD symref.
	git(root, "clone", "--quiet", "--bare", src, bare);
	// Working clone wires `origin` + sets origin/HEAD symref automatically.
	git(root, "clone", "--quiet", bare, clone);
	return clone;
}

/**
 * Build a multi-repo project layout under `root`: each entry in `repos` becomes
 * a component subdir cloned from a bare remote whose HEAD symref points at the
 * given branch. Returns the project rootPath (the container dir holding the
 * component subdirs). `git ls-remote --symref origin HEAD` in component[i]
 * returns `ref: refs/heads/<repos[i].branch>`.
 */
function makeMultiRepoProject(root: string, repos: Array<{ name: string; branch: string }>): string {
	for (const { name, branch } of repos) {
		const src = path.join(root, `${name}-src`);
		const bare = path.join(root, `${name}-remote.git`);
		const clone = path.join(root, name);
		gitInit(src, branch);
		git(root, "clone", "--quiet", "--bare", src, bare);
		git(root, "clone", "--quiet", bare, clone);
	}
	return root;
}

async function getConfig(id: string): Promise<any> {
	const res = await fetch(`${base()}/api/projects/${id}/config`, { headers: headers() });
	expect(res.status).toBe(200);
	return res.json();
}

test.beforeAll(() => { token = readE2EToken(); });

test.describe("base_ref add-time pinning", () => {
	test("single-repo with live origin/HEAD pins concrete origin/<branch>", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-pin-"));
		const repo = makeRepoWithRemote(root, "master");
		const proj = await registerProjectShared({ name: `baseref-pin-${Date.now()}`, rootPath: repo });
		const cfg = await getConfig(proj.id);
		expect(cfg.base_ref).toBe("origin/master");
	});

	test("pins the actual default branch name (not hard-coded master)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-pin-dev-"));
		const repo = makeRepoWithRemote(root, "develop");
		const proj = await registerProjectShared({ name: `baseref-pin-dev-${Date.now()}`, rootPath: repo });
		const cfg = await getConfig(proj.id);
		expect(cfg.base_ref).toBe("origin/develop");
	});

	test("repo with no reachable remote leaves base_ref blank (no failure)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-noremote-"));
		gitInit(root, "master");
		const proj = await registerProjectShared({ name: `baseref-noremote-${Date.now()}`, rootPath: root });
		const cfg = await getConfig(proj.id);
		expect(cfg.base_ref === undefined || cfg.base_ref === "").toBe(true);
	});

	test("GET /base-ref/detect degrades gracefully for a non-git project root", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-nongit-"));
		fs.writeFileSync(path.join(root, "README.md"), "not a git repo\n");
		const proj = await registerProjectShared({ name: `baseref-nongit-${Date.now()}`, rootPath: root });

		const res = await fetch(`${base()}/api/projects/${proj.id}/base-ref/detect`, { headers: headers() });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ resolved: "", detected: null });
	});

	test("GET /base-ref/detect returns resolved + detected for a repo with a remote", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-detect-"));
		const repo = makeRepoWithRemote(root, "master");
		const proj = await registerProjectShared({ name: `baseref-detect-${Date.now()}`, rootPath: repo });

		const res = await fetch(`${base()}/api/projects/${proj.id}/base-ref/detect`, { headers: headers() });
		expect(res.status).toBe(200);
		const body = await res.json();
		// Pinned at add time → resolved reflects the stored concrete value.
		expect(body.resolved).toBe("origin/master");
		expect(body.detected).toBe("origin/master");
	});

	test("GET /base-ref/detect 404s for an unknown project", async () => {
		const res = await fetch(`${base()}/api/projects/does-not-exist/base-ref/detect`, { headers: headers() });
		expect(res.status).toBe(404);
	});

	test("multi-repo: all components have the detected branch → pins origin/<branch>", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-multi-ok-"));
		makeMultiRepoProject(root, [
			{ name: "api", branch: "develop" },
			{ name: "web", branch: "develop" },
		]);
		const proj = await registerProjectShared({
			name: `baseref-multi-ok-${Date.now()}`,
			rootPath: root,
			components: [
				{ name: "api", repo: "api" },
				{ name: "web", repo: "web" },
			],
		});
		const cfg = await getConfig(proj.id);
		expect(cfg.base_ref).toBe("origin/develop");
	});

	test("multi-repo detect: one component lacks the ref → detected is null (resolved still returned)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-detect-miss-"));
		// Primary (api) would detect origin/develop; web only has origin/master,
		// so the live-detected value is not saveable → endpoint nulls it out.
		makeMultiRepoProject(root, [
			{ name: "api", branch: "develop" },
			{ name: "web", branch: "master" },
		]);
		const proj = await registerProjectShared({
			name: `baseref-detect-miss-${Date.now()}`,
			rootPath: root,
			components: [
				{ name: "api", repo: "api" },
				{ name: "web", repo: "web" },
			],
		});

		const res = await fetch(`${base()}/api/projects/${proj.id}/base-ref/detect`, { headers: headers() });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.detected).toBe(null);
		// resolved is still returned (the runtime fallback for the blank value).
		expect(typeof body.resolved).toBe("string");
	});

	test("multi-repo: one component lacks the detected branch → base_ref stays blank", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-multi-miss-"));
		// Primary (api) detects origin/develop; web only has origin/master.
		makeMultiRepoProject(root, [
			{ name: "api", branch: "develop" },
			{ name: "web", branch: "master" },
		]);
		const proj = await registerProjectShared({
			name: `baseref-multi-miss-${Date.now()}`,
			rootPath: root,
			components: [
				{ name: "api", repo: "api" },
				{ name: "web", repo: "web" },
			],
		});
		const cfg = await getConfig(proj.id);
		expect(cfg.base_ref === undefined || cfg.base_ref === "").toBe(true);
	});
});
