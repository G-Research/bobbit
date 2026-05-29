# PR walkthrough panel — MVP handoff

## Purpose

Build a preview-pane PR walkthrough UI that guides a human reviewer through a changeset with LLM assistance. The reviewer should feel like they are being walked through a PR by a senior engineer: first context, then architectural choices, then major changes, then omissions/other changes, then a remaining-lines audit.

The latest prototype was iterated in Bobbit preview during session [`0c159c64-f8cb-4b19-b395-d60db8de5061`](https://bobbit.dedyn.io:5173/session/0c159c64-f8cb-4b19-b395-d60db8de5061), using real inspiration from Bobbit PR #637, `Shrink Initial Bundle`.

The captured interactive HTML prototype is checked in at [`docs/design/pr-walkthrough-panel-prototype.html`](./pr-walkthrough-panel-prototype.html). **Treat that prototype as the target UX for the production implementation.** This markdown document is the supporting design narrative; if it conflicts with the prototype's visual hierarchy, density, navigation behaviour, or interaction details, the prototype wins unless the deviation is explicitly called out and accepted.

Production should be recognisably the same experience as the prototype, not merely a generic implementation of the same data model. Match the prototype's overall composition, header treatment, rail density, card hierarchy, diff presentation, comment affordances, and review controls as closely as Bobbit's shared app chrome/theme allow.

## Core experience

The walkthrough appears inside Bobbit's existing preview/side-panel surface, not inside the chat transcript.

Because the prototype was created in Bobbit preview and is the target UX, the production panel must support preview-pane ergonomics:

- it can be used in the normal side-panel beside chat;
- it can be full-screened from the side-panel toolbar like HTML preview panes;
- it can be opened in a new browser tab for wide review sessions.

The outer Bobbit chat remains available for asking the agent questions. The walkthrough panel itself does not need an Ask button or prompt composer.

Each walkthrough consists of phases:

0. **Orientation** — why the PR was raised, business value, need-to-know context.
1. **Key design choices** — architectural/design decisions made by the PR.
2. **Significant changes** — major, controversial, or review-worthy changes.
3. **Other changes + omissions** — secondary changes and missing expected artefacts such as tests/docs/migrations.
4. **Audit** — remaining plumbing/shrapnel. Items expand inline into normal diff blocks and can be commented on.

Cards are LLM-synthesised logical change sets, not raw files/hunks. A card may contain multiple code blocks.

## Layout

- Header:
  - PR number/title, matching the prototype's prominent review-header treatment.
  - GitHub/GitStatus-style stats: `50 files`, green `+4,650`, red `-2,353`.
  - A GitHub/PR link affordance that behaves like the PR pill on the goal dashboard: when the walkthrough was launched from or can infer a GitHub PR, expose the PR number/title as an external link to GitHub.
  - Review progress.
  - Submit review button.
- Left rail:
  - Full-width mode: phase list with card substeps.
  - Narrow/half-width preview mode: very thin rail, ~38px, showing phase pips plus clickable card-dot substeps beneath each phase.
  - Text appears in native tooltips in collapsed mode.
- Main workspace:
  - Phase/card title and short narrative summary.
  - One or more diff blocks.
  - Card-level suggested concerns.
  - Prev / Dislike / Like controls.

## Diff display

- Full-width mode defaults to side-by-side diffs.
- Narrow/half-width mode defaults to inline diffs, but must not force it; the user can still choose side-by-side.
- There should be at most one horizontal scrollbar per diff widget. The scrollbar should move the whole code snippet and both sides together, not appear per overflowing line.
- Diff blocks can be independently expanded/collapsed.
- Multiple code blocks per card are allowed and expected.

## Inline comments

- Hovering or clicking a diff line exposes a `+` affordance.
- Clicking a line opens an inline editor below that line.
- LLM-suggested comments should be line-anchored when possible.
- The user must always be able to write their own comment if the suggestions are not right.
- Saved comments show inline below the line and mark the line/file/card in the UI.
- Card-level comments are separate from line-level comments and support LLM-suggested broad concerns plus `Write your own`.

## Review controls

- **Like**:
  - Primary app button style: `var(--primary)` / `var(--primary-foreground)`.
  - Advances to the next card.
  - If comments exist, label can read `Like anyway` to clarify that notes are being retained while the card is accepted.
- **Dislike**:
  - Disabled until at least one line-level or card-level comment exists.
  - At rest, should look like Bobbit's other danger/terminate buttons: neutral/ghost.
  - It should only become red/destructive on hover/focus.
  - Advances to the next card and marks the card as requiring changes/comment attention.
- **Prev**:
  - Neutral ghost button.
  - Allows backtracking and updating prior answers.

## State model sketch

```ts
type WalkthroughPhaseId = 0 | 1 | 2 | 3 | 4;

type WalkthroughCard = {
  id: string;
  phase: WalkthroughPhaseId;
  title: string;
  narrative: string;
  blocks: DiffBlockRef[];
  lineSuggestions?: Record<string, string[]>; // `${path}:${line}` -> suggested comments
  cardSuggestions?: string[];
  omissionRationale?: string;
};

type DiffBlockRef = {
  path: string;
  label: string;
  role: 'primary' | 'related' | 'audit' | 'new-file';
  diff: UnifiedDiffSubset;
};

type CardReviewState = {
  status: 'pending' | 'liked' | 'disliked';
  lineComments: Array<{
    path: string;
    line: number;
    body: string;
  }>;
  cardComment?: string;
};
```

## Changeset model

V1 should review any two SHAs, defaulting to PR base..head when launched from a PR. Avoid coupling core logic to GitHub-specific concepts. GitHub/GitLab/etc. should be adapters for fetching PR metadata and exporting final review comments.

Launch points proposed:

1. Button in the Git Status Widget.
2. Popover/action on GitHub PR links in chat history.
3. `/walkthrough-pr <url|number>` skill.

## LLM responsibilities

- Build orientation summary.
- Group raw diff into logical cards.
- Classify cards into phases.
- Choose primary and related diff blocks per card.
- Suggest line-level comments where concerns are directly anchorable.
- Suggest card-level comments for broader concerns.
- Detect omissions using a two-pass approach:
  1. Expected artefacts pass — tests, docs, migrations, feature flags, telemetry, error paths, etc.
  2. Verification pass — search diff and repo HEAD before flagging as absent.
- Build phase 4 audit summary from remaining/unreviewed lines.

## MVP constraints

- The checked-in prototype is the target UX. Fixture data is acceptable, but the production slice must still look and behave substantially like the prototype.
- Server-side generation can come later; first production slice can use mocked/fixture card data if needed to validate UI.
- The UI should live as a first-class preview/side-panel surface, not as cards embedded in chat messages.
- It must be usable at half-width alongside chat.
- It must support inline comments before external review export exists.
- The final output should be an internal draft review model first; GitHub export can be an adapter.

## Prototype notes from session

Final prototype decisions:

- The prototype is the normative UX target for this feature. Implementation review should compare against `pr-walkthrough-panel-prototype.html`, not only against this prose checklist.
- Removed internal prompt/composer because outer Bobbit chat owns questions.
- Collapsed rail uses visible phase pips plus clickable card-dot substeps.
- Full width defaults side-by-side; narrow defaults inline, but user may choose side-by-side.
- Side-by-side diff overflow uses a single widget-level horizontal scrollbar.
- Like uses primary button styling.
- Dislike is neutral at rest and red on hover/focus.
- The prototype used realistic PR #637 content:
  - lazy wrappers around `@earendil-works/pi-ai`, qrcode, JSZip, highlight.js.
  - `PLACEHOLDER_DEFAULT_MODEL` in `remote-agent.ts`.
  - type-only `ui/index.ts` re-exports.
  - `manualChunks` in `vite.config.ts`.
  - tightened `tests/bundle-size.test.ts` budgets.
  - omission: no user-flow E2E for first lazy-load activation.
  - audit warning examples: `vite.profile.config.ts`, `pill-overflow-promotion.spec.ts` timeout bump.
