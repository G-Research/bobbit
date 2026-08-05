import { describe, expect, it } from "vitest";
import {
	DECISION_DEADLINE_MAX_MS,
	DECISION_DEADLINE_MIN_MS,
	validateDecisionHookOutput,
	validateDecisionValue,
} from "../../src/server/agent/decision-hook-contract.ts";

const now = Date.parse("2026-01-02T03:04:05.000Z");
const deadline = new Date(now + DECISION_DEADLINE_MIN_MS).toISOString();

function validRequest(): Record<string, unknown> {
	return {
		version: 1,
		key: "review-style",
		title: "Review style",
		question: "Which review style should be used?",
		options: [
			{ value: "quick", label: "Quick" },
			{ value: "thorough", label: "Thorough" },
		],
		other: { minLength: 2, maxLength: 40, pattern: "^[A-Za-z ]+$" },
		default: { kind: "option", value: "quick" },
		scope: "session",
		deadlineAt: deadline,
	};
}

function requestOutput(request = validRequest()): unknown {
	return { kind: "request", request };
}

function expectCode(value: unknown, code: string): void {
	expect(() => validateDecisionHookOutput(value, { now })).toThrow(expect.objectContaining({ name: "DecisionHookContractError", code }));
}

describe("decision hook contract", () => {
	it("accepts a bounded canonical request and defensive validated values", () => {
		const output = validateDecisionHookOutput(requestOutput(), { now });
		expect(output).toMatchObject({
			kind: "request",
			request: { deadlineAt: deadline, effect: { kind: "none" }, default: { kind: "option", value: "quick" } },
		});
		if (!output || output.kind !== "request") throw new Error("expected request");
		expect(Object.isFrozen(output.request)).toBe(true);
		expect(validateDecisionValue({ kind: "other", text: "Two words" }, output.request.options, output.request.other)).toEqual({ kind: "other", text: "Two words" });
	});

	it("accepts only null or undefined as a no-op", () => {
		expect(validateDecisionHookOutput(null, { now })).toBeNull();
		expect(validateDecisionHookOutput(undefined, { now })).toBeNull();
		expectCode({}, "INVALID_HOOK_OUTPUT");
		expectCode({ kind: "request", request: validRequest(), unexpected: true }, "UNKNOWN_HOOK_OUTPUT_FIELD");
	});

	it("rejects unknown fields and malformed output at every decision boundary", () => {
		const withUnknownRequest = validRequest();
		withUnknownRequest.unknown = true;
		expectCode(requestOutput(withUnknownRequest), "UNKNOWN_REQUEST_FIELD");
		const withUnknownOption = validRequest();
		(withUnknownOption.options as Array<Record<string, unknown>>)[0].extra = "no";
		expectCode(requestOutput(withUnknownOption), "UNKNOWN_OPTION_FIELD");
		const withUnknownOther = validRequest();
		(withUnknownOther.other as Record<string, unknown>).anything = true;
		expectCode(requestOutput(withUnknownOther), "UNKNOWN_OTHER_FIELD");
	});

	it("requires unique safe option ids and a required Other schema", () => {
		const duplicate = validRequest();
		(duplicate.options as Array<Record<string, unknown>>)[1].value = "quick";
		expectCode(requestOutput(duplicate), "INVALID_OPTIONS");
		const unsafe = validRequest();
		(unsafe.options as Array<Record<string, unknown>>)[0].value = "not safe";
		expectCode(requestOutput(unsafe), "INVALID_OPTIONS");
		const noOther = validRequest();
		delete noOther.other;
		expectCode(requestOutput(noOther), "INVALID_OTHER_SCHEMA");
		const nonAnchored = validRequest();
		(nonAnchored.other as Record<string, unknown>).pattern = "[a-z]+";
		expectCode(requestOutput(nonAnchored), "INVALID_OTHER_SCHEMA");
	});

	it("requires a validated option or Other default", () => {
		const invalidOption = validRequest();
		invalidOption.default = { kind: "option", value: "absent" };
		expectCode(requestOutput(invalidOption), "INVALID_DECISION_VALUE");
		const invalidOther = validRequest();
		invalidOther.default = { kind: "other", text: "x" };
		expectCode(requestOutput(invalidOther), "INVALID_DECISION_VALUE");
		const extraDefault = validRequest();
		extraDefault.default = { kind: "option", value: "quick", actor: "user" };
		expectCode(requestOutput(extraDefault), "UNKNOWN_DECISION_VALUE_FIELD");
	});

	it("requires canonical deadlines from 30 seconds through seven days", () => {
		const tooSoon = validRequest();
		tooSoon.deadlineAt = new Date(now + DECISION_DEADLINE_MIN_MS - 1).toISOString();
		expectCode(requestOutput(tooSoon), "INVALID_DEADLINE");
		const tooLate = validRequest();
		tooLate.deadlineAt = new Date(now + DECISION_DEADLINE_MAX_MS + 1).toISOString();
		expectCode(requestOutput(tooLate), "INVALID_DEADLINE");
		const nonCanonical = validRequest();
		nonCanonical.deadlineAt = "2026-01-02T03:04:35Z";
		expectCode(requestOutput(nonCanonical), "INVALID_DEADLINE");
	});

	it("validates proposal maps and bounded JSON-only proposal arguments", () => {
		const request = validRequest();
		request.effect = {
			kind: "proposal",
			proposals: {
				quick: { proposalType: "goal", args: { title: "Quick review", nested: [true, 2, null] } },
				thorough: { proposalType: "workflow", args: { title: "Thorough review" } },
				other: { proposalType: "tool", args: {} },
			},
		};
		expect(validateDecisionHookOutput(requestOutput(request), { now })).toMatchObject({ kind: "request", request: { effect: { kind: "proposal" } } });
		const incomplete = validRequest();
		incomplete.effect = { kind: "proposal", proposals: { quick: { proposalType: "goal", args: {} } } };
		expectCode(requestOutput(incomplete), "INVALID_EFFECT");
		const nonJson = validRequest();
		nonJson.effect = {
			kind: "proposal",
			proposals: {
				quick: { proposalType: "goal", args: { fn: () => undefined } },
				thorough: { proposalType: "goal", args: {} },
				other: { proposalType: "goal", args: {} },
			},
		};
		expectCode(requestOutput(nonJson), "INVALID_PROPOSAL_ARGS");
	});

	it("validates bounded non-interrupting advisories and rejects unsafe text", () => {
		const advisory = validateDecisionHookOutput({ kind: "advisory", advisory: { version: 1, staffId: "ops", key: "low-space", title: "Low space", body: "Disk space is low." } }, { now });
		expect(advisory).toEqual({ kind: "advisory", advisory: { version: 1, staffId: "ops", key: "low-space", title: "Low space", body: "Disk space is low." } });
		expectCode({ kind: "advisory", advisory: { version: 1, staffId: "ops", key: "low-space", title: "A", body: "https://user:password@example.test" } }, "INVALID_ADVISORY");
	});
});
