/**
 * Acceptance test for the shipped autoresearch plugin in defaults/plugins/.
 *
 * Verifies the manifest validates, the workflow YAML parses through the
 * install pipeline, and the resulting workflow has the expected gate DAG
 * and verify-step types. This is the smoke test that catches "plugin shipped
 * with a broken YAML" regressions.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { readManifest } from "../src/server/plugins/plugin-manifest.ts";
import { installPluginIntoProject } from "../src/server/plugins/project-install.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.ts";

const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..", "defaults", "plugins", "autoresearch");

describe("autoresearch plugin (defaults/plugins/autoresearch)", () => {
	it("ships a valid plugin.yaml manifest", () => {
		const { manifest, errors } = readManifest(PLUGIN_ROOT);
		assert.deepEqual(errors, [], `manifest errors: ${JSON.stringify(errors)}`);
		assert.equal(manifest.name, "autoresearch");
		assert.match(manifest.version, /^\d+\.\d+\.\d+/);
		assert.deepEqual(manifest.contributes?.workflows, ["workflows/autoresearch.yaml"]);
		// Data-only — no gateway entry to import, no UI bundle to serve.
		assert.equal(manifest.entryPoints, undefined);
	});

	it("installs into a project and registers the namespaced workflow", () => {
		const cfg = new ProjectConfigStore(fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-test-")));
		const { manifest, errors } = readManifest(PLUGIN_ROOT);
		assert.deepEqual(errors, []);

		const result = installPluginIntoProject(cfg, {
			name: manifest.name,
			path: PLUGIN_ROOT,
			source: "builtin",
			manifest,
			manifestErrors: [],
		});

		assert.equal(result.ok, true, `install failed: ${JSON.stringify(result)}`);
		if (result.ok) {
			assert.deepEqual(result.workflowsInstalled, ["autoresearch::research"]);
		}
		assert.equal(cfg.isPluginInstalled("autoresearch"), true);
	});

	it("the installed workflow has the expected gate DAG and verify-step types", () => {
		const cfg = new ProjectConfigStore(fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-test-")));
		const { manifest } = readManifest(PLUGIN_ROOT);
		installPluginIntoProject(cfg, {
			name: manifest.name,
			path: PLUGIN_ROOT,
			source: "builtin",
			manifest,
			manifestErrors: [],
		});

		const wfStore = new InlineWorkflowStore(cfg);
		const wf = wfStore.get("autoresearch::research");
		assert.ok(wf, "namespaced workflow id 'autoresearch::research' should exist after install");
		assert.equal(wf.pluginSource?.name, "autoresearch");
		assert.equal(wf.pluginSource?.originalId, "research");

		const gateById = new Map(wf.gates.map(g => [g.id, g]));
		// Expected DAG: idea → literature → plan → experiment-run → analysis → publication
		assert.deepEqual(gateById.get("idea")?.dependsOn, []);
		assert.deepEqual(gateById.get("literature")?.dependsOn, ["idea"]);
		assert.deepEqual(gateById.get("plan")?.dependsOn, ["literature"]);
		assert.deepEqual(gateById.get("experiment-run")?.dependsOn, ["plan"]);
		assert.deepEqual(gateById.get("analysis")?.dependsOn, ["experiment-run"]);
		assert.deepEqual(gateById.get("publication")?.dependsOn, ["analysis"]);

		// publication is manual — no automated verify, user clicks Mark passed.
		assert.equal(gateById.get("publication")?.manual, true);
		assert.equal(gateById.get("publication")?.verify, undefined);

		// idea has no verify — content gate only.
		assert.equal(gateById.get("idea")?.verify, undefined);
		assert.equal(gateById.get("idea")?.content, true);
		assert.equal(gateById.get("idea")?.injectDownstream, true);

		// literature / plan / analysis use rubric-review (LLM) with pass_when criteria.
		for (const id of ["literature", "plan", "analysis"]) {
			const gate = gateById.get(id);
			assert.ok(gate, `gate ${id} should exist`);
			assert.equal(gate.content, true, `gate ${id} should be a content gate`);
			assert.equal(gate.injectDownstream, true, `gate ${id} should inject downstream`);
			const rubricStep = gate.verify?.find(s => s.type === "rubric-review");
			assert.ok(rubricStep, `gate ${id} should have a rubric-review step`);
			assert.equal(rubricStep.reviewer, "llm");
			assert.ok(Array.isArray(rubricStep.rubric) && rubricStep.rubric.length > 0);
			assert.ok(typeof rubricStep.pass_when === "string" && rubricStep.pass_when.length > 0,
				`rubric on '${id}' should declare a pass_when expression`);
		}

		// experiment-run uses external-job with a multi-day timeout budget.
		const experimentGate = gateById.get("experiment-run");
		assert.ok(experimentGate, "experiment-run gate should exist");
		const externalStep = experimentGate.verify?.find(s => s.type === "external-job");
		assert.ok(externalStep, "experiment-run should have an external-job step");
		assert.ok(typeof externalStep.timeout === "number" && externalStep.timeout >= 24 * 3600,
			"external-job timeout should be at least 24h for real experiment runs");
	});
});
