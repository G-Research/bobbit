# User Stories

Testable user stories for every feature in Bobbit. Each story documents the expected user experience as a sequence of actions and assertions. These stories serve two purposes:

1. **Specification** — define what "correct" looks like for each feature
2. **Test coverage tracking** — map each story to automated tests

## Structure

Each file covers a feature area. Stories are numbered within each file (e.g. `S-01`, `G-01`). Each story has:

- **Preconditions** — what must be true before the story starts
- **Steps** — user actions (click, type, navigate)
- **Expected** — observable outcomes (UI state, server state, persistence)
- **Coverage** — which automated tests exercise this story (empty = untested)

## Coverage Status

| Area | File | Stories | Covered | Gap |
|------|------|---------|---------|-----|
| Sessions | [sessions.md](sessions.md) | 14 | Partial | Crash recovery, rapid switching |
| Goals | [goals.md](goals.md) | 12 | Partial | Full lifecycle, sandbox goals |
| Team | [team.md](team.md) | 8 | Minimal | Most interactions untested |
| Dashboard | [dashboard.md](dashboard.md) | 10 | Minimal | Gate interaction, verification |
| Roles | [roles.md](roles.md) | 8 | API only | No UI CRUD tests |
| Personalities | [personalities.md](personalities.md) | 6 | API only | No UI CRUD tests |
| Tools | [tools.md](tools.md) | 7 | API only | No UI edit/policy tests |
| Workflows | [workflows.md](workflows.md) | 8 | Partial | Editor phases only |
| Staff | [staff.md](staff.md) | 6 | None | Completely untested |
| Projects | [projects.md](projects.md) | 10 | Good | Assistant flow well-tested |
| Settings | [settings.md](settings.md) | 9 | Partial | Per-project config gaps |
| Navigation | [navigation.md](navigation.md) | 8 | Partial | Cross-feature journeys missing |
| Search | [search.md](search.md) | 11 | None | Filter mode, full search, keyboard, archived, rebuild |
| Config Cascade | [config-cascade.md](config-cascade.md) | 7 | API only | UI cascade effects untested |
| Sandbox | [sandbox.md](sandbox.md) | 8 | Skipped | Docker-dependent, all skipped |
| Prompt Interactions | [prompt-interactions.md](prompt-interactions.md) | 34 | Minimal | Race conditions, steer/abort lifecycle |
| Review Pane | [review-pane.md](review-pane.md) | 21 | None | Completely untested |
| Resilience | [resilience.md](resilience.md) | 6 | Manual only | No automated crash tests |

## Cross-Feature Contracts

[contracts.md](contracts.md) documents 17 cross-feature contracts — guarantees that one feature provides to others. When a change touches a contract boundary, consult the contract to understand what must hold.

## Feature Interaction Matrix

[feature-matrix.md](feature-matrix.md) is a lookup table for agents building new features. Find the section matching your feature type, check the listed contracts, and verify against the checklist.

## Specification Convention

Stories describe **user-visible behavior**, not implementation. Assertions say "the session row is highlighted" not "the `sidebar-session-active` class is applied." CSS classes, API endpoints, and component names belong in tests, not stories. See [docs/ux-review-plan.md](../docs/ux-review-plan.md) for the full convention.

## How to Use

**Implementing a test:** Reference the story ID in the test description:

```typescript
test('S-03: draft isolation across sessions', async ({ page }) => { ... });
```

**Building a new feature:** Consult the [feature matrix](feature-matrix.md) for your feature type. Honor the listed contracts. Verify against the checklist.

**Fixing a bug:** Find the relevant story. If it doesn't cover this variation, add a sub-story first. Write the test, confirm it fails, fix, confirm it passes.

**Changing a contract boundary:** If your change affects a guarantee in [contracts.md](contracts.md), review all consuming stories and update them if needed.
