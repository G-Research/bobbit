/**
 * ProjectProposalPanel — sub-section diff renderer for project.yaml proposals.
 *
 * TODO Phase 4 follow-up: implement proper sub-section diff scoping by
 * top-level YAML key (components, workflows, qa_*). Today: stub with full-file
 * diff — the existing project-proposal renderer in `src/app/render.ts` handles
 * the live UI flow unchanged.
 *
 * See docs/design/multi-repo-components.md §8.6.
 */

export interface RenderProjectProposalDiffOpts {
	/** Which sub-section to focus on. Today the focus argument is informational. */
	focus?: "workflows" | "components" | "all";
}

/**
 * Stub renderer. Returns a plain unified diff between the old and new YAML
 * strings. The real renderer (sub-section scoping, collapsible sections,
 * component / workflow block diff) is a follow-up; consumers continue to
 * use the existing inline-proposal panel until then.
 */
export function renderProjectProposalDiff(
	oldYaml: string,
	newYaml: string,
	_opts?: RenderProjectProposalDiffOpts,
): string {
	return `--- old\n+++ new\n${oldYaml}\n${newYaml}`;
}
