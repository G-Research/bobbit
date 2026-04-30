/**
 * Derived workflow builders for the project-assistant's checklist flow.
 *
 * - `buildPerComponentWorkflow(componentName, allComponents)` — clones the
 *   canonical `feature` workflow but rewrites id/name/description so a multi-
 *   component project can ship one feature flow per component.
 * - `buildAllComponentsWorkflow(components)` — fan-out implementation gate
 *   that runs build/check/unit/e2e across every component with a `commands`
 *   map. Data-only components are skipped.
 *
 * Both helpers reuse prompts and the `readyToMergeGate()` helper exported by
 * `seed-default-workflows.ts` so `buildDefaultWorkflows` stays canonical.
 */

import type { Component } from "../agent/project-config-store.js";
import {
	buildDefaultWorkflows,
	readyToMergeGate,
	DESIGN_REVIEW_PROMPT,
	GAP_ANALYSIS_DESIGN_PROMPT,
	GAP_ANALYSIS_IMPL_PROMPT,
	CODE_REVIEW_PROMPT,
	DOC_PROMPT,
	RALPH_LOOP_DESCRIPTION,
	type SeededWorkflow,
	type SeededVerifyStep,
} from "./seed-default-workflows.js";

/**
 * Build a feature-style workflow scoped to a single component.
 *
 * Clones `buildDefaultWorkflows(componentName).feature` and rewrites the
 * top-level workflow id/name/description. The underlying `{ component, command }`
 * step refs already target `componentName` because the seed uses the supplied
 * component name throughout.
 *
 * Resulting workflow id: `feature-${componentName}`.
 */
export function buildPerComponentWorkflow(
	componentName: string,
	_allComponents: Component[],
): SeededWorkflow {
	const def = buildDefaultWorkflows(componentName).feature;
	return {
		...def,
		id: `feature-${componentName}`,
		name: `Feature (${componentName})`,
		description: `Feature flow scoped to the ${componentName} component.`,
	};
}

/**
 * Build a fan-out workflow that builds and tests every component with a
 * `commands` map in parallel phases. Data-only components are silently skipped.
 *
 * Phases:
 *   - phase 0: build (one step per component)
 *   - phase 1: check + unit + e2e (one step per (component, command))
 *   - phase 2: gap-analysis (post-impl), code-quality review
 *
 * Workflow id: `all-components`.
 */
export function buildAllComponentsWorkflow(components: Component[]): SeededWorkflow {
	const buildable = components.filter(
		(c) => c.commands && Object.keys(c.commands).length > 0,
	);

	const verify: SeededVerifyStep[] = [];
	for (const c of buildable) {
		if (c.commands?.build) {
			verify.push({
				name: `Build: ${c.name}`,
				type: "command",
				phase: 0,
				component: c.name,
				command: "build",
				timeout: 600,
			});
		}
	}
	for (const c of buildable) {
		if (c.commands?.check) {
			verify.push({
				name: `Type check: ${c.name}`,
				type: "command",
				phase: 1,
				component: c.name,
				command: "check",
			});
		}
		if (c.commands?.unit) {
			verify.push({
				name: `Unit tests: ${c.name}`,
				type: "command",
				phase: 1,
				component: c.name,
				command: "unit",
			});
		}
		if (c.commands?.e2e) {
			verify.push({
				name: `E2E tests: ${c.name}`,
				type: "command",
				phase: 1,
				component: c.name,
				command: "e2e",
				timeout: 900,
			});
		}
	}
	verify.push({
		name: "Gap analysis",
		type: "llm-review",
		role: "spec-auditor",
		phase: 2,
		prompt: GAP_ANALYSIS_IMPL_PROMPT,
	});
	verify.push({
		name: "Code quality review",
		type: "llm-review",
		role: "code-reviewer",
		phase: 2,
		prompt: CODE_REVIEW_PROMPT,
	});

	return {
		id: "all-components",
		name: "All Components",
		description: "Fan-out flow that builds and tests every component in parallel.",
		gates: [
			{
				id: "design-doc",
				name: "Design Document",
				content: true,
				inject_downstream: true,
				verify: [
					{ name: "Design review", type: "llm-review", role: "architect", prompt: DESIGN_REVIEW_PROMPT },
					{ name: "Gap analysis", type: "llm-review", role: "spec-auditor", prompt: GAP_ANALYSIS_DESIGN_PROMPT },
				],
			},
			{
				id: "implementation",
				name: "Implementation",
				description: RALPH_LOOP_DESCRIPTION,
				depends_on: ["design-doc"],
				verify,
			},
			{
				id: "documentation",
				name: "Documentation",
				depends_on: ["implementation"],
				verify: [
					{ name: "Documentation coverage", type: "llm-review", prompt: DOC_PROMPT },
				],
			},
			readyToMergeGate(),
		],
	};
}
