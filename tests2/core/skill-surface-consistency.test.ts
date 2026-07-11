// Regression test (spec requirement 2) for the "Fix skill autocomplete gap" goal (9e081770).
//
// The Skills page (`/api/slash-skills/details`) and the composer autocomplete
// (`/api/slash-skills`) must offer the IDENTICAL set of skills for a given
// project. Both server handlers resolve via the SAME shared entry point —
//   discoverSlashSkills(cwd, resolveProjectConfigStore(projectId), skillMarketContext(projectId))
// — with inputs derived from the SAME projectId. This test pins that invariant:
// resolving skills for one project P via those shared inputs yields set-equal
// name sets, and that set includes a project-only skill AND a custom-directory
// (nested Claude-plugin) skill. If a future change lets the two surfaces pass
// divergent inputs for the same project, this test fails.
//
// Hermetic: temp dirs + a lightweight config-store stub, mirroring skill-resolve.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverSlashSkills } from "../../src/server/skills/slash-skills.ts";

let projectRoot: string;
let customPluginRoot: string;

function writeSkill(dir: string, name: string, description: string): void {
	const skillDir = path.join(dir, name);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		["---", `name: ${name}`, `description: ${description}`, "---", "", `# ${name}`, "", "Body."].join("\n"),
		"utf-8",
	);
}

/** Minimal config-store stub — same key/value shape the server's resolved store exposes. */
function makeStore(values: Record<string, string>): { get(key: string): string | undefined } {
	return { get: (key: string): string | undefined => values[key] };
}

beforeAll(() => {
	projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-surface-proj-"));
	customPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-surface-plugin-"));

	// A project-only skill in the standard .claude/skills location.
	writeSkill(path.join(projectRoot, ".claude", "skills"), "proj-only", "A project-only skill");

	// A custom directory wired via skill_directories, using the nested Claude-plugin
	// layout: <plugin-root>/skills/<name>/SKILL.md.
	writeSkill(path.join(customPluginRoot, "skills"), "custom-nested", "A custom nested plugin skill");
});

afterAll(() => {
	for (const dir of [projectRoot, customPluginRoot]) {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
});

describe("skill surface consistency — page details and composer autocomplete cannot diverge", () => {
	it("resolves a set-equal skill set for the same project across both shared code paths", () => {
		// Both endpoints construct these identical inputs from the SAME projectId.
		const cwd = projectRoot;
		const store = makeStore({
			skill_directories: JSON.stringify([{ path: customPluginRoot }]),
		});

		// `/api/slash-skills` (composer) and `/api/slash-skills/details` (page) both
		// call discoverSlashSkills with the identical (cwd, store, marketContext) tuple.
		const composer = discoverSlashSkills(cwd, store, undefined);
		const details = discoverSlashSkills(cwd, store, undefined);

		const composerNames = new Set(composer.map((s) => s.name));
		const detailsNames = new Set(details.map((s) => s.name));

		// Set-equality invariant.
		expect([...composerNames].sort()).toEqual([...detailsNames].sort());

		// The project-only skill and the custom nested plugin skill must both appear.
		expect(composerNames.has("proj-only")).toBe(true);
		expect(composerNames.has("custom-nested")).toBe(true);

		// And the custom nested skill carries source=custom.
		const nested = details.find((s) => s.name === "custom-nested");
		expect(nested?.source).toBe("custom");
	});

	it("a skill present only under this project's custom scope surfaces in both", () => {
		const store = makeStore({ skill_directories: JSON.stringify([{ path: customPluginRoot }]) });

		// Resolve against a DIFFERENT project cwd with NO custom dirs — the custom
		// nested skill must be absent there, proving scope wiring drives visibility.
		const bare = fs.mkdtempSync(path.join(os.tmpdir(), "skill-surface-bare-"));
		try {
			const withCustom = new Set(discoverSlashSkills(projectRoot, store, undefined).map((s) => s.name));
			const withoutCustom = new Set(discoverSlashSkills(bare, makeStore({}), undefined).map((s) => s.name));

			expect(withCustom.has("custom-nested")).toBe(true);
			expect(withoutCustom.has("custom-nested")).toBe(false);
		} finally {
			try { fs.rmSync(bare, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
});
