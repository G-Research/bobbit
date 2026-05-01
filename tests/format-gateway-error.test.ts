/**
 * Unit tests for `formatGatewayError` (dialog-helpers.ts).
 *
 * Pinned regression: the goal-creation toast used to be the bare
 * `Failed to create goal: 400`, hiding the actionable detail in the
 * server's response body. After commit `058c17ea` the helper unwraps
 * `{ error: "Workflow not found: general" }` into a user-friendly
 * message.
 *
 * The helper takes a parsed body (or `undefined` on parse failure) and
 * the HTTP status. Pure: no fetch, no DOM. Used from
 * `src/app/api.ts::createGoal` after `await res.json()` (in a try/catch
 * for non-JSON responses).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatGatewayError } from "../src/app/dialog-helpers.ts";

describe("formatGatewayError", () => {
	describe("undefined / null body (non-JSON or unreadable response)", () => {
		it("returns bare prefix:status when body is undefined", () => {
			assert.equal(
				formatGatewayError("Failed to create goal", 400, undefined),
				"Failed to create goal: 400",
			);
		});

		it("returns bare prefix:status when body is null", () => {
			assert.equal(
				formatGatewayError("Failed to create goal", 500, null),
				"Failed to create goal: 500",
			);
		});
	});

	describe("body with error string (the headline regression case)", () => {
		it("appends the server's error message when body has { error: string }", () => {
			// This is the case that was hidden by the original bare formatter.
			assert.equal(
				formatGatewayError("Failed to create goal", 400, {
					error: "Workflow not found: general",
				}),
				"Failed to create goal: 400 — Workflow not found: general",
			);
		});

		it("works for any prefix and status combination", () => {
			assert.equal(
				formatGatewayError("Failed to update project", 409, {
					error: "Project is locked",
				}),
				"Failed to update project: 409 — Project is locked",
			);
		});

		it("treats an empty-string error as missing — falls back to bare prefix:status", () => {
			// Defence in depth: a server bug that returns `{ error: "" }`
			// shouldn't yield `"Failed to create goal: 400 — "` with a
			// trailing em-dash.
			assert.equal(
				formatGatewayError("Failed to create goal", 400, { error: "" }),
				"Failed to create goal: 400",
			);
		});
	});

	describe("body without error field — fall back to JSON.stringify", () => {
		it("stringifies an object body that lacks an `error` field", () => {
			// This branch covers shape-validation responses like
			// { field: "inlineWorkflow", error: "..." } (which DOES have
			// `error`, hits the previous branch) and other ad-hoc shapes.
			assert.equal(
				formatGatewayError("Failed to create goal", 400, {
					field: "inlineWorkflow",
					reason: "missing gates",
				}),
				`Failed to create goal: 400 — {"field":"inlineWorkflow","reason":"missing gates"}`,
			);
		});

		it("returns bare prefix:status when body is an empty object {}", () => {
			// `{}` carries no useful info — don't append a useless `— {}` tail.
			assert.equal(
				formatGatewayError("Failed to create goal", 400, {}),
				"Failed to create goal: 400",
			);
		});

		it("uses the error field when both error and other fields are present", () => {
			assert.equal(
				formatGatewayError("Failed to create goal", 400, {
					field: "inlineWorkflow",
					error: "must be an object",
				}),
				"Failed to create goal: 400 — must be an object",
			);
		});
	});

	describe("non-object bodies", () => {
		it("returns bare prefix:status for a string body", () => {
			// String bodies are unusual but possible from misconfigured servers.
			// We don't try to embed them inline (could be huge HTML pages).
			assert.equal(
				formatGatewayError("Failed to create goal", 502, "Bad Gateway"),
				"Failed to create goal: 502",
			);
		});

		it("returns bare prefix:status for a number body", () => {
			assert.equal(
				formatGatewayError("Failed to create goal", 400, 42),
				"Failed to create goal: 400",
			);
		});
	});

	describe("circular-reference safety", () => {
		it("falls back to bare prefix:status when JSON.stringify throws", () => {
			// Defensive — JSON.stringify on a circular structure throws;
			// the helper must not propagate that to the user.
			const circular: Record<string, unknown> = {};
			circular.self = circular;
			assert.equal(
				formatGatewayError("Failed to create goal", 400, circular),
				"Failed to create goal: 400",
			);
		});
	});
});
