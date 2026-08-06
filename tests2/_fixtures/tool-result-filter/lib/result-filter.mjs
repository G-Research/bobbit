const text = result => Array.isArray(result?.content)
  ? result.content.filter(part => part?.type === "text").map(part => part.text).join("\n")
  : "";

export default {
  decide(ctx) {
    const value = text(ctx.result);
    if (value.includes("EP14_FIXTURE_REJECT")) {
      return { kind: "tool-result-filter", version: 1, action: "reject", ruleId: "fixture-reject", reasonCode: "fixture-reject" };
    }
    if (value.includes("EP14_FIXTURE_REDACT")) {
      return {
        kind: "tool-result-filter", version: 1, action: "redact", ruleId: "fixture-redact", reasonCode: "fixture-redact",
        replacement: { content: [{ type: "text", text: "EP14_SAFE_REDACTED_RESULT" }], isError: false },
      };
    }
    if (value.includes("EP14_FIXTURE_REPLACE")) {
      return {
        kind: "tool-result-filter", version: 1, action: "replace", ruleId: "fixture-replace", reasonCode: "fixture-replace",
        replacement: { content: [{ type: "text", text: "EP14_SAFE_REPLACED_RESULT" }], isError: true },
      };
    }
    return { kind: "tool-result-filter", version: 1, action: "pass", ruleId: "fixture-pass", reasonCode: "fixture-pass" };
  },
};
