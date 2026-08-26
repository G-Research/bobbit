# Chat transcript navigation

The chat surface provides floating controls for two related jobs: staying oriented in a long, streaming transcript and returning to live output. The top-centre segmented control navigates prompts, unresolved questions, and searchable transcript history. The bottom-centre control moves toward the transcript tail.

The controls are projections of the active transcript and current viewport. They do not create a second history store or persist a navigation cursor.

## Controls

| Control | Appears when | Action |
|---|---|---|
| **Previous prompt** | the segmented control is visible; enabled only when a user prompt is fully above the viewport | springs to the nearest user prompt above the viewport |
| **Unanswered question** | at least one unresolved `ask_user_choices` call exists | springs to the nearest unresolved question fully above the viewport, or the newest unresolved question when none is above |
| **Jump to…** | the segmented control is visible | opens the searchable transcript-history dialog beneath the control |
| **Next prompt** | a user prompt is fully below the viewport | springs to the nearest user prompt below the viewport |
| **Bottom** / **Jump to bottom** | a user prompt is below the viewport, or the viewport is more than half a screen from the tail | springs to the tail and re-engages follow-tail |

The segmented control is visible when a user prompt is above the viewport, an unanswered question exists, or its history dialog is open. This preserves the original prompt-navigation visibility while ensuring a question remains discoverable if later streaming output pushes it away. When an unanswered question is the only reason the control is visible, **Previous prompt** remains present but disabled rather than becoming a dead action.

On narrow layouts, the top control retains its icons, chevron, and unresolved count while moving visible text to screen-reader-only labels. Its top offset includes the fixed mobile header. The history dialog uses viewport gutters and is height-limited to the space above the composer, which is remeasured when the viewport, message area, composer, or navigation anchor changes.

## Geometry and scrolling

Prompt navigation is stateless. On every scroll, resize, and committed transcript update, `AgentInterface` classifies rendered `<user-message>` elements against the scroll container:

- `rect.bottom < viewport.top` means a prompt is above the viewport;
- `rect.top > viewport.bottom` means a prompt is below the viewport;
- otherwise the prompt intersects the viewport.

**Previous prompt** selects the last prompt above the viewport. **Next prompt** selects the first prompt below it. There is no saved prompt index, depth, or last/previous label transition; live geometry is authoritative so content growth and reflow cannot stale a cursor.

All explicit transcript jumps use the shared fixed-target spring in `AgentInterface`; they do not call native `scrollIntoView()`. The target lands below the top navigation offset, including the fixed mobile header when present. Jump-to-bottom uses the same spring but re-reads the tail on each animation frame so new output can move the goalpost. A new explicit jump cancels the current spring.

A history or unanswered jump releases follow-tail before resolving or measuring its target by setting the existing scroll-intent flags to escaped. This prevents deferred materialization or subsequent streaming growth from pulling the reader back to live output. **Bottom** clears that escape and re-pins follow-tail. See [Internals — Chat scroll lock invariant](internals.md#chat-scroll-lock-invariant) for the underlying intent and resize lifecycle.

History selections receive a brief `--ring` outline after landing. Reduced-motion mode skips the spring and highlight animation while preserving the final position and static focus outline.

## Transcript-history projection

`deriveTranscriptNavigation` in the transcript-history UI module builds a client-only projection from `session.state.messages`, the authoritative ordered transcript. It makes one pass in array order and never sorts by timestamp. This matters because reducer order, not clocks, defines what the user saw.

The projection includes:

- human prompts as **User** entries;
- primary-assistant output and trusted agent-authored prompts as **Agents** entries;
- trusted system-authored prompts plus relevant notifications, mutation summaries, errors, compaction, and context-clear events as **System** entries;
- one **Questions** entry for each valid `ask_user_choices` tool call, even after it is answered or fails.

Authorship comes from validated `MessageAuthor.kind`, not the raw Pi role. This keeps agent-authored user-shaped handoffs out of the **User** filter and preserves system attribution. Ordinary tool calls, tool results, artifacts, and ask response envelopes are relationship data rather than navigable entries and are omitted. Mixed user rows still contribute visible text after their tool-result blocks are reconciled.

Excerpts collapse whitespace and are bounded for a compact list. Assistant text separated by a question or relevant system tool remains in content order as separate entries. The projection covers only the loaded active transcript. It does not merge unopened pre-compaction or cleared sidecars because those slices have no ordered boundary in `state.messages`.

### Stable targets and deferred rows

History entries and rendered rows share the same target identity helpers:

1. prefer a durable message id;
2. otherwise combine reducer origin, order, insertion tick, and authoritative transcript ordinal;
3. prefix the result as a message target.

`AgentInterface` supplies authoritative ordinals because relationship-only rows are filtered before `MessageList` renders. Rendered message roots and any owning `<deferred-block>` receive the same `data-transcript-target` value.

Selecting a history row resolves only the deferred block that owns that target. Direct unanswered navigation resolves the unresolved candidate rows before comparing their live geometry, but it does not resolve unrelated history. After resolution, the code re-queries the real row and measures its current rectangle; placeholder estimates are never used as the final spring target.

## Search and filters

**Jump to…** opens a non-modal dialog below the segmented control. Entries remain oldest-to-newest, and the list opens at the newest matching entry. The available filters are **All**, **User**, **System**, **Agents**, and **Questions**. Filter chips wrap within the dialog at narrow widths, and the active chip uses a distinct bordered tint without adding a separate ordering footer. The dialog shares the Git status dropdown's card surface, compact spacing, border, radius, shadow, and typography. Each result uses trusted prompt-author metadata to reuse the main chat's Bobbit agent avatar or **U** author initial. Both surfaces use the same compact settings avatar for system-authored messages instead of an ambiguous **S**, and the history type reads **System Message** rather than **System prompt**. Entries without author metadata fall back to a kind-specific icon.

Search is case-insensitive and whitespace-normalized across author label, type label, and excerpt. Search and the selected filter compose; no matches produces **No matching prompts**. Changing either search or filter scrolls the result list to its newest match.

While the dialog is open, committed transcript additions update the projection. The list follows those additions only if the reader was already at the filtered tail; otherwise the current reading position is preserved. Cumulative `message_update` token frames update only the streaming container and are not indexed independently. A completed message, tool result, or answer envelope arrives through the committed-message path and refreshes navigation immediately, even if a later assistant message is still streaming.

No global command or keyboard shortcut is registered for transcript history. Standard control behavior remains available: Tab navigation, Enter/Space activation, Escape dismissal, and capture-phase outside-pointer dismissal.

## Unanswered-question lifecycle

Question state is derived from the ask tool call and later transcript evidence. The shared ask classifier is used by both the widget renderer and transcript navigation so their definitions cannot drift.

An ask is unresolved when it has valid parameters and:

- no valid later matching response envelope or legacy result answers exist; and
- no terminal failure result exists.

This includes a call with no result yet and a successful `{ "status": "posted" }` result waiting for the user's response. A valid later `[ask_user_choices_response ...]` envelope or legacy blocking-tool answers mark it **Answered**. **Dismiss All** durably marks the whole ask card **Dismissed** without waking the agent. An explicit error result, or a completed non-posted result without valid legacy answers, marks it failed. Answered, dismissed, and failed questions remain searchable under **Questions** with their status shown, but they leave the unresolved count and remove the direct **Unanswered question** segment when the count reaches zero.

Only later, matching evidence applies. A malformed envelope, an envelope for another tool-use id, or an envelope that precedes the call does not resolve the question. The response envelope remains in the authoritative transcript for model conversion even though the visible message list and history projection hide the relationship-only row.

When several asks are unresolved, direct navigation chooses the candidate with the greatest bottom edge that is still fully above the viewport. If none is fully above, it chooses the newest unresolved entry by transcript ordinal. This makes repeated use predictable while prioritizing a question the user has already scrolled past.

## Dialog and focus lifecycle

The history component owns only ephemeral query, filter, and dialog UI state. `AgentInterface` owns the open bit, authoritative entries, available height, and target-selection callback; the component does not subscribe to the session.

On open, the dialog resets to **All**, clears the query, focuses its labelled search field, and scrolls to the newest match. Escape, an outside pointer, selecting a row, session change, or disconnect closes it. Focus returns to the **Jump to…** trigger after dismissal or selection. The trigger exposes `aria-haspopup="dialog"`, `aria-expanded`, and `aria-controls`; the segmented shell is a labelled group, filters expose `aria-pressed`, and completed jumps are announced through a polite live region.

Hidden navigation shells are inert, excluded from the accessibility tree, and removed from the tab order during their fade. The unresolved badge is decorative because the button's accessible label includes the count.

## Implementation ownership

- The transcript-history UI module owns pure entry derivation, filtering, stable target identity, and unanswered target selection.
- The shared ask-state module owns pending, posted, answered, legacy-answer, and failure classification; durable session metadata owns dismissals.
- `TranscriptHistoryPopover` owns search/filter rendering and accessible open/dismiss/focus behavior.
- `MessageList` stamps target identities and performs targeted deferred resolution.
- `AgentInterface` owns viewport geometry, segmented-control visibility, history open state, follow-tail release, spring scrolling, highlighting, and live announcements.
- The message reducer remains the sole owner of authoritative transcript order. Transcript navigation must not introduce a persisted or independently subscribed history cache.

## Regression coverage

- [`tests/unit/core/transcript-history.unit.test.ts`](../tests/unit/core/transcript-history.unit.test.ts) pins strict transcript chronology, trusted author/type classification, mixed rows, bounded excerpts, stable identity, valid and malformed asks, answered/dismissed/failed status, composed search/filter behavior, and nearest-above/newest unanswered selection.
- [`tests/dom/transcript-history-popover.dom.test.ts`](../tests/dom/transcript-history-popover.dom.test.ts) pins dialog semantics, focus, open-to-newest behavior, filters plus search, empty state, live-tail preservation, selection, outside dismissal, and Escape dismissal.
- [`tests/dom/transcript-navigation-integration.dom.test.ts`](../tests/dom/transcript-navigation-integration.dom.test.ts) pins committed updates during streaming, immediate envelope-driven resolution, hidden-shell accessibility, targeted deferred materialization, real-geometry unanswered selection, follow-tail release, highlighting, and live announcements.
- [`tests/browser/journeys/transcript-history-navigation.journey.spec.ts`](../tests/browser/journeys/transcript-history-navigation.journey.spec.ts) exercises the real segmented controls, chronology, search/filter/empty state, jumping, focus restoration, answered and durably dismissed status, the sidebar question-circle unread indicator, reload derivation, responsive bounds, and cleanup.
- The existing chat-scroll fixture and broader tail-chat coverage continue to pin prompt geometry, spring landing, mobile header offset, streaming growth, and return-to-tail behavior.

When changing this feature, run the focused core and DOM files first, then the browser journey. Run `npm run check` and `npm run test:unit` before completion; broader browser and end-to-end gates remain the regression authority for shared scroll behavior.
