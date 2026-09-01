/**
 * API E2E — representative PUT /api/projects/:id/config validation for `base_ref`.
 *
 * Pure grammar/error-shape inventory lives in tests/unit/core/base-ref-validation.unit.test.ts.
 * This file keeps route-level coverage for persistence plus git-backed tag,
 * sandbox, local-branch, multi-repo, and warning paths. Keep related route
 * checks batched: the in-process integration cleanup runs after every test, so
 * splitting pure scenario permutations here materially increases suite time.
 */
import { it } from "vitest";
import { test, expect } from "../../../tests/support/harnesses/integration/gateway/in-process-harness.js";
import { readE2EToken, base } from "../../../tests/support/harnesses/integration/gateway/e2e-setup.js";
import { loadServerTestRuntime } from "../../../tests/support/harnesses/shared/server-runtime.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let token: string;
let restoreCommandRunner: (() => void) | undefined;
let nameCounter = 0;
let gitProjectId = "";
let multiProjectId = "";
let warningProjectId = "";
let warningRoot = "";
let fixtureGateway: any;
const cleanupRoots: string[] = [];
const cleanupProjectIds: string[] = [];
const originDevelopRepos = new Set<string>();

const headers = () => ({
	Authorization: `Bearer ${token}`,
	"Content-Type": "application/json",
});

function canonicalPath(dir: string): string {
	return fs.realpathSync(dir);
}

function createFakeRepo(dir: string): void {
	fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/master\n");
	fs.writeFileSync(path.join(dir, "README.md"), "x\n");
}

function cannedGit(cwd: string, args: readonly string[]): string {
	const key = args.join(" ");
	// Preserve the route contract under test: only fixture directories created
	// by createFakeRepo are git-backed. In particular, the data-only docs
	// component must make the probe fail so the route returns its warning.
	if (key === "rev-parse --is-inside-work-tree" && !fs.existsSync(path.join(cwd, ".git"))) {
		throw new Error(`not a git repo: ${cwd}`);
	}
	if (key === "rev-parse --show-toplevel") return cwd;
	if (key === "rev-parse --is-inside-work-tree") return "true";
	if (key === "rev-parse --verify HEAD" || key === "rev-parse --verify refs/heads/master" || key === "rev-parse --verify develop") return "a".repeat(40);
	if (key === "rev-parse --verify refs/tags/v1.2.3") return "b".repeat(40);
	if (key === "rev-parse --verify origin/develop" && originDevelopRepos.has(path.resolve(cwd))) return "a".repeat(40);
	if (args[0] === "remote" && args[1] === "get-url") throw new Error("no remote");
	throw new Error(`missing canned git result (${cwd}): ${key}`);
}

async function installCannedGitRunner(): Promise<void> {
	const runtime = await loadServerTestRuntime();
	const runner = runtime.gatewayDeps.realCommandRunner;
	const original = { execFile: runner.execFile, execFileSync: runner.execFileSync, spawn: runner.spawn };
	runner.execFile = async (file, args, options) => {
		if (path.basename(file).toLowerCase().replace(/\.exe$/, "") !== "git") throw new Error(`unexpected command: ${file}`);
		return { stdout: cannedGit(String(options?.cwd ?? ""), args), stderr: "" };
	};
	runner.execFileSync = (file, args, options) => {
		if (path.basename(file).toLowerCase().replace(/\.exe$/, "") !== "git") throw new Error(`unexpected command: ${file}`);
		return cannedGit(String(options?.cwd ?? ""), args);
	};
	runner.spawn = undefined;
	restoreCommandRunner = () => Object.assign(runner, original);
}

function cleanupDir(dir: string): void {
	try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* ignore */ }
}

function copyTemplateRepo(root: string): void {
	createFakeRepo(root);
}

function fixtureRepo(prefix: string, opts?: { originDevelop?: boolean }): string {
	const lexicalRoot = fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-baseref-${prefix}-`));
	copyTemplateRepo(lexicalRoot);
	const root = canonicalPath(lexicalRoot);
	cleanupRoots.push(root);
	if (opts?.originDevelop) fakeOriginRef(root, "develop");
	return root;
}

function fakeOriginRef(repo: string, branch: string): void {
	if (branch === "develop") originDevelopRepos.add(path.resolve(repo));
}

function registerProject(gateway: any, name: string, rootPath: string, components?: Array<{ name: string; repo: string }>): string {
	// Base-ref coverage starts at the config route, not project creation. Author
	// the three project contexts directly so registration cannot add HTTP,
	// remote-detection, or cleanup latency to this decision matrix.
	const pcm = gateway.projectContextManager;
	const project = pcm.getRegistry().register(`${name}-${++nameCounter}`, rootPath, { acceptCanonical: true });
	const ctx = pcm.getOrCreate(project.id);
	if (!ctx) throw new Error(`failed to create test-owned project context ${project.id}`);
	ctx.projectConfigStore.setComponents(components ?? [{ name, repo: "." }]);
	cleanupProjectIds.push(project.id);
	return project.id;
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

test.beforeAll(async ({ gateway }) => {
	token = readE2EToken();
	fixtureGateway = gateway;
	await installCannedGitRunner();

	const gitRoot = fixtureRepo("shared-git", { originDevelop: true });
	gitProjectId = registerProject(gateway, "baseref-git", gitRoot);

	const multiRoot = canonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-multi-")));
	cleanupRoots.push(multiRoot);
	const repoA = path.join(multiRoot, "api");
	const repoB = path.join(multiRoot, "web");
	const repoC = path.join(multiRoot, "shared");
	copyTemplateRepo(repoA);
	copyTemplateRepo(repoB);
	copyTemplateRepo(repoC);
	fakeOriginRef(repoA, "develop");
	multiProjectId = registerProject(
		gateway,
		"baseref-multi",
		multiRoot,
		[
			{ name: "api", repo: "api" },
			{ name: "web", repo: "web" },
			{ name: "shared", repo: "shared" },
		],
	);

	const lexicalWarningRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-warning-"));
	fs.mkdirSync(path.join(lexicalWarningRoot, "docs"), { recursive: true });
	warningRoot = canonicalPath(lexicalWarningRoot);
	cleanupRoots.push(warningRoot);
	warningProjectId = registerProject(gateway, "baseref-warning", warningRoot, [{ name: "docs", repo: "docs" }]);
});

test.afterEach(({ gateway }) => {
	// The first two cases share the same immutable git graph. Restore only the
	// config keys they mutate so each test starts from an explicit clean state.
	const store = gateway.projectContextManager.getOrCreate(gitProjectId)?.projectConfigStore;
	store?.remove("base_ref");
	store?.remove("sandbox");
});

test.afterAll(async () => {
	const pcm = fixtureGateway?.projectContextManager;
	const registry = pcm?.getRegistry();
	for (const id of cleanupProjectIds.splice(0).reverse()) {
		// remove() is the context shutdown barrier. Await it before unregistering
		// or a following isolate:false suite can snapshot this closing fixture.
		await pcm?.remove(id);
		expect([...pcm.visible()].some((context: any) => context.project.id === id)).toBe(false);
		try { registry?.remove(id); } catch { /* already removed */ }
	}
	for (const root of cleanupRoots) cleanupDir(root);
	restoreCommandRunner?.();
});

// Suite-owned project contexts and the canned runner make each declaration
// deterministic without the compatibility harness's per-test entity sweep.
test.describe("base_ref API validation", () => {
	it("persists remote refs, clears empty values, and accepts local/whitespace refs", async () => {
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

	it("rejects git-backed tag refs and sandboxed local refs with route error strings", async () => {
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

	it("multi-repo: missing ref in subset of components returns 400 with structured details[]", async () => {
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

	it("non-git component paths skip validation unless base_ref is present, then return warnings", async () => {
		const skip = await put(warningProjectId, { build_command: "echo build" });
		expect(skip.status, JSON.stringify(skip.json)).toBe(200);

		const warn = await put(warningProjectId, { base_ref: "origin/develop" });
		expect(warn.status, JSON.stringify(warn.json)).toBe(200);
		expect(warn.json.warnings).toEqual([
			`base_ref validation skipped for component 'docs': not a git repo at ${path.join(warningRoot, "docs")}`,
		]);
	});
});
