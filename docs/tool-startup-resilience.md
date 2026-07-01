# Tool override startup resilience

Bobbit lets projects override bundled agent tools by placing tool groups under `.bobbit/config/tools/<group>/`. Those overrides are trusted project code, but they still run in the agent startup path. A broken override must not prevent agents from launching, restoring after restart, or using the bundled fallback tool.

This behavior sits between the config cascade and agent launch:

- config and bundled tool YAML are resolved with normal precedence;
- active config-level Bobbit extension files are preflighted before they are passed to the agent process;
- invalid config overrides are skipped with diagnostics;
- lower-priority bundled or market-pack tools are used when available.

The goal is resilience, not sandboxing. Project tool code remains trusted once it passes preflight.

## Archive and disable locations

Use `.bobbit/config/tools-disabled/` as the explicit archive location for disabled project tool overrides. Bobbit does not scan this directory as an active tool source, so archived groups there cannot shadow bundled tools.

Bobbit also ignores archive-style group names directly under `.bobbit/config/tools/`:

- dot-prefixed group directories, such as `.agent`;
- names ending in `.disabled`, such as `agent.disabled`;
- names containing `.disabled-`, such as `agent.disabled-20260630`;
- names containing `.disabled_`, such as `agent.disabled_backup`.

These ignore rules apply to immediate tool-group directories under `.bobbit/config/tools/`. They provide a safe rename path when temporarily disabling an override in place, but `.bobbit/config/tools-disabled/` is the clearer long-term archive location.

## Preflighted extension failures

For config-level Bobbit tool extensions, Bobbit validates the extension before building the agent launch arguments. Preflight catches failures that would otherwise crash the agent process during module import, including:

- a declared extension file that is missing;
- missing relative imports, for example `import "./missing-helper.js"`;
- bare module imports that cannot be resolved from the project or Bobbit installation;
- module-load failures, including top-level throws during import;
- module-load timeouts.

When preflight fails, Bobbit treats the config-level override as invalid for launch. The invalid extension path is not passed to the agent process.

## Fallback semantics

Valid override precedence is unchanged: a valid project override still wins over lower-priority bundled or market-pack tools.

Invalid config overrides are skipped before precedence can make them the runtime provider:

- If a lower-priority tool with the same name exists, that fallback becomes the active tool.
- If a config group contains a broken shared `extension.ts`, Bobbit avoids whole-group shadowing so bundled tools in the same group can reappear.
- If a custom config-only tool has no fallback, Bobbit omits that tool from runtime activation and reports the diagnostic instead of crashing startup.
- Valid tools in the same group can still win when they do not depend on the broken extension.

This keeps `/api/tools`, prompt tool docs, renderer/action resolution, and agent launch consistent: the Tools page shows the same effective tools that can actually be activated.

## Diagnostics

Invalid overrides are visible in two places.

Server logs emit a warning like:

```text
[tool-manager] Invalid config tool override "<tool>" in group "<group>" skipped: <reason>
```

The Tools page reads diagnostics from `/api/tools`. It shows a diagnostics panel and attaches related diagnostics to affected tools. Diagnostic rows include the skipped tool or group, source path, code, and message when available.

Diagnostics are deliberate: Bobbit should not silently ignore broken custom tools. A skipped config-only tool still has a clear diagnostic even though it has no fallback row.

## `session_prompt` restart resilience

`session_prompt` is provided by the bundled Agent tool group. The bundled `defaults/tools/agent/extension.ts` imports its gateway helper from a group-local `defaults/tools/agent/gateway.js` file. Keeping that helper inside the Agent group makes copied project overrides self-contained: editing or copying `.bobbit/config/tools/agent/` does not leave the extension depending on a missing shared helper outside the group.

Gateway credentials are read from disk first and environment variables are only a fallback. This matters after server restart or dormant-session restore because on-disk gateway URL and token files are refreshed by the gateway, while spawned-agent environment variables may be stale. The helper caches briefly, refreshes on unauthorized responses, and retries transient gateway errors so `session_prompt` can continue working across restart/restore flows.

If a project-level Agent override imports a missing helper, preflight marks that override invalid, skips it, and the bundled `session_prompt` implementation remains available.

## Related files

- [Session prompt tools](session-prompt-tools.md) covers the `session_prompt` and `team_prompt` API and authorization behavior.
- [Internals — config cascade](internals.md#config-cascade) describes normal tool precedence and project-scoped resolution.
- [Marketplace](marketplace.md) describes pack-based tool precedence and activation filtering.
