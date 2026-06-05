# Bobbit v0.12.0

Upgrading from v0.11.0. This release adds human sign-off gates, richer goal/gate status surfaces, a settings restart button, sidebar actions, Opus 4.8 support, AI Gateway pricing visibility, and a long run of reliability fixes across sessions, sandboxes, workflows, and mobile chat. It also includes the new PR Walkthrough workflow as a beta feature.

## ✨ New Features

* ✅ **Human Sign-Off Gates**: Workflows can now require explicit human approval before implementation proceeds. The goal status widget, review pane, and gate surfaces all understand sign-off state so approval checkpoints are visible and enforceable.

* 🧭 **Gate & Goal Status Polish**: Gate counts sync more reliably, fresh resets are clearer, gate inspection supports slicing, and the goal status popover is easier to scan.

* 🧰 **Sidebar Actions Menu**: Common session/project actions now live in a compact sidebar menu, including safer background-process kill confirmation.

* 🔄 **Settings Restart Button**: Restart the Bobbit server from Settings after config changes instead of dropping to a terminal.

* 🧠 **Claude Opus 4.8 Support**: Bobbit now ranks Opus 4.8 variants correctly, supports Extra high thinking where available, and persists those model choices without fallback drift.

* 🧩 **Polyrepo Session Status**: Git status in sessions now handles multi-repo projects more accurately, including per-component worktree state.

* 🪟 **Open Session in New Window**: Sessions can be opened in a separate browser window for easier side-by-side work.

* 💸 **AI Gateway Pricing Visibility**: Bobbit now reports AI Gateway pricing more clearly, making model-cost decisions easier to understand.

* 🔍 **PR Walkthrough [BETA]**: Launch a dedicated PR walkthrough agent from a session, review scoped diff bundles, map findings to hunks, and publish structured YAML back into the UI. Trusted-host management and a guided orientation rail make the review flow safer and easier to follow.

## 🐛 Bug Fixes

* 📌 **Pinned Base Ref**: Project add-time `base_ref` is now pinned correctly, making worktree start-points predictable and preventing later branch drift from changing new session bases.

* 💬 **Comms Stack Stability**: Fixed duplicate messages, lost prompts, Stop handling, image rendering, and mojibake in streamed chat flows.

* 🐳 **Remote-Less Sandbox Startup**: Sandboxed sessions now start correctly for projects without remotes, including clone fallback handling.

* 🧑‍💼 **Staff Worktrees in Polyrepo Projects**: Staff provisioning now creates the right sibling worktrees across multi-repo projects.

* 🔗 **Session Deep Links**: Session URLs are canonicalized and route correctly after reloads and navigation.

* 📱 **Mobile Chat Navigation**: The “Jump to previous prompt” button now clears the fixed mobile header, and the target prompt lands below it.

* 📱 **Mobile Settings Tabs**: Settings tabs no longer overflow awkwardly on small screens.

* 🧮 **Gate Count & Reset Bugs**: Gate counts, fresh resets, and human sign-off workflow gates now stay in sync with workflow state.

* ⏳ **Background Process Wait**: `bash_bg wait` no longer fails with fetch errors on long-running processes.

* 🧪 **Fixture Stability**: The BashRenderer fixture bundle now builds atomically on Windows, preventing release-test timeouts from partial bundle loads.

---

🤖 Generated with [Bobbit](https://github.com/SuuBro/bobbit)
