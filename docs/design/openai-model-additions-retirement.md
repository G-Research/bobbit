# OpenAI model-additions retirement

**Status:** Implemented. This decision supersedes the earlier investigation's staged-migration recommendation.

## Decision

Bobbit retired its OpenAI additions module and the boot-time metadata writers. Historical compatibility migration and tombstone cleanup were intentionally declined.

Bobbit does not inspect, rebase, mark, remove, or otherwise normalize surviving historical rows. It also does not restore direct OpenAI rows removed by Pi. Existing custom rows, duplicates, provider configuration, `modelOverrides`, JSONC comments, and unknown fields are user-owned.

This is a deliberate change from the earlier recommendation to retain fingerprints, inventory old rows, and run a staged migration. Content similarity cannot prove that Bobbit owns a row, so an automatic migration would risk changing user configuration. The authoritative-source policy and final spawn guard provide safety without taking ownership of historical data.

## Metadata authority

Each model realm has one capability source:

| Realm | Authority | Bobbit's role |
|---|---|---|
| Well-known AI Gateway model | The resolved gateway well-known document | Validate required fields and translate documented protocol details: adapter to Pi API, validated base URL, bare wire ID, Bobbit headers, and advertised variants. |
| Direct built-in model | The exact Pi catalog row | Add only Bobbit presentation and authentication state. Do not inflate or overlay capabilities, costs, thinking maps, or compatibility. |
| User/custom model | The exact configuration composed for that target realm | Expose the composed row without family inference. Preserve the last exact row for an unchanged source during a transient discovery failure. |
| Legacy AI Gateway model | `/v1/models` plus `inferLegacyAigwMeta` | Retain model-name inference only for gateways that do not provide an authoritative well-known document. |

Protocol translation is not capability authorship. A well-known row must advertise valid context and output limits, reasoning, supported input modalities, and a documented adapter before Bobbit publishes it. Missing capability or pricing fields are not filled from a model family: incomplete rows are omitted, absent prices are represented conservatively as zero, and only advertised thinking variants are emitted.

## User-owned `models.json`

Ordinary startup no longer writes blanket Claude overrides or historical OpenAI additions. When AIGW publication is not independently configured, `models.json` remains byte-identical, including malformed or duplicate-rich files.

Configured AIGW publication has one narrow, forward-only ownership marker:

```json
"x-bobbit-managed": { "kind": "aigw-publication", "version": 1 }
```

The publication contract is:

- If `providers.aigw` is absent, Bobbit may insert a generated provider carrying the marker.
- If exactly one valid marked block exists, Bobbit may update only its managed routing, header, model, and marker fields. JSONC comments and unknown fields remain intact.
- An unmarked `providers.aigw` block is user-owned. Bobbit does not mark, refresh, or remove it. Pi's exact target-realm composition remains the selection authority.
- Malformed JSONC or duplicate `providers`, `providers.aigw`, or managed fields is ambiguous. Publication fails closed without changing any byte or committing the new preference.
- Disconnect removes only a marked Bobbit publication. Historical unmarked output remains user-owned even if it resembles generated content.

Writes use localized JSONC edits and atomic replacement. This keeps provenance with the only block Bobbit owns while avoiding a migration sidecar or a second metadata state owner.

## Live state and thinking

Live and rehydrated model state resolves from the last exact assembled registry row, then an exact direct Pi row. Unknown tuples remain unavailable rather than receiving default context, modality, reasoning, or thinking metadata.

The last exact AIGW/custom row is retained for an unchanged source when discovery temporarily fails. This keeps selection, reconnect, restore, and thinking clamping stable during an outage. A successful refresh is authoritative, including an empty or filtered result, so stale rows are not merged back after a model is intentionally removed.

If exact composed metadata is temporarily unavailable, state frames may preserve capability fields only from an identity-matching live Pi state. Missing fields stay missing. Thinking clamping likewise requires exact registry or target-realm metadata; model IDs and provider names never grant reasoning tiers.

## Final spawn boundary

Early selection validation is insufficient because raw Pi arguments are last-wins. Bobbit therefore resolves the fully assembled effective provider, model, and thinking tuple immediately before every real Pi bridge is constructed.

The finalizer:

1. parses repeated raw `--provider`, `--model`, and `--thinking` arguments using Pi's effective precedence;
2. keeps the original requested model and thinking level separate from the effective values;
3. validates the effective provider/model against the exact session-selectable catalog in the host or sandbox target realm;
4. clamps thinking against that exact row;
5. removes raw selection flags and emits one canonical spawn tuple.

Malformed, unavailable, fabricated, or cross-provider effective tuples fail before process/container execution or durable effective-state mutation. The same boundary covers normal creation, delegates, fork/continue, cold restore, role replacement, force-abort replacement, review/QA, and sandbox execution. Controlled fallback remains explicit and records an effective identity distinct from the request; it never restores a deprecated catalog row.

## Stable invariants

- Bobbit does not maintain a parallel capability catalog.
- Direct Pi and composed user/custom metadata pass through exactly.
- Well-known translation never calls legacy model-family inference.
- Legacy inference is confined to the `/v1/models` compatibility boundary.
- Historical rows and unmarked provider blocks are never claimed from content alone.
- No removed Pi row is reintroduced by Bobbit production code.
- Requested identity remains available for diagnosis even when an explicit fallback produces a different effective identity.
- Host, sandbox, and recovery paths validate the same canonical tuple before spawn.

See [AI Gateway routing](../ai-gateway-routing.md), [Per-model thinking-level capabilities](../thinking-levels.md), and [Spawn-time model pinning](../internals.md#spawn-time-model-pinning) for operational details.
