# Claude SDK composer slash interception (D2)

## Shipped decision

Bobbit owns its composer controls, discovered skills, and Extension Platform
`composer-slash` launchers before a prompt reaches either runtime. This prevents a
Bobbit command from accidentally acquiring a different meaning from a bundled
Claude command while retaining the existing server-owned skill-expansion path.

This is not Claude command configuration. Bobbit does not create command files,
plugins, settings, or generated worktree artifacts, and it does not mirror the
Claude command catalogue. The Agent SDK query remains isolated:

```ts
settingSources: []
strictMcpConfig: true
```

Only the existing Extension Platform launcher API is used:
`listLauncherEntrypoints("composer-slash")` supplies active contributions and
`runLauncherEntrypoint()` runs one. Pack-bound Host API construction remains in
the platform; D2 adds no Claude-private extension surface.

## Runtime inventory

`MessageEditor` builds a `ComposerSlashRegistry` whenever it filters autocomplete
or resolves a submitted command. The registry combines:

- the scoped `/api/slash-skills` catalogue;
- server-provided collision claims for recognized but non-menu skills;
- current active `composer-slash` launchers; and
- the explicit session runtime: `pi`, `claude-agent-sdk`, or temporarily unknown
  while session identity is loading.

The registry is intentionally shared by menu and send resolution. A skill's
`userInvocable: false` status hides it from autocomplete but does not give a
same-named pack launcher permission to appear or launch. Duplicate bare launcher
ids are also omitted: the composer cannot choose among them. A selected launcher
is always routed with its exact compound entrypoint key, not a bare-id fallback.

The editor clears scoped skills and collision claims immediately when the session,
cwd, project, or runtime changes. It then refetches the current scoped catalogue;
generation checks discard an older response. Launchers are read from the current
pack registry at filter/send time. Thus a project or session change cannot briefly
offer the previous session's skill or runtime-specific control.

The registry itself, launcher bodies, and menu selection are not stored in drafts.
After reload, Bobbit refetches skills for the active cwd/project and reconciles
active pack entrypoints. Text and attachment drafts retain their normal draft
behavior. A removed or disabled launcher therefore disappears; text that no
longer resolves to a launcher takes the ordinary prompt path rather than calling
a stale host.

## Command ownership and collisions

Only runtime-supported Bobbit entries appear in autocomplete:

| Source | Pi menu | Claude Agent SDK menu | Send behavior |
| --- | --- | --- | --- |
| User-invocable scoped skill | shown | shown | ordinary prompt path; the server expands the skill |
| Current unmasked, unambiguous pack launcher | shown | shown | Extension Platform launcher dispatch |
| `/compact` | shown | hidden | Pi local compaction; SDK local unsupported alert |

There are no implied composer commands for Bobbit tools, goals, reviews, or
Claude built-ins. In particular, `/goal` and `/review` appear only when the
current Bobbit skill catalogue contains those exact skills.

Ownership uses an exact full-composer token, never a prefix match:

1. `/compact` is a Bobbit control/reservation.
2. A current server-recognized skill owns its exact name, including a hidden
   collision claim.
3. An unmasked, unambiguous launcher owns its exact name.
4. Everything else is ordinary runtime input.

A skill deliberately falls through the editor's normal `onSend` path. The server
then expands it through `resolveSkillExpansions()` before it enqueues `modelText`
for the Pi bridge or `ClaudeAgentSdkBridge`. This preserves arguments, inline
expansion, chips, snapshots, file mentions, sandbox path headers, and replay
semantics without duplicating skill bodies in the client.

Consequently, a configured Bobbit `/goal` or `/review` skill is completed in the
menu and expanded before the SDK sees the prompt. With no such skill, those names
are neither shown nor reserved and pass through as raw runtime text. Unknown
commands, non-command slashes, mixed prose, and near-prefixes such as
`/review-notes` and `/compact-notes` also pass through unchanged unless they are
independently registered exact names.

Pack launcher interception applies only to a full-line exact launcher command and
only without attachments. With attachments, it takes the ordinary prompt path so
Bobbit never drops a file to launch a UI action. A launcher that resolves runs
through `runLauncherEntrypoint()` with its existing pending, resolved, and error
feedback; it never calls `onSend` or retries as an agent prompt after failure.

## Compaction behavior

Manual compaction is a runtime capability, not a check for the presence of a
`compact()` method. The SDK bridge defines that method only to report that manual
compaction is unsupported, so the server-provided runtime controls the composer.

- In a **Pi** session, exact trimmed case-insensitive `/compact` is a local
  compaction action and never becomes a model prompt. It is shown in autocomplete.
  Attachments block the action with an inline error and preserve the draft/files.
- In a **Claude Agent SDK** session, exact `/compact` is a hidden Bobbit
  reservation. It is consumed before `onSend`, history, clearing, or focus
  changes, shows the `role="alert"` message *Manual compaction isn’t available
  for Claude Agent SDK sessions.*, and never reaches a bundled Claude `/compact`.
  Draft text and attachments remain available for correction.
- While runtime identity is **unknown**, `/compact` is also consumed rather than
  optimistically assuming Pi. The editor reports that manual compaction is
  unavailable until the runtime is ready. This avoids exposing Pi control or
  leaking an SDK-native command during session loading.

SDK-managed automatic compaction remains separate: its SDK lifecycle hook still
uses Bobbit's existing `beforeCompact` path. D2 changes only manual composer
handling.

## Enter, Ctrl/Cmd+Enter, and autocomplete

Autocomplete owns Enter before either send path. When the slash or file-mention
menu is open, Enter, Ctrl+Enter, and Cmd+Enter select the highlighted completion;
they do not send or steer. Selecting a slash item only writes `/name ` into the
composer, allowing arguments to be added.

Plain Enter evaluates the registry after attachment-size validation. It performs
local compact/launcher handling where applicable; otherwise it uses the ordinary
prompt path described above.

Ctrl/Cmd+Enter normally sends a text-only live steer, which bypasses server skill
expansion and local launcher dispatch. To keep Bobbit-owned commands from
reaching a runtime raw on that bypass path, every exact registry dispatch is
refused with an inline alert and the draft remains intact. For a skill or launcher
that alert tells the user to press Enter so normal send and server expansion (or
launcher dispatch) can run. Exact SDK `/compact` instead receives its specific
unsupported-compaction alert. Ordinary and unknown text continue to steer
normally; attachments still block all steers without discarding the draft.

## Delivery flow

```text
textarea
  -> current registry (runtime + scoped skills/claims + active pack launchers)
  -> autocomplete, or Enter/Ctrl/Cmd+Enter
     -> open autocomplete: complete selection only
     -> normal Enter:
        -> hidden/unavailable /compact: alert, preserve editor
        -> Pi /compact: local compaction
        -> exact unmasked launcher without attachments: platform launcher
        -> otherwise onSend
           -> WebSocket prompt -> resolveSkillExpansions/file mentions
           -> enqueuePrompt(modelText) -> Pi or ClaudeAgentSdkBridge
     -> Ctrl/Cmd+Enter:
        -> exact Bobbit-owned command: alert, preserve editor
        -> otherwise text-only steer
```

## Isolation boundary

Composer interception is strictly a client/runtime-routing feature. It does not
change Agent SDK lifecycle, session identity, permissions, transcript ownership,
MCP ownership, resume, or tool policy. In particular, the SDK bridge continues to
receive only final expanded prompt text and its query options retain no settings
sources, only Bobbit's live MCP server, and strict MCP configuration. No command
source is added to SDK configuration.

## Verification

Focused DOM coverage proves menu/send registry sharing, exact compound launcher
routing, ambiguity refusal, hidden-skill masking, Pi and SDK compaction behavior,
unknown-runtime safety, ordinary slash pass-through, and steering refusal.
`claude-sdk-composer-slash.journey.spec.ts` covers SDK autocomplete and skill
expansion, raw unknown-command delivery, hidden `/compact`, launcher dispatch,
and scoped inventory behavior across reload/session changes. The Agent SDK tool
surface tests retain literal assertions for `settingSources: []`,
`strictMcpConfig: true`, and only the `bobbit` MCP server.
