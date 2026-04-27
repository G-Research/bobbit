# Design — Skill UX & Autonomous Activation

Goal: ship the two parts described in the goal spec.

- **Part A — Chat UX**: persist the user's literal message + a list of resolved skill expansions; render the bubble with the original text and clickable disclosure chips. Model still receives the fully-expanded prompt (byte-equal to today).
- **Part B — Autonomous activation**: inject `name` + `description` (+ `argument-hint`) of every user-invocable, non-`disable-model-invocation` skill into the system prompt, and add a built-in `activate_skill` tool the agent can call mid-turn. Tool-call result renders with the same chip UX.

Out of scope (file as separate goals — *not designed here*): namespacing, `!`bash exec`, `allowed-tools` enforcement, edit-message re-resolution.

---

## 1. Files touched

### Server

| File | Change |
| --- | --- |
| `src/server/skills/resolve-skill-expansions.ts` *(new)* | Extract resolver from `ws/handler.ts`. Pure, unit-testable. |
| `src/server/skills/slash-skills.ts` | No structural change; re-export `applySubstitutions`/`buildSlashSkillPrompt` (already exported). |
| `src/server/ws/handler.ts` | Replace inline regex block (lines 290–322) with call to `resolveSkillExpansions`. Pass structured form to `enqueuePrompt`. |
| `src/server/agent/session-manager.ts` | `enqueuePrompt` accepts an optional `skillExpansions` array. Persist a sidecar (`<sessionFile>.skill-meta.jsonl`) keyed by user-message text+timestamp. Broadcast `skillExpansions` alongside the echoed user message. |
| `src/server/agent/system-prompt.ts` | Add `skillsCatalog?: Array<{name; description; argumentHint?}>` to `PromptParts`. Inject "Available Skills" section into `assembleSystemPrompt` and `getPromptSections`, with 4 KB cap and alphabetical truncation. |
| `defaults/tools/skills/activate_skill.yaml` *(new)* | Tool definition. |
| `defaults/tools/skills/extension.ts` *(new)* | Tool handler — calls back via REST to a new `POST /api/sessions/:id/activate-skill` that resolves on the server using the existing `getSlashSkill` + `buildSlashSkillPrompt`. |
| `src/server/server.ts` | Add `POST /api/sessions/:id/activate-skill` (returns `{ name, args, source, filePath, expanded }` or 404/403). Also exposes `GET /api/sessions/:id/skills-catalog` for tool-extension hot-reload (optional). |
| `defaults/tool-group-policies.yaml` | No change required — group `Skills` defaults to allow. Documented as opt-out point. |

### UI

| File | Change |
| --- | --- |
| `src/ui/components/SkillChip.ts` *(new)* | `<skill-chip name args expanded source filePath>` Lit component. Pill button + `<expandable-section>` body. |
| `src/ui/components/Messages.ts` | `UserMessage.render`: when `message.skillExpansions?.length`, build `TemplateResult[]` by walking `text` and splicing `<skill-chip>` at each recorded range. Otherwise render today's `<markdown-block>`. Extend `UserMessageWithAttachments` type with optional `skillExpansions` field. |
| `src/ui/index.ts` | `import "./components/SkillChip.js";`. |
| `src/ui/tools/renderers/ActivateSkillRenderer.ts` *(new)* | Renders `activate_skill` tool calls as a `<skill-chip>` (uses the tool result `expanded` field). Same visual as user-invoked chip. |
| `src/ui/tools/index.ts` | `registerToolRenderer("activate_skill", new ActivateSkillRenderer());`. |
| `src/app/remote-agent.ts` | Optimistic user message includes `skillExpansions` if present in the prompt-send path. Echo-merge logic preserves it (mirror existing `_pendingAttachments` pattern: `_pendingSkillExpansions`). `enrichUserMessage` passes the field through. |

### New function signatures

```ts
// src/server/skills/resolve-skill-expansions.ts
export interface SkillExpansion {
  name: string;                  // skill name
  args: string;                  // arguments string ("" if none)
  source: SlashSkill["source"];  // project | personal | legacy | built-in | custom
  filePath: string;              // absolute path to SKILL.md
  /** [start, end) char offsets into the ORIGINAL `text` (UTF-16 code units; matches String.prototype.slice). */
  range: [number, number];
  /** Snapshot of the resolved markdown body sent to the model at this position. */
  expanded: string;
}

export interface ResolveResult {
  /** Original text the user typed (unchanged). */
  originalText: string;
  /** Fully-spliced text that should be sent to the model. Byte-equal to today's behavior. */
  modelText: string;
  /** Expansions in original-text order. Empty when nothing resolved. */
  expansions: SkillExpansion[];
  /** Names that looked like skills but weren't found. For diagnostics only. */
  unknown: string[];
}

export function resolveSkillExpansions(
  text: string,
  cwd: string,
  projectConfigStore?: { get(key: string): string | undefined },
): ResolveResult;
```

```ts
// src/server/agent/session-manager.ts (extended)
async enqueuePrompt(sessionId: string, text: string, opts?: {
  images?: ImageContent[];
  attachments?: unknown[];
  isSteered?: boolean;
  skillExpansions?: SkillExpansion[]; // NEW — original-text expansions
  modelText?: string;                 // NEW — text actually sent to the model
}): Promise<void>;
```

```ts
// src/server/agent/system-prompt.ts (extended PromptParts)
skillsCatalog?: Array<{
  name: string;
  description: string;
  argumentHint?: string;
}>;
```

```ts
// defaults/tools/skills/extension.ts
pi.registerTool({
  name: "activate_skill",
  parameters: Type.Object({
    name: Type.String(),
    args: Type.Optional(Type.String()),
  }),
  async execute({ name, args }) { /* POST /api/sessions/:id/activate-skill */ }
});
```

---

## 2. Persisted message shape

The agent CLI controls the `.jsonl` file and writes the **expanded** user message (model-facing form). To preserve the original text + expansions without changing the model-facing transcript, we use a **sidecar file**, identical pattern to attachments-in-content.

### Sidecar file

Path: `<agentSessionFile>.skill-meta.jsonl` (sits next to the agent's session file). One line per user message that had at least one expansion:

```json
{
  "ts": 1714123456789,
  "modelText": "Please look at @docs/style.md and use the design mockups guide …",
  "originalText": "Please look at @docs/style.md and /mockup",
  "skillExpansions": [
    {
      "name": "mockup",
      "args": "",
      "source": "built-in",
      "filePath": "C:/…/defaults/skills/mockup/SKILL.md",
      "range": [33, 40],
      "expanded": "# Mockup skill instructions\n\n…"
    }
  ]
}
```

**Lookup key** when restoring: `(timestamp ± 2s, modelText)`. Sidecar entries are matched on the model-facing user message in `.jsonl` and merged when `getMessages()` returns. Match-miss = old/legacy message → render plain.

**Why a sidecar, not new fields in the agent message:**
1. Agent CLI is third-party (`@mariozechner/pi-coding-agent`); it owns the `.jsonl` schema.
2. Sidecar means *zero* schema risk for the model and keeps the model's transcript byte-equal to today.
3. Backward compat is automatic: missing sidecar → no chips.

### Range semantics

`range` is a **`[start, end)` pair of UTF-16 code unit offsets** into `originalText`, matching `String.prototype.slice` semantics in both Node and browsers. We deliberately avoid byte offsets — the UI splices in JS where char indexing is what's natural.

### Old vs new examples

**Old** (existing `.jsonl` line, no sidecar):

```json
{ "type": "message", "message": { "role": "user", "content": [{ "type": "text", "text": "<expanded /mockup body>" }], "timestamp": 1714000000000 } }
```

**New** (`.jsonl` line unchanged; sidecar written alongside):

```jsonl
{"ts":1714000000000,"modelText":"<expanded /mockup body>","originalText":"/mockup hero","skillExpansions":[{"name":"mockup","args":"hero","source":"built-in","filePath":"…/SKILL.md","range":[0,7],"expanded":"<expanded body>"}]}
```

---

## 3. `resolveSkillExpansions` algorithm

Reproduces today's behavior in `ws/handler.ts:283–323` exactly, but as a pure function.

```ts
export function resolveSkillExpansions(text, cwd, store): ResolveResult {
  const slashPattern = /(^|\s)\/([\w-]+)/g;
  const expansions: SkillExpansion[] = [];
  const unknown: string[] = [];

  // 1. Detect prefix-only invocation: ENTIRE text matches /^\/([\w-]+)(?:\s+(.*))?$/
  //    (current behaviour: this is the only form that gets args appended).
  const prefixMatch = text.match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/);
  if (prefixMatch) {
    const [, name, rawArgs] = prefixMatch;
    const skill = getSlashSkill(cwd, name, store);
    if (skill) {
      const args = (rawArgs ?? "").trim();
      const expanded = buildSlashSkillPrompt(skill, args);
      // Range covers the WHOLE message — the chip replaces the entire bubble
      // content (consistent with how Claude Code shows it).
      expansions.push({
        name, args,
        source: skill.source, filePath: skill.filePath,
        range: [0, text.length],
        expanded,
      });
      return { originalText: text, modelText: expanded, expansions, unknown };
    } else {
      unknown.push(name);
      // Fall through to inline scan in case it's a typo with other content.
    }
  }

  // 2. Inline scan: every /name token at a word boundary expands to
  //    buildSlashSkillPrompt(skill, "") and replaces just the token.
  let m: RegExpExecArray | null;
  const replacements: Array<{start: number; end: number; expanded: string; name: string; skill: SlashSkill}> = [];
  while ((m = slashPattern.exec(text)) !== null) {
    const prefixLen = m[1].length;
    const start = m.index + prefixLen;
    const end = start + 1 + m[2].length;
    const skill = getSlashSkill(cwd, m[2], store);
    if (!skill) { unknown.push(m[2]); continue; }
    replacements.push({ start, end, expanded: buildSlashSkillPrompt(skill, ""), name: m[2], skill });
  }

  // 3. Build modelText by splicing right-to-left (preserves indices),
  //    and build expansions left-to-right for stable UI ordering.
  let modelText = text;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    modelText = modelText.slice(0, r.start) + r.expanded + modelText.slice(r.end);
  }
  for (const r of replacements) {
    expansions.push({
      name: r.name, args: "",
      source: r.skill.source, filePath: r.skill.filePath,
      range: [r.start, r.end],
      expanded: r.expanded,
    });
  }

  return { originalText: text, modelText, expansions, unknown };
}
```

**Snapshot-at-invocation**: `expanded` is captured *now* and persisted in the sidecar. Re-rendering after `.jsonl` replay does not re-read `SKILL.md`. Matches the spec's "instructions loaded at activation" guarantee.

**Prefix vs inline parity with today**:
- Prefix-only (`/mockup hero`): full `buildSlashSkillPrompt` (which appends `ARGUMENTS: hero` if SKILL.md has no `$ARGUMENTS`). Range covers entire message. Chip replaces whole bubble.
- Inline (`see /mockup for context`): `buildSlashSkillPrompt(skill, "")` (no args appended), token-only replacement. Chip replaces just `/mockup`.
- Mixed (`/mockup\nsee /git-conventions`): does NOT match prefix-only regex (whole-string match required), so falls through to inline scan — both expand inline. Same as today.

---

## 4. `enqueuePrompt` change + snapshot tests

`ws/handler.ts` becomes:

```ts
case "prompt": {
  const { originalText, modelText, expansions } = resolveSkillExpansions(
    msg.text, skillCwd, resolvedConfigStore
  );
  await sessionManager.enqueuePrompt(sessionId, originalText, {
    images: msg.images,
    attachments: msg.attachments,
    skillExpansions: expansions.length ? expansions : undefined,
    modelText: expansions.length ? modelText : undefined,
  });
  break;
}
```

`enqueuePrompt` uses `modelText ?? text` whenever it dispatches to `rpcClient.prompt(...)`, and writes a sidecar entry for the user message timestamp it dispatches with. The model NEVER sees `originalText` — only `modelText`, which equals today's `promptText` byte-for-byte.

**Title generation** stays on `text` (the original) — that's a UX win (the title generator no longer ingests skill bodies).

### Byte-equality snapshot test plan

`tests/skill-resolve.spec.ts` (Node test runner):

| Case | Input | Expectation |
| --- | --- | --- |
| **Prefix-only, no args** | `/mockup` | `modelText === buildSlashSkillPrompt(skill, "")`; expansions[0].range = [0, 7]. |
| **Prefix-only, with args** | `/mockup hero card` | `modelText === buildSlashSkillPrompt(skill, "hero card")`; range covers whole text. |
| **Inline single** | `Use /mockup for layout` | `modelText === "Use " + buildSlashSkillPrompt(skill, "") + " for layout"`. |
| **Inline mixed** | `/foo\nsee /bar` | NOT prefix-only (newline before `/bar`); both inline-expanded. |
| **No skill** | `hello world` | `modelText === originalText`; `expansions === []`. |
| **Unknown skill** | `/nope` | `modelText === originalText`; `expansions === []`; `unknown === ["nope"]`. |
| **Multiple inline** | `/a then /b` | Two expansions in left-to-right order; ranges correct. |

A second test asserts byte-equality versus the **current** handler output by importing the pre-refactor regex block as a fixture and feeding identical inputs through both — this is the regression guard for the model-facing path.

---

## 5. System-prompt skills section

### Injection point

`src/server/agent/system-prompt.ts::assembleSystemPrompt`. Insert as a new `5.5. Available Skills` block, between `5. Task context` and `6. Workflow dependency context` — late enough that role/goal context wins for attention, early enough that the agent sees it before tool docs scroll past.

The block is also reflected in `getPromptSections()` so the inspector shows it.

### Format

```
## Available Skills

You can autonomously activate any of these skills mid-turn by calling the
`activate_skill` tool with `{ name, args? }`. The tool returns the skill's
instructions; act on them as if the user had typed `/<name> <args>`.

- **mockup** — Create a high-fidelity HTML/SVG design mockup. _args: <element-name>_
- **git-conventions** — Project-specific git rules (commits, branches, PR descriptions).
- **debug-session** — Step-by-step session debugging checklist.
…
```

- One bullet per skill. `argument-hint` rendered as italic suffix when present.
- Skills with `disable-model-invocation: true` are **omitted entirely**.
- Skills with `user-invocable: false` are also omitted (already filtered by `discoverSlashSkills`).

### Token budget

- Cap section at **4 096 chars** (≈1 KB tokens). Each bullet is ≈100–250 chars; gives ~16–40 skills which covers all realistic projects.
- Construction loop: sort alphabetically by `name`; accumulate bullets while `runningLen + bulletLen < 4096`. When the cap is hit, append `- _… (N more skills omitted, alphabetically truncated; use \`activate_skill\` by name)_` and `console.warn`.

### Refresh on session restore

`assemblePrompt` is called on every session restore (already does — it rebuilds from `session.promptParts`). We add `skillsCatalog` to the rebuild path in `getPromptParts()`'s on-demand branch by calling `discoverSlashSkills(cwd, projectConfigStore)` and projecting to `{name, description, argumentHint}` filtered by `disableModelInvocation !== true`. The 5 s `_cache` in `slash-skills.ts` is sufficient — newly added skills appear within 5 s for autonomous use, immediately for slash use (cache miss for unknown name).

### Token estimate sanity

```
Header (~250 chars)
+ N × 150 chars bullet ≈ 250 + 150N
N=20 → ~3 250 chars (≈800 tokens)
```

Comfortably below the 4 KB cap.

---

## 6. `activate_skill` tool

### YAML

`defaults/tools/skills/activate_skill.yaml`:

```yaml
name: activate_skill
description: "Activate a discovered skill by name. Returns the skill's instructions as the tool result; follow them as if the user had typed /<name> <args>. Use only for skills listed in 'Available Skills'."
summary: "Activate a discovered skill by name (autonomous slash invocation)."
provider:
  type: bobbit-extension
  extension: extension.ts
group: Skills
docs: |
  Parameters:
    - name (required): skill name (no leading slash). Must appear in the system prompt's "Available Skills" list.
    - args (optional): arguments to pass to the skill (same as text after /<name> when typed).

  The tool result IS the resolved skill body — read and act on it.

  Errors:
    - 404 "skill not found"
    - 403 "skill has disable-model-invocation set"
detail_docs: |
  Mirrors the user-typed `/<name> <args>` pathway exactly: same `getSlashSkill`
  lookup, same `buildSlashSkillPrompt(skill, args)` resolution, same chat-side
  chip rendering. Snapshots are taken at activation time so the body is stable
  across `.jsonl` replay.
```

### Extension handler

`defaults/tools/skills/extension.ts`:

```ts
pi.registerTool({
  name: "activate_skill",
  label: "Activate Skill",
  description: "Resolve and load a discovered skill's instructions.",
  parameters: Type.Object({
    name: Type.String({ description: "Skill name (no leading slash)" }),
    args: Type.Optional(Type.String({ description: "Arguments string" })),
  }),
  async execute({ name, args }) {
    const resp = await api("POST", `/api/sessions/${sessionId}/activate-skill`, { name, args: args ?? "" });
    if (resp.ok === false) return { content: [{ type: "text", text: resp.error }], isError: true, details: undefined };
    return {
      content: [{ type: "text", text: resp.expanded }],
      // `details` carries metadata for the UI tool renderer to render the chip
      details: { skillExpansion: { name, args: args ?? "", source: resp.source, filePath: resp.filePath, expanded: resp.expanded } },
    };
  },
});
```

### REST endpoint

`POST /api/sessions/:id/activate-skill`:

```ts
{
  name: string;
  args?: string;
}
→ 200 { ok: true, expanded, source, filePath }
→ 404 { ok: false, error: "Skill 'xyz' not found" }
→ 403 { ok: false, error: "Skill 'xyz' has disable-model-invocation set" }
```

Implementation:

```ts
const skill = getSlashSkill(skillCwd, name, configStore);
if (!skill) return 404;
if (skill.disableModelInvocation === true) return 403;
const expanded = buildSlashSkillPrompt(skill, args ?? "");
// Best-effort: append a sidecar entry for the activate_skill tool_use so the UI
// can re-render the chip after reload (keyed on the tool_use_id, not message ts).
return { ok: true, expanded, source: skill.source, filePath: skill.filePath };
```

### Disable-model-invocation enforcement (defense in depth)

1. **System prompt**: filtered out by `skillsCatalog` builder → agent doesn't know it exists.
2. **Server endpoint**: 403 if reached anyway (e.g. agent guesses the name).

### UI integration

`ActivateSkillRenderer.render(params, result)`:

- Reads `result.details.skillExpansion` (or parses `params.{name,args}` + the tool result text if `details` absent).
- Renders `<skill-chip>` identical to user-message chips. The chip body is the `expanded` string rendered via `<markdown-block>`.
- Streaming state: shows pill with spinner until `result` arrives.

Because the chip component is the same element used inside `<user-message>`, the look is pixel-identical.

---

## 7. Tool-policy integration

`activate_skill` belongs to a new `Skills` group. To opt out:

- **Project-wide**: add `Skills: never` to `.bobbit/config/tool-group-policies.yaml`. Cascade machinery in `defaults/tool-group-policies.yaml` / `src/server/config/tool-group-policy-store.ts` already handles group-level allow/ask/never.
- **Per-role**: role YAML `toolPolicies: { activate_skill: never }` (existing key, see `defaults/roles/*.yaml`).

When `activate_skill` is denied, `tool-guard-extension.ts` rejects calls with the standard "tool not allowed" error. The agent learns from the error and falls back to "ask the user to invoke /name". To reduce the likelihood of that pointless tool call, when `activate_skill` is filtered out for the session we **also skip injecting the "Available Skills" section** (the catalog is useless without the activator).

`defaults/tool-group-policies.yaml` gets a header comment documenting this:

```yaml
# Skills:
#   activate_skill — autonomous skill activation. Defaults to allow.
#   Set 'Skills: never' to disable autonomous activation; users can still type /name.
```

---

## 8. Backward compatibility

Three layers of fallback for old messages:

1. **Sidecar absent**: `getMessages()` returns the user message with no `skillExpansions` field. `<user-message>` falls into the existing `<markdown-block>` branch — pixel-identical to today.
2. **Sidecar present but `range` out-of-bounds** (corruption): `<user-message>` validates `0 ≤ start < end ≤ text.length` per expansion; on failure, drops the chip and renders plain text. Console warn for diagnostics.
3. **Old client / new server**: server still broadcasts `skillExpansions` as an *additive* field on the user message; old UI ignores unknown fields. Old server / new client: client never sees the field; renders plain text.

The `convertToLlm` path in `Messages.ts` is unchanged — `skillExpansions` is purely a UI-display field, never round-tripped to the model.

---

## 9. Test plan

### Unit (`tests/skill-resolve.spec.ts`, `tests/skill-sidecar.spec.ts`)

- **resolveSkillExpansions**:
  - prefix-only no args / with args
  - inline single
  - inline mixed (multiple skills, one unknown)
  - no skill in input
  - unknown skill (no expansion, captured in `unknown[]`)
  - byte-equality regression: snapshot vs current handler block for 6 representative inputs.
- **applySubstitutions** (already covered, kept).
- **Sidecar round-trip** (`tests/skill-sidecar.spec.ts`):
  - write a sidecar entry; read it back; assert `originalText`, `expansions`, `expanded` survive.
  - non-existent sidecar → empty merge; agent message renders as today.

### Server snapshot (`tests/e2e/skill-prompt-bytes.spec.ts`, in-process harness)

- Send `/mockup hero` and `see /git-conventions` via WS prompt.
- Capture the text passed to `rpcClient.prompt`.
- Assert byte-equal to a fixture captured from the pre-refactor `ws/handler.ts`.

### Autonomous activation (`tests/e2e/activate-skill.spec.ts`, in-process harness)

- Mock model that, on first turn, emits a `tool_use` for `activate_skill` with `{name:"mockup"}`.
- Assert:
  1. The `tool_result` text equals `buildSlashSkillPrompt(mockup, "")`.
  2. The next assistant turn's input contains the resolved body.
  3. `disable-model-invocation: true` skill rejected with 403; tool surfaces `isError`.
  4. `Skills: never` policy → tool not registered → 4xx during agent activation init (existing tool-guard test pattern).

### Browser E2E (`tests/e2e/ui/skills-chip.spec.ts`)

Per AGENTS.md "E2E coverage requirement" (navigation, happy path, persistence, cleanup):

1. **Navigation**: open a session in a project that has `.claude/skills/mockup/SKILL.md`.
2. **Happy path — user invocation**: type `/mockup hero`, send. Assert:
   - bubble shows literal `/mockup hero` (NOT the expanded body).
   - chip rendered with label `/mockup hero` and disclosure caret.
   - clicking chip reveals expanded markdown.
3. **Happy path — autonomous**: stub a model that emits `activate_skill({name:"mockup"})`. Assert tool-call card renders as `<skill-chip>` with disclosure showing the resolved body.
4. **Persistence**: reload the page. Assert both the user-invoked chip AND the autonomous chip survive (sidecar + tool_use carry their own state).
5. **Cleanup / backward compat**: load a fixture session whose `.jsonl` predates this feature (no sidecar). Assert the (raw expanded) message renders as plain text — no chip — exactly as today.

### Manual integration

None required — no sandbox/worktree changes.

---

## Open questions / non-goals (not to be addressed in this goal)

- **Namespacing**: `/frontend:component` resolution via subdirectory. Filed separately.
- **`!`bash exec`** inside skill bodies, expanded at invocation time. Filed separately.
- **`allowed-tools` enforcement**: skill YAML's `allowed-tools` list is currently advisory only. Filed separately.
- **Edit-message re-resolution**: editing a sent user message currently does not re-resolve skills. Out of scope.
- **Mobile chip wrapping** beyond `flex-wrap` defaults — visual polish in a follow-up.
