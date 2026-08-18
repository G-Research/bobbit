import { describe, expect, it } from "vitest";
import {
	DECISION_DEADLINE_MAX_MS,
	DECISION_DEADLINE_MIN_MS,
	validateDecisionHookOutput,
	validateProjectImportDecisionHookOutput,
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
			request: { requestedClass: "deferrable", deadlineAt: deadline, effect: { kind: "none" }, default: { kind: "option", value: "quick" } },
		});
		if (!output || output.kind !== "request") throw new Error("expected request");
		expect(Object.isFrozen(output.request)).toBe(true);
		expect(validateDecisionValue({ kind: "other", text: "Two words" }, output.request.options, output.request.other)).toEqual({ kind: "other", text: "Two words" });
	});

	it("limits project-import requests to project scope and no mutation output", () => {
		const projectScoped = validRequest();
		projectScoped.scope = "project";
		expect(validateProjectImportDecisionHookOutput(requestOutput(projectScoped), { now })).toMatchObject({ kind: "request", request: { scope: "project" } });
		expect(() => validateProjectImportDecisionHookOutput(requestOutput(validRequest()), { now })).toThrow(expect.objectContaining({ code: "DECISION_SCOPE_UNAVAILABLE" }));
		expect(() => validateProjectImportDecisionHookOutput({ kind: "request-mutation", proposal: {} }, { now })).toThrow(expect.objectContaining({ code: "DECISION_OUTPUT_UNAVAILABLE" }));
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

	it("requires unique safe option ids and unambiguous labels with a required Other schema", () => {
		const duplicate = validRequest();
		(duplicate.options as Array<Record<string, unknown>>)[1].value = "quick";
		expectCode(requestOutput(duplicate), "INVALID_OPTIONS");
		const unsafe = validRequest();
		(unsafe.options as Array<Record<string, unknown>>)[0].value = "not safe";
		expectCode(requestOutput(unsafe), "INVALID_OPTIONS");
		const duplicateLabel = validRequest();
		(duplicateLabel.options as Array<Record<string, unknown>>)[1].label = "quick";
		expectCode(requestOutput(duplicateLabel), "INVALID_OPTIONS");
		for (const reservedLabel of ["Other", "oThEr", "__OTHER__"]) {
			const reserved = validRequest();
			(reserved.options as Array<Record<string, unknown>>)[0].label = reservedLabel;
			expectCode(requestOutput(reserved), "INVALID_OPTIONS");
		}
		const noOther = validRequest();
		delete noOther.other;
		expectCode(requestOutput(noOther), "INVALID_OTHER_SCHEMA");
		const nonAnchored = validRequest();
		(nonAnchored.other as Record<string, unknown>).pattern = "[a-z]+";
		expectCode(requestOutput(nonAnchored), "INVALID_OTHER_SCHEMA");
	});

	it("accepts conservative anchored linear Other patterns", () => {
		for (const [pattern, text] of [["^[A-Za-z ]+$", "Review style"], ["^[0-9]{1,4}$", "2026"], ["^release-[A-Za-z0-9._-]+$", "release-1.0"]]) {
			const request = validRequest();
			(request.other as Record<string, unknown>).pattern = pattern;
			expect(validateDecisionHookOutput(requestOutput(request), { now })).toMatchObject({ kind: "request" });
			expect(validateDecisionValue({ kind: "other", text }, [], { minLength: 1, maxLength: 280, pattern })).toEqual({ kind: "other", text });
		}
	});

	it("rejects unsafe native regex constructs and never executes legacy unsafe patterns", () => {
		for (const pattern of ["^(a+)+$", "^(a|aa)+$", "^(?=a)a+$", "^(a+)\\1$"]) {
			const request = validRequest();
			(request.other as Record<string, unknown>).pattern = pattern;
			expectCode(requestOutput(request), "INVALID_OTHER_SCHEMA");
		}
		expect(() => validateDecisionValue(
			{ kind: "other", text: "aaaa" },
			[],
			{ minLength: 1, maxLength: 280, pattern: "^(a+)+$" },
		)).toThrow(expect.objectContaining({ name: "DecisionHookContractError", code: "INVALID_DECISION_VALUE" }));
	});

	it("defaults omitted requests to deferrable and requires a validated default", () => {
		const invalidOption = validRequest();
		invalidOption.default = { kind: "option", value: "absent" };
		expectCode(requestOutput(invalidOption), "INVALID_DECISION_VALUE");
		const invalidOther = validRequest();
		invalidOther.default = { kind: "other", text: "x" };
		expectCode(requestOutput(invalidOther), "INVALID_DECISION_VALUE");
		const extraDefault = validRequest();
		extraDefault.default = { kind: "option", value: "quick", actor: "user" };
		expectCode(requestOutput(extraDefault), "UNKNOWN_DECISION_VALUE_FIELD");
		const missingDefault = validRequest();
		delete missingDefault.default;
		expectCode(requestOutput(missingDefault), "DEFAULT_REQUIRED");
	});

	it("validates bounded class and intent metadata without giving consent a default", () => {
		const consent = validRequest();
		delete consent.default;
		consent.requestedClass = "consent-required";
		consent.intent = "configuration-change";
		const output = validateDecisionHookOutput(requestOutput(consent), { now });
		expect(output).toMatchObject({ kind: "request", request: { requestedClass: "consent-required", intent: "configuration-change" } });
		if (!output || output.kind !== "request") throw new Error("expected request");
		expect(Object.hasOwn(output.request, "default")).toBe(false);

		const directConsentDefault = validRequest();
		directConsentDefault.requestedClass = "consent-required";
		expectCode(requestOutput(directConsentDefault), "CONSENT_DEFAULT_FORBIDDEN");
		const invalidClass = validRequest();
		invalidClass.requestedClass = "advisory";
		expectCode(requestOutput(invalidClass), "INVALID_REQUESTED_CLASS");
		const invalidIntent = validRequest();
		invalidIntent.intent = "not a routing id";
		expectCode(requestOutput(invalidIntent), "INVALID_INTENT");
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

	it("accepts only strict typed advisory selections without changing request or advisory behavior", () => {
		const selection = validateDecisionHookOutput({ kind: "selection", selection: { kind: "model", provider: "openai", modelId: "gpt-5.2" } }, { now });
		expect(selection).toEqual({ kind: "selection", selection: { kind: "model", provider: "openai", modelId: "gpt-5.2" } });
		if (!selection || selection.kind !== "selection") throw new Error("expected selection");
		expect(Object.isFrozen(selection)).toBe(true);
		expect(Object.isFrozen(selection.selection)).toBe(true);
		expectCode({ kind: "selection", selection: { kind: "thinking", thinkingLevel: "HIGH" } }, "INVALID_SELECTION");
		expectCode({ kind: "selection", selection: { kind: "role", roleName: "coder", score: 1 } }, "UNKNOWN_SELECTION_FIELD");
		expectCode({ kind: "selection", selection: { kind: "workflow", workflowId: "release" }, effect: { kind: "none" } }, "UNKNOWN_HOOK_OUTPUT_FIELD");
		expectCode({ kind: "selection", selection: { kind: "model", provider: "openai", modelId: "gpt-5.2", callback: "apply" } }, "UNKNOWN_SELECTION_FIELD");
	});

	it("allows declared negative options to have no proposal seed", () => {
		const request = validRequest();
		delete request.default;
		request.requestedClass = "consent-required";
		request.effect = {
			kind: "proposal",
			proposals: { quick: { proposalType: "goal", args: { title: "Draft" } } },
			noEffectValues: ["thorough", "other"],
		};
		expect(validateDecisionHookOutput(requestOutput(request), { now })).toMatchObject({
			kind: "request", request: { effect: { noEffectValues: ["thorough", "other"] } },
		});
		(request.effect as Record<string, unknown>).noEffectValues = ["quick"];
		expectCode(requestOutput(request), "INVALID_EFFECT");
	});
});
