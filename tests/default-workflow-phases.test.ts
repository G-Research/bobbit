/**
 * Verify that default workflow YAMLs have the build step as a dedicated
 * phase 0 (runs alone), with other verification commands on phase 1 or
 * later. This guarantees the build fails fast before the rest of the
 * verification fans out.
 *
 * Runs via `npm run test:unit` — no server / no Playwright.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowsDir = path.resolve(__dirname, "..", "defaults", "workflows");

interface VerifyStep {
	name: string;
	type: string;
	run?: string;
	phase?: number;
}
interface Gate {
	id: string;
	verify?: VerifyStep[];
}
interface Workflow {
	id: string;
	gates: Gate[];
}

function loadWorkflow(file: string): Workflow {
	const raw = readFileSync(path.join(workflowsDir, file), "utf8");
	return parseYaml(raw) as Workflow;
}

const WORKFLOWS = ["general.yaml", "feature.yaml", "bug-fix.yaml", "quick-fix.yaml"];

describe("default workflows — build step phase 0", () => {
	for (const file of WORKFLOWS) {
		it(`${file}: implementation gate has a Build step at phase 0, alone`, () => {
			const wf = loadWorkflow(file);
			const impl = wf.gates.find(g => g.id === "implementation");
			assert.ok(impl, `${file}: expected an "implementation" gate`);
			const steps = impl!.verify || [];
			const buildStep = steps.find(s => s.name.toLowerCase() === "build");
			assert.ok(buildStep, `${file}: expected a "Build" verify step`);
			assert.equal(buildStep!.type, "command");
			assert.ok(
				buildStep!.run && buildStep!.run.includes("{{project.build_command}}"),
				`${file}: Build step should invoke {{project.build_command}}`,
			);
			// Phase 0 is the default when `phase` is omitted.
			const buildPhase = buildStep!.phase ?? 0;
			assert.equal(buildPhase, 0, `${file}: Build must be phase 0`);

			// No other step shares phase 0 — build runs alone.
			const otherPhase0 = steps.filter(s => s !== buildStep && (s.phase ?? 0) === 0);
			assert.deepEqual(
				otherPhase0.map(s => s.name),
				[],
				`${file}: only Build should be on phase 0; found other phase-0 steps`,
			);

			// Typecheck / unit / E2E commands must be on phase >= 1.
			for (const s of steps) {
				if (s === buildStep) continue;
				if (s.type !== "command") continue;
				const phase = s.phase ?? 0;
				assert.ok(
					phase >= 1,
					`${file}: command step "${s.name}" must be on phase >= 1 (found ${phase})`,
				);
			}
		});
	}
});
