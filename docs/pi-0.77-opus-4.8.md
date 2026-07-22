# Pi 0.77 / Claude Opus 4.8 compatibility

Bobbit consumes Pi for model metadata, agent process control, and provider adapters. The Pi `0.77.0` upgrade adds first-class Claude Opus 4.8 metadata and changes enough adjacent runtime behaviour that Bobbit pins the integration with model-ranking, thinking-level, spawn, transcript, Bedrock, and RPC lifecycle tests.

This page documents the shipped Bobbit-side contract for that upgrade. For current Pi runtime compatibility boundaries and the Pi `0.81.1` upgrade notes, see [Pi runtime compatibility](pi-runtime-compatibility.md).

## Package and model support

Bobbit pins these Pi packages to `0.77.0`:

- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`

Pi `0.77.0` is the version that introduces Claude Opus 4.8 catalog entries. Bobbit expects the Anthropic model id `claude-opus-4-8` to appear as `anthropic/claude-opus-4-8` when the provider exposes it, with Pi metadata for:

- display name: `Claude Opus 4.8`
- context window: `1_000_000`
- max output tokens: `128_000`
- reasoning enabled
- `xhigh` thinking support

The model list remains provider-driven. Bobbit can only display and select Opus 4.8 when `/api/models` includes it from the active provider source: direct Anthropic, Bedrock-backed Pi metadata, or an AI Gateway configuration that advertises the canonical model id.

## Discovery, display, and selection

Model discovery flows through the server model registry, then to `/api/models`, then to the UI `ModelSelector`. The selector does not hardcode Opus 4.8 as a special row; it sorts any discovered model using the same recency rules the server uses for auto-selection.

The important guarantee is consistency:

- server auto-selection uses `modelRecencyRank()` in the model registry;
- the UI selector has a copy of the same ranking helper;
- tests pin the Opus 4 parser so the server and UI do not regress independently.

If the provider does not expose Opus 4.8, Bobbit should not invent it. Existing saved preferences for unavailable models keep the normal red unavailable state until the provider exposes that id again or the user clears the preference.

## Opus 4 ranking parser

Older Bobbit builds ranked Opus minors by a fixed ladder. That made a newly released id like `claude-opus-4-8` fall through to the generic Opus 4 tier until Bobbit was patched.

The current ranking parses the minor version from either supported spelling:

```text
claude-opus-4-8
claude-opus-4.8
```

The parser intentionally captures only short version-looking minors. Date-only ids such as `claude-opus-4-20250514` stay in the generic Opus 4 tier instead of being mistaken for a future Opus minor.

Parsed Opus 4 minors rank by version, so:

- Opus 4.8 ranks above Opus 4.7;
- dotted and hyphenated ids rank the same;
- future ids such as `claude-opus-4-10` rank above 4.8 without another hardcoded ladder update;
- parsed Opus 4.8 ranks above Sonnet 4.6 in Bobbit's recency sort.

This matters in two places: the server's best-model fallback and the UI's displayed ordering. A future Opus minor should require only upstream provider metadata, not a Bobbit ranking patch.

## `xhigh` thinking support

Thinking-level capability is centralized in `src/shared/thinking-levels.ts`; see [Per-model thinking-level capabilities](thinking-levels.md) for the full contract.

For Opus 4.8, `xhigh` is accepted through two paths:

1. **Pi metadata first.** If the discovered model carries a `thinkingLevelMap`, Bobbit trusts the whole map (Opus 4.8's `{xhigh:"xhigh"}` yields the full `off→xhigh` ladder). Bobbit now mirrors pi-ai's map semantics fully, not just `xhigh` detection — see [Per-model thinking-level capabilities](thinking-levels.md#mirroring-pi-ai-when-a-thinkinglevelmap-is-present).
2. **Fallback family rule.** Sparse payloads, including some AI Gateway and persisted-state paths, match Claude Opus 4.6+ ids with either hyphen or dotted spelling.

Provider guarding still applies. The fallback accepts Anthropic, AI Gateway (`aigw`), and legacy empty-provider state. It rejects mismatched provider/id collisions, such as an OpenAI-provider model with a Claude-shaped id.

Clamping for Opus 4.8 is unchanged: if `xhigh` is stored but the resolved model does not support it, Bobbit degrades to the highest supported lower level. Stored preferences preserve the user's intent; spawn-time and set-time paths clamp against the resolved model before talking to Pi. (The clamp is now up-then-down to match pi-ai exactly — relevant only for maps that drop `off` or a middle level, e.g. Fable; Opus 4.8 supports `off` so its clamp result is identical.)

## Spawn pinning and no-flash guarantees

Bobbit passes the resolved model and thinking level to pi-coding-agent at process start instead of booting on Pi's CLI default and switching afterward. For Opus 4.8 this means a session pinned to `anthropic/claude-opus-4-8` starts with:

```text
--model anthropic/claude-opus-4-8 --thinking xhigh
```

The same pre-resolution applies to:

- normal session creation;
- worktree-pool claimed sessions;
- role respawn and force-abort respawn;
- verification reviewer, QA, and legacy sub-sessions;
- continue-archived sessions.

Post-spawn helpers still verify the agent state. When the spawn-pinned model matches the model that would otherwise be applied, Bobbit skips the redundant `setModel` RPC but still reads back `getState()` and fails loudly on mismatch. The only skipped work is the duplicate switch that previously caused a transient older-model footer flash.

The AI Gateway cold-cache fallback remains the documented exception: if Bobbit cannot resolve a concrete gateway model before spawning, it may boot first and select the best-ranked gateway model after discovery completes.

## Verification sub-session tool activation

Verification reviewer, QA, and legacy direct sub-sessions use the same tool-activation contract as normal sessions. Bobbit does not pass Pi's unified `--tools` allowlist for those sub-sessions, because that flag can filter out Bobbit extension and MCP tools as well as Pi builtins.

Instead, verification sub-sessions route through `buildVerificationToolActivation()`, which delegates to `computeToolActivationArgs()` when a `ToolManager` is available. That emits `--no-builtin-tools`, `--no-extensions`, explicit extension paths, the `_builtins` re-registration shim, and the guard extension used for policy enforcement. If no `ToolManager` is available, the legacy direct path emits no explicit activation flags so `RpcBridge.start()` can apply its baseline fallback without reintroducing `--tools`.

## Persistence, reconnect, restore, and archived sessions

Opus 4.8 persistence uses the existing session-store fields: `modelProvider` and `modelId`. Those fields are the source of truth when live agent state is temporarily unavailable.

The reconnect and restore contract is:

- live WebSocket connect asks the agent for state when possible;
- if `getState()` fails or returns incomplete metadata, the server sends fallback model state derived from persisted provider/id plus inferred metadata;
- the context bar starts at an empty `0` window until real metadata arrives, avoiding a misleading default window;
- archived sessions receive a `state` frame during the initial handshake, before any manual `get_state` retry is needed;
- continue-archived clones the Pi JSONL transcript and pre-resolves the copied session's model so the new agent starts on the saved model rather than flashing a placeholder.

The client still has a short-lived placeholder model object for pre-state rendering. The no-flash guarantee is server-owned: every live, restored, and archived path must push or verify the persisted model immediately enough that users see `claude-opus-4-8` instead of an older placeholder or Pi default.

## Sandbox OpenAI Codex auth

Pi `0.77.0` added headless OpenAI Codex login support, so sandboxed agents need a safe way to see Codex credentials without mounting the host agent directory wholesale.

Bobbit never mounts host `<agentDir>/auth.json` into Docker containers. It mounts only the active agent directory's `sessions/` directory and `models.json`, then writes a generated, sandbox-scoped auth file under `.bobbit/state/sandbox-agent-auth/<scope>.auth.json` and mounts that file read-only as `/home/node/.bobbit/agent/auth.json`. The scope is normally the project id, which prevents one project's allowed Codex auth file from being reused by another project whose policy denies it. See [Configurable agent directory](configurable-agent-directory.md#sandbox-safeguards).

The generated auth file follows sandbox token policy:

- if `sandbox_tokens` is unset, Bobbit preserves the legacy permissive fallback and may include Codex auth;
- if `sandbox_tokens` is set, Codex auth is included only when an enabled `OPENAI_CODEX_AUTH` or `OPENAI_API_KEY` entry is present;
- Google OAuth auth is stricter: it is included only when policy explicitly enables `GOOGLE_CLOUD_ACCESS_TOKEN`, even when `sandbox_tokens` is unset;
- when policy denies an auth entry, the mounted file is `{}` so Pi sees an expected auth path but no secret.

When Codex auth is allowed, preference-backed credentials win first: `providerKey.openai-codex` becomes an `openai-codex` API-key entry. If no preference key is set, Bobbit copies a sanitized host `openai-codex` credential from auth.json, then falls back to legacy ChatGPT OAuth stored under `openai`. Only the credential fields Pi needs are copied (`type`, API key, OAuth access, refresh, and expires). Google OAuth follows the separate `google-gemini-cli` sandbox propagation path described in [Google OAuth & Gemini models](google-oauth-models.md#token--sandbox-propagation-high-level).

## Transcript compatibility: `active_tools_change`

Pi `0.77.0` can write `active_tools_change` entries to the session tree when the active tool set changes. These are metadata entries, not chat messages.

Bobbit transcript readers treat them like any other non-message envelope:

- they are ignored by `parseJsonl()`;
- they do not count toward transcript totals, offsets, or windows;
- they do not appear in compact or verbose transcript output;
- surrounding message indexes remain dense and stable.

This keeps archived transcript views, `read_session`, and pre-compaction history compatible with Pi transcripts that contain tool-activation metadata.

## Bedrock patch and RPC lifecycle coverage

Three Pi-adjacent compatibility points are intentionally regression-tested:

- **Bedrock request-header patch.** Bobbit still patches Pi's Bedrock provider so Bedrock traffic can carry Bobbit's request headers. The compatibility test verifies that the installed `amazon-bedrock.js` still has the expected patch anchors, or is already patched, before asserting the Bobbit hook is present. This catches upstream Pi provider rewrites early.
- **RPC child-exit lifecycle.** Pi `0.76+` rejects pending RPC requests more reliably when the child process exits. Bobbit's bridge test crashes a synthetic Pi child while a prompt is pending and asserts the prompt rejects exactly once, `process_exit` is emitted exactly once, and repeated `stop()` calls are idempotent.
- **Prompt dispatch recovery.** If a direct prompt or queued prompt is dequeued but the RPC call rejects before the agent accepts it, Bobbit re-enqueues the exact rows at the front of the queue and schedules another drain. If the child has already exited and the session is terminated or aborting, Bobbit does not recover the rows into a dead process; restart/abort recovery owns that path.

These tests are not Opus-specific, but they protect the runtime paths most likely to be disturbed by Pi upgrades.

## Verification commands

Run the normal compatibility suite before accepting a Pi/model upgrade:

```bash
npm run check
npm run test:unit
npm run test:e2e
```

Useful targeted checks while iterating:

```bash
npx tsx --test --test-force-exit tests/model-utils.test.ts
npx tsx --test --test-force-exit tests/thinking-levels.test.ts
npx tsx --test --test-force-exit tests/rpc-bridge-spawn-args.test.ts
npx tsx --test --test-force-exit tests/session-store.test.ts tests/session-manager-restore.test.ts
npx tsx --test --test-force-exit tests/transcript-reader.test.ts
npx tsx --test --test-force-exit tests/rpc-bridge-lifecycle.test.ts
npx playwright test --config tests/playwright.config.ts tests/ui-fixtures/model-selector-fixture.spec.ts tests/thinking-levels-per-model.spec.ts
```

For package hygiene, also verify the lockfile has no stale Pi `0.75.x` entries:

```bash
npm ls @earendil-works/pi-agent-core @earendil-works/pi-ai @earendil-works/pi-coding-agent
```
