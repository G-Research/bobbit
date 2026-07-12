/**
 * Two-endpoint integration regression for the "Fix skill autocomplete gap"
 * goal (9e081770), spec requirement 2.
 *
 * The Skills page (`/api/slash-skills/details`) and the composer autocomplete
 * (`/api/slash-skills`) MUST offer the IDENTICAL set of skills for a given
 * project. The earlier core test called `discoverSlashSkills(...)` twice with
 * byte-identical args and compared — tautological: it could not catch
 * endpoint / parameter / projectId / config-store / market-context divergence
 * between the two REST handlers, which is the actual bug surface.
 *
 * This test drives the REAL gateway: register a project P whose rootPath owns a
 * project-only skill, then fetch BOTH endpoints with `projectId=<P>` and assert
 * the returned skill-`name` sets are set-equal AND include the project-only
 * skill. A second project Q (without that skill) proves scope isolation: Q's
 * autocomplete must NOT surface P's skill.
 *
 * Follows tests2/integration/slash-skill-e2e.test.ts: waitForHealth +
 * registerProject + apiFetch, with a DEDICATED per-worker tmp rootPath per
 * project so the 5s discoverSlashSkills cache (keyed on cwd) cannot mask a
 * freshly-written SKILL.md.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { waitForHealth, apiFetch, registerProject } from "./_e2e/e2e-setup.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const P_SKILL = "only-in-p";
const R_SKILL = "only-in-custom-dir";

let pRoot: string;
let qRoot: string;
let rRoot: string;
let rCustomDir: string;
let pProjectId: string;
let qProjectId: string;
let rProjectId: string;

function writeSkill(root: string, name: string, description: string): void {
	const dir = join(root, ".claude", "skills", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`,
	);
}

async function fetchNames(path: string): Promise<string[]> {
	const resp = await apiFetch(path);
	expect(resp.ok, `${path} -> ${resp.status}`).toBe(true);
	const data = await resp.json();
	return (data.skills ?? []).map((s: { name: string }) => s.name);
}

test.beforeAll(async () => {
	await waitForHealth();

	const stamp = `${process.pid}-${Date.now()}`;
	pRoot = join(tmpdir(), `bobbit-skill-surface-p-${stamp}`);
	qRoot = join(tmpdir(), `bobbit-skill-surface-q-${stamp}`);

	// Project-only skill lives under P's rootPath. Q gets no custom skill.
	writeSkill(pRoot, P_SKILL, "A skill that exists only under project P");
	mkdirSync(join(qRoot, ".claude", "skills"), { recursive: true });

	// Project R exercises a PROJECT-SCOPE custom skill directory (Facet 1b): the
	// skill lives in a directory OUTSIDE R's rootPath, wired via config_directories.
	rRoot = join(tmpdir(), `bobbit-skill-surface-r-${stamp}`);
	rCustomDir = join(tmpdir(), `bobbit-skill-custom-dir-${stamp}`);
	mkdirSync(join(rRoot, ".claude", "skills"), { recursive: true });
	writeSkill(rCustomDir, R_SKILL, "A skill wired via a project-scope custom directory");

	const p = await registerProject({ name: `skill-surface-p-${stamp}`, rootPath: pRoot, seedWorkflows: false });
	const q = await registerProject({ name: `skill-surface-q-${stamp}`, rootPath: qRoot, seedWorkflows: false });
	const r = await registerProject({ name: `skill-surface-r-${stamp}`, rootPath: rRoot, seedWorkflows: false });
	pProjectId = p.id;
	qProjectId = q.id;
	rProjectId = r.id;
});

test.afterAll(async () => {
	if (pProjectId) await apiFetch(`/api/projects/${pProjectId}`, { method: "DELETE" }).catch(() => {});
	if (qProjectId) await apiFetch(`/api/projects/${qProjectId}`, { method: "DELETE" }).catch(() => {});
	if (rProjectId) await apiFetch(`/api/projects/${rProjectId}`, { method: "DELETE" }).catch(() => {});
});

test.describe("Skill surface consistency — page details vs composer autocomplete", () => {
	test("both endpoints resolve a set-equal skill set for project P, including only-in-p", async () => {
		const composer = await fetchNames(`/api/slash-skills?projectId=${encodeURIComponent(pProjectId)}`);
		const details = await fetchNames(`/api/slash-skills/details?projectId=${encodeURIComponent(pProjectId)}`);

		// Set-equality: the two surfaces cannot diverge for the same project.
		expect([...new Set(composer)].sort()).toEqual([...new Set(details)].sort());

		// The project-only skill must appear in BOTH.
		expect(composer).toContain(P_SKILL);
		expect(details).toContain(P_SKILL);
	});

	test("a project-scope custom skill directory is honored by BOTH surfaces (Facet 1b)", async () => {
		// Wire the custom directory (outside rootPath) via project-scope config BEFORE
		// discovery. config_directories participates in the discovery cache key, so this
		// PUT invalidates any prior cached list for R.
		const put = await apiFetch(`/api/projects/${encodeURIComponent(rProjectId)}/config`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ config_directories: [{ path: rCustomDir, types: ["skills"] }], skill_directories: null }),
		});
		expect(put.ok, `config PUT -> ${put.status}`).toBe(true);

		const composer = await fetchNames(`/api/slash-skills?projectId=${encodeURIComponent(rProjectId)}`);
		const details = await fetchNames(`/api/slash-skills/details?projectId=${encodeURIComponent(rProjectId)}`);

		// Both surfaces must include the custom-dir skill and stay set-equal.
		expect(composer).toContain(R_SKILL);
		expect(details).toContain(R_SKILL);
		expect([...new Set(composer)].sort()).toEqual([...new Set(details)].sort());
	});

	test("a different project Q does not surface P's project-only skill (scope isolation)", async () => {
		const qComposer = await fetchNames(`/api/slash-skills?projectId=${encodeURIComponent(qProjectId)}`);
		const qDetails = await fetchNames(`/api/slash-skills/details?projectId=${encodeURIComponent(qProjectId)}`);

		expect(qComposer).not.toContain(P_SKILL);
		expect(qDetails).not.toContain(P_SKILL);
		// Q's own two surfaces stay set-equal too.
		expect([...new Set(qComposer)].sort()).toEqual([...new Set(qDetails)].sort());
	});
});
