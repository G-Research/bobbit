# Prompt Interactions — User Stories

The prompt area and context bar are the most-used parts of the UI. These stories cover every interactive element in the message editor, status bar, and context bar.

---

## PI-01: Send a message with Enter

**Preconditions:** Active session, textarea focused.

**Steps and expectations:**
1. Type "hello world" in the textarea.
   - Characters appear in the textarea as typed.
   - Send button is enabled (full opacity, pointer cursor).
2. Press Enter.
   - Message appears in chat immediately as a user turn.
   - Textarea clears and re-focuses.
   - Send button transitions to a Stop button while the agent streams.
   - Agent response streams token-by-token below the user message.
3. Press Escape while the agent is streaming.
   - Streaming aborts. Partial response remains visible in chat.
   - Stop button reverts to Send button.
   - Textarea re-enables and re-focuses.
4. After the agent completes a response:
   - Send button is visible (not Stop).
   - Textarea is focused and ready for the next message.
5. Press Enter with an empty textarea (nothing typed, no attachments).
   - Nothing happens. No empty message sent. No error.
6. Press Enter with only whitespace in the textarea.
   - Nothing happens. Whitespace-only messages are not sent.

**Coverage:** covered (via S-02)

---

## PI-02: Multiline prompt editing

**Preconditions:** Active session, textarea focused.

**Steps and expectations:**
1. Type "line one".
2. Press Shift+Enter.
   - A newline is inserted. The message is NOT sent.
   - Textarea grows vertically to accommodate the new line.
3. Type "line two". Press Shift+Enter. Type "line three".
   - Textarea continues to grow vertically (up to a max height of ~200px, then scrolls internally).
   - All three lines are visible (or scrollable).
4. Press Enter to send.
   - The full multiline message sends as one message.
   - Message renders in chat with preserved line breaks.
   - Textarea clears, shrinks back to single-line height, and re-focuses.
5. Type a very long single line (500+ characters) without pressing Enter.
   - Textarea wraps the text and grows vertically to fit (CSS `field-sizing: content`).
   - No horizontal scrollbar appears.

**Coverage:** covered (message-editor-send.spec.ts, message-editor-arrows.spec.ts)

---

## PI-03: Command history navigation

**Preconditions:** Active session with at least 3 previously sent messages: "first", "second", "third" (in that order).

**Steps and expectations:**
1. With empty textarea, press ArrowUp.
   - Textarea shows "third" (most recent sent message).
   - The current empty draft is saved internally.
2. Press ArrowUp again.
   - Textarea shows "second".
3. Press ArrowUp again.
   - Textarea shows "first".
4. Press ArrowUp again (at oldest entry).
   - Textarea stays on "first". No wrap-around.
5. Press ArrowDown.
   - Textarea shows "second".
6. Press ArrowDown.
   - Textarea shows "third".
7. Press ArrowDown (past newest entry).
   - Textarea restores the original draft (empty string, or whatever was typed before entering history).
8. Type "my draft" (don't send). Press ArrowUp.
   - "my draft" is saved. Textarea shows "third".
9. Press ArrowDown past newest.
   - Textarea restores "my draft" exactly.
10. History is per-session — switch to another session and press ArrowUp.
    - The other session's history appears (or nothing if no messages sent there).
11. ArrowUp only activates when the cursor is on the top visual row of the textarea. If the textarea has multiple lines and the cursor is on line 2, ArrowUp moves the cursor up normally (default textarea behavior).
12. ArrowDown only activates when the cursor is on the bottom visual row of the textarea. Same principle as above.

**Coverage:** covered (command-history.spec.ts, message-editor-arrows.spec.ts)

---

## PI-04: Draft preservation across sessions

**Preconditions:** Two sessions exist (session A and session B).

**Steps and expectations:**
1. Go to session A. Type "draft A" (don't send).
   - "draft A" is visible in the textarea.
2. Switch to session B. Type "draft B" (don't send).
   - "draft B" is visible in the textarea. Session A's draft is not visible.
3. Switch back to session A.
   - Textarea shows "draft A" exactly as left.
4. Switch back to session B.
   - Textarea shows "draft B" exactly as left.
5. Reload the page (F5). Navigate to session A.
   - Textarea shows "draft A" (drafts survive reload).
6. Navigate to session B.
   - Textarea shows "draft B".
7. In session A, send "draft A" (press Enter).
   - Textarea clears. Draft is no longer saved for session A.
8. Switch away and back to session A.
   - Textarea is empty (draft was cleared on send).
9. Add an attachment to session B (don't send). Switch to session A and back.
   - Session B's draft includes both "draft B" text and the attachment tile.
   - Attachments are part of the draft and are preserved.

**Coverage:** covered (message-editor-queue.spec.ts, draft-api.spec.ts)

---

## PI-05: Slash skill autocomplete

**Preconditions:** Active session, at least one slash skill configured (e.g. `/mockup`).

**Steps and expectations:**
1. Type "/" at the very start of the textarea.
   - Autocomplete menu appears above the textarea, aligned with the "/" character.
   - Menu lists available slash skills, each showing: name (monospace, primary color), argument hint (muted), and description.
   - Skills are sourced from the server via `/api/slash-skills`.
2. Type "mo" after the "/" (so textarea reads "/mo").
   - Menu filters in real time — only skills whose name contains "mo" are shown.
   - If no skills match, the menu closes.
3. Press ArrowDown to highlight the next skill. Press ArrowUp to go back.
   - Highlighted skill has a distinct background (`bg-accent`).
   - Selection wraps: ArrowDown at last item stays on last; ArrowUp at first stays on first.
4. Press Enter (or Tab) to accept the highlighted skill.
   - The "/" and partial text are replaced with `/<skill-name> ` (with trailing space).
   - Menu closes.
   - Cursor is positioned after the trailing space, ready for the argument.
5. Press Escape while the menu is open.
   - Menu dismisses. Typed text (e.g. "/mo") remains in the textarea.
6. Hover over a skill in the menu.
   - That skill highlights. Clicking (mousedown) selects it.
7. Type "/" mid-sentence (e.g. "use the /mock").
   - Menu appears — "/" after whitespace is a valid trigger.
8. Type "/" inside a word (e.g. "path/to/file").
   - Menu does NOT appear. Only "/" preceded by whitespace or at position 0 triggers autocomplete.
9. Menu has a max height (~192px) and scrolls if many skills are available.

**Coverage:** covered (message-editor-slash.spec.ts, slash-skill-e2e.spec.ts)

---

## PI-06: File attachment via button

**Preconditions:** Active session.

**Steps and expectations:**
1. Click the paperclip (attach) button in the input row.
   - Native file picker opens.
   - Accepts: images, PDFs, documents, code files (`.md`, `.json`, `.ts`, `.js`, `.html`, `.css`, `.yaml`, etc.).
2. Select one file.
   - File picker closes.
   - An attachment tile appears above the textarea (in a `px-4 pt-3` container) showing a thumbnail or file icon.
   - Tile has a delete (X) button.
   - Send button remains enabled (attachment counts as content).
3. Click the paperclip again and select 2 more files.
   - 3 tiles now visible. Tiles wrap to multiple rows if needed.
4. Click X on one tile.
   - That tile is removed. 2 tiles remain.
5. Click an attachment tile (not the X).
   - A preview overlay opens showing the file content (image preview, or file details).
6. Send the message with remaining attachments.
   - Message appears in chat with attachment indicators.
   - Tiles clear from the editor.
   - Textarea clears and re-focuses.
7. Attempt to attach more than 10 files total.
   - An alert shows: "Maximum 10 files allowed".
   - No additional files are added.
8. Attempt to attach a file larger than 20MB.
   - An alert shows the file exceeds the maximum size.
   - That file is skipped; other valid files in the batch are still added.
9. While files are being processed (e.g. large file encoding):
   - The paperclip button is replaced by a spinning loader icon.
   - Send button is disabled until processing completes.

**Coverage:** covered (message-editor-attach.spec.ts — button flow, limits, tiles)

---

## PI-07: File attachment via drag and drop

**Preconditions:** Active session.

**Steps and expectations:**
1. Drag a file from the desktop over the editor area.
   - A "Drop files here" overlay appears over the editor (blue-tinted, `bg-primary/10`).
   - The editor border changes to primary color with increased width.
2. Drag the file away from the editor (without dropping).
   - Overlay disappears. Border reverts to normal.
3. Drop the file onto the editor.
   - Overlay disappears.
   - File is processed into an attachment tile (same as button-attached files).
4. Drop multiple files at once.
   - All files appear as attachment tiles (subject to the 10-file limit).
5. Same size/count validation as PI-06 (alerts for oversized or too many files).
6. Drag a queued message pill (see PI-12) — the "Drop files here" overlay does NOT appear.
   - File drop overlay only triggers for external file drags, not internal pill reordering.

**Coverage:** covered (message-editor-attach.spec.ts — drag-drop, overlay, limits)

---

## PI-08: Image paste from clipboard

**Preconditions:** Active session.

**Steps and expectations:**
1. Copy an image to the clipboard (e.g. take a screenshot with PrtScn, or copy from an image editor).
2. Focus the textarea and press Ctrl+V (Cmd+V on Mac).
   - The pasted image appears as an attachment tile (not as text in the textarea).
   - Default paste behavior is prevented (no binary data pasted as text).
3. Click the tile to preview the image.
   - Preview overlay shows the pasted image.
4. Paste regular text from clipboard.
   - Text is inserted into the textarea normally (no attachment tile).
   - Only `image/*` MIME types are intercepted.
5. Paste an image that exceeds 20MB.
   - Alert shows size limit. Image is not added.
6. Paste multiple images (if clipboard supports it).
   - Each image becomes a separate attachment tile.

**Coverage:** covered (message-editor-attach.spec.ts — paste, edge cases, limits)

---

## PI-09: Voice input

**Preconditions:** Active session, browser supports `SpeechRecognition` (Chrome, Edge).

**Steps and expectations:**
1. Observe the mic button in the input row.
   - Visible only if `SpeechRecognition` or `webkitSpeechRecognition` is available.
   - If browser doesn't support speech recognition, mic button is hidden entirely.
2. Click the mic button.
   - Button turns red with a pulsing animation (`text-red-500 animate-pulse`).
   - Icon changes from Mic to MicOff.
   - Browser may show a permission prompt for microphone access.
   - Speech recognition starts in continuous mode with interim results.
3. Speak a phrase (e.g. "hello world").
   - Recognized text appears in the textarea, appended after any existing text.
   - A space separator is added if existing text doesn't end with a space.
   - Only finalized results are displayed (no flickering from interim results).
4. Pause speaking. Mobile browsers may end recognition automatically.
   - Recognition auto-restarts if the user hasn't explicitly stopped (mobile resilience).
5. Click the mic button again to stop.
   - A 500ms delay allows the recognizer to finalize the tail end of speech.
   - Button reverts to normal Mic icon, no pulse.
   - Recognized text remains in the textarea — it is NOT auto-sent.
6. Recognition error occurs (e.g. no speech detected, network error).
   - `no-speech` errors are silently ignored (recognition continues).
   - Other errors stop recognition and reset the button state.
7. Hardware Copilot key support: pressing F13 (remapped via PowerToys from Win+Shift+F23) starts recognition; releasing F13 stops it (push-to-talk mode).

**Coverage:** covered (voice-input.spec.ts — mocked SpeechRecognition, F13, errors, restart)

---

## PI-10: Steer (interrupt with new message)

**Preconditions:** Active session, agent is currently streaming a response.

**Steps and expectations:**
1. While the agent is streaming, type a new message in the textarea.
   - Textarea is still editable during streaming.
2. Press Enter (or click Send).
   - The message is queued as a steer.
   - A queued pill appears below the textarea with amber styling (`bg-amber-500/10 border-amber-500/30`).
   - The pill shows a Zap icon and "Steer" button, indicating it will interrupt the current turn.
3. The steer is delivered to the agent at the next tool boundary.
   - The agent's current response may be interrupted.
   - The steer message appears as a user turn in chat, visually marked as a steer.
   - The agent continues with the new direction.
4. Both the partial response, the steer, and the new response are visible in chat in chronological order.
5. Steered pills show a "Sent" indicator (Zap icon + "Sent" text in amber) once dispatched.
   - Dispatched steer pills are not draggable, editable, or removable.

**Coverage:** covered (queue-ui.spec.ts E2E, steer-midturn.spec.ts API, message-editor-queue.spec.ts unit)

---

## PI-10b: Batch multiple steers

**Preconditions:** Active session, agent is currently streaming a response.

**Steps and expectations:**
1. While the agent is streaming, send a steer message (type + Enter).
   - First steer pill appears with amber styling.
2. Before the agent acknowledges the first steer, send a second steer.
   - Second pill appears below the first.
3. Send a third steer immediately after.
   - Three pills visible in order.
4. Steers are batched and delivered to the agent together at the next tool boundary.
   - Agent receives the combined context of all steers, not just the last one.
   - No steers are dropped or lost.
5. Chat shows the correct chronological order: partial agent response, steer 1, steer 2, steer 3, then the agent's new response.
6. All dispatched steer pills show the "Sent" indicator.

**Coverage:** covered (queue-ui.spec.ts E2E, queue-dispatch.spec.ts unit — batch steer delivery)

---

## PI-11: Queue messages while agent is busy

**Preconditions:** Active session, agent is streaming a response.

**Steps and expectations:**
1. Type a message and press Enter while the agent is busy.
   - Message appears as a queued pill below the textarea.
   - Pill has muted styling (`bg-muted/50 border-border/50`) — distinct from steer pills.
   - Pill shows: drag handle, truncated message text (monospace), Steer button, Edit button, Remove button.
2. Send a second and third message while the agent is still busy.
   - Three pills appear in order (top = first queued, bottom = last queued).
3. Agent finishes its current turn.
   - First queued message is dispatched automatically.
   - Its pill updates or is consumed.
4. Agent finishes responding to the first queued message.
   - Second queued message is dispatched next. Messages execute in order.
5. Queue count is reflected in the pill list (visual count of remaining pills).

**Coverage:** covered (queue-ui.spec.ts E2E, queue-dispatch.spec.ts unit, message-editor-queue.spec.ts)

---

## PI-12: Reorder queued messages

**Preconditions:** Agent is busy, 3 non-steer messages queued (A, B, C in order).

**Steps and expectations:**
1. Grab the drag handle (grip icon) on pill C.
   - Pill C becomes semi-transparent (`opacity: 0.5`).
   - Cursor shows move indicator.
2. Drag pill C to the position above pill A.
   - Other pills shift to accommodate.
3. Drop pill C.
   - New order is C, A, B.
   - Pill opacity restores to normal.
   - `onReorder` fires with the new ID ordering.
   - Execution order updates to match the new visual order.
4. Steer pills (dispatched) are not draggable — they have no drag handle.
5. Drag a pill and drop it on itself (no-op).
   - Nothing changes. No reorder event fires.

**Coverage:** covered (message-editor-queue.spec.ts — drag reorder with pill DnD)

---

## PI-13: Edit a queued message

**Preconditions:** Agent is busy, at least one non-steer message is queued.

**Steps and expectations:**
1. Click the Edit button (pencil icon) on a queued pill.
   - The pill is removed from the queue.
   - The message text is placed into the textarea for editing.
   - Textarea is focused.
2. Modify the text and press Enter.
   - The modified message is re-queued (appears as a new pill at the end of the queue).
3. Edit a pill, then decide not to re-send (clear the textarea and do something else).
   - The original queued message is gone (it was removed when Edit was clicked).
   - No orphaned message — the user chose to discard it.
4. Steer pills that have been dispatched (showing "Sent") do not have an Edit button.

**Coverage:** covered (message-editor-queue.spec.ts, queue-ui.spec.ts E2E — edit pill flow)

---

## PI-14: Remove a queued message

**Preconditions:** Agent is busy, 3 messages queued.

**Steps and expectations:**
1. Click the Remove (X) button on the second queued pill.
   - That pill disappears immediately.
   - Remaining pills (first and third) stay in their relative order.
   - The removed message is not sent.
2. Remove all queued pills one by one.
   - Queue area collapses (no empty container visible).
3. Dispatched steer pills (showing "Sent") do not have a Remove button.

**Coverage:** covered (message-editor-queue.spec.ts — remove button fires callback)

---

## PI-15: Model selector

**Preconditions:** Active session with the context bar visible.

**Steps and expectations:**
1. Observe the model name displayed in the context bar.
   - Shows the current model name (e.g. "Claude Sonnet 4").
2. Click the model name.
   - A dropdown or popover appears showing available models.
   - Models are grouped by provider.
   - The currently active model is highlighted or checked.
3. Select a different model.
   - Dropdown closes.
   - Context bar updates to show the new model name immediately.
   - The next message sent uses the new model.
4. Reload the page. Navigate back to the session.
   - The selected model persists (stored server-side on the session).
5. If many models are available, a search/filter input is present in the dropdown.

**Coverage:** covered (model-thinking-selectors.spec.ts — button display, click, visibility toggle)

---

## PI-16: Thinking level selector

**Preconditions:** Active session, current model supports extended thinking.

**Steps and expectations:**
1. Observe the thinking level control in the context bar.
   - Current level is visually indicated (e.g. icon or label showing "off", "low", "medium", "high").
2. Click or interact with the thinking level control.
   - Options appear: off / minimal / low / medium / high.
3. Select a different level (e.g. "medium").
   - Control updates to reflect the new level.
   - The next message uses the new thinking level.
4. Send a message with thinking enabled.
   - Agent response includes thinking blocks (if the model produces them).
   - Thinking blocks are shown or hidden in the UI based on the level.
5. Setting persists for the session (survives page reload).
6. If the model does not support thinking, the thinking control is hidden or disabled.

**Coverage:** covered (model-thinking-selectors.spec.ts — levels, onChange, visibility, reasoning gate)

---

## PI-17: Context usage bar

**Preconditions:** Active session with several messages exchanged.

**Steps and expectations:**
1. Observe the context percentage indicator in the stats bar.
   - A progress bar or percentage label shows how much of the model's context window is used.
2. Continue sending messages until context usage grows.
   - Percentage increases after each exchange.
   - Bar color changes at thresholds (e.g. green at low usage, amber at moderate, red near capacity).
3. Hover or click the context indicator.
   - A breakdown popover appears with input/output token counts.
4. Percentage updates in real time during agent streaming (as output tokens accumulate).
5. When context is near-full (e.g. >90%), a visible warning is displayed.
6. Context percentage is session-specific — switching sessions shows the other session's usage.

**Coverage:** covered (context-cost-stats.spec.ts — bar fill, thresholds, tooltip, stale state)

---

## PI-18: Cost display

**Preconditions:** Active session with messages exchanged.

**Steps and expectations:**
1. Observe the cost indicator in the stats bar.
   - Running cost for the session is displayed (formatted as currency, e.g. "$0.03").
2. Send a message. While the agent streams:
   - Cost updates in real time as tokens are produced.
3. Click the cost indicator to expand.
   - A cost popover opens with breakdown by model.
   - If delegate/sub-agent costs exist, they are shown separately.
4. Cost is server-authoritative — the displayed value comes from the server, not a client-side calculation.
5. Cost is session-specific — switching sessions shows the other session's cost.
6. Cost persists across page reload (server-side value).

**Coverage:** covered (context-cost-stats.spec.ts — dollar formatting, popover toggle, breakdown)

---

## PI-19: Git status pill

**Preconditions:** Active session in a git repo with a worktree.

**Steps and expectations:**
1. Observe the git status widget in the status bar.
   - Shows the current branch name (e.g. `master` or `goal/my-feature`).
   - Shows a clean/dirty indicator (e.g. dot or icon).
2. Ask the agent to create a file (e.g. "create a file called test.txt").
   - After the agent completes, the git status updates to show dirty state (modified/untracked files).
3. Click the git status widget to expand.
   - Dropdown shows: list of changed files, ahead/behind counts relative to upstream, upstream status.
   - Push/merge actions may be available in the dropdown.
4. Status refreshes when the agent returns to idle after each tool use.
5. When a branch has been merged into the primary branch, a "merged" indicator is visible.
6. Git status is session-specific (each session may have its own worktree/branch).

**Coverage:** covered (git-status-interactions.spec.ts — expand/collapse, files, PR, events, badges)

---

## PI-20: Background process pills

**Preconditions:** Active session, agent has started background processes via `bash_bg`.

**Steps and expectations:**
1. Ask the agent to start a dev server (triggers `bash_bg create`).
   - A process pill appears in the status bar with the process name (e.g. "dev server").
   - Pill indicates running state (e.g. green dot or running icon).
2. Click the pill.
   - A log popup opens showing recent output from the background process.
3. Ask the agent to start a second background process.
   - A second pill appears. Multiple pills are shown side by side.
4. Ask the agent to kill the first process.
   - The first pill updates to show stopped/exited state (e.g. exit code).
5. If many processes exist, overflow is handled (e.g. "Show N more" or a dropdown).
6. Kill action is available directly from the pill (click to expand, then kill).
7. Process pills are session-specific — switching sessions shows only that session's processes.

**Coverage:** covered (bg-process-states.spec.ts — running/exited, logs, kill, dismiss, close)

---

## PI-21: Abort streaming response

**Preconditions:** Agent is streaming a response (Stop button visible).

**Steps and expectations:**
1. Press Escape.
   - Agent stops generating immediately.
   - Partial response remains visible in chat (not removed or truncated to empty).
   - Stop button reverts to Send button.
   - Textarea re-enables and re-focuses.
   - Session status returns to idle.
2. Type a new message and send it.
   - New message sends normally. Agent responds.
   - No orphaned streaming state or UI glitches.
3. Alternatively, click the Stop button instead of pressing Escape.
   - Same behavior as pressing Escape.
4. Abort immediately after sending (before any tokens arrive).
   - Agent turn is aborted. An empty or minimal partial response may appear.
   - Textarea re-enables. Can send again.

**Coverage:** covered (abort-and-focus.spec.ts — stop button, Escape, onAbort callback)

---

## PI-22: Personality selector

**Preconditions:** Active session, at least one personality configured.

**Steps and expectations:**
1. Locate the personality selector in the context bar.
   - Shows the current personality name or a default label.
2. Click the personality selector.
   - A dropdown or popover shows available personalities with names and descriptions.
   - Current personality is highlighted or checked.
3. Select a different personality.
   - Selector updates to show the new personality.
   - Next message sent uses the new personality's prompt fragment.
4. Personality choice persists for the session (survives page reload).
5. Selecting "None" or the default removes any personality override.

**Coverage:** covered (personality-selector.spec.ts — chip toggle, multi-select, visual state)

---

## PI-23: Context bar stats overview

**Preconditions:** Active session with messages exchanged.

**Steps and expectations:**
1. Observe the full stats bar below the context bar.
   - Displays: model name, cost, context %, token counts, git status, background processes.
   - Compact layout with clear visual hierarchy (no overlapping or clipped elements).
2. During agent streaming:
   - Cost and context % update in real time.
   - Token counts increment as tokens arrive.
3. Switch to a different session.
   - All stats update to reflect the new session (model, cost, context, git, processes).
   - No stale data from the previous session.
4. On a narrow viewport (responsive):
   - Stats bar adapts — less critical items may hide or move to overflow.
   - Core items (model, cost) remain visible.

**Coverage:** covered (context-cost-stats.spec.ts — composite stats bar, reactive updates)

---

## PI-24: Textarea focus management

**Preconditions:** Active session.

**Steps and expectations:**
1. Navigate to a session (click in sidebar or direct URL).
   - Textarea auto-focuses immediately. Cursor is in the textarea, ready to type.
2. Click elsewhere in the chat area (e.g. on a message). Press any letter key.
   - Textarea re-focuses and the keystroke is captured (type-to-focus behavior).
3. Switch sessions (click a different session in the sidebar).
   - Textarea in the new session auto-focuses.
4. Agent finishes streaming a response.
   - Focus returns to the textarea (if the user hasn't focused another UI element).
5. Open a dialog (e.g. settings, model selector).
   - Textarea does NOT steal focus from the dialog.
   - After closing the dialog, focus returns to the textarea.
6. Open the review pane (agent calls `review_open`).
   - Textarea focus is not stolen. User can still type in the textarea.
   - Clicking in the review document moves focus to the document. Clicking back in the textarea restores focus there.

**Coverage:** covered (abort-and-focus.spec.ts — auto-focus, focus after send, persistence)

---

## PI-25: Steer, abort, and queue drain lifecycle

**Preconditions:** Active session with a connected agent.

**Steps and expectations:**
1. Ask the agent to run a long command (e.g. `bash sleep 60`).
   - Agent begins streaming. Stop button appears. Textarea is editable.
2. Type "Q1" and press Enter.
   - Q1 appears as a queued pill above the textarea (muted styling, non-steered).
3. Type "Q2" and press Enter.
   - Q2 appears between Q1 and the textarea.
4. Type "S1" and press Enter.
   - S1 appears between Q2 and the textarea.
5. Type "S2" and press Enter.
   - S2 appears between S1 and the textarea.
   - Queue order top-to-bottom: Q1, Q2, S1, S2.
6. Click "Steer" on S1.
   - S1 moves to the top of the queue area (above Q1). Pill gets amber steered styling.
   - S1 is NOT dispatched immediately — it waits for the agent to be ready.
7. Click "Steer" on S2.
   - S2 moves below S1 (above Q1). Pill gets amber steered styling.
   - Queue order top-to-bottom: S1, S2, Q1, Q2.
8. Click Stop (or press Escape).
   - The agent immediately terminates the tool run.
   - UI transitions to idle (or briefly shows "aborting" state).
9. After abort completes:
   - Agent receives S1 and S2 as a batch (single user turn, combined text).
   - Agent processes the steered messages and responds.
   - S1 and S2 pills are consumed from the queue.
10. Agent finishes responding to the steered batch.
    - Q1 is dispatched as the next prompt.
    - Agent processes Q1 and responds.
11. Agent finishes responding to Q1.
    - Q2 is dispatched as the next prompt.
    - Agent processes Q2 and responds.
12. All queue pills are now consumed. Textarea is ready for new input.

**Coverage:** tests/queue-dispatch.spec.ts

---

## PI-04b: Draft lost on rapid session switch

**Suspected bug:** Draft save is debounced (100ms) and async. Switching sessions within 100ms of typing means the debounce timer hasn't fired. `_flushDraft` fires synchronously on switch, but `saveDraftToServer` is async — the subsequent `loadDraftFromServer` on switch-back can arrive at the server before the save completes, returning empty/stale data.

**Preconditions:** Two sessions exist (A and B).

**Steps and expectations:**
1. Go to session A. Type "important draft".
2. Immediately switch to session B (within <100ms of typing).
3. Immediately switch back to session A.
   - Textarea should show "important draft".
   - **Suspected:** textarea is empty because the save hadn't completed before the load.
4. Reload the page. Navigate to session A.
   - Draft should still be present.
   - **Suspected:** draft is missing because the race condition persisted the empty state.

**Coverage:** tests/draft-persistence.spec.ts

---

## PI-04c: Draft clobbered by Lit re-render

**Suspected bug:** Draft is restored via `editor.value = text` + a single `queueMicrotask` re-apply. But multiple Lit re-render cycles (connection status changes, message loading, session status updates) can reset `editor.value` after both the initial set and the microtask.

**Preconditions:** Session with a saved draft.

**Steps and expectations:**
1. Reload the page.
2. Navigate to a session that has a saved draft.
   - During connection, multiple state changes occur: "connecting" → "connected", messages load, session status updates.
   - **Expected:** Draft appears in textarea after connection settles.
   - **Suspected:** Draft briefly appears then disappears as a later re-render resets the editor value.
3. Wait 2 seconds. Check textarea.
   - Draft should still be there.

**Coverage:** tests/draft-persistence.spec.ts

---

## PI-10c: Steer sent to wrong session after fast switch

**Suspected bug:** The `steer` WS message handler uses the session from the current WS connection, but the UI's `onSteer` callback captures a closure over the `session` object. If the user fast-switches sessions, the closure might reference the old session's remote agent.

**Preconditions:** Two sessions. Session A has an agent streaming. Session B is idle.

**Steps and expectations:**
1. In session A, queue a message while the agent is streaming.
2. Click "Steer" on the queued pill.
3. Immediately switch to session B (before the steer RPC resolves).
   - Steer should apply to session A, not session B.
   - Session B should be unaffected.

**Coverage:** none

---

## PI-11b: Queue not restored after page reload

**Suspected bug:** Queued messages live in server-side `PromptQueue` (in-memory). They're broadcast via `queue_update` WS messages. But after page reload, the queue state needs to be re-sent — is it included in the session reconnection flow?

**Preconditions:** Agent is streaming. 3 messages queued.

**Steps and expectations:**
1. Observe 3 queued pills below the textarea.
2. Reload the page (F5).
3. Navigate back to the session.
   - **Expected:** 3 queued pills reappear.
   - Queue should be re-broadcast on WS reconnection (check if `queue_update` is sent in the `connect` handler).
4. Agent finishes. Queued messages drain in order.

**Coverage:** none

---

## PI-11c: Queue drain race with concurrent prompt

**Suspected bug:** `drainQueue` sets `session.status = "streaming"` optimistically to prevent double-dispatch. But `enqueuePrompt` also checks `status === "idle" && queue.isEmpty` for direct dispatch. If `agent_end` and a new prompt arrive simultaneously, two prompts could be dispatched concurrently.

**Preconditions:** Agent is streaming. 1 message queued.

**Steps and expectations:**
1. Agent finishes its turn (`agent_end` fires).
2. Simultaneously, user sends a new message (presses Enter at the exact moment the agent goes idle).
   - Only one prompt should be dispatched at a time.
   - The new message should be queued behind the existing queued message, not jump ahead.
   - No "double prompt" where the agent receives two concurrent prompts.

**Coverage:** none

---

## PI-21b: Abort during tool call shows stale streaming state

**Suspected bug:** After abort, if the agent process is killed and restarted (3s grace period expired), there's a gap where the UI may show "streaming" status even though the process is dead. The `agent_end` is broadcast manually in `forceAbort`, but the client's `_isAborting` flag may not be cleared.

**Preconditions:** Agent is running a long tool call (e.g. `bash sleep 60`).

**Steps and expectations:**
1. Click Stop (or press Escape).
   - UI should immediately show "Aborting..." or similar feedback.
   - **Suspected:** UI shows nothing for 3 seconds, then abruptly transitions to idle.
2. After abort completes:
   - Textarea re-enables. Send button appears.
   - Session status is "idle".
   - No ghost "streaming" indicator persists.
3. Send a new message.
   - Agent responds normally (process was restarted).

**Coverage:** tests/queue-dispatch.spec.ts

---

## PI-15b: Model change lost on session reconnect

**Suspected bug:** Model selection may be stored client-side but not persisted to the server session. On reconnect or page reload, the model reverts to the default.

**Preconditions:** Session with a non-default model selected.

**Steps and expectations:**
1. Change the model to a non-default option.
2. Send a message. Verify agent responds using the new model.
3. Reload the page. Navigate back to the session.
   - Model selector should show the previously selected model.
   - **Suspected:** Model reverts to default.
4. Close browser entirely, reopen, navigate to session.
   - Model should still be the one you selected.

**Coverage:** none

---

## PI-03b: Command history lost after tab close

**Suspected bug:** Command history is stored in `AppStorage.commandHistory` — need to verify this survives across browser sessions and page reloads. If it's in `sessionStorage` (not `localStorage` or server-side), it disappears on tab close.

**Preconditions:** Session with 5+ sent messages.

**Steps and expectations:**
1. Send messages "msg1" through "msg5".
2. Press ArrowUp — verify "msg5" appears.
3. Reload the page. Navigate to session. Press ArrowUp.
   - **Expected:** "msg5" appears (history survives reload).
4. Close the browser tab entirely. Reopen. Navigate to session. Press ArrowUp.
   - **Expected:** "msg5" appears (history survives tab close).
   - **Suspected:** History is empty if stored in sessionStorage.

**Coverage:** none

---

## PI-24b: Focus stolen by review pane annotation popover

**Suspected bug:** When the review pane is open and the user clicks an annotation, the popover opens and steals focus. If the user then starts typing (expecting to type in the textarea), keystrokes go into the annotation popover instead.

**Preconditions:** Session with review pane open, at least one annotation.

**Steps and expectations:**
1. Click on an annotation highlight in the review pane.
   - Popover opens with textarea focused.
2. Press Escape to close the popover.
   - Focus should return to the message editor textarea.
   - **Suspected:** Focus goes to the document body or the review pane, not the textarea.
3. Without clicking anything, start typing.
   - Characters should appear in the message editor textarea.

**Coverage:** tests/review-annotation-focus.spec.ts
