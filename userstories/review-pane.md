# Review Pane — User Stories

The review pane allows users to annotate markdown documents opened by the agent, add inline comments, and submit structured feedback that the agent acts on.

---

## RP-01: Agent opens a document for review

**Preconditions:** Active session with a connected agent.

**Steps:**
1. Agent calls the `review_open` tool with markdown content and a title.

**Expected:**
- Review pane appears as a split panel alongside the chat
- Document renders as formatted markdown
- Tab bar shows the document title
- Panel auto-selects the "Review" tab in the unified panel
- Panel un-collapses if it was collapsed

**Coverage:** none

---

## RP-02: Multiple review documents as tabs

**Preconditions:** Agent has opened two or more review documents.

**Steps:**
1. Agent calls `review_open` with title "Doc A".
2. Agent calls `review_open` with title "Doc B".
3. Click between tabs.

**Expected:**
- Both documents appear as tabs in the tab bar
- Clicking a tab switches the displayed document
- Active tab is visually highlighted
- Each document retains its own annotations independently
- Overflow menu ("...") appears when more than 5 tabs

**Coverage:** none

---

## RP-03: Add an annotation

**Preconditions:** Review pane is open with a document.

**Steps:**
1. Select text in the rendered document.
2. Add a comment in the annotation popover.
3. Submit the comment.

**Expected:**
- Selected text is highlighted after comment is saved
- Comment count badge appears on the tab
- Total comment count updates in the submit bar
- Annotation persists if you switch tabs and return

**Coverage:** none

---

## RP-04: Edit an existing annotation

**Preconditions:** Review document has at least one annotation.

**Steps:**
1. Click on a highlighted annotation.
2. Edit the comment text.
3. Save.

**Expected:**
- Popover opens with the existing comment pre-filled
- Edited comment replaces the previous one
- Highlight and badge count remain unchanged

**Coverage:** none

---

## RP-05: Delete an annotation

**Preconditions:** Review document has at least one annotation.

**Steps:**
1. Click on a highlighted annotation.
2. Click the delete/remove action.

**Expected:**
- Highlight is removed from the text
- Comment count decrements
- Annotation is removed from sessionStorage

**Coverage:** none

---

## RP-06: Submit review feedback

**Preconditions:** Review pane open with at least one annotation.

**Steps:**
1. Click "Submit Review" button.

**Expected:**
- Review feedback appears as a user message in the chat
- Message contains structured feedback with quoted text, line numbers, offsets, and comments
- Agent receives the feedback and responds to it
- Review pane closes after submission
- Annotations are cleared from sessionStorage
- Submit Review button is disabled when there are 0 comments

**Coverage:** none

---

## RP-07: Submit review with no comments

**Preconditions:** Review pane open, no annotations added.

**Steps:**
1. Observe the Submit Review button.

**Expected:**
- Button is disabled (greyed out)
- Submit bar shows "No comments yet"
- Clicking the disabled button does nothing

**Coverage:** none

---

## RP-08: Review pane survives page reload

**Preconditions:** Agent has opened a review document, user has not submitted.

**Steps:**
1. Agent opens a review document.
2. Reload the page (F5).
3. Navigate back to the session.

**Expected:**
- Review pane reopens with the same document
- Document content is intact (rebuilt from message history)
- Previously added annotations are preserved (sessionStorage)
- Tab and comment counts are correct

**Coverage:** none

---

## RP-09: Submitted review does not reopen on reload

**Preconditions:** User has submitted a review.

**Steps:**
1. Submit review feedback.
2. Reload the page.
3. Navigate back to the session.

**Expected:**
- Review pane stays closed
- Submitted state is tracked in sessionStorage
- Chat still shows the submitted feedback message

**Coverage:** none

---

## RP-10: New review after previous submission

**Preconditions:** User previously submitted a review in this session.

**Steps:**
1. Agent calls `review_open` again with new content.

**Expected:**
- Review pane reopens with the new document
- Submitted flag from the previous review is cleared
- New review persists across reconnects until submitted
- Previous submission's feedback remains in chat history

**Coverage:** none

---

## RP-11: Collapse/expand with Ctrl+]

**Preconditions:** Review pane is open.

**Steps:**
1. Press Ctrl+] (or Cmd+] on Mac).
2. Press Ctrl+] again.

**Expected:**
- First press collapses the review panel
- Second press expands it back
- Same behavior as the preview pane collapse shortcut
- Works regardless of whether it's a review, preview, or goal panel

**Coverage:** none

---

## RP-12: Fullscreen with Ctrl+#

**Preconditions:** Review pane is open.

**Steps:**
1. Press Ctrl+# (or Cmd+# on Mac).
2. Press Ctrl+# again.

**Expected:**
- First press makes the review pane fullscreen (hides chat)
- Second press exits fullscreen
- Previous collapsed state is restored on exit

**Coverage:** none

---

## RP-13: Close review via agent

**Preconditions:** Review pane is open.

**Steps:**
1. Agent calls the `review_close` tool.

**Expected:**
- Review pane closes
- Annotations for the closed document are cleared
- If closing a specific tab, other tabs remain
- If closing all, the entire review panel hides

**Coverage:** none

---

## RP-14: Review pane on mobile

**Preconditions:** Mobile device (touch-primary), review pane open.

**Steps:**
1. Select text using touch.
2. Tap "Add Comment" floating button.
3. Type comment in bottom sheet.
4. Submit.

**Expected:**
- Selection triggers a floating "Add Comment" button (not desktop popover)
- Comment input appears as a bottom sheet (not popover)
- Bottom sheet has slide-up animation
- Touch targets are at least 44x44px
- Annotation is saved and highlighted

**Coverage:** none (CSS unit tests for mobile styles exist)

---

## RP-15: Feedback format includes location data

**Preconditions:** Review pane open with annotations that have character offsets.

**Steps:**
1. Add annotations to specific text selections.
2. Submit review.

**Expected:**
- Feedback message includes line numbers computed from character offsets
- Feedback includes character offset ranges (e.g. "offset 1234-1267")
- Quoted text is included for each annotation
- Code block selections are formatted with backticks
- Agent can use line numbers and offsets to make precise edits

**Coverage:** none

---

## RP-16: Annotation persistence is per-session

**Preconditions:** Two sessions, both with review panes open.

**Steps:**
1. Add annotations in session A's review pane.
2. Switch to session B's review pane.
3. Add different annotations.
4. Switch back to session A.

**Expected:**
- Session A shows only session A's annotations
- Session B shows only session B's annotations
- Annotations never leak between sessions
- Storage keys include session ID for isolation

**Coverage:** none
