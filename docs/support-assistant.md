# Support Assistant

The **Support Assistant** is a built-in Bobbit agent for "how do I…" questions
about Bobbit itself. It answers in plain language, grounds every answer in
Bobbit's docs and source, and — after you explicitly agree — can apply
server-side changes by driving the running gateway.

## Why it exists

Bobbit is a large system: projects, sessions, goals, workflows, gates, roles,
tools, marketplace packs, provider keys, worktree pools, and more. New and
experienced users alike hit questions like "how do I start a new session?",
"can I change the app colour?", or "how do I turn off worktree pools for all my
projects?". The Support Assistant closes the gap between *asking a question* and
*getting the change made*:

- It **answers** the question, grounded in the actual docs and code.
- Where the answer is a server-side setting, it **offers to make the change for
  you** rather than leaving you to hunt through the UI or REST API.

This lowers the support burden on maintainers and gives users a self-service
first stop that understands Bobbit's real behaviour.

## Launching it

The Support Assistant is launched from a dedicated Lucide
`MessageCircleQuestion` icon button positioned immediately to the **left of the
QR-code button** in both the desktop sidebar header and the mobile header. The
button title is `Open a new support agent session`.

The launcher is visible whenever the **Show Headquarters in project lists**
preference is enabled (`showHeadquartersInProjectLists !== false`). It is not
limited to the currently active project: if a normal project is active, the
button still appears and still opens Support in Headquarters. If the preference
is disabled, the launcher is hidden along with the Headquarters shortcut.

Clicking the launcher starts a `support` assistant session in Headquarters and
connects you to it. Support is a server-wide concern — it operates the gateway,
not one repository — so sessions always target Headquarters even when launched
from another project. The launcher uses the same sizing and spacing as the
sibling header controls (`h-6 w-6` where the compact desktop controls need an
explicit class), and its `data-testid` wrapper uses `display: contents` so it
does not add an extra flex gap.

A new Support session opens automatically with a short capability overview. The
opening reply explains that it can answer Bobbit questions from docs/source,
make confirmed gateway changes, gives a few example questions, and then invites
your question.

## Session titles

Support and the other built-in assistant chats start with a short type prefix and
auto-rename after the first **genuine user message**:

| Assistant type | Initial title | Generated title shape |
|---|---|---|
| Goal | `New Goal` | `New Goal: <summary>` |
| Role | `New Role` | `New Role: <summary>` |
| Tool | `New Tool` | `New Tool: <summary>` |
| Staff | `New Staff` | `New Staff: <summary>` |
| Project | `New Project` | `New Project: <summary>` |
| Support | `Support` | `Support: <summary>` |

The automatic kickoff prompt is marked non-title-generating, so titles are based
on what the user actually asks rather than on boilerplate startup text. Restored
assistant sessions that already have a generated title keep it; sessions still
showing the bare prefix remain eligible for the first real user message to name
them.

## Confirmation-first behaviour

The Support Assistant **never mutates a running Bobbit without first explaining
exactly what it will do and getting your explicit go-ahead**. This is a hard
rule baked into its prompt, and it applies to **every** action — not just
destructive ones.

The flow is always: answer the question first, then ask (for example, *"Would
you like me to do that for you?"*), and only call a mutating gateway tool once
you clearly say yes. When a change touches multiple targets (for example, all
your projects), it states exactly what will change and how many things are
affected before asking. Read-only introspection needs no confirmation.

Confirmations are surfaced through the inline `ask_user_choices` widget, so you
answer with a click rather than free text.

## What it can do

### Grounded answers

The agent reads and greps Bobbit's own **documentation** (primary) and **source**
(deeper detail) to ground its answers, and cites the relevant file when that
helps you trust the answer. These directories ship inside the npm package and
are resolved to absolute paths that are injected into the agent's prompt, so the
grounding works even for offline, npm-installed users (see
[How it works](#how-it-works)).

### Applying changes via the gateway tools

The Support Assistant can drive a running Bobbit instance through the `bobbit`
gateway tool suite. Access is tiered by privilege:

| Tier | Tool | What it does | Availability to Support |
|---|---|---|---|
| Read | `bobbit_read` | Introspect goals, sessions, projects, tasks, gates, config, health. No side effects. | Always allowed; used freely to check state. |
| Orchestrate | `bobbit_orchestrate` | Mutate runtime state: goals, sessions, tasks, gates, staff, team lifecycle. | Allowed, still gated by confirmation-first. |
| Admin | `bobbit_admin` | Config and destructive maintenance: project config, provider keys, marketplace, restart, shutdown. | Behind `ask`, so every use requires confirmation. |

The `bobbit_admin` tier is the most powerful and includes destructive
operations, which is why it is kept behind an `ask` policy in addition to the
prompt-level confirmation rule. For the full operation catalogue and the
rationale behind the tier split, see
[the `bobbit` gateway tool group](bobbit-gateway-tool.md).

Worked examples of the intended behaviour:

- *"How do I start a new session?"* → explains the steps.
- *"How do workflows and gates work?"* → answers from the docs and source.
- *"Can I turn off worktree pools for all my projects?"* → explains it is a
  per-project config change, then offers to apply it across every project via
  `bobbit_admin.update_project_config`.
- *"Can you archive my finished goals?"* → inspects the current goals, explains
  the proposed archive set, and asks before calling a mutating tool.

### Client-only state is guided, not applied

Some appearance and UI state (for example, theme choices stored in the browser)
is **client-only** — it lives in the browser, not on the server, so the gateway
tools cannot change it. For those, the Support Assistant explains the steps and
guides you to make the change yourself in the UI rather than offering to apply
it.

## Constraints

The `support` role is deliberately *more* capable than the read-only advisor
`assistant` role — it is explicitly allowed to change a running Bobbit instance
via the `bobbit` tools. But it has one firm boundary:

- **It must never edit or commit Bobbit's source code.** It reads docs and
  source for reference only — no `write`/`edit` on source files, and no
  `git commit`/`git push`. Its `bash` access is read-only inspection (`rg`,
  `cat`, `git log`, `git status`, and similar). The *only* way it changes state
  is through the `bobbit` gateway tools.

## How it works

A developer-oriented summary of the moving parts:

- **Assistant type.** `support` is registered in the assistant registry with the
  title prefix `Support` and prompt title `Bobbit Support Assistant`. It reuses
  the existing assistant session machinery, so a support session gets no goal,
  worktree, or task board. The same registry field that provides the initial
  title also provides the auto-rename prefix.

- **Why this stays an assistant type.** Support intentionally keeps the
  `assistantType: "support"` path instead of launching as a plain role. That path
  injects `{{BOBBIT_DOCS_DIR}}`, `{{BOBBIT_SRC_DIR}}`, and `{{AGENT_ID}}` into
  the prompt at resolution time. Headquarters sessions often run from the
  Headquarters workspace rather than the Bobbit package directory, especially
  for npm-installed or offline users, so a plain role spawn would not reliably
  know where the bundled docs and source live.

- **Prompt composition.** The session prompt has a dedicated `Role: support`
  section containing the `support` role's `promptTemplate`, plus a separate
  `Goal` section containing the Support Assistant prompt with bundled path
  substitutions applied. Keeping these sections separate matches normal role
  spawns and keeps the role template from being folded into or duplicated inside
  the assistant prompt. Other assistant types use the same split with
  `Role: assistant` and their own assistant-specific `Goal` prompt.

- **Role metadata and tool policies.** `assistantRoleForType()` is the single
  source of truth for assistant-type-to-role mapping: `support` resolves to the
  `support` role, while the other assistant types resolve to the advisor
  `assistant` role. For Support, the persisted session metadata is therefore
  `session.role === "support"` and `session.accessory === "headset"`, matching
  the Role Manager. Setting the resolved role on the plan also means the role's
  tool policies apply: `bobbit_orchestrate: allow` and `bobbit_admin: ask`.

- **Support role.** `defaults/roles/support.yaml` defines the `support` role with
  `accessory: headset` and per-tool grants that layer over the tool defaults.
  `bobbit_read` needs no entry because its `allow` default already applies. The
  support role's prompt carries the hard constraints against editing source code
  or acting without confirmation.

- **Offline docs and source packaging.** The npm package ships `docs/` and
  `src/`. At runtime, bundled path resolution finds their absolute locations
  from the package module URL, working both in this repository and from an
  installed package. Those absolute paths are substituted into the support prompt
  so the agent reads the right files without depending on the current working
  directory.

- **Launcher flow.** The client renders the `MessageCircleQuestion` launcher
  when Headquarters is visible in project lists. The dialog posts a new session
  with `assistantType: "support"` and the Headquarters project id, then connects
  to that session. The client also sends the non-title-generating support kickoff
  prompt, `Start the support session.`, so the agent greets with its capability
  overview.

## See also

- [The `bobbit` gateway tool group](bobbit-gateway-tool.md) — the tiered tool
  suite the Support Assistant uses to apply changes.
- [Headquarters](headquarters.md) — the server workspace the Support Assistant
  runs in.
- [Support Assistant design](design/support-assistant.md) — implementation
  history and original partitioning notes.
