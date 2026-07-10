import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { initialState, reduce, type ReducerState } from "../../src/app/message-reducer.js";

function permissionCard(id: string, toolName: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		role: "tool_permission_needed",
		toolName,
		group: "Shell",
		roleName: "coder",
		roleLabel: "Coder",
		timestamp: 10,
		...extra,
	};
}

function apply(state: ReducerState, action: any): ReducerState {
	const next = reduce(state, action as never) as ReducerState | undefined;
	assert.ok(next, `permission reducer did not handle ${action.type}`);
	return next;
}

function permissionRows(state: ReducerState): any[] {
	return state.messages.filter((m: any) => m.role === "tool_permission_needed");
}

function isActionable(row: any): boolean {
	const status = row.status ?? "active";
	return row.actionable !== false && (status === "active" || status === "granting");
}

describe("permission request lifecycle reducer", () => {
	it("denying a permission keeps compact inline history instead of removing the row", () => {
		const active = apply(initialState(), {
			type: "permission-needed",
			card: permissionCard("perm-deny", "Bash"),
			seq: 1,
		});

		const denied = apply(active, {
			type: "deny-permission-filter",
			messageId: "perm-deny",
		});

		const rows = permissionRows(denied);
		if (rows.length === 0) assert.fail("permission row was removed");
		assert.equal(rows[0].status, "denied", "denied permission should be retained as compact history");
		assert.equal(isActionable(rows[0]), false, "denied permission history must not remain actionable");
	});

	it("reconciliation with no current pending permission settles active rows expired/stale", () => {
		const active = apply(initialState(), {
			type: "permission-needed",
			card: permissionCard("perm-timeout", "Bash"),
			seq: 1,
		});

		let settled: ReducerState;
		try {
			settled = apply(active, {
				type: "permission-reconciled",
				current: null,
				reason: "expired",
			});
		} catch {
			assert.fail("permission timeout did not settle active row");
		}

		const row = permissionRows(settled).find((m: any) => m.id === "perm-timeout");
		assert.ok(row, "expired permission should remain as inline history");
		assert.match(String(row.status), /expired|stale|cancelled/i, "permission timeout did not settle active row");
		assert.equal(isActionable(row), false, "expired/stale permission must not remain actionable or pinned");
	});

	it("a later permission request supersedes the earlier active request", () => {
		const withA = apply(initialState(), {
			type: "permission-needed",
			card: permissionCard("perm-a", "Bash"),
			seq: 1,
		});
		const withB = apply(withA, {
			type: "permission-needed",
			card: permissionCard("perm-b", "Edit"),
			seq: 2,
		});

		const rows = permissionRows(withB);
		const a = rows.find((m: any) => m.id === "perm-a");
		const b = rows.find((m: any) => m.id === "perm-b");
		assert.ok(a && b, "both permission rows should remain in transcript history");
		assert.match(String(a.status), /superseded|cancelled/i, "superseded permission was not marked stale history");
		assert.equal(isActionable(a), false, "superseded permission must not remain actionable");
		assert.equal(isActionable(b), true, "latest permission should be the only actionable row");
		assert.deepEqual(rows.filter(isActionable).map((m: any) => m.id), ["perm-b"], "only the latest permission request may be actionable");
	});
});
