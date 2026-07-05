import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/sidebar-collapse.spec.ts (v2-dom tier).
// FIDELITY NOTE: the legacy file:// fixture drove an INLINED copy of the
// per-project collapse-state logic (matching the fixed state.ts implementation).
// The real logic in state.ts is bound to module-level Sets + localStorage that
// the spec's "clear localStorage + reload" beforeEach re-initializes; under
// vitest's shared module cache (isolate:false) that reload cannot be replayed
// without the forbidden vi.resetModules(). This port keeps a byte-identical
// replica behind a factory that reads localStorage at construction, and creates
// a fresh instance per test after clearing localStorage — preserving the exact
// per-project semantics and every assertion.
import { beforeEach, describe, expect, it } from "vitest";

const COLLAPSED_UNGROUPED_KEY = "bobbit-collapsed-ungrouped";
const COLLAPSED_STAFF_KEY = "bobbit-collapsed-staff";

function createCollapseState() {
	const collapsedUngroupedProjects = new Set<string>(
		JSON.parse(localStorage.getItem(COLLAPSED_UNGROUPED_KEY) || "[]"),
	);
	const collapsedStaffProjects = new Set<string>(
		JSON.parse(localStorage.getItem(COLLAPSED_STAFF_KEY) || "[]"),
	);

	return {
		isUngroupedExpandedForProject(projectId: string): boolean {
			return !collapsedUngroupedProjects.has(projectId);
		},
		setUngroupedExpandedForProject(projectId: string, value: boolean): void {
			if (value) collapsedUngroupedProjects.delete(projectId);
			else collapsedUngroupedProjects.add(projectId);
			localStorage.setItem(COLLAPSED_UNGROUPED_KEY, JSON.stringify([...collapsedUngroupedProjects]));
		},
		isStaffExpandedForProject(projectId: string): boolean {
			return !collapsedStaffProjects.has(projectId);
		},
		setStaffExpandedForProject(projectId: string, value: boolean): void {
			if (value) collapsedStaffProjects.delete(projectId);
			else collapsedStaffProjects.add(projectId);
			localStorage.setItem(COLLAPSED_STAFF_KEY, JSON.stringify([...collapsedStaffProjects]));
		},
	};
}

describe("Bug 4: Sidebar collapse state per-project", () => {
	let s: ReturnType<typeof createCollapseState>;

	beforeEach(() => {
		localStorage.clear();
		s = createCollapseState();
	});

	it("collapsing ungrouped section for project-A does not affect project-B", () => {
		const aExpandedBefore = s.isUngroupedExpandedForProject("project-A");
		const bExpandedBefore = s.isUngroupedExpandedForProject("project-B");

		s.setUngroupedExpandedForProject("project-A", false);

		const aExpandedAfter = s.isUngroupedExpandedForProject("project-A");
		const bExpandedAfter = s.isUngroupedExpandedForProject("project-B");

		expect(aExpandedBefore).toBe(true);
		expect(bExpandedBefore).toBe(true);
		expect(aExpandedAfter).toBe(false);
		expect(bExpandedAfter).toBe(true);
	});

	it("collapsing staff section for project-A does not affect project-B", () => {
		s.setStaffExpandedForProject("project-A", false);
		expect(s.isStaffExpandedForProject("project-A")).toBe(false);
		expect(s.isStaffExpandedForProject("project-B")).toBe(true);
	});

	it("each project maintains independent collapse state", () => {
		s.setUngroupedExpandedForProject("project-A", false);
		s.setUngroupedExpandedForProject("project-B", true);
		s.setStaffExpandedForProject("project-B", false);

		expect(s.isUngroupedExpandedForProject("project-A")).toBe(false);
		expect(s.isUngroupedExpandedForProject("project-B")).toBe(true);
		expect(s.isStaffExpandedForProject("project-A")).toBe(true);
		expect(s.isStaffExpandedForProject("project-B")).toBe(false);
	});
});
