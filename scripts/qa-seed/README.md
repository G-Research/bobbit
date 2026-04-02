# QA Seed Script

Generates realistic fixture data for Bobbit QA ephemeral environments.

## Usage

```bash
node scripts/qa-seed/seed.mjs <WORK_DIR>
```

The script writes all state files into `<WORK_DIR>/.bobbit/state/` and config files into `<WORK_DIR>/.bobbit/config/`. All file paths (e.g., `agentSessionFile` in `sessions.json`) use absolute paths derived from `WORK_DIR`.

## What it creates

| File | Description |
|---|---|
| `projects.json` | 1 registered project pointing at WORK_DIR |
| `project.yaml` | Minimal project config in `.bobbit/config/` |
| `sessions.json` | 3 archived sessions (goal assistant, coder, reviewer) |
| `goals.json` | 1 goal in `in-progress` state with frozen `feature` workflow |
| `gates.json` | 4 gates — design-doc (passed), implementation (passed), documentation (pending), ready-to-merge (pending) |
| `tasks.json` | 3 complete tasks (design doc, implementation, code review) |
| `team-state.json` | 1 team entry with coder and reviewer agents |
| `messages/coder.jsonl` | Coder session messages with Read, Edit, Bash, gate_signal, task_update tool calls |
| `messages/reviewer.jsonl` | Reviewer session messages with verification_result tool call |

## JSONL format

Message files use the pi-ai library format (NOT Anthropic wire format):

- `AssistantMessage.content` is an array of `TextContent | ToolCall` objects
- Tool calls use `type: "toolCall"` with `arguments` (not `type: "tool_use"` with `input`)
- `ToolResultMessage` has top-level `toolCallId`, `toolName`, `isError` fields
- All messages require a `timestamp` field

## Integration

Called automatically during QA setup in `.claude/skills/qa-test/SKILL.md` Step 2:

```bash
node "$REPO/scripts/qa-seed/seed.mjs" "$WORK_DIR"
```

## Updating

When store formats change, update `seed.mjs` in the same PR. Run and verify:

```bash
node scripts/qa-seed/seed.mjs /tmp/test-seed
cat /tmp/test-seed/.bobbit/state/sessions.json | python -m json.tool
```
