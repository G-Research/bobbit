# Message author identity

Bobbit tracks **who caused a message** independently of the Pi role used to carry it. This matters because a Pi `user` row can come from a human, another agent, Bobbit orchestration, or an extension.

The feature has two deliberately separate views:

- **Bobbit-visible view:** trusted author metadata and, only when the loaded transcript is ambiguous, a prompt-bubble label. Message text remains the user's original text.
- **Model view:** trusted system and agent prompts receive a short dispatch-time text prefix. Human prompts remain byte-for-byte unprefixed.

The private author sidecar connects those views without adding author fields to Pi JSONL or storing prompt plaintext.

## Public author model

The shared contract lives in `src/shared/message-author.ts`:

```ts
export type MessageAuthorKind = "user" | "agent" | "system";

export interface MessageAuthor {
  kind: MessageAuthorKind;
  id: string;
  label: string;
}

export type BobbitMessage<T extends object = Record<string, unknown>> =
  T & { author?: MessageAuthor };
```

`author` remains optional across storage, wire, transcript, and client boundaries so legacy sessions remain readable. The three kinds are intentionally small:

- `user` — human input. The current local identity is `user:local`, labelled `User`.
- `agent` — an LLM-backed Bobbit session, including staff, team, delegate, reviewer, and other agent sessions.
- `system` — Bobbit orchestration, notifications, dynamic context, mixed-author batches, and extension session writes.

Tools and extensions are producers, not additional author kinds. Tool results inherit the closest accountable author; extensions act as server-derived system identities.

Author and role answer different questions. `role` continues to control Pi/provider semantics and rendering shape. `author` is Bobbit-owned accountability metadata. Never infer human authorship from `role: "user"`.

### Validation and display formatting

`isMessageAuthor()` accepts only a known kind and bounded, non-empty string `id` and `label`. Pi transcript fields and browser payloads are not trusted merely because they have that shape.

Display formatting is centralized:

- `normalizeMessageAuthorLabel()` removes control characters, trims, and collapses whitespace onto one line. It does not modify the stored `MessageAuthor`.
- `formatDisplayAuthorId()` removes a leading `user:`, `staff:`, or `session:` namespace. A human remainder is preserved; an agent remainder is normalized with the canonical author-ID sanitizer and shortened to six characters. Systems have no display ID.
- An unusable label or ID returns no agent prefix or presentation instead of fabricating attribution.

The user-ID branch is a future compatibility seam. Bobbit does not currently collect a stable human principal, so no human prefix is emitted in this release.

## Trusted identity construction

The gateway derives authors from authenticated server context. Browser `prompt` and `steer` frames cannot submit arbitrary author metadata.

`PromptSource` remains the internal producer provenance:

| Source | Accountable kind | Typical producer |
|---|---|---|
| `user` | `user` | Browser prompt, steer, or ask response |
| `agent` | `agent` | Authenticated caller-session relay |
| `auto-nudge`, `task-notification`, `verification`, `system`, `child-complete` | `system` | Bobbit orchestration |
| `extension` | `system` | Authenticated extension surface |

An agent source without a valid trusted caller falls back to Bobbit's system identity; it is never relabelled as a human or invented agent.

Stable IDs are constructed in the server message-author module:

- staff-backed session: `staff:<staff-id>`;
- other agent session: `session:<session-id>`;
- Bobbit core: `system:bobbit`;
- dynamic context: `system:bobbit:dynamic-context`;
- mixed-author steer batch: `system:bobbit:batch`;
- extension write: `system:extension:<pack-id>:<surface>`.

Agent labels prefer staff name, session title, role label/name, then `Agent`. IDs remain stable when a title changes. Extension identities come from the server-minted surface token, not pack or tool names asserted by the client.

## Conditional prompt labels

The browser computes one display mode over the currently loaded transcript slices. It includes the main history and any hydrated pre-compaction slices, so nested history and the main list cannot disagree.

Labels follow these rules:

- Only accountable `user` and `user-with-attachments` prompt rows are eligible. Assistant replies and tool-result-only rows never receive a label.
- Any loaded prompt with a validated `agent` or `system` author enables labels for the chat.
- Once enabled, every eligible loaded prompt with a valid author is labelled for context, including human prompts.
- All-human loaded history remains label-free, even if optional metadata contains multiple human IDs. Multi-human triggering is deferred until Bobbit has real human principals.
- Missing or invalid legacy metadata produces no badge on that row.

Visible text is exact:

| Kind | Prompt badge |
|---|---|
| Human | `User` |
| System | `System` |
| Agent | `<normalized label> | Agent` |

The human badge never appends `Human`. The system badge never exposes the internal `Bobbit` label. The badge overlays the bubble's top-left border; intrinsic sizing, ellipsis, timestamp spacing, and mobile-width constraints keep long labels, attachments, file mentions, and slash-skill chips usable. The historical unlabelled markup remains unchanged when labels are suppressed.

### Static agent identity appearance

Only agent badges include a Bobbit avatar. `resolvePromptAuthorAppearance()` resolves:

- `session:*` against already-loaded live sessions, then archived sessions;
- `staff:*` through the loaded staff row's current session, again preferring live over archived state.

The avatar uses the same session color index/hue rotation and canonical accessory definition as the sidebar. It is rendered through the existing Bobbit canvas/sprite pipeline with the canonical palette and forward-facing open eyes. It has no status input, animation class, timer, blinking, breathing, bobbing, transient desaturation, or abort/compaction treatment.

If the author, session, staff row, color index, or accessory cannot be resolved safely, the renderer uses the frozen canonical fallback: default hue and no accessory. It never allocates a new color or guesses a session.

## Model-facing prompt prefixes

Prefixing happens at one trusted boundary immediately before a Pi `prompt` or `steer` RPC:

```text
human:  A normal user prompt
system: [System]: A Bobbit-generated prompt
agent:  [Test Coordinator (1ae73f)]: A prompt from another agent
```

Current rules:

- human prompts are always unprefixed;
- systems use exactly `[System]: `, regardless of the internal system label or ID;
- agents use `[<normalized label> (<six-character display ID>)]: `;
- a same-author steer batch is prefixed once for that author;
- an existing mixed-author batch keeps `system:bobbit:batch` and is prefixed once as system;
- an all-human batch remains unprefixed.

The prefix is placed before the exact final model text. Existing recovery framing, skill expansion, attachment synthesis, and newline batching therefore follow it. Images and other non-text blocks are not rewritten; when Pi returns structured content, projection treats the first model-visible text block as the prefix boundary.

Only accountable visible prompts use this mechanism. Assistant output, tool results, hidden non-prompt orchestration payloads, indexed display text, and browser-side provider conversion do not receive author prefixes.

### Final-dispatch invariant

Queued, in-flight, retry, force-abort recovery, and restored text stays as unprefixed `baseModelText`. Each dispatch occurrence performs this sequence:

1. Derive `desiredPrefix` from the trusted author.
2. Form `desiredPiText = desiredPrefix + baseModelText`, or just `baseModelText` when no prefix applies.
3. Append the dispatch record for that exact Pi text to the private author sidecar.
4. Only if the append succeeds, send `desiredPiText` to Pi.
5. If the append fails, send unprefixed `baseModelText` and retain only a best-effort in-memory binding for that occurrence.

This write-before-prefix rule prevents Bobbit from placing text in Pi history that it cannot later prove was injected. Retry, reconnect, queue restore, provider-auth recovery, force-abort recovery, and gateway restart all re-enter the same final-dispatch boundary rather than persisting decorated text.

## Private author sidecar

Pi does not reliably preserve arbitrary Bobbit fields, and sandbox transcripts may live inside a container. Prompt attribution is therefore stored outside project roots at:

```text
<serverSecretsDir>/author-sidecar/<sessionId>.jsonl
```

The directory and files use owner-only permissions where the platform supports them. The v2 ledger has dispatch and settlement records. A dispatch record contains:

```ts
interface PromptAuthorDispatchRecord {
  schemaVersion: 2;
  type: "prompt-author";
  promptId: string;
  dispatchedAt: number;
  modelTextDigest: string; // keyed digest of exact Pi text
  source: PromptSource;
  author: MessageAuthor;
  modelPrefix?: string;    // exact injected prefix, never body text
}
```

The sidecar never stores base text, Pi text, attachments, images, recovery text, or skill-expanded plaintext. `modelTextDigest` is a domain-separated keyed HMAC of the exact dispatched Pi text, including any author prefix. Settlement rows mark a dispatch `echoed` or `cancelled` and may retain the Pi message ID/timestamp.

A present `modelPrefix` is semantically validated, not merely type-checked: it must exactly equal the prefix currently derived from that record's validated author, including normalized label, display ID, punctuation, and trailing space. A mismatched agent label or ID, a user record with a prefix, or an agent/system mismatch invalidates the record. An absent field remains valid for legacy and unprefixed occurrences but authorizes no stripping.

Redispatch folds by prompt ID, with the latest dispatch resetting earlier settlement. Cancelled and unresolved records cannot claim ordinary historical rows. Reads skip malformed, partial, unsupported, or semantically invalid records. Archive retains the sidecar; hard purge removes it.

## Correlation and replay-safe projection

Correlation chooses **which occurrence and author** a Pi user-role row belongs to. Projection separately decides whether the row still contains raw model text that Bobbit may alter.

Correlation prefers stable Pi/message IDs, then timestamp plus exact digest, then dispatch-ordered exact-digest FIFO. Structured prompt text is canonicalized by concatenating ordered text blocks without separators; image and unrelated blocks are ignored for matching but retained in the message. Restore replay also maintains its bounded keyless occurrence cursor and terminal guard so repeated identical prompts and duplicate terminal frames do not consume the wrong dispatch.

`projectCorrelatedPromptMessage()` applies the safety check:

1. Reconstruct the candidate's canonical raw model text.
2. Compare its keyed digest with the binding's `modelTextDigest` using a timing-safe comparison.
3. Stamp the correlated trusted author even when raw-text proof fails.
4. Strip content only when the stored `modelPrefix` is semantically valid, the raw digest matches, and the string or first text block starts with that exact prefix.
5. Remove exactly one leading copy. Never use a regular expression or infer a prefix from visible content.

This makes projection replay-safe without relying on object identity or a process-local marker:

- a fresh raw clone still matches the raw digest and projects once;
- a clone made after projection no longer matches the raw digest, so it is author-stamped but not stripped again;
- prefix-shaped user content is preserved. A base message `[System]: hello` sent by the system becomes `[System]: [System]: hello` in Pi, and only the injected first copy is removed from the visible projection.

## Projection surfaces

Every consumer that can expose or derive user-visible text must project before display rewriting or extraction:

| Surface | Boundary |
|---|---|
| Live events | Correlate and project before lifecycle tracking, EventBuffer storage, reconnect replay, or WebSocket broadcast. |
| Active and archived snapshots | Project before truncation, ordering fields, slash-skill restoration, and file-mention restoration. |
| Transcript and pre-compaction reads | Resolve over the full ordered sequence before filtering, pagination, compact/verbose conversion, or rendering. |
| Session title generation | Project full-history Pi rows before passing them to the naming model. First-prompt title generation already uses unprefixed accepted base text. |
| Search | Resolve and project raw transcript rows before extraction, snippets, weights, and content hashes. Author kind/ID/label remain metadata only. |
| Extension transcript/tool-call APIs | Project an in-memory JSONL copy before filtering or host-contract conversion, then remove private author/correlation fields. On-disk Pi JSONL is unchanged. |
| Fork and continue | Copy only echoed, transcript-confirmed sidecar bindings, preserving both raw digest and exact `modelPrefix`; destination replay uses the same projection. Failed setup purges the destination copy. |

The browser bubble, transcript APIs, pre-compaction history, archived reads, copied visible text, search snippets, search weights, and content hashes therefore use the original base text. Prefixes exist intentionally in raw Pi JSONL and provider-visible input only.

Search remains bounded. If compact sidecar correlation exceeds its record or byte budget, Bobbit skips ambiguous ordinary prompt rows rather than indexing an injected prefix or guessing an author; dependent tool attribution is omitted as needed. Legacy absence follows normal safe inference, but an authoritative set that cannot be correlated is not treated as local-human history.

## Failure and security behavior

The system prefers preserving literal content over guessing and deleting it:

- Browser, REST, extension, and Pi transcript payloads cannot assert an authoritative author. The server derives identity from session secrets, authenticated ownership, or server-minted surface tokens.
- IDs and labels are metadata, not authorization principals.
- A sidecar append failure sends that occurrence unprefixed.
- Missing, unreadable, corrupt, semantically invalid, or uncorrelated sidecar data never authorizes stripping. Raw transcript text remains literal, even if it resembles a Bobbit prefix.
- A digest mismatch, missing digest key, absent first text boundary, split prefix, or prefix at a nonzero offset leaves content unchanged.
- Sidecar correlation can still stamp a stable-ID-bound author when content is already projected; stable identity alone never authorizes deletion.
- Pi JSONL is never rewritten by normal projection. Startup migration of legacy plaintext ledgers preserves valid digest-only records and fails closed if reachable plaintext cannot be removed.

These degradation rules may leave a model-only prefix visible when its proof has been lost. That is safer than deleting prefix-shaped user text.

## Future multi-human seam

Bobbit currently has one local human fallback and does not collect a stable user ID or display name. Consequently:

- all-human loaded history remains label-free;
- every human prompt remains model-facing byte-for-byte unprefixed;
- `user:local` is not treated as evidence of multi-user participation;
- no sticky multi-human runtime flag exists.

The shared selector already returns ordered distinct validated human IDs, and the display-ID formatter preserves a future human ID remainder. A follow-up can add trusted human principals and a runtime `multiHumanSeen` flag, then enable labels and prefixes together after a second human is observed. It must not retroactively rewrite Pi history.

## Maintainer source map

| Responsibility | Source |
|---|---|
| Author types, validation, label normalization, display IDs, accountable-prompt predicate | `src/shared/message-author.ts` |
| Trusted identity construction, source mapping, and model-prefix formatter | `src/server/agent/message-author.ts` |
| Dispatch/settlement persistence, semantic prefix validation, correlation, digest-gated projection, copy/purge | `src/server/agent/author-sidecar.ts` |
| Final `prompt`/`steer` boundary, retries, replay bindings, title projection | `src/server/agent/session-manager.ts` |
| Central active/archived snapshot projection | `src/server/agent/visible-message-snapshot.ts` |
| Transcript, pre-compaction, and extension-facing JSONL projection | `src/server/agent/transcript-reader.ts` |
| Streamed search projection and metadata indexing | `src/server/search/sources/message-source.ts` |
| Loaded-history label selector and exact badge presentation | `src/ui/message-author-presentation.ts` |
| Live/archived/staff appearance resolution | `src/app/message-author-appearance.ts` |
| Chat-level slice aggregation and appearance context | `src/ui/components/AgentInterface.ts`, `PreCompactionHistory.ts` |
| Prompt-only label/avatar rendering | `src/ui/components/MessageList.ts`, `Messages.ts` |
| Canonical static Bobbit sprite and responsive badge styling | `src/ui/bobbit-render.ts`, `src/ui/app.css` |
| Extension routes and fork/continue lifecycle wiring | `src/server/server.ts` |

## Verification map

The authoritative registration and rationale live in `tests2/tests-map.json`.

| Contract | Primary coverage |
|---|---|
| Selector, exact strings, label/ID normalization, no human prefix | `tests2/core/message-author-surfacing.test.ts` |
| Loaded-state hue/accessory resolution and safe fallback | `tests2/core/message-author-appearance.test.ts` |
| Final dispatch, write-before-prefix, batching, recovery base text, replay/title projection | `tests2/core/message-author-dispatch.test.ts` |
| Sidecar plaintext exclusion, semantic `modelPrefix` validation, raw-digest idempotence, structured blocks, corruption, copy/purge | `tests2/core/author-sidecar.test.ts` |
| Prompt-only DOM labels and transcript-wide main/pre-compaction mode | `tests2/dom/message-author-labels.test.ts` |
| Canonical open-eye sprite pixels, shared hue/accessory registries, and no timers/animation | `tests2/dom/message-author-sprite.test.ts` |
| Pi versus live/snapshot/transcript/title/search text, mixed batches, and append-failure degradation | `tests2/integration/message-author-ws-server.test.ts` |
| Extension transcript and tool-call projection/filtering | `tests2/integration/message-author-extension-projection.test.ts` |
| Fork/continue binding copy, replay ordering, and failed-setup cleanup | `tests2/integration/continue-archived.test.ts` |
| Live/reload/narrow-layout labels and sidebar-matched static avatar | `tests2/browser/journeys/author-metadata.journey.spec.ts` |
| Raw Pi persistence, EventBuffer/reconnect idempotence, search rebuild, and gateway restart | `tests/e2e/message-author-prefix-restart.spec.ts` |

Retry, attachment, queue, provider-auth, force-abort, rehydration, and verification suites also pin that durable/recovery text stays unprefixed and each later RPC re-applies the final-dispatch contract.

For the original metadata-only design and its superseding addendum, see [Author Identity Metadata](design/author-identity-metadata.md).
