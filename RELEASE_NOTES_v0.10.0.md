# Bobbit v0.10.0

Upgrading from v0.9.0. Compaction is now a first-class citizen, the sidebar grew filters and a sleepier bobbit, and the gateway finally honours per-project base refs across every git affordance.

## ✨ New Features

* 🗜️ **Compaction, End-to-End**: Persistent compaction history with inline rows and tail-first pagination, a smooth single-row card with rich summary, shimmer + deflate animation on the context bar, and a polished sidebar bobbit while it's running.
  See exactly what got summarised, when, and how much room you got back.

* 🧠 **Per-Model Thinking Levels**: Thinking level (Off / Low / Medium / High / Extra High) is now configurable per model, with auto-detection of Extra-High support from model metadata. Role-keyed model and thinking-level overrides are honoured at spawn time.
  Spend reasoning budget where it matters.

* 🪟 **Three-Level Preview Panel** with symmetric `Ctrl+[` / `Ctrl+]` shortcuts: collapsed → split → maximised, and back.
  Drive the preview from the keyboard without leaving the chat.

* 🌳 **Configurable Base Ref Per Project**: Set a non-`master` primary ref — local-only or remote — and every git surface (status widget, rebase button, squash-push, merged-into pill, ahead/behind counts, orphaned-commits cleanup) honours it.
  Stop pretending every project tracks `origin/master`.

* 🧹 **Sidebar View Filters**: Show / hide Archived, Busy, and Read sessions independently. Active session is always exempt; a non-empty search bypasses the filters. Persists across reload.

* 🔔 **Scoped Notifications**: The unread dot, polling beep, and agent-end beep now fire only when a human is actually needed — never for delegates or team members, and only for team leads when the goal is complete or the team is genuinely stuck.
  No more chimes for downstream work that's still in flight.

* 👥 **Staff Surfaced in Sessions**: Per-project Staff sub-section restored under the project group, with its own `+` / list buttons and instant loaders.

* 💤 **Sleepier Sidebar Bobbit**: Idle bobbit closes its eyes, breathes, and stops gaze-cycling; unread sessions get a rhythmic tap; atomic-blit eye-frame swaps eliminate hue shimmer.

* 🛠️ **Bundled `fd` / `rg` Binaries**: Per-platform optional sub-packages ship the search binaries the agent expects — no system-wide install required.

* 🎨 **New-Session Button**: Chat icon with a primary-coloured `+` overlay that picks up the per-project accent.

## 🐛 Bug Fixes

* 🐳 **Sandboxed Sessions Crashing After Agent Upgrade**: When the gateway rebuilt the sandbox image, the next session would reconnect to the old container and crash on the first message. Fixed — your worktrees and clones survive the rebuild.

* 🎛️ **Steered Prompts Appearing Out of Order**: Closed the last race.

* 🧮 **Workflow Progress Chips**: Render immediately after a gate signal instead of after a 15–30s blank window.

* 🧰 **Sidebar Goal-Group Filters**: Show Busy / Show Read now apply to sessions under a goal group too. Team-lead row stays sticky if any child still passes; otherwise the goal collapses to its empty-state CTA.

* 🫥 **"No agents — Start Team"** no longer shows up when the live team is just hidden by filters.

* 🏷️ **Staff Sandbox Mode**: Chosen at creation and locked for the staff's lifetime, with an honest read-only indicator on the edit page. No more silent flips when project config changes.

* 🧭 **Sidebar Keyboard Navigation**: `Ctrl+Down` no longer dropped; `Ctrl+Left` / `Ctrl+Right` do native word-jump inside text inputs.

* 🖇️ **Big Transcripts Feel Faster**: Off-screen transcripts render lazily.

* 🚿 **Compaction Card Polish**: No more flipping from success to error, no stale context-bar percentage, no spurious overflow-retry banner during recovery, no false "Request aborted" mid-compaction, no duplicate Thinking bubble after reconnect, and the sprite force-exits when the next turn starts.

* ⚡ **Idle Blob Mid-Stream**: Fixed.

* 🚪 **Post-Archive Routing**: Lands somewhere sensible instead of a dead route.

* 🧾 **`ask_user_choices` Failure**: You now see a minimal error widget instead of nothing.

* 🌐 **Spurious Idle / Unread Sidebar Dot**: Fixed.

* 💬 **Proposal Inline Comments**: Reliable highlights and visible inline-comment markers; fresh proposal tabs render styled instead of unstyled-flash.

* 🚨 **Consistent Error Modals**: API failures surface through one modal with code + stack — no more silent 500s.

* 🧱 **Role Assistant 400 from Non-Project Directories**: Fixed.

* 🎨 **Per-Project Palette "None (use global)"**: Selecting it actually resets your per-project accent.

* 🧹 **Remove the Last Project**: Possible now.

* 🛫 **Add-Project from the Browser Dir Picker**: No longer rejects valid paths.

* 🛡️ **Add-Project Validation**: Clearer errors, no spurious accept paths.

* 🎯 **Goal Workflow UX**: A clutch of fixes around goal creation, workflow snapshotting, and dashboard rendering.

* 🪟 **PWA Title in Standalone Mode**: Just the session/goal name; ` · Bobbit` suffix dropped.

* 🧷 **Sidebar Icon Hit Boxes**: Slightly bigger, no more ambiguous overlapping seams.

* 🌀 **Active-Session Spinner Contrast**: Boosted.

* 📐 **Off-Centre Icons in Empty-State Placeholders**: Fixed.

* 🛎️ **Tooltip Shortcut Hints**: Driven from the shortcut registry so they can't drift from reality.

---

🤖 Generated with [Bobbit](https://github.com/SuuBro/bobbit)
