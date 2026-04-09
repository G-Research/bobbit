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
| Search | [search.md](search.md) | 5 | None | Completely untested |
| Config Cascade | [config-cascade.md](config-cascade.md) | 7 | API only | UI cascade effects untested |
| Sandbox | [sandbox.md](sandbox.md) | 8 | Skipped | Docker-dependent, all skipped |
| Resilience | [resilience.md](resilience.md) | 6 | Manual only | No automated crash tests |

## How to Use

When implementing a new E2E test, reference the story ID in the test description:

```typescript
test('S-03: draft isolation across sessions', async ({ page }) => { ... });
```

When a bug is found, check if it maps to an existing story. If not, add a new story first, then write the test.
