import type { PrWalkthroughCard, PrWalkthroughChangesetRef } from "./types.js";

export const fixturePrWalkthroughChangeset: PrWalkthroughChangesetRef = {
	baseSha: "9f4c2a1",
	headSha: "c7b8e32",
	provider: "github",
	externalUrl: "https://github.com/SuuBro/bobbit/pull/1842",
	prUrl: "https://github.com/SuuBro/bobbit/pull/1842",
	prNumber: 1842,
	prTitle: "Productionise PR walkthrough panel",
	title: "PR #1842: Productionise PR walkthrough panel",
	filesChanged: 50,
	additions: 4650,
	deletions: 2353,
};

export function getFixturePrWalkthroughCards(): PrWalkthroughCard[] {
	return [
		{
			id: "orientation-scope",
			phaseId: "orientation",
			title: "Separate walkthrough from chat",
			summary: "Introduces the review surface as a side-panel component with its own local interaction state rather than embedding review cards in chat messages.",
			rationale: "The walkthrough can later be opened from GitHub, git status, or any two SHAs without coupling the core model to a provider.",
			checklist: ["Panel owns review navigation", "Events expose draft state", "No nested prompt composer"],
			cardSuggestions: ["Confirm that the outer Bobbit chat remains the only place for reviewer questions.", "The side-panel launch path should preserve one canonical walkthrough tab per changeset."],
			diffBlocks: [
				{
					id: "orientation-panel",
					filePath: "src/ui/components/pr-walkthrough/PrWalkthroughPanel.ts",
					hunks: [
						{
							id: "orientation-panel-h1",
							header: "@@ -0,0 +1,18 @@",
							lines: [
								{ id: "op-1", side: "new", newLine: 1, kind: "add", text: "@customElement(\"pr-walkthrough-panel\")" },
								{ id: "op-2", side: "new", newLine: 2, kind: "add", text: "export class PrWalkthroughPanel extends LitElement {" },
								{ id: "op-3", side: "new", newLine: 3, kind: "add", text: "  @property({ attribute: false }) changeset?: PrWalkthroughChangesetRef;" },
								{ id: "op-4", side: "new", newLine: 4, kind: "add", text: "  @property({ attribute: false }) cards: PrWalkthroughCard[] = getFixturePrWalkthroughCards();" },
								{ id: "op-5", side: "new", newLine: 5, kind: "add", text: "  @state() private activeCardId = \"orientation-scope\";" },
							],
						},
					],
				},
			],
			suggestedComments: [
				{
					id: "suggest-orientation-state",
					cardId: "orientation-scope",
					diffBlockId: "orientation-panel",
					lineId: "op-5",
					body: "Consider deriving the initial card from incoming cards so fixture replacement cannot leave stale state.",
				},
			],
		},
		{
			id: "design-model",
			phaseId: "design",
			title: "Changeset-agnostic model",
			summary: "Defines PR walkthrough cards, hunks, comments, decisions, and draft review helpers without GitHub-specific fields in the core state.",
			rationale: "Provider adapters can map GitHub, local diffs, or future review sources into the same card shape.",
			checklist: ["Comments anchor by card/block/line", "Draft helper clones state", "Width helper centralises diff defaults"],
			cardSuggestions: ["Provider metadata stays optional, which keeps local SHA walkthroughs first-class."],
			diffBlocks: [
				{
					id: "types-model",
					filePath: "src/ui/components/pr-walkthrough/types.ts",
					hunks: [
						{
							id: "types-model-h1",
							header: "@@ -0,0 +1,34 @@",
							lines: [
								{ id: "tm-1", side: "new", newLine: 1, kind: "add", text: "export interface PrWalkthroughChangesetRef {" },
								{ id: "tm-2", side: "new", newLine: 2, kind: "add", text: "  baseSha: string;" },
								{ id: "tm-3", side: "new", newLine: 3, kind: "add", text: "  headSha: string;" },
								{ id: "tm-4", side: "new", newLine: 4, kind: "add", text: "  provider?: string;" },
								{ id: "tm-5", side: "new", newLine: 5, kind: "add", text: "  externalUrl?: string;" },
								{ id: "tm-6", side: "new", newLine: 6, kind: "add", text: "}" },
							],
						},
					],
				},
			],
			suggestedComments: [
				{
					id: "suggest-model-provider",
					cardId: "design-model",
					diffBlockId: "types-model",
					lineId: "tm-4",
					body: "Provider metadata stays optional, which keeps local SHA walkthroughs first-class.",
				},
			],
		},
		{
			id: "design-navigation",
			phaseId: "design",
			title: "Responsive phase rail",
			summary: "Adds a labelled rail for wide panels and a pip/dot rail for constrained side-panel widths.",
			rationale: "The same review flow must remain usable in the half-width preview panel and full-width review surfaces.",
			checklist: ["Phase buttons jump to first card", "Collapsed dots remain buttons", "Tooltips name each card"],
			cardSuggestions: ["The collapsed rail must stay usable at preview-pane width, not just full-screen."],
			diffBlocks: [
				{
					id: "navigation-rail",
					filePath: "src/ui/components/pr-walkthrough/PrWalkthroughPanel.ts",
					hunks: [
						{
							id: "navigation-rail-h1",
							header: "@@ -116,8 +152,20 @@ private renderRail()",
							lines: [
								{ id: "nr-1", side: "context", oldLine: 116, newLine: 152, kind: "context", text: "const grouped = this.cardsByPhase;" },
								{ id: "nr-2", side: "old", oldLine: 117, kind: "del", text: "return html`<nav>${grouped.map(renderPhase)}</nav>`;" },
								{ id: "nr-3", side: "new", newLine: 153, kind: "add", text: "if (this.isNarrow) return this.renderCollapsedRail(grouped);" },
								{ id: "nr-4", side: "new", newLine: 154, kind: "add", text: "return this.renderLabelledRail(grouped);" },
								{ id: "nr-5", side: "context", oldLine: 118, newLine: 155, kind: "context", text: "}" },
							],
						},
					],
				},
			],
		},
		{
			id: "significant-diff",
			phaseId: "significant",
			title: "Diff mode and shared overflow",
			summary: "Renders split and inline diff views from the same hunk model, defaulting split on wide panels and inline on narrow panels.",
			rationale: "Split mode keeps old/new columns aligned while a single overflow container prevents duelling horizontal scrollbars.",
			checklist: ["Split mode uses one overflow wrapper", "Inline mode remains available", "Changed and context lines are commentable"],
			cardSuggestions: ["Keep split overflow on one shared scroller so reviewers do not fight duelling horizontal scrollbars."],
			diffBlocks: [
				{
					id: "diff-renderer",
					filePath: "src/ui/components/pr-walkthrough/PrWalkthroughPanel.ts",
					hunks: [
						{
							id: "diff-renderer-h1",
							header: "@@ -202,10 +246,18 @@ private renderDiffBlock(block)",
							lines: [
								{ id: "dr-1", side: "context", oldLine: 202, newLine: 246, kind: "context", text: "<section class=\"diff-block\">" },
								{ id: "dr-2", side: "old", oldLine: 203, kind: "del", text: "  <div class=\"old-column\">${oldLines}</div>" },
								{ id: "dr-3", side: "old", oldLine: 204, kind: "del", text: "  <div class=\"new-column\">${newLines}</div>" },
								{ id: "dr-4", side: "new", newLine: 247, kind: "add", text: "  <div class=\"diff-overflow\">" },
								{ id: "dr-5", side: "new", newLine: 248, kind: "add", text: "    <div class=\"split-grid\">${pairedLines}</div>" },
								{ id: "dr-6", side: "new", newLine: 249, kind: "add", text: "  </div>" },
								{ id: "dr-7", side: "context", oldLine: 205, newLine: 250, kind: "context", text: "</section>" },
							],
						},
					],
				},
			],
			suggestedComments: [
				{
					id: "suggest-diff-overflow",
					cardId: "significant-diff",
					diffBlockId: "diff-renderer",
					lineId: "dr-4",
					body: "Good: the overflow wrapper encloses both columns, so split scrolling stays synchronised.",
				},
			],
		},
		{
			id: "significant-comments",
			phaseId: "significant",
			title: "Line and card comments",
			summary: "Adds custom and suggested comments anchored to logical card, diff block, and line IDs, with editing and deletion reflected in draft state.",
			rationale: "Stable logical anchors are easier to map onto generated cards than raw line numbers alone.",
			checklist: ["Dislike waits for a comment", "Suggested comments can be accepted", "Card-level concerns are always available"],
			cardSuggestions: ["Dislike gating should be pinned because deleting the final supporting comment must clear the decision."],
			diffBlocks: [
				{
					id: "comment-state",
					filePath: "src/ui/components/pr-walkthrough/types.ts",
					hunks: [
						{
							id: "comment-state-h1",
							header: "@@ -42,6 +58,16 @@ export interface PrWalkthroughComment",
							lines: [
								{ id: "cs-1", side: "context", oldLine: 42, newLine: 58, kind: "context", text: "export interface PrWalkthroughComment {" },
								{ id: "cs-2", side: "new", newLine: 59, kind: "add", text: "  cardId: string;" },
								{ id: "cs-3", side: "new", newLine: 60, kind: "add", text: "  diffBlockId?: string;" },
								{ id: "cs-4", side: "new", newLine: 61, kind: "add", text: "  lineId?: string;" },
								{ id: "cs-5", side: "new", newLine: 62, kind: "add", text: "  body: string;" },
								{ id: "cs-6", side: "context", oldLine: 43, newLine: 63, kind: "context", text: "}" },
							],
						},
					],
				},
				{
					id: "decision-state",
					filePath: "src/ui/components/pr-walkthrough/types.ts",
					hunks: [
						{
							id: "decision-state-h1",
							header: "@@ -66,0 +82,8 @@",
							lines: [
								{ id: "ds-1", side: "new", newLine: 82, kind: "add", text: "export interface PrWalkthroughDecision {" },
								{ id: "ds-2", side: "new", newLine: 83, kind: "add", text: "  cardId: string;" },
								{ id: "ds-3", side: "new", newLine: 84, kind: "add", text: "  value: \"liked\" | \"disliked\";" },
								{ id: "ds-4", side: "new", newLine: 85, kind: "add", text: "  commentIds: string[];" },
								{ id: "ds-5", side: "new", newLine: 86, kind: "add", text: "}" },
							],
						},
					],
				},
			],
			suggestedComments: [
				{
					id: "suggest-comment-anchor",
					cardId: "significant-comments",
					diffBlockId: "comment-state",
					lineId: "cs-3",
					body: "Anchoring by block and line ID avoids ambiguity when the same line number appears in multiple diff blocks.",
				},
			],
		},
		{
			id: "other-omissions",
			phaseId: "other",
			title: "MVP omissions are explicit",
			summary: "Keeps card synthesis fixture-driven and leaves provider launch, persistence, and GitHub submission as app-level or future adapter work.",
			rationale: "A production-quality component can be integrated incrementally without leaking fixture assumptions into the app shell.",
			checklist: ["No GitHub API calls in the component", "Fixture shape matches public model", "Audit remains copy-only"],
			cardSuggestions: ["Fixture cards are acceptable for MVP, but the model should stay ready for generated logical cards."],
			diffBlocks: [
				{
					id: "fixture-source",
					filePath: "src/ui/components/pr-walkthrough/fixtures.ts",
					hunks: [
						{
							id: "fixture-source-h1",
							header: "@@ -0,0 +1,9 @@",
							lines: [
								{ id: "fs-1", side: "new", newLine: 1, kind: "add", text: "export function getFixturePrWalkthroughCards(): PrWalkthroughCard[] {" },
								{ id: "fs-2", side: "new", newLine: 2, kind: "add", text: "  return [orientationCard, designCard, significantCard, otherCard, auditCard];" },
								{ id: "fs-3", side: "new", newLine: 3, kind: "add", text: "}" },
							],
						},
					],
				},
			],
		},
		{
			id: "audit-draft",
			phaseId: "audit",
			title: "Draft review",
			summary: "Summarises accepted cards, concerns, and queued comments into a copyable draft for the human reviewer.",
			rationale: "The MVP never submits externally; it only prepares review state for a later adapter.",
			checklist: ["Liked cards are grouped", "Disliked cards include comment IDs", "Line comments are grouped by file and line"],
			diffBlocks: [],
		},
	];
}
