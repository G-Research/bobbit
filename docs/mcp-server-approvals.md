# MCP server startup approvals

Bobbit requires an explicit operator decision before it starts or connects to an MCP server introduced by a registered project's configuration. This prevents opening or registering a cloned repository from executing a local command or sending data to a remote endpoint.

Startup approval is separate from **Tool calls** policy:

- Startup approval controls whether the server process or connection may exist and whether Bobbit may initialize it or discover its operations.
- **Tool calls** (`Allow`, `Ask`, or `Never`) controls whether an agent may invoke operations after an eligible server has connected.

Changing **Tool calls** policy cannot bypass startup approval. Pending, rejected, changed, and invalid definitions are not started or contacted and register no MCP operations.

## Review a project server

When the currently relevant project has definitions to review, Bobbit shows a non-blocking banner with a **Review servers** action. The banner counts definitions in **Pending approval** or **Configuration changed — review again** state; rejected definitions remain available in the management view without keeping the banner open.

Use **Tools → MCP** to manage definitions:

1. Select the project whose MCP view you want to inspect.
2. Expand one server row. Review the introducing project and logical source file, transport, command and arguments or remote URL, working directory, environment/header names, and fingerprint.
3. Choose **Approve**, **Reject**, or, after a prior decision, **Approve current configuration**. There is intentionally no approve-all action.

The row reports startup approval independently from connection health: **Trusted**, **Pending approval**, **Approved**, **Rejected**, or **Configuration changed — review again**. A pending, rejected, or changed definition shows **Not started**, not a connection error. Rejection is reversible: expand the row and choose **Approve current configuration**. Rejecting an approved server disconnects it and removes its operations from agents.

Review data is generated from the current effective definition. Environment and header values are displayed as `[redacted]`. URL user information, query parameters, and fragments are removed. Credential-bearing command/argument values and values matching configured secrets are also redacted; ordinary command and argument text remains visible so the operator can make an informed decision.

## Which sources require approval

Bobbit classifies the source that supplied the effective definition rather than treating every MCP server alike.

| Source class | Startup trust | Why |
|---|---|---|
| A normal registered project's `.mcp.json`, `.claude/.mcp.json`, or `.bobbit/config/mcp.json` | Approval required | Repository-controlled content can change when code is cloned, checked out, or updated. |
| A custom MCP directory declared by a normal project's configuration | Approval required | The project controls the declaration, so approval is required even if the resolved directory is outside the repository. |
| The same project-controlled sources discovered through another registered project | Approval required and attributed to the introducing project | Multi-project discovery must not erase which repository introduced a process or endpoint. |
| `~/.claude.json` (including its project entries), `~/.claude/.mcp.json`, and `~/.bobbit/.mcp.json` | Pretrusted | The user explicitly manages home configuration outside the repository. |
| Headquarters/server-managed `config/mcp.json` and custom MCP directories declared by Headquarters | Pretrusted | These use the existing administrator-controlled Headquarters configuration flow. |
| Installed MCP Marketplace contributions, including MCP Gateway materializations | Pretrusted | Installation and activation are already explicit trust decisions. |

Existing project definitions are not grandfathered during upgrade. A definition without a matching Headquarters decision starts as **Pending approval**.

## Decision identity and fingerprints

A decision identifies one exact effective definition by:

- the stable registered Bobbit project ID;
- a logical source ID;
- the server name; and
- an opaque configuration fingerprint.

Standard project files use logical source slots such as `project-file:.mcp.json`; their checkout path is not part of the identity. For a project-declared custom MCP directory, Bobbit builds a canonical locator from the declaration before resolving its runtime path: it trims whitespace, normalizes separators and lexical path segments, preserves `~` form, and applies platform path-identity normalization to absolute paths. The source ID hashes that locator and includes the `.mcp.json` slot. Consequently, equivalent relative declarations such as `./mcp` and `mcp` share an identity, while a genuinely different declaration does not.

This logical identity prevents a worktree path from creating a duplicate approval. The same project ID, logical source, server name, and exact configuration can reuse a decision across the project root and its worktrees. Different content still produces a different fingerprint and requires review.

The fingerprint is an HMAC-SHA-256 digest under a random Headquarters key. Its versioned canonical input includes the derived and configured transport, command, ordered arguments, working-directory semantics, effective configured environment names and values, URL, configured header names and values, and unknown configuration fields. Object keys are sorted recursively, array order is preserved, and defaults are explicit. Therefore any execution- or connection-relevant change returns a previously decided server to **Configuration changed — review again**.

Bobbit retains decisions for exact fingerprints. Removing and later restoring the exact definition may reuse its previous decision; reverting a change may likewise recover the earlier decision. A different behavior does not inherit it.

## Headquarters persistence and secret handling

The shared store lives outside every registered repository:

- `<headquarters-dir>/state/mcp-server-approvals.json` — decision ledger
- `<headquarters-dir>/state/mcp-server-approval.key` — random HMAC key

By default, `<headquarters-dir>` is `<server-run-dir>/.bobbit/headquarters`; `BOBBIT_DIR` or the legacy `BOBBIT_PI_DIR` can relocate it.

The ledger stores only its schema, project/source/server identity, opaque fingerprint, decision, and decision timestamp. It does not store raw MCP configuration, commands, arguments, URLs, environment values, or header values. The HMAC key prevents an exposed fingerprint from being used as a direct hash for guessing configured secrets.

Decision writes use a flushed temporary file and atomic rename. If persistence fails, Bobbit leaves the prior in-memory and on-disk decision—and therefore runtime eligibility—unchanged.

The ledger and key form one trust record. If the key is missing or corrupt, Bobbit creates a new key when possible, discards decisions that can no longer be authenticated, and fails closed: project definitions return to **Pending approval**. Operators must review them again individually. If a replacement key cannot be established, fingerprints remain unavailable and the definitions stay pending.

## Multi-project scope and precedence

A project's MCP view can include definitions introduced by other registered projects. Each review row names the introducing project and logical source file. The project selected in Tools is the *view scope*; the introducing project's ID and source ID are the *decision scope*. The approval endpoint validates both scopes and the current fingerprint, so a decision cannot be applied to a same-named server from another project or to a definition that changed during review.

Discovery precedence is resolved before startup eligibility. Only the effective same-name winner is classified and shown. A higher-priority pending, rejected, changed, or invalid project definition continues to shadow a lower pretrusted definition; Bobbit does not silently start the lower server merely because the winner is unapproved. See [Internals — MCP servers](internals.md#mcp-servers) for the discovery order.

Successful decisions are persisted before Bobbit reloads affected active managers. Approval can connect the server without a gateway restart. Rejection, removal, or a fingerprint-changing edit disconnects the old runtime and removes its routes and external tools. Periodic reconciliation and scoped status refreshes catch repository edits made outside Bobbit.

## Status and approval API

`GET /api/mcp-servers?projectId=<view-project>&ensure=true` returns effective definitions even when they expose zero operations because they are pending, rejected, changed, or invalid. Each server can include:

- `approval`: whether approval is required, its state, the current opaque fingerprint, and an optional decision time;
- `source`: safe source ID, authority, introducing project ID/name, and logical file;
- `reviewConfig`: the redacted live transport configuration for review;
- `diagnostics`: actionable status codes independent of connection health.

An authenticated operator submits one current decision at a time:

```http
POST /api/mcp-servers/<server>/approval?projectId=<view-project>
Content-Type: application/json

{
  "decision": "approved",
  "fingerprint": "<current fingerprint>",
  "sourceProjectId": "<introducing project ID>",
  "sourceId": "<current logical source ID>"
}
```

`decision` may be `approved` or `rejected`. Agent bearer credentials cannot authorize this boundary; the endpoint requires the server-verified operator session. A stale source or fingerprint returns HTTP 409 with `MCP_APPROVAL_STALE` and, when available, the current safe server status. A pretrusted source returns HTTP 422 with `MCP_APPROVAL_NOT_REQUIRED`; an invalid definition returns HTTP 422 with `MCP_CONFIG_INVALID`. Pretrusted definitions return `MCP_APPROVAL_NOT_REQUIRED`, and invalid definitions return `MCP_CONFIG_INVALID`; neither can be decided through this endpoint.

## Troubleshooting

Do not edit or copy the approval ledger or key to bypass review. Use **Tools → MCP** for decisions; repair configuration or Headquarters storage only when the corresponding diagnostic identifies a problem.

| State or symptom | Diagnostic | Safe recovery |
|---|---|---|
| **Pending approval** / **Not started** | `MCP_APPROVAL_PENDING` | Open **Review servers** or **Tools → MCP**, inspect the current definition, then approve or reject that server. |
| **Rejected** / **Not started** | `MCP_APPROVAL_REJECTED` | Expand the server in **Tools → MCP** and choose **Approve current configuration** if it is now trusted. |
| **Configuration changed — review again** / **Not started** | `MCP_APPROVAL_CHANGED` | Review all currently displayed behavior and choose **Approve current configuration** or **Reject**. The old approval cannot authorize the changed definition. |
| Invalid server definition | `MCP_CONFIG_INVALID` | Correct the introducing source so it contains exactly one non-empty local command or HTTP(S) URL and valid string arguments, working directory, environment, and headers. Reload the MCP view, then review the valid definition. Invalid definitions cannot be approved. |
| A configuration file is omitted after a JSON parse error | `MCP_CONFIG_PARSE_FAILED` | Check the gateway log for the attributed logical file, correct its JSON, and reload the MCP view. Other valid sources continue to be discovered. Diagnostic text does not include file contents or secret values. |
| The definition changed or disappeared while a decision was being submitted | `MCP_APPROVAL_STALE` (HTTP 409) | Review the refreshed panel and submit a new decision for its current fingerprint. If the source project was removed, no decision is needed. |
| A decision could not be saved | `MCP_APPROVAL_PERSIST_FAILED` | Check free space and write permissions for `<headquarters-dir>/state`, then retry the per-server action. The previous decision and runtime state remain unchanged. |
| The approval key is unavailable, lost, or corrupt | `MCP_APPROVAL_KEY_UNAVAILABLE` when Bobbit cannot establish a usable key; affected servers otherwise return to `MCP_APPROVAL_PENDING` | Restore normal access to `<headquarters-dir>/state`, restart if needed, and review each pending server again. Do not reconstruct fingerprints or ledger rows manually. |
| Bobbit cannot remove a ledger whose decisions no longer match the key | `MCP_APPROVAL_LEDGER_RESET_FAILED` | Restore write/delete access to `<headquarters-dir>/state`, then make fresh per-server decisions in **Tools → MCP**. The unmatched entries do not authorize the current fingerprints. |
| Unauthenticated code attempts an approval decision | `MCP_APPROVAL_HUMAN_REQUIRED` (HTTP 403) | Make the decision from an authenticated Bobbit operator UI session. Do not grant repository code an approval credential. |
