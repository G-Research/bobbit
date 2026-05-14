/**
 * API E2E — PUT /api/projects/:id/config validation for `base_ref`.
 *
 * Covers:
 *  - Round-trip persistence (set / get / clear).
 *  - Every error-inventory row from docs/design/base-ref.md.
 *  - Multi-repo `details[]` payload when the ref is missing in some components.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base } from "./e2e-setup.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let token: string;

const headers = () => ({
	Authorization: `Bearer ${token}`,
	"Content-Type": "application/json",
});

function gitInit(dir: string, opts?: { extraBranches?: string[] }): void {
	fs.mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "--quiet"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@bobbit.local"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
	execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
	execFileSync("git", ["checkout", "--quiet", "-b", "master"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "README.md"), "x\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: dir });
	for (const b of opts?.extraBranches ?? []) {
		execFileSync("git", ["branch", b], { cwd: dir });
	}
}

/** Create a "fake" `origin/<branch>` remote tracking ref by writing a packed ref.
 *  Cheaper than scaffolding a real remote — `git rev-parse --verify origin/<branch>`
 *  resolves to whatever commit we point it at. */
function fakeOriginRef(repo: string, branch: string, sha?: string): void {
	const headSha = sha ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();
	const refsDir = path.join(repo, ".git", "refs", "remotes", "origin");
	const refPath = path.join(refsDir, branch);
	fs.mkdirSync(path.dirname(refPath), { recursive: true });
	fs.writeFileSync(refPath, headSha + "\n");
}

async function registerProject(name: string, rootPath: string, components?: Array<{ name: string; repo: string }>): Promise<string> {
	// macOS `os.tmpdir()` resolves through /private — register() would 400 with
	// symlink_root unless we opt in to the canonical path.
	const body: Record<string, unknown> = { name, rootPath, acceptCanonical: true };
	if (components) body.components = components;
	const res = await fetch(`${base()}/api/projects`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(201);
	const proj = await res.json();
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

test.beforeAll(() => { token = readE2EToken(); });

test.describe("base_ref API validation", () => {
	test("PUT round-trip — set origin/<branch>, GET returns it, empty clears it", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-rt-"));
		gitInit(root);
		fakeOriginRef(root, "develop");
		const id = await registerProject(`baseref-rt-${Date.now()}`, root);

		const r1 = await put(id, { base_ref: "origin/develop" });
		expect(r1.status, JSON.stringify(r1.json)).toBe(200);

		const cfg1 = await get(id);
		expect(cfg1.base_ref).toBe("origin/develop");

		// Empty value clears.
		const r2 = await put(id, { base_ref: "" });
		expect(r2.status).toBe(200);
		const cfg2 = await get(id);
		// Empty after clear can either be "" or the key removed; either is OK
		// for the unset sentinel. We accept both.
		expect(cfg2.base_ref === undefined || cfg2.base_ref === "").toBe(true);
	});

	test("rejects commit SHA shape with the exact error string", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-sha-"));
		gitInit(root);
		const id = await registerProject(`baseref-sha-${Date.now()}`, root);
		const sha = "abc123def";
		const r = await put(id, { base_ref: sha });
		expect(r.status).toBe(400);
		expect(r.json.field).toBe("base_ref");
		expect(r.json.error).toBe(`base_ref must be a branch ref, not a commit SHA. Got: ${sha}`);
	});

	test("rejects tag with the exact error string", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-tag-"));
		gitInit(root);
		// Create a real tag in the repo so the server's tag-detection path fires.
		execFileSync("git", ["tag", "v1.2.3"], { cwd: root });
		const id = await registerProject(`baseref-tag-${Date.now()}`, root);
		const r = await put(id, { base_ref: "v1.2.3" });
		expect(r.status).toBe(400);
		expect(r.json.field).toBe("base_ref");
		expect(r.json.error).toBe("base_ref must be a branch ref, not a tag. Tags can't be used as git upstreams. Got: v1.2.3");
	});

	test("rejects invalid branch grammar with the exact error string", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-grammar-"));
		gitInit(root);
		const id = await registerProject(`baseref-grammar-${Date.now()}`, root);
		const bad = "feature foo"; // space disallowed
		const r = await put(id, { base_ref: bad });
		expect(r.status).toBe(400);
		expect(r.json.field).toBe("base_ref");
		expect(r.json.error).toBe(`base_ref must be a valid branch name. Got: ${bad}`);
	});

	test("rejects non-origin remote prefix with the exact error string", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-nonorigin-"));
		gitInit(root);
		const id = await registerProject(`baseref-nonorigin-${Date.now()}`, root);
		const bad = "upstream/main";
		const r = await put(id, { base_ref: bad });
		expect(r.status).toBe(400);
		expect(r.json.field).toBe("base_ref");
		expect(r.json.error).toBe(
			`base_ref only supports the 'origin' remote today. Got: ${bad}. If you need a different primary remote, configure it as 'origin' in your local clone.`,
		);
	});

	test("rejects local ref when sandbox = docker with the exact error string", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-sandbox-"));
		gitInit(root);
		const id = await registerProject(`baseref-sandbox-${Date.now()}`, root);
		// First flip sandbox to docker.
		const r1 = await put(id, { sandbox: "docker" });
		expect(r1.status).toBe(200);
		const r2 = await put(id, { base_ref: "master" });
		expect(r2.status).toBe(400);
		expect(r2.json.field).toBe("base_ref");
		expect(r2.json.error).toBe(
			"base_ref must be a remote ref (origin/...) for sandboxed projects. The container has separate ref visibility from the host. Got: master",
		);
	});

	test("accepts local branch ref in a non-sandbox project", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-local-"));
		gitInit(root, { extraBranches: ["develop"] });
		const id = await registerProject(`baseref-local-${Date.now()}`, root);
		const r = await put(id, { base_ref: "develop" });
		expect(r.status, JSON.stringify(r.json)).toBe(200);
		const cfg = await get(id);
		expect(cfg.base_ref).toBe("develop");
	});

	test("multi-repo: missing ref in subset of components returns 400 with structured details[]", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-multi-"));
		const repoA = path.join(root, "api");
		const repoB = path.join(root, "web");
		const repoC = path.join(root, "shared");
		gitInit(repoA);
		gitInit(repoB);
		gitInit(repoC);
		// Only `api` has origin/develop. `web` and `shared` lack it.
		fakeOriginRef(repoA, "develop");

		const id = await registerProject(
			`baseref-multi-${Date.now()}`,
			root,
			[
				{ name: "api", repo: "api" },
				{ name: "web", repo: "web" },
				{ name: "shared", repo: "shared" },
			],
		);

		const r = await put(id, { base_ref: "origin/develop" });
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

	test("validation only fires when base_ref is in the PUT body", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-skip-"));
		gitInit(root);
		const id = await registerProject(`baseref-skip-${Date.now()}`, root);
		// Save an unrelated key — should succeed without consulting git.
		const r = await put(id, { build_command: "echo build" });
		expect(r.status).toBe(200);
	});

	test("whitespace-only value is treated as unset (200)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-baseref-ws-"));
		gitInit(root);
		const id = await registerProject(`baseref-ws-${Date.now()}`, root);
		const r = await put(id, { base_ref: "   " });
		expect(r.status, JSON.stringify(r.json)).toBe(200);
	});
});
