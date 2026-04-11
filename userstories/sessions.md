# Sessions — User Stories

Session lifecycle covers creation, switching, persistence, worktrees, termination, and crash resilience. These stories describe every interaction from the sidebar "+" button through gateway restart recovery.

---

## S-01: Create a new session

**Preconditions:** App loaded, at least one project registered in a git repo.

**Steps and expectations:**
1. Click the "+" button in the sidebar.
   - A new session entry appears in the sidebar with a default title (e.g. "New Session").
   - The new session is highlighted as the active session.
2. Observe the chat area.
   - Chat area is empty — no messages, no placeholder errors.
   - Textarea is focused and ready for input.
   - Send button is visible and disabled (no content to send).
3. Observe the context bar.
   - Context bar shows the current default model name.
   - Cost reads "$0.00" (no tokens exchanged yet).
   - Context usage is 0%.
4. Observe the git status widget in the status bar.
   - Widget shows a dedicated branch name (not `master` or the goal branch).
   - Branch name follows the session worktree naming convention (e.g. `session/<id>`).
5. Verify the session's working directory is inside a worktree.
   - Working directory is NOT the main project directory — it is inside a `-wt-session/` worktree.
   - If the project is in a subdirectory of the repo, the working directory is the equivalent subdirectory offset inside the worktree.
6. If `worktree_setup_command` is configured in `project.yaml` (e.g. `npm ci`):
   - The setup command runs automatically in the new worktree.
   - Session becomes usable after setup completes (no premature prompt delivery).

**Coverage:** covered (session-interactions.spec.ts — create+send+response; session-worktree.spec.ts — worktree creation)

---

## S-02: Send a message and receive a response

**Preconditions:** Active session with textarea focused.

**Steps and expectations:**
1. Type "hello world" in the textarea.
   - Characters appear as typed.
   - Send button enables (full opacity, pointer cursor).
2. Press Enter.
   - User message appears in the chat area immediately as a user turn.
   - Textarea clears and the Send button transitions to a Stop button.
   - Agent response streams token-by-token below the user message.
3. Wait for the agent to finish responding.
   - Stop button reverts to Send button.
   - Textarea re-enables and re-focuses.
   - Full agent response is visible in chat.
4. Observe the session title in the sidebar.
   - Title auto-generates based on the conversation content (no longer "New Session").
   - The new title is visible in the sidebar entry.
5. Press Enter with an empty textarea.
   - Nothing happens. No empty message is sent. No error.
6. Press Enter with only whitespace.
   - Nothing happens. Whitespace-only messages are not sent.

**Coverage:** covered (session-interactions.spec.ts — create+send+response)

---

## S-03: Draft isolation across sessions

**Preconditions:** Two sessions exist (session A and session B).

**Steps and expectations:**
1. Navigate to session A. Type "draft for A" (don't send).
   - "draft for A" is visible in the textarea.
2. Switch to session B. Type "draft for B" (don't send).
   - "draft for B" is visible in the textarea. Session A's draft is not visible.
3. Switch back to session A.
   - Textarea shows "draft for A" exactly as left.
   - No content from session B's draft appears.
4. Switch back to session B.
   - Textarea shows "draft for B" exactly as left.
5. Reload the page (F5). Navigate to session A.
   - Textarea shows "draft for A" (drafts survive page reload via server persistence).
6. Navigate to session B.
   - Textarea shows "draft for B".
7. In session A, send "draft for A" (press Enter).
   - Textarea clears. Draft is removed.
8. Switch away and back to session A.
   - Textarea is empty — sent message does not reappear as a draft.

**Coverage:** covered (message-editor-queue.spec.ts, draft-api.spec.ts — draft save/load/clear, per-session isolation)

---

## S-04: Terminate a session

**Preconditions:** At least two sessions exist, one of them (session X) is currently selected.

**Steps and expectations:**
1. Hover over session X in the sidebar.
   - A close (X) button appears on the session entry.
2. Click the X button.
   - A confirmation dialog appears (if the session has messages or active work).
3. Confirm termination.
   - Session X disappears from the sidebar immediately.
   - It is no longer listed — no ghost entry or placeholder.
4. Observe the view after termination.
   - If session X was active, the view switches to another session or the landing/dashboard.
   - The newly shown session (or landing) is fully functional.
5. Verify worktree cleanup.
   - Session X's worktree directory is removed from disk.
   - Session X's branch is cleaned up.
6. Terminate the last remaining session.
   - Sidebar shows no sessions.
   - View switches to the landing/dashboard.
   - The "+" button is still available to create a new session.

**Coverage:** covered (session-interactions.spec.ts — terminate+cleanup)

---

## S-05: Switch between sessions

**Preconditions:** Two sessions exist — session A with messages "alpha" and session B with messages "beta".

**Steps and expectations:**
1. Click session A in the sidebar.
   - Session A is highlighted as active in the sidebar.
   - Chat area shows session A's messages (including "alpha").
   - A loading animation (bouncing mascot) may appear briefly while connecting.
2. Observe the context bar and status bar.
   - Model name matches session A's configured model.
   - Cost and context usage reflect session A's values.
   - Git status widget shows session A's branch.
3. Click session B in the sidebar.
   - Session B is highlighted; session A is no longer highlighted.
   - Chat area shows session B's messages (including "beta") — none of session A's messages are visible.
   - Context bar updates to session B's model, cost, and context usage.
4. Click session A again.
   - Session A's messages reappear exactly as before.
   - No messages from session B leak into session A's view.
   - Sidebar correctly highlights session A.
5. Verify textarea state on switch.
   - If session A had a draft, it reappears. If not, textarea is empty.
   - Textarea is focused and ready for input.

**Coverage:** covered (session-interactions.spec.ts — switch via sidebar)

---

## S-06: Rapid session switching

**Preconditions:** Four sessions exist (A, B, C, D), each with distinct messages.

**Steps and expectations:**
1. Click session A in the sidebar.
   - Session A begins loading.
2. Immediately click session B (before A finishes loading).
   - Loading for session A is superseded.
3. Immediately click session C (before B finishes loading).
   - Loading for session B is superseded.
4. Wait for session C to fully load.
   - Chat area shows session C's messages — not stale messages from A or B.
   - Sidebar highlights session C as active.
   - Context bar shows session C's model and stats.
5. No errors, console warnings, or orphaned WebSocket connections from the abandoned switches.
   - Only one active connection exists (to session C).
6. Click session D, then immediately click back to session C.
   - Session C loads correctly with its own messages.
   - No flicker of session D's content.

**Coverage:** covered (session-interactions.spec.ts — switch via sidebar; rapid switching is an edge case of the same flow)

---

## S-07: Session survives page reload

**Preconditions:** Active session with at least one user message and one agent response.

**Steps and expectations:**
1. Send a message ("persistence test") and wait for the agent's response.
   - Both user message and agent response are visible in chat.
2. Note the session title, model, and message count.
3. Reload the page (F5 or Ctrl+R).
   - Page reloads. A loading/connecting indicator may appear briefly.
4. Wait for reconnection to complete.
   - Session appears in the sidebar with the same title.
   - Session is selectable and loads.
5. Navigate to the session (click it in the sidebar if not auto-selected).
   - Previous messages ("persistence test" and agent response) are visible in chat.
   - Messages are in the correct order with correct roles (user vs. assistant).
6. Send a new message ("after reload").
   - New message sends normally. Agent responds.
   - All messages (before and after reload) are visible in chronological order.
7. Verify context bar state after reload.
   - Model name matches the pre-reload selection.
   - Cost reflects the cumulative session cost (not reset to $0.00).

**Coverage:** covered (session-interactions.spec.ts — session survives reload)

---

## S-08: Session worktree details

**Preconditions:** Project is registered and lives in a git repo. A new session is created.

**Steps and expectations:**
1. Create a new session via the sidebar "+" button.
   - Session appears and connects.
2. Observe the git status widget in the status bar.
   - Widget shows a branch name that is NOT `master` and not the project's default branch.
   - Branch name follows the worktree naming pattern (e.g. `session/<session-id>`).
3. Verify the working directory.
   - The agent's working directory is inside a `-wt-session/` directory, not the main project root.
   - The worktree is a valid git worktree (has its own `.git` file pointing back to the main repo).
4. If the project root is a subdirectory of the git repo (e.g. `repo/packages/myapp`):
   - The working directory inside the worktree mirrors the same subdirectory offset.
   - File paths resolve correctly relative to this offset.
5. If `worktree_setup_command` is configured (e.g. `npm ci --prefer-offline`):
   - The command executes in the new worktree directory.
   - `SOURCE_REPO` environment variable is set to the primary worktree path.
   - Setup completes within the 2-minute timeout.
6. Ask the agent to create a file (e.g. "create test.txt").
   - The file is created inside the worktree, not in the primary project directory.
   - Git status widget updates to show the new untracked file.

**Coverage:** covered (session-worktree.spec.ts — worktree creation)

---

## S-09: Rename a session

**Preconditions:** A session exists with a default or auto-generated title.

**Steps and expectations:**
1. Double-click the session title in the sidebar (or right-click → Rename).
   - The title becomes an editable text input, pre-filled with the current title.
   - The input is focused and the text is selected for easy replacement.
2. Clear the input and type "My Custom Title".
   - Characters appear in the inline editor as typed.
3. Press Enter (or click away) to confirm.
   - The sidebar entry immediately shows "My Custom Title".
   - The editable input reverts to a static label.
4. Reload the page and navigate back to the session.
   - The title still reads "My Custom Title" (rename persists server-side).
5. Rename the session to an empty string and confirm.
   - The rename is rejected or the title reverts to the previous value.
   - No session is left with a blank title.
6. Rename the session to a very long string (100+ characters).
   - The title is accepted but truncated or ellipsized in the sidebar to fit.
   - Full title is visible on hover (tooltip).

**Coverage:** none — no automated tests for rename flow

---

## S-10: Change model mid-session

**Preconditions:** Active session with at least one exchanged message, multiple models available.

**Steps and expectations:**
1. Observe the model name in the context bar.
   - Shows the current model (e.g. "Claude Sonnet 4").
2. Click the model name to open the model selector.
   - A dropdown or popover appears with available models grouped by provider.
   - The current model is highlighted or checked.
3. Select a different model (e.g. "Claude Opus 4").
   - Dropdown closes.
   - Context bar immediately updates to show "Claude Opus 4".
4. Send a message.
   - The agent responds using the newly selected model.
   - Response metadata (if visible) confirms the new model.
5. Reload the page and navigate back to the session.
   - Model selector shows "Claude Opus 4" — the selection persists server-side.
   - The model is not reverted to the default.
6. Send another message after reload.
   - Agent continues to use "Claude Opus 4".

**Coverage:** covered (prompt-stats-e2e.spec.ts — model persistence across reconnect)

---

## S-11: Abort a running agent

**Preconditions:** Active session, agent is streaming a response (Stop button visible).

**Steps and expectations:**
1. Send a message that triggers a long response.
   - Agent begins streaming. Stop button appears. Textarea is disabled or shows streaming state.
2. Click the Stop button (or press Escape).
   - Agent stops generating immediately.
   - Partial response remains visible in chat — it is not removed or truncated to empty.
   - Stop button reverts to Send button.
3. Observe textarea state after abort.
   - Textarea re-enables and re-focuses.
   - Session status returns to idle.
4. Send a new message.
   - New message sends normally. Agent responds.
   - No orphaned streaming state or UI glitches from the previous abort.
5. Abort immediately after sending (before any tokens arrive).
   - Agent turn is aborted. An empty or minimal partial response may appear.
   - Textarea re-enables. Can send again normally.
6. Abort during a tool call (e.g. agent is running `bash sleep 60`).
   - Tool execution is interrupted.
   - UI transitions through an "aborting" state, then settles to idle.
   - No ghost "streaming" indicator persists after the abort completes.

**Coverage:** covered (abort-and-focus.spec.ts — stop button, Escape, onAbort callback)

---

## S-12: Queue management

**Preconditions:** Active session, agent is currently streaming a response (busy).

**Steps and expectations:**
1. Type "queued message 1" and press Enter while the agent is busy.
   - Message appears as a queued pill below the textarea.
   - Pill has muted styling (`bg-muted/50 border-border/50`) with: drag handle, truncated text, Steer button, Edit button, Remove (X) button.
2. Send "queued message 2" and "queued message 3" while the agent is still busy.
   - Three pills appear in order (top = first queued, bottom = last queued).
3. Grab the drag handle on pill 3 and drag it above pill 1.
   - Pill 3 becomes semi-transparent during drag.
   - After dropping, the new order is: 3, 1, 2.
   - Execution order updates to match the visual order.
4. Click the Remove (X) button on pill 1.
   - Pill 1 disappears immediately. Remaining pills (3 and 2) stay in relative order.
   - The removed message will not be sent.
5. Click the Edit button (pencil icon) on pill 2.
   - Pill 2 is removed from the queue.
   - Its text ("queued message 2") is placed into the textarea for editing.
   - Textarea is focused.
6. Modify the text to "edited message 2" and press Enter.
   - The modified message is re-queued as a new pill at the end of the queue.
7. Click the "Steer" button on pill 3.
   - Pill 3 moves to the top of the queue with amber styling (`bg-amber-500/10 border-amber-500/30`).
   - It will be delivered to the agent at the next tool boundary as an interrupt.
8. Agent finishes its current turn.
   - Steered message (pill 3) is dispatched first.
   - After the agent responds, the next queued message auto-dispatches.
   - Queue drains in order until empty.

**Coverage:** covered (message-editor-queue.spec.ts — pills, reorder, remove, edit; queue-ui.spec.ts E2E — steer, drain)

---

## S-13: Tool permission grant/deny

**Preconditions:** Active session, at least one tool has its access policy set to `ask` (e.g. in `tool-group-policies.yaml`).

**Steps and expectations:**
1. Send a message that causes the agent to invoke a guarded tool.
   - A permission dialog appears in the chat or as a modal.
   - Dialog shows: tool name, a description of what the tool will do, and action buttons.
2. Click "Deny" on the permission dialog.
   - Dialog closes.
   - Agent is told permission was denied and continues without the tool result.
   - Agent may respond with an alternative approach or ask the user.
3. Trigger the same guarded tool again (send another message that requires it).
   - Permission dialog appears again (denial was one-time).
4. Click "Allow" on the permission dialog.
   - Dialog closes.
   - Tool executes and its result is visible in the chat (tool call + result block).
   - Agent uses the tool result to continue its response.
5. Click "Allow for this session" (if available).
   - Dialog closes. Tool executes.
   - Subsequent uses of the same tool in this session do NOT prompt — they execute automatically.
   - Switching to a different session and triggering the same tool still prompts.
6. Click "Allow always" (if available).
   - Dialog closes. Tool executes.
   - The tool's policy is permanently changed to `allow` — no future prompts in any session.

**Coverage:** covered (tool-ask-policy.spec.ts, tool-guard-ask-policy.spec.ts — permission dialog, allow/deny flows)

---

## S-14: Session survives gateway crash

**Preconditions:** Active session with messages, gateway running via `dev:harness`.

**Steps and expectations:**
1. Send a message and wait for the agent's response.
   - Both user message and agent response are visible in chat.
   - Note the session ID and message content.
2. Kill the gateway process (e.g. `kill -9` or crash simulation).
   - The UI shows a disconnection indicator (e.g. "Connecting..." or reconnection spinner).
   - Chat area may become read-only or show a warning.
3. Wait for the gateway to restart (harness auto-restarts on crash).
   - The UI reconnects automatically — disconnection indicator disappears.
4. Observe the sidebar after reconnection.
   - Session appears in the sidebar with its title intact — it was not lost.
   - Session is selectable.
5. Navigate to the session (click it if not auto-selected).
   - Previous messages (both user and agent) are visible in chat.
   - Messages are in correct chronological order with correct roles.
6. Send a new message ("after crash").
   - New message sends normally. Agent responds.
   - The session is fully functional — no degraded state.
7. Verify the working directory is unchanged.
   - Agent's worktree and branch are the same as before the crash.
   - Git status widget shows the correct branch.
   - Files created before the crash are still present in the worktree.

**Coverage:** covered (manual-integration/session-resilience.spec.ts — crash/restart recovery)
