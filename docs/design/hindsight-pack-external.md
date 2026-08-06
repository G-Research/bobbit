# Hindsight pack — external service

**Status:** implemented external-service reference. This document describes the shipped Hindsight
provider and its migration boundary. Project configuration is owned by the generic
[project extension settings](../extension-settings.md) contract; it is not a Hindsight-specific
PackStore API.

> **Supersedes historical G2 planning.** Earlier revisions of this document described a `mode`
> setting, PackStore configuration overlays, and mutable pack routes. Those implementation
> instructions are superseded. The retained client, lifecycle, queue, and tag notes below explain
> current behavior only. Managed Hindsight runtime, explicit agent tools, and a native panel remain
> outside this pack's external-service configuration contract.

## Configuration and activation

Hindsight is a schema-2 provider with id `memory`. Its declaration in
`market-packs/hindsight/providers/memory.yaml` is the source of truth for the editable fields:

| Key | Type | Default / requirement |
|---|---|---|
| `externalUrl` | string | Optional, but required by `activation.requiresConfig` for runtime activation. It is the base URL of the external Hindsight service. |
| `apiKey` | secret | Optional bearer token. It is write-only and is represented publicly only by `secretSet`. |
| `bank` | string | `bobbit` |
| `namespace` | string | `default` |
| `recallScope` | enum | `project` or `all`; default `all` |
| `autoRecall` | boolean | `true` |
| `autoRetain` | boolean | `true` |
| `recallBudget` | number | `1200`, minimum `1` |
| `timeoutMs` | number | `1500`, minimum `1` |

There is **no editable `mode` field**. This pack is external-service-only. A compatibility-only
internal default may recognize an old legacy record, but it is not a declaration, Market control,
or supported settings API value.

The provider is dormant until the selected project's effective `externalUrl` is non-blank. The
resolver applies normal installed-pack activation first, then the project pack and provider
switches, then `requiresConfig`. A disabled project target or unreadable project settings fail
closed. An unconfigured provider is omitted before bridge injection and hook dispatch, so it does
not construct a client or make a network request.

### Configure a project

Read the redacted project catalogue, then use its revision in a compare-and-swap mutation. The
server resolves the pack, contribution kind, and provider id; clients must not write project YAML,
write the PackStore configuration key, or construct their own target record.

```http
GET /api/projects/:projectId/extension-settings

PATCH /api/projects/:projectId/extension-settings/hindsight/provider/memory
Content-Type: application/json

{
  "expectedRevision": 12,
  "values": {
    "externalUrl": "https://hindsight.example",
    "apiKey": "replacement-only-secret",
    "recallScope": "project"
  }
}
```

A secret is accepted only as a replacement string or `null` to clear it. The response is redacted;
it reports `secretSet` rather than the secret bytes. Omit a field to leave it unchanged and use
`null` for a supported clear. A stale revision returns
`409 EXTENSION_SETTINGS_REVISION_CONFLICT`; reload the projection and review before retrying,
rather than overwriting.

Project runtime enablement is a separate CAS operation:

```http
PATCH /api/projects/:projectId/extension-settings/hindsight
Content-Type: application/json

{ "expectedRevision": 12, "enabled": false }
```

The target mutation may also set `enabled` for only `memory`. Both PATCH routes require the
verified prompt-operator proof. See [project extension settings](../extension-settings.md#http-api)
for the complete request, error, secret, and authorization contract.

## Runtime configuration boundary

The lifecycle provider receives its resolved, flat configuration through `ctx.config`. It reads
`externalUrl`, `apiKey`, and the declared fields from that object, and uses `ctx.host.store` only
for operational state such as the retain queue and diagnostics. It must not read or write
configuration through the pack store.

The effective non-secret order is declaration defaults, then a legacy provider PackStore override
**only while this project has no Hindsight provider target row**, then that project's target
values. Runtime-only secret resolution is project-local. Once a row exists, including an empty row
created by clearing a setting, the legacy fallback is not consulted. This prevents clearing a
project setting from reviving an old shared configuration.

## Legacy route migration

The pack `config` route is retained only as a read-only migration diagnostic:

- `GET` says whether the old fallback can be read and whether it appears configured; it never
  returns legacy values or secrets, and it is not a view of the current project's settings.
- Every non-GET request returns `HINDSIGHT_PROJECT_SETTINGS_REQUIRED` with project-settings
  guidance. It cannot persist settings.
- `status` likewise reports only legacy fallback and queue diagnostics. Current provider
  configuration is delivered to the runtime through `ctx.config`.

Manual `recall`, `retain`, `reflect`, and `banks` routes deliberately do not use a legacy or
project credential. Each returns `HINDSIGHT_PROJECT_SETTINGS_REQUIRED` (with its route's empty or
failed result shape). This avoids a second configuration runtime and prevents a global legacy
credential from bypassing project isolation.

## Provider behavior retained from the external implementation

The worker-tier provider constructs a REST client per hook from `ctx.config`. With a configured
external URL:

- `sessionSetup` and `beforePrompt` recall memories when `autoRecall` is enabled and return
  memory-authority context blocks.
- `afterTurn` retains a capped turn summary when `autoRetain` is enabled, asynchronously, and
  first retries one queued retain.
- `beforeCompact` retains the about-to-be-lost summary synchronously.
- `sessionShutdown` makes one best-effort queue-drain pass.

The client uses the configured namespace (default `default`) and bank (default `bobbit`), encodes
path segments, applies its request timeout (default 1500 ms), and sends an `Authorization: Bearer`
header only when an API key is set. Remote failures are non-fatal to the agent turn. The durable,
pack-scoped retry queue preserves unknown state rather than replacing it with an empty queue; its
capacity is 100 entries.

Retained memories are tagged from runtime context: `project`, `goal`, `agent`, `session`, and a
`kind` of `turn` or `compaction`. `recallScope: project` adds the current project tag to automatic
recall; `all` does not. This remote-memory query scope is independent of Bobbit's project settings
ownership.

## Project isolation proof

Hindsight configuration and enablement are project-local. A valid acceptance path is:

1. Configure Project A's `externalUrl` and optional `apiKey` through its extension-settings CAS
   route; verify the redacted projection and a reload.
2. Open Project B and verify A's URL and secret presence do not appear. Configure B independently.
3. Disable the Hindsight pack or only its `memory` provider in B through B's revisioned route.
4. Return to A and verify it remains configured and active. Return to B and verify it is disabled
   while its own settings are retained.

Once Projects A and B have their own target rows, no target value, secret, or enablement override
crosses their boundary, and neither project consults the legacy fallback. Before a target row
exists, the legacy read is migration compatibility only and is never written by this contract. The
same proof must ensure the API key never appears in a response, DOM, attribute, log, trace, or
client storage.

## Historical implementation notes

The former G2 implementation checklist, mutable `config` route contract, PackStore-over-YAML
configuration overlay instructions, and `mode: [external, managed]` example are superseded by the
project extension-settings contract above. Historical client and lifecycle detail is retained only
where it still describes shipped external-service behavior. For the durable public settings API,
Market redaction rules, and schema evolution, use [project extension settings](../extension-settings.md).
