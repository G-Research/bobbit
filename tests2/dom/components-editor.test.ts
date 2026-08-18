import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/components-editor.spec.ts (v2-dom tier).
// The legacy spec exercised pure helpers via an esbuild file:// bundle. This port
// imports the REAL helpers directly from src/app/components-editor.ts.
import { describe, expect, it } from "vitest";
import { componentToEditState, editStateToComponent, buildSavePayload, validateCommandEnvironmentEntries } from "../../src/app/components-editor.js";

describe("components-editor helpers", () => {
	it("componentToEditState turns a normal component into editable rows", () => {
		const result = componentToEditState({
			name: "api",
			repo: "api",
			relativePath: "packages/api",
			worktreeSetupCommand: "npm ci",
			commands: { build: "npm run build", test: "npm test" },
		});
		expect(result.name).toBe("api");
		expect(result.repo).toBe("api");
		expect(result.relative_path).toBe("packages/api");
		expect(result.worktree_setup_command).toBe("npm ci");
		expect(result.commands).toEqual([
			{ key: "build", value: "npm run build" },
			{ key: "test", value: "npm test" },
		]);
	});

	it("componentToEditState gives a no-commands component an empty commands list", () => {
		const result = componentToEditState({ name: "fixtures", repo: "fixtures" });
		expect(result.commands).toEqual([]);
	});

	it("editStateToComponent strips empty rows", () => {
		const result = editStateToComponent({
			name: "web",
			repo: "web",
			relative_path: "",
			worktree_setup_command: "",
			commands: [
				{ key: "build", value: "npm run build" },
				{ key: "", value: "ignored" },
				{ key: "test", value: "  " },
			],
			env: [],
			config: [],
		});
		expect(result).toEqual({ name: "web", repo: "web", commands: { build: "npm run build" } });
	});

	it("editStateToComponent omits commands when the list is empty (data-only)", () => {
		const result = editStateToComponent({ name: "shared", repo: "shared", commands: [], env: [], config: [] });
		expect(result).toEqual({ name: "shared", repo: "shared" });
		expect(result.commands).toBeUndefined();
	});

	it("editStateToComponent defaults missing repo to '.'", () => {
		const result = editStateToComponent({ name: "main", repo: "", commands: [], env: [], config: [] });
		expect(result.repo).toBe(".");
	});

	it("buildSavePayload composes the structured PUT body (components only)", () => {
		const result = buildSavePayload(
			[
				{ name: "main", repo: ".", commands: [{ key: "build", value: "npm run build" }], env: [], config: [] },
				{ name: "fixtures", repo: "fixtures", commands: [], env: [], config: [] },
			],
			{ general: { name: "General", gates: [] } } as any,
		);
		expect(result.components).toHaveLength(2);
		expect((result.components as any[])[0]).toEqual({ name: "main", repo: ".", commands: { build: "npm run build" } });
		expect((result.components as any[])[1]).toEqual({ name: "fixtures", repo: "fixtures" });
		expect(result.workflows).toBeUndefined();
		expect(result.worktree_root).toBeUndefined();
	});

	it("componentToEditState surfaces config as editable rows", () => {
		const result = componentToEditState({
			name: "web",
			repo: ".",
			config: { qa_start_command: "PORT=$PORT npm start", qa_max_duration_minutes: "10" },
		});
		expect(result.config).toEqual([
			{ key: "qa_start_command", value: "PORT=$PORT npm start" },
			{ key: "qa_max_duration_minutes", value: "10" },
		]);
	});

	it("editStateToComponent serializes config and strips empty keys", () => {
		const result = editStateToComponent({
			name: "web",
			repo: ".",
			commands: [],
			env: [],
			config: [
				{ key: "qa_start_command", value: "PORT=$PORT npm start" },
				{ key: "", value: "ignored" },
				{ key: "qa_max_scenarios", value: "5" },
			],
		});
		expect(result).toEqual({
			name: "web",
			repo: ".",
			config: { qa_start_command: "PORT=$PORT npm start", qa_max_scenarios: "5" },
		});
	});

	it("editStateToComponent omits config when the list is empty", () => {
		const result = editStateToComponent({ name: "web", repo: ".", commands: [], env: [], config: [] });
		expect(result.config).toBeUndefined();
	});

	it("round-trip: clearing commands turns a component data-only", () => {
		const initial = { name: "x", repo: "x", commands: { build: "npm run build" } };
		const edit = componentToEditState(initial);
		const out1 = editStateToComponent({ ...edit, commands: [] });
		const out2 = editStateToComponent(edit);
		expect(out1).toEqual({ name: "x", repo: "x" });
		expect(out2).toEqual({ name: "x", repo: "x", commands: { build: "npm run build" } });
	});

	it("round-trips command environment rows and preserves explicitly blank literal values", () => {
		const edit = componentToEditState({
			name: "api",
			repo: ".",
			commands: { test: "npm test" },
			env: { CI: "1", EMPTY: "" },
		});
		expect(edit.env).toEqual([{ key: "CI", value: "1" }, { key: "EMPTY", value: "" }]);
		expect(editStateToComponent(edit)).toEqual({
			name: "api", repo: ".", commands: { test: "npm test" }, env: { CI: "1", EMPTY: "" },
		});
	});

	it("keeps invalid environment rows visible with field-level key errors", () => {
		const errors = validateCommandEnvironmentEntries([
			{ key: "NOT-VALID", value: "x" },
			{ key: "Path", value: "one" },
			{ key: "PATH", value: "two" },
			{ key: "", value: "" },
		]);
		expect(errors.get(0)?.key).toMatch(/letters, numbers, and underscores/i);
		expect(errors.get(1)?.key).toMatch(/unique ignoring case/i);
		expect(errors.get(2)?.key).toMatch(/unique ignoring case/i);
		expect(errors.get(3)?.key).toBe("Variable name is required.");
	});
});
