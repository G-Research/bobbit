# MCP Marketplace UX

Status: design recommendation  
Scope: Market page UX for Marketplace MCP support. This document specifies UI behavior only; it does not define backend schema beyond the client-facing shape needed for the UI.

## Existing surface to preserve

The current Market page is a compact three-tab surface in `src/app/marketplace-page.ts`:

- `Installed` — scope-grouped `market-pack-card` rows with provenance, update/uninstall actions, conflict indicators, and activation toggles.
- `Browse` — source picker context, install scope picker, pack cards with declared-entity chips and install/update/installed state.
- `Sources` — source rows plus a single add-source form and persistent source-level trust warning.

The MCP design should reuse these primitives rather than introduce a separate MCP manager inside Market:

- Containers: `market-panel`, `market-pack-card`, `market-source-row`.
- Inputs/actions: `market-input`, `market-btn`, `market-icon-btn`.
- Entity markers: `market-entity-chip`, `market-lozenge`, `market-corrupt` / warning pattern.
- Activation: `market-pack-activation-toggle`, `market-activation`, `market-activation-group`, `market-activation-toggle`, `market-toggle-switch`.
- Progressive disclosure: existing `details` / `summary` pattern for trust and entity descriptions.

## UX principles

1. **Market controls existence; Tools controls policy.** Market install/activation decides whether an MCP server or sub-namespace exists. The Tools page remains the place for `allow` / `ask` / `never` policy.
2. **Disabled MCP entries must stay visible.** Activation rows come from `GET /api/marketplace/pack-activation`, never from runtime `GET /api/mcp-servers`.
3. **Runtime status is contextual, not authoritative.** `GET /api/mcp-servers` enriches installed rows with connected/error/disconnected status only.
4. **Trust is source-level and explicit.** MCP stdio servers are trusted host-tier commands; HTTP servers are trusted remote endpoints that receive requests/headers.
5. **Same visual grammar as roles/tools/skills.** MCP appears as another pack contribution kind, not as a new page section.

## Source adding UX

### Sources tab layout

Keep the existing add-source block, but add a source-kind segmented control above the URL input:

- `Pack repo / local dir`
- `MCP registry / discovery URL`

Default: `Pack repo / local dir`, preserving current behavior.

For pack repos:

- URL placeholder: `https://github.com/acme/bobbit-packs.git or /abs/local/path`
- Ref input remains visible: `ref (branch/tag, optional)`

For MCP registries:

- URL placeholder: `https://registry.example.com/mcp/servers.json`
- Hide or disable the `ref` input with helper text: `Registry sources are synced from their discovery URL; refs apply only to git sources.`
- Primary button label remains `Add`.

Recommended test ids:

- `market-source-kind-pack`
- `market-source-kind-mcp-registry`
- Existing `market-source-url`, `market-source-ref`, `market-add-source` remain.

### Source rows

Extend `renderSourceRow` visually with a kind chip next to the source id:

- `Pack source` for git/local pack collections.
- `MCP registry` for discovery sources.
- Existing `Built-in` badge remains for the synthetic built-in source.

For MCP registry rows, secondary metadata should show:

- Discovery URL.
- Last synced time or commit-equivalent if available.
- Count summary when known: `12 MCP servers discovered`.

Click behavior is unchanged: selecting a source switches to Browse and loads its packs/virtual packs.

## Trust messaging

Update the existing `market-trust-warning` copy, not a modal:

> Only add sources you trust. Packs, MCP servers, and registry entries can run code, connect to remote services, or instruct agents on your machine.

Extend the existing `Why?` disclosure with a fourth row:

- **MCP servers** — stdio servers run trusted commands on the host; HTTP servers are trusted remote endpoints that may receive prompts, tool arguments, headers, and project-derived data depending on use.

When the source-kind control is set to `MCP registry / discovery URL`, show one inline sentence below the URL input:

> You will review and install individual servers after sync; installing a stdio server may start a host process.

Do not add a second install confirmation for every MCP card. The trust decision stays at source add, while each MCP browse card gives a readable command/endpoint preview.

## Browse UX for MCP server packs

Registry-discovered MCP servers should render as normal `market-pack-card` cards in the Browse tab. Treat each discovered server as a virtual pack until installed.

### Card content

Example card structure:

- Title: `github` or publisher-provided display name.
- Version: show if provided; otherwise omit instead of showing `v?`.
- Description: registry summary.
- Chips:
  - `mcp: github`
  - `stdio` or `HTTP`
  - Optional `registry`
- Transport preview:
  - Stdio: `Command: npx @modelcontextprotocol/server-github`
  - HTTP: `Endpoint: https://mcp.example.com/github`
- Collapsed details:
  - For stdio, show full command, args, cwd if present, and env key names only, never secret values.
  - For HTTP, show URL origin/path and header names only.

Install action uses the existing scope picker and existing button states:

- Not installed: `Install`
- Installed current: `Installed`
- Installed behind source: `Update`

Recommended chip styling:

- Add `market-entity-chip[data-kind="mcp"]` using an info/chart token, for example `--chart-4` or `--info`.
- Add small transport chips with the existing `market-lozenge` shape, not a new badge family.

Recommended test ids:

- `market-browse-pack[data-pack-name="github"]`
- `market-entity-chip[data-kind="mcp"]`
- `market-mcp-transport`
- `market-mcp-transport-details`

### Browse states

- Loading: reuse `Loading packs…`; for MCP registry sources, prefer `Loading MCP servers…` if source kind is known.
- Empty registry: `This registry did not return any installable MCP servers.`
- Registry error: use `market-error`; include server-provided message and keep the source row visible for re-sync/remove.
- Invalid entry within a registry: do not fail the whole browse list; show valid cards and a compact warning row: `3 registry entries were skipped because they were invalid.`

## Installed UX for MCP contributions

Installed MCP entries appear inside the same installed pack card as roles/tools/skills. Do not create a separate MCP-only installed list.

### Pack summary row

In `entityChips`, include MCP manifest entries:

- `mcp: github`
- `mcp: gr / ai-adoption` for sub-namespace entries when applicable.

For packs that contain only MCP contributions, the chip row should make the pack feel non-empty. Avoid the current `no declared entities` fallback when `contents.mcp` is non-empty.

### Runtime status

Fetch `GET /api/mcp-servers` when the Market page loads and after install/update/uninstall/activation changes. Merge by server name. The status display is read-only.

Status lozenge copy:

| Condition | Label | Treatment |
|---|---|---|
| enabled and runtime connected | `Connected · 12 ops` | positive/info text |
| enabled and runtime error | `Error` | negative lozenge plus expandable error text |
| enabled and absent from runtime | `Not loaded` or `Reconnecting…` while busy | warning/muted |
| disabled in Market | `Disabled` | muted; absence from runtime is expected |
| server is connected but policy blocks it | do not show as disabled | add small link/copy: `Policy in Tools` |

Important: if an MCP activation toggle is off, `GET /api/mcp-servers` should not contain that server. The UI should render `Disabled`, not `Missing`.

Recommended helper component in `marketplace-page.ts`:

- `renderMcpRuntimeStatus(mcpRef, activationChecked, runtimeByServer)`

Recommended test ids:

- `market-mcp-status-${ref}`
- `market-mcp-error-${ref}`
- `market-mcp-policy-link-${ref}`

### Activation controls

Add MCP to the existing activation grid. The group title should be:

- `MCP servers`

Toggle granularity should be server/sub-namespace meta-tools, not raw operations.

Preferred row label examples:

- Flat server: `github`
- Gateway sub-namespace: `gr / ai-adoption`
- If display metadata exists: `GitHub · github`

Each toggle should include status at the end of the pill or immediately after the label:

`[toggle] github  Connected · 12 ops`

Off state:

`[toggle off] github  Disabled`

Helper copy is optional and should be small. If used, place it under the MCP group only:

> Activation controls whether this MCP server is installed into Bobbit. Allow/ask/never policy is managed on the Tools page.

Do not show raw operation rows in Market. Operation discovery belongs in Tools and `mcp_describe`.

Recommended test ids:

- `market-toggle-mcp-${ref}`
- `market-activation-mcp-group`

### Master toggle behavior

The existing pack-level master toggle should include MCP entries in its total count. For a pack with only one MCP server:

- Enabled: master says `Enabled`.
- Disabled: master says `Disabled`.
- Mixed MCP plus other entities: master can say `Partially enabled`.

## Disable, re-enable, and reconnect behavior

### Disable

When a user turns off an MCP toggle:

1. Disable the toggle while saving.
2. Persist `DisabledRefs.mcp` via `PUT /api/marketplace/pack-activation`.
3. Refresh MCP runtime/tool registrations.
4. Keep the row visible, unchecked.
5. Show status `Disabled`.
6. Runtime `/api/mcp-servers` should no longer list the disabled server/sub-namespace.

If save or disconnect fails, keep the last confirmed checked state and show an inline `market-error` scoped to the card.

### Re-enable

When a user turns an MCP toggle back on:

1. Disable the toggle while saving.
2. Persist the updated disabled set.
3. Show `Reconnecting…` while runtime reload is in flight.
4. Replace with `Connected · N ops` or `Error`.
5. Keep the toggle checked even if runtime connects with an error; activation means the server exists, not that it is healthy.

### Uninstall

Use the existing uninstall action and destructive confirm dialog, but update copy for MCP packs:

> Uninstall "github"? This deletes the pack directory, disconnects its MCP server, and unregisters its MCP tools. Tool policy settings are not deleted.

After uninstall:

- Installed card disappears.
- Browse card returns to `Install`.
- Runtime status and external tools are removed without stale entries.

## Reload persistence

After browser reload or navigating away/back to `#/market`:

- Installed MCP packs remain in the Installed tab.
- Disabled MCP toggles remain visible and unchecked because they render from pack activation catalogue.
- Enabled MCP entries show the latest runtime status after the runtime status request completes.
- Registry sources remain in Sources.
- Browse cards still show `Installed` / `Update` relative to the selected install scope.

Do not rely on client memory for any activation state. Client memory may reset active tab to Installed, matching current Market behavior, but persisted source/install/activation state must survive.

## API shape the UI needs

The existing `PackActivationCatalogue.mcp: string[]` can support a minimal toggle list, but richer display avoids parsing identifiers in the UI. Preferred client wire shape:

```ts
interface PackActivationMcpEntry {
  ref: string;              // stable DisabledRefs.mcp key, usually contents.mcp basename
  serverName: string;       // runtime /api/mcp-servers name
  subNamespace?: string;    // optional meta-tool sub-namespace
  label?: string;
  transport?: "stdio" | "http";
  description?: string;
}
```

If the backend keeps `mcp: string[]` initially, the UI should still render functional toggles and use `descriptions.mcp[ref]` plus runtime lookup where possible.

`DisabledRefs.mcp` should remain `string[]`, keyed by `ref`, so disabled entries remain visible after runtime removal.

## Component and file recommendations

### `src/app/api.ts`

- Extend `PackManifest.contents` with optional `mcp?: string[]` on the client type.
- Extend `DisabledRefs` with `mcp?: string[]`.
- Extend `PackActivationCatalogue` with `mcp` entries. Prefer richer `PackActivationMcpEntry[]`; tolerate string arrays if the first backend pass is minimal.
- Extend `MarketplaceSource` with a source kind, for example `kind?: "pack" | "mcp-registry" | "builtin"`.
- Reuse existing `fetchMcpServers()` types or move them to shared API exports if Market imports runtime status.

### `src/app/marketplace-page.ts`

- Add source-kind state for the add-source form.
- Update `renderSourcesPanel()` to render the source-kind segmented control, MCP-specific helper text, and updated trust copy.
- Update `renderSourceRow()` to show source-kind chips and discovered MCP count when present.
- Update `entityChips()` to render MCP chips and avoid `no declared entities` for MCP-only packs.
- Add runtime status state, for example `let mcpRuntimeByName = new Map<string, McpServerInfo>();`.
- Load runtime status in `loadMarketplaceData()` and after MCP-related mutations.
- Extend activation kind mapping and toggle rendering with `mcp`.
- Add `renderMcpRuntimeStatus()` and `renderMcpTransportPreview()` helpers.
- Keep policy controls out of Market; add a small `Policy in Tools` link if useful.

### `src/app/marketplace.css`

- Add `market-entity-chip[data-kind="mcp"]`.
- Add status variants, preferably by extending `market-lozenge`: connected, error, disabled/reconnecting.
- Add source-kind segmented control styles only if existing button/input classes cannot express it.
- Add transport preview and command/details styles using muted text and existing border tokens.

### `tests/e2e/ui/marketplace-mcp.spec.ts`

Add a dedicated browser E2E covering:

1. Add MCP registry/discovery URL as a source.
2. Browse multiple discovered MCP server cards.
3. Install one into a dedicated project scope.
4. See MCP chip, activation toggle, and runtime status on Installed.
5. Disable it and assert `GET /api/mcp-servers` no longer lists it while the toggle remains visible/off.
6. Reload and assert the disabled toggle persists.
7. Re-enable and assert runtime status returns connected or error.
8. Uninstall and assert card cleanup plus Browse returns to Install.

Use project-scope isolation like `tests/e2e/ui/marketplace.spec.ts` to avoid leaking MCP installs across browser workers.

## Consistency rationale

- The design keeps MCP in the existing source → browse → install → installed lifecycle.
- MCP cards reuse `market-pack-card`, chips, provenance, update/uninstall, and activation toggles.
- Runtime status is a lozenge, matching existing non-action status indicators rather than adding a table or dashboard.
- Trust messaging extends the current source-level warning instead of adding repetitive install modals.
- Toggle granularity matches the current Tools page MCP grouping and the model-facing MCP meta-tool architecture.
