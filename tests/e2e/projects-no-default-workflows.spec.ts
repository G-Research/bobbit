/**
 * Verifies that POST /api/projects no longer silently seeds default workflows
 * when the proposal omits a `workflows` block. Workflows are the project
 * assistant's responsibility — the server has no fallback.
 *
 * See docs/internals.md and the "No default workflow scaffold" design doc.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import yaml from "yaml";

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

function readProjectYaml(root: string): Record<string, unknown> | null {
	const p = path.join(root, ".bobbit", "config", "project.yaml");
	if (!fs.existsSync(p)) return null;
	return yaml.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
}

function isWorkflowsAbsentOrEmpty(parsed: Record<string, unknown> | null): boolean {
	if (!parsed) return true;
	const wf = parsed.workflows;
	if (wf === undefined || wf === null) return true;
	if (typeof wf !== "object" || Array.isArray(wf)) return false;
	return Object.keys(wf as Record<string, unknown>).length === 0;
}

test.beforeAll(() => { token = readE2EToken(); });

test.describe("No default workflow scaffold", () => {
	test("Case A — POST /api/projects without workflows persists with zero workflows", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-nodef-a-"));
		gitInit(root);

		const projName = `nodef-a-${Date.now()}`;
		const res = await fetch(`${base()}/api/projects`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({
				name: projName,
				rootPath: root,
				components: [{ name: projName, repo: "." }],
				// NOTE: no `workflows` field
			}),
		});
		expect([200, 201]).toContain(res.status);
		const project = await res.json();

		// Wait briefly for the autosave to flush.
		const yamlPath = path.join(root, ".bobbit", "config", "project.yaml");
		await pollUntil(() => fs.existsSync(yamlPath) ? true : null, { timeoutMs: 2000, intervalMs: 25, label: "project.yaml exists" });

		// On-disk: no workflows: block (or empty mapping).
		const parsed = readProjectYaml(root);
		expect(isWorkflowsAbsentOrEmpty(parsed)).toBe(true);

		// API: GET /api/projects/:id/config — workflows absent or empty.
		const cfgRes = await fetch(`${base()}/api/projects/${project.id}/config`, { headers: headers() });
		expect(cfgRes.status).toBe(200);
		const cfg = await cfgRes.json();
		const cfgWorkflows = cfg && (cfg.workflows ?? cfg.config?.workflows);
		const empty = cfgWorkflows === undefined
			|| cfgWorkflows === null
			|| (typeof cfgWorkflows === "object" && Object.keys(cfgWorkflows).length === 0);
		expect(empty).toBe(true);
	});

	test("Case B — workflows in proposal are kept exactly, no defaults merged", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-nodef-b-"));
		gitInit(root);

		const projName = `nodef-b-${Date.now()}`;
		const inlineWorkflows = {
			custom: {
				id: "custom",
				name: "Custom",
				description: "project-specific",
				gates: [{ id: "g1", name: "G1" }],
			},
		};

		const res = await fetch(`${base()}/api/projects`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({
				name: projName,
				rootPath: root,
				components: [{ name: projName, repo: "." }],
				workflows: inlineWorkflows,
			}),
		});
		expect([200, 201]).toContain(res.status);

		const yamlPath = path.join(root, ".bobbit", "config", "project.yaml");
		await pollUntil(() => fs.existsSync(yamlPath) ? true : null, { timeoutMs: 2000, intervalMs: 25, label: "project.yaml exists" });
		const parsed = readProjectYaml(root)!;
		const wf = parsed.workflows as Record<string, any>;
		expect(typeof wf).toBe("object");
		expect(Object.keys(wf).sort()).toEqual(["custom"]);
		expect(wf.custom.name).toBe("Custom");
		// No canonical-default ids merged in.
		expect(wf.general).toBeUndefined();
		expect(wf.feature).toBeUndefined();
		expect(wf["bug-fix"]).toBeUndefined();
		expect(wf["quick-fix"]).toBeUndefined();
	});

	test("Case C — goal-creation side-effects do not seed workflows into a zero-workflows project", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-nodef-c-"));
		gitInit(root);

		const projName = `nodef-c-${Date.now()}`;
		const res = await fetch(`${base()}/api/projects`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({
				name: projName,
				rootPath: root,
				components: [{ name: projName, repo: "." }],
			}),
		});
		expect([200, 201]).toContain(res.status);
		const project = await res.json();

		const yamlPath = path.join(root, ".bobbit", "config", "project.yaml");
		await pollUntil(() => fs.existsSync(yamlPath) ? true : null, { timeoutMs: 2000, intervalMs: 25, label: "project.yaml exists" });
		const before = fs.readFileSync(yamlPath, "utf-8");
		expect(isWorkflowsAbsentOrEmpty(readProjectYaml(root))).toBe(true);

		// Best-effort: try creating a goal. Whether it succeeds or fails, the
		// invariant is that project.yaml's workflows block is unchanged.
		await fetch(`${base()}/api/goals`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({
				title: `goal-${Date.now()}`,
				cwd: root,
				projectId: project.id,
				team: false,
				// no workflowId — exercises the empty-workflows path
			}),
		}).catch(() => { /* either outcome is fine */ });

		// Re-read and verify no seeding happened.
		const after = fs.readFileSync(yamlPath, "utf-8");
		expect(isWorkflowsAbsentOrEmpty(readProjectYaml(root))).toBe(true);
		// File should be byte-identical w.r.t. the workflows section. Compare
		// whole file as a stronger assertion.
		expect(after).toBe(before);
	});
});
