/**
 * Unit tests for VerificationHarness QA-step component resolution.
 *
 * After the component-config migration, `qa_max_duration_minutes` lives on
 * `components[<name>].config` instead of at the project top level. The
 * harness must:
 *
 *   1. Read `qa_max_duration_minutes` from the step's declared `component:`
 *      via `pcs.getQaMaxDurationMinutes(componentName)`.
 *   2. When no `component:` is declared on the step, fall back via the
 *      private `resolveDefaultQaComponentName(goalId)` helper — first the
 *      component carrying `config.qa_start_command`, else a project-name
 *      match, else `components[0]`.
 *   3. Default to 10 when the chosen component has no
 *      `qa_max_duration_minutes` (or is missing entirely).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "verif-qa-test-"));
fs.mkdirSync(path.join(TEST_DIR, "state"), { recursive: true });

const { VerificationHarness } = await import("../src/server/agent/verification-harness.js");

type Component = {
	name: string;
	repo: string;
	config?: Record<string, string>;
};

/**
 * Minimal in-memory ProjectConfigStore shim implementing only the surface the
 * QA path consults (`getComponents`, `getQaMaxDurationMinutes`).
 */
function makeConfigStore(components: Component[]) {
	return {
		getComponents: () => components,
		getQaMaxDurationMinutes(componentName: string): number {
			const c = components.find(x => x.name === componentName);
			const raw = c?.config?.qa_max_duration_minutes;
			const n = raw == null ? NaN : Number(raw);
			return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 10;
		},
	};
}

function makeContextManager(goalId: string, projectName: string, components: Component[]) {
	const projectConfigStore = makeConfigStore(components);
	return {
		_projectConfigStore: projectConfigStore,
		getContextForGoal: (id: string) => id === goalId ? {
			project: { id: "proj-1", name: projectName },
			goalStore: { get: (gid: string) => (gid === goalId ? { id: goalId } : undefined) },
			gateStore: { getGate: () => ({ signals: [] }) },
			projectConfigStore,
		} : null,
	};
}

function makeHarness(pcm: ReturnType<typeof makeContextManager>) {
	return new VerificationHarness(
		path.join(TEST_DIR, "state"),
		undefined,
		() => {},
		{ get: () => null, getAll: () => [] } as any,
		undefined,
		undefined,
		undefined,
		undefined,
		pcm as any,
	);
}

test("resolveDefaultQaComponentName prefers the component that carries config.qa_start_command", () => {
	const components: Component[] = [
		{ name: "data", repo: ".", config: {} },
		{ name: "web", repo: ".", config: { qa_start_command: "PORT=$PORT npm start" } },
		{ name: "worker", repo: "." },
	];
	const pcm = makeContextManager("goal-1", "myproject", components);
	const harness = makeHarness(pcm);
	const name = (harness as any).resolveDefaultQaComponentName("goal-1");
	assert.equal(name, "web");
});

test("resolveDefaultQaComponentName falls back to project-name match when no component has qa_start_command", () => {
	const components: Component[] = [
		{ name: "data", repo: "." },
		{ name: "myproject", repo: "." },
		{ name: "tools", repo: "." },
	];
	const pcm = makeContextManager("goal-1", "myproject", components);
	const harness = makeHarness(pcm);
	const name = (harness as any).resolveDefaultQaComponentName("goal-1");
	assert.equal(name, "myproject");
});

test("resolveDefaultQaComponentName falls back to components[0] when no qa_start_command and no name match", () => {
	const components: Component[] = [
		{ name: "alpha", repo: "." },
		{ name: "beta", repo: "." },
	];
	const pcm = makeContextManager("goal-1", "unrelated", components);
	const harness = makeHarness(pcm);
	const name = (harness as any).resolveDefaultQaComponentName("goal-1");
	assert.equal(name, "alpha");
});

test("resolveDefaultQaComponentName returns undefined when there are no components", () => {
	const pcm = makeContextManager("goal-1", "myproject", []);
	const harness = makeHarness(pcm);
	const name = (harness as any).resolveDefaultQaComponentName("goal-1");
	assert.equal(name, undefined);
});

test("getQaMaxDurationMinutes(componentName) reads the declared component's config", () => {
	const components: Component[] = [
		{ name: "web", repo: ".", config: { qa_start_command: "x", qa_max_duration_minutes: "20" } },
		{ name: "worker", repo: ".", config: { qa_start_command: "y", qa_max_duration_minutes: "5" } },
	];
	const pcm = makeContextManager("goal-1", "myproject", components);
	const store = pcm._projectConfigStore;
	assert.equal(store.getQaMaxDurationMinutes("web"), 20);
	assert.equal(store.getQaMaxDurationMinutes("worker"), 5);
	// Missing components fall back to the default.
	assert.equal(store.getQaMaxDurationMinutes("ghost"), 10);
	// Missing key falls back to the default.
	const componentsNoKey: Component[] = [{ name: "web", repo: ".", config: { qa_start_command: "x" } }];
	const pcm2 = makeContextManager("goal-1", "p", componentsNoKey);
	assert.equal(pcm2._projectConfigStore.getQaMaxDurationMinutes("web"), 10);
});
