/** Real-gateway endpoint parity and project-to-project skill scope isolation. */
import { test, expect } from "./_e2e/in-process-harness.js";
import { waitForHealth, apiFetch, registerProject } from "./_e2e/e2e-setup.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OTHER_PROJECT_SKILL = "only-in-p";

let otherProjectRoot: string;
let isolatedProjectRoot: string;
let otherProjectId: string;
let isolatedProjectId: string;

function writeOtherProjectSkill(root: string): void {
	const dir = join(root, ".claude", "skills", OTHER_PROJECT_SKILL);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${OTHER_PROJECT_SKILL}\ndescription: A skill that belongs to a different project\n---\n\n# ${OTHER_PROJECT_SKILL}\n\nBody.\n`,
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
	otherProjectRoot = join(tmpdir(), `bobbit-skill-surface-other-${stamp}`);
	isolatedProjectRoot = join(tmpdir(), `bobbit-skill-surface-isolated-${stamp}`);
	writeOtherProjectSkill(otherProjectRoot);
	mkdirSync(join(isolatedProjectRoot, ".claude", "skills"), { recursive: true });
	otherProjectId = (await registerProject({
		name: `skill-surface-other-${stamp}`,
		rootPath: otherProjectRoot,
		seedWorkflows: false,
	})).id;
	isolatedProjectId = (await registerProject({
		name: `skill-surface-isolated-${stamp}`,
		rootPath: isolatedProjectRoot,
		seedWorkflows: false,
	})).id;
});

test.afterAll(async () => {
	if (otherProjectId) await apiFetch(`/api/projects/${otherProjectId}`, { method: "DELETE" }).catch(() => {});
	if (isolatedProjectId) await apiFetch(`/api/projects/${isolatedProjectId}`, { method: "DELETE" }).catch(() => {});
	if (otherProjectRoot) rmSync(otherProjectRoot, { recursive: true, force: true });
	if (isolatedProjectRoot) rmSync(isolatedProjectRoot, { recursive: true, force: true });
});

test.describe("Skill surface consistency — scope isolation", () => {
	test("both endpoints exclude a different project's skill and stay set-equal", async () => {
		// Prime discovery with the other project's visible skill. This makes the
		// isolation assertion cover both project resolution and cache partitioning.
		const otherComposer = await fetchNames(`/api/slash-skills?projectId=${encodeURIComponent(otherProjectId)}`);
		expect(otherComposer).toContain(OTHER_PROJECT_SKILL);

		const composer = await fetchNames(`/api/slash-skills?projectId=${encodeURIComponent(isolatedProjectId)}`);
		const details = await fetchNames(`/api/slash-skills/details?projectId=${encodeURIComponent(isolatedProjectId)}`);

		expect(composer).not.toContain(OTHER_PROJECT_SKILL);
		expect(details).not.toContain(OTHER_PROJECT_SKILL);
		expect([...new Set(composer)].sort()).toEqual([...new Set(details)].sort());
	});
});
