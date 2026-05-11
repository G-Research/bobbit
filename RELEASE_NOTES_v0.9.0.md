# Bobbit v0.9.0

Upgrading from v0.8.0. Lots of polish, a preview panel, and a steer subsystem that finally behaves.

## ✨ New Features

* 🖼️ **Embedded HTML Preview Panel**: Agents can render HTML output — with sibling assets — live in a preview tab. Fullscreen, refresh, standalone view, cookie-auth, and SSE updates all just work.
  Build dashboards, mockups, and reports and watch them update as the agent iterates.

* 💬 **Inline Comments on Proposals**: Annotate goal, role, and staff proposals inline, then send the whole batch as feedback.
  No more retyping "this bit, but…" — point at it.

* 📜 **Session Transcript Tool + Copy-Link Button**: Agents can read another session's transcript via the `read_session` tool. Users get a one-click copy-session-URL button in the header.
  Hand off context between sessions without re-pasting.

* 🎨 **Theme Overhaul**: New categorical chart palette (`--chart-1..6`) and semantic colours (`--positive`, `--negative`, `--warning`, `--info`).
  Agent-authored HTML now looks like it belongs in your theme — light, dark, or custom palette.

* ⎋ **Escape Aborts the Agent Globally**: Press Esc anywhere — focus doesn't matter.
  Stop runaway agents without hunting for the button.

* 🔡 **Sidebar Font-Size Setting**: Adjustable from Settings.

* 🧮 **Git-Status Widget Line Counts**: The pill now shows +/- lines vs the primary branch.
  See at a glance how much your branch has actually changed.

* 🗄️ **Always-On Goal Archive Button** and **Re-Attempt Button**: Re-attempt is now available whenever a goal has no active session; archive is always one click away.

* 🧰 **MCP Meta-Tool Aggregation**: One tool per MCP server with grouped policy UX, plus per-op `allow` / `ask` / `never` parity with built-in tools.
  Less tool-list noise; finer-grained control.

* ⏳ **Instant Loader on Session Create + Faster Re-Attempt**: No more dead-air after clicking New Session.

* 📱 **iOS PWA Boot Skeleton**: Inlined into `index.html` — eliminates the white-screen flash on resume.

* 📐 **Mobile Sidebar**: Now matches the desktop layout.

* 📦 **Smaller UI Bundle**: -64% gzipped via lazy routes and renderer code-splitting.

* 📄 **Cascaded Config Scaffolding**: `system-prompt.md` and `docs/` are now scaffolded into your project's `.bobbit/config/` and cascade builtin → server → project.
  Customise per-project without forking the defaults.

* 📏 **Compact Prompt Bar**: The prompt-bar row collapses gracefully when the chat container is narrow.

## 🐛 Bug Fixes

* 🎛️ **Steer / Abort Reliability**: Full subsystem rewrite. Queued and live-steered prompts are delivered exactly once and survive aborts, restarts, and SDK races. Stop button no longer eats your steer.

* 🚦 **Unified Session Status**: Stop button no longer sticks visible; second send no longer duplicates the user message.

* 💾 **Sessions Persistence Crash-Safety**: Atomic writes + rotated backups. No more bulk-archived live sessions on boot or "orphaned transcripts" banners after a crash.

* 👻 **Snapshot ↔ Live-Event Race**: Messages no longer disappear from the chat and reappear after the next prompt.

* 📌 **Tail-Chat Scroll Lock**: Ported the `use-stick-to-bottom` algorithm — no more snap-back, false Jump-to-Bottom button, or lost scroll position while streaming.

* 🚫 **Dismissed Proposals Stay Dismissed**: Across reloads, as you'd expect.

* 🏷️ **Initial Model Binding & Archived-Session Footer**: Both now show the model that was actually used.

* 🪟 **New-Tab Duplicate Messages**: Fixed.

* 🌳 **Worktree Fixes**: Pool resolves nested `rootPath` correctly; poly-repo sessions get worktrees; setup no longer ENOENTs on Windows without `sh` on PATH; spawn ENOENT when the session cwd is gone is handled gracefully.

* 🔌 **MCP HTTP Transport**: Sends the correct `Accept: application/json, text/event-stream` header.

* 🔁 **Restart Agent**: No longer silently drops streamed events.

* 🔐 **Permission Frame Sequence Gaps**: Fixed, including on late-joiner replay.

* 🏖️ **Sandbox Recovery**: No longer drops streamed events when the sandbox restarts mid-turn.

* 📱 **iOS PWA Resume Polish**: Premature Reload prompt suppressed; `/assets/*` cached so resume can't hang on a dead socket; theme flash on cold launch eliminated.

* 🎬 **Skeleton Bleed-Through & Duplicate Reconnecting Pill**: Both gone after first render.

* 🔗 **Symlinked Project Root**: Clearer error UX with one-click accept-canonical re-submit.

* 🆕 **400 Errors Creating a Session With No Registered Project**: Fixed.

* 🧩 **Lazy Tool Renderer Placeholder**: No longer sticks; Open button reliably appears.

* 📐 **Settings → Shortcuts Tip**: Stacks below the list on mobile.

* 👮 **Team Tools**: Restricted to the team-lead via group policy.

* 🔍 **Implementation-Phase Gap Analysis**: Ignores doc-only gaps.

* 🔗 **Goal `prUrl` Removed**: `PrStatusStore` is now the single source of truth for PR state.

* 🛑 **Descriptive API Errors**: Surfaced in modals with code and stack — no more silent 500s.

---

🤖 Generated with [Bobbit](https://github.com/SuuBro/bobbit)
