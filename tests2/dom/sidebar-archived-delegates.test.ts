import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/sidebar-archived-delegates.spec.ts (v2-dom tier).
// The legacy file:// fixture inlined the merge/BFS/tree-expansion helpers that
// mirror logic living inline in src/app/api.ts (refreshSessions) and
// src/app/render-helpers.ts (renderSessionRow / tree rendering). Those decisions
// are not exported as standalone symbols, so this port replicates the identical
// helpers and asserts the same behaviours. No DOM — bridge for uniformity.
import { describe, expect, it } from "vitest";

interface SessionLike {
	id: string;
	delegateOf?: string;
	status?: string;
}

/** Mirrors the archived-delegate dedup merge from src/app/api.ts refreshSessions(). */
function mergeArchivedDelegates(archivedSessions: SessionLike[], archivedDelegates: SessionLike[]): SessionLike[] {
	const existingIds = new Set(archivedSessions.map((s) => s.id));
	const result = [...archivedSessions];
	for (const d of archivedDelegates) {
		if (!existingIds.has(d.id)) {
			result.push(d);
			existingIds.add(d.id);
		}
	}
	return result;
}

/** Mirrors the chevron/hasChildren check from renderSessionRow. */
function computeHasChildren(
	sessionId: string,
	liveSessions: SessionLike[],
	archivedSessions: SessionLike[],
	showArchived: boolean,
): boolean {
	const liveDelegates = liveSessions.filter(
		(s) => s.delegateOf === sessionId && (showArchived || s.status !== "terminated"),
	);
	const archivedDelegates = showArchived ? archivedSessions.filter((s) => s.delegateOf === sessionId) : [];
	return liveDelegates.length > 0 || archivedDelegates.length > 0;
}

/** Mirrors the server BFS that finds archived delegates of live sessions (nested). */
function serverBFS(liveSessions: SessionLike[], allArchived: SessionLike[]): SessionLike[] {
	const liveIds = new Set(liveSessions.map((s) => s.id));
	const result: SessionLike[] = [];
	const seen = new Set<string>();
	const queue: string[] = [...liveIds];
	while (queue.length > 0) {
		const parentId = queue.shift()!;
		for (const s of allArchived) {
			if (s.delegateOf === parentId && !seen.has(s.id)) {
				seen.add(s.id);
				result.push(s);
				queue.push(s.id);
			}
		}
	}
	return result;
}

interface TreeGroup {
	childClass: string;
	expanded: boolean;
	children: string[];
}

/** Mirrors the render-helpers decision for tree-backed session-row child groups. */
function renderTreeSessionGroupModel(
	groups: TreeGroup[],
	options: { showArchivedGroupHeader?: boolean } = {},
): unknown[] {
	const hasFirstClass = groups.some((g) => g.childClass === "first-class" && g.children.length > 0);
	const hasArchived = groups.some((g) => g.childClass === "archived-delegate" && g.children.length > 0);
	const firstClassExpanded = groups.some((g) => g.childClass === "first-class" && g.expanded);
	const archivedExpanded = groups.some((g) => g.childClass === "archived-delegate" && g.expanded);
	const rowExpanded = hasFirstClass ? firstClassExpanded : archivedExpanded;
	const renderChildArea = rowExpanded || (hasFirstClass && hasArchived);
	const showArchivedHeader = options.showArchivedGroupHeader ?? (hasFirstClass && hasArchived);
	if (!renderChildArea) return [];
	const rows: unknown[] = [];
	for (const group of groups) {
		if (group.childClass === "archived-delegate" && group.children.length > 0 && showArchivedHeader) {
			rows.push({ kind: "toggle", childClass: "archived-delegate", expanded: !!group.expanded, toggleTarget: "archived-delegate" });
			if (group.expanded) rows.push(...group.children.map((id) => ({ kind: "child", childClass: "archived-delegate", id })));
			continue;
		}
		if (group.expanded) rows.push(...group.children.map((id) => ({ kind: "child", childClass: group.childClass, id })));
	}
	return rows;
}

/** Mirrors renderTreeTeamLeadNode archived-delegate expansion. */
function renderTeamLeadArchivedDelegateModel(
	teamLeadExpanded: boolean,
	archivedGroupExpanded: boolean,
	childIds: string[],
): unknown[] {
	if (!teamLeadExpanded || childIds.length === 0) return [];
	const rows: unknown[] = [{ kind: "toggle", childClass: "archived-delegate", expanded: archivedGroupExpanded, toggleTarget: "archived-delegate" }];
	if (archivedGroupExpanded) rows.push(...childIds.map((id) => ({ kind: "child", childClass: "archived-delegate", id })));
	return rows;
}

describe("SB-00b: Archived delegates inline in session response", () => {
	describe("client merge logic", () => {
		it("merges archived delegates into empty list", () => {
			const result = mergeArchivedDelegates([], [
				{ id: "d1", delegateOf: "parent-1" },
				{ id: "d2", delegateOf: "parent-1" },
			]);
			expect(result).toHaveLength(2);
			expect(result.map((s) => s.id)).toEqual(["d1", "d2"]);
		});

		it("deduplicates against existing archived sessions", () => {
			const result = mergeArchivedDelegates(
				[{ id: "d1", delegateOf: "parent-1" }],
				[
					{ id: "d1", delegateOf: "parent-1" },
					{ id: "d2", delegateOf: "parent-1" },
				],
			);
			expect(result).toHaveLength(2);
			expect(result.map((s) => s.id)).toEqual(["d1", "d2"]);
		});

		it("handles empty archivedDelegates from server", () => {
			const result = mergeArchivedDelegates([{ id: "existing-1" }], []);
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("existing-1");
		});

		it("deduplicates across repeated merges", () => {
			const after1 = mergeArchivedDelegates([], [
				{ id: "d1", delegateOf: "p1" },
				{ id: "d2", delegateOf: "p1" },
			]);
			const after2 = mergeArchivedDelegates(after1, [
				{ id: "d1", delegateOf: "p1" },
				{ id: "d2", delegateOf: "p1" },
				{ id: "d3", delegateOf: "p1" },
			]);
			expect(after2).toHaveLength(3);
			expect(after2.map((s) => s.id)).toEqual(["d1", "d2", "d3"]);
		});
	});

	describe("chevron (hasChildren) logic", () => {
		it("shows chevron when archived delegates exist and showArchived is on", () => {
			expect(computeHasChildren(
				"parent-1",
				[{ id: "parent-1", status: "idle" }],
				[{ id: "d1", delegateOf: "parent-1" }],
				true,
			)).toBe(true);
		});

		it("hides chevron when archived delegates exist but showArchived is off", () => {
			expect(computeHasChildren(
				"parent-1",
				[{ id: "parent-1", status: "idle" }],
				[{ id: "d1", delegateOf: "parent-1" }],
				false,
			)).toBe(false);
		});

		it("shows chevron when live delegates exist regardless of showArchived", () => {
			expect(computeHasChildren(
				"parent-1",
				[
					{ id: "parent-1", status: "idle" },
					{ id: "d1", delegateOf: "parent-1", status: "streaming" },
				],
				[],
				false,
			)).toBe(true);
		});

		it("no chevron when no delegates at all", () => {
			expect(computeHasChildren(
				"parent-1",
				[{ id: "parent-1", status: "idle" }],
				[],
				true,
			)).toBe(false);
		});
	});

	describe("tree expansion rendering", () => {
		it("keeps mixed first-class and archived-delegate groups independently expandable", () => {
			const collapsed = renderTreeSessionGroupModel([
				{ childClass: "first-class", expanded: false, children: ["first"] },
				{ childClass: "archived-delegate", expanded: false, children: ["archived"] },
			]);
			expect(collapsed).toEqual([
				{ kind: "toggle", childClass: "archived-delegate", expanded: false, toggleTarget: "archived-delegate" },
			]);

			const archivedExpanded = renderTreeSessionGroupModel([
				{ childClass: "first-class", expanded: false, children: ["first"] },
				{ childClass: "archived-delegate", expanded: true, children: ["archived"] },
			]);
			expect(archivedExpanded).toEqual([
				{ kind: "toggle", childClass: "archived-delegate", expanded: true, toggleTarget: "archived-delegate" },
				{ kind: "child", childClass: "archived-delegate", id: "archived" },
			]);
		});

		it("team-lead expansion exposes archived-delegate expander before archived delegates render", () => {
			const collapsed = renderTeamLeadArchivedDelegateModel(true, false, ["archived-delegate"]);
			expect(collapsed).toEqual([
				{ kind: "toggle", childClass: "archived-delegate", expanded: false, toggleTarget: "archived-delegate" },
			]);

			const expanded = renderTeamLeadArchivedDelegateModel(true, true, ["archived-delegate"]);
			expect(expanded).toEqual([
				{ kind: "toggle", childClass: "archived-delegate", expanded: true, toggleTarget: "archived-delegate" },
				{ kind: "child", childClass: "archived-delegate", id: "archived-delegate" },
			]);

			const teamLeadCollapsed = renderTeamLeadArchivedDelegateModel(false, true, ["archived-delegate"]);
			expect(teamLeadCollapsed).toEqual([]);
		});
	});

	describe("server BFS logic", () => {
		it("finds direct archived delegates of live sessions", () => {
			const result = serverBFS(
				[{ id: "live-1" }],
				[
					{ id: "d1", delegateOf: "live-1" },
					{ id: "d2", delegateOf: "other" },
				],
			);
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("d1");
		});

		it("finds nested archived delegates (delegate of delegate)", () => {
			const result = serverBFS(
				[{ id: "live-1" }],
				[
					{ id: "d1", delegateOf: "live-1" },
					{ id: "d2", delegateOf: "d1" },
					{ id: "d3", delegateOf: "d2" },
				],
			);
			expect(result).toHaveLength(3);
			expect(result.map((s) => s.id)).toEqual(["d1", "d2", "d3"]);
		});

		it("returns empty when no archived sessions are delegates of live", () => {
			const result = serverBFS(
				[{ id: "live-1" }],
				[{ id: "d1", delegateOf: "unrelated" }],
			);
			expect(result).toHaveLength(0);
		});

		it("handles multiple live parents", () => {
			const result = serverBFS(
				[{ id: "live-1" }, { id: "live-2" }],
				[
					{ id: "d1", delegateOf: "live-1" },
					{ id: "d2", delegateOf: "live-2" },
					{ id: "d3", delegateOf: "other" },
				],
			);
			expect(result).toHaveLength(2);
			expect(result.map((s) => s.id).sort()).toEqual(["d1", "d2"]);
		});
	});
});
