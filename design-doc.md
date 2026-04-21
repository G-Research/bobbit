# Design Doc — Ask widget keyboard navigation + label polish

Translates the goal spec into a concrete implementation plan. No code here — just
shapes, formats, and test surface.

## 1. Files to modify

### Tool schema
- `defaults/tools/ask/ask_user_choices.yaml` — update `description`, `promptSnippet`,
  `docs`, and `detail_docs` so the agent is told to supply `tab_label` on every
  question when `questions.length > 1`. Add a short "Tab labels" section + an
  example with `tab_label` populated.
- `defaults/tools/ask/extension.ts` — extend the TypeBox `Type.Object({...})` for
  each question with `tab_label: Type.Optional(Type.String({ minLength: 1, maxLength: 24 }))`.
  It stays optional at the JSON-schema layer (single-question asks don't need it);
  server-side validation enforces "required when questions.length > 1".

### Server validation
- `src/server/agent/ask-user-choices-validation.ts`
  - Extend `UserQuestion` interface with `tab_label?: string`.
  - In `validateQuestions()`: if `questions.length > 1`, require every `q.tab_label`
    to be a non-empty string ≤ 24 chars; reject with a clear error string
    (`questions[i].tab_label is required for multi-question asks (got <value>)`).
    Also validate that when present (even in single-question asks) it is a
    string ≤ 24 chars — so bad input is always rejected.
  - `crossValidate()` does not need changes (answers don't carry `tab_label`).
- `src/server/server.ts` (~ line 6276) — no behavioural change needed here;
  `validateQuestions` is already invoked upstream of the tool_use broadcast via
  the normal tool parameter pipeline. Confirm during implementation whether
  `validateQuestions` is called on the tool_use input before broadcasting the
  widget — if not, add a call at the point that builds `matchedQuestions` so
  malformed asks surface an error to the agent instead of rendering a broken
  widget. (See Open Questions #1.)

### Widget
- `src/ui/components/AskUserChoicesWidget.ts`
  - Extend `AskQuestion` interface with `tab_label?: string`.
  - Tab rendering: replace `${idx + 1}. ${q.question.slice(0,40)}` with
    `${letter(idx)}. ${q.tab_label}` (letter = `String.fromCharCode(65 + idx)`).
    Only shown when `questions.length > 1` (tabs already hidden otherwise).
  - Option rendering: prefix every option card's visible text with a numbered
    badge (`1.`, `2.`, …) via a dedicated `<span class="ask-option-index">`
    before `.ask-option-text`. "Other" uses `options.length + 1`.
  - Primary button: compute `isLast = this._activeTab === this.questions.length - 1`
    in `render()`.
    - Multi-question + not last → render **Next** button in place of Submit.
      Disabled until the active question's draft entry is valid (re-use the
      per-question validity predicate extracted from `_canSubmit()`).
    - Multi-question + last → render **Submit** (existing behaviour), disabled
      until all questions valid.
    - Single-question → unchanged (`_shouldHideSubmit()` already handles this).
  - Add a keydown listener on the `.ask-widget` root (`@keydown=${this._onKey}`).
  - New state: `@state() private _focusedOption = 0` — index of focused option
    card within the active question (0 = first real option, `q.options.length`
    = "Other" when `allow_other`). Reset to 0 on tab change. Applied as a
    roving `tabindex="0"` on the focused card, `-1` on others.
  - Tabs get roving tabindex too: the active tab button has `tabindex="0"`,
    others `tabindex="-1"`. ArrowLeft/ArrowRight on a focused tab button moves
    tab focus and activates the new tab (ARIA tablist with automatic activation).

### Fixture (plain-JS mirror)
- `tests/ask-user-choices-widget.html` — mirror all rendering changes (numbered
  tabs, numbered options, Next vs. Submit, roving tabindex, keydown handler,
  Escape/number/letter shortcuts). Every multi-question fixture call must pass
  `tab_label` so it matches the real widget's expected input.

### Unit tests
- `tests/ask-user-choices-widget.spec.ts` — update existing multi-question
  fixtures to include `tab_label`; add new tests (see Test plan §6).

### Browser E2E
- `tests/e2e/ui/ask-user-choices-ui.spec.ts` — add one keyboard-only
  multi-question flow; update any existing multi-question scenarios to include
  `tab_label`.

### Mock agent
- `tests/e2e/mock-agent-core.mjs` — all multi-question mock ask emissions now
  include `tab_label` on each question.

## 2. Data model

```ts
// src/ui/components/AskUserChoicesWidget.ts
export interface AskQuestion {
  question: string;
  options: string[];
  tab_label?: string;       // NEW — required when questions.length > 1
  allow_other?: boolean;
  multi?: boolean;
  min?: number;
  max?: number;
}

// src/server/agent/ask-user-choices-validation.ts
export interface UserQuestion {
  question: string;
  options: string[];
  tab_label?: string;       // NEW — same semantics
  allow_other?: boolean;
  multi?: boolean;
  min?: number;
  max?: number;
}
```

Validation rule (server):
- `typeof tab_label === "string"` when present.
- `tab_label.trim().length >= 1` and `tab_label.length <= 24` when present.
- If `questions.length > 1`, every question MUST have `tab_label` — reject
  otherwise. No fallback.
- Single-question asks: `tab_label` is ignored (not rendered) but still
  type-checked when present.

## 3. Rendering spec

- **Tab label**: `A. ${q.tab_label}` (letter via `String.fromCharCode(65 + idx)`).
  Rendered as two spans: `<span class="ask-tab-letter">A.</span>
  <span class="ask-tab-label">User behaviour</span>`. The `✓` marker logic is
  unchanged.
- **Option label**: option card adds a leading
  `<span class="ask-option-index font-mono">${n}.</span>` before the existing
  `<span class="ask-option-text">`, where `n = optIdx + 1`. The "Other" row uses
  `n = q.options.length + 1`. The numbered prefix is styled as a monospace badge
  so the shortcut (`1`, `2`, …) is obvious.
- **Primary button**:
  - Label: `Next` when multi-question and not last; `Submit` when last (or
    single-question and Submit is shown by existing rules); `Submitting…` while
    in-flight (unchanged).
  - `disabled` predicate:
    - Next: `!_isQuestionValid(this._activeTab)`.
    - Submit: `!_canSubmit() || _submitting` (unchanged).
  - Click handler:
    - Next → `this._activeTab = this._activeTab + 1` and reset `_focusedOption = 0`.
    - Submit → `_submit()` (unchanged).
- Mouse/touch flows untouched apart from label strings. Single-select
  auto-submit (single-question) and auto-advance (multi-question) behaviour
  preserved.

## 4. Keyboard handling

One keydown listener on `.ask-widget` root. Early-out guard: if
`document.activeElement` is the `.ask-other-input` text input, only intercept
**Enter** (submit/next) and **Escape** (clear); never intercept digits or
letters. All other keys fall through to the text input.

Key map (handler runs only when focus is inside the widget):

| Key | Behaviour |
|-----|-----------|
| `ArrowDown` | `_focusedOption = (_focusedOption + 1) % optionCount`; `preventDefault`. Also physically focus the card (for screen-reader parity). |
| `ArrowUp` | `_focusedOption = (_focusedOption - 1 + optionCount) % optionCount`; `preventDefault`. |
| `ArrowLeft` / `ArrowRight` | Only when focus is on a tab button: move tab focus + activate new tab (ARIA tablist auto-activation). `preventDefault`. |
| `Enter` | If the focused element is the primary button, click it. Else if single-question + single-select + a focused option exists → select it (auto-submits via existing path). Else if primary button is enabled → click it (Next or Submit). `preventDefault`. |
| `Tab` / `Shift+Tab` | Browser default — DOM order is: tablist (one roving stop) → options radiogroup (one roving stop) → Other text input (when present) → primary button. |
| `Escape` | Clear active question: set `_draft[_activeTab].selected = q.multi ? [] : null` and `_draft[_activeTab].other_text = ""`. `preventDefault`. Do not submit or close. |
| `1`–`9` | `pickByIndex(n - 1)` on the active question: |
| | – out-of-range (>= optionCount): ignore. |
| | – single-select: select the option. Single-question → auto-submits (existing path). Multi-question + not last → auto-advances (existing path). Last question → stay put (user must press Enter to Submit). |
| | – multi-select: toggle the option (no auto-advance). |
| | `preventDefault` on accept. Skipped when text input has focus. |
| `A`–`Z` (case-insensitive) | `jumpToTab(code - 65)` in multi-question asks. Out-of-range ignored. Updates `_activeTab` and resets `_focusedOption = 0`. Single-question asks: ignored. Skipped when text input has focus. |

Helper predicates:
- `optionCount(qIdx) = q.options.length + (q.allow_other ? 1 : 0)`.
- `isTextInputFocused()` = `document.activeElement instanceof HTMLInputElement
  && activeElement.type === "text"`.

## 5. ARIA

- Tab bar: `role="tablist"` (already present); each tab button keeps
  `role="tab"`, `aria-selected`, plus new `tabindex` (0 for active, -1 for
  others), and new `aria-controls="ask-panel-${idx}"`.
- Panel: `role="tabpanel"` gets `id="ask-panel-${idx}"` and
  `aria-labelledby="ask-tab-${idx}"`.
- Options container: swap the implicit grouping for
  `role="radiogroup"` (single-select) or `role="group"` (multi-select) with
  `aria-label=${q.question}`. Each option `<label>` gets `role="radio"` /
  `role="checkbox"` and `aria-checked` reflecting state; roving `tabindex`
  (0 on `_focusedOption`, -1 otherwise).
- The visually-hidden native `<input>` stays for form semantics and for the
  fixture tests that already query by `input[type=radio]`.

## 6. Test plan

### Unit (`tests/ask-user-choices-widget.spec.ts`)
Update first: every existing multi-question fixture gets `tab_label` on each
question, and label assertions are updated to the new format.

Add:
1. **Tab label format** — multi-question ask renders `A. <tab_label>` on tab 0,
   `B. <tab_label>` on tab 1, etc. Letter and label are in separate spans.
2. **Option label format** — options render `1.`, `2.`, … prefixes; "Other" is
   `${options.length + 1}.`.
3. **Next vs. Submit button swap** — in a 2-question ask, question 0 shows Next
   (disabled with no selection, enabled after selecting), question 1 shows
   Submit. Clicking Next on q0 advances to q1; Submit on q1 submits.
4. **ArrowDown / ArrowUp** — move `_focusedOption` with wrap-around; radio
   `tabindex` follows.
5. **ArrowLeft / ArrowRight** on tab button — move tab focus and activate new
   tab.
6. **Enter on primary button** — clicks Next or Submit depending on active tab.
7. **Enter on focused option (single-question, single-select)** — selects and
   auto-submits.
8. **Escape clears** — single-select clears to `null`; multi-select clears to
   `[]`; `other_text` reset to `""`. Does not submit or advance tab.
9. **Number key 1–9 pick** —
   - single-select + multi-question + non-last: auto-advances to next tab.
   - single-select + multi-question + last: selects, no advance.
   - single-select + single-question: auto-submits.
   - multi-select: toggles the option.
   - out-of-range (e.g. `7` with 3 options): no-op.
10. **Letter key A–Z jump** — A focuses tab 0, B focuses tab 1, etc. Out-of-range
    is a no-op. Single-question ask ignores letter keys.
11. **No hijack while typing in Other** — focus the `.ask-other-input`, press
    `3`, `b`: text field receives the characters, widget does not intercept.
    Only Enter (submit) and Escape (clear) still intercept from inside the
    Other input.
12. **"Other" numbering** — option list with `allow_other: true` renders the
    Other row with `${options.length + 1}.`; pressing that number key selects
    Other (single-select — reveals text input; multi-select — toggles).

### Server validation (`tests/ask-user-choices-validation.spec.ts` if present, else a new one)
13. `validateQuestions` rejects a 2-question ask where `tab_label` is missing on
    any question; error message mentions `tab_label` and the question index.
14. `validateQuestions` rejects `tab_label` longer than 24 chars.
15. `validateQuestions` accepts a single-question ask without `tab_label`.
16. `validateQuestions` accepts a multi-question ask where every question has a
    valid `tab_label`.

### Browser E2E (`tests/e2e/ui/ask-user-choices-ui.spec.ts`)
17. **Keyboard-only multi-question submission** — mock agent emits a
    2-question ask (both with `tab_label`); test focuses the widget, presses
    `1` (picks option 1, auto-advances to q2), presses `2` (picks option 2, no
    advance — last question), presses `Enter` (Submit). Assert the submitted
    envelope matches and the widget is read-only.

## 7. Out of scope

- No changes to mouse/touch flows other than label strings (numbered tabs/options,
  Next vs. Submit).
- **No fallback** for missing `tab_label` — server rejects multi-question asks
  without it. No auto-generation from `question` text.
- No changes to the `ask_user_choices_response` envelope format. Answers
  continue to carry `{ question, selected, other_text }` only.
- No new CSS theme tokens — reuse existing `border-border`, `bg-card`, etc.
- No changes to `min`/`max` semantics.

## 8. Open questions

1. **Where does `validateQuestions` run on inbound tool_use?** The current
   codebase calls it in the `/api/internal/user-question/submit` path (against
   the transcript-captured input). We should confirm whether the tool_use is
   validated when first broadcast to the UI — if not, an invalid multi-question
   ask would render a broken tab bar before the submit path catches it. If the
   validator isn't wired there yet, the implementer should add a call either in
   the tool extension's `execute` (return an error content instead of the stub)
   or in the WS broadcast pipeline so the agent gets immediate feedback. Either
   path is acceptable — flag for the coder.
2. **Case of letter shortcut**: spec says A–Z; should we also accept
   lowercase `a`–`z`? Recommendation: yes (compare `event.key.toUpperCase()`);
   cheap and user-friendly. Flagged in case the reviewer prefers strict.
3. **Enter inside the Other text input**: currently submit when valid — confirm
   this is still desired (design assumes yes; matches existing behaviour
   preserved by not intercepting anything else from the text input).
