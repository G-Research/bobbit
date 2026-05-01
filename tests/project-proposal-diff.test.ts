/**
 * Unit tests for `buildProjectConfigDiff` in `src/app/project-proposal-diff.ts`.
 *
 * Regression guard: the provisional-accept path used to forward only a
 * hardcoded list of legacy command keys, silently dropping `components` and
 * `workflows`. A freshly-accepted multi-component project would land with
 * zero workflows — the goal-proposal panel then had no workflow to show.
 *
 * Both `acceptProvisionalProjectProposal` and `acceptRegisteredProjectProposal`
 * in `src/app/session-manager.ts` route through this helper, so guarding it
 * here covers both accept paths.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildProjectConfigDiff, PROJECT_NATIVE_FIELDS } from "../src/app/project-proposal-diff.js";

describe("buildProjectConfigDiff", () => {
	it("forwards structured `components` and `workflows` to the config payload", () => {
		const components = [
			{ name: "api", repo: "api", commands: { build: "npm run build" } },
			{ name: "web", repo: "web", commands: { build: "vite build" } },
		];
		const workflows = {
			feature: {
				id: "feature",
				name: "Feature",
				description: "Default feature flow",
				gates: [{ id: "ready-to-merge", name: "Ready to merge" }],
			},
		};
		const out = buildProjectConfigDiff({
			name: "my-proj",
			root_path: "/tmp/foo",
			components,
			workflows,
			build_command: "npm run build",
		});
		assert.deepEqual(out.components, components, "components must ride through structured");
		assert.deepEqual(out.workflows, workflows, "workflows must ride through structured");
		assert.equal(out.build_command, "npm run build");
		assert.ok(!("name" in out), "name handled separately");
		assert.ok(!("root_path" in out), "root_path is immutable");
	});

	it("parses JSON-string `components`/`workflows` back to structured types", () => {
		const components = [{ name: "api", repo: ".", commands: { test: "npm test" } }];
		const workflows = { general: { id: "general", name: "General", gates: [] } };
		const out = buildProjectConfigDiff({
			components: JSON.stringify(components),
			workflows: JSON.stringify(workflows),
		});
		assert.deepEqual(out.components, components);
		assert.deepEqual(out.workflows, workflows);
	});

	it("drops empty / null / undefined values so we don't clobber persisted state", () => {
		const out = buildProjectConfigDiff({
			build_command: "",
			test_command: undefined,
			typecheck_command: null,
			sandbox: "docker",
		});
		assert.deepEqual(out, { sandbox: "docker" });
	});

	it("preserves remaining native-YAML fields as structured payloads", () => {
		// `qa_env`, `qa_max_duration_minutes`, `qa_max_scenarios` are no longer
		// native-YAML top-level fields — they live inside components[].config
		// and the server rejects them at the top level with HTTP 400 (component-config-map).
		const sandboxTokens = [{ key: "GITHUB_TOKEN", enabled: true }];
		const configDirs = [{ path: ".bobbit/config", types: ["roles"] }];
		const out = buildProjectConfigDiff({
			sandbox_tokens: sandboxTokens,
			config_directories: configDirs,
		});
		assert.deepEqual(out.sandbox_tokens, sandboxTokens);
		assert.deepEqual(out.config_directories, configDirs);
	});

	it("drops the seven legacy top-level qa_* keys (server rejects them with 400)", () => {
		// component-config-map: qa_* settings have moved into components[].config.
		// The server rejects all seven legacy keys at the top level with HTTP 400
		// + a migration message. Filter them out client-side so an older agent
		// that still emits them doesn't make Apply Changes fail.
		const out = buildProjectConfigDiff({
			qa_start_command: "npm start",
			qa_build_command: "npm run build",
			qa_health_check: "http://localhost",
			qa_browser_entry: "http://localhost/?token=x",
			qa_env: { PORT: "3000" },
			qa_max_duration_minutes: 5,
			qa_max_scenarios: 10,
			build_command: "npm run build",
		});
		assert.deepEqual(out, { build_command: "npm run build" });
	});

	it("keeps a malformed JSON-string native field as the original string (server will 400)", () => {
		// Defensive: if the agent sends garbage in a structured field, we don't
		// silently turn it into `undefined`. The server's strict validator will
		// reject it with 400 and the user sees the error, rather than the field
		// being dropped.
		const out = buildProjectConfigDiff({ sandbox_tokens: "{not json" });
		assert.equal(out.sandbox_tokens, "{not json");
	});

	it("forwards legacy command fields (build/test/typecheck/...) untouched", () => {
		const out = buildProjectConfigDiff({
			build_command: "npm run build",
			test_command: "npm test",
			typecheck_command: "npm run check",
			worktree_setup_command: "npm ci",
			sandbox: "docker",
		});
		assert.equal(out.build_command, "npm run build");
		assert.equal(out.test_command, "npm test");
		assert.equal(out.typecheck_command, "npm run check");
		assert.equal(out.worktree_setup_command, "npm ci");
		assert.equal(out.sandbox, "docker");
	});

	it("regression: multi-component proposal preserves both components AND workflows together", () => {
		// The exact regression: provisional accept only forwarded a hardcoded
		// allow-list of legacy command keys. components / workflows were
		// silently dropped, so a multi-component project was registered with
		// zero workflows — the goal-proposal panel then had nothing to show
		// in the workflow dropdown.
		const components = [
			{ name: "server", repo: "server", commands: { build: "tsc" } },
			{ name: "ui", repo: "ui", commands: { build: "vite build" } },
		];
		const workflows = {
			"feature-server": { id: "feature-server", name: "Feature (server)", gates: [] },
			"feature-ui": { id: "feature-ui", name: "Feature (ui)", gates: [] },
			"all-components": { id: "all-components", name: "All components", gates: [] },
		};
		const out = buildProjectConfigDiff({
			name: "multi",
			root_path: "/tmp/multi",
			components,
			workflows,
		});
		assert.deepEqual(out.components, components);
		assert.deepEqual(out.workflows, workflows);
		assert.equal(Object.keys(out.workflows as Record<string, unknown>).length, 3,
			"all three proposed workflows must reach the server");
	});

	it("PROJECT_NATIVE_FIELDS includes components and workflows", () => {
		// Sanity: regression guard for the allow-list itself.
		assert.ok(PROJECT_NATIVE_FIELDS.has("components"));
		assert.ok(PROJECT_NATIVE_FIELDS.has("workflows"));
	});
});
