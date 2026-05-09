/**
 * Oracle — Step 1 prototype.
 *
 * Pure function: diff(script, observed) -> Verdict.
 *
 * Each invariant is its own check so a failure pinpoints the exact
 * violation instead of dumping a giant inequality. Verdict is a list of
 * Anomalies; an empty list means PASS.
 *
 * Invariants implemented in this prototype:
 *   #1  Multiset of (role) appended events == multiset of script-implied roles.
 *   #2  Final order of appended slots' roles == script logical order.
 *   #3  For each slot, observed text is monotone-growing (only append/grow,
 *       not shrink) — replacement to a non-prefix text is an anomaly.
 *   #4  No slot is `remove`d once it has appended.
 *   #6  t(first append for any assistant slot) - t(user_send) <= firstPaintBudgetMs.
 *   #7  t(final status=idle) - t(last script step) <= idleSettleBudgetMs (within
 *       harness-recorded total runtime, since we don't have absolute t0 alignment).
 *
 * Invariants #5 (tool-id multiset) and #8 (echo budget) are deferred to
 * Step 2 (we need stable tool ids) and don't fit the Step-1 minimal happy
 * path.
 */
import type { ObservedEvent } from "./dom-recorder.js";

export interface ScriptStepEmit {
	at?: string | number;
	on?: "user_prompt";
	emit?: any;
}
export interface Script {
	name: string;
	description?: string;
	firstPaintBudgetMs?: number;
	idleSettleBudgetMs?: number;
	steps: ScriptStepEmit[];
}

export type Anomaly =
	| { code: "multiset_mismatch"; expected: string[]; observed: string[]; detail: string }
	| { code: "order_mismatch"; expected: string[]; observed: string[] }
	| { code: "non_monotone_text"; slot: string; previous: string; next: string; tPrev: number; tNext: number }
	| { code: "slot_removed"; slot: string; role: string; t: number }
	| { code: "first_paint_too_slow"; observedMs: number; budgetMs: number }
	| { code: "idle_settle_too_slow"; observedMs: number; budgetMs: number }
	| { code: "no_assistant_paint"; detail: string }
	| { code: "no_idle_status"; detail: string };

export interface Verdict {
	pass: boolean;
	anomalies: Anomaly[];
	stats: {
		observedSlotCount: number;
		expectedSlotCount: number;
		firstPaintMs: number | null;
		idleSettleMs: number | null;
	};
}

/**
 * Derive the list of expected message roles, in order, from the script.
 *
 * The prototype only handles `message_end` frames carrying a top-level
 * role. The harness adds an implicit "user" role for the prompt that
 * triggered the script — the bridge echoes a user message_end before
 * processing further steps.
 */
function expectedRolesFromScript(script: Script): string[] {
	const roles: string[] = [];
	for (const step of script.steps) {
		// Each `on: user_prompt` corresponds to one user-bubble in the
		// transcript (the bridge echoes a user message_end on every prompt).
		if (step.on === "user_prompt") {
			roles.push("user");
			continue;
		}
		const e = step.emit;
		if (!e) continue;
		if (e.type === "message_end" && e.message && typeof e.message.role === "string") {
			// We only render user / assistant in the chat right now. tool roles
			// are tested in Step 2.
			if (e.message.role === "user" || e.message.role === "assistant") {
				roles.push(e.message.role);
			}
		}
	}
	return roles;
}

/** Multiset equality over string arrays — order-insensitive count compare. */
function multisetEqual(a: string[], b: string[]): { ok: true } | { ok: false; detail: string } {
	const ca = new Map<string, number>(), cb = new Map<string, number>();
	for (const x of a) ca.set(x, (ca.get(x) ?? 0) + 1);
	for (const x of b) cb.set(x, (cb.get(x) ?? 0) + 1);
	const keys = new Set([...ca.keys(), ...cb.keys()]);
	for (const k of keys) {
		if ((ca.get(k) ?? 0) !== (cb.get(k) ?? 0)) {
			return { ok: false, detail: `role=${k}: expected=${ca.get(k) ?? 0} observed=${cb.get(k) ?? 0}` };
		}
	}
	return { ok: true };
}

export function diff(script: Script, observed: ObservedEvent[]): Verdict {
	const anomalies: Anomaly[] = [];
	const appended = observed.filter((e): e is Extract<ObservedEvent, { kind: "append" }> => e.kind === "append");
	const updates = observed.filter((e): e is Extract<ObservedEvent, { kind: "update" }> => e.kind === "update");
	const removes = observed.filter((e): e is Extract<ObservedEvent, { kind: "remove" }> => e.kind === "remove");

	const expectedRoles = expectedRolesFromScript(script);
	// Append events arrive in chronological order; that's the order we want
	// for the role list (no need to sort by slot key, which is a string id).
	const observedRolesByOrder = appended.map((e) => e.role);

	// #1 multiset equality
	const ms = multisetEqual(expectedRoles, observedRolesByOrder);
	if (!ms.ok) {
		anomalies.push({
			code: "multiset_mismatch",
			expected: expectedRoles,
			observed: observedRolesByOrder,
			detail: ms.detail,
		});
	}

	// #2 order
	if (expectedRoles.length === observedRolesByOrder.length &&
	    !expectedRoles.every((r, i) => r === observedRolesByOrder[i])) {
		anomalies.push({
			code: "order_mismatch",
			expected: expectedRoles,
			observed: observedRolesByOrder,
		});
	}

	// #3 monotone text per slot
	const lastTextBySlot = new Map<string, { text: string; t: number }>();
	for (const e of observed) {
		if (e.kind === "append") {
			lastTextBySlot.set(e.slot, { text: e.text, t: e.t });
		} else if (e.kind === "update") {
			const prev = lastTextBySlot.get(e.slot);
			if (prev) {
				// Allow grow ('next' starts with 'prev') OR identical content.
				// Anything else is non-monotone.
				const grew = e.text.startsWith(prev.text) || e.text === prev.text;
				const trivialPunct = !grew && prev.text.replace(/[.!?]+\s*$/, "") === e.text.replace(/[.!?]+\s*$/, "");
				if (!grew && !trivialPunct) {
					anomalies.push({
						code: "non_monotone_text",
						slot: e.slot,
						previous: prev.text,
						next: e.text,
						tPrev: prev.t,
						tNext: e.t,
					});
				}
			}
			lastTextBySlot.set(e.slot, { text: e.text, t: e.t });
		}
	}

	// #4 no removal of finalised slots
	for (const r of removes) {
		anomalies.push({ code: "slot_removed", slot: r.slot, role: r.role, t: r.t });
	}

	// Stats / timing
	const userSend = observed.find((e) => e.kind === "user_send");
	const firstAssistantAppend = appended.find((e) => e.role === "assistant");
	const firstPaintMs = (userSend && firstAssistantAppend)
		? firstAssistantAppend.t - userSend.t
		: null;

	const finalIdle = observed.filter((e) => e.kind === "status" && e.status === "idle").slice(-1)[0];
	const lastScriptEvent = observed
		.filter((e) => e.kind !== "status" && e.kind !== "user_send")
		.slice(-1)[0];
	const idleSettleMs = (finalIdle && lastScriptEvent && finalIdle.t >= lastScriptEvent.t)
		? finalIdle.t - lastScriptEvent.t
		: null;

	// #6 first paint
	const fpBudget = script.firstPaintBudgetMs ?? 1500;
	if (firstPaintMs === null && userSend) {
		anomalies.push({ code: "no_assistant_paint",
			detail: `User send observed at t=${userSend.t}ms but no assistant append followed.` });
	} else if (firstPaintMs !== null && firstPaintMs > fpBudget) {
		anomalies.push({ code: "first_paint_too_slow", observedMs: firstPaintMs, budgetMs: fpBudget });
	}

	// #7 idle settle
	const isBudget = script.idleSettleBudgetMs ?? 1500;
	if (!finalIdle) {
		anomalies.push({ code: "no_idle_status",
			detail: "Status never reached 'idle' during the test window." });
	} else if (idleSettleMs !== null && idleSettleMs > isBudget) {
		anomalies.push({ code: "idle_settle_too_slow", observedMs: idleSettleMs, budgetMs: isBudget });
	}

	void updates; // referenced for completeness — counts surface via #3 monotonicity.

	return {
		pass: anomalies.length === 0,
		anomalies,
		stats: {
			observedSlotCount: appended.length,
			expectedSlotCount: expectedRoles.length,
			firstPaintMs,
			idleSettleMs,
		},
	};
}

/** Pretty-print a verdict for test failure messages. */
export function formatVerdict(v: Verdict): string {
	const lines: string[] = [];
	lines.push(`Verdict: ${v.pass ? "PASS" : "FAIL"}`);
	lines.push(`Stats: slots observed=${v.stats.observedSlotCount} / expected=${v.stats.expectedSlotCount}` +
		`  firstPaint=${v.stats.firstPaintMs ?? "?"}ms  idleSettle=${v.stats.idleSettleMs ?? "?"}ms`);
	if (v.anomalies.length === 0) {
		lines.push("(no anomalies)");
	} else {
		lines.push(`Anomalies (${v.anomalies.length}):`);
		for (const a of v.anomalies) {
			lines.push("  - " + JSON.stringify(a));
		}
	}
	return lines.join("\n");
}
