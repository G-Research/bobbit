/**
 * E2E for the generic tool-error retry harness.
 *
 * The mock agent's `ask_user_choices_bad_then_ok` trigger emits an
 * `ask_user_choices` `tool_use` with TWO questions and NO `tab_label` on
 * turn 1. The mock's tool_execution_end carries the structured
 * `ok({ error: "ask_user_choices: questions[0]..." })` body that the
 * generic tool-retry harness classifies as `"schema"` and reacts to with
 * a nudge prompt via `rpcClient.prompt`. The mock's `_handleAskBadThenOk`
 * sees the nudge as a fresh user turn, consults its `_askRetryFollowUp`
 * flag, and emits a CORRECTED multi-question call with `tab_label`s set.
 *
 * Asserts:
 *  - `toolAutoRetries.count >= 1` is persisted to `PersistedSession` and
 *    surfaced through `GET /api/sessions/:id`.
 *  - The transcript contains a SECOND `tool_use` for `ask_user_choices`
 *    whose `tool_execution_end` is non-erroring.
 *
 * See `docs/design/tool-retry-harness.md` for the full design.
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	connectWs,
	createSession,
	deleteSession,
	messageEndPredicate,
	toolStartPredicate,
	waitForCondition,
} from "./e2e-setup.js";

test.describe("tool-retry-harness end-to-end via mock agent", () => {
	test("schema-class ask_user_choices error triggers a server-side retry", async () => {
		const sessionId = await createSession();
		try {
			const conn = await connectWs(sessionId);
			try {
				// Drive the bad-then-ok flow via the dedicated mock trigger.
				conn.send({ type: "prompt", text: "please use ask_user_choices_bad_then_ok" });

				// Turn 1: errored tool_result.
				const erroredStart = await conn.waitFor(
					toolStartPredicate("ask_user_choices"),
					15_000,
				);
				expect(erroredStart).toBeTruthy();
				const erroredResult = await conn.waitFor(
					(m) =>
						messageEndPredicate("toolResult")(m) &&
						m.data?.message?.toolName === "ask_user_choices" &&
						(m.data?.message?.content?.[0]?.text || "").includes("tab_label"),
					15_000,
				);
				expect(erroredResult).toBeTruthy();

				// Turn 2: harness nudges, mock emits a corrected ask. We wait
				// for a second tool_execution_start whose paired tool_result
				// does NOT carry an error body.
				const startCursor = conn.messageCount();
				const correctedResult = await conn.waitForFrom(
					startCursor,
					(m) => {
						if (!messageEndPredicate("toolResult")(m)) return false;
						if (m.data?.message?.toolName !== "ask_user_choices") return false;
						const text = m.data?.message?.content?.[0]?.text || "";
						return text.includes('"status":"posted"') && !text.includes("tab_label");
					},
					30_000,
				);
				expect(correctedResult).toBeTruthy();

				// `toolAutoRetries.count >= 1` is persisted and surfaced.
				await waitForCondition(async () => {
					const r = await apiFetch(`/api/sessions/${sessionId}`);
					if (!r.ok) return false;
					const body: any = await r.json();
					return Number(body?.toolAutoRetries?.count ?? 0) >= 1;
				}, 5_000);
				const r = await apiFetch(`/api/sessions/${sessionId}`);
				const body: any = await r.json();
				expect(body.toolAutoRetries).toBeTruthy();
				expect(body.toolAutoRetries.count).toBeGreaterThanOrEqual(1);
				expect(typeof body.toolAutoRetries.lastReason).toBe("string");
			} finally {
				conn.close();
			}
		} finally {
			await deleteSession(sessionId);
		}
	});
});
