# Bobbit v0.11.0

Upgrading from v0.10.0. The side panel grew a proper Chrome-style tab strip with drag-and-drop, prompt-by-prompt history navigation, a friendlier Add Project dialog, a staff inbox queue, and automatic retry on provider overload — plus a long tail of preview, proposal, and sidebar fixes.

## ✨ New Features

* 🗂️ **Chrome-Style Side-Panel Tabs**: Dynamic chat / preview / proposal / review tabs in a single SortableJS-powered strip — drag to reorder, viewport-aware wrap, sprite room preserved, with a route-aware contract so every panel kind plays by the same rules. Each preview, proposal, and review document now opens in its own tab.

* ⏪ **Jump-to-Prompt Navigation**: Step backwards and forwards through your own prompts in the transcript with the new Jump to Last Prompt button — geometric, stateless, and Keyboard-driven. Walking your own conversation history is one click instead of a scroll-hunt.

* 🪟 **Project Onboarding Redesign**: New Add Project dialog with a built-in DirectoryPicker; subset handoff (single-repo / multi-repo) actually works. Adding a project no longer demands typing absolute paths into a textbox.

* 🪄 **Project Drag-Reorder**: Drag projects in the sidebar to reorder; order persists per device.

* 📨 **Staff Inbox Queue**: Staff agents get a queued inbox of events to triage, with `inbox_list` / `inbox_complete` / `inbox_dismiss` tools and compact-list renderers in the transcript. The Mobile Inbox Modal makes that surface usable on phones too.

* 🪝 **Goal Lifecycle Staff Triggers**: `goal_created` and `goal_archived` fire matching staff agents — automate goal-shaped workflows end to end.

* 🎀 **Persistent Staff Accessories**: The little accessory you pick for a staff agent is now persisted with the staff record, surviving reload and respawn.

* 🔁 **Automatic Retry on Provider Overload**: HTTP 429 / 529 and other transient provider errors now retry with capped exponential backoff and a visible auto-retry banner — no more "Request failed" mid-turn when the upstream model is just throttled.

* 🧠 **Stable Prompt Prefix**: The system-message prefix is now stable between turns, dramatically improving provider cache hit rates. Pair it with the new **Cache-Hit Rate Metric** in the status surface to actually see the saving.

* 📂 **Reopen Archived Proposals**: Two flavours — Path A resubmits the original spec, Path B reopens it as a continuing draft. Archived ≠ gone.

* ✏️ **Editable Historical Proposal Tabs**: Older proposal panels are editable with a render-time override, so you can iterate on a previously-submitted spec.

* 🪪 **Pithier Team Branch Names**: Team-member branches are now `goal/<id8>/<role>-<short4>` instead of long unreadable strings — easier to scan in `git branch` output and PR lists.

* 📉 **Smaller Initial Bundle**: First-paint payload trimmed by lazy-loading routes and dropping unused chunks.

* 🧊 **Lower Server CPU**: Idle gateway CPU floor reduced through tighter watcher scheduling and fewer wakeups.

## 🐛 Bug Fixes

* 🪟 **Preview Tab Dedupe**: A long sequence of fixes — content-hash based dedupe across history restore, v3 snapshots without marker hash, first-open, legacy preview tabs, renderer-hash edge cases, and live-mount remount-skip. Identical preview content no longer spawns ghost tabs.

* 🏷️ **Duplicate Preview Tab Labels**: Fixed.

* 📍 **Filename Preview Tabs**: Stable now (no more flicker / reorder when the same file is re-previewed).

* 🧾 **Proposal Drift & Rehydrate**: Proposal revision drift fixed; goal-proposal spec rehydrates correctly after navigate-away/back; proposal transcript fidelity restored; proposal dismiss and staff-accept E2E paths no longer race.

* 🚪 **Tab-Strip + Historical Proposal Bugs from Master**: Cluster fix.

* 🧱 **Dynamic Panel Workspace Gaps**: Layout gaps eliminated; dynamic preview workspace tabs reliable.

* 📐 **Mobile Proposal Header Spacing**: Fixed.

* 🧠 **GPT-5.5 Context Metadata Drift**: Fixed.

* ⏱️ **BG Timer**: Fixed.

* 💰 **Compact Cost Display**: Fixed.

* 🔀 **Project Reorder Bug**: Reorder persists correctly across reloads.

* 🌀 **Streaming Bobbit Eye Flicker**: Gone.

* 🚿 **Git Widget Wedge**: Status widget no longer wedges in indeterminate states.

* 🏃 **Session-Create Race**: Closed.

* 🪪 **Staff `staffId` Persistence**: Staff sessions correctly persist their `staffId` link, including across reload.

* 🗂️ **Staff CWD Parity**: Staff agents now spawn in the same working directory the user sees in the inspector.

* 🔇 **Hide Ask Envelopes**: Ask widgets no longer trigger spurious envelope dots.

* 🛡️ **Goal Branch Push Safety**: Fixed; bare-push warning in the workflow guide tightened.

* 🧷 **Stale Shortcut Hint Titles**: Tooltip text refreshes correctly after `initApp` boot — no more drift from the shortcut registry.

* 🩺 **Verification Command-Step Timeout**: Subprocess tree leak that caused phase-0 commands to outlive their parent fixed.

* 🌐 **HTTP 429/529 Classifier**: Both now correctly classify as transient + provider-backoff for retry purposes.

* 🐳 **Sandbox `fd` v10 + Stale Container Recovery**: Sandbox image bumped to `fd` v10; stale containers from previous image versions are now recreated cleanly after a rebuild.

* 🪫 **Idle-Nudge Backoff**: Team-manager idle nudges now use exponential backoff across reply cycles instead of constant-rate poking.

* 🧪 **Verification Stability**: PR #605 review folded back into the verification pipeline so the cache-hit metric and step-state rendering stay honest.

* 🛠️ **Workflow Guide Bare-Push Warning**: Fires on the right shape of push.

---

🤖 Generated with [Bobbit](https://github.com/SuuBro/bobbit)
