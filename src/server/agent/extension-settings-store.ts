import {
  ExtensionSettingsSecretPersistenceError,
  ExtensionSettingsSecretStore,
  validateExtensionSettingsSecretChanges,
  type ExtensionSettingsSecretChanges,
  type ExtensionSettingsSecretTargetRef,
} from "./extension-settings-secret-store.js";

/** Values admitted by the flat, schema-2 extension-settings contract. */
export type ExtensionSettingValue = string | boolean | number;
export type ExtensionSettingsTargetKind = "provider" | "hook";
export interface ExtensionSettingsTargetRef extends ExtensionSettingsSecretTargetRef {
  kind: ExtensionSettingsTargetKind;
}

/** Public per-target overlay. Secret bytes are owned by ExtensionSettingsSecretStore. */
export interface ExtensionSettingsRecord {
  enabled?: boolean;
  values: Record<string, ExtensionSettingValue>;
}

/** Native project.yaml state. Its storage schema is deliberately independent of pack schema. */
export interface ExtensionSettingsState {
  schema: 1;
  revision: number;
  targets: Record<string, ExtensionSettingsRecord>;
}

export function extensionSettingsTargetKey(ref: ExtensionSettingsTargetRef): string {
  return `${ref.packId}\0${ref.kind}\0${ref.id}`;
}

/** Minimal ProjectConfigStore surface, so this owner does not take control of YAML serialization. */
export interface ProjectExtensionSettingsConfigStore {
  getExtensionSettings(): ExtensionSettingsState;
  mutate(mutator: (draft: { setExtensionSettings(state: ExtensionSettingsState): void }) => void): void;
}

export interface ExtensionSettingsEffectiveOptions {
  /** Legacy global values are considered only while a project has no target record. */
  legacyValues?: Readonly<Record<string, ExtensionSettingValue>>;
  /** Declared secret fields: excluded from the public effective values. */
  secretFields?: readonly string[];
}

/** Redacted effective state suitable for catalogue/status projections. */
export interface EffectiveExtensionSettings {
  enabled?: boolean;
  hasProjectRecord: boolean;
  values: Record<string, ExtensionSettingValue>;
  sources: Record<string, "default" | "legacy" | "project">;
  secretSet: Record<string, boolean>;
}

export interface ExtensionSettingsMutation {
  ref: ExtensionSettingsTargetRef;
  enabled?: boolean;
  /** `undefined` clears a declared optional non-secret field. */
  values?: Readonly<Record<string, ExtensionSettingValue | undefined>>;
  /** `undefined` clears a declared secret field. Never place these values in an API projection. */
  secrets?: ExtensionSettingsSecretChanges;
}

export type ExtensionSettingsUpdateResult = {
  outcome: "updated" | "secret-persist-failed";
  revision: number;
  /** Redacted public overlay only. */
  targets: Record<string, ExtensionSettingsRecord>;
};

export class ExtensionSettingsRevisionConflictError extends Error {
  readonly code = "EXTENSION_SETTINGS_REVISION_CONFLICT";

  constructor() {
    super("Extension settings changed elsewhere. Reload and review before saving.");
    this.name = "ExtensionSettingsRevisionConflictError";
  }
}

export class ExtensionSettingsUnavailableError extends Error {
  readonly code = "EXTENSION_SETTINGS_UNAVAILABLE";

  constructor() {
    super("Extension settings are unavailable until the project configuration is repaired.");
    this.name = "ExtensionSettingsUnavailableError";
  }
}

export class ExtensionSettingsMutationError extends Error {
  readonly code = "EXTENSION_SETTINGS_INVALID";

  constructor() {
    super("Extension settings mutation is invalid.");
    this.name = "ExtensionSettingsMutationError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPrimitiveValue(value: unknown): value is ExtensionSettingValue {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

const SETTING_FIELD_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function isSafeSettingField(field: string): boolean {
  return SETTING_FIELD_RE.test(field);
}

function cloneRecord(record: ExtensionSettingsRecord): ExtensionSettingsRecord {
  // Keep unknown future public keys intact when publishing a new revision. The
  // public-state normalizer remains responsible for rejecting unsafe values.
  const copy = structuredClone(record) as ExtensionSettingsRecord;
  copy.values = { ...record.values };
  return copy;
}

function cloneState(state: ExtensionSettingsState): ExtensionSettingsState {
  // Preserve unknown future public fields in the native storage record while
  // changing only this schema's revision/targets overlay.
  const copy = structuredClone(state) as ExtensionSettingsState;
  const targets: Record<string, ExtensionSettingsRecord> = {};
  for (const [key, record] of Object.entries(state.targets)) targets[key] = cloneRecord(record);
  copy.targets = targets;
  return copy;
}

function assertRef(ref: ExtensionSettingsTargetRef): void {
  if (!ref || typeof ref.packId !== "string" || ref.packId.length === 0 || ref.packId.includes("\0")
    || (ref.kind !== "provider" && ref.kind !== "hook")
    || typeof ref.id !== "string" || ref.id.length === 0 || ref.id.includes("\0")) {
    throw new ExtensionSettingsMutationError();
  }
}

function assertState(state: unknown): asserts state is ExtensionSettingsState {
  if (!isPlainObject(state) || state.schema !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !isPlainObject(state.targets)) {
    throw new ExtensionSettingsUnavailableError();
  }
  for (const record of Object.values(state.targets)) {
    if (!isPlainObject(record) || (record.enabled !== undefined && typeof record.enabled !== "boolean") || !isPlainObject(record.values)) {
      throw new ExtensionSettingsUnavailableError();
    }
    if (!Object.values(record.values).every(isPrimitiveValue)) throw new ExtensionSettingsUnavailableError();
  }
}

function assertMutation(mutation: ExtensionSettingsMutation): void {
  assertRef(mutation.ref);
  const hasValues = mutation.values !== undefined && Object.keys(mutation.values).length > 0;
  const hasSecrets = mutation.secrets !== undefined && Object.keys(mutation.secrets).length > 0;
  if (mutation.enabled === undefined && !hasValues && !hasSecrets) throw new ExtensionSettingsMutationError();
  if (mutation.enabled !== undefined && typeof mutation.enabled !== "boolean") throw new ExtensionSettingsMutationError();
  if (mutation.values !== undefined) {
    if (!isPlainObject(mutation.values)) throw new ExtensionSettingsMutationError();
    for (const [key, value] of Object.entries(mutation.values)) {
      if (!isSafeSettingField(key) || (value !== undefined && !isPrimitiveValue(value))) throw new ExtensionSettingsMutationError();
    }
  }
  if (mutation.secrets !== undefined) {
    if (!isPlainObject(mutation.secrets)) throw new ExtensionSettingsMutationError();
    // Validate all secret values before publishing the public revision. The
    // secret owner repeats this defense at its persistence boundary.
    validateExtensionSettingsSecretChanges(mutation.ref, mutation.secrets);
  }
}

/**
 * Project-scoped settings owner. It publishes safe YAML state first, then
 * owner-only secrets. A failed second phase deliberately reports partial
 * publication rather than claiming a secret was stored.
 */
export class ExtensionSettingsStore {
  constructor(
    private readonly projectConfigStore: ProjectExtensionSettingsConfigStore,
    private readonly secretStore: ExtensionSettingsSecretStore,
  ) {}

  /** Defensive, value-free-from-secrets public state. */
  getPublicState(): ExtensionSettingsState {
    const state = this.projectConfigStore.getExtensionSettings();
    assertState(state);
    return cloneState(state);
  }

  hasTargetRecord(ref: ExtensionSettingsTargetRef): boolean {
    assertRef(ref);
    return Object.prototype.hasOwnProperty.call(this.getPublicState().targets, extensionSettingsTargetKey(ref));
  }

  /** A defensive public overlay. This must never be used to retrieve a secret. */
  getTarget(ref: ExtensionSettingsTargetRef): ExtensionSettingsRecord | undefined {
    assertRef(ref);
    const record = this.getPublicState().targets[extensionSettingsTargetKey(ref)];
    return record ? cloneRecord(record) : undefined;
  }

  /**
   * Computes a safe public projection. Legacy data is intentionally considered
   * only before the project creates its first target row.
   */
  getEffective(
    ref: ExtensionSettingsTargetRef,
    defaults: Readonly<Record<string, ExtensionSettingValue>>,
    options: ExtensionSettingsEffectiveOptions = {},
  ): EffectiveExtensionSettings {
    assertRef(ref);
    const record = this.getTarget(ref);
    const hasProjectRecord = record !== undefined;
    const secretFields = new Set(options.secretFields ?? []);
    const values: Record<string, ExtensionSettingValue> = Object.create(null) as Record<string, ExtensionSettingValue>;
    const sources: EffectiveExtensionSettings["sources"] = Object.create(null) as EffectiveExtensionSettings["sources"];

    for (const [key, value] of Object.entries(defaults)) {
      if (!isSafeSettingField(key) || !isPrimitiveValue(value) || secretFields.has(key)) continue;
      values[key] = value;
      sources[key] = "default";
    }
    if (!hasProjectRecord) {
      for (const [key, value] of Object.entries(options.legacyValues ?? {})) {
        if (!isSafeSettingField(key) || !isPrimitiveValue(value) || secretFields.has(key)) continue;
        values[key] = value;
        sources[key] = "legacy";
      }
    }
    for (const [key, value] of Object.entries(record?.values ?? {})) {
      if (!isSafeSettingField(key) || secretFields.has(key)) continue;
      values[key] = value;
      sources[key] = "project";
    }

    const secretSet: Record<string, boolean> = {};
    for (const field of secretFields) secretSet[field] = this.secretStore.has(ref, field);
    return { ...(record?.enabled !== undefined ? { enabled: record.enabled } : {}), hasProjectRecord, values, sources, secretSet };
  }

  /**
   * Runtime-only effective configuration. The result can contain secret bytes;
   * callers must treat it as secret-bearing and never use it for diagnostics or
   * a public response. A secret-store read error intentionally fails closed.
   */
  getForRuntime(
    ref: ExtensionSettingsTargetRef,
    defaults: Readonly<Record<string, ExtensionSettingValue>>,
    options: ExtensionSettingsEffectiveOptions = {},
  ): Record<string, ExtensionSettingValue> {
    const effective = this.getEffective(ref, defaults, options);
    const values = { ...effective.values };
    for (const field of options.secretFields ?? []) {
      const value = this.secretStore.getForRuntime(ref, field);
      if (value !== undefined) values[field] = value;
    }
    return values;
  }

  compareAndSwap(ref: ExtensionSettingsTargetRef, expectedRevision: number, mutation: Omit<ExtensionSettingsMutation, "ref">): ExtensionSettingsUpdateResult {
    return this.compareAndSwapMany([{ ...mutation, ref }], expectedRevision);
  }

  /**
   * Publish all safe target mutations in one ProjectConfigStore transaction.
   * The public revision changes exactly once. Secret writes follow afterwards;
   * callers receive a redacted partial result when that second phase fails.
   */
  compareAndSwapMany(mutations: readonly ExtensionSettingsMutation[], expectedRevision: number): ExtensionSettingsUpdateResult {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || mutations.length === 0) throw new ExtensionSettingsMutationError();
    for (const mutation of mutations) assertMutation(mutation);

    const seen = new Set<string>();
    for (const mutation of mutations) {
      const key = extensionSettingsTargetKey(mutation.ref);
      if (seen.has(key)) throw new ExtensionSettingsMutationError();
      seen.add(key);
    }

    // Fail before public publication when the owner-only state cannot be read.
    // This is a value-free probe; a later filesystem persistence failure is the
    // intentional partial-publication path below.
    for (const mutation of mutations) {
      for (const field of Object.keys(mutation.secrets ?? {})) this.secretStore.has(mutation.ref, field);
    }

    const current = this.getPublicState();
    if (current.revision !== expectedRevision) throw new ExtensionSettingsRevisionConflictError();
    const candidate = cloneState(current);
    candidate.revision++;

    for (const mutation of mutations) {
      const key = extensionSettingsTargetKey(mutation.ref);
      const next = cloneRecord(candidate.targets[key] ?? { values: {} });
      if (mutation.enabled !== undefined) next.enabled = mutation.enabled;
      for (const [field, value] of Object.entries(mutation.values ?? {})) {
        if (value === undefined) delete next.values[field];
        else next.values[field] = value;
      }
      candidate.targets[key] = next;
    }

    // All shape validation happens before public publication. The config store
    // owns atomic YAML persistence and preserves its unrelated fields.
    this.projectConfigStore.mutate(draft => draft.setExtensionSettings(candidate));

    try {
      for (const mutation of mutations) {
        if (mutation.secrets && Object.keys(mutation.secrets).length > 0) {
          this.secretStore.update(mutation.ref, mutation.secrets);
        }
      }
    } catch (error) {
      if (error instanceof ExtensionSettingsSecretPersistenceError) {
        return { outcome: "secret-persist-failed", revision: candidate.revision, targets: this.redactedTargets(candidate, mutations) };
      }
      throw error;
    }

    return { outcome: "updated", revision: candidate.revision, targets: this.redactedTargets(candidate, mutations) };
  }

  private redactedTargets(state: ExtensionSettingsState, mutations: readonly ExtensionSettingsMutation[]): Record<string, ExtensionSettingsRecord> {
    const targets: Record<string, ExtensionSettingsRecord> = {};
    for (const mutation of mutations) {
      const key = extensionSettingsTargetKey(mutation.ref);
      const record = state.targets[key];
      if (record) targets[key] = cloneRecord(record);
    }
    return targets;
  }
}
