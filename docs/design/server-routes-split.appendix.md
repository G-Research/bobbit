# Appendix - full route inventory (209 routes)

Generated from `src/server/server.ts` lines 1461-8334. See [server-routes-split.md](./server-routes-split.md) for context.

Total routes: 209

### `routes/projects.ts` - 16 routes

| Method | Path | Lines |
|---|---|---|
| POST | `/api/projects/detect` | 1797-1852 |
| POST | `/api/projects/scan` | 1853-1875 |
| GET | `/api/projects/:id/structured` | 1876-1889 |
| POST | `/api/projects/:id/rescan-repos` | 1890-1905 |
| GET | `/api/browse-directory` | 1906-1958 |
| GET | `/api/projects` | 1959-1966 |
| POST | `/api/projects` | 1967-2129 |
| GET | `/api/projects/:id` | 2130-2137 |
| PUT | `/api/projects/:id` | 2138-2156 |
| DELETE | `/api/projects/:id` | 2157-2192 |
| POST | `/api/projects/:id/promote` | 2193-2212 |
| GET | `/api/projects/:id/config(?:/(defaults|resolved))?` | 2213-2226 |
| GET | `/api/projects/:id/config(?:/(defaults|resolved))?` | 2227-2230 |
| GET | `/api/projects/:id/config(?:/(defaults|resolved))?` | 2231-2270 |
| PUT | `/api/projects/:id/config(?:/(defaults|resolved))?` | 2271-2479 |
| GET | `/api/projects/:id/qa-testing-config` | 2480-2487 |

### `routes/goals.ts` - 16 routes

| Method | Path | Lines |
|---|---|---|
| GET | `/api/goals` | 3087-3155 |
| POST | `/api/goals` | 3156-3259 |
| POST | `/api/goals/:id/retry-setup` | 3260-3297 |
| GET | `/api/goals/:id` | 3298-3304 |
| PUT | `/api/goals/:id` | 3305-3325 |
| DELETE | `/api/goals/:id` | 3326-3383 |
| POST | `/api/goals/:id/(?:team|swarm)/start` | 5046-5058 |
| POST | `/api/goals/:id/(?:team|swarm)/spawn` | 5059-5094 |
| POST | `/api/goals/:id/(?:team|swarm)/dismiss` | 5095-5111 |
| GET | `/api/goals/:id/(?:team|swarm)` | 5305-5317 |
| POST | `/api/goals/:id/(?:team|swarm)/steer` | 5318-5352 |
| POST | `/api/goals/:id/(?:team|swarm)/abort` | 5353-5382 |
| POST | `/api/goals/:id/(?:team|swarm)/prompt` | 5383-5439 |
| GET | `/api/goals/:id/(?:team|swarm)/agents` | 5440-5474 |
| POST | `/api/goals/:id/(?:team|swarm)/complete` | 5475-5487 |
| POST | `/api/goals/:id/(?:team|swarm)/teardown` | 5488-5503 |

### `routes/models.ts` - 15 routes

| Method | Path | Lines |
|---|---|---|
| GET | `/api/models` | 3770-3780 |
| GET | `/api/image-models` | 3781-3790 |
| GET | `/api/custom-providers` | 3860-3866 |
| POST | `/api/custom-providers/test` | 3867-3889 |
| POST | `/api/custom-providers` | 3890-3916 |
| DELETE | `/api/custom-providers/` | 3917-3932 |
| GET | `/api/provider-keys` | 3933-3942 |
| POST | `/api/provider-keys/` | 3943-3959 |
| DELETE | `/api/provider-keys/` | 3960-3973 |
| GET | `/api/aigw/status` | 3974-3990 |
| POST | `/api/aigw/configure` | 3991-4008 |
| DELETE | `/api/aigw/configure` | 4009-4017 |
| POST | `/api/aigw/test` | 4018-4033 |
| POST | `/api/aigw/refresh` | 4034-4053 |
| POST | `/api/models/test` | 4054-4159 |

### `routes/preferences-config.ts` - 13 routes

| Method | Path | Lines |
|---|---|---|
| GET | `/api/system-prompt-context` | 1637-1652 |
| PUT | `/api/system-prompt-context` | 1653-1677 |
| POST | `/api/system-prompt/customise` | 1678-1704 |
| GET | `/api/config/cwd` | 3586-3591 |
| PUT | `/api/config/cwd` | 3592-3623 |
| GET | `/api/preferences` | 3624-3629 |
| PUT | `/api/preferences` | 3630-3645 |
| GET | `/api/project-config` | 3646-3651 |
| GET | `/api/project-config/defaults` | 3652-3657 |
| GET | `/api/config-directories` | 3658-3668 |
| DELETE | `/api/config-directories` | 3669-3682 |
| POST | `/api/config-directories/reset` | 3683-3692 |
| PUT | `/api/project-config` | 3693-3769 |

### `routes/sessions-proposals.ts` - 12 routes

| Method | Path | Lines |
|---|---|---|
| GET | `/api/sessions/:id/proposal/:id(/edit|/seed|/restore)?` | 5912-5928 |
| DELETE | `/api/sessions/:id/proposal/:id(/edit|/seed|/restore)?` | 5929-5943 |
| POST | `/api/sessions/:id/proposal/:id(/edit|/seed|/restore)?` | 5944-5980 |
| POST | `/api/sessions/:id/proposal/:id(/edit|/seed|/restore)?` | 5981-6017 |
| POST | `/api/sessions/:id/proposal/:id(/edit|/seed|/restore)?` | 6018-6064 |
| GET | `/api/sessions/:id/proposals` | 6065-6093 |
| POST | `/api/sessions/:id/generate-title` | 6094-6110 |
| PUT | `/api/sessions/:id/title` | 6111-6128 |
| PUT | `/api/sessions/:id/draft` | 7382-7396 |
| GET | `/api/sessions/:id/prompt-sections` | 7409-7436 |
| GET | `/api/sessions/:id/draft` | 7437-7454 |
| DELETE | `/api/sessions/:id/draft` | 7455-7468 |

### `routes/sessions.ts` - 10 routes

| Method | Path | Lines |
|---|---|---|
| GET | `/api/sessions` | 2535-2639 |
| GET | `/api/sessions/:id` | 2722-2804 |
| POST | `/api/sessions` | 2805-3086 |
| GET | `/api/sessions/:id` | 5504-5520 |
| DELETE | `/api/sessions/:id` | 5521-5557 |
| PATCH | `/api/sessions/:id` | 5763-5884 |
| DELETE | `/api/sessions/` | 7525-7551 |
| POST | `/api/search/rebuild` | 8180-8203 |
| GET | `/api/search/stats` | 8204-8215 |
| POST | `/api/search/compact` | 8216-8240 |

### `routes/sessions-git.ts` - 10 routes

| Method | Path | Lines |
|---|---|---|
| GET | `/api/sessions/.../file-content` | 6203-6254 |
| GET | `/api/sessions/:id/git-status` | 6255-6302 |
| GET | `/api/sessions/:id/git-diff` | 6392-6410 |
| GET | `/api/sessions/:id/commits` | 6411-6482 |
| GET | `/api/sessions/:id/pr-status` | 6483-6514 |
| POST | `/api/sessions/:id/git-pull` | 6515-6533 |
| POST | `/api/sessions/:id/git-push` | 6534-6553 |
| POST | `/api/sessions/:id/git-squash-push` | 6554-6629 |
| POST | `/api/sessions/:id/git-merge-primary` | 6630-6674 |
| POST | `/api/sessions/:id/pr-merge` | 6675-6710 |

### `routes/maintenance.ts` - 9 routes

| Method | Path | Lines |
|---|---|---|
| GET | `/api/search` | 2488-2534 |
| GET | `/api/maintenance/orphaned-worktrees` | 8069-8086 |
| POST | `/api/maintenance/cleanup-worktrees` | 8087-8126 |
| GET | `/api/maintenance/orphaned-sessions` | 8127-8133 |
| POST | `/api/maintenance/cleanup-sessions` | 8134-8146 |
| GET | `/api/maintenance/expired-archives` | 8147-8153 |
| POST | `/api/maintenance/purge-archives` | 8154-8179 |
| GET | `/api/maintenance/orphaned-index-rows` | 8241-8287 |
| POST | `/api/maintenance/cleanup-index-rows` | 8288-8333 |

### `routes/roles.ts` - 9 routes

| Method | Path | Lines |
|---|---|---|
| GET | `/api/roles/assistant/prompts` | 4160-4172 |
| PUT | `/api/roles/assistant/prompts/` | 4173-4194 |
| GET | `/api/roles` | 4195-4202 |
| POST | `/api/roles` | 4203-4246 |
| POST | `/api/roles/:id/customize` | 4247-4275 |
| DELETE | `/api/roles/:id/override` | 4276-4301 |
| GET | `/api/roles/:id` | 4302-4316 |
| PUT | `/api/roles/:id` | 4317-4400 |
| DELETE | `/api/roles/:id` | 4401-4420 |

### `routes/sessions-content.ts` - 8 routes

| Method | Path | Lines |
|---|---|---|
| POST | `/api/sessions/:id/tool-grant-request` | 2703-2721 |
| POST | `/api/sessions/:id/wait` | 5558-5598 |
| POST | `/api/sessions/:id/continue` | 5599-5749 |
| GET | `/api/sessions/:id/output` | 5750-5762 |
| POST | `/api/sessions/:id/mark-read` | 5885-5911 |
| GET | `/api/sessions/:id/tool-content/(d+)/(d+)` | 6303-6334 |
| GET | `/api/sessions/:id/transcript` | 6335-6391 |
| POST | `/api/sessions/:id/abort` | 7397-7408 |

### `routes/sessions-bg.ts` - 8 routes

| Method | Path | Lines |
|---|---|---|
| POST | `/api/sessions/:id/bg-processes` | 7268-7287 |
| GET | `/api/sessions/:id/bg-processes` | 7288-7295 |
| GET | `/api/sessions/:id/bg-processes/:id/logs` | 7296-7310 |
| GET | `/api/sessions/:id/bg-processes/:id/grep` | 7311-7324 |
| GET | `/api/sessions/:id/bg-processes/:id/head` | 7325-7335 |
| GET | `/api/sessions/:id/bg-processes/:id/slice` | 7336-7347 |
| GET | `/api/sessions/:id/bg-processes/:id/wait` | 7348-7364 |
| DELETE | `/api/sessions/:id/bg-processes/:id` | 7365-7381 |

### `routes/tools.ts` - 7 routes

| Method | Path | Lines |
|---|---|---|
| GET | `/api/tools` | 3384-3405 |
| GET | `/api/tools/:id` | 3406-3412 |
| PUT | `/api/tools/:id` | 3413-3460 |
| POST | `/api/tools/:id/customize` | 3461-3524 |
| DELETE | `/api/tools/:id/override` | 3525-3560 |
| GET | `/api/tool-group-policies` | 3561-3568 |
| PUT | `/api/tool-group-policies/:rest` | 3569-3585 |

### `routes/tasks.ts` - 7 routes

| Method | Path | Lines |
|---|---|---|
| GET | `/api/goals/:id/tasks` | 4421-4442 |
| POST | `/api/goals/:id/tasks` | 4443-4478 |
| GET | `/api/tasks/:id` | 4914-4925 |
| PUT | `/api/tasks/:id` | 4926-4960 |
| DELETE | `/api/tasks/:id` | 4961-4974 |
| POST | `/api/tasks/:id/assign` | 4975-5010 |
| POST | `/api/tasks/:id/transition` | 5011-5045 |

### `routes/gates.ts` - 7 routes

| Method | Path | Lines |
|---|---|---|
| GET | `/api/goals/:id/gates` | 4479-4520 |
| GET | `/api/goals/:id/gates/:id` | 4521-4573 |
| GET | `/api/goals/:id/gates/:id/inspect` | 4574-4647 |
| POST | `/api/goals/:id/gates/:id/signal` | 4648-4834 |
| GET | `/api/goals/:id/gates/:id/signals` | 4835-4847 |
| GET | `/api/goals/:id/gates/:id/content` | 4881-4893 |
| GET | `/api/goals/:id/workflow-context/:id` | 4894-4913 |

### `routes/goals-git.ts` - 7 routes

| Method | Path | Lines |
|---|---|---|
| GET | `/api/goals/:id/commits` | 5112-5151 |
| GET | `/api/goals/:id/git-status` | 5152-5202 |
| GET | `/api/goals/:id/git-diff` | 5203-5238 |
| GET | `/api/pr-status-cache` | 5239-5245 |
| GET | `/api/goals/:id/pr-status` | 5246-5260 |
| POST | `/api/goals/:id/pr-cache-bust` | 5261-5274 |
| POST | `/api/goals/:id/pr-merge` | 5275-5304 |

### `routes/workflows.ts` - 7 routes

| Method | Path | Lines |
|---|---|---|
| GET | `/api/workflows` | 6739-6746 |
| POST | `/api/workflows` | 6747-6774 |
| POST | `/api/workflows/:id/customize` | 6775-6795 |
| DELETE | `/api/workflows/:id/override` | 6796-6810 |
| GET | `/api/workflows/:id` | 6811-6822 |
| PUT | `/api/workflows/:id` | 6823-6846 |
| DELETE | `/api/workflows/:id` | 6847-6861 |

### `routes/staff.ts` - 7 routes

| Method | Path | Lines |
|---|---|---|
| GET | `/api/staff` | 7574-7584 |
| POST | `/api/staff` | 7585-7623 |
| GET | `/api/staff/:id` | 7624-7631 |
| PUT | `/api/staff/:id` | 7632-7649 |
| DELETE | `/api/staff/:id` | 7650-7659 |
| POST | `/api/staff/:id/wake` | 7660-7675 |
| GET | `/api/staff/:id/sessions` | 7676-7681 |

### `routes/health.ts` - 6 routes

| Method | Path | Lines |
|---|---|---|
| GET | `/api/health` | 1574-1596 |
| POST | `/api/internal/test/replay-buffered-events/:id` | 1597-1621 |
| GET | `/api/setup-status` | 1622-1627 |
| POST | `/api/setup-status/dismiss` | 1628-1636 |
| POST | `/api/shutdown` | 1705-1712 |
| GET | `/api/connection-info` | 6129-6144 |

### `routes/sandbox.ts` - 6 routes

| Method | Path | Lines |
|---|---|---|
| GET | `/api/ca-cert` | 1713-1730 |
| GET | `/api/sandbox-pool` | 1731-1741 |
| GET | `/api/worktree-pool` | 1742-1757 |
| GET | `/api/sandbox-status` | 1758-1767 |
| POST | `/api/sandbox-image/build` | 1768-1787 |
| GET | `/api/sandbox/host-tokens` | 1788-1796 |

### `routes/cost.ts` - 5 routes

| Method | Path | Lines |
|---|---|---|
| GET | `/api/sessions/:id/cost/breakdown` | 6862-6903 |
| GET | `/api/sessions/:id/cost` | 6904-6922 |
| GET | `/api/goals/:id/cost/breakdown` | 6923-6971 |
| GET | `/api/goals/:id/cost` | 6972-6990 |
| GET | `/api/tasks/:id/cost` | 6991-7018 |

### `routes/sessions-review.ts` - 5 routes

| Method | Path | Lines |
|---|---|---|
| POST | `/api/sessions/.../review/annotations/bulk` | 7469-7499 |
| GET | `/api/sessions/.../review/annotations` | 7500-7509 |
| POST | `/api/sessions/.../review/annotations` | 7510-7524 |
| GET | `/api/sessions/.../review/submitted` | 7552-7560 |
| PUT | `/api/sessions/.../review/submitted` | 7561-7573 |

### `routes/verifications.ts` - 4 routes

| Method | Path | Lines |
|---|---|---|
| GET | `/api/goals/:id/verifications/active` | 4848-4856 |
| POST | `/api/goals/:id/gates/:id/cancel-verification` | 4857-4880 |
| POST | `/api/internal/verification-result` | 7909-7981 |
| POST | `/api/internal/user-question/submit` | 7982-8068 |

### `routes/oauth.ts` - 4 routes

| Method | Path | Lines |
|---|---|---|
| GET | `/api/oauth/status` | 6145-6154 |
| GET | `/api/oauth/flow-status` | 6155-6171 |
| POST | `/api/oauth/start` | 6172-6183 |
| POST | `/api/oauth/complete` | 6184-6202 |

### `routes/mcp.ts` - 4 routes

| Method | Path | Lines |
|---|---|---|
| GET | `/api/mcp-servers` | 7682-7707 |
| POST | `/api/mcp-servers/:id/restart` | 7708-7751 |
| POST | `/api/internal/mcp-call` | 7752-7839 |
| POST | `/api/internal/mcp-describe` | 7840-7908 |

### `routes/skills.ts` - 3 routes

| Method | Path | Lines |
|---|---|---|
| POST | `/api/sessions/:id/activate-skill` | 2640-2702 |
| GET | `/api/slash-skills` | 6711-6723 |
| GET | `/api/slash-skills/details` | 6724-6738 |

### `routes/preview.ts` - 3 routes

| Method | Path | Lines |
|---|---|---|
| POST | `/api/preview/mount` | 7019-7153 |
| GET | `/api/preview/mount` | 7154-7198 |
| GET | `/api/sessions/:id/preview-events` | 7199-7267 |

### `routes/image-generation.ts` - 1 routes

| Method | Path | Lines |
|---|---|---|
| POST | `/api/image-generation/generate` | 3791-3859 |
