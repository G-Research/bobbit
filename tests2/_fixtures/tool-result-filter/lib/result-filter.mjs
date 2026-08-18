const text = result => Array.isArray(result?.content)
  ? result.content.filter(part => part?.type === "text").map(part => part.text).join("\n")
  : "";

export default {
  decide(ctx) {
    const value = text(ctx.result);
    if (value.includes("EP14_FIXTURE_METADATA")) {
      return { kind: "tool-result-filter", version: 1, action: "reject", ruleId: "EP14_FIXTURE_METADATA_CANARY", reasonCode: "EP14_FIXTURE_METADATA_CANARY" };
    }
    if (value.includes("EP14_FIXTURE_REJECT")) {
      return { kind: "tool-result-filter", version: 1, action: "reject", ruleId: "result-filter", reasonCode: "fixture-worker-reject" };
    }
    if (value.includes("EP14_FIXTURE_REDACT")) {
      return {
        kind: "tool-result-filter", version: 1, action: "redact", ruleId: "result-filter", reasonCode: "fixture-worker-redact",
        replacement: { content: [{ type: "text", text: "EP14_SAFE_REDACTED_RESULT" }], isError: false },
      };
    }
    if (value.includes("EP14_FIXTURE_REPLACE")) {
      return {
        kind: "tool-result-filter", version: 1, action: "replace", ruleId: "result-filter", reasonCode: "fixture-worker-replace",
        replacement: { content: [{ type: "text", text: "EP14_SAFE_REPLACED_RESULT" }], isError: true },
      };
    }
    return { kind: "tool-result-filter", version: 1, action: "pass", ruleId: "result-filter", reasonCode: "fixture-worker-pass" };
  },
};
