# Bobbit v0.14.0

Upgrading from v0.13.0. This is a large release. The headline is deeper self-service control over your Bobbit instance — agents can now drive the gateway itself, projects and MCP servers are managed from the UI, and a new Support Assistant helps you when things go wrong. Alongside that: a richer git diff viewer, more resilient sessions and gates across restarts, Google/OpenRouter model options, and a steady stream of chat, sidebar, and mobile polish.

## ✨ New Features

* 🛰️ **Gateway control from agents**: A consolidated Bobbit gateway tool lets agents read and orchestrate the gateway — goals, sessions, tasks, gates, and config — with tiered, role-scoped permissions, so orchestration work no longer needs hand-rolled API calls.

* 🏢 **Headquarters workspace**: Headquarters is now a first-class, reorderable project with its own workspace, so staff agents and gateway-level work have a proper home instead of living implicitly alongside your projects.

* 🧑‍🔧 **Support Assistant**: A built-in Support Assistant you can prompt for help with your Bobbit instance, granted session-prompt access by default.

* 🗂️ **Project & MCP management in the UI**: Add and configure projects through a guided flow, administer project settings, browse and install MCP servers from a marketplace, and manage MCP registrations — all without editing config files by hand.

* 🔍 **Rich git diff viewer**: A redesigned diff viewer with GitHub-style line styling, intraline highlights, and per-commit file diffs for reviewing changes directly in Bobbit.

* 🔑 **More model & auth options**: Google OAuth and Google-account Gemini session models, an OpenRouter API key setting, controlled session-model fallback, and an OAuth expiry modal that prompts you to re-authenticate before work stalls.

* 🔁 **Automatic error recovery**: Sessions now auto-retry transient transport/provider errors and retry wedged sessions before nudging, so flaky infrastructure interrupts you less.

* ⏸️ **Pause UX**: Clearer pause behavior with in-chat banners and explicit prompt-rejection feedback when a session is paused.

* 🖼️ **Durable HTML preview**: The HTML preview panel persists across reloads and restarts, and preview refresh/restore actions are more reliable.

* 🧭 **Sidebar & navigation polish**: Configurable sidebar font size, a unified project/goal/session tree, a browse filter menu, sidebar reveal on navigation, entrypoint icons, and refined indentation and spacing (including on mobile).

* 🧰 **Session tooling**: A new session-prompt tool, cross-project and smarter `read_session` inspection, a session prompt card, unified session actions, goal metadata tabs with hierarchical metadata, and per-goal worktree setup hooks.

* 👥 **Staff & permissions UX**: Refreshed Staff UI, a delete-staff tool, and clearer permission cards and prompts with grant deduplication.

* 📱 **Mobile action menus**: Dedicated action menus for touch, plus steadier terminal touch scrolling.

## 🐛 Bug Fixes

* 🔄 **Restart resilience**: Fixed staff/session/goal resurrection on restart, verifier and reviewer restart recovery, team-prompt recovery, and terminal reattach after reconnect.

* 🧱 **Worktree & fork reliability**: Non-destructive goal-worktree sync during gate verification, unified worktree cleanup, unborn-HEAD fallback, fork cwd rebasing, local-only sub-agent branches, and a Windows `EPERM` atomic-rename fix.

* 🧵 **Compaction & message ordering**: Fixed compaction history recovery, live-message ordering after compaction, stranded optimistic prompt ordering, and composer draft loss.

* 🌐 **Connection stability**: Fixed WebSocket backpressure and frame-limit routing, and git-status/git-pill fetch flicker.

* ⚙️ **Gate & verification**: Faster gateway shutdown, restart-safe gate commands, bounded gate inspection artifacts, and smoother verification-phase rendering.

* 🎛️ **Settings & models**: Fixed the model-picker switch, provider-key status display, OpenRouter key propagation, and unwanted autofill in settings fields.

## 🧪 Research Preview & Experimental Notes

* 🔍 **PR Walkthrough**: Now a guided, token-efficient review flow with durable reviews, local `gh`-based review posting, intraline diff highlights, and a more focused half-panel layout. Still beta and evolving.

* 🧩 **Extension platform & marketplace**: Pack schema v2, a lifecycle hub with per-turn provider hooks and extension channels, and first-party marketplace packs continue to mature as research-preview foundations for extensibility.

* 🌳 **Sub-Goals**: Experimental sub-goals remain off by default, with improvements to creation UX and hierarchical goal metadata for opt-in users.

---

🤖 Generated with [Bobbit](https://github.com/SuuBro/bobbit)
