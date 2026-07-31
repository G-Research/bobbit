/** Real-gateway endpoint parity for a project-scoped custom skill directory. */
import { test, expect } from "./_e2e/in-process-harness.js";
import { waitForHealth, apiFetch, registerProject } from "./_e2e/e2e-setup.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CUSTOM_SKILL = "only-in-custom-dir";

let projectRoot: string;
let customDirectory: string;
let projectId: string;

function writeCustomSkill(root: string): void {
	const dir = join(root, CUSTOM_SKILL);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${CUSTOM_SKILL}\ndescription: A skill wired via a project-scope custom directory\n---\n\n# ${CUSTOM_SKILL}\n\nBody.\n`,
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
	projectRoot = join(tmpdir(), `bobbit-skill-surface-custom-project-${stamp}`);
	customDirectory = join(tmpdir(), `bobbit-skill-surface-custom-directory-${stamp}`);
	mkdirSync(join(projectRoot, ".claude", "skills"), { recursive: true });
	writeCustomSkill(customDirectory);
	projectId = (await registerProject({
		name: `skill-surface-custom-${stamp}`,
		rootPath: projectRoot,
		seedWorkflows: false,
	})).id;
});

test.afterAll(async () => {
	if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
	if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
	if (customDirectory) rmSync(customDirectory, { recursive: true, force: true });
});

test.describe("Skill surface consistency — custom directory", () => {
	test("both endpoints honor the project-scope custom directory and stay set-equal", async () => {
		const update = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/config`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				config_directories: [{ path: customDirectory, types: ["skills"] }],
				skill_directories: null,
			}),
		});
		expect(update.ok, `config PUT -> ${update.status}`).toBe(true);

		const composer = await fetchNames(`/api/slash-skills?projectId=${encodeURIComponent(projectId)}`);
		const details = await fetchNames(`/api/slash-skills/details?projectId=${encodeURIComponent(projectId)}`);

		expect(composer).toContain(CUSTOM_SKILL);
		expect(details).toContain(CUSTOM_SKILL);
		expect([...new Set(composer)].sort()).toEqual([...new Set(details)].sort());
	});
});
