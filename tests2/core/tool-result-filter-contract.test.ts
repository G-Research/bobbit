import { describe, expect, it } from "vitest";
import {
	MAX_TOOL_RESULT_DETAILS_BYTES,
	MAX_TOOL_RESULT_TEXT_BYTES,
	ToolResultFilterContractError,
	applyToolResultFilterReduction,
	createSyntheticRejectedToolResult,
	reduceToolResultFilters,
	validateCanonicalToolResult,
	validateToolResultFilterProposal,
	validateToolResultInspection,
} from "../../src/server/agent/tool-result-filter-contract.ts";

const original = {
	content: [{ type: "text", text: "EP14-CANARY-original" }],
	details: { nested: ["safe"] },
	isError: false,
	usage: { inputTokens: 3, outputTokens: 4 },
};

function proposal(action: "pass" | "replace" | "redact" | "reject", overrides: Record<string, unknown> = {}): unknown {
	return {
		kind: "tool-result-filter",
		version: 1,
		action,
		ruleId: "fixture-rule",
		reasonCode: "fixture-reason",
		...((action === "replace" || action === "redact") ? { replacement: { content: [{ type: "text", text: "EP14-CANARY-safe" }] } } : {}),
		...overrides,
	};
}

function contractCode(fn: () => unknown): string {
	try { fn(); } catch (error) {
		if (error instanceof ToolResultFilterContractError) return error.code;
		throw error;
	}
	throw new Error("expected contract rejection");
}

describe("tool result filter contract", () => {
	it("accepts a bounded complete inspection and freezes its canonical result", () => {
		const inspection = validateToolResultInspection({
			event: "afterToolResult", sessionId: "session-a", projectId: "project-a", toolCallId: "call-a", toolName: "bash", result: original,
		});
		expect(inspection).toMatchObject({ event: "afterToolResult", result: { content: [{ text: "EP14-CANARY-original" }], usage: { outputTokens: 4 } } });
		expect(Object.isFrozen(inspection.result)).toBe(true);
		expect(Object.isFrozen(inspection.result.content)).toBe(true);
		expect(contractCode(() => validateToolResultInspection({ ...inspection, arguments: {} }))).toBe("INVALID_INSPECTION");
	});

	it("accepts legitimate empty content and text results", () => {
		expect(validateCanonicalToolResult({ content: [], isError: false })).toEqual({ content: [], isError: false });
		expect(validateCanonicalToolResult({ content: [{ type: "text", text: "" }], isError: false })).toEqual({ content: [{ type: "text", text: "" }], isError: false });
	});

	it("accepts empty JSON detail leaves but rejects malformed text, oversized details, unknown blocks, invalid images, and prototype values", () => {
		expect(validateCanonicalToolResult({ content: [], details: { empty: "", nested: [""] }, isError: false })).toEqual({ content: [], details: { empty: "", nested: [""] }, isError: false });
		expect(contractCode(() => validateCanonicalToolResult({ ...original, content: [{ type: "text", text: "\ud800" }] }))).toBe("INVALID_TOOL_RESULT");
		expect(contractCode(() => validateCanonicalToolResult({ ...original, content: [{ type: "file", data: "x" }] }))).toBe("INVALID_TOOL_RESULT");
		expect(contractCode(() => validateCanonicalToolResult({ ...original, content: [{ type: "image", mediaType: "image/gif", data: "eA==" }] }))).toBe("INVALID_TOOL_RESULT");
		expect(contractCode(() => validateCanonicalToolResult({ ...original, content: [{ type: "image", mediaType: "image/png", data: "not-base64" }] }))).toBe("INVALID_TOOL_RESULT");
		expect(contractCode(() => validateCanonicalToolResult({ ...original, content: [{ type: "text", text: "x".repeat(MAX_TOOL_RESULT_TEXT_BYTES + 1) }] }))).toBe("INVALID_TOOL_RESULT");
		expect(contractCode(() => validateCanonicalToolResult({ ...original, details: "x".repeat(MAX_TOOL_RESULT_DETAILS_BYTES + 1) }))).toBe("INVALID_DETAILS");
		expect(contractCode(() => validateCanonicalToolResult({ ...original, details: { credential: "https://user:password@example.test" } }))).toBe("INVALID_DETAILS");
		expect(contractCode(() => validateCanonicalToolResult(Object.create({ content: original.content, isError: false })))).toBe("INVALID_TOOL_RESULT");
	});

	it("permits only closed pass, reject, replace, and redact shapes", () => {
		expect(validateToolResultFilterProposal(proposal("pass"))).toMatchObject({ action: "pass" });
		expect(validateToolResultFilterProposal(proposal("reject"))).toMatchObject({ action: "reject" });
		expect(validateToolResultFilterProposal(proposal("replace"))).toMatchObject({ action: "replace", replacement: { content: [{ text: "EP14-CANARY-safe" }] } });
		expect(validateToolResultFilterProposal(proposal("redact"))).toMatchObject({ action: "redact" });
		expect(contractCode(() => validateToolResultFilterProposal(proposal("pass", { replacement: { content: [{ type: "text", text: "x" }] } })))).toBe("INVALID_PROPOSAL");
		expect(contractCode(() => validateToolResultFilterProposal(proposal("replace", {
			replacement: { content: [{ type: "text", text: "x" }], details: {} },
		})))).toBe("INVALID_REPLACEMENT");
		expect(contractCode(() => validateToolResultFilterProposal(proposal("redact", { patch: [] })))).toBe("UNKNOWN_PROPOSAL_FIELD");
		expect(contractCode(() => validateToolResultFilterProposal(proposal("reject", { reasonCode: "free form reason" })))).toBe("INVALID_PROPOSAL");
	});

	it("reduces reject over redact and replacement, then priority and stable source identity", () => {
		const redact = validateToolResultFilterProposal(proposal("redact"));
		const replace = validateToolResultFilterProposal(proposal("replace"));
		const reject = validateToolResultFilterProposal(proposal("reject"));
		const reduced = reduceToolResultFilters([
			{ source: { packId: "high-replace", hookId: "hook", priority: 100 }, proposal: replace },
			{ source: { packId: "low-redact", hookId: "hook", priority: 1 }, proposal: redact },
			{ source: { packId: "low-reject", hookId: "hook", priority: 0 }, proposal: reject },
		]);
		expect(reduced).toMatchObject({ action: "reject", source: { packId: "low-reject" } });
		const tied = reduceToolResultFilters([
			{ source: { packId: "z-pack", hookId: "hook", priority: 1 }, proposal: replace },
			{ source: { packId: "a-pack", hookId: "hook", priority: 1 }, proposal: replace },
		]);
		expect(tied.source).toMatchObject({ packId: "a-pack" });
	});

	it("uses code-unit source ties regardless of input order", () => {
		const replacement = validateToolResultFilterProposal(proposal("replace"));
		const candidates = [
			{ source: { packId: "pack-2", hookId: "hook.1", priority: 4 }, proposal: replacement },
			{ source: { packId: "pack.1", hookId: "hook-2", priority: 4 }, proposal: replacement },
		];
		for (const ordered of [candidates, [...candidates].reverse()]) {
			expect(reduceToolResultFilters(ordered)).toMatchObject({ action: "replace", source: { packId: "pack-2", hookId: "hook.1" } });
		}
	});

	it("releases only original pass bytes, replacement bytes, or fixed synthetic rejection", () => {
		const canonical = validateCanonicalToolResult(original);
		const replacement = validateToolResultFilterProposal(proposal("redact"));
		const redacted = applyToolResultFilterReduction(canonical, {
			action: "redact", proposal: replacement, source: { packId: "pack-a", hookId: "hook", priority: 0 },
		});
		expect(redacted).toEqual({ content: [{ type: "text", text: "EP14-CANARY-safe" }], isError: false });
		expect(JSON.stringify(redacted)).not.toContain("EP14-CANARY-original");
		expect(JSON.stringify(redacted)).not.toContain("nested");
		const rejected = applyToolResultFilterReduction(canonical, { action: "reject" }, "opaque-ref-1");
		expect(rejected).toEqual(createSyntheticRejectedToolResult("opaque-ref-1"));
		expect(JSON.stringify(rejected)).not.toContain("EP14-CANARY-original");
	});
});
