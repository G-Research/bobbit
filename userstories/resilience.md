# Resilience — User Stories

These stories cover crash/restart scenarios: server hard-kills, container deaths, and recovery of sessions, goals, worktrees, and sandboxes. All stories require `tests/manual-integration/` — they cannot run in normal E2E tests because they involve real process termination and restart.

---

## RE-01: Single session survives server crash

**Preconditions:** Server running via `npm run dev:harness`. One active session open in the browser with at least 3 exchanged messages (user + agent turns). Session has a non-empty working directory.

**Steps and expectations:**
1. Send a message "ping before crash" in the active session.
   - Message appears in chat as a user turn.
   - Agent responds. Response fully streams and completes.
2. Note the session name in the sidebar and the number of visible messages.
   - Sidebar shows the session with its title.
3. Kill the server process (hard kill — `kill -9`, not graceful shutdown).
   - The browser shows a "Disconnected" or "Reconnecting…" indicator in the UI.
   - No data loss toast or error modal appears yet (server is simply gone).
4. Restart the server (`npm run restart-server` or re-launch harness).
   - The browser automatically reconnects (WebSocket reconnect loop).
   - "Disconnected" indicator disappears once connected.
5. Verify the sidebar after reconnection.
   - The session appears in the sidebar with the same title as before.
   - Session is not archived or marked as errored.
6. Click the session to open it.
   - All previous messages are visible, including "ping before crash" and its response.
   - Message order is preserved. No duplicates. No missing turns.
   - Scroll position may reset to bottom (acceptable).
7. Type "ping after crash" and press Enter.
   - Message sends successfully. Agent responds normally.
   - The session is fully functional — no stale state or broken pipes.
8. Check the git status widget (if the session has a git working directory).
   - Git branch name is correct. Git status loads without error.

**Edge case:** If the agent was mid-stream when the server was killed, the partial response is preserved up to the last flushed chunk. The response may appear truncated but is not lost entirely.

**Coverage:** manual-integration (session-resilience.spec.ts)

---

## RE-02: Goal and dashboard survive server crash

**Preconditions:** Server running. A goal exists with at least one spawned team agent, at least one gate signaled (status `passed` or `failed`), and at least one task in `in-progress` state. The goal dashboard is open in the browser.

**Steps and expectations:**
1. Note the current state: goal title, gate statuses, task list, and team agent list on the dashboard.
   - Dashboard renders all sections: gates, tasks, team.
2. Kill the server process (hard kill).
   - Dashboard shows a connection-lost state (grayed out or reconnecting indicator).
3. Restart the server.
   - Browser reconnects. Dashboard refreshes.
4. Verify the goal appears in the sidebar.
   - Goal is listed with its original title.
   - Goal status is unchanged (e.g., `active`, not reset to `draft`).
5. Open the goal dashboard.
   - Gate statuses match pre-crash state: passed gates still show passed, failed still show failed, pending still show pending.
   - Task list shows the same tasks with the same states. `in-progress` tasks remain `in-progress`.
   - Team agent list shows previously spawned agents. Their status reflects reality — agents killed by the crash show as disconnected or errored, not as running.
6. Spawn a new team agent or send a prompt to an existing one.
   - The goal system is fully operational. New agents can be spawned. Tasks can be updated.
7. Signal a pending gate.
   - Gate transitions to `verifying` and then to `passed` or `failed`. The workflow engine is functional.

**Edge case:** If the server crashed during goal creation (mid-setup), the goal may appear with an error status and a "Retry" button on the dashboard. Clicking Retry re-runs the setup.

**Coverage:** manual-integration (session-resilience.spec.ts)

---

## RE-03: Multiple sessions of different types survive restart

**Preconditions:** Server running. At least 5 sessions exist: (a) a plain session (no git), (b) a worktree session with uncommitted changes, (c) a goal session with a team agent, (d) a session with 50+ messages, (e) a recently created session with only 1 message. All sessions are visible in the sidebar.

**Steps and expectations:**
1. Record each session's title, type indicator, and message count.
2. Kill the server process (hard kill).
3. Restart the server. Wait for the browser to reconnect.
4. Verify all 5 sessions appear in the sidebar.
   - Same titles. Same ordering (most-recent-activity first).
   - No sessions missing. No sessions duplicated.
5. Open the plain session (a).
   - Messages are intact. Can send a new message.
6. Open the worktree session (b).
   - Messages are intact. Git branch is the same as before.
   - Uncommitted changes are still present (run `git status` via the agent or check the git status widget).
   - The worktree directory on disk was not deleted or modified by the restart.
7. Open the goal session (c).
   - Messages intact. Goal dashboard accessible from the session.
8. Open the large session (d) with 50+ messages.
   - All messages load. Scrolling through history works. No truncation.
9. Open the minimal session (e).
   - Single message is present.
10. Send a follow-up message in each session.
    - All 5 sessions accept new messages and produce agent responses.

**Edge case:** If a worktree session's `.jsonl` file is missing or corrupted on disk, that session is skipped during restore — it will not appear in the sidebar. Other sessions are unaffected (no all-or-nothing failure).

**Coverage:** manual-integration (session-resilience.spec.ts)

---

## RE-04: Worktree preservation across crash

**Preconditions:** Server running. A worktree session exists at `<project-root>-wt-session/<session-id>/`. The worktree has a branch checked out (e.g., `session/my-feature`) with at least one uncommitted file and one committed-but-unpushed commit.

**Steps and expectations:**
1. In the worktree session, verify the branch name in the git status widget.
   - Shows the correct branch (e.g., `session/my-feature`).
2. Note the uncommitted file and the unpushed commit SHA.
3. Kill the server process (hard kill).
4. Verify the worktree directory still exists on disk.
   - `ls <project-root>-wt-session/<session-id>/` shows the project files.
   - The uncommitted file is present with its changes.
   - `git log --oneline -1` in the worktree shows the unpushed commit.
   - `git branch` shows the same branch checked out.
5. Restart the server. Wait for reconnection.
6. Open the worktree session in the browser.
   - Session loads with all previous messages.
   - Git status widget shows the correct branch name.
   - The agent's working directory is the worktree path (not the primary worktree).
7. Ask the agent to run `git status`.
   - Output shows the uncommitted file. The unpushed commit is in the log.
   - The worktree is in the exact same state as before the crash.
8. Make a new edit and commit it.
   - Git operations work normally in the worktree. No "detached HEAD" or ref errors.

**Edge case:** If the worktree directory was manually deleted while the server was down, the session restores but the agent will see file-not-found errors when it tries to access the working directory. The session itself is not lost — only the worktree is gone.

**Coverage:** manual-integration (session-resilience.spec.ts)

---

## RE-05: Docker sandbox container recovery

**Preconditions:** Server running. A project configured with `sandbox: "docker"`. At least one active session using the sandbox container. The container is running (verify via `GET /api/sandbox-status` or `docker ps`).

**Steps and expectations:**
1. Send a command through the session that executes inside the container.
   - Command succeeds. Output returns normally.
2. Kill the Docker container externally (`docker kill <container-id>`).
   - The server detects container death within ~30 seconds.
   - `GET /api/sandbox-status` transitions from `running` to `stopped` or `restarting`.
3. Wait up to 60 seconds for auto-recovery.
   - The server automatically recreates the container.
   - `GET /api/sandbox-status` returns `running` again.
   - The container has the same project label (`bobbit-project=<projectId>`).
4. Return to the session and send another command.
   - Command executes inside the new container. Output returns normally.
   - The session did not need to be restarted or re-created.
5. Verify worktree mounts inside the container.
   - If the session had a worktree, it is mounted at the same path in the new container.
   - Files in the worktree are accessible from inside the container.

**Edge case:** If Docker itself is unavailable (daemon stopped), recovery fails. The sandbox status shows an error. Sessions continue to exist but commands that require the container will fail with a clear error message. The session is not automatically archived — the user can retry once Docker is available.

**Coverage:** manual-integration — skips automatically when Docker is unavailable

---

## RE-06: Crash during session setup

**Preconditions:** Server running. The user is about to create a new session. The server will be killed during the setup phase (after the session record is created but before the agent is fully initialized).

**Steps and expectations:**
1. Click "New Session" in the sidebar.
   - The UI shows a loading/connecting state for the new session.
2. Immediately kill the server process (hard kill) while the session is still initializing.
   - The browser shows a disconnected state.
3. Restart the server.
4. Check the sidebar after reconnection.
   - **Case A:** The session was persisted to `sessions.json` before the crash — it appears in the sidebar, possibly in an error or uninitialized state. Opening it may show no messages or a setup-failed indicator.
   - **Case B:** The session was not persisted before the crash — it does not appear in the sidebar. This is expected. No orphan data is left behind.
5. In Case A, try sending a message in the recovered session.
   - The session either recovers and accepts the message, or shows a clear error with a way to archive/delete it.
6. Create a brand-new session.
   - Session creation works normally. The crash during the previous setup did not corrupt any global state.
   - Other existing sessions are unaffected and fully functional.

**Edge case:** If the crash occurs during worktree creation (`git worktree add`), an orphaned worktree directory may remain on disk. This is cleaned up via Settings → Maintenance → "Orphaned Worktrees" scan.

**Coverage:** manual-integration (session-resilience.spec.ts)

---

## RE-07: Queued messages delivered after reconnection

**Preconditions:** Server running. An active session is open in the browser with a working agent.

**Steps and expectations:**
1. Kill the server process (hard kill).
   - Browser shows disconnected state.
2. While the server is down, type "message while offline" in the textarea and press Enter.
   - The UI either queues the message locally (shows a pending/unsent indicator) or shows an error that the message could not be sent.
3. Restart the server. Wait for reconnection.
4. **If the message was queued:** it is delivered automatically after reconnection.
   - The message appears in chat as a sent user turn.
   - The agent processes it and responds.
5. **If the message was rejected:** the textarea still contains the typed text (draft preservation).
   - The user can press Enter again to re-send now that the connection is restored.
   - The message sends successfully and the agent responds.
6. Verify that no duplicate messages were sent.
   - The chat history shows exactly one copy of "message while offline".

**Edge case:** If the user sends multiple messages while offline, they are either all queued (delivered in order on reconnection) or all rejected (drafts preserved). There is no partial delivery.

**Coverage:** manual-integration (session-resilience.spec.ts)

---

## RE-08: Rapid crash-restart cycle stability

**Preconditions:** Server running. At least 3 active sessions with messages. A goal with gates and tasks exists.

**Steps and expectations:**
1. Kill the server and immediately restart it.
2. As soon as the server is up (~2 seconds), kill it again.
3. Restart the server a third time. Wait for it to fully initialize.
   - Server starts without errors. No crash loop. No corrupted state files.
4. Check the sidebar.
   - All 3 sessions appear. Titles and ordering are correct.
5. Open each session.
   - Messages are intact in all sessions. No data loss from the rapid restart cycle.
6. Check the goal dashboard.
   - Goal, gates, and tasks are intact with correct statuses.
   - No duplicate gates or tasks from double-initialization.
7. Send a message in one of the sessions.
   - Agent responds normally. Full functionality is restored.

**Edge case:** If `sessions.json` is written partially (e.g., crash mid-write), the server should handle the corrupt file gracefully on startup — either by using a backup, recovering valid entries, or logging a clear error. Individual corrupted entries are skipped; valid sessions are still restored.

**Coverage:** manual-integration (session-resilience.spec.ts)
