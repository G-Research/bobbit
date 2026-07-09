# Support Assistant

The **Support Assistant** is a built-in Bobbit agent you launch from Headquarters
to ask "how do I…" questions about Bobbit itself — *before* you go to the
maintainers. It answers in plain language, grounds every answer in Bobbit's own
documentation and source, and — after you explicitly agree — can apply
server-side changes on your behalf by driving the running gateway.

## Why it exists

Bobbit is a large system: projects, sessions, goals, workflows, gates, roles,
tools, marketplace packs, provider keys, worktree pools, and more. New and
experienced users alike hit questions like "how do I start a new session?",
"can I change the app colour?", or "how do I turn off worktree pools for all my
projects?". The Support Assistant closes the gap between *asking a question* and
*getting the change made*:

- It **answers** the question, grounded in the actual docs and code (no guessing).
- Where the answer is a server-side setting, it **offers to make the change for
  you** rather than leaving you to hunt through the UI or the REST API.

This lowers the support burden on maintainers and gives users a self-service
first stop that understands Bobbit's real behaviour.

## Launching it

The Support Assistant is launched from a dedicated **`LifeBuoy` icon button**
labelled *Support*, positioned immediately to the **left of the QR-code button**
in both the desktop sidebar header and the mobile header.

The button is **only visible when Headquarters is the active project**. Because
support is a server-wide concern (it operates the whole gateway, not one repo),
it lives in Headquarters — Bobbit's built-in server workspace (see
[Headquarters](headquarters.md)). Switch to a normal project and the launcher
disappears.

Clicking it starts a `support` assistant session inside Headquarters and
connects you to it. The session opens with a short greeting inviting your
question — it has no goal, worktree, or task board; it is a plain conversational
assistant with the gateway tools attached.

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
| Read | `bobbit_read` | Introspect goals, sessions, projects, tasks, gates, config, health. No side effects. | Always allowed (used freely to check state). |
| Orchestrate | `bobbit_orchestrate` | Mutate runtime state: goals, sessions, tasks, gates, staff, team lifecycle. | Allowed (still gated by confirmation-first). |
| Admin | `bobbit_admin` | Config + destructive maintenance: `update_project_config`, provider keys, marketplace, `harness_restart`, `shutdown`. | Behind `ask` (confirm on every use). |

The `bobbit_admin` tier is the most powerful and includes destructive
operations, which is why it is kept behind an `ask` policy in addition to the
prompt-level confirmation rule. For the full operation catalogue and the
rationale behind the tier split, see
[the `bobbit` gateway tool group](bobbit-gateway-tool.md).

Worked examples of the intended behaviour:

- *"How do I start a new session?"* → explains the steps.
- *"Can I turn off worktree pools for all my projects?"* → explains it is a
  per-project config change, then offers to apply it across every project via
  `bobbit_admin.update_project_config`.

### Client-only state is guided, not applied

Some appearance and UI state (for example, theme choices stored in the browser)
is **client-only** — it lives in the browser, not on the server, so the gateway
tools cannot change it. For those, the Support Assistant explains the steps and
guides you to make the change yourself in the UI rather than offering to apply it.

## Constraints

The `support` role is deliberately *more* capable than the read-only advisor
`assistant` role — it is explicitly allowed to change a running Bobbit instance
via the `bobbit` tools. But it has one firm boundary:

- **It must never edit or commit Bobbit's source code.** It reads docs and
  source for reference only — no `write`/`edit` on source files, and no
  `git commit`/`git push`. Its `bash` access is read-only inspection
  (`rg`, `cat`, `git log`, `git status`, and similar). The *only* way it changes
  state is through the `bobbit` gateway tools.

## How it works

A developer-oriented summary of the moving parts. For the full design — file
paths, signatures, and the partition plan — see
[docs/design/support-assistant.md](design/support-assistant.md).

- **Assistant type.** `support` is registered in the assistant registry
  (`src/server/agent/assistant-registry.ts`, `FALLBACK_DEFAULTS`) with session
  title *Support* and prompt title *Bobbit Support Assistant*. Its prompt lives
  in a dedicated module (`src/server/agent/support-assistant.ts`,
  `SUPPORT_ASSISTANT_PROMPT`), mirroring the other assistant prompt modules. It
  reuses the existing assistant session machinery, so a support session gets no
  goal or worktree.

- **Role.** `defaults/roles/support.yaml` defines the `support` role with
  `accessory: headset` and per-tool grants that layer over the tool defaults:
  `bobbit_orchestrate: allow` and `bobbit_admin: ask` (`bobbit_read` needs no
  entry — its `allow` default already applies). These role policies beat the
  `grantPolicy: never` defaults on the orchestrate/admin tool YAMLs.

- **Type → role mapping.** `assistantRoleForType()` in the assistant registry
  maps the `support` assistant type to the `support` role; every other assistant
  type resolves the read-only advisor `assistant` role. This is what gives the
  support session its elevated `bobbit` tool grants.

- **Offline docs + source packaging.** `package.json` `files` ships `docs/` and
  `src/` in the npm tarball (tests are excluded). At runtime,
  `src/server/agent/bundled-paths.ts` resolves the absolute `docs/` and `src/`
  paths from `import.meta.url` — working both in this repo (running from source)
  and from a built, installed package layout, where the session's cwd is the
  user's workspace rather than the package root. Those absolute paths are
  substituted into the support prompt via the `{{BOBBIT_DOCS_DIR}}` and
  `{{BOBBIT_SRC_DIR}}` placeholders at prompt-resolution time, so the agent knows
  exactly where to read from.

- **Launcher UI.** The `LifeBuoy` button in `src/app/render.ts` (both the desktop
  sidebar header and the mobile header, each gated on
  `isHeadquartersProject(...)`, carrying `data-testid="support-launcher"`) calls
  `showSupportDialog()` in `src/app/dialogs.ts`, which `POST`s
  `/api/sessions { assistantType: "support", projectId: HEADQUARTERS_PROJECT_ID }`
  and connects to the new session.

## See also

- [The `bobbit` gateway tool group](bobbit-gateway-tool.md) — the tiered tool
  suite the Support Assistant uses to apply changes.
- [Headquarters](headquarters.md) — the server workspace the Support Assistant
  runs in.
- [docs/design/support-assistant.md](design/support-assistant.md) — the full
  design doc.
