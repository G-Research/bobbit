export async function decide(ctx) {
  const patterns = ctx.staffImprovementSignals?.patterns;
  if (!Array.isArray(patterns) || !patterns.some(({ kind, count }) => kind === "repeated-user-correction" && count > 0)) return undefined;
  return {
    kind: "request",
    request: {
      version: 1,
      key: "staff-improvement-v1",
      title: "Suggested workflow improvement",
      question: "Recent session patterns suggest an improvement. Create an editable draft?",
      options: [
        { value: "create", label: "Create draft" },
        { value: "decline", label: "Not now" },
      ],
      other: { maxLength: 280 },
      scope: "session",
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      requestedClass: "consent-required",
      intent: "staff-improvement",
      effect: {
        kind: "proposal",
        proposals: {
          create: {
            proposalType: "goal",
            args: {
              title: "Improve staff workflow guidance",
              spec: "Investigate the observed correction pattern and propose an explicit workflow or AGENTS.md guidance improvement.",
            },
          },
        },
        noEffectValues: ["decline", "other"],
      },
    },
  };
}
