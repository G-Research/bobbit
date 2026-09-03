/**
 * API E2E — add-time `base_ref` pinning across independent real remotes.
 *
 * The cheaper integration suite owns deterministic add-time success/mismatch
 * decisions. This retained boundary proves that POST registration detects a
 * non-default remote HEAD, validates it in every component, and persists it.
 */
import { test, expect } from "../in-process-harness.js";
import { readE2EToken, base, registerProject as registerProjectShared } from "../e2e-setup.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { copyGitTemplate, prepareGitTemplate } from "../../../tests/support/harnesses/shared/git-template.js";

let token: string;

const headers = () => ({
	Authorization: `Bearer ${token}`,
	"Content-Type": "application/json",
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", windowsHide: true }).trim();
}

/** Create an independent committed repository on `branch` without hardlinks. */
function seedRepo(dir: string, branch: string): void {
	copyGitTemplate(dir, { branch });
}

/**
 * Build two independently seeded components, each cloned from its own bare
 * remote whose HEAD points at the requested non-default branch.
 */
function makeMultiRepoProject(root: string, repos: Array<{ name: string; branch: string }>): string {
	for (const { name, branch } of repos) {
		const src = path.join(root, `${name}-src`);
		const bare = path.join(root, `${name}-remote.git`);
		const clone = path.join(root, name);
		seedRepo(src, branch);
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

test.beforeAll(async () => {
	token = readE2EToken();
	await prepareGitTemplate();
});

test("POST detects and pins a non-default ref present in every real component remote", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-multi-add-"));
	let projectId: string | undefined;
	try {
		makeMultiRepoProject(root, [
			{ name: "api", branch: "develop" },
			{ name: "web", branch: "develop" },
		]);
		for (const component of ["api", "web"]) {
			expect(git(path.join(root, component), "ls-remote", "--symref", "origin", "HEAD"))
				.toContain("ref: refs/heads/develop");
			expect(git(path.join(root, component), "rev-parse", "--verify", "origin/develop"))
				.toMatch(/^[0-9a-f]{40}$/);
		}

		const project = await registerProjectShared({
			name: `baseref-multi-add-${Date.now()}`,
			rootPath: root,
			components: [
				{ name: "api", repo: "api" },
				{ name: "web", repo: "web" },
			],
		});
		projectId = project.id;
		expect((await getConfig(project.id)).base_ref).toBe("origin/develop");
	} finally {
		if (projectId) {
			const removed = await fetch(`${base()}/api/projects/${projectId}`, {
				method: "DELETE",
				headers: headers(),
			});
			expect(removed.status).toBe(200);
		}
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
