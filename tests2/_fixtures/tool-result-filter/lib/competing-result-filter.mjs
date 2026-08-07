export default {
  decide(ctx) {
    const text = Array.isArray(ctx.result?.content)
      ? ctx.result.content.filter(part => part?.type === "text").map(part => part.text).join("\n")
      : "";
    if (!text.includes("EP14_FIXTURE_ORDER")) {
      return { kind: "tool-result-filter", version: 1, action: "pass", ruleId: "competing-result-filter", reasonCode: "fixture-worker-pass" };
    }
    return {
      kind: "tool-result-filter", version: 1, action: "replace", ruleId: "competing-result-filter", reasonCode: "fixture-worker-replace",
      replacement: { content: [{ type: "text", text: "EP14_SAFE_COMPETING_REPLACEMENT" }], isError: false },
    };
  },
};
