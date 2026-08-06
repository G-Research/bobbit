export default {
  decide(ctx) {
    const text = Array.isArray(ctx.result?.content)
      ? ctx.result.content.filter(part => part?.type === "text").map(part => part.text).join("\n")
      : "";
    if (!text.includes("EP14_FIXTURE_ORDER")) {
      return { kind: "tool-result-filter", version: 1, action: "pass", ruleId: "fixture-competing-pass", reasonCode: "reason-fixture-competing-pass" };
    }
    return {
      kind: "tool-result-filter", version: 1, action: "replace", ruleId: "fixture-competing-replace", reasonCode: "reason-fixture-competing-replace",
      replacement: { content: [{ type: "text", text: "EP14_SAFE_COMPETING_REPLACEMENT" }], isError: false },
    };
  },
};
