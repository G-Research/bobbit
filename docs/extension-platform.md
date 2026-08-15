# Extension Platform

The Extension Platform makes optional agent capability an installed, inspectable, and revocable project choice. A schema-2 Marketplace pack can contribute lifecycle providers, bounded decision hooks, skills/MCP, static prompt sections, or a declarative service contract; a schema-3 pack can also declare a core-owned sandbox toolchain requirement. Bobbit keeps the authority to activate, configure, grant, apply, audit, and remove those contributions.

This is the operator entry point. Pack authors should start with the [Extension Host authoring guide](extension-host-authoring.md).

## Operator lifecycle

1. **Add a trusted source and install the pack.** Open **Market**, add a git/local source or MCP Gateway, inspect the pack's provenance and declared contributions, then install it to the intended scope. Source trust is important: a pack can include host-executed code or instructions. See [Marketplace](marketplace.md).
2. **Inspect its project state.** In **Market → Installed**, select the target project. Review the pack's activation rows, per-project runtime/settings controls, required configuration, exact grant status, and any invalid-schema or unavailable state. Secrets are write-only and display only whether a value is stored. See [Project extension settings](extension-settings.md#market-behavior).
3. **Activate deliberately.** Enable the pack/contribution in the installed activation catalogue, then enable its project runtime target and supply required settings. These are separate gates: a setting cannot revive an uninstalled or activation-disabled contribution.
4. **Grant only the exact capability required.** In Market's existing **Review grants** control, review and confirm either a named `(pack, hook, capability)` tuple or the Pack row's `(pack, pack principal, capability)` tuple. The pack-only values are `service.manage`, `memory.read`, `memory.write`, `memory.reflect`, `memory.invalidate`, `memory.read.all`, and `sandbox:build`; hook capabilities remain separately declared and exact. Activation is never a grant. A grant does not add a raw Host API or let a pack write project configuration. `sandbox:build` permits only approved declarative requirements to affect the core image, not Docker control. See [Extension capability grants](extension-capability-grants.md) and [Extension sandbox requirements](extension-sandbox-requirements.md).
5. **Observe the effect.** Use **Session actions → View context trace** for safe lifecycle, advice, selection, decision, mutation, and filter activity. Review an extension's effective static prompt sections and byte attribution in the system-prompt inspector. Decision cards use the existing choice/Other widget; advisories go to the inbox without interrupting work. The operator-only result-filter audit records metadata, never result bytes.
6. **Handle decisions and proposals.** A deferrable question has a validated safe default; a consent-required question never does and denies or pauses safely on silence. Answers are validated before extension code sees them. Any configuration-changing outcome is an ordinary proposal for human approval, never a direct extension apply path. See [Extension decision requests](extension-decision-requests.md).
7. **Change or revoke safely.** Update settings with their displayed revision, disable one contribution, or revoke one exact grant. Live application paths revalidate after worker completion, so a late result cannot use revoked authority. Existing audit/trace rows remain historical evidence.
8. **Uninstall and verify inert state.** Uninstall from the same Market card, reload, and run another normal session turn. The pack's runtime contribution must not return; historical trace/audit evidence remains readable. Removing a source is separate from uninstalling its packs.

## What activation, settings, and grants mean

| Control | What it does | What it never does |
|---|---|---|
| Install/activation | Makes a declared contribution eligible for resolution. | Grants a hook authority or approves a change. |
| Project settings | Supplies typed, project-local configuration and project/target enablement. | Installs a pack, reveals a secret, or bypasses activation/grants. |
| Exact grant | Lets core use one active hook for one declared capability, or one active pack principal for one closed platform-owned non-hook capability. | Adds a Host API method, permits arbitrary code, or authorizes another principal. |
| Proposal approval | Applies a reviewed project-state change through the existing proposal system. | Treats an extension answer as a direct mutation. |

A disabled, shadowed, removed, unconfigured, or ungranted contribution is inert. Market keeps it visible where possible so it can be repaired or explicitly re-enabled; it does not silently disappear from the control surface.

## Built platform slices

The integration design is the authoritative delivery record: [Extension Platform parent design](design/extension-platform-parent.md). These links describe the implemented operator or author contract for each slice.

| Slice | Delivered capability | Read next |
|---|---|---|
| EP-1 | Schema-2 hook declarations, validation, activation filtering, lifecycle events, and budgets. | [Hook metadata](extension-host-authoring.md#hook-metadata-hooksnameyaml--schema-2-metadata-first) |
| EP-2b | Project-safe lifecycle scope context for hooks. | [Hook scope context](design/hook-scope-context.md) |
| EP-2 | Typed advisory selection of model, thinking, role, and workflow values; core owns availability/reduction, and currently applies only eligible thinking advice. | [Advisory selections](extension-decision-requests.md#advisory-selection-proposals) |
| EP-3 | Fire-and-forget every-N-turn advisors; no clock-based helper scheduling. | [Every-N-turn schedules](extension-host-authoring.md#every-n-turn-schedules) |
| EP-4 | Exact-granted, core-applied transient request shaping and pre-execution tool safety. | [Gated request mutation](request-mutation.md) |
| EP-5 | Read-only Context trace and extension activity visibility. | [Lifecycle Hub and Context trace](lifecycle-hub.md#context-trace-inspector) |
| EP-6 | Per-project exact hook/pack capability grants, live revoke behavior, and backward-readable grant audit. | [Extension capability grants](extension-capability-grants.md) |
| EP-7 | Market project settings, typed fields, write-only secrets, project enablement, and grant controls. | [Project extension settings](extension-settings.md) |
| EP-8 | Scheduled staff proposal fixture plus the generic managed-service lifecycle contract. | [Staff proposals](design/ep-8-staff-proposals.md) and [managed service extensions](service-extension-runtime.md) |
| EP-9 | Adoption of stock MCP servers and Claude-style skill directories without repackaging them. | [Adopt stock extensions](marketplace.md#adopt-stock-extensions-without-a-pack) |
| EP-10 | Session-start selection of existing optional skills first, then MCP. The selected surface is pinned for restore/respawn. | [Dynamic capability selection](design/dynamic-capability-selection.md) |
| EP-11 | Durable extension advisories and typed deferrable/consent-required decision requests, including project-owned `projectImported` delivery during new-project registration. | [Extension decision requests](extension-decision-requests.md) |
| EP-12 | The first built-in feature migration: the optional thinking fallback is the default-disabled, exact-granted `thinking-selector` pack; core keeps explicit choices and model safety ceilings. | [Thinking selector extraction](design/ep-12-thinking-selector-extraction.md) |
| EP-13 | Named static system-prompt contributions with deterministic order, cache boundary, budgets, proposal-only authoring, and inspection. | [Static system-prompt sections](extension-host-authoring.md#static-system-prompt-sections-system-promptsnameyaml--schema-2) |
| EP-14 | Exact-granted post-tool-result filtering at the canonical pre-fan-out boundary. | [Tool-result filter seam](design/ep-14-tool-result-filter.md) |
| Sandbox requirements | Schema-3 approved toolchain declarations resolved by the core sandbox builder. | [Extension sandbox requirements](extension-sandbox-requirements.md) |

`EP-11` and `EP-13` are the additional decision-request and static-prompt slices. `EP-12` is the required migration proof, not an optional follow-up.

## Important boundaries

- **Advice before mutation.** Extensions can advise, but core validates and applies only a narrow, separately granted contract. Human pins and existing role/tool policy still win.
- **Static versus per-turn prompt changes.** A static extension section is deterministic and starts after the cache-stable core prefix. EP-4 request shaping is a separately granted, transient per-turn replacement; it cannot change the system prompt.
- **Services are declarative today.** The managed-service declaration/registry/lifecycle contract is implemented, including the fresh-read `service.manage` authorization seam, but no gateway consumer starts these services yet. A runtime entry currently starts nothing. See [Managed service-extension contract](service-extension-runtime.md).
- **Tool-result filtering protects disclosure, not execution.** EP-14 runs after a tool side effect and before its result is persisted or shown. It does not authorize a tool call or undo its side effects.
- **Credential policy is deferred.** EP-14 provides the transport, authority, and containment seam only. A real credential-detection product—detectors, taxonomy, false-positive policy, configuration, and remediation—is a later top-level goal.
- **Pack code remains trusted.** Worker confinement is resource/crash isolation, not an operating-system security sandbox for a source you chose to install. See [Marketplace trust](marketplace.md#installing-to-a-scope).

## Verification entry points

Use the normal tiers first:

```bash
npm run check
npm run test:unit
npm run test:browser
```

The integrated browser journey is [`tests2/browser/e2e/extension-platform-lifecycle.spec.ts`](../tests2/browser/e2e/extension-platform-lifecycle.spec.ts). It uses Market to add a source, install a pack, inspect its hook, confirm the exact `decide` grant, trigger and inspect Context activity, uninstall, reload, and prove the removed advisor remains inert.

Focused journeys cover decision cards and consent pause/recovery, prompt-section inspection, staff proposals, and the tool-result filter. The EP-14 design records its focused core/integration/Pi/browser canaries; use it when changing the filter boundary.
