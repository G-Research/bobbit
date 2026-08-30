/**
 * Multi-repo project plumbing — create with components, update config, validator.
 *
 * See docs/design/multi-repo-components.md §8.5 / §9.2.
 */
import { describe, it } from "vitest";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, readE2EToken, base, registerProject } from "./_e2e/e2e-setup.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let token: string;
let fixtureRoot: string;
let multiRoot: string;
let singleRoot: string;
let multiProject: { id: string };
let singleProject: { id: string };
let multiYamlSnapshot: string;
let singleYamlSnapshot: string;

const headers = () => ({
	Authorization: `Bearer ${token}`,
	"Content-Type": "application/json",
});

function componentDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "README.md"), "x\n");
}

function projectYaml(root: string): string {
	return fs.readFileSync(path.join(root, ".bobbit", "config", "project.yaml"), "utf-8");
}

test.beforeAll(async () => {
	token = readE2EToken();
	fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-mr-shared-"));
	multiRoot = path.join(fixtureRoot, "multi");
	singleRoot = path.join(fixtureRoot, "single");
	componentDir(path.join(multiRoot, "api"));
	componentDir(path.join(multiRoot, "web"));
	fs.mkdirSync(path.join(multiRoot, "shared"), { recursive: true });
	componentDir(singleRoot);
	componentDir(path.join(singleRoot, "web"));

	const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	multiProject = await registerProject({
		name: `mr-${stamp}`,
		rootPath: multiRoot,
		components: [
			{ name: "api", repo: "api", commands: { build: "npm run build", test: "npm test" } },
			{ name: "web", repo: "web", commands: { build: "vite build" } },
			{ name: "shared", repo: "shared" },
		],
		workflows: {
			simple: {
				id: "simple", name: "Simple", gates: [{ id: "implementation", name: "Build" }],
			},
		},
	});
	singleProject = await registerProject({ name: `sr-${stamp}`, rootPath: singleRoot });

	// Both saves are synchronous. Snapshot their immutable declaration state once
	// so the assertions never poll the filesystem under worker contention.
	multiYamlSnapshot = projectYaml(multiRoot);
	singleYamlSnapshot = projectYaml(singleRoot);
});

test.afterAll(async () => {
	for (const id of [singleProject?.id, multiProject?.id]) {
		if (id) await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
	}
	if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("multi-repo project declarations", () => {
	it("multi-repo: POST /api/projects with components + workflows persists structured fields", async () => {
		const cfgRes = await fetch(`${base()}/api/projects/${multiProject.id}/config`, { headers: headers() });
		expect(cfgRes.status).toBe(200);
		expect(multiYamlSnapshot).toContain("components:");
		expect(multiYamlSnapshot).toContain("name: api");
		expect(multiYamlSnapshot).toContain("name: shared");
		expect(multiYamlSnapshot).toContain("workflows:");
	});

	it("single-repo POST without components fills default [{name, repo: '.'}]", () => {
		expect(singleYamlSnapshot).toContain("name: sr-");
		expect(singleYamlSnapshot).toMatch(/repo:\s*[."']\.?["']?/);
	});

	it("PUT /api/projects/:id/config with bad workflow step → 400", async () => {
		const putRes = await fetch(`${base()}/api/projects/${multiProject.id}/config`, {
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

	it("PUT /api/projects/:id/config adds a new component", async () => {
		const putRes = await fetch(`${base()}/api/projects/${singleProject.id}/config`, {
			method: "PUT",
			headers: headers(),
			body: JSON.stringify({
				components: [
					{ name: "single", repo: "." },
					{ name: "web", repo: "web", commands: { build: "vite build" } },
				],
			}),
		});
		expect(putRes.status).toBe(200);
		expect(projectYaml(singleRoot)).toContain("name: web");
	});
});
