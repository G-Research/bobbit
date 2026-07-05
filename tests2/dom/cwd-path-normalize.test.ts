import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/cwd-path-normalize.spec.ts (v2-dom tier).
// The legacy fixture copied getRecentCwds() verbatim. This port drives the REAL
// getRecentCwds() + cwdCombobox() from src/app/cwd-combobox.ts against the real
// `state` singleton (restored in afterEach). The default-cwd placeholder
// normalization is asserted via the rendered combobox input's placeholder attribute.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "lit";
import { getRecentCwds, cwdCombobox } from "../../src/app/cwd-combobox.js";
import { state } from "../../src/app/state.js";

let saved: { sessions: unknown; goals: unknown; defaultCwd: string };

beforeEach(() => {
	saved = { sessions: state.gatewaySessions, goals: state.goals, defaultCwd: state.defaultCwd };
	state.gatewaySessions = [
		{ cwd: "C:\\Users\\foo\\project", assistantType: "chat", delegateOf: null, teamGoalId: null, staffId: null, lastActivity: 1000 },
		{ cwd: "C:/Users/foo/project", assistantType: "chat", delegateOf: null, teamGoalId: null, staffId: null, lastActivity: 900 },
		{ cwd: "C:\\Users\\baz\\other", assistantType: "chat", delegateOf: null, teamGoalId: null, staffId: null, lastActivity: 800 },
	] as any;
	state.goals = [
		{ repoPath: null, cwd: "C:\\Users\\bar\\work", updatedAt: 500 },
		{ repoPath: "C:/Users/bar/work", cwd: null, updatedAt: 400 },
	] as any;
	state.defaultCwd = "C:\\Users\\foo";
});

afterEach(() => {
	state.gatewaySessions = saved.sessions as typeof state.gatewaySessions;
	state.goals = saved.goals as typeof state.goals;
	state.defaultCwd = saved.defaultCwd;
	document.body.innerHTML = "";
});

describe("CWD combobox path normalization", () => {
	it("no duplicates when same path appears in both slash formats (sessions)", () => {
		const cwds = getRecentCwds();
		const fooPaths = cwds.filter((c) => c.path.replace(/\\/g, "/") === "C:/Users/foo/project");
		expect(fooPaths).toHaveLength(1);
	});

	it("no duplicates when same path appears in both slash formats (goals)", () => {
		const cwds = getRecentCwds();
		const barPaths = cwds.filter((c) => c.path.replace(/\\/g, "/") === "C:/Users/bar/work");
		expect(barPaths).toHaveLength(1);
	});

	it("all returned paths use forward slashes only", () => {
		for (const entry of getRecentCwds()) expect(entry.path).not.toContain("\\");
	});

	it("defaultCwd placeholder is normalized to forward slashes", () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		render(
			cwdCombobox({ value: "", onInput: () => {}, onSelect: () => {}, dropdownOpen: false, onToggle: () => {} }),
			container,
		);
		const input = container.querySelector("input")!;
		const placeholder = input.getAttribute("placeholder") || "";
		expect(placeholder).not.toContain("\\");
		expect(placeholder).toBe("C:/Users/foo");
	});
});
