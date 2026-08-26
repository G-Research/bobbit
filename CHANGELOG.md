# Changelog

Newest first. Each release appends a `## v<version>` section; the release
workflow publishes that section as the GitHub release body.

## v0.19.0

Upgrading from v0.18.0. This release adds durable file attachments, searchable transcript navigation, smoother question handling, and broader enterprise Git host support, while strengthening AI Gateway migration and project-scoped tool routing.

### ✨ New Features

* 📎 **Attach any browser file**: Upload arbitrary files while retaining specialized image and document handling. Large document context stays bounded, agents can read immutable attachment ranges on demand, and attachment identity survives queueing, retries, recovery, history, reloads, and sandbox handoff.

* 🧭 **Searchable transcript navigation**: Move between prompts with segmented controls, search and filter conversation history, jump to unresolved questions, and return reliably to the latest message across desktop and mobile layouts.

* 💬 **Durable question handling**: Dismiss an entire question card without waking the agent, while answered and unanswered state remains race-safe across reloads and appears consistently in sidebar indicators.

* 🌐 **Credential-aware enterprise PR status**: Bobbit can read PR status from structurally valid GitHub Enterprise remotes vouched for by local Git credentials, without broadening destructive merge permissions or exposing ambient credentials.

### 🐛 Bug Fixes

* 🤖 **Safe AI Gateway migration**: Verified legacy Bobbit AI Gateway provider blocks are adopted without rewriting user-owned JSONC. Live discovery and provider provenance are restored, and model-file permissions survive atomic updates.

* 🧰 **Project-correct agent tools**: Tool discovery, policy, activation, delegation, replacement, and marketplace invalidation now consistently use the owning project, preventing server or another project’s tool configuration from leaking into a session.

* 🗄️ **Cleaner archived goal output**: Agent-facing goal reads no longer include REST-only archived-session enrichment, keeping responses bounded while archived sessions remain available through the dedicated session tools.

## v0.18.0

Upgrading from v0.17.0. This release adds in-place session promotion, fresh-context controls, richer Extension Host APIs, independent staff forks, clearer context limits, and stronger startup and team recovery.

### ✨ New Features

* 🚀 **Promote sessions to goals**: Turn an active session into a Team Lead without changing its conversation, checkout, dirty files, branch, or sandbox. Promotion starts reliably after team setup and remains safe across retries and restarts.

* 🧹 **Fresh context with `/clear`**: Start with an empty model-facing conversation while retaining the same session, worktree, configuration, and permissions. Previous messages remain available in expandable read-only history, and staff can clear context before inbox delivery.

* 🪝 **Unified Extension Host hooks**: Extension packs can participate in typed lifecycle operations before commit or observe durable session, staff, goal, task, and gate events afterward, including through browser notifications and staff triggers.

* 💾 **Project-local extension data**: Schema-2 packs can declare stable read-write directories shared across worktrees, restored sessions, agents, and sandboxes. Data remains intact when a pack is disabled or uninstalled.

* 👥 **Independent staff forks**: Forking a staff session now creates a separate persistent staff identity with isolated configuration, triggers, inbox, authorization, and lifecycle ownership.

* 📊 **Clearer context capacity**: Context meters distinguish the operating soft limit from the provider’s full model capacity, with a target marker and semantic usage zones without changing compaction behavior.

* 🎭 **Bobbit sprites for extensions**: Extension UIs can create canonical animated Bobbit avatars through the Host API, with project-scoped identity resolution and automatic lifecycle cleanup.

### 🐛 Bug Fixes

* ⚡ **Faster, safer gateway recovery**: Startup checkpoints avoid repeating completed migration and historical recovery work, while failed checkpoints and interrupted server-build promotions remain durable and retryable.

* 🗄️ **Archived teams stay archived**: Sessions owned by archived goals no longer respawn after restart, and durable worktree ownership prevents premature cleanup or dangling team state.

* ✅ **Atomic goal validation**: Goal proposals, edits, acceptance, and child creation now share canonical validation. Invalid or stale candidates leave no partial goals, workflows, gates, worktrees, or draft mutations behind.

* 🧑‍💻 **Promptable read-only delegates**: Active read-only delegates can receive prompts while retaining their tool and mutation restrictions. Lifecycle and model-recovery state also remains accurate across refreshes and reconnects.

* ⌨️ **Command history preserves edits**: Changes made while browsing previous composer commands are retained as you move backward and forward through history.

## v0.17.0

Upgrading from v0.16.3. This release adds a built-in file explorer, conversation forks, richer sidebar views, durable reviews and state storage, and major improvements to agent-turn reliability.

### ✨ New Features

* 🗂️ **Built-in file explorer**: Browse files with read-only previews, Git decorations, working-tree diffs, editable breadcrumbs, filename search, changed-file filtering, path copying, and navigation to accessible directories.

* 🧭 **Project and status sidebar views**: Switch between project and status groupings, pin sessions, filter unread and read work, collapse sections, and reveal the current session even when search, filters, or archived state hide it.

* 🌿 **Fork conversations from history**: Copy historic prompts or fork a session immediately before a selected prompt, preserving the applicable transcript, model context, and working directory with an optional fresh worktree.

* 📝 **Grouped and durable Markdown reviews**: Open multi-file reviews in one workspace with responsive file navigation. Reviews up to 10 MiB are stored as session-owned artifacts and reopen reliably after reloads and recovery.

* 🔄 **Reliable agent turns**: The Pi runtime has been upgraded to 0.84.1 with durable prompt identities, FIFO delivery, restart and reconnect recovery, safer Stop handling, compact streaming, and clear delivery status for pending automation.

* 🖼️ **Session-local Markdown images**: Assistant messages can render workspace images referenced by relative, absolute, or `file://` paths through authenticated, session-scoped asset requests with traversal and size protections.

* 💾 **Durable SQLite state**: Gates, goals, and tasks now use per-project SQLite storage, with transactional migration and recovery for existing JSON state.

* 🧰 **Focused agent read tools**: Bobbit read operations now return compact, bounded summaries by default, support exact transcript inspection, and paginate larger gate and maintenance collections.

* 👥 **Improved staff controls**: Staff sessions gain standard sidebar actions, while the editor now provides a full avatar preview, role and accessory selectors, named colours, clearer runtime details, and separate prompt and trigger controls.

* 🏢 **Configured Git host support**: Hosts configured in `gh` are trusted consistently across PR status, merges, permissions, browser prompts, and PR Walkthroughs, improving GitHub Enterprise support without reading credentials.

### 🐛 Bug Fixes

* ▶️ **Safer goal and child-team startup**: Paused goals remain paused across restarts, teams wait for verified worktree setup, and failed child starts use bounded retries instead of making the gateway unresponsive.

* 🖼️ **Reliable previews and panel tabs**: Previews with spaces, Unicode, emoji, long names, and nested assets reopen correctly. Artifact-backed tabs avoid file races, overflow cleanly, and retain the selected tab after reload.

* ✅ **Explicit update API errors**: Resource update endpoints now reject unsupported fields with actionable `400` responses instead of silently returning success without saving the requested change.

* 📊 **Accurate activity and dashboard state**: Team-lead uptime, agent counts, session activity, and read state now remain accurate across lifecycle overlap, archival, replacement, and gateway restarts.

* ⏹️ **Force abort completes reliably**: Escape and force-abort actions now fall back to persisted transcript state when the agent state RPC hangs, preventing sessions from remaining stuck in `aborting`.

* 🔍 **Reliable workflow verification dispatch**: Verification phases run in a predictable order, reviewer prompts survive busy sessions and restarts, and duplicate or cancelled dispatches are handled exactly once.

* ☁️ **Bedrock-compatible agent tools**: `read_session`, `review_open`, and MCP meta-tools now expose Bedrock-compatible schemas while retaining strict runtime validation and native argument support.

* 🤖 **Exact model metadata**: Host, sandbox, restore, replacement, AI Gateway, and custom-model paths now use the authoritative effective model tuple instead of stale compatibility shims.

## v0.16.3

Upgrading from v0.16.2. This release adds a command-line version flag and completes the automated release workflow fixes.

### ✨ New Features

* 🏷️ **Command-line version flag**: Run `bobbit --version` or `npx @gresearch/bobbit@latest --version` to print the installed Bobbit version and exit without starting the gateway or creating configuration state.

### 🐛 Bug Fixes

* 📦 **Reliable GitHub release creation**: The checkout-free release job now targets the repository explicitly, allowing it to create the GitHub release after npm publication and immutable tag creation.

## v0.16.2

Upgrading from v0.16.1. This release fixes automated release completion.

### 🐛 Bug Fixes

* 📦 **Reliable release completion**: Automated releases now handle a missing version tag correctly after npm publication, allowing the immutable source tag and GitHub release to be created as intended.

## v0.16.1

Upgrading from v0.15.1. This release adds shared Git and PR status, URL subpath hosting, keyboard steering, clearer workflow guidance, and broad improvements to authentication, recovery, and performance.

### ✨ New Features

* 🌐 **Host Bobbit under a URL path**: Gateways can now serve Bobbit under a path such as `/bobbit`, including the UI, API, sign-in, previews, and deep links. Use `--base-path` or `BOBBIT_BASE_PATH`, for example when adding Bobbit to a command centre.

* 🔄 **Shared Git and PR status**: Sessions, goals, sidebar badges, and staff triggers now share the same GitHub state. Duplicate requests are combined and capped to reduce pressure on GitHub and gateway infrastructure. The last known state remains visible during temporary failures, with clear freshness and error indicators.

* 🧭 **Clearer workflow failure guidance**: Workflow authors can add guidance for failed verification steps, giving Team Leads practical next steps when a check fails. Built-in workflows also produce more focused review findings and compare options during non-trivial design work.

* ⌨️ **Keyboard steering**: Press `Ctrl+Enter` on Windows/Linux or `Cmd+Enter` on macOS to steer the active turn. Composer text and attachments are preserved if a session changes or preflight work is still finishing.

* 🎀 **Ponytail accessory**: Staff and agent avatars can now use an animated centre-parted ponytail accessory in both full-size and inline views.

### 🐛 Bug Fixes

* ▶️ **Resume paused goals when starting a team**: Starting a team now resumes an eligible paused goal automatically instead of failing. Repeated or simultaneous requests are handled safely.

* 🔐 **More reliable Anthropic sign-in**: Anthropic OAuth now handles refresh, cancellation, logout, rejected requests, and concurrent credential access more safely. Renewable host credentials are still kept out of sandboxes unless explicitly enabled.

* 🖼️ **Reopen saved previews reliably**: Previews now reopen correctly after a reload or transcript compaction. This also fixes preview files with spaces, Unicode, emoji, percent signs, long names, and nested assets.

* ⚡ **Faster sessions and UI**: Search indexing, recovery, streamed replies, installed-PWA checks, and avatar animations now do less repeated work. Pack scans are cached, and the launchers provide a configurable 8 GiB Node memory ceiling for larger workloads.

* 🔄 **Better session and workflow recovery**: Workflow drafts and server-created IDs now survive delayed saves. Interrupted prompt queues can resume or show a clear Retry action, and restarted sessions keep provider, model, and thinking selections consistent.

* 🛡️ **Safer background work and configuration**: Project and sandbox settings are written atomically and failures are reported clearly. Background jobs and verification steps now recover more reliably after restarts and include their final output before reporting completion.

* 🌐 **Cross-origin saves**: Remote gateways and cross-origin reverse proxies now accept authenticated `PATCH` requests, so side-panel state and other settings save correctly without weakening trusted-origin checks.

* 🧱 **Protect user-managed worktrees**: Startup and shutdown no longer repair or remove manually managed worktrees. Cleanup only removes archived session worktrees owned by the current Bobbit instance.

## v0.15.1

Upgrading from v0.15.0. This release adds Claude Opus 5 support and dedicated verifiable bug reviews, while improving model-selection and multi-repository Git status reliability.

### ✨ New Features

* 🤖 **Claude Opus 5 & Pi 0.82.1**: Bobbit now exposes Claude Opus 5 through the authoritative Pi model catalog. Provider, model, and thinking-level selections travel together through sessions, delegates, team workers, restarts, and recovery, with safe rollback when a requested runtime tuple cannot be verified.

* 🔍 **Verifiable bug-hunt reviews**: Built-in implementation workflows now include a dedicated read-only reviewer focused on reproducible bugs in the current branch diff.

### 🐛 Bug Fixes

* 🧩 **Accurate polyrepo Git status**: Goal and session widgets now retain named component repositories, aggregate partial results conservatively, survive team-lead restart recovery, and avoid hiding valid component status when the project container itself is not a Git repository.

## v0.15.0

Upgrading from v0.14.2. This release makes it clearer who is speaking in a session, adds project-level notification control, refreshes the agent runtime, and improves responsiveness and recovery across sessions, previews, file mentions, and multi-repository teams.

### ✨ New Features

* 🪪 **Message author identity**: Bobbit now preserves whether prompts came from the user, another agent, or the system, with clear labels where a transcript would otherwise be ambiguous. Authorship survives reloads, search, compaction, delegation, and restart recovery.

* 🔔 **Per-project completion sounds**: Each project can inherit the global agent-finish sound preference or override it, so noisy projects can be muted without losing unread indicators and favicon notifications.

* 🤖 **Updated agent runtime & model metadata**: The Pi runtime has been refreshed with current provider and model metadata, including GPT-5.6 capabilities, while preserving Bobbit's existing Codex OAuth, sandbox, and provider-routing behavior.

* 🧭 **Predictable standard sessions**: New ordinary sessions now start with the built-in General role, giving them a consistent default tool and behavior profile.

### 🐛 Bug Fixes

* ⚡ **Faster cold session loading**: Transcript rendering starts before slower workspace hydration, making large and revisited sessions appear sooner while preserving review tabs, restrictions, and proposal state.

* 📎 **Reliable file mentions**: `@`-mentioned files now resolve safely under large, concurrent, code-heavy, and deeply nested prompts without misclassifying ordinary text or Markdown code.

* 🖼️ **Consistent HTML preview themes**: Inline and mounted previews now receive the correct Bobbit theme tokens across source, packaged, reload, and standalone-tab paths.

* 🧩 **Multi-repository team workers**: Team and delegated agents now inherit the correct coordinated repository heads and worktree layout across collisions, rollback, and cleanup.

* 🧹 **Responsive background maintenance**: Preview, worktree, archive, mutation, and orphan cleanup now use bounded asynchronous I/O so large maintenance jobs do not stall unrelated gateway activity.

* 🌐 **Network-filesystem startup**: Dependency checks no longer hang or corrupt runtime state on NFS and other slow or unusual filesystem layouts.

* 🗂️ **Project proposal recovery**: A server-restored project proposal can no longer be erased when an empty local draft finishes loading later.

* 🖥️ **Newer Node.js PTY support**: The bundled prebuilt terminal dependency has been updated for more reliable integrated terminal startup on current Node.js versions.

## v0.14.2

Upgrading from v0.14.1. This release makes sessions faster and smoother to revisit, strengthens browser authentication, and brings review and reset controls closer to active workflow gates.

### ✨ New Features

* ⚡ **Faster session loading & recovery**: Large and archived session histories load with substantially less work, while startup recovery now keeps expensive filesystem and model checks bounded so the gateway stays responsive.

* 🔄 **Gate reset recovery**: Resetting a workflow gate now reopens a completed active goal, rearms its team lead, and updates the goal status immediately so work can continue normally.

* ✅ **Reviews on gate cards**: Active human sign-off reviews can be launched directly from goal status, live verification, and gate inspection cards, with the review action placed beside the relevant step name.

* 🔐 **Stateless browser authentication**: Browser cookies are now securely signed instead of stored in a server-side registry, improving restart and multi-process reliability while preserving preview, sandbox, and operator authentication behavior.

* 🏷️ **Visible build identity**: Settings now shows the running Bobbit version and, for source checkouts, the short commit SHA so operators can quickly confirm which build is active.

### 🐛 Bug Fixes

* 📱 **Portrait session navigation**: Returning to a healthy session from the portrait back-to-list flow now reuses the correct live panel without an unnecessary loader or replacement connection, while stale and mismatched cache entries are safely discarded.

## v0.14.1

Upgrading from v0.14.0. This release makes Bobbit safer around Git publication, expands project-aware proposals and AI Gateway routing, and strengthens recovery when interrupted tool history would previously leave a session unusable.

### ✨ New Features

* 🌐 **AI Gateway discovery & routing**: Bobbit can discover compatible models, metadata, and pricing from an AI Gateway well-known endpoint, persist the resolved configuration safely, and route sandboxed sessions through the configured gateway.

* 🗂️ **Cross-project proposals**: Agents can propose goals, projects, roles, tools, and staff into a different registered project. Proposal panels clearly show the target project and acceptance now routes changes to the correct project and workflow.

* 🛡️ **Local-first Git lifecycle**: Worktree creation, child-goal merges, and session status checks no longer push branches implicitly. Non-primary branch status stays focused on local working state and no longer presents remote-publication copy or Push controls.

* 📦 **More compact gateway tools**: Bobbit read, orchestration, and administration tools now return bounded compact responses by default, with explicit verbose views for deeper inspection. Context-heavy transcript reads are guarded to prevent accidental prompt bloat.

### 🐛 Bug Fixes

* 🧵 **Interrupted session recovery**: Orphaned tool results and poisoned transcript branches are repaired in place across restart, role assignment, sandbox rehydration, and queued-prompt recovery, preventing damaged history from stranding otherwise recoverable sessions.

* ✅ **Project proposal acceptance**: New, provisional, existing, and cross-project proposals now take the correct create, promote, or edit path, including after proposal revisions change the target.

* 🧩 **Skill discovery consistency**: The Skills page and composer now share the active project scope, discover nested plugin skills and configured custom directories consistently, and recover the correct scope after refresh.

* 🎨 **Workspace polish**: Headquarters uses a neutral accent, and the desktop working-directory footer is clearer and easier to inspect.

## v0.14.0

Upgrading from v0.13.0. This is a large release. The headline is deeper self-service control over your Bobbit instance — agents can now drive the gateway itself, projects and MCP servers are managed from the UI, and a new Support Assistant helps you when things go wrong. Alongside that: a richer git diff viewer, more resilient sessions and gates across restarts, Google/OpenRouter model options, and a steady stream of chat, sidebar, and mobile polish.

### ✨ New Features

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

### 🐛 Bug Fixes

* 🔄 **Restart resilience**: Fixed staff/session/goal resurrection on restart, verifier and reviewer restart recovery, team-prompt recovery, and terminal reattach after reconnect.

* 🧱 **Worktree & fork reliability**: Non-destructive goal-worktree sync during gate verification, unified worktree cleanup, unborn-HEAD fallback, fork cwd rebasing, local-only sub-agent branches, and a Windows `EPERM` atomic-rename fix.

* 🧵 **Compaction & message ordering**: Fixed compaction history recovery, live-message ordering after compaction, stranded optimistic prompt ordering, and composer draft loss.

* 🌐 **Connection stability**: Fixed WebSocket backpressure and frame-limit routing, and git-status/git-pill fetch flicker.

* ⚙️ **Gate & verification**: Faster gateway shutdown, restart-safe gate commands, bounded gate inspection artifacts, and smoother verification-phase rendering.

* 🎛️ **Settings & models**: Fixed the model-picker switch, provider-key status display, OpenRouter key propagation, and unwanted autofill in settings fields.

### 🧪 Research Preview & Experimental Notes

* 🔍 **PR Walkthrough**: Now a guided, token-efficient review flow with durable reviews, local `gh`-based review posting, intraline diff highlights, and a more focused half-panel layout. Still beta and evolving.

* 🧩 **Extension platform & marketplace**: Pack schema v2, a lifecycle hub with per-turn provider hooks and extension channels, and first-party marketplace packs continue to mature as research-preview foundations for extensibility.

* 🌳 **Sub-Goals**: Experimental sub-goals remain off by default, with improvements to creation UX and hierarchical goal metadata for opt-in users.

## v0.13.0

Upgrading from v0.12.0. This release focuses on polish and robustness: safer agent restarts, delegates that survive server restarts, stronger worktree/session recovery, steadier gates, and smoother chat/sidebar behavior. It also includes several research-preview surfaces, but the main story is reliability across day-to-day Bobbit workflows.

### ✨ New Features

* 🔄 **Refresh Agent**: Restart a session’s agent from the sidebar with the latest prompt, tools, MCP configuration, permissions, and auth state while preserving transcript history.

* 🧵 **Durable Delegates**: `team_delegate` child agents now survive gateway restarts and can be re-collected afterward, making longer multi-agent work less fragile.

* 🧭 **Unified Side Panels**: Review, artifact, inbox, and related surfaces now share a more consistent side-panel foundation, with closed-tab persistence and better recovery after reload.

* 🖼️ **Chat & Appearance Controls**: New chat customization options include a bobbit-sprite/text toggle, nurse-cap accessory, finish-beep bell toggle, default-on timestamps, and image-model locking to the selector.

* 🛠️ **Agent Tooling Improvements**: `bash_bg` processes are now persistent and re-attachable across restart, `read_session` is easier to inspect, gate inspection can filter by step, and agents get clearer guidance for safe tool use.

### 🐛 Bug Fixes

* 🧱 **Worktree Reliability**: Fixed archived-session continue flows, session cwd/base rebasing, shared-worktree guardrails, fork handling, pool cleanup, remote-less sandbox clone fallback, and fork-PR release rules.

* 🧪 **Gate & Verification Stability**: Verification resume, async gate reminders, skipped-step notices, phase concurrency, retained gate logs, failure markdown, bypass feedback, and top-level goal proposal flows are more reliable.

* 💬 **Chat Stream Robustness**: Fixed missing live messages after hibernate/respawn, image/attachment-only prompts, markdown dollar-token rendering, deferred transcript scrolling, Stop/steer validation, and error-recovery copy.

* 📱 **Mobile & PWA Fixes**: Installed iOS PWAs now fill the screen correctly, mobile chat respects safe areas, sidebar overflow is reduced, and the gateway-starting screen includes a Connect escape hatch.

* 🧑‍💼 **Staff & Role Flows**: Staff role selection, creation guards, sidebar placement, and polyrepo staff worktree provisioning now behave more predictably.

* 🔐 **OAuth, MCP & Permissions**: Codex OAuth auto-selects browser login, inherited MCP policy labels are corrected, and MCP permissions refresh correctly on agent restart.

* 🧹 **Noise & Performance**: Reduced routine server log noise, memoized sprite rendering, optimized search-store clearing, improved transcript snapshot timing, and fixed git-status dropdown flicker.

* 🧰 **Release & Test Hardening**: The test suite now enforces phase ownership, release docs use isolated detached worktrees, npm audit fixes are included, and E2E/manual canaries are more stable.

### 🧪 Research Preview & Experimental Notes

* 🧩 **Marketplace & Extension Host**: Bobbit includes first-party marketplace packs and a durable extension-host contract as research-preview foundations for future extensibility.

* 🌳 **Sub-Goals**: Experimental sub-goals remain off by default, but this release improves proposal controls, defaults, prompt gating, and visibility rules for users who opt in.

* 🔍 **PR Walkthrough**: PR Walkthrough remains beta and continues to evolve alongside the marketplace/extension-host work; this release includes plumbing and recovery improvements rather than a polished end-user milestone.

## v0.12.0

Upgrading from v0.11.0. This release adds human sign-off gates, richer goal/gate status surfaces, a settings restart button, sidebar actions, Opus 4.8 support, AI Gateway pricing visibility, and a long run of reliability fixes across sessions, sandboxes, workflows, and mobile chat. It also includes the new PR Walkthrough workflow as a beta feature.

### ✨ New Features

* ✅ **Human Sign-Off Gates**: Workflows can now require explicit human approval before implementation proceeds. The goal status widget, review pane, and gate surfaces all understand sign-off state so approval checkpoints are visible and enforceable.

* 🧭 **Gate & Goal Status Polish**: Gate counts sync more reliably, fresh resets are clearer, gate inspection supports slicing, and the goal status popover is easier to scan.

* 🧰 **Sidebar Actions Menu**: Common session/project actions now live in a compact sidebar menu, including safer background-process kill confirmation.

* 🔄 **Settings Restart Button**: Restart the Bobbit server from Settings after config changes instead of dropping to a terminal.

* 🧠 **Claude Opus 4.8 Support**: Bobbit now ranks Opus 4.8 variants correctly, supports Extra high thinking where available, and persists those model choices without fallback drift.

* 🧩 **Polyrepo Session Status**: Git status in sessions now handles multi-repo projects more accurately, including per-component worktree state.

* 🪟 **Open Session in New Window**: Sessions can be opened in a separate browser window for easier side-by-side work.

* 💸 **AI Gateway Pricing Visibility**: Bobbit now reports AI Gateway pricing more clearly, making model-cost decisions easier to understand.

* 🔍 **PR Walkthrough [BETA]**: Launch a dedicated PR walkthrough agent from a session, review scoped diff bundles, map findings to hunks, and publish structured YAML back into the UI. Trusted-host management and a guided orientation rail make the review flow safer and easier to follow.

### 🐛 Bug Fixes

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

## v0.11.0

Upgrading from v0.10.0. The side panel grew a proper Chrome-style tab strip with drag-and-drop, prompt-by-prompt history navigation, a friendlier Add Project dialog, a staff inbox queue, and automatic retry on provider overload — plus a long tail of preview, proposal, and sidebar fixes.

### ✨ New Features

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

### 🐛 Bug Fixes

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

## v0.10.0

Upgrading from v0.9.0. Compaction is now a first-class citizen, the sidebar grew filters and a sleepier bobbit, and the gateway finally honours per-project base refs across every git affordance.

### ✨ New Features

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

### 🐛 Bug Fixes

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

## v0.9.0

Upgrading from v0.8.0. Lots of polish, a preview panel, and a steer subsystem that finally behaves.

### ✨ New Features

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

### 🐛 Bug Fixes

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

## v0.8.0

Upgrading from v0.7.1. Buckle up.

### ✨ New Features

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

### 🐛 Bug Fixes

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
