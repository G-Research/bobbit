# Review Pane — User Stories

The review pane allows users to annotate markdown documents opened by the agent, add inline comments, and submit structured feedback that the agent acts on.

**Annotation storage:** Annotations are stored server-side so they survive server restarts, browser changes, and are visible from any connected client. There is exactly one set of annotations per document per session — all browsers see the same annotations. No live collaboration or conflict resolution needed; browsers simply append and on refresh pick up all annotations.

---

## RP-01: Agent opens a document and user adds an annotation

**Preconditions:** Active session with a connected agent.

**Steps and expectations:**
1. Agent calls `review_open` with markdown content and title "Session Stories".
   - Review pane appears as a split panel alongside the chat.
   - Tab bar shows "Session Stories" as the active tab.
   - Panel auto-selects the "Review" tab in the unified panel.
   - If the panel was collapsed, it un-collapses.
   - Document renders as formatted markdown (headings, lists, code blocks, links all render correctly).
2. Select a passage of plain text in the rendered document (test on both desktop and mobile).
   - **Desktop:** A comment popover appears positioned near the selection.
   - **Mobile:** A floating "Add Comment" button appears near the selection; tapping it opens a bottom sheet.
   - The popover/sheet shows the selected text (truncated to ~80 chars if long) and a textarea with placeholder "Add your comment...".
3. Select text inside a code block.
   - Popover appears. The selection is flagged as code.
   - In the feedback output, this annotation's quote will be formatted with backticks.
4. Select text that spans a code block boundary (partially inside, partially outside).
   - Selection works. The annotation captures the full quoted text.
5. Type a comment in the popover textarea.
6. Press Enter to submit the comment (or click the Submit button).
   - The popover closes.
   - The selected text is highlighted with a purple/indigo underline span.
   - The tab badge shows "1".
   - The submit bar at the bottom shows "1 comment".
   - Clicking the comment count opens a popover listing all comments. Clicking a comment scrolls to and highlights that annotation in the document.
7. Press Enter with an empty comment textarea.
   - Popover closes without creating an annotation (cancel behavior). Comment count unchanged.
8. Select a different passage and add a second comment.
   - Both highlights are visible.
   - Tab badge shows "2". Submit bar shows "2 comments".

**Coverage:** none

---

## RP-02: Multiple documents with independent annotations

**Preconditions:** Active session with a connected agent.

**Steps and expectations:**
1. Agent calls `review_open` with title "Doc A" and some markdown.
   - Review pane opens showing "Doc A". One tab visible in the tab bar.
2. Add two annotations to Doc A.
   - "Doc A" tab badge shows "2". Submit bar shows "2 comments" (total across all docs).
3. Agent calls `review_open` with title "Doc B" and different markdown.
   - A second tab "Doc B" appears in the tab bar.
   - "Doc B" is now the active tab, displaying its content.
   - "Doc A" tab badge still shows "2".
   - Submit bar still shows "2 comments" (total is across all docs, not just the active one).
4. Add one annotation to Doc B.
   - "Doc B" tab badge shows "1". Submit bar shows "3 comments" (total).
5. Click the "Doc A" tab.
   - Doc A's content is displayed with both highlights intact.
   - Doc B's annotation is preserved — switch back to Doc B to verify badge still shows "1".
6. Agent calls `review_open` with titles "Doc C" through "Doc F" (4 more documents).
   - First 5 tabs display normally in the tab bar.
   - 6th tab appears under an overflow "..." button.
   - Clicking "..." reveals a dropdown menu with the overflow tab(s).
   - Selecting an overflow tab switches the view and closes the dropdown.
   - Clicking outside the overflow dropdown closes it.

**Coverage:** none

---

## RP-03: Annotation keyboard shortcuts

**Preconditions:** Review pane open with a document.

**Steps and expectations:**
1. Select text in the document. Popover appears with textarea focused.
2. Type "my comment". Press Enter.
   - Comment is saved. Popover closes. Highlight appears. Count increments.
3. Select new text. Popover opens.
4. Type "line one". Press Shift+Enter. Type "line two".
   - Shift+Enter inserts a newline in the textarea (does not submit).
   - Textarea now shows two lines.
5. Press Enter.
   - The full multi-line comment is saved (both lines preserved).
6. Select new text. Popover opens.
7. Press Escape.
   - Popover closes without saving. No highlight added. Comment count unchanged.
8. Select new text. Popover opens. Press Tab.
   - Tab moves focus within the popover (e.g. to the Submit button). It does not submit or close.
9. Press Enter with empty textarea (nothing typed).
   - Popover closes (cancel behavior). No annotation created.

**Coverage:** none

---

## RP-04: Edit an existing annotation

**Preconditions:** Review document has at least two annotations.

**Steps and expectations:**
1. Click on the first highlighted annotation in the document.
   - Popover opens positioned near the highlight.
   - Existing comment is pre-filled in the textarea.
   - Textarea is focused.
   - **Desktop:** Popover mode. **Mobile:** Bottom sheet mode.
2. Modify the comment text.
3. Press Enter to save.
   - Popover closes. Highlight remains in the same position without flickering.
   - Comment count is unchanged (edit, not add).
4. Click the same highlight again.
   - Popover shows the updated comment text (confirming the edit persisted).
5. While one popover is open (editing annotation A), click on annotation B's highlight.
   - The first popover closes (auto-cancel), and a new popover opens for annotation B.

**Coverage:** none

---

## RP-05: Delete an annotation

**Preconditions:** Review document has two annotations.

**Steps and expectations:**
1. Click on the first highlighted annotation.
   - Popover opens showing the existing comment, with Submit, Cancel, and Delete actions.
2. Click the Delete action.
   - Highlight is removed from the document.
   - Comment count decrements from 2 to 1.
   - The popover closes.
3. Reload the page and navigate back to the session.
   - Only one highlight remains. Comment count is 1.

**Coverage:** none

---

## RP-06: Submit review feedback

**Preconditions:** Review pane open with two documents. Doc A has 2 annotations, Doc B has 1 annotation.

**Steps and expectations:**
1. Observe the submit bar: shows "3 comments". Submit Review button is enabled.
2. Click "Submit Review".
   - Button shows a brief sending indicator, then the review pane closes.
   - A user message appears in the chat containing structured feedback:
     - `## Review Feedback` heading.
     - Section for "Doc A" with 2 annotations: each has quoted text, line number, character offset range, and the user's comment.
     - Section for "Doc B" with 1 annotation in the same format.
     - Annotations within each document section are ordered by their position in the document (ascending offset).
   - Agent receives the message and begins streaming a response.
3. After agent responds, verify:
   - The review feedback message persists in chat history.
   - The review pane does not reappear.
   - Annotations are cleared from storage.
4. If the agent is currently streaming when you click Submit:
   - The feedback is sent as a regular prompt and queued behind the current turn.
   - The queued message appears as a pill below the textarea (same as any queued message).

**Coverage:** none

---

## RP-07: Submit review with no comments

**Preconditions:** Review pane open, no annotations added.

**Steps and expectations:**
1. Observe the submit bar.
   - Shows "No comments yet".
   - Submit Review button is disabled (greyed out, reduced opacity, not-allowed cursor).
2. Click the disabled button.
   - Nothing happens. No message sent. Pane stays open.
3. Add one annotation.
   - Submit bar updates to "1 comment". Button becomes enabled (full opacity, pointer cursor).
4. Delete the annotation.
   - Submit bar reverts to "No comments yet". Button becomes disabled again.

**Coverage:** none

---

## RP-08: Review pane survives page reload

**Preconditions:** Agent has opened a review document, user has added annotations but not submitted.

**Steps and expectations:**
1. Agent opens a review document. User adds 2 annotations.
   - Tab badge shows "2". Highlights visible.
2. Reload the page (F5).
3. Navigate back to the session.
   - Review pane reopens with the same document (rebuilt from message history).
   - Both annotations are present with highlights and correct comment text (loaded from server-side storage).
   - Tab badge shows "2". Submit bar shows "2 comments".
4. Add a third annotation. Submit the review.
   - All 3 annotations appear in the feedback message.
5. Close the browser entirely, reopen, navigate to the session.
   - Review pane reopens. All annotations are intact (server-side storage persists across browser sessions).

**Coverage:** none

---

## RP-09: Submitted review does not reopen on reload

**Preconditions:** User has submitted a review in this session.

**Steps and expectations:**
1. Submit review feedback. Review pane closes.
2. Reload the page (F5).
3. Navigate back to the session.
   - Review pane stays closed.
   - The submitted feedback message is visible in chat history.
4. Close browser, reopen, navigate to the session.
   - Review pane stays closed (submitted state is server-side).
5. Server restarts. Navigate back to the session.
   - Review pane stays closed.

**Coverage:** none

---

## RP-10: New review after previous submission

**Preconditions:** User previously submitted a review in this session.

**Steps and expectations:**
1. Agent calls `review_open` with new content and title "Round 2".
   - Review pane reopens with "Round 2" document.
   - Submitted flag is cleared.
   - No leftover annotations from the previous review.
   - No leftover tabs from the previous review.
2. Add annotations and submit.
   - Second feedback message appears in chat after the first one.
   - Both feedback messages are in the chat history.
3. Reload the page.
   - Review pane stays closed (second review was submitted).
   - Both feedback messages visible in chat.

**Coverage:** none

---

## RP-11: Collapse and expand with Ctrl+]

**Preconditions:** Review pane is open with a document and at least one annotation.

**Steps and expectations:**
1. Press Ctrl+] (Cmd+] on Mac).
   - Review panel collapses. Chat expands to full width.
   - Collapsed state is persisted (survives reload).
2. Press Ctrl+] again.
   - Review panel expands back.
   - Document content and all annotation highlights are intact (collapse is CSS-only, no component destruction).
3. Close the review pane entirely (submit or agent closes).
4. Press Ctrl+].
   - Nothing happens (no panel to toggle).

**Coverage:** none

---

## RP-12: Fullscreen with Ctrl+#

**Preconditions:** Review pane is open with a document.

**Steps and expectations:**
1. Press Ctrl+# (Cmd+# on Mac).
   - Review pane goes fullscreen. Chat panel is hidden.
   - Document fills the available space.
   - Pre-fullscreen collapsed state is preserved.
2. Press Ctrl+# again.
   - Fullscreen exits. Chat reappears.
   - Previous collapsed/expanded state is restored.
3. Annotations added in fullscreen mode persist when exiting fullscreen.

**Coverage:** none

---

## RP-13: Close review via agent

**Preconditions:** Review pane is open with two documents: "Doc A" and "Doc B". Doc A has 1 annotation, Doc B has 2 annotations. The user is viewing Doc A with the popover open (mid-edit).

**Steps and expectations:**
1. Agent calls `review_close` with title "Doc A".
   - "Doc A" tab is removed from the tab bar.
   - "Doc B" becomes the active tab, displaying its content and 2 highlights.
   - Annotations for Doc A are cleared from storage.
   - Doc B's annotations and highlights are unaffected.
   - The popover that was open on Doc A is dismissed.
   - Submit bar updates to show "2 comments" (only Doc B's).
2. Agent calls `review_close` with no title (close all).
   - Review pane hides entirely.
   - All remaining annotations (Doc B's) are cleared from storage.
3. On reload, the review pane stays closed. The message history replay processes both `review_open` and `review_close` tool results in order, arriving at the correct final state.

**Coverage:** none

---

## RP-14: Review pane on mobile

**Preconditions:** Mobile device (touch-primary), review pane open.

**Steps and expectations:**
1. Long-press and drag to select text in the document.
   - Browser native selection handles appear.
   - After a brief debounce, a floating "Add Comment" button appears positioned below the selection.
   - The button does NOT appear if the selection is empty or collapsed.
2. Tap "Add Comment".
   - A bottom sheet slides up from the bottom of the screen.
   - Shows the selected text (truncated) and a textarea.
   - Touch targets (Cancel, Submit buttons) are at least 44x44px.
   - Textarea auto-focuses.
3. Type a comment. Tap Submit.
   - Bottom sheet closes. Annotation is highlighted in the document.
4. Tap an existing highlighted annotation.
   - Bottom sheet opens with the existing comment pre-filled (edit mode).
   - User can modify and tap Submit to update, or tap Delete to remove.
5. Swipe down on the bottom sheet handle.
   - Bottom sheet dismisses (cancel behavior).
6. Tap outside the selection (on non-annotated text).
   - The floating "Add Comment" button disappears if it was visible.

**Coverage:** none (CSS unit tests for mobile styles exist)

---

## RP-15: Feedback format includes precise location data

**Preconditions:** Review pane open, document loaded from a file the agent can edit.

**Steps and expectations:**
1. Add an annotation on a heading near line 3 of the document.
2. Add an annotation on a paragraph near line 40.
3. Add an annotation on text inside a code block.
4. Submit review.
5. Inspect the feedback message in chat:
   - Structure is: `## Review Feedback` → `### "Doc Title" — N comments` → individual annotations.
   - Each annotation has: `> "quoted text" (line N, offset X-Y)` followed by the comment on the next line.
   - The code block annotation uses backtick formatting: `` > `code text` (line N, offset X-Y) ``.
   - Annotations within each document are ordered by position in the document (ascending offset).
   - Line numbers are 1-indexed, computed from character offsets against the source markdown.
6. Agent uses the line numbers and quoted text to make precise edits via the `edit` tool.

**Coverage:** none

---

## RP-16: Annotations are shared across browsers

**Preconditions:** Same session open in two different browsers. Server-side annotation storage.

**Steps and expectations:**
1. In browser A, add an annotation to the review document.
2. In browser B, reload the page and navigate to the same session.
   - Browser B sees the annotation added by browser A (highlight and comment).
3. In browser B, add a second annotation.
4. Reload browser A.
   - Browser A sees both annotations.
5. Server restart preserves all annotations.
6. Logging in from a new device shows all annotations.

**Coverage:** none

---

## RP-17: Replace an existing document with updated content

**Preconditions:** Review pane open with a document titled "Draft" that has 3 annotations.

**Steps and expectations:**
1. Agent calls `review_open` with the same title "Draft" but updated markdown content (replace mode, which is the default).
   - The document content updates in place. The tab remains — no duplicate tab created.
2. Re-anchoring occurs automatically:
   - Annotations whose quoted text still exists at the same or nearby position are re-anchored. Highlights appear in the updated document.
   - A banner appears at the top of the document: "Document updated. X of 3 comments re-anchored, Y could not be placed."
3. Annotations that cannot be re-anchored (quoted text no longer exists in the document):
   - Appear in a "Detached Comments" section below the main document content.
   - Each detached comment shows the original quoted text and the user's comment.
   - Each has a remove button to delete it permanently.
4. User can add new annotations to the updated content.
5. Submit review includes both re-anchored annotations (with updated line numbers/offsets) and detached comments (with original quote but no location data).

**Coverage:** none

---

## RP-18: Session switch with review pane open

**Preconditions:** Two sessions exist. Session A has a review pane open with annotations. Session B has no review pane.

**Steps and expectations:**
1. Switch from session A to session B.
   - Review pane closes (review state is per-session).
   - Chat shows session B's messages.
2. Switch back to session A.
   - Review pane reopens with session A's document (rebuilt from message history).
   - Annotations are restored (keyed by session A's ID).
   - Tab badges and submit bar are correct.
3. Switch to session B again. Session B's agent opens its own review document.
   - Session B's review pane appears with its own document and zero annotations.
   - Session A's annotations are not visible (isolated by session ID).

**Coverage:** none

---

## RP-19: Error handling for malformed review_open

**Preconditions:** Active session with a connected agent.

**Steps and expectations:**
1. Agent calls `review_open` with empty markdown (empty string).
   - Review pane opens but shows an empty document area.
   - No crash. User can switch away and back.
2. Agent calls `review_open` with missing title (null or empty).
   - The tool call is ignored. Review pane does not open. No crash.
3. Agent calls `review_open` with extremely large markdown (>1MB).
   - Document renders (may be slow). No crash. Scrolling works.
   - Annotation selection works on the large document.

**Coverage:** none
