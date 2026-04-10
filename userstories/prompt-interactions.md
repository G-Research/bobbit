# Prompt Interactions — User Stories

The prompt area and context bar are the most-used parts of the UI. These stories cover every interactive element in the message editor, status bar, and context bar.

---

## PI-01: Send a message with Enter

**Preconditions:** Active session, textarea focused.

**Steps:**
1. Type "hello world".
2. Press Enter.

**Expected:**
- Message appears in chat immediately
- Textarea clears and re-focuses
- Send button shows as Stop button while agent streams
- Pressing Escape aborts the stream
- After response completes, textarea re-enables with Send button

**Coverage:** covered (via S-02)

---

## PI-02: Multiline prompt editing

**Preconditions:** Active session, textarea focused.

**Steps:**
1. Type "line one".
2. Press Shift+Enter.
3. Type "line two".
4. Press Shift+Enter.
5. Type "line three".
6. Press Enter to send.

**Expected:**
- Each Shift+Enter inserts a newline without sending
- Textarea grows vertically to fit content (up to max height, then scrolls)
- The full multiline message sends as one message on Enter
- Message renders with preserved line breaks in chat

**Coverage:** none

---

## PI-03: Command history navigation

**Preconditions:** Active session with at least 3 previously sent messages.

**Steps:**
1. With empty textarea, press ArrowUp.
2. Press ArrowUp again.
3. Press ArrowDown.
4. Press ArrowDown past the newest entry.

**Expected:**
- First ArrowUp shows most recent sent message
- Second ArrowUp shows the one before that
- ArrowDown moves forward through history
- Going past the newest entry restores the original draft (empty or whatever was typed)
- History is per-session (not shared across sessions)
- History only activates when cursor is on the top visual row (ArrowUp) or bottom row (ArrowDown)

**Coverage:** none

---

## PI-04: Draft preservation across sessions

**Preconditions:** Two sessions exist.

**Steps:**
1. Go to session A, type "draft A" (don't send).
2. Switch to session B, type "draft B" (don't send).
3. Switch back to session A.
4. Switch back to session B.
5. Reload the page.
6. Navigate to session A, then B.

**Expected:**
- Session A always shows "draft A"
- Session B always shows "draft B"
- Drafts survive page reload
- Sending a message clears the draft (does not persist as draft afterward)
- Attachments are part of the draft and also preserved

**Coverage:** none (see also S-03)

---

## PI-05: Slash skill autocomplete

**Preconditions:** Active session, at least one slash skill configured.

**Steps:**
1. Type "/" at the start of the textarea.
2. Observe autocomplete menu.
3. Type a few characters to filter.
4. Use ArrowDown to highlight a skill.
5. Press Enter to select.

**Expected:**
- Menu appears showing available slash skills with name, description, and argument hint
- Typing after "/" filters the list in real time
- ArrowUp/ArrowDown navigates the list
- Enter or Tab accepts the highlighted skill
- Escape dismisses the menu
- Mouse hover highlights, mousedown selects
- Menu is positioned aligned with the "/" character
- "/" mid-word does not trigger the menu (only at word boundary)

**Coverage:** none

---

## PI-06: File attachment via button

**Preconditions:** Active session.

**Steps:**
1. Click the paperclip (attach) button.
2. Select one or more files.
3. Observe attachment tiles below the textarea.
4. Click X on one tile to remove it.
5. Click a tile to preview.
6. Send the message with remaining attachments.

**Expected:**
- File picker opens (accepts images, PDFs, documents, code files)
- Max 10 files, max 20MB each — exceeding shows an error
- Each file shows as an attachment tile (thumbnail or icon) with a delete button
- Clicking a tile opens a full preview overlay
- Removing a tile removes the attachment
- Sending includes all remaining attachments with the message
- Processing indicator shows while files are being prepared

**Coverage:** none

---

## PI-07: File attachment via drag and drop

**Preconditions:** Active session.

**Steps:**
1. Drag a file from the desktop over the editor area.
2. Observe the drop overlay.
3. Drop the file.

**Expected:**
- "Drop files here" overlay appears during drag
- Dropping processes the file into an attachment tile
- Same size/count limits as button attachment
- Multiple files can be dropped at once

**Coverage:** none

---

## PI-08: Image paste from clipboard

**Preconditions:** Active session.

**Steps:**
1. Copy an image to clipboard (e.g. screenshot).
2. Paste into the textarea (Ctrl+V / Cmd+V).

**Expected:**
- Pasted image appears as an attachment tile
- Image can be previewed by clicking the tile
- Image is included when the message is sent

**Coverage:** none

---

## PI-09: Voice input

**Preconditions:** Active session, browser supports SpeechRecognition.

**Steps:**
1. Click the mic button.
2. Speak a phrase.
3. Click mic again to stop (or let it auto-stop).

**Expected:**
- Mic button shows red pulsing animation while recording
- Recognized speech appears in the textarea
- Stopping recognition leaves the text in the textarea (not auto-sent)
- If browser doesn't support speech, mic button is hidden
- Recognition errors show a notification

**Coverage:** none

---

## PI-10: Steer (interrupt with new message)

**Preconditions:** Active session, agent is currently streaming a response.

**Steps:**
1. While agent is streaming, type a new message in the textarea.
2. Click the Steer button (or press Enter).

**Expected:**
- Current agent response is interrupted
- The steer message is injected as a user turn
- Agent continues with the new direction
- Both the partial response, the steer, and the new response are visible in chat
- The steer message is visually distinct (steer indicator)

**Coverage:** none (API-level only via steer-midturn.spec.ts)

---

## PI-11: Queue messages while agent is busy

**Preconditions:** Active session, agent is streaming.

**Steps:**
1. Type a message and send while agent is busy.
2. Send a second message.
3. Observe queued message pills below the textarea.

**Expected:**
- Queued messages appear as pills below the textarea
- Pills show the message text (truncated)
- Messages send in order when agent finishes each turn
- Queue count is visible

**Coverage:** partial (via S-12)

---

## PI-12: Reorder queued messages

**Preconditions:** Agent is busy, 3+ messages queued.

**Steps:**
1. Drag a queued pill to a different position.

**Expected:**
- Pill moves to the new position
- Execution order updates to match the new visual order
- Other pills shift to accommodate

**Coverage:** none

---

## PI-13: Edit a queued message

**Preconditions:** Agent is busy, message is queued.

**Steps:**
1. Click the edit action on a queued message pill.

**Expected:**
- Message text is placed back into the textarea for editing
- The queued pill is removed
- User can modify and re-send (or queue again)

**Coverage:** none

---

## PI-14: Remove a queued message

**Preconditions:** Agent is busy, message is queued.

**Steps:**
1. Click the remove/X action on a queued message pill.

**Expected:**
- Queued pill disappears
- Message is not sent
- Remaining queue order is preserved

**Coverage:** none

---

## PI-15: Model selector

**Preconditions:** Active session.

**Steps:**
1. Click the model name in the context bar.
2. Browse available models.
3. Select a different model.

**Expected:**
- Dropdown/popover shows available models grouped by provider
- Current model is highlighted
- Selecting a model updates the context bar immediately
- Next message uses the new model
- Model choice persists across page reload
- Search/filter available if many models

**Coverage:** partial (API-level via S-10, no UI E2E)

---

## PI-16: Thinking level selector

**Preconditions:** Active session, model supports thinking/extended thinking.

**Steps:**
1. Click the thinking level control in the context bar.
2. Change the thinking level (e.g. off / low / medium / high).

**Expected:**
- Current thinking level is visually indicated
- Changing the level takes effect on the next message
- Thinking blocks in the response are shown/hidden based on level
- Setting persists for the session

**Coverage:** none

---

## PI-17: Context usage bar

**Preconditions:** Active session with several messages exchanged.

**Steps:**
1. Observe the context percentage indicator in the stats bar.
2. Continue sending messages until context usage grows.

**Expected:**
- Progress bar shows percentage of context window used
- Bar color changes at thresholds (e.g. green → amber → red)
- Percentage updates after each message exchange
- Hovering or clicking shows a breakdown popover with input/output token counts
- When context is near-full, a warning is visible

**Coverage:** none

---

## PI-18: Cost display

**Preconditions:** Active session with messages.

**Steps:**
1. Observe the cost indicator in the stats bar.
2. Click it to expand.

**Expected:**
- Running cost for the session is displayed (formatted as currency)
- Clicking opens a cost popover with breakdown by model
- Cost updates in real time as the agent streams
- Delegate/sub-agent costs are shown separately if applicable
- Cost is server-authoritative (not client-calculated)

**Coverage:** none

---

## PI-19: Git status pill

**Preconditions:** Active session in a git repo with worktree.

**Steps:**
1. Observe the git status widget in the status bar.
2. Make changes via the agent (e.g. ask it to create a file).
3. Click the git status widget to expand.

**Expected:**
- Shows current branch name
- Shows clean/dirty indicator
- After agent makes changes, status updates to show modified files
- Expanding shows: changed file list, ahead/behind counts, upstream status
- Push/merge actions available in the dropdown
- Status refreshes when agent returns to idle
- Shows "merged into primary" indicator when applicable

**Coverage:** none

---

## PI-20: Background process pills

**Preconditions:** Active session, agent has started background processes via bash_bg.

**Steps:**
1. Ask the agent to start a dev server (triggers bash_bg).
2. Observe process pill in the status bar.
3. Click a pill to view logs.
4. Ask the agent to kill the process.

**Expected:**
- Each running background process shows as a pill with its name
- Pill indicates running/stopped state
- Clicking opens a log popup with recent output
- When process exits, pill updates to show exit status
- Overflow ("Show N more") when many processes exist
- Kill action available from the pill

**Coverage:** none

---

## PI-21: Abort streaming response

**Preconditions:** Agent is streaming a response.

**Steps:**
1. Press Escape (or click Stop button).

**Expected:**
- Agent stops generating immediately
- Partial response remains visible in chat
- Textarea re-enables with Send button
- Session status returns to idle
- Can send new messages
- No orphaned streaming state or UI glitches

**Coverage:** partial (API-level, no UI click test)

---

## PI-22: Personality selector

**Preconditions:** Active session, personalities configured.

**Steps:**
1. Locate the personality selector in the context bar.
2. Change the personality.

**Expected:**
- Current personality is shown
- Changing personality affects agent behavior on next message
- Personality choice persists for the session

**Coverage:** none

---

## PI-23: Context bar stats overview

**Preconditions:** Active session with messages.

**Steps:**
1. Observe the full stats bar below the context bar.

**Expected:**
- Shows: model name, cost, context %, token counts, git status, background processes
- All indicators update in real time during streaming
- Stats are specific to the active session (change when switching sessions)
- Compact layout with clear visual hierarchy

**Coverage:** none

---

## PI-24: Textarea focus management

**Preconditions:** Active session.

**Steps:**
1. Navigate to a session — verify textarea auto-focuses.
2. Click elsewhere in the chat area, then press "/" — verify textarea re-focuses.
3. Switch sessions — verify textarea focuses in new session.

**Expected:**
- Textarea auto-focuses on session load
- Textarea auto-focuses on session switch
- Focus returns to textarea after agent response completes
- Focus does not steal from other active UI elements (e.g. settings dialog)

**Coverage:** none
