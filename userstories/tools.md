# Tools

## TL-01: View tools list

**Preconditions:** App loaded.

**Steps:**
1. Navigate to #/tools

**Expected:**
- Tools grouped by category
- Each tool shows name, description, policy badge
- Origin badges for cascaded tools

**Coverage:** `tests/e2e/tools-e2e.spec.ts` (API). `tests/e2e/ui/config-scope.spec.ts` (partial badges).

---

## TL-02: Edit tool configuration

**Preconditions:** On tools page.

**Steps:**
1. Click a tool
2. Edit YAML (description, policy, provider config)
3. Save

**Expected:**
- YAML updated on disk
- New sessions pick up changes
- Tool metadata refreshed

**Coverage:** `tests/e2e/tools-e2e.spec.ts` (API). No UI edit test.

---

## TL-03: Change tool group policy

**Preconditions:** Tools page loaded.

**Steps:**
1. Find tool group
2. Change policy (allow/ask/never)
3. Save

**Expected:**
- Policy applied to all tools in group
- New sessions respect new policy
- Existing sessions unaffected

**Coverage:** `tests/e2e/tool-policy.spec.ts` (API). No UI test.

---

## TL-04: Tool guard interaction (ask policy)

**Preconditions:** Tool set to "ask" policy, active session.

**Steps:**
1. Agent attempts guarded tool
2. Permission dialog appears
3. User grants/denies

**Expected:**
- Dialog shows tool name, group, and input preview
- Grant: tool executes, response continues
- Deny: agent informed, adjusts
- "Always allow" persists for session

**Coverage:** `tests/e2e/ui/tool-ask-policy.spec.ts` — 3 tests.

---

## TL-05: MCP tool discovery

**Preconditions:** MCP server configured in .mcp.json.

**Steps:**
1. Navigate to tools page
2. MCP tools listed under their server group

**Expected:**
- MCP tools appear with correct names/descriptions
- Policy applies to MCP tool group
- No YAML needed for MCP tools

**Coverage:** `tests/e2e/mcp-integration.spec.ts` (browser E2E). Partial.

---

## TL-06: Create custom tool

**Preconditions:** On tools page.

**Steps:**
1. Click "New Tool"
2. Define tool YAML (name, description, provider)
3. Save

**Expected:**
- Tool appears in list
- Available in sessions
- Extension code loaded if defined

**Coverage:** API-level only. No UI create test.

---

## TL-07: Tool used in session

**Preconditions:** Session active, tool available.

**Steps:**
1. Send message that triggers tool use
2. Agent calls tool
3. Tool result displayed

**Expected:**
- Tool execution card appears in chat
- Input/output visible in card
- Tool renderer shows appropriate UI (e.g. file diff, bash output)
- Collapsible tool details

**Coverage:** `tests/e2e/agent-tools-e2e.spec.ts` (API). Renderers tested in unit fixtures.
