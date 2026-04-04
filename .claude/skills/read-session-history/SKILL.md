---
name: read-session-history
description: Read the conversation history of another Bobbit session (team agent, delegate, or archived session)
argument-hint: <session-id>
---

# Reading Session History

Read the full conversation history of another Bobbit session — a team agent, delegate, or archived session. This is useful when you need to understand what another agent did, debug failures, or extract information from completed work.

## How session history is stored

Each session's conversation is stored in a JSONL file (one JSON object per line). The file path is recorded in the session metadata as `agentSessionFile`.

## Step 1: Locate the session's JSONL file

### Option A: Via the REST API (preferred)

```bash
TOKEN=$(cat /tmp/session-prompts/.token 2>/dev/null || cat .bobbit/state/token 2>/dev/null)
GATEWAY=${BOBBIT_GATEWAY_URL:-https://host.docker.internal:3001}

# Get session metadata — the agentSessionFile field has the JSONL path
curl -sk "$GATEWAY/api/sessions/<session-id>" -H "Authorization: Bearer $TOKEN"
```

The response includes `agentSessionFile` — that's the JSONL path.

### Option B: Via sessions.json (if you have filesystem access)

```bash
# From the project's state directory
cat .bobbit/state/sessions.json | grep -A2 '<session-id>'
```

Look for the `agentSessionFile` field.

## Step 2: Read the JSONL file

### Non-sandboxed sessions

The JSONL file is at the path returned by the API. Read it directly:

```bash
cat "<agentSessionFile path>"
```

### Sandboxed sessions (Docker containers)

Inside a sandbox container, the host's `~/.bobbit/agent/sessions/` directory is mounted at `/home/node/.bobbit/agent/sessions/`. The `agentSessionFile` path from the API will be a **host path** (e.g. `C:/Users/.../sessions/...`). You need to remap it:

1. Strip the host prefix up to and including `agent/sessions/`
2. Prepend `/home/node/.bobbit/agent/sessions/`

```bash
# Example: host path is C:/Users/josh/.bobbit/agent/sessions/--workspace--/2026-04-04_abc.jsonl
# Container path: /home/node/.bobbit/agent/sessions/--workspace--/2026-04-04_abc.jsonl

HOST_PATH="<agentSessionFile from API>"
RELATIVE=$(echo "$HOST_PATH" | sed 's|.*agent/sessions/||')
cat "/home/node/.bobbit/agent/sessions/$RELATIVE"
```

## Step 3: Parse the JSONL

Each line is a JSON object. The key fields are:

- `type`: Usually `"message"` for conversation entries
- `role`: `"user"` or `"assistant"`
- `message.content`: The message content — either a string or an array of content blocks

Content blocks can be:
- `{ "type": "text", "text": "..." }` — text content
- `{ "type": "tool_use", "name": "...", "input": {...} }` — tool call
- `{ "type": "tool_result", "content": "..." }` — tool result

### Quick extraction script

```bash
# Extract just the text content from each message
python3 -c "
import json, sys
for line in open(sys.argv[1], encoding='utf-8', errors='replace'):
    line = line.strip()
    if not line: continue
    entry = json.loads(line)
    if entry.get('type') != 'message': continue
    msg = entry.get('message', {})
    role = msg.get('role', '?')
    content = msg.get('content', '')
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        text = ' '.join(
            p.get('text', '') if p.get('type') == 'text'
            else f'[TOOL: {p.get(\"name\",\"?\")}]' if p.get('type') == 'tool_use'
            else f'[RESULT: {str(p.get(\"content\",\"\"))[:200]}]' if p.get('type') == 'tool_result'
            else ''
            for p in content if isinstance(p, dict)
        )
    else:
        text = str(content)
    if text.strip():
        print(f'--- {role} ---')
        print(text[:2000])
        print()
" "<path-to-jsonl>"
```

## Step 4: For team agents — reading from the team bare repo

If you're a **sandboxed team lead** and need to see what files a team agent committed (not just their conversation), the commits are in the shared team bare repo:

```bash
# The team bare repo is at /team-repos/team-<goalId>.git
# Fetch the agent's branch
git fetch team

# List the agent's commits
git log team/<agent-branch> --oneline

# Cherry-pick or merge their work
git merge team/<agent-branch>
```

## Common pitfalls

1. **Path remapping in sandboxes**: The `agentSessionFile` is stored as a host path. Inside Docker, remap `*/agent/sessions/*` to `/home/node/.bobbit/agent/sessions/*`.

2. **Encoding**: JSONL files may contain Unicode characters (arrows, emojis). Always use `encoding='utf-8', errors='replace'` when reading.

3. **Large files**: Session histories can be very large. Use `head -n 50` or `tail -n 50` to read portions, or filter by role.

4. **Active sessions**: For sessions that are still running, the JSONL file is being actively written to. You can still read it, but the last line may be incomplete.

5. **Gateway URL in sandbox**: Use `$BOBBIT_GATEWAY_URL` if set, otherwise try `https://host.docker.internal:3001`. The token is available via `$BOBBIT_TOKEN` env var or from `/tmp/session-prompts/.token`.
