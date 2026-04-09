# Tools — User Stories

## TL-01: View tools list

**As a** user
**I want to** see all available tools on the Tools page
**So that** I can understand what tools are available and their current access policies

### Acceptance Criteria

- The Tools page displays all tools grouped by category.
- Each tool shows its **name**, **description**, and a **policy indicator**: allow, ask, or never.
- Each tool displays an **origin badge**: grey for builtin, blue for server-level, green for project-level.
- MCP tools appear automatically under their server name — no manual setup needed per tool.
- When multiple projects are registered, a **scope selector** appears above the list.

### Coverage

**Partial.** The tools list page renders, but E2E tests do not fully validate grouping, policy indicators, MCP tool display, or multi-project scope.

---

## TL-02: Edit tool config

**As a** user
**I want to** edit a tool's configuration
**So that** I can customize its description or settings

### Acceptance Criteria

- Clicking a tool opens its detail/edit view.
- The user can edit the tool's fields (description, summary, settings).
- On save, changes are persisted.
- New sessions pick up the changes; existing sessions are unaffected.

### Coverage

**API only.** No browser E2E test for the tool edit page.

---

## TL-03: Change group policy

**As a** user
**I want to** change the access policy for a tool group
**So that** I can control which tools require approval before execution

### Acceptance Criteria

- A tool group's policy can be set to: **allow** (runs immediately), **ask** (user prompted each time), or **never** (tool hidden from agents).
- The policy applies to all tools in that group.
- Policy changes affect new sessions only; existing sessions keep their original policies.

### Coverage

**API only.** No browser E2E test for policy editing or verification.

---

## TL-04: Tool guard (ask policy)

**As a** user
**I want to** be prompted for approval when an agent attempts to use a guarded tool
**So that** I maintain control over sensitive operations

### Acceptance Criteria

- When an agent uses a tool set to "ask" policy, execution pauses and a **permission dialog** appears in the chat.
- The dialog shows the **tool name** and a preview of what the tool wants to do.
- The user can choose:
  - **Allow** — runs this one time.
  - **Deny** — blocks the tool, agent is told it was denied.
  - **Allow for session** — stops asking for this tool in the current session.
  - **Allow always** — stops asking permanently across all sessions.

### Coverage

**Covered.** E2E tests validate the tool guard flow including allow, deny, and session-scoped permissions.

---

## TL-05: MCP tool discovery

**As a** user
**I want** MCP tools to be automatically discovered from configured servers
**So that** I don't need to manually define each MCP-provided tool

### Acceptance Criteria

- MCP servers configured in the project or system settings are auto-discovered.
- Discovered tools appear in the tools list grouped under their server name.
- No manual per-tool configuration is needed.
- In multi-project setups, MCP servers from **all** registered projects are discovered.

### Coverage

**Partial.** MCP discovery is tested in E2E but not all discovery locations or multi-project aggregation are covered.

---

## TL-06: Create custom tool

**As a** user
**I want to** create a new custom tool
**So that** I can extend the tool set with project-specific capabilities

### Acceptance Criteria

- Clicking "New Tool" opens a creation form.
- The user defines the tool with at minimum a **name**, **description**, and **provider type**.
- On save, the tool appears in the tools list and is available in sessions.

### Coverage

**API only.** No browser E2E test for the tool creation form.

---

## TL-07: Tool execution in session

**As a** user
**I want to** see tool executions rendered in the chat when an agent uses a tool
**So that** I can follow what the agent is doing and inspect tool inputs/outputs

### Acceptance Criteria

- When an agent calls a tool, a **tool card** appears in the chat.
- The tool card shows the **tool name** and a preview of the **input**.
- On completion, the **result** is displayed in the card.
- Tool cards have collapsible details for longer inputs/outputs.

### Coverage

**API-level.** Tool execution events are tested via the API but no browser E2E test validates the visual rendering of tool cards in the chat.
