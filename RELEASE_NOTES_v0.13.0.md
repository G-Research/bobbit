# Bobbit v0.13.0

Upgrading from v0.12.0. This release focuses on polish and robustness: safer agent restarts, delegates that survive server restarts, stronger worktree/session recovery, steadier gates, and smoother chat/sidebar behavior. It also includes several research-preview surfaces, but the main story is reliability across day-to-day Bobbit workflows.

## ✨ New Features

* 🔄 **Refresh Agent**: Restart a session’s agent from the sidebar with the latest prompt, tools, MCP configuration, permissions, and auth state while preserving transcript history.

* 🧵 **Durable Delegates**: `team_delegate` child agents now survive gateway restarts and can be re-collected afterward, making longer multi-agent work less fragile.

* 🧭 **Unified Side Panels**: Review, artifact, inbox, and related surfaces now share a more consistent side-panel foundation, with closed-tab persistence and better recovery after reload.

* 🖼️ **Chat & Appearance Controls**: New chat customization options include a bobbit-sprite/text toggle, nurse-cap accessory, finish-beep bell toggle, default-on timestamps, and image-model locking to the selector.

* 🛠️ **Agent Tooling Improvements**: `bash_bg` processes are now persistent and re-attachable across restart, `read_session` is easier to inspect, gate inspection can filter by step, and agents get clearer guidance for safe tool use.

## 🐛 Bug Fixes

* 🧱 **Worktree Reliability**: Fixed archived-session continue flows, session cwd/base rebasing, shared-worktree guardrails, fork handling, pool cleanup, remote-less sandbox clone fallback, and fork-PR release rules.

* 🧪 **Gate & Verification Stability**: Verification resume, async gate reminders, skipped-step notices, phase concurrency, retained gate logs, failure markdown, bypass feedback, and top-level goal proposal flows are more reliable.

* 💬 **Chat Stream Robustness**: Fixed missing live messages after hibernate/respawn, image/attachment-only prompts, markdown dollar-token rendering, deferred transcript scrolling, Stop/steer validation, and error-recovery copy.

* 📱 **Mobile & PWA Fixes**: Installed iOS PWAs now fill the screen correctly, mobile chat respects safe areas, sidebar overflow is reduced, and the gateway-starting screen includes a Connect escape hatch.

* 🧑‍💼 **Staff & Role Flows**: Staff role selection, creation guards, sidebar placement, and polyrepo staff worktree provisioning now behave more predictably.

* 🔐 **OAuth, MCP & Permissions**: Codex OAuth auto-selects browser login, inherited MCP policy labels are corrected, and MCP permissions refresh correctly on agent restart.

* 🧹 **Noise & Performance**: Reduced routine server log noise, memoized sprite rendering, optimized search-store clearing, improved transcript snapshot timing, and fixed git-status dropdown flicker.

* 🧰 **Release & Test Hardening**: The test suite now enforces phase ownership, release docs use isolated detached worktrees, npm audit fixes are included, and E2E/manual canaries are more stable.

## 🧪 Research Preview & Experimental Notes

* 🧩 **Marketplace & Extension Host**: Bobbit includes first-party marketplace packs and a durable extension-host contract as research-preview foundations for future extensibility.

* 🌳 **Sub-Goals**: Experimental sub-goals remain off by default, but this release improves proposal controls, defaults, prompt gating, and visibility rules for users who opt in.

* 🔍 **PR Walkthrough**: PR Walkthrough remains beta and continues to evolve alongside the marketplace/extension-host work; this release includes plumbing and recovery improvements rather than a polished end-user milestone.

---

🤖 Generated with [Bobbit](https://github.com/SuuBro/bobbit)
