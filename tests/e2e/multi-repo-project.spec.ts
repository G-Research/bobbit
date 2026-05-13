/**
 * Multi-repo project plumbing — create with components, update config, validator.
 *
 * See docs/design/multi-repo-components.md §8.5 / §9.2.
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

function gitInit(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "--quiet"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@bobbit.local"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "README.md"), "x\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: dir });
}

test.beforeAll(() => { token = readE2EToken(); });

test("multi-repo: POST /api/projects with components + workflows persists structured fields", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-mr-")));
	gitInit(path.join(root, "api"));
	gitInit(path.join(root, "web"));
	fs.mkdirSync(path.join(root, "shared"));  // data-only

	const res = await fetch(`${base()}/api/projects`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({
			name: `mr-${Date.now()}`,
			rootPath: root,
			components: [
				{ name: "api", repo: "api", commands: { build: "npm run build", test: "npm test" } },
				{ name: "web", repo: "web", commands: { build: "vite build" } },
				{ name: "shared", repo: "shared" },  // data-only
			],
			workflows: {
				simple: {
					id: "simple", name: "Simple", gates: [{ id: "implementation", name: "Build" }],
				},
			},
		}),
	});
	expect(res.status).toBe(201);
	const project = await res.json();

	const cfgRes = await fetch(`${base()}/api/projects/${project.id}/config`, { headers: headers() });
	expect(cfgRes.status).toBe(200);
	// Components are stored on disk in project.yaml; verify the Yaml directly.
	const yamlPath = path.join(root, ".bobbit", "config", "project.yaml");
	expect(fs.existsSync(yamlPath)).toBe(true);
	const yamlContent = fs.readFileSync(yamlPath, "utf-8");
	expect(yamlContent).toContain("components:");
	expect(yamlContent).toContain("name: api");
	expect(yamlContent).toContain("name: shared");
	expect(yamlContent).toContain("workflows:");
});

test("single-repo POST without components fills default [{name, repo: '.'}]", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-sr-")));
	gitInit(root);

	const projName = `sr-${Date.now()}`;
	const res = await fetch(`${base()}/api/projects`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({ name: projName, rootPath: root }),
	});
	expect(res.status).toBe(201);
	const project = await res.json();

	const yamlPath = path.join(root, ".bobbit", "config", "project.yaml");
	// Wait briefly for the autosave (synchronous in setComponents but defensive).
	for (let i = 0; i < 10 && !fs.existsSync(yamlPath); i++) {
		await new Promise(r => setTimeout(r, 50));
	}
	expect(fs.existsSync(yamlPath)).toBe(true);
	const yamlContent = fs.readFileSync(yamlPath, "utf-8");
	expect(yamlContent).toContain(`name: ${projName}`);
	expect(yamlContent).toMatch(/repo:\s*[."']\.?["']?/);
	void project;
});

test("PUT /api/projects/:id/config with bad workflow step → 400", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-mr-bad-")));
	gitInit(path.join(root, "api"));

	const createRes = await fetch(`${base()}/api/projects`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({
			name: `bad-${Date.now()}`,
			rootPath: root,
			components: [{ name: "api", repo: "api", commands: { build: "npm run build" } }],
		}),
	});
	const project = await createRes.json();

	const putRes = await fetch(`${base()}/api/projects/${project.id}/config`, {
		method: "PUT",
		headers: headers(),
		body: JSON.stringify({
			components: [{ name: "api", repo: "api", commands: { build: "npm run build" } }],
			workflows: {
				bad: {
					id: "bad", name: "Bad", gates: [{
						id: "g", name: "g", verify: [
							{ name: "step1", type: "command", component: "x", command: "build" },
						],
					}],
				},
			},
		}),
	});
	expect(putRes.status).toBe(400);
	const body = await putRes.json();
	expect(body.error).toMatch(/Workflow validation failed/);
});

test("PUT /api/projects/:id/config adds a new component", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-mr-upd-")));
	gitInit(path.join(root, "api"));
	gitInit(path.join(root, "web"));

	const createRes = await fetch(`${base()}/api/projects`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({
			name: `upd-${Date.now()}`,
			rootPath: root,
			components: [{ name: "api", repo: "api" }],
		}),
	});
	const project = await createRes.json();

	const putRes = await fetch(`${base()}/api/projects/${project.id}/config`, {
		method: "PUT",
		headers: headers(),
		body: JSON.stringify({
			components: [
				{ name: "api", repo: "api" },
				{ name: "web", repo: "web", commands: { build: "vite build" } },
			],
		}),
	});
	expect(putRes.status).toBe(200);

	const yamlContent = fs.readFileSync(path.join(root, ".bobbit", "config", "project.yaml"), "utf-8");
	expect(yamlContent).toContain("name: web");
});
