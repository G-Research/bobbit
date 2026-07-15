/**
 * API E2E — representative PUT /api/projects/:id/config validation for `base_ref`.
 *
 * Pure grammar/error-shape inventory lives in tests2/core/base-ref-validation.test.ts.
 * This file keeps route-level coverage for persistence plus git-backed tag,
 * sandbox, local-branch, multi-repo, and warning paths. Keep related route
 * checks batched: the in-process integration cleanup runs after every test, so
 * splitting pure scenario permutations here materially increases suite time.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, readE2EToken, base, registerProject as registerProjectShared } from "./_e2e/e2e-setup.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let token: string;
let templateRepo = "";
let nameCounter = 0;
let gitProjectId = "";
let multiProjectId = "";
let warningProjectId = "";
let warningRoot = "";
const cleanupRoots: string[] = [];
const cleanupProjectIds: string[] = [];

const headers = () => ({
	Authorization: `Bearer ${token}`,
	"Content-Type": "application/json",
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", windowsHide: true }).trim();
}

function createTemplateRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-template-"));
	git(dir, "init", "--quiet");
	git(dir, "config", "user.email", "test@bobbit.local");
	git(dir, "config", "user.name", "test");
	git(dir, "config", "commit.gpgsign", "false");
	git(dir, "checkout", "--quiet", "-B", "master");
	fs.writeFileSync(path.join(dir, "README.md"), "x\n");
	git(dir, "add", ".");
	git(dir, "commit", "--quiet", "-m", "init");
	git(dir, "branch", "develop");
	git(dir, "tag", "v1.2.3");
	return dir;
}

function cleanupDir(dir: string): void {
	try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* ignore */ }
}

function copyTemplateRepo(root: string): void {
	fs.cpSync(templateRepo, root, { recursive: true });
}

function fixtureRepo(prefix: string, opts?: { originDevelop?: boolean }): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-baseref-${prefix}-`));
	fs.rmSync(root, { recursive: true, force: true });
	copyTemplateRepo(root);
	cleanupRoots.push(root);
	if (opts?.originDevelop) fakeOriginRef(root, "develop");
	return root;
}

/** Create a "fake" `origin/<branch>` remote tracking ref by writing a loose ref.
 *  Cheaper than scaffolding a real remote — `git rev-parse --verify origin/<branch>`
 *  resolves to whatever commit we point it at. */
function fakeOriginRef(repo: string, branch: string, sha?: string): void {
	const headSha = sha ?? git(repo, "rev-parse", "HEAD");
	const refPath = path.join(repo, ".git", "refs", "remotes", "origin", branch);
	fs.mkdirSync(path.dirname(refPath), { recursive: true });
	fs.writeFileSync(refPath, headSha + "\n");
}

async function registerProject(name: string, rootPath: string, components?: Array<{ name: string; repo: string }>): Promise<string> {
	// Delegate to the shared helper which canonicalizes rootPath (handles the
	// macOS /var → /private/var tmpdir symlink) and sets acceptCanonical:true.
	const proj = await registerProjectShared({ name: `${name}-${++nameCounter}`, rootPath, components, seedWorkflows: false });
	cleanupProjectIds.push(proj.id);
	return proj.id;
}

async function put(id: string, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
	const res = await fetch(`${base()}/api/projects/${id}/config`, {
		method: "PUT",
		headers: headers(),
		body: JSON.stringify(body),
	});
	let json: any = null;
	try { json = await res.json(); } catch { /* not JSON */ }
	return { status: res.status, json };
}

async function get(id: string): Promise<any> {
	const res = await fetch(`${base()}/api/projects/${id}/config`, { headers: headers() });
	expect(res.status).toBe(200);
	return res.json();
}

function expectBaseRefUnset(config: any): void {
	expect(config.base_ref === undefined || config.base_ref === "").toBe(true);
}

test.beforeAll(async () => {
	token = readE2EToken();
	templateRepo = createTemplateRepo();

	const gitRoot = fixtureRepo("shared-git", { originDevelop: true });
	gitProjectId = await registerProject("baseref-git", gitRoot);

	const multiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-multi-"));
	cleanupRoots.push(multiRoot);
	const repoA = path.join(multiRoot, "api");
	const repoB = path.join(multiRoot, "web");
	const repoC = path.join(multiRoot, "shared");
	copyTemplateRepo(repoA);
	copyTemplateRepo(repoB);
	copyTemplateRepo(repoC);
	fakeOriginRef(repoA, "develop");
	multiProjectId = await registerProject(
		"baseref-multi",
		multiRoot,
		[
			{ name: "api", repo: "api" },
			{ name: "web", repo: "web" },
			{ name: "shared", repo: "shared" },
		],
	);

	warningRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-warning-"));
	cleanupRoots.push(warningRoot);
	fs.mkdirSync(path.join(warningRoot, "docs"), { recursive: true });
	warningProjectId = await registerProject("baseref-warning", warningRoot, [{ name: "docs", repo: "docs" }]);
});

test.afterEach(({ gateway }) => {
	// The first two cases share the same immutable git graph. Restore only the
	// config keys they mutate so each test starts from an explicit clean state.
	const store = gateway.projectContextManager.getOrCreate(gitProjectId)?.projectConfigStore;
	store?.remove("base_ref");
	store?.remove("sandbox");
});

test.afterAll(async () => {
	for (const id of cleanupProjectIds.splice(0).reverse()) {
		await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
	}
	for (const root of cleanupRoots) cleanupDir(root);
	if (templateRepo) cleanupDir(templateRepo);
});

// These tests register projects and mutate project config through one in-process
// gateway. Keep this file serial to avoid extra gateway workers/retries on Windows.
test.describe.configure({ mode: "serial" });

test.describe("base_ref API validation", () => {
	test("persists remote refs, clears empty values, and accepts local/whitespace refs", async () => {
		const remoteSet = await put(gitProjectId, { base_ref: "origin/develop" });
		expect(remoteSet.status, JSON.stringify(remoteSet.json)).toBe(200);
		expect((await get(gitProjectId)).base_ref).toBe("origin/develop");

		const emptyClear = await put(gitProjectId, { base_ref: "" });
		expect(emptyClear.status, JSON.stringify(emptyClear.json)).toBe(200);
		expectBaseRefUnset(await get(gitProjectId));

		const localSet = await put(gitProjectId, { base_ref: "develop" });
		expect(localSet.status, JSON.stringify(localSet.json)).toBe(200);
		expect((await get(gitProjectId)).base_ref).toBe("develop");

		const whitespaceUnset = await put(gitProjectId, { base_ref: "   " });
		expect(whitespaceUnset.status, JSON.stringify(whitespaceUnset.json)).toBe(200);
	});

	test("rejects git-backed tag refs and sandboxed local refs with route error strings", async () => {
		const tag = await put(gitProjectId, { base_ref: "v1.2.3" });
		expect(tag.status).toBe(400);
		expect(tag.json).toEqual({
			field: "base_ref",
			error: "base_ref must be a branch ref, not a tag. Tags can't be used as git upstreams. Got: v1.2.3",
		});

		const sandbox = await put(gitProjectId, { sandbox: "docker" });
		expect(sandbox.status, JSON.stringify(sandbox.json)).toBe(200);
		const local = await put(gitProjectId, { base_ref: "master" });
		expect(local.status).toBe(400);
		expect(local.json).toEqual({
			field: "base_ref",
			error: "base_ref must be a remote ref (origin/...) for sandboxed projects. The container has separate ref visibility from the host. Got: master",
		});
	});

	test("multi-repo: missing ref in subset of components returns 400 with structured details[]", async () => {
		const r = await put(multiProjectId, { base_ref: "origin/develop" });
		expect(r.status).toBe(400);
		expect(r.json.field).toBe("base_ref");
		expect(r.json.error).toBe("base_ref 'origin/develop' is not present in 2 of 3 component repos");
		expect(Array.isArray(r.json.details)).toBe(true);
		expect(r.json.details.length).toBe(2);
		const failedComps = r.json.details.map((d: any) => d.component).sort();
		expect(failedComps).toEqual(["shared", "web"]);
		for (const d of r.json.details) {
			expect(d.message).toMatch(/^ref not found\. Try: cd /);
		}
	});

	test("non-git component paths skip validation unless base_ref is present, then return warnings", async () => {
		const skip = await put(warningProjectId, { build_command: "echo build" });
		expect(skip.status, JSON.stringify(skip.json)).toBe(200);

		const warn = await put(warningProjectId, { base_ref: "origin/develop" });
		expect(warn.status, JSON.stringify(warn.json)).toBe(200);
		expect(warn.json.warnings).toEqual([
			`base_ref validation skipped for component 'docs': not a git repo at ${path.join(warningRoot, "docs")}`,
		]);
	});
});
