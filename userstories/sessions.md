# Sessions — User Stories

## S-01: Create a new session

**Preconditions:** Project registered; project root is inside a git repo.

**Steps:**
1. Click the "+" button in the sidebar.
2. Wait for the new session to appear in the sidebar and the chat textarea to be ready.

**Expected behavior:**
- Session appears in the sidebar with the default title "New Session", selected and highlighted.
- Main panel shows an empty chat area with the textarea focused.
- Context bar displays the current model name and provider.
- Session status is `idle` when queried via the REST API.
- A worktree is created automatically with branch name `session/new-session-{first 8 chars of session UUID}`.
- Session CWD is inside the worktree directory — not the project root or primary worktree.
- The worktree belongs to the correct git repository.
- Git status widget in the UI shows the worktree branch name (with ⎇ symbol).
- If the project's `rootPath` is a subdirectory of the git repo, the worktree is a full checkout at the repo root but CWD is offset to the equivalent subdirectory within the worktree.
- If `worktree_setup_command` is configured in `project.yaml`, it runs in the new worktree directory (with `SOURCE_REPO` env var set, 2-minute timeout, via `sh -c`).

**Coverage:** partial

---

## S-02: Send message and receive response

**Steps:**
1. Type a message in the textarea.
2. Press Enter.
3. Wait for the agent to respond.

**Expected behavior:**
- User message appears in the chat immediately.
- Agent response appears below the user message.
- Session status transitions: `idle` → `streaming` → `idle`.
- Textarea re-enables after the agent finishes responding.
- Session title auto-generates on the first message via the WebSocket `generate_title` command.

**Coverage:** covered

---

## S-03: Draft isolation

**Steps:**
1. Navigate to session A.
2. Type a draft message (do not send).
3. Navigate to session B.
4. Type a different draft message (do not send).
5. Navigate back to session A.

**Expected behavior:**
- Each session shows its own draft text when navigated to.
- Drafts use a generation counter (`_draftGen` / `_draftSendGen`) to prevent stale drafts from reappearing after a message is sent.
- Drafts are persisted to `sessionStorage` keyed by session ID.
- Drafts survive a full page reload.
- After sending a message, the draft does not reappear — the send generation is tracked and persisted to `sessionStorage` under `draft-send-gen-<sessionId>`; any draft with a generation at or below the persisted send generation is discarded on session load.

**Coverage:** none

---

## S-04: Terminate a session

**Steps:**
1. Hover over a session entry in the sidebar.
2. Click the X (close/terminate) button.

**Expected behavior:**
- Session disappears from the sidebar.
- Main panel shows the landing page or navigates to the next available session.
- REST API confirms the session is terminated.
- Session worktree is cleaned up (`git worktree remove`).
- Session is archived in `sessions.json`.
- If the terminated session was the currently active/selected session, the UI navigates away from it.

**Coverage:** covered

---

## S-05: Switch between sessions

**Steps:**
1. Click session A in the sidebar; verify it loads.
2. Click session B in the sidebar; verify it loads.
3. Click session A again; verify it loads.

**Expected behavior:**
- Each session shows its own messages — never mixed with another session's messages.
- Sidebar highlights the currently active session.
- Context bar updates to reflect each session's model and provider.
- The previous session's WebSocket is disconnected, but the session remains in the client-side LRU cache (max 10 entries, controlled by `SESSION_CACHE_MAX` in `session-manager.ts`).
- While connecting to a session, the `BobbitLoadingAnimation` loading indicator is displayed (driven by `state.connectingSessionId`); it clears once the WebSocket connects or the connection fails.
- No console errors during switching.

**Coverage:** partial

---

## S-06: Rapid session switching

**Steps:**
1. Click session A in the sidebar.
2. Immediately click session B (before A finishes loading).
3. Immediately click session C (before B finishes loading).
4. Wait for session C to fully load.

**Expected behavior:**
- Session C loads correctly with its own messages and context.
- No stale messages from session A or B appear in the chat.
- No console errors.
- Sidebar correctly highlights session C.
- `state.connectingSessionId` tracks the most recent connection target; earlier connection attempts are superseded.

**Coverage:** none

---

## S-07: Session survives page reload

**Steps:**
1. Send a message in a session and receive a response.
2. Reload the page (F5).
3. Wait for the application to reconnect.

**Expected behavior:**
- Session appears in the sidebar after reload.
- Clicking the session shows the previous messages.
- User can send a new message and receive a response.
- Context bar displays the correct model and provider.
- Client retries `get_state` after 3 seconds on reconnect.
- If `getState()` fails, `sendFallbackModelState()` in `handler.ts` provides persisted model info (from `modelProvider`/`modelId` in `sessions.json`).

**Coverage:** covered

---

## S-08: Session with worktree

**Steps:**
1. Create a new session (click "+").
2. Query the session via the REST API to inspect its CWD and worktree details.
3. Verify the git status widget in the UI.

**Expected behavior:**
- Session CWD is inside a worktree directory — not the project root or the primary worktree.
- Branch name is `session/new-session-{uuid8}` (first 8 characters of the session UUID), not `master`.
- Git status widget shows the branch name with the ⎇ symbol.
- Worktree belongs to the correct repository.
- If `worktree_setup_command` is configured, it has already run in the worktree directory.
- If the project's `rootPath` is a subdirectory of the git repo, the worktree is a full checkout at the repo root but CWD is offset to the equivalent subdirectory within the worktree.
- If the worktree pool is available (pre-warmed), the session claims a pooled worktree. On acquire, the pooled worktree is fetched from origin and hard-reset to the remote primary branch (resolved via `git symbolic-ref refs/remotes/origin/HEAD`, falls back to `origin/master`) so it is not stale.

**Coverage:** partial

---

## S-09: Rename a session

**Steps:**
1. Double-click the session title in the sidebar (or right-click → rename).
2. Type a new title.
3. Confirm the rename.

**Expected behavior:**
- Title updates in the sidebar immediately via the WebSocket `set_title` command.
- New title is persisted to `sessions.json`.
- New title is visible in the session header area.

**Coverage:** none

---

## S-10: Change model mid-session

**Steps:**
1. Click the model selector in the context bar.
2. Select a different model.
3. Send a message.

**Expected behavior:**
- Context bar updates to show the newly selected model.
- Agent uses the new model for the response — selection is sent via the WebSocket `set_model` command (includes `provider` and `modelId`).
- Model choice is persisted to `localStorage` keyed by session ID (`session.<id>.model`).
- Model choice is restored on reconnect.

**Coverage:** partial

---

## S-11: Abort a running agent

**Steps:**
1. Send a message that triggers a long-running response.
2. Click the Stop button while the agent is streaming.

**Expected behavior:**
- A WebSocket `abort` command is sent to the server.
- Agent stops generating.
- Partial response remains visible in the chat.
- Textarea re-enables.
- Session returns to `idle` status.
- User can send new messages after aborting.

**Coverage:** partial

---

## S-12: Queue management

**Steps:**
1. Send a message while the agent is already busy (streaming).
2. Verify the message is queued.
3. Send another message to the queue.
4. Reorder the queued messages via drag-and-drop.
5. Remove a queued message via the X button.

**Expected behavior:**
- Queued messages appear as pills in the message editor area with drag handles.
- Reordering via drag-and-drop sends a `reorder_queue` WebSocket command with the ordered list of message IDs.
- Removing a queued message via the X button sends a `remove_queued` WebSocket command.
- The Steer button sends the queued message immediately, interrupting the current turn (`steer_queued` WebSocket command).
- The Edit button removes the message from the queue and places its text back into the textarea.
- When the agent finishes its current turn, the next queued message auto-sends.

**Coverage:** covered

---

## S-13: Tool permission grant/deny

**Steps:**
1. Trigger a tool call that has a guard policy (`policy: "ask"`).
2. A permission dialog appears.
3. Click Allow (or Deny).

**Expected behavior:**
- Clicking Allow sends a `grant_tool_permission` WebSocket command with `toolName`, `scope`, `group`, and `mode`. The tool then executes.
- Clicking Deny sends a `deny_tool_permission` WebSocket command. The agent is informed the tool was denied. The dialog closes.
- "Allow for session" scope persists the grant for the remainder of the session.
- "Allow always" writes the permission to `tool-group-policies`.

**Coverage:** covered

---

## S-14: Session survives gateway crash

**Steps:**
1. Send a message in a session and receive a response.
2. Kill the gateway process (simulate a crash).
3. Restart the gateway on a new port, using the same data directory.
4. Navigate to the application.

**Expected behavior:**
- Session appears in the sidebar — not archived.
- Previous messages are preserved (loaded from the `.jsonl` file).
- User can send a follow-up message and receive a response.
- Session CWD is preserved exactly (same path as before the crash).
- Git status widget renders correctly in the UI.
- Existing worktrees are reused — not recreated.

**Coverage:** manual only
