# Bobbit v0.15.0

Upgrading from v0.14.2. This release makes it clearer who is speaking in a session, adds project-level notification control, refreshes the agent runtime, and improves responsiveness and recovery across sessions, previews, file mentions, and multi-repository teams.

## ✨ New Features

* 🪪 **Message author identity**: Bobbit now preserves whether prompts came from the user, another agent, or the system, with clear labels where a transcript would otherwise be ambiguous. Authorship survives reloads, search, compaction, delegation, and restart recovery.

* 🔔 **Per-project completion sounds**: Each project can inherit the global agent-finish sound preference or override it, so noisy projects can be muted without losing unread indicators and favicon notifications.

* 🤖 **Updated agent runtime & model metadata**: The Pi runtime has been refreshed with current provider and model metadata, including GPT-5.6 capabilities, while preserving Bobbit's existing Codex OAuth, sandbox, and provider-routing behavior.

* 🧭 **Predictable standard sessions**: New ordinary sessions now start with the built-in General role, giving them a consistent default tool and behavior profile.

## 🐛 Bug Fixes

* ⚡ **Faster cold session loading**: Transcript rendering starts before slower workspace hydration, making large and revisited sessions appear sooner while preserving review tabs, restrictions, and proposal state.

* 📎 **Reliable file mentions**: `@`-mentioned files now resolve safely under large, concurrent, code-heavy, and deeply nested prompts without misclassifying ordinary text or Markdown code.

* 🖼️ **Consistent HTML preview themes**: Inline and mounted previews now receive the correct Bobbit theme tokens across source, packaged, reload, and standalone-tab paths.

* 🧩 **Multi-repository team workers**: Team and delegated agents now inherit the correct coordinated repository heads and worktree layout across collisions, rollback, and cleanup.

* 🧹 **Responsive background maintenance**: Preview, worktree, archive, mutation, and orphan cleanup now use bounded asynchronous I/O so large maintenance jobs do not stall unrelated gateway activity.

* 🌐 **Network-filesystem startup**: Dependency checks no longer hang or corrupt runtime state on NFS and other slow or unusual filesystem layouts.

* 🗂️ **Project proposal recovery**: A server-restored project proposal can no longer be erased when an empty local draft finishes loading later.

* 🖥️ **Newer Node.js PTY support**: The bundled prebuilt terminal dependency has been updated for more reliable integrated terminal startup on current Node.js versions.

---

🤖 Generated with [Bobbit](https://github.com/SuuBro/bobbit)
