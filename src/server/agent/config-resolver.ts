/**
 * Hierarchical config resolution across tiers:
 *   global (~/.bobbit/) → server (<server-cwd>/.bobbit/) → project (<project>/.bobbit/)
 *
 * Higher specificity wins. For entities, project-level overrides server-level
 * overrides global-level (full override by name, not field-level merge).
 * For scalar config, first defined value in project → server → global → default wins.
 */

export type ConfigScope = "global" | "server" | "project";

/**
 * Merge named entities across tiers. Later tiers override earlier ones by name.
 *
 * Example: a role "reviewer" at global level is overridden entirely if a
 * "reviewer" role exists at the project level. Roles that only exist at
 * global level remain available in all projects.
 */
export function resolveEntities<T extends { name: string }>(
  globalItems: T[],
  serverItems: T[],
  projectItems: T[],
): Array<T & { scope: ConfigScope }> {
  const merged = new Map<string, T & { scope: ConfigScope }>();

  for (const item of globalItems) {
    merged.set(item.name, { ...item, scope: "global" as const });
  }
  for (const item of serverItems) {
    merged.set(item.name, { ...item, scope: "server" as const });
  }
  for (const item of projectItems) {
    merged.set(item.name, { ...item, scope: "project" as const });
  }

  return [...merged.values()];
}

/** Minimal interface for a config store that can get scalar values by key. */
export interface ScalarConfigSource {
  get(key: string): string | undefined;
}

/**
 * Resolve a scalar config value (e.g. project.yaml keys like `build_command`,
 * `test_command`, default models) through the tier cascade.
 *
 * Resolution order: project → server → global → built-in default.
 */
export function resolveScalarConfig(
  key: string,
  projectConfig: ScalarConfigSource,
  serverConfig: ScalarConfigSource,
  globalConfig: ScalarConfigSource | null,
  defaults: Record<string, string>,
): { value: string; source: ConfigScope | "default" } {
  const pv = projectConfig.get(key);
  if (pv !== undefined) return { value: pv, source: "project" };

  const sv = serverConfig.get(key);
  if (sv !== undefined) return { value: sv, source: "server" };

  const gv = globalConfig?.get(key);
  if (gv !== undefined) return { value: gv, source: "global" };

  return { value: defaults[key] ?? "", source: "default" };
}

/**
 * Unified config resolution using ProjectContext-shaped objects.
 *
 * Convenience wrapper around resolveScalarConfig that extracts the
 * `projectConfigStore` from context objects.
 */
export function resolveConfig(
  key: string,
  projectContext: { projectConfigStore: ScalarConfigSource },
  serverContext?: { projectConfigStore: ScalarConfigSource },
  globalConfig?: ScalarConfigSource | null,
  defaults?: Record<string, string>,
): { value: string; source: ConfigScope | "default" } {
  return resolveScalarConfig(
    key,
    projectContext.projectConfigStore,
    serverContext?.projectConfigStore ?? { get: () => undefined },
    globalConfig ?? null,
    defaults ?? {},
  );
}
