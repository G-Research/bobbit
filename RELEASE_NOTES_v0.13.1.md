# Bobbit v0.13.1

Hotfix release for v0.13.0. This patch backports a focused set of reliability fixes without pulling in the larger post-v0.13.0 feature work currently on `master`.

## ✨ New Features

* No new features — this is a code-only hotfix release.

## 🐛 Bug Fixes

* 🌱 **Unborn Git Repos**: Sessions, goals, worktree pools, and sandbox worktrees now handle repositories whose `HEAD` has no initial commit, falling back cleanly instead of retrying or failing with confusing git errors.

* 🖼️ **Preview Header Restore**: Restored preview tabs now show the expected preview controls immediately, including refresh and open-in-new-tab actions.

* 📝 **Review Pane Reopen**: A fresh live `review_open` can reopen revised review content after a previous approve/reject submission, while historical replay still stays suppressed.

* 🧩 **Structured Review Results**: Review tool results are now detected from structured or nested tool-result payloads, not only raw JSON text blocks, so inline markdown review panes hydrate reliably across provider paths.

---

🤖 Generated with [Bobbit](https://github.com/SuuBro/bobbit)
