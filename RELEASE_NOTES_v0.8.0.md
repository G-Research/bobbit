# Bobbit v0.8.0

Upgrading from v0.7.1. Buckle up.

## ✨ New Features

* 🗂️ **Multi-Repo & Components**: One project, many repos, many components. Per-component `commands`, `config`, and `worktree_setup_command`. Sibling worktrees on the same branch.
  Monorepos and polyrepos both work like you'd hope.

* 🖼️ **Image Generation**: First-class support for OpenAI, DALL-E, GPT Image 2, and Gemini/Nano Banana via the new `generate_image` tool and footer model picker.
  Go from "describe it" to "show it" without leaving Bobbit.

* 🎚️ **Per-Role Model & Thinking-Level Overrides**: Tell your reviewer to use Opus, your coder to use Sonnet, your QA to use Haiku — right from the role manager.
  Match the model to the job and stop overpaying for trivial work.

* ✏️ **Editable Proposals**: Tweak a proposal in place — no more re-emitting kilobytes of YAML to fix a typo.
  Agents use `view_proposal` / `edit_proposal` for surgical changes; failed edits roll back atomically. Less waiting, fewer wasted tokens.

* 🕰️ **Proposal Revision Snapshots**: Every propose and edit is a checkpoint. Click any past proposal card to roll back — and the rollback itself becomes a new revision.
  No more silent data loss when you click an old card. The `rev N` badge shows you exactly where you are.

* 🧩 **Mid-Session Project Proposals**: Any agent, any session — propose a `project.yaml` change, review the diff, accept. Done.
  Stop terminating a session just to flip a config flag.

* 🎨 **Project Setup UX Overhaul**: Tabbed Components and Workflows views, scoped proposal panel, custom-key composer.
  Setting up a project finally looks like setting up a project, not editing JSON in a textarea.

* 📦 **Lossless Continue-Archived**: Resurrect any archived session with full transcript fidelity. The `.jsonl` is cloned, not stringified — no 128 KB cap, no lossy seed.
  Pick up exactly where you left off, weeks later.

* 📚 **Claude Code Skill Parity**: SKILL.md skills can ship `references/`, `scripts/`, and `assets/` — agents read them on demand.
  Build richer skills without front-loading every byte into the prompt.

* 🪄 **Skill Chips & Autonomous Activation**: `/name args` renders as a clickable chip in the chat, and agents can self-activate skills via `activate_skill`.
  Cleaner conversations; smarter agents.

* 🔑 **`x-opencode-session` Header**: Per-session token-cache partitioning on the AI Gateway.
  Sessions stop poisoning each other's caches.

* 💾 **Persisted Read & Last-Activity State**: Survives restarts, follows you across devices.
  No more "just now" liars cluttering your sidebar after a server bounce.

* ↔️ **Resizable Sidebar**: Drag it. Width persists.

* ⬇️ **Jump-to-Bottom Button**: Scrolled up to read something? One click brings you back to the live tail.

* 🔔 **Agent-Finish Sound Toggle**: Settings → General. Mute the beep, keep the favicon badge.

* 👁️ **Reopenable Preview Widgets**: Closed a preview by accident? Click the tool card to bring it back.

* 💬 **Always-On "Other" in `ask_user_choices`**: Free-text escape hatch on every multiple-choice.

* 🚦 **Sessions Unstick on New Input**: A failed turn no longer wedges the session — your next message implicitly clears the error and dispatches.
  Less Retry-button hunting.

* 🔒 **`gate_signal` is Team-Lead-Only**: Contributor agents can no longer mark their own homework.
  Cleaner workflow audit trail.

## 🐛 Bug Fixes

* 🔀 **Live-streaming dedup & ordering**: Messages no longer duplicate or arrive out of order during streaming.

* 🛑 **Live-steer survives Stop**: Type a steer, hit Stop, the steer now actually reaches the agent.

* ⏹️ **`bash_bg.wait` interrupts on steer**: Stop a long-running wait by just talking to the agent.

* 🔁 **Verification log Nx duplication**: Each verification line appears exactly once, regardless of how many goal tabs you have open.

* 🎯 **AI Gateway model picking**: Review and naming models bind to the model you actually configured. No silent fallbacks.

* ♻️ **`models.json` self-refreshes on startup**: New gateway-side models appear automatically. No more stale-config mysteries.

* 🌿 **Orphaned remote branches**: `goal/`, `session/`, per-role, and `staff-*` branches now reliably push-delete on archive. Your remote stays tidy.

* 🛰️ **Service worker self-updates**: Each build stamps a unique BUILD_ID. No more stuck-on-stale UI after deploy.

* 🔐 **OAuth transient failures**: A blip in `/api/oauth/status` no longer kicks you back to the login screen.

* 📱 **iOS PWA blank top-gap**: Fixed. The PWA renders edge-to-edge.

* ✍️ **iOS Safari caret**: Visible again in the prompt textarea.

* 📲 **Mobile polish**: Thinking-level label, model-selector focus, input-zoom, footer spacing — all sanded down.

* ✨ **Rename dialog**: Wand button, save state, and selection contrast all work as expected.

* 🫧 **Blob animation**: No more jarring restart between tool calls and assistant text.

* ⚡ **Git-status widget**: Native parallel `execFile` replaces Git Bash spawn — much faster on Windows.

---

🤖 Generated with [Bobbit](https://github.com/SuuBro/bobbit)
