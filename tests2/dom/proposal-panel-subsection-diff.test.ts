import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/proposal-panel-subsection-diff.spec.ts (v2-dom tier).
// The legacy Playwright fixture esbuild-bundled ProjectProposalPanel and called
// diffProjectYaml/renderProjectProposalDiff off `window`. Here we import the REAL
// functions from src and call them directly — same behaviour, higher fidelity.
import { describe, expect, it } from "vitest";
import { diffProjectYaml, renderProjectProposalDiff } from "../../src/ui/components/ProjectProposalPanel.js";

describe("project proposal sub-section YAML diff", () => {
	it("identical YAML → all sections unchanged", () => {
		const yaml = `name: foo\nbuild_command: npm run build\n`;
		const result = diffProjectYaml(yaml, yaml);
		expect(result.changedCount).toBe(0);
		for (const section of result.sections) {
			expect(section.status).toBe("unchanged");
		}
	});

	it("workflows-only edit produces a single changed section", () => {
		const oldYaml = `name: foo\nbuild_command: npm run build\nworkflows:\n  general:\n    name: General\n    gates: []\n`;
		const newYaml = `name: foo\nbuild_command: npm run build\nworkflows:\n  general:\n    name: General Updated\n    gates: []\n`;
		const result = diffProjectYaml(oldYaml, newYaml);
		expect(result.changedCount).toBe(1);
		const changed = result.sections.find((s: any) => s.status === "changed");
		expect(changed?.key).toBe("workflows");
		const unchangedKeys = result.sections.filter((s: any) => s.status === "unchanged").map((s: any) => s.key);
		expect(unchangedKeys).toContain("name");
		expect(unchangedKeys).toContain("build_command");
	});

	it("components added → status 'added' and 'unchanged' for unrelated keys", () => {
		const oldYaml = `name: foo\nbuild_command: npm run build\n`;
		const newYaml = `name: foo\nbuild_command: npm run build\ncomponents:\n  - name: foo\n    repo: .\n`;
		const result = diffProjectYaml(oldYaml, newYaml);
		expect(result.changedCount).toBe(1);
		const added = result.sections.find((s: any) => s.key === "components");
		expect(added?.status).toBe("added");
		expect(added?.oldYaml).toBe("");
		expect(added?.newYaml).toContain("name: foo");
	});

	it("components removed → status 'removed'", () => {
		const oldYaml = `name: foo\ncomponents:\n  - name: foo\n    repo: .\n`;
		const newYaml = `name: foo\n`;
		const result = diffProjectYaml(oldYaml, newYaml);
		const removed = result.sections.find((s: any) => s.key === "components");
		expect(removed?.status).toBe("removed");
	});

	it("renderProjectProposalDiff omits unchanged sections from the unified diff", () => {
		const oldYaml = `name: foo\nbuild_command: npm run build\nworkflows:\n  general:\n    name: General\n`;
		const newYaml = `name: foo\nbuild_command: npm run build\nworkflows:\n  general:\n    name: New\n`;
		const text = renderProjectProposalDiff(oldYaml, newYaml);
		expect(text).toContain("workflows (changed)");
		expect(text).not.toContain("build_command (unchanged)");
		expect(text).not.toContain("name (unchanged)");
	});

	it("known structural keys (workflows, components) get a stable order", () => {
		const oldYaml = `zzz: 1\nworkflows: {}\nbuild_command: x\ncomponents: []\nname: foo\nworktree_root: /tmp\n`;
		const newYaml = `zzz: 2\nworkflows: { general: { name: G } }\nbuild_command: y\ncomponents: [{ name: a, repo: . }]\nname: bar\nworktree_root: /opt\n`;
		const keys = diffProjectYaml(oldYaml, newYaml).sections.map((s: any) => s.key);
		// known order: name, rootPath, worktree_root, components, workflows, then alphabetical
		expect(keys.indexOf("name")).toBeLessThan(keys.indexOf("worktree_root"));
		expect(keys.indexOf("worktree_root")).toBeLessThan(keys.indexOf("components"));
		expect(keys.indexOf("components")).toBeLessThan(keys.indexOf("workflows"));
		expect(keys.indexOf("workflows")).toBeLessThan(keys.indexOf("zzz"));
		expect(keys.indexOf("build_command")).toBeLessThan(keys.indexOf("zzz"));
	});
});
