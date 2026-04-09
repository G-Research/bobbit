# Tools — User Stories

## TL-01: View tools list

**As a** user  
**I want to** navigate to `#/tools` and see all available tools  
**So that** I can understand what tools are available and their current access policies

### Acceptance Criteria

- Navigating to `#/tools` displays all tools grouped by their `group` field.
- Each tool entry shows its **name**, **description**, and a **policy badge**: green for `allow`, yellow for `ask`, red for `never`.
- Each tool displays an **origin badge**: grey for builtin, blue for server, green for project.
- MCP tools are listed under their server group as "MCP: \<serverName\>" — auto-discovered from `.mcp.json`, no YAML needed.
- When multiple projects are registered, a **project scope row** appears above the list.

### Technical Notes

- MCP tools auto-generate documentation on connect: one-line summary (≤120 chars) and full Markdown reference at `.bobbit/state/mcp-tool-docs/<serverName>.md`.
- In multi-project setups, MCP servers from **all** registered projects are discovered.
- Shared UI code in `config-scope.ts` and `config-scope.css`.

### Coverage

**Partial.** The tools list page renders, but E2E tests do not fully validate grouping, policy badges, MCP tool display, or multi-project scope.

---

## TL-02: Edit tool config

**As a** user  
**I want to** edit a tool's YAML configuration  
**So that** I can customize its description, summary, or provider settings

### Acceptance Criteria

- Clicking a tool navigates to its detail/edit page.
- The user can edit the tool's YAML fields: **description**, **summary**, **provider** config.
- On save, the YAML file is updated in place.
- New sessions pick up the changes; existing sessions are unaffected.
- `updateToolMetadata()` modifies the tool in-place (tools are still copied from defaults, unlike other config types).

### Technical Notes

- REST: `PUT /api/tools/:name` with YAML/JSON body.
- Tools are copied from defaults (not resolved via cascade at runtime like roles) because they contain provider configs and extension code that `updateToolMetadata()` modifies in-place.

### Coverage

**API only.** No browser E2E test for the tool edit page.

---

## TL-03: Change group policy

**As a** user  
**I want to** change the access policy for a tool group  
**So that** I can control which tools require approval before execution

### Acceptance Criteria

- Editing `.bobbit/config/tool-group-policies.yaml` or using the API sets group-level policies.
- Three policy values: `allow` (immediate execution), `ask` (guard blocks — user prompted), `never` (tool not registered for the session).
- Policy resolution order: **role+tool → role+group → tool default → group default → `allow`**.
- Policy changes affect new sessions only.

### Technical Notes

- Per-group policies: `.bobbit/config/tool-group-policies.yaml`.
- Per-role policies: `toolPolicies` field in role YAML.
- Resolution chain implemented in session setup pipeline's `resolveToolActivation` step.

### Coverage

**API only.** No browser E2E test for policy editing or resolution verification.

---

## TL-04: Tool guard (ask policy)

**As a** user  
**I want to** be prompted for approval when an agent attempts to use a guarded tool  
**So that** I maintain control over sensitive operations

### Acceptance Criteria

- When an agent attempts a tool with `ask` policy, execution pauses and a permission dialog appears in the UI.
- The dialog shows the **tool name**, **group**, and **input preview**.
- The user can choose:
  - **Allow** — grants permission for this single invocation (sends `grant_tool_permission` WS message).
  - **Deny** — blocks the invocation (sends `deny_tool_permission` WS message).
  - **Allow for session** — grants permission for all future uses of this tool in this session.
  - **Allow always** — persists the permission to the policy file for all future sessions.
- The permission request uses long-polling via `POST /api/sessions/:id/tool-grant-request`.

### Technical Notes

- Server-side: `sandbox-guard.ts` handles permission state.
- Client-side: tool guard UI renders in the chat message area.
- WS messages: `grant_tool_permission`, `deny_tool_permission`.

### Coverage

**Covered (3 tests).** E2E tests validate the tool guard flow including allow, deny, and session-scoped permissions.

---

## TL-05: MCP tool discovery

**As a** user  
**I want** MCP tools to be automatically discovered from configured servers  
**So that** I don't need to manually define YAML for MCP-provided tools

### Acceptance Criteria

- MCP servers configured in `.mcp.json` (project level), `.bobbit/config/mcp.json` (overrides), or any of 7 discovery locations are auto-discovered.
- Discovered tools appear in the tools list under "MCP: \<serverName\>" groups.
- No YAML definition is needed for MCP tools.
- In multi-project setups, MCP servers from **all** registered projects are discovered.
- Auto-generated documentation includes summaries (cached with content hashing) and full Markdown reference files.

### Technical Notes

- Discovery locations: see `docs/internals.md#mcp-servers` for the full priority list.
- Summaries cached at `.bobbit/state/mcp-tool-docs/<serverName>.cache.json`.
- Full docs at `.bobbit/state/mcp-tool-docs/<serverName>.md`.
- System prompt uses a single `# Tools` section with per-group summaries — MCP groups link to their auto-generated docs.

### Coverage

**Partial.** MCP discovery is tested in E2E (browser project tests with MCP enabled) but not all 7 discovery locations or multi-project aggregation are covered.

---

## TL-06: Create custom tool

**As a** user  
**I want to** create a new custom tool via the UI  
**So that** I can extend the tool set with project-specific capabilities

### Acceptance Criteria

- Clicking "New Tool" opens a creation form.
- The user defines the tool via YAML with required fields: **name**, **description**, **provider** (`builtin`, `bobbit-extension`, or `mcp`).
- Optional fields: **summary**, **group**.
- On save, the YAML is written to `.bobbit/config/tools/<group>/<name>.yaml`.
- The new tool appears in the tools list and is available in sessions.
- If `provider` is `bobbit-extension`, the group's `extension.ts` is loaded for execution logic.

### Technical Notes

- REST: `POST /api/tools` or via `propose_tool` tool call.
- Extension code lives in the tool group's `extension.ts` file.

### Coverage

**API only.** No browser E2E test for the tool creation form.

---

## TL-07: Tool execution in session

**As a** user  
**I want to** see tool executions rendered in the chat when an agent uses a tool  
**So that** I can follow what the agent is doing and inspect tool inputs/outputs

### Acceptance Criteria

- When an agent calls a tool, a `tool_execution_start` event fires and a **tool card** appears in the chat.
- The tool card shows the **tool name** and a preview of the **input** parameters.
- On completion, `tool_execution_end` fires and the **result** is displayed in the card.
- Tool renderers provide appropriate UI (collapsible details, syntax highlighting, etc.) — custom renderers registered in `src/ui/tools/index.ts`.
- Pending tool calls are tracked and visually indicated.

### Technical Notes

- Tool renderers: `src/ui/tools/renderers/` — registered in `src/ui/tools/index.ts`.
- `ProposalRenderer.ts` demonstrates the `withToolName()` factory pattern for multi-tool renderers.
- Streaming tool results are batched via rAF to avoid UI jank.

### Coverage

**API-level.** Tool execution events are tested via the API/WS protocol but no browser E2E test validates the visual rendering of tool cards in the chat UI.
