/**
 * Canonical frozen workflow snapshot for every Explore Hypothesis goal.
 * The Optimisation Director passes this object as `bobbit_orchestrate(create_goal)`
 * body.workflow; it is deliberately a pack template rather than a registered workflow.
 */
export const EXPLORE_HYPOTHESIS_INLINE_WORKFLOW = {
	id: "explore-hypothesis",
	name: "Explore Hypothesis",
	description: "Measure one performance hypothesis against existing project benchmarks and behavioural tests before making a merge recommendation.",
	gates: [
		{
			id: "benchmark-selection",
			name: "Plan and Select",
			dependsOn: [],
			content: true,
			injectDownstream: true,
			verify: [{
				name: "Measurement plan is actionable or explicitly blocked",
				type: "llm-review",
				prompt: `Review the signaled plan for the single performance hypothesis. PASS only when it explains the expected mechanism, affected modules and execution path, expected benefit, risk, and likely complexity; selects every relevant existing project-owned benchmark and behavioural test; and states the metrics and improvement direction. If no applicable benchmark exists, PASS only when the artifact instead records blocked-unmeasurable, the metric or behaviour needing measurement, affected modules/path, why current benchmarks are unsuitable, and a suggested benchmark shape, with explicit confirmation that no production implementation began. A blocked-unmeasurable hypothesis stops here and is not a terminal recommendation.`,
			}],
		},
		{
			id: "baseline",
			name: "Baseline",
			dependsOn: ["benchmark-selection"],
			content: true,
			injectDownstream: true,
			verify: [{
				name: "Baseline evidence is reproducible",
				type: "llm-review",
				prompt: "PASS only when all selected benchmarks ran against the unchanged baseline and the artifact records commit, environment, named project commands, warm-up/repetitions, metrics and units, variability, and raw or structured results. Do not accept implementation changes in the baseline.",
			}],
		},
		{
			id: "implementation",
			name: "Implementation Variation",
			dependsOn: ["baseline"],
			content: true,
			injectDownstream: true,
			verify: [{
				name: "Variation is bounded and behaviour-preserving by intent",
				type: "llm-review",
				prompt: "PASS only when one bounded performance variation is implemented, its mechanism is tied to the hypothesis, behavioural intent is preserved, and all material complexity, maintainability, defect-surface, and operational-risk changes are recorded. Preserve prior unsuccessful variations rather than erasing their evidence.",
			}],
		},
		{
			id: "candidate-measurement",
			name: "Candidate Measurement",
			dependsOn: ["implementation"],
			content: true,
			injectDownstream: true,
			verify: [{
				name: "Candidate comparison is comparable and repeatable",
				type: "llm-review",
				prompt: "PASS only when the same selected benchmarks ran under conditions comparable to baseline and the artifact records candidate commit, environment, commands, repetitions, metrics, variability, structured/raw results, the baseline comparison, and a repeatability/noise assessment. If no repeatable benefit appears, require either one sensible bounded retry by resetting to Implementation Variation without deleting prior evidence, or progression toward the exact recommendation No improvement found.",
			}],
		},
		{
			id: "behavioural-validation",
			name: "Behavioural Validation",
			dependsOn: ["candidate-measurement"],
			content: true,
			injectDownstream: true,
			verify: [{
				name: "Selected behaviour remains protected",
				type: "llm-review",
				prompt: "PASS only when all selected project-owned behavioural tests ran and their commands and results are recorded. Added characterization coverage is allowed when existing tests did not protect the affected behaviour. If behaviour changed, require correction through another bounded implementation variation where sensible or progression toward the exact recommendation Changes system behaviour.",
			}],
		},
		{
			id: "terminal-recommendation",
			name: "Recommendation",
			dependsOn: ["behavioural-validation"],
			content: true,
			verify: [{
				name: "Terminal recommendation and trade-off artifact are complete",
				type: "llm-review",
				prompt: `PASS only when the final artifact records exactly one recommendation from this list, with exact spelling: No improvement found; Improvement doesn’t justify complication; Changes system behaviour; Recommend merging. It must also include baseline and candidate measurements with variability, repeatability assessment, behavioural test commands/results, complexity and maintainability assessment, new defect surface and operational risk, and recommendation rationale. Confirm the same structured outcome was committed to the performance registry. Only Recommend merging may advance a merge candidate, and its PR description must surface this complete comparison and recommendation; every other result preserves its branch, commits, measurements, and findings without a merge recommendation.`,
			}],
		},
	],
} as const;

export default EXPLORE_HYPOTHESIS_INLINE_WORKFLOW;
