# Bobbit Specification System

## Purpose

User stories are executable TypeScript E2E tests written with a fluent API designed for human readability. No intermediate YAML or prose format. Stories ARE the tests.

The framework provides:

- **Phase-annotated tracking** — only regions/intents/entities touched during `act` and `assert` phases contribute to the spec graph. Setup and cleanup are incidental and excluded.
- **Typed entity handles** — `s.session("A").in_state("active")`, `s.goal("A").in_state("complete")`, `s.gate("design").in_state("passed")`, `s.staff("bot").in_state("paused")`
- **Spec graph** — contract coverage, related stories, region impact analysis. Built by running the E2E suite (<90s). Consumed by `spec_check` CLI and agent context injection.
- **Recursive self-improvement** — every bug found adds a story, every feature adds entity handles and intents.

## How a story looks

```typescript
test("CT-02-a: Draft survives rapid session switching", async () => {
    s.begin(defineStory({
        id: "CT-02-a",
        title: "Draft survives rapid session switching",
        contracts: ["CT-02"],
    }));

    // setup — incidental, not tracked in spec graph
    await s.navigate_to("session", "A");
    await s.session("A").in_state("active");

    // act — the behavior under test, tracked
    s.act();
    await s.type_in(s.editor, "my work in progress");
    await s.wait_for_draft_saved("A", "my work in progress");
    await s.navigate_to("session", "B");
    await s.navigate_to("session", "A");

    // assert — expected outcomes, tracked
    s.assert();
    await s.editor.contains_text("my work in progress");
    await s.editor.is_focused();
});
```

## Phase annotations

Each story has four phases. Only `act` and `assert` contribute to the spec graph:

| Phase | Purpose | Tracked? |
|---|---|---|
| `setup` | Navigate to starting state, create entities | No |
| `act` | The user actions being tested | Yes |
| `assert` | The expected outcomes | Yes |
| `cleanup` | Delete test entities | No |

This prevents the "everything touches editor and sidebar" noise problem. A search story that navigates to a session as setup doesn't pollute the relatedness graph with sidebar entries.

## The spec graph

Built by running the full E2E suite. Each `defineStory()` + phase-tracked actions populate the registry. After all tests complete, `exportSpecGraph()` produces:

```json
{
  "stories": { "CT-02-a": { "contracts": ["CT-02"], "regions": ["editor"], "intents": ["type_in", "navigate_to_session"], ... } },
  "contracts": { "CT-02": { "stories": ["CT-02-a", "CT-02-b", "CT-02-c", "CT-02-d"] } },
  "regionIndex": { "editor": ["CT-02-a", "CT-02-c", ...], "sidebar": [...] },
  "intentIndex": { "type_in": ["CT-02-a", "CT-02-c", ...] },
  "entityIndex": { "session": ["CT-02-a", "CT-02-d", ...] }
}
```

### Queries

| Query | Function | Use case |
|---|---|---|
| "What stories relate to mine?" | `findRelatedStories(id)` | Agent context: "you're changing CT-02-a, also check these" |
| "I'm changing the editor — what stories test it?" | `storiesForRegion("editor")` | Impact analysis before implementation |
| "Is CT-02 well covered?" | `contractCoverage("CT-02")` | Coverage gap detection |
| "Full graph for agent context" | `exportSpecGraph()` | Scoped injection into agent prompts |

### No contradiction detection

Contradictory stories can't both pass — the assertions would conflict at runtime. The test suite IS the contradiction detector. No separate structural check needed.

## Entity handles

Typed handles for each domain entity, with state assertions that match the entity's actual states:

```typescript
// Session — states: active, inactive, idle, streaming
s.session("A").in_state("active")
s.session("A").is_highlighted()

// Goal — states: active, archived, complete
s.goal("A").in_state("active")

// Gate — states: pending, passed, failed, verifying
s.gate("design").in_state("passed")
s.gate("design").has_badge("passed")

// Staff — states: active, paused, sleeping, awake
s.staff("deploy-bot").in_state("paused")
s.staff("deploy-bot").has_badge("paused")
```

Adding a new entity = add a `FooHandle` class with typed states. The TypeScript compiler enforces valid state values.

## Regions

Typed hierarchy of UI areas. Sub-regions are properties:

```typescript
s.editor                    // message composition area
s.editor.text_input         // the textarea
s.editor.attachment_area    // attachment tiles
s.editor.queue              // queued message pills
s.editor.autocomplete       // slash skill dropdown

s.sidebar                   // left navigation panel
s.context_bar               // model/personality selectors
s.context_bar.model_selector
s.stats_bar                 // cost, context usage, git status
s.message_list              // chat message thread
s.dashboard                 // goal dashboard
s.settings                  // settings page
s.review_pane               // document annotation panel
s.search_page               // full search results
s.modal                     // overlay dialogs
```

## Intents

User actions expressed as intents, not widget clicks:

```typescript
s.send_message("hello")
s.stop_streaming()
s.attach_file("report.pdf", "file")
s.navigate_to("session", "A")
s.navigate_to("settings")
s.type_in(s.editor, "draft text")
s.change_setting("model", "claude-opus")
s.reload()
s.press_key("Ctrl+K")
s.pause_staff("deploy-bot")
s.wake_staff("deploy-bot")
```

## System events

For resilience and lifecycle testing:

```typescript
s.event.server_crash()    // kill server process
s.event.server_restart()  // restart server
s.event.disconnect()      // force WebSocket close
s.event.agent_finish("B") // wait for agent idle on session B
```

Note: `server_crash` and `server_restart` require the manual-integration harness, not standard E2E.

## spec_check integration

`spec_check` is a CLI that:

1. Runs the full E2E suite (populates the registry)
2. Calls `exportSpecGraph()` to get the JSON graph
3. Validates: every contract has stories, no orphaned story IDs, coverage gaps flagged
4. Outputs the graph for agent context injection

Runs as a gate verification step:

```yaml
verify:
  - name: spec-integrity
    type: command
    run: "npx spec_check"
    phase: 2
```

## Workflow integration

### spec-first workflow (features and epics)

```
Human describes behavior →
  AI drafts story tests using the framework →
  spec_check validates: grammar, registry completeness →
Human reviews stories →
  Tests must fail (TDD) →
  N agents implement in parallel →
  Gates verify: npm test + spec_check →
  Merge
```

### Bug-fix workflow

```
Human describes bug →
  Agent queries spec graph: "which stories cover this region?" →
  If story exists: write failing test variation → fix → verify
  If no story: write new story test → fix → verify →
  spec_check validates coverage →
  Merge
```

### All workflows

`spec_check` runs in `ready-to-merge` gate verification on every workflow — general, feature, bug-fix, quick-fix. No code merges without passing spec integrity.

## Build cost

| Component | Effort |
|---|---|
| Framework (spec-framework.ts) — done | Prototype exists |
| Entity handles (Goal, Gate, Staff, Task) — done | In prototype |
| System events (crash, restart, disconnect) | 1 day |
| spec_check CLI | 2-3 days |
| Story migration (convert 240 prose stories) | 1-2 weeks |
| Workflow integration | 1-2 days |
| **Total** | **~3-4 weeks** |

## Run cost

The full E2E suite runs in <90s. The spec graph is a build artifact — computed once, consumed many times:

| Operation | Cost |
|---|---|
| Build spec graph | ~90s (E2E suite run) |
| Query related stories | 0 tokens, <1ms |
| Query contract coverage | 0 tokens, <1ms |
| Query region impact | 0 tokens, <1ms |
| Agent context injection | Scoped graph subset, not all 240 stories |
