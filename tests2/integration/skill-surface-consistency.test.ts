/**
 * Real-gateway endpoint parity for a skill owned by a project's rootPath.
 * Kept in its own file so the fixed three-worker unit lane can run the three
 * independent skill-scope fixtures concurrently within the per-file budget.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { waitForHealth, apiFetch, registerProject } from "./_e2e/e2e-setup.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_SKILL = "only-in-p";

let projectRoot: string;
let projectId: string;

function writeProjectSkill(root: string): void {
	const dir = join(root, ".claude", "skills", PROJECT_SKILL);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${PROJECT_SKILL}\ndescription: A skill that exists only under project P\n---\n\n# ${PROJECT_SKILL}\n\nBody.\n`,
	);
}

async function fetchNames(path: string): Promise<string[]> {
	const response = await apiFetch(path);
	expect(response.ok, `${path} -> ${response.status}`).toBe(true);
	const data = await response.json();
	return (data.skills ?? []).map((skill: { name: string }) => skill.name);
}

test.beforeAll(async () => {
	await waitForHealth();
	const stamp = `${process.pid}-${Date.now()}`;
	projectRoot = join(tmpdir(), `bobbit-skill-surface-project-${stamp}`);
	writeProjectSkill(projectRoot);
	projectId = (await registerProject({
		name: `skill-surface-project-${stamp}`,
		rootPath: projectRoot,
		seedWorkflows: false,
	})).id;
});

test.afterAll(async () => {
	if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
	if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
});

test.describe("Skill surface consistency — page details vs composer autocomplete", () => {
	test("both endpoints resolve a set-equal skill set for project P, including only-in-p", async () => {
		const composer = await fetchNames(`/api/slash-skills?projectId=${encodeURIComponent(projectId)}`);
		const details = await fetchNames(`/api/slash-skills/details?projectId=${encodeURIComponent(projectId)}`);

		expect([...new Set(composer)].sort()).toEqual([...new Set(details)].sort());
		expect(composer).toContain(PROJECT_SKILL);
		expect(details).toContain(PROJECT_SKILL);
	});
});
