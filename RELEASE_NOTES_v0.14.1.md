# Bobbit v0.14.1

Upgrading from v0.14.0. This release makes Bobbit safer around Git publication, expands project-aware proposals and AI Gateway routing, and strengthens recovery when interrupted tool history would previously leave a session unusable.

## ✨ New Features

* 🌐 **AI Gateway discovery & routing**: Bobbit can discover compatible models, metadata, and pricing from an AI Gateway well-known endpoint, persist the resolved configuration safely, and route sandboxed sessions through the configured gateway.

* 🗂️ **Cross-project proposals**: Agents can propose goals, projects, roles, tools, and staff into a different registered project. Proposal panels clearly show the target project and acceptance now routes changes to the correct project and workflow.

* 🛡️ **Local-first Git lifecycle**: Worktree creation, child-goal merges, and session status checks no longer push branches implicitly. Non-primary branch status stays focused on local working state and no longer presents remote-publication copy or Push controls.

* 📦 **More compact gateway tools**: Bobbit read, orchestration, and administration tools now return bounded compact responses by default, with explicit verbose views for deeper inspection. Context-heavy transcript reads are guarded to prevent accidental prompt bloat.

## 🐛 Bug Fixes

* 🧵 **Interrupted session recovery**: Orphaned tool results and poisoned transcript branches are repaired in place across restart, role assignment, sandbox rehydration, and queued-prompt recovery, preventing damaged history from stranding otherwise recoverable sessions.

* ✅ **Project proposal acceptance**: New, provisional, existing, and cross-project proposals now take the correct create, promote, or edit path, including after proposal revisions change the target.

* 🧩 **Skill discovery consistency**: The Skills page and composer now share the active project scope, discover nested plugin skills and configured custom directories consistently, and recover the correct scope after refresh.

* 🎨 **Workspace polish**: Headquarters uses a neutral accent, and the desktop working-directory footer is clearer and easier to inspect.

---

🤖 Generated with [Bobbit](https://github.com/SuuBro/bobbit)
