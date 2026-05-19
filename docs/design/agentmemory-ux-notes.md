# AgentMemory settings UX notes

## Principles

- Default off and unsurprising: no tools, injection, capture, or managed process until enabled.
- Plain-language UI: say “Agent Memory”, “Managed by Bobbit”, “Existing local server”, and “Tools only” instead of MCP/iii-engine-first language.
- Always show where data goes, whether capture/injection is active, and whether Bobbit is managing a process.
- Show actionable next steps for unavailable service states; avoid raw stack traces.

## Navigation and placement

System settings currently live in `src/app/settings-page.ts` with tabs declared in `SYSTEM_TABS`; project scoped tabs use `PROJECT_TABS`; route tab IDs are typed in `src/app/routing.ts`.

Add:

- System `Memory` tab: `#/settings/system/memory`.
- Project `Memory` tab or section: `#/settings/<projectId>/memory`.
- General toggle near the existing Subgoals experimental toggle.

General toggle copy:

> Agent Memory — Experimental
> Enable persistent cross-session memory for agents. Agents can search/save memories; projects can opt into automatic prompt recall and capture.

If toggled on and `agentMemoryMode` is null, open the first-enable wizard immediately. If the wizard is cancelled, leave enabled off or return to the previous value.

## First-enable wizard

A modal with three cards:

1. **Use existing local server**
   - Subtitle: “Connect to AgentMemory already running at `http://127.0.0.1:3111`.”
   - Show detected health inline when available.
   - Primary action: “Use existing server”.

2. **Managed by Bobbit**
   - Subtitle: “Bobbit starts and stops AgentMemory for you.”
   - Disclosure: “AgentMemory may store data in `~/.agentmemory` unless configured otherwise. Bobbit will not run Docker or installers without asking.”
   - Primary action: “Let Bobbit manage it”.

3. **Tools only / MCP fallback**
   - Subtitle: “Expose compatible memory tools without automatic recall or capture.”
   - Mark as advanced/fallback.

Footer links/buttons:

- “Learn what is captured” opens the Memory tab privacy section.
- “Cancel” leaves Agent Memory disabled.

Persist selection through `/api/agentmemory/settings`. Do not start managed mode automatically until the user clicks Start or confirms in the managed card.

## System Memory tab

Sections:

### Status card

Fields:

- Enabled/off
- Mode: External / Managed by Bobbit / Tools only
- Health: Healthy / Unreachable / Degraded / Not started / Disabled
- Server URL
- Viewer link when known
- Capture default: on/off
- Prompt injection default: on/off, with note that project can override
- Last checked timestamp

Use status colors from theme semantic classes/variables. Keep raw errors collapsed behind “Details”.

### Mode and connection

- Mode selector cards matching the wizard.
- External URL input, default `http://127.0.0.1:3111`.
- Secret/token field with “Set/Replace” and “Remove”; never echo the stored secret.
- Test connection button:
  - Success: “Connected to AgentMemory.”
  - Failure: “Could not reach AgentMemory at … Start it or switch to Managed by Bobbit.”

### Managed controls

Visible when mode is managed:

- Start / Stop / Restart buttons.
- Process state and PID if available.
- Logs tail with redacted content.
- Configured package/path and data directory.
- Warning: “Bobbit will not run Docker or install iii-engine without confirmation.”
- If prerequisites are missing, show specific next action rather than a stack trace.

### Defaults

Controls:

- Auto-capture summaries: default on when enabled.
- Global fallback: default on.
- Default prompt injection: default off.
- Token budget: number/range 200..4000, default 1200.

### Test recall

- Query input and project selector/current project hint.
- Search button calls `/api/agentmemory/search`.
- Results grouped under `Project memory` then `Global memory`.
- Empty state: “No relevant memories found.”
- Disabled state: “Enable Agent Memory to test recall.”

### Privacy explanation

Short text:

- Agents may save durable decisions/preferences when tools are enabled.
- Auto-capture sends bounded summaries at agent end, not full transcripts or raw tool outputs.
- Secrets are redacted before save/capture.
- Project settings can pause capture and prompt injection.

## Project Memory settings

Controls should save to project config keys:

- `agentmemory.enabled`: inherit / on / off.
- `agentmemory.inject`: inherit / on / off.
- `agentmemory.autoCapture`: inherit / on / off.
- `agentmemory.scope`: Project + global / Project only / Global only.
- `agentmemory.projectKey`: optional text override with helper text “Defaults to the project id/name.”
- `agentmemory.tokenBudget`: inherit or explicit 200..4000.

Show a resolved summary at the top:

- “Agent Memory is enabled for this project” or “Disabled because system setting is off.”
- “Prompt recall is on/off.”
- “Capture summaries is on/off.”
- “Scope: project + global.”

Project test recall mirrors the system tab but uses the resolved project key/scope.

## Error and empty states

- Disabled: “Agent Memory is off. Enable it in General settings.”
- Mode not chosen: “Choose how Bobbit should connect to AgentMemory.”
- External unreachable: “No server responded at … Start AgentMemory or choose Managed by Bobbit.”
- Managed stopped: “AgentMemory is configured for Bobbit management but is not running.”
- Unsafe remote token: “For non-local HTTP URLs, use HTTPS before saving a token.”
- MCP-only: “Automatic recall and capture are unavailable in tools-only mode.”

## Test IDs

Add stable browser E2E hooks:

- `general-agentmemory-enabled`
- `agentmemory-setup-dialog`
- `agentmemory-mode-external`, `agentmemory-mode-managed`, `agentmemory-mode-mcp-only`
- `agentmemory-test-connection`
- `agentmemory-status-card`
- `agentmemory-secret-set`, `agentmemory-secret-remove`
- `agentmemory-managed-start`, `agentmemory-managed-stop`
- `project-agentmemory-enabled`, `project-agentmemory-inject`, `project-agentmemory-scope`
- `agentmemory-test-query`, `agentmemory-test-results`

## Browser E2E scenarios

1. Toggle Agent Memory on from General; wizard opens; choosing External persists across reload.
2. Memory tab test connection uses mocked healthy/unhealthy endpoint and shows actionable copy.
3. Project Memory settings toggle injection/scope/capture and persist across reload.
4. Test recall renders project/global headings in order.
5. Managed mode controls show start/stop state with mocked process manager and never auto-start without explicit action.
