# PR Walkthrough Panel

The PR walkthrough panel is Bobbit's guided review surface for pull requests and local changesets. It opens in the side panel beside chat, not as embedded chat cards, so the transcript stays available for questions while the review UI owns navigation, comments, and the draft review state.

The panel is intentionally changeset-oriented rather than GitHub-specific. The MVP renders fixture-generated logical cards, but the core component only needs a changeset reference, cards, diffs, comments, and decisions. GitHub lookup and export belong in adapters around that model.

## Launch paths

Users can open the walkthrough from two places:

- **Slash command** — type `/walkthrough-pr <url|number>` in chat.
  - URLs become external PR changesets.
  - Numbers, with or without `#`, become PR-number changesets.
  - Empty invocations fall back to the fixture changeset.
- **Git Status Widget** — click **Walkthrough** on the git status widget. The widget emits branch, PR, and summary metadata, and the app opens or focuses the matching walkthrough side-panel tab.

Both paths create a side-panel tab with a canonical `walkthrough:<changeset-id>` id. Reopening the same changeset focuses and updates that tab instead of duplicating it.

## Review flow

The walkthrough is organised into five phases:

1. **Orientation** — establishes scope and review framing.
2. **Key design choices** — explains the main design decisions the reviewer should understand before scanning code.
3. **Significant changes** — walks through the most important implementation details and diffs.
4. **Other + omissions** — calls out smaller changes, known MVP omissions, and follow-up boundaries.
5. **Audit** — assembles the accumulated decisions and comments into a copyable draft review.

Each non-audit phase contains one or more logical cards. A card is an LLM-synthesised review unit: title, summary, optional rationale/checklist, optional suggested comments, and one or more diff blocks. A single logical card can span multiple files or diff blocks when that better matches the reviewer story.

## Navigation rail

The rail adapts to the available side-panel width:

- **Wide layout** shows labelled phase sections and card buttons. Phase buttons jump to the first card in that phase; card buttons jump directly to the card.
- **Narrow layout** collapses to a thin rail. Phase pips remain clickable, and each card is represented by a clickable dot with an accessible label and tooltip. Completed cards show decision glyphs.

This keeps the same review model usable in both the half-width Bobbit side panel and wider review surfaces.

## Diff behaviour

Diffs render from the same card/block/hunk model in two modes:

- **Split** — side-by-side old/new columns. This is the default in wide layouts.
- **Inline** — a single column. This is the default in narrow layouts.

The user can toggle either mode at any width. Split diffs wrap both sides in one shared horizontal overflow container, so each diff widget has one horizontal scrollbar instead of competing scrollbars per column.

## Comments and decisions

Review state is built from comments plus per-card decisions.

### Line comments

Diff lines are interactive. Hovering or clicking a line reveals the comment affordance; keyboard users can open it from the focused line. Line comments are anchored by card id, diff block id, and logical line id, with file and line information resolved later for the audit draft.

LLM-suggested line comments can appear beside matching lines. The reviewer can:

- accept the suggestion as a queued line comment;
- accept and edit it;
- delete/dismiss it.

Suggested comments become normal queued comments after acceptance and can then be edited or deleted.

### Card comments

Every card also has a card-level comment area for broad concerns that do not belong on a specific line. This is always available, even when the card has no useful line anchor.

### Like, Dislike, and Prev

- **Like** is always enabled, uses primary button styling, records a liked decision, and advances to the next card.
- **Dislike** is disabled until the active card has at least one non-empty line or card comment. When enabled, it stays visually neutral at rest and uses the negative theme colour on hover/focus. Clicking it records a disliked decision with supporting comment ids and advances.
- **Prev** moves back to the previous card so the reviewer can revise comments or change the decision.

If the last supporting comment for a disliked card is deleted, the component clears the invalid disliked decision and removes that card from the completed set. This keeps the audit draft from containing unsupported change requests.

## Audit draft

The Audit phase renders a copyable draft review assembled from current state:

- changeset title and base/head metadata;
- liked cards under approved context;
- disliked cards and their supporting comments under concerns;
- queued line comments grouped with file/line anchors;
- broad card-level comments.

The MVP is copy-only. It does not submit to GitHub or another provider. A future export adapter should consume the same draft state and translate it into provider-specific review comments or final review actions.

## Persistence and tab isolation

The panel persists interaction state by walkthrough tab id using a browser-storage key derived from `bobbit:pr-walkthrough:<tab-id>`. Persisted state includes:

- active card;
- diff mode override;
- comments;
- decisions;
- completed card ids;
- dismissed suggestion ids.

Because the persistence key is the side-panel tab id, each walkthrough tab is isolated. Opening `/walkthrough-pr 123` and `/walkthrough-pr 456` creates independent state; comments, decisions, active card, and Dislike enablement do not leak between tabs. Reloading the app restores the active walkthrough tab and its persisted audit state.

## MVP adapter boundary

The production slice is fixture-driven. `PrWalkthroughPanel` receives `changeset`, `cards`, and `persistenceKey` and does not call GitHub APIs. App-level launch code maps slash-command or Git Status Widget input into a changeset ref and side-panel tab. Fixture cards then stand in for future card synthesis.

Keep future work on the same boundary:

- **Core model** — changeset ref, logical cards, diff blocks, suggested comments, reviewer comments, decisions, and draft review.
- **Generation adapter** — turns two SHAs or provider metadata into logical cards.
- **Provider adapter** — resolves GitHub PR metadata and exports final comments/review actions.

This separation keeps local SHA walkthroughs first-class and avoids coupling the review UI to GitHub before the core interaction model is stable.

## Testing notes

Browser coverage lives in `tests/e2e/ui/pr-walkthrough-panel.spec.ts`. The suite verifies the user-facing contract:

- slash-command launch opens a side-panel walkthrough tab, not chat cards;
- wide layout shows the labelled rail and defaults to split diff mode;
- narrow layout shows clickable card-dot navigation and defaults to inline diff mode;
- the diff mode toggle can switch back to split and keeps one horizontal scrollbar per diff;
- line comments can be created, edited, and deleted;
- Dislike is gated by comments and invalid disliked decisions are cleared when comments are removed;
- Prev supports decision revision;
- Audit draft reflects liked cards, disliked concerns, and queued comments;
- reload restores persisted state;
- separate walkthrough tabs keep state isolated;
- fixture suggested comments can be accepted, edited, and deleted.

Use this test as the pinning contract when changing panel behaviour or replacing fixture generation with real changeset synthesis.
