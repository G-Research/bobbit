# Review Pane — User Stories

The review pane allows users to annotate markdown documents opened by the agent, add inline comments, and submit structured feedback that the agent acts on.

**Architectural note — annotation storage:** Annotations are stored server-side (not sessionStorage) so they survive server restarts, browser changes, and are visible from any connected client. There is exactly one set of annotations per document per session — all browsers see the same annotations. No live collaboration or conflict resolution needed; browsers simply append and on refresh pick up all annotations.

---

## RP-01: Agent opens a document and user adds an annotation

**Preconditions:** Active session with a connected agent.

**Steps and expectations:**
1. Agent calls `review_open` with markdown content and title "Session Stories".
   - Review pane appears as a split panel alongside the chat.
   - Tab bar shows "Session Stories" as the active tab.
   - Panel auto-selects the "Review" tab in the unified panel.
   - If the panel was collapsed, it un-collapses.
   - Document renders as formatted markdown.
2. Select a passage of text in the rendered document.
   - A comment popover appears near the selection.
   - The popover shows the selected text (truncated if long) and a textarea.
3. Type a comment in the popover textarea.
4. Press Enter to submit the comment.
   - The popover closes.
   - The selected text is highlighted in the document.
   - The tab badge shows "1".
   - The submit bar at the bottom shows "1 comment".
5. Select a different passage and add a second comment.
   - Both highlights are visible.
   - Tab badge shows "2". Submit bar shows "2 comments".

**Coverage:** none

---

## RP-02: Multiple documents with independent annotations

**Preconditions:** Active session with a connected agent.

**Steps and expectations:**
1. Agent calls `review_open` with title "Doc A" and some markdown.
   - Review pane opens showing "Doc A". One tab visible.
2. Add two annotations to Doc A.
   - Tab badge shows "2". Submit bar shows "2 comments".
3. Agent calls `review_open` with title "Doc B" and different markdown.
   - A second tab "Doc B" appears in the tab bar.
   - "Doc B" is now the active tab, displaying its content.
   - Tab badge on "Doc A" still shows "2".
4. Add one annotation to Doc B.
   - "Doc B" tab badge shows "1". Submit bar shows "3 comments" (total).
5. Click the "Doc A" tab.
   - Doc A's content and both highlights are displayed.
   - Doc B's annotation is preserved (switch back to Doc B to verify — badge still shows "1").
6. Agent calls `review_open` with titles "Doc C" through "Doc F" (4 more documents).
   - First 5 tabs display normally.
   - 6th tab appears under an overflow "..." menu.
   - Clicking "..." reveals the overflow tab. Selecting it switches the view.

**Coverage:** none

---

## RP-03: Annotation keyboard shortcuts

**Preconditions:** Review pane open with a document, comment popover visible.

**Steps and expectations:**
1. Select text and observe the popover.
2. Type a comment. Press Enter.
   - Comment is saved. Popover closes. Highlight appears.
3. Select new text. Popover opens.
4. Type a multi-line comment: type "line one", press Shift+Enter, type "line two".
   - Shift+Enter inserts a newline in the textarea (does not submit).
5. Press Enter.
   - The full multi-line comment is saved.
6. Select new text. Popover opens.
7. Press Escape.
   - Popover closes without saving. No highlight added. Comment count unchanged.

**Coverage:** none

---

## RP-04: Edit an existing annotation

**Preconditions:** Review document has at least one annotation.

**Steps and expectations:**
1. Click on a highlighted annotation in the document.
   - Popover opens with the existing comment pre-filled in the textarea.
2. Modify the comment text.
3. Press Enter to save.
   - Popover closes. Highlight remains. Comment count unchanged.
   - Switching tabs and returning shows the updated comment.
4. Click the same highlight again.
   - Popover shows the updated comment text.

**Coverage:** none

---

## RP-05: Delete an annotation

**Preconditions:** Review document has two annotations.

**Steps and expectations:**
1. Click on the first highlighted annotation.
   - Popover opens showing the comment.
2. Click the delete/remove action in the popover.
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
   - Review pane closes immediately.
   - A user message appears in the chat containing structured feedback:
     - "## Review Feedback" heading.
     - Section for "Doc A" with 2 quoted passages, line numbers, offsets, and comments.
     - Section for "Doc B" with 1 quoted passage, line number, offset, and comment.
   - Agent receives the message and begins streaming a response.
3. After agent responds, verify:
   - The review feedback message persists in chat history.
   - The review pane does not reappear.
   - Annotations are cleared from storage.

**Coverage:** none

---

## RP-07: Submit review with no comments

**Preconditions:** Review pane open, no annotations added.

**Steps and expectations:**
1. Observe the submit bar.
   - Shows "No comments yet".
   - Submit Review button is disabled (greyed out).
2. Click the disabled button.
   - Nothing happens. No message sent. Pane stays open.
3. Add one annotation.
   - Submit bar updates to "1 comment". Button becomes enabled.

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
   - Both annotations are present with highlights and correct comment text.
   - Tab badge shows "2". Submit bar shows "2 comments".
4. Add a third annotation. Submit the review.
   - All 3 annotations appear in the feedback message.

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
4. Server restarts. Navigate back to the session.
   - Review pane still stays closed.

**Coverage:** none

---

## RP-10: New review after previous submission

**Preconditions:** User previously submitted a review in this session.

**Steps and expectations:**
1. Agent calls `review_open` with new content and title "Round 2".
   - Review pane reopens with "Round 2" document.
   - No leftover annotations from the previous review.
2. Add annotations and submit.
   - Second feedback message appears in chat after the first one.
   - Both feedback messages are in the chat history.
3. Reload the page.
   - Review pane stays closed (second review was submitted).
   - Both feedback messages visible in chat.

**Coverage:** none

---

## RP-11: Collapse and expand with Ctrl+]

**Preconditions:** Review pane is open with a document.

**Steps and expectations:**
1. Press Ctrl+] (Cmd+] on Mac).
   - Review panel collapses. Chat expands to full width.
2. Press Ctrl+] again.
   - Review panel expands back. Document and annotations are intact.
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
2. Press Ctrl+# again.
   - Fullscreen exits. Chat reappears.
   - Previous collapsed/expanded state is restored.

**Coverage:** none

---

## RP-13: Close review via agent

**Preconditions:** Review pane is open with two documents: "Doc A" and "Doc B".

**Steps and expectations:**
1. Agent calls `review_close` with title "Doc A".
   - "Doc A" tab is removed. "Doc B" becomes the active tab.
   - Annotations for Doc A are cleared.
   - Doc B's annotations are unaffected.
2. Agent calls `review_close` with no title (close all).
   - Review pane hides entirely.
   - All remaining annotations are cleared.

**Coverage:** none

---

## RP-14: Review pane on mobile

**Preconditions:** Mobile device (touch-primary), review pane open.

**Steps and expectations:**
1. Long-press and drag to select text.
   - A floating "Add Comment" button appears near the selection (not the desktop popover).
2. Tap "Add Comment".
   - A bottom sheet slides up from the bottom of the screen.
   - Shows the selected text and a textarea.
   - Touch targets (Cancel, Submit buttons) are at least 44x44px.
3. Type a comment. Tap Submit.
   - Bottom sheet closes. Annotation is highlighted in the document.
4. Swipe down on the bottom sheet handle.
   - Bottom sheet dismisses (cancel).

**Coverage:** none (CSS unit tests for mobile styles exist)

---

## RP-15: Feedback format includes precise location data

**Preconditions:** Review pane open, document loaded from a file the agent can edit.

**Steps and expectations:**
1. Add an annotation on a heading near the top of the document.
2. Add an annotation on a paragraph further down.
3. Submit review.
4. Inspect the feedback message in chat:
   - Each annotation includes the quoted text.
   - Each includes a line number (e.g. "line 5", "line 42") computed from character offset.
   - Each includes a character offset range (e.g. "offset 120-156").
   - Code block selections are formatted with backticks.
   - The agent uses this data to make precise edits (e.g. via the `edit` tool targeting the exact text).

**Coverage:** none

---

## RP-16: Annotations are shared across browsers

**Preconditions:** Same session open in two different browsers (or tabs simulating different clients).

**Steps and expectations:**
1. In browser A, add an annotation to the review document.
2. In browser B, reload the page and navigate to the same session.
   - Browser B sees the annotation added by browser A (highlight and comment).
3. In browser B, add a second annotation.
4. Reload browser A.
   - Browser A sees both annotations.
5. Annotations are stored server-side, not in browser-local storage.
   - Server restart preserves all annotations.
   - Logging in from a new device shows all annotations.

**Coverage:** none

---

## RP-17: Replace an existing document with updated content

**Preconditions:** Review pane open with a document titled "Draft".

**Steps and expectations:**
1. Agent calls `review_open` with the same title "Draft" but updated markdown content.
   - The document content updates in place (replace mode is default).
   - The tab remains — no duplicate tab created.
2. Previous annotations may no longer align with the new content.
   - Annotations whose anchor text no longer exists are either orphaned or hidden.
   - Annotations whose anchor text still exists re-anchor correctly.
3. User can add new annotations to the updated content.

**Coverage:** none
