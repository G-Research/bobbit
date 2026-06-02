import type { PrWalkthroughCard, PrWalkthroughCardSection, PrWalkthroughChangesetRef } from "./types.js";

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
			checklist: ["No GitHub API calls in the component", "Fixture shape matches public model", "Audit runs as a normal review card"],
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
			title: "Remaining-lines audit and draft review",
			summary: "Audits plumbing and omission-prone lines that were not central enough for earlier logical cards, then keeps the copyable final review draft visible below the normal diff workflow.",
			rationale: "Audit is still reviewable: remaining lines expand into normal diff blocks, accept line/card comments, and feed the draft review before any external submission exists.",
			checklist: ["Remaining lines are reviewed as a normal card", "Line and card comments update the draft", "Final draft stays copyable"],
			cardSuggestions: ["Double-check audit shrapnel for fixture assumptions before this becomes generated from real unreviewed diff lines."],
			diffBlocks: [
				{
					id: "audit-remaining-lines",
					filePath: "src/app/pr-walkthrough.ts",
					hunks: [
						{
							id: "audit-remaining-lines-h1",
							header: "@@ -88,8 +96,15 @@ export function openPrWalkthroughPanel",
							lines: [
								{ id: "ar-1", side: "context", oldLine: 88, newLine: 96, kind: "context", text: "const changeset = changesetRefForWalkthrough(input);" },
								{ id: "ar-2", side: "old", oldLine: 89, kind: "del", text: "const tabId = walkthroughPanelTabId(`${changeset.baseSha}..${changeset.headSha}`);" },
								{ id: "ar-3", side: "new", newLine: 97, kind: "add", text: "const changesetId = changesetIdForInput(input, changeset.baseSha, changeset.headSha);" },
								{ id: "ar-4", side: "new", newLine: 98, kind: "add", text: "const tabId = walkthroughPanelTabId(changesetId);" },
								{ id: "ar-5", side: "context", oldLine: 90, newLine: 99, kind: "context", text: "const title = changeset.title || titleForInput(input);" },
							],
						},
					],
				},
			],
			suggestedComments: [
				{
					id: "suggest-audit-tab-id",
					cardId: "audit-draft",
					diffBlockId: "audit-remaining-lines",
					lineId: "ar-3",
					body: "Audit generated changeset IDs against URL and PR-number launches so review state does not collide between walkthrough tabs.",
				},
			],
		},
	];
}

const guidedOrientationSections: PrWalkthroughCardSection[] = [
	{
		id: "at-a-glance",
		navLabel: "At a glance",
		heading: "A net-deletion UI fix",
		verdict: { recommendation: "approve", confidence: "medium", summary: "Shares the preview panel resize path." },
		body: "The in-app walkthrough panel now resizes exactly like the HTML preview panel — one shared code path instead of two.",
		showStats: true,
	},
	{
		id: "why-it-exists",
		navLabel: "Why it exists",
		eyebrow: "The problem",
		heading: "Why it exists",
		body: "The in-app walkthrough side-panel's resize controls were dead. The previous attempt patched the standalone pop-out route, where the controls are meaningless.",
	},
	{
		id: "what-it-changes",
		navLabel: "What it changes",
		eyebrow: "The change",
		heading: "What it actually does",
		body: "Deletes walkthrough-specific fullscreen special-casing so the panel shares the preview panel's rules and the standalone route reverts to chromeless.",
	},
	{
		id: "should-merge",
		navLabel: "Should we merge",
		eyebrow: "The decision",
		heading: "Should it be merged?",
		body: "Yes — approve, medium confidence. Two resize code paths collapse into one, backed by a reproducing E2E that fails before and passes after.",
	},
	{
		id: "what-to-watch",
		navLabel: "What to watch",
		heading: "What to scrutinise",
		concerns: [
			{ severity: "non_blocking", text: "A live walkthrough child can now be fullscreened, which hides the chat prompt. Confirm that is acceptable." },
			{ severity: "question", text: "All coverage is E2E. Confirm CI runs the browser specs for UI-only PRs." },
			{ severity: "nit", text: "A fullscreenState helper is duplicated across the spec files." },
		],
	},
	{
		id: "where-to-look",
		navLabel: "Where to look",
		heading: "Where to look",
		body: "Start in render.ts, then pr-walkthrough.ts, then the specs.",
		fileRoles: [
			{ role: "core", file: "src/app/render.ts", note: "fullscreen branch + standalone panel rendering" },
			{ role: "core", file: "src/app/pr-walkthrough.ts", note: "job upsert / patch ready handling" },
			{ role: "support", file: "src/app/main.ts", note: "keyboard-shortcut detection" },
			{ role: "verify", file: "tests/e2e/ui/pr-walkthrough-*.spec.ts", note: "new + inverted tests" },
		],
		showOriginalDescription: true,
	},
];

/**
 * Fixture cards where the orientation card uses the guided step-through `sections`
 * model, plus follow-on cards with long titles and explicit short `navLabel`s.
 * Used to exercise the orientation stepper and rail-circle navigation in tests.
 */
export function getGuidedOrientationFixtureCards(): PrWalkthroughCard[] {
	return [
		{
			id: "orientation-scope",
			phaseId: "orientation",
			title: "Fix in-app PR walkthrough panel resize controls",
			navLabel: "Orientation",
			summary: "Shares the preview panel resize path so the walkthrough panel stops special-casing fullscreen.",
			sections: guidedOrientationSections,
			diffBlocks: [],
		},
		{
			id: "design-resize",
			phaseId: "design",
			title: "render.ts: fullscreen predicate and standalone panel simplification",
			navLabel: "Resize logic",
			summary: "Reuses the preview panel's resize logic instead of walkthrough-specific fullscreen handling.",
			diffBlocks: [
				{
					id: "design-resize-block",
					filePath: "src/app/render.ts",
					hunks: [
						{
							id: "design-resize-h1",
							header: "@@ -100,6 +100,8 @@ function prWalkthroughPanel()",
							lines: [
								{ id: "dz-1", side: "context", oldLine: 100, newLine: 100, kind: "context", text: "const status = tab.state.status;" },
								{ id: "dz-2", side: "new", newLine: 101, kind: "add", text: "const fullscreen = previewPanelFullscreen(state);" },
							],
						},
					],
				},
			],
		},
		{
			id: "significant-ready",
			phaseId: "significant",
			title: "pr-walkthrough.ts: job upsert and ready handling",
			navLabel: "Ready handling",
			summary: "Patches job upsert so the ready payload hydrates the panel without resetting fullscreen.",
			diffBlocks: [
				{
					id: "significant-ready-block",
					filePath: "src/app/pr-walkthrough.ts",
					hunks: [
						{
							id: "significant-ready-h1",
							header: "@@ -120,6 +120,9 @@ export function upsertWalkthroughJob()",
							lines: [
								{ id: "sr-1", side: "context", oldLine: 120, newLine: 120, kind: "context", text: "const existing = jobs.get(jobId);" },
								{ id: "sr-2", side: "new", newLine: 121, kind: "add", text: "if (existing?.status === \"ready\") return mergeReady(existing, patch);" },
							],
						},
					],
				},
			],
		},
		{
			id: "audit-checklist",
			phaseId: "audit",
			title: "E2E: reproducing test and audit review checklist",
			navLabel: "Audit checklist",
			summary: "Remaining lines and the reproducing E2E feed the final review draft.",
			diffBlocks: [
				{
					id: "audit-checklist-block",
					filePath: "tests/e2e/ui/pr-walkthrough-real.spec.ts",
					hunks: [
						{
							id: "audit-checklist-h1",
							header: "@@ -10,0 +11,4 @@",
							lines: [
								{ id: "ac-1", side: "new", newLine: 11, kind: "add", text: "test(\"resize controls are user-initiated\", async ({ page }) => {" },
							],
						},
					],
				},
			],
		},
	];
}
