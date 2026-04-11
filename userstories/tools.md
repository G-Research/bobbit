# Tools — User Stories

The tools page lets users browse, configure, and control every capability available to agents — file editing, shell commands, web search, MCP integrations, and more. These stories cover the tools list, policy management, tool guard dialogs, MCP discovery, custom tool creation, and in-session tool rendering.

---

## TL-01: View tools list

**Preconditions:** At least one project registered. Tools page loaded (`#/tools`).

**Steps and expectations:**
1. Navigate to the Tools page.
   - A loading spinner appears briefly while tools are fetched.
   - Tools render grouped by category in a fixed order: File System, Shell, Web, Browser, Agent, Team, Tasks, Gates, Other.
   - Any extra groups (e.g. MCP server groups) appear after the standard groups.
2. Observe all groups on initial load.
   - Every group is collapsed by default. Each group header shows: chevron icon, group name, tool count badge (e.g. "6 tools"), and a "Group Policy" dropdown.
3. Click a group header (e.g. "File System").
   - The group expands. Tool rows appear, each showing: tool name (bold), origin badge, and description (muted text).
   - Origin badges: grey for builtin, blue for server-level, green for project-level.
4. Click the same group header again.
   - The group collapses. Tool rows are hidden.
5. Observe MCP tools when an MCP server is configured.
   - MCP-provided tools appear under a group named after their server (e.g. "playwright").
   - No manual per-tool registration was needed — they were auto-discovered.
6. Register a second project. Return to the Tools page.
   - A scope selector row appears above the tool list showing "System" and each project name.
   - Switching scope reloads the tool list for that context. All groups re-collapse on scope change.
7. With only one project registered, no scope selector appears.

**Coverage:** partial — tools list renders in E2E (`tools-e2e.spec.ts`) but grouping, badges, collapse state, and multi-project scope are not validated

---

## TL-02: Edit tool config

**Preconditions:** Tools page loaded, at least one tool visible in an expanded group.

**Steps and expectations:**
1. Click a tool row (e.g. "bash" in the Shell group).
   - The view switches to a detail/edit view for that tool.
   - A back arrow button is visible to return to the list.
   - The edit view shows tabs: "Access" (default) and optionally "Docs" / "Preview".
2. On the Access tab, observe the "Default Grant Policy" section.
   - A dropdown shows the current per-tool policy: "Use group default", "Allow", "Ask", or "Never".
   - When set to "Use group default", a hint shows the resolved value (e.g. "→ Allow [from group]").
3. Change the policy dropdown from "Use group default" to "Ask".
   - The hint text disappears (explicit policy overrides the group).
4. Click "Save".
   - A saving indicator appears briefly. Changes are persisted to the server.
5. Navigate back to the list, then re-open the same tool.
   - The policy dropdown still shows "Ask" — the change was persisted.
6. Start a new session and ask the agent to use "bash".
   - The agent triggers a permission dialog (because the tool is now set to "Ask").
7. Existing sessions that were already running when the change was made are unaffected — they keep the original policy.
8. Click the back arrow from the edit view.
   - Returns to the tool list. Group collapse state is preserved.

**Coverage:** API only — `tool-policy.spec.ts` and `tools-cascade.spec.ts` test policy resolution; no browser E2E for the edit page

---

## TL-03: Change group policy

**Preconditions:** Tools page loaded with groups visible (collapsed).

**Steps and expectations:**
1. Observe the "Group Policy" dropdown on the Shell group header.
   - Default value is "Allow (default)".
   - Other options: "Allow", "Ask", "Never".
2. Click the dropdown (not the group header itself).
   - The dropdown opens without toggling the group's collapse state (click propagation is stopped).
3. Select "Ask".
   - The dropdown updates to "Ask". The change is persisted to the server immediately (no separate Save button).
4. Expand the Shell group. Click a tool to open its edit view.
   - Tools with "Use group default" now resolve to "Ask" — the hint reads "→ Ask [from group]".
5. Change the group policy to "Never".
   - All tools in the group with "Use group default" policy are now hidden from agents in new sessions.
6. Start a new session. Ask the agent to run a shell command.
   - The agent cannot see or use Shell tools (they are blocked by the "Never" policy).
7. An existing session that was created before the policy change still has the old policy — its Shell tools remain available.
8. Change the group policy back to "Allow (default)".
   - Tools resolve to allow again for new sessions.

**Coverage:** API only — `tool-policy.spec.ts` covers resolution logic; `tools-cascade.spec.ts` covers cascade; no browser E2E for group policy dropdown

---

## TL-04: Tool guard (ask policy)

**Preconditions:** Active session. At least one tool has its policy set to "ask" (either per-tool or via group policy).

**Steps and expectations:**
1. Ask the agent to perform an action that invokes the guarded tool (e.g. "run `rm -rf /tmp/test`" when Shell group is set to "ask").
   - The agent attempts to call the tool. Execution pauses.
   - A permission dialog appears in the chat stream, showing the tool name and a preview of the input (e.g. the command to be run).
2. Click "Allow".
   - The tool executes this one time. The result appears in chat.
   - The next invocation of the same tool will prompt again.
3. Trigger the tool again. This time click "Deny".
   - The tool does not execute. The agent receives a denial message and adjusts its plan.
   - No error is thrown — the agent is informed gracefully.
4. Trigger the tool again. Click "Allow for session".
   - The tool executes. For the remainder of this session, the tool runs without prompting.
   - A guard extension file is written to `.bobbit/state/tool-guard/`.
5. Start a new session and trigger the same tool.
   - The permission dialog appears again — "Allow for session" did not persist across sessions.
6. In the new session, click "Allow always".
   - The tool executes and the policy is upgraded permanently. No future sessions prompt for this tool.
7. Dismiss the dialog by clicking outside it or pressing Escape.
   - The dialog closes. The tool invocation is denied (same as clicking "Deny").

**Coverage:** covered — `tool-ask-policy.spec.ts` (UI dialog flow), `tool-guard-ask-policy.spec.ts` (API permission flow with guard files)

---

## TL-05: MCP tool discovery

**Preconditions:** An MCP server is configured (e.g. `playwright` in `.mcp.json` at project or system level).

**Steps and expectations:**
1. Navigate to the Tools page.
   - MCP tools appear grouped under their server name (e.g. a "playwright" group with tools like `browser_click`, `browser_snapshot`).
   - No manual tool definitions were required — tools were auto-discovered from the MCP server's tool manifest.
2. Expand the MCP group.
   - Each tool shows its name, auto-generated description, and a builtin origin badge.
3. Click an MCP tool to open its edit view.
   - The detail view shows the tool's parameters and description as reported by the MCP server.
   - The Access tab allows setting a per-tool policy override (same as builtin tools).
4. Start a session. Ask the agent to use an MCP tool (e.g. "take a screenshot of the page").
   - The agent discovers and invokes the MCP tool. The tool card renders in chat with the MCP tool name.
5. Register a second project with its own `.mcp.json` containing a different MCP server.
   - Switch scope on the Tools page to the second project.
   - The second project's MCP tools appear. The first project's MCP tools do not appear in this scope.
6. Switch scope to "System".
   - Only system-level MCP tools appear (if any). Project-scoped MCP tools are excluded.
7. Remove the MCP server configuration and reload the Tools page.
   - The MCP group disappears. Tools from that server are no longer available.

**Coverage:** partial — `mcp-integration.spec.ts` tests MCP server connection; `mcp-unit.spec.ts` tests schema conversion; multi-project MCP scope not covered

---

## TL-06: Create custom tool

**Preconditions:** Tools page loaded.

**Steps and expectations:**
1. Click the "New Tool" button (Plus icon) at the top of the tools list.
   - A creation form appears with fields: name (required), description (required), group selector (dropdown of standard groups), and documentation text area.
2. Fill in the name field with "my-custom-tool" and a description.
   - Name field accepts lowercase alphanumeric and hyphens.
3. Select a group from the dropdown (e.g. "Shell").
4. Click "Save".
   - The tool is persisted. The view returns to the tool list.
   - The new tool appears in the selected group with a project-level origin badge (green).
5. Expand the group and click the new tool.
   - The edit view opens showing the saved name, description, and group.
6. Start a new session.
   - The custom tool is available to the agent in the tool list.
7. Navigate to a different project scope and check the tools list.
   - The custom tool does not appear — it is scoped to the project where it was created.
8. Return to the original project scope. Open the custom tool's edit view. Delete it (if delete is available) or revert the override.
   - The tool disappears from the list.

**Coverage:** API only — no browser E2E for the creation form or custom tool lifecycle

---

## TL-07: Tool execution in session

**Preconditions:** Active session with a connected agent.

**Steps and expectations:**
1. Ask the agent to perform an action that invokes a tool (e.g. "list the files in the src directory").
   - A tool card appears in the chat stream while the tool executes.
   - The card shows: tool name (e.g. "ls"), and a preview of the input parameters (e.g. `path: "src"`).
2. The tool completes.
   - The result appears inside the tool card (e.g. the file listing).
   - The card is collapsed by default for long results — only a truncated preview is visible.
3. Click the tool card to expand it.
   - Full input parameters and full result text are revealed.
4. Click the tool card again to collapse it.
   - The card collapses back to the truncated preview.
5. Ask the agent to perform multiple tool calls in sequence (e.g. "read package.json and then run npm test").
   - Each tool call renders as a separate card in chronological order within the agent's turn.
   - Cards appear as the tools execute, not all at once after the turn completes.
6. Ask the agent to use a tool that produces an error (e.g. "read a file that doesn't exist").
   - The tool card shows the error result. The agent sees the error and adjusts.
   - No UI crash or unhandled exception.
7. During tool execution, the tool card shows a loading/in-progress indicator.
   - Once the tool completes, the indicator is replaced by the result.

**Coverage:** API-level — tool execution events tested via API (`tools-e2e.spec.ts`); `tool-docs-prompt.test.ts` tests tool docs generation; no browser E2E for visual tool card rendering
