# MCP server startup approvals

Bobbit requires an explicit operator decision before it starts or contacts an MCP server introduced by repository-controlled project configuration. The boundary exists because merely opening or registering a cloned repository must not execute a local command or send data to a remote endpoint.

Startup approval is separate from **Tool calls** policy:

- Startup approval controls whether a server process or connection may exist and whether Bobbit may initialize it or discover operations.
- **Tool calls** (`Allow`, `Ask`, or `Never`) controls whether an agent may invoke operations after an eligible server has connected.

Changing tool-call policy cannot bypass startup approval. Pending, rejected, changed, and invalid definitions are not spawned or contacted, do not receive initialization or `tools/list` requests, and publish no operations.

## Review and decide

When the currently relevant project has definitions to review, Bobbit shows a compact banner with the pending count and a **Review servers** action. The count includes **Pending approval** and **Configuration changed — review again** definitions. Rejected definitions remain in the management view but do not keep the banner open.

Use **Tools → MCP** to manage definitions:

1. Select the project whose MCP view you want to inspect. A **Review servers** action opened from a session or goal retains that owner's execution scope, so Tools reviews the same worktree definition as the runtime; opening Tools directly reviews the registered project root.
2. If the browser is not paired, enter the current MCP pairing code from the gateway terminal and choose **Pair browser**.
3. Expand one server row. Review the introducing project and logical source file, transport, command and arguments or remote URL, working directory, environment/header names, and fingerprint.
4. Choose **Approve**, **Reject**, or, after a prior decision, **Approve current configuration**. There is intentionally no approve-all action.

Pairing authorizes the browser; it does not approve a server. Decisions remain deliberate and per-server.

The row reports startup trust independently from connection health:

- **Trusted** means the source was authorized through an existing user, administrator, or Marketplace flow and needs no startup decision.
- **Pending approval**, **Rejected**, and **Configuration changed — review again** show **Not started**, not a connection error.
- **Approved** permits startup, after which the separate health state can be connected, disconnected, reconnecting, or error.

Rejection is reversible. Rejecting a running server disconnects it and removes its routes and external tools; approving the currently displayed definition makes it eligible again without a gateway restart.

## Pairing requires terminal-code possession

A normal gateway bearer token or browser session cookie is not enough to approve project MCP startup. Repository-controlled agents can possess those general admission credentials, so approval mutations require a separate, purpose-bound capability. Pairing proves possession of the current terminal code; the resulting bearer credential is not bound to a particular person, browser, or device.

At gateway startup, the terminal prints an MCP pairing code. The code:

- is single-use and expires after ten minutes;
- is held by the gateway only as an in-memory digest;
- is replaced when the gateway creates a newer code; and
- is rate-limited by remote address after repeated failed attempts.

`POST /api/mcp-operator/pair` exchanges the current code for an opaque operator credential. Pairing a browser replaces the gateway's previous operator credential, so an older paired browser can no longer make decisions. The gateway persists only the credential ID and a one-way verifier—not the code, credential secret, or complete credential.

The UI stores the complete credential per normalized gateway base URL in browser local storage and keeps an in-memory copy for the current tab. Pair only a trusted browser profile: same-origin script can read local storage, and anyone holding the credential can submit decisions. If local storage is unavailable, the tab remains paired and shows a warning, but it must be paired again after reload. A rejected or obsolete credential is forgotten for that gateway.

The browser sends the credential only as `X-Bobbit-Mcp-Operator` on an approval or rejection request. It is not attached to pairing, status, or generic API requests. This narrow use prevents a general Bobbit credential from becoming MCP approval authority. Repository previews are also opaque-origin sandboxed frames: they cannot read the parent document, browser storage, operator credential, or pairing controls. See [Preview architecture](preview-architecture.md#security-boundary).

## Which sources require approval

Bobbit classifies the source that supplied the effective definition rather than treating every MCP server alike.

| Source class | Startup trust | Reason |
|---|---|---|
| A normal registered project's `.mcp.json`, `.claude/.mcp.json`, or `.bobbit/config/mcp.json` | Approval required | Repository-controlled content can change when code is cloned, checked out, or updated. |
| A custom MCP directory declared by a normal project | Approval required | The project controls the declaration, even when the resolved directory is outside the repository. |
| The same project-controlled sources discovered through another registered project | Approval required and attributed to the introducing project | Multi-project discovery must preserve which repository introduced a process or endpoint. |
| `~/.claude.json` (including matching project entries), `~/.claude/.mcp.json`, and `~/.bobbit/.mcp.json` | Pretrusted | The user explicitly manages these files outside a repository. |
| Headquarters `config/mcp.json` and custom MCP directories declared by Headquarters | Pretrusted | They use the existing administrator-controlled configuration flow. |
| Server- or global-user-scoped Marketplace contributions | Pretrusted | Installation and activation are already explicit trust decisions. |
| Project-scoped Marketplace contributions with an exact private install attestation | Pretrusted | Bobbit's Marketplace install/update flow attested the exact installed behavior. |
| Unattested or modified project-scoped Marketplace content | Approval required | Repository files cannot claim Marketplace authority merely by containing pack metadata. |

Existing project definitions are not grandfathered during upgrade. A definition without either an exact private Marketplace attestation or a matching approval decision starts pending.

### Marketplace install attestations

Project-scoped Marketplace installation is a special case because its files live under the project but installation is an explicit Bobbit action. For a project pack that declares MCP contributions, Bobbit measures the complete pack: every directory, regular file, and internal relative symlink contributes its relative path, entry type, executable/search bits, bytes or link target. Traversal and opened files are rechecked so a partial or concurrent replacement cannot inherit install trust. Unsafe entry types or links, cycles, changed snapshots, and enforced entry, byte, or path bounds fail closed. Packs without MCP contributions skip this pass because they cannot introduce an MCP runtime through this path.

The install flow requires the staged and published pack measurements to match before it atomically records a private attestation binding:

- project and Marketplace source identity;
- pack and contribution identity;
- server name; and
- a keyed fingerprint of the exact configuration and complete-pack measurement.

The raw pack measurement is not persisted or exposed. Discovery treats a project contribution as Marketplace-pretrusted only when that complete tuple and fingerprint match. The current attestation ledger is schema 2; legacy configuration-only ledgers are not accepted after this upgrade. Copied pack metadata, an old/missing/corrupt attestation ledger, or any on-disk pack change falls back to project-controlled approval. A changed attested contribution appears as **Configuration changed — review again** when it has no matching decision. Its manual approval fingerprint also includes the complete-pack measurement, so another pack edit invalidates that decision even if the MCP JSON is unchanged. Uninstall removes the pack's attestations.

Reinstalling or updating through Marketplace records the newly installed definitions. Alternatively, an operator can review and decide the currently effective project-controlled definition in **Tools → MCP**. MCP Gateway materializations follow the same project-scope attestation rule.

## Decision identity and fingerprints

A startup decision identifies one exact effective definition by:

- stable registered Bobbit project ID;
- logical source ID;
- runtime server name; and
- opaque configuration fingerprint.

Standard project files use logical source slots such as `project-file:.mcp.json`; their checkout path is not part of the identity. For a project-declared custom MCP directory, Bobbit canonicalizes the declaration before hashing its source identity: whitespace and lexical path segments are normalized, separators are unified, `~` form is preserved, and absolute path identity follows platform case rules. Equivalent declarations such as `./mcp` and `mcp` therefore share an identity, while genuinely different declarations do not.

This logical identity prevents worktree paths from creating duplicate decisions. The same project ID, logical source, server name, and exact configuration can reuse a decision across a registered root and its worktrees. Different content still has a different fingerprint.

### Canonical behavior

Approval fingerprints are HMAC-SHA-256 digests under a random, gateway-private key. The versioned canonical input includes:

- derived transport (`http` when a URL is present, otherwise `stdio`) and any explicitly configured transport field;
- command, ordered arguments, and configured working-directory semantics;
- configured environment names and their values after `${VAR}` expansion against the gateway environment;
- the complete URL and configured header names and values; and
- unknown own configuration fields, including prototype-like JSON keys such as `__proto__`.

Object keys are sorted recursively, array order is preserved, `undefined` properties are omitted, and defaults such as empty arguments, environment, and headers are explicit. Reordering object properties does not invalidate a decision; changing an argument's position, an environment/header name or value, URL credentials/query/fragment, an unknown field, or any other behavior-bearing value does.

Only configured environment values participate. Changing an ambient variable referenced by `${VAR}` changes the effective value and fingerprint; changing an unrelated ambient variable does not. The approval is for repository-supplied behavior, not a snapshot of the gateway's entire inherited process environment.

Bobbit validates a definition before it can be approved. It must contain exactly one non-empty local command or HTTP(S) URL. Arguments must be strings, the working directory must be a string, environment and header values must be strings, and header names must be unique case-insensitively. Invalid definitions stay inert and have no decidable fingerprint.

Bobbit retains decisions for exact fingerprints. Removing and later restoring an identical definition, or reverting a change, may reuse the earlier decision. A behaviorally different definition cannot inherit it.

## Safe review metadata

Status and stale-decision responses are built from the live effective definition but expose only safe review data:

- Environment and header names remain visible; every value is `[redacted]`, including prototype-like own keys.
- URL username, password, query, and fragment are removed. An unparseable URL is replaced entirely with `[redacted]`.
- Configured environment/header values, including expanded environment values, are redacted wherever they also occur in a command or argument. Longer matching values are processed first.
- Credential-shaped CLI forms are redacted for separated, `--flag=value`, quoted, header (`-H`), and attached-header syntax. Benign text remains visible where possible so the operator can still identify the command.
- Physical source paths and internal Marketplace attestation signals are omitted. Source URLs receive the same URL redaction; logical source files and introducing project attribution remain visible.
- Parse and validation diagnostics do not echo configuration contents.
- Connection, initialization, stderr, and other runtime error text is separately sanitized before it reaches status or API responses: configured environment/header values and URL credential/query/fragment components are removed, complete configured URLs are reduced to a safe endpoint, and output is bounded.

Redaction is a display boundary, not the approval identity. The fingerprint uses the complete canonical behavior before redaction, so two different secret values produce different fingerprints even though both display as `[redacted]`. Approval fingerprints use a private HMAC key so the displayed digest is not a direct hash that can be used to guess a low-entropy secret.

## Private persistence and agent environment boundary

Approval authority is server-private and lives outside registered repositories and ordinary Headquarters state. By default, Bobbit chooses a `bobbit/secrets/<headquarters-hash>` namespace in the current OS user's private application/state area:

- Windows: `%APPDATA%` (falling back to the user's `AppData/Roaming` directory);
- macOS: the user's `Library/Application Support` directory; and
- other platforms: `$XDG_STATE_HOME` or the user's `.local/state` directory.

The hash keeps gateways with different Headquarters directories in separate stable namespaces. `BOBBIT_SECRETS_DIR` overrides the complete private root; operators must keep an override outside every registered project and agent working directory.

The private root contains:

- `mcp-approvals/mcp-server-approvals.json` — exact approval/rejection decisions;
- `mcp-approvals/mcp-server-approval.key` — approval fingerprint HMAC key;
- `mcp-operator-authorization.json` — operator credential ID and verifier; and
- `marketplace-mcp-install-attestations.json` — exact project Marketplace install attestations.

The decision ledger stores only schema, project/source/server identity, opaque fingerprint, decision, and timestamp. The Marketplace ledger likewise stores identities, fingerprints, and timestamps rather than raw MCP configuration. On POSIX systems new authority files are opened with mode `0600` and private directories request mode `0700`; some permission tightening is best-effort, so operators should also enforce appropriate ownership and parent-directory permissions. On Windows the files remain under the selected user's application-data boundary and inherit its access controls. Writes use exclusive temporary files, flush data, and publish by atomic rename.

Historical approval files under `<headquarters-dir>/state` are deliberately ignored and are not migrated. That location can be inside a registered project's reachable tree in a same-root setup, so trusting a preseeded key or ledger there would let repository content mint its own approval. `BOBBIT_DIR` still relocates Headquarters, but only `BOBBIT_SECRETS_DIR` overrides live secret storage.

Agent subprocess environments are sanitized after inherited and caller-provided variables are merged:

- `BOBBIT_SECRETS_DIR` is removed case-insensitively so an agent is not handed the private-root locator.
- `NODE_EXTRA_CA_CERTS` is removed when it points inside the private root, which also contains private TLS material.
- Direct agents receive a separate public CA certificate copy under the agent directory when it can be published. Otherwise that direct process uses the existing disabled-TLS-verification fallback; sandboxed agents also currently use that fallback.

Safe MCP status omits private physical paths for the same reason. Environment sanitization reduces accidental disclosure but is not an OS access-control boundary: a non-sandboxed agent or approved MCP process retains the gateway user's filesystem privileges. Use sandboxing or a separate OS account when untrusted code needs stronger isolation.

If the approval HMAC key is missing or corrupt, Bobbit creates a replacement when possible and discards decisions that can no longer be authenticated. Affected definitions fail closed to pending. If the key cannot be established, they remain pending without a fingerprint and cannot be decided. If an atomic decision write fails, the previous in-memory and on-disk decision—and therefore runtime eligibility—remain unchanged.

## Multi-project, shared-owner, and runtime lifecycle

Discovery precedence is resolved before startup eligibility. Only the effective same-name winner is classified and shown. A higher-priority pending, rejected, changed, or invalid project definition continues to shadow a lower pretrusted definition; Bobbit does not start the lower server as a fallback. See [Internals — MCP servers](internals.md#mcp-servers) for the discovery order.

The project selected in Tools is the *view scope*. The introducing project's ID and logical source ID are the *decision scope*. The endpoint validates both scopes and the current fingerprint, preventing a decision from applying to a same-named server from another project or a definition changed during review.

Some Marketplace contributions share one physical runtime connection when they resolve to the same runtime key and identical configuration. Every owner of that connection must be trusted or approved before Bobbit connects it. If several project-controlled owners are pending, the row surfaces the first blocked owner; after deciding it, review the next owner until all are eligible. Adding, changing, removing, or rejecting any owner tears down the shared connection and all of its routes before further calls.

A gateway can also have multiple active MCP managers keyed by logical project and canonical host execution directory. Each session binds to the manager for the project root or worktree content it actually executes, including the host coordinate behind a sandbox path. Sessions on the same exact project/worktree scope may share that manager; Bobbit disconnects a non-root manager after its last bound session releases it. All managers share one approval store.

Review of a worktree outside the registered root is owner-scoped, not path-scoped. Status and decision requests must name one current session or goal owned by the selected project, and the claimed directory must validate against that owner's execution scope. A bare/arbitrary `cwd`, missing or stale owner, foreign session/project, or root-only Tools view cannot authorize an external sibling worktree. Invalid scope is rejected before creating a manager or discovering its repository-controlled content.

After a successful decision Bobbit reloads every active manager, because a server introduced by one registered project may be active in another project's view. Project registration, removal, root moves, and project Marketplace mutations likewise reconcile all affected active managers. Managers created later read the same durable decision.

Runtime checks close configuration-change races at every data-bearing boundary:

- discovery and approval eligibility run before connecting;
- the effective definition is rediscovered after initialization and before `tools/list` or route publication;
- queued reloads run again when a mutation arrives during an in-flight reload; and
- the effective definition is rediscovered immediately before every tool call.

If the source changes or disappears during one of those windows, Bobbit disconnects the stale client and sends no tool-call data. Periodic reconciliation catches edits made outside Bobbit, while status reads reconcile the requested project scope. Configuration removal, rejection, or invalidation removes active connections and external tool registrations without requiring a gateway restart.

## Status and approval API

These endpoints still require normal gateway admission unless trusted-local admission applies. `X-Bobbit-Mcp-Operator` is an additional credential required only for approval mutations.

### Pair a browser

```http
POST /api/mcp-operator/pair
Content-Type: application/json

{
  "code": "<current terminal pairing code>"
}
```

A successful response contains an opaque `credential`. Pairing responses use `Cache-Control: no-store`. Invalid, expired, consumed, or replaced codes return `MCP_OPERATOR_PAIRING_REQUIRED`; temporary rate limiting returns `MCP_OPERATOR_PAIRING_RATE_LIMITED`; a verifier persistence failure returns `MCP_OPERATOR_PERSIST_FAILED`.

### Read status

`GET /api/mcp-servers?projectId=<view-project>&ensure=true` returns effective definitions even when they expose zero operations because they are pending, rejected, changed, or invalid. A session/goal review carries exactly one `sessionId` or `goalId` query parameter, plus its displayed `cwd` when present, through both status and decision requests; a direct Tools view omits owner scope and remains at the registered root. Each server can include:

- `approval`: whether approval is required, its state, current opaque fingerprint, and optional decision time;
- `source`: safe source ID, authority, introducing project ID/name, and logical file;
- `reviewConfig`: redacted live transport configuration for project-controlled review;
- `diagnostics`: actionable startup-trust codes independent of connection health; and
- redacted owner contribution data for grouped Marketplace runtimes.

Reading status does not require or receive the MCP operator credential.

### Submit one decision

```http
POST /api/mcp-servers/<server>/approval?projectId=<view-project>[&sessionId=<owner>&cwd=<displayed-cwd>]
Content-Type: application/json
X-Bobbit-Mcp-Operator: <paired operator credential>

{
  "decision": "approved",
  "fingerprint": "<current fingerprint>",
  "sourceProjectId": "<introducing project ID>",
  "sourceId": "<current logical source ID>"
}
```

`decision` may be `approved` or `rejected`. The server freshly validates operator capability, registered project scope, introducing source, configuration validity, and fingerprint before persisting. It then reloads active managers and validates the current winner again. A stale source or fingerprint returns HTTP 409 with `MCP_APPROVAL_STALE` and, when available, current safe server status. A pretrusted source returns HTTP 422 with `MCP_APPROVAL_NOT_REQUIRED`; an invalid definition returns HTTP 422 with `MCP_CONFIG_INVALID`.

## Troubleshooting

Do not edit, copy, or preseed private authority files to bypass review. Use **Tools → MCP** for decisions and the Marketplace UI for Marketplace installs or updates.

| State or symptom | Diagnostic | Safe recovery |
|---|---|---|
| Browser is not paired | `MCP_APPROVAL_HUMAN_REQUIRED` (HTTP 403) | Copy the current code from the gateway terminal into **Tools → MCP**. A normal cookie or bearer token cannot authorize the decision. |
| Pairing code is invalid, expired, already used, or replaced | `MCP_OPERATOR_PAIRING_REQUIRED` (HTTP 403) | Use the latest code printed by the current gateway process. Restart the gateway to print a fresh code if the terminal code expired. |
| Too many failed pairing attempts | `MCP_OPERATOR_PAIRING_RATE_LIMITED` (HTTP 429) | Wait briefly for the per-address failure window to clear, then use the current code. |
| Pairing authorization could not be saved by the gateway | `MCP_OPERATOR_PERSIST_FAILED` (HTTP 500) | Check ownership, permissions, and free space for the server secrets directory, then retry pairing. The old credential remains authoritative when replacement publication fails. |
| Browser says pairing could not be saved | Browser storage warning | The current tab can decide servers. Enable local storage or pair again after reloading; credentials are scoped by gateway base URL. |
| A formerly paired browser receives `MCP_APPROVAL_HUMAN_REQUIRED` | Approval credential was replaced, malformed, or no longer matches the gateway | Pair again with the current terminal code. Pairing another browser intentionally invalidates the old credential. |
| **Pending approval** / **Not started** | `MCP_APPROVAL_PENDING` | Open **Review servers** or **Tools → MCP**, inspect the current definition, then approve or reject that server. |
| **Rejected** / **Not started** | `MCP_APPROVAL_REJECTED` | Expand the row and choose **Approve current configuration** if it is now trusted. |
| **Configuration changed — review again** / **Not started** | `MCP_APPROVAL_CHANGED` | Review all currently displayed behavior and decide the new fingerprint. An old decision or Marketplace attestation cannot authorize changed behavior. |
| A shared runtime remains pending after one approval | Another project-controlled owner is still blocked | Refresh or expand the same row and review the newly surfaced owner. Every owner needs its own trust decision. |
| A project Marketplace server unexpectedly needs approval | Its private install attestation is missing or does not match current files | Reinstall/update through Marketplace to attest the installed definition, or deliberately decide the current project-controlled definition. Investigate unexpected on-disk changes first. |
| Invalid server definition | `MCP_CONFIG_INVALID` | Configure exactly one non-empty command or HTTP(S) URL and valid string arguments, working directory, environment, and headers. Remove case-insensitive duplicate header names. Invalid definitions cannot be approved. |
| A configuration source is omitted after JSON parsing fails | `MCP_CONFIG_PARSE_FAILED` | Correct the attributed logical file and reload the MCP view. Other valid sources continue to be discovered; logs do not include file contents. |
| Definition changed, disappeared, or changed owner during submission | `MCP_APPROVAL_STALE` (HTTP 409) | Review the safe current status returned by the server and submit a decision for its current source and fingerprint. If the source project was removed, no decision is needed. |
| Worktree review is rejected as invalid scope or outside the project | `MCP_REVIEW_SCOPE_INVALID` or `CWD_OUTSIDE_PROJECT` | Return to the owning session or goal and use its **Review servers** action. Do not retry with a hand-written `cwd`; the owner binding is the authority for an external sibling worktree. |
| An agent cannot see a server that looks approved at the project root | No operation in that session's MCP scope | Review connection/approval state from that session's worktree scope, then check **Tool calls** policy. Root and worktree managers can discover different content. |
| A displayed runtime error appears to contain secret material | Sanitization failure | Preserve only a redacted reproduction and treat it as a security defect. Status, approval responses, and Tools diagnostics must not expose configured secrets or URL credentials. |
| Decision could not be saved | `MCP_APPROVAL_PERSIST_FAILED` | Check ownership, permissions, and free space for the private `mcp-approvals` directory, then retry. The previous decision and runtime state remain unchanged. |
| Approval key is unavailable, lost, or corrupt | `MCP_APPROVAL_KEY_UNAVAILABLE` when no replacement can be created; otherwise definitions return to pending | Restore private storage access and review each pending definition again. Do not reconstruct fingerprints or ledger rows manually. |
| Bobbit cannot remove decisions that no longer match the key | `MCP_APPROVAL_LEDGER_RESET_FAILED` | Restore write/delete access to the private `mcp-approvals` directory, then make fresh per-server decisions. Unauthenticated old rows do not authorize current fingerprints. |
| Marketplace attestation ledger is corrupt | `MARKETPLACE_MCP_ATTESTATION_INVALID` in gateway logs | Repair private storage, then reinstall/update the affected project Marketplace pack. Corrupt attestations fail closed and their contents are not logged. |
| Marketplace attestation could not be published | `MARKETPLACE_MCP_ATTESTATION_PERSIST_FAILED` | Check private storage ownership, permissions, and free space, then retry the install/update. Bobbit does not report the installation as successfully pretrusted. |
| Old approvals under Headquarters state are ignored after upgrade | No private matching decision exists | This is intentional. Pair the browser and review each project server again; never copy the old repository-reachable key or ledger into private storage. |
| Private storage is inside a project after customization | `BOBBIT_SECRETS_DIR` points into a registered root or agent workspace | Move the override to an owner-controlled location outside all projects before making decisions. `BOBBIT_DIR` is not a substitute for the private secrets override. |
