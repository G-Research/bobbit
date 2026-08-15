import { randomUUID } from "node:crypto";
import {
  ExtensionSettingsSecretPersistenceError,
  ExtensionSettingsSecretStore,
  isExtensionSettingsCommitId,
  validateExtensionSettingsSecretChanges,
  type ExtensionSettingsSecretChanges,
  type ExtensionSettingsSecretTargetRef,
} from "./extension-settings-secret-store.js";

/** Values admitted by the flat, schema-2 extension-settings contract. */
export type ExtensionSettingValue = string | boolean | number;
export type ExtensionSettingsTargetKind = "provider" | "hook" | "runtime" | "sandboxRequirement";
/** Server-derived public settings target. Sandbox requirements intentionally have
 * no secret fields and are never passed to the secret-store as a mutation. */
export interface ExtensionSettingsTargetRef {
  packId: string;
  kind: ExtensionSettingsTargetKind;
  id: string;
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
  /** Opaque identity paired with the owner-only secret envelope. */
  commitId?: string;
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
  outcome: "updated";
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
  /** Candidate public revision that remained committed after failed compensation. */
  readonly committedRevision?: number;

  constructor(committedRevision?: number) {
    super("Extension settings are unavailable until the project configuration is repaired.");
    this.name = "ExtensionSettingsUnavailableError";
    if (typeof committedRevision === "number" && Number.isSafeInteger(committedRevision) && committedRevision >= 0) this.committedRevision = committedRevision;
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
    || (ref.kind !== "provider" && ref.kind !== "hook" && ref.kind !== "runtime" && ref.kind !== "sandboxRequirement")
    || typeof ref.id !== "string" || ref.id.length === 0 || ref.id.includes("\0")) {
    throw new ExtensionSettingsMutationError();
  }
}

function assertState(state: unknown): asserts state is ExtensionSettingsState {
  // `isPlainObject` deliberately narrows to Record<string, unknown>; capture
  // the scalar before checking it so the assertion is sound rather than
  // relying on a property access that remains `unknown` to TypeScript.
  const revision = isPlainObject(state) ? state.revision : undefined;
  const commitId = isPlainObject(state) ? state.commitId : undefined;
  if (!isPlainObject(state) || state.schema !== 1 || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0
    || (commitId !== undefined && !isExtensionSettingsCommitId(commitId)) || !isPlainObject(state.targets)) {
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
    if (!isPlainObject(mutation.secrets) || mutation.ref.kind === "sandboxRequirement") throw new ExtensionSettingsMutationError();
    // Validate all secret values before publishing the public revision. The
    // secret owner repeats this defense at its persistence boundary.
    validateExtensionSettingsSecretChanges(mutation.ref as ExtensionSettingsSecretTargetRef, mutation.secrets);
  }
}

/**
 * Project-scoped settings owner. It publishes safe YAML state first, then
 * owner-only secrets. If the latter fails, it restores the exact prior public
 * snapshot before reporting a sanitized failure.
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
    const publicState = this.getPublicState();
    // A secret-presence projection is still a pairing observation. Do not show
    // it next to public settings from a different durable commit, even when the
    // requested target has no declared secret fields.
    this.secretStore.assertCommitId(publicState.commitId);
    const storedRecord = publicState.targets[extensionSettingsTargetKey(ref)];
    const record = storedRecord ? cloneRecord(storedRecord) : undefined;
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
    for (const field of secretFields) secretSet[field] = this.secretStore.has(ref as ExtensionSettingsSecretTargetRef, field);
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
    // getEffective performs the project-wide pairing check before exposing any
    // public overlay or secret-presence metadata.
    const effective = this.getEffective(ref, defaults, options);
    const values = { ...effective.values };
    for (const field of options.secretFields ?? []) {
      const value = this.secretStore.getForRuntime(ref as ExtensionSettingsSecretTargetRef, field);
      if (value !== undefined) values[field] = value;
    }
    return values;
  }

  compareAndSwap(ref: ExtensionSettingsTargetRef, expectedRevision: number, mutation: Omit<ExtensionSettingsMutation, "ref">): ExtensionSettingsUpdateResult {
    return this.compareAndSwapMany([{ ...mutation, ref }], expectedRevision);
  }

  /**
   * Publish all safe target mutations in one ProjectConfigStore transaction.
   * The public revision changes exactly once. Secret changes follow in one
   * owner-only publication; a failed secret save restores the prior snapshot.
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
    // This is a value-free probe; a later owner-only persistence failure attempts
    // durable compensation of the already-published public candidate below.
    for (const mutation of mutations) {
      for (const field of Object.keys(mutation.secrets ?? {})) this.secretStore.has(mutation.ref as ExtensionSettingsSecretTargetRef, field);
    }

    const current = this.getPublicState();
    // Never use a follow-up mutation to launder bytes from an ambiguous or
    // mismatched secret publication into a fresh commit identity. This probe is
    // unconditional so public-only changes cannot enter compensation either.
    this.secretStore.assertCommitId(current.commitId);
    if (current.revision !== expectedRevision) throw new ExtensionSettingsRevisionConflictError();
    const candidate = cloneState(current);
    candidate.revision++;
    // Every mutation, including a public-only one, gets a fresh identity. The
    // secret store publishes an envelope even if none of its field bytes change.
    candidate.commitId = randomUUID();

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

    // The config store owns atomic YAML persistence and preserves unrelated
    // fields. Public state is deliberately published before secrets: reversing
    // this order could leave durable secret changes with no public rollback.
    this.projectConfigStore.mutate(draft => draft.setExtensionSettings(candidate));

    const secretMutations = mutations.flatMap(mutation =>
      mutation.secrets && Object.keys(mutation.secrets).length > 0
        ? [{ ref: mutation.ref as ExtensionSettingsSecretTargetRef, changes: mutation.secrets }]
        : [],
    );
    try {
      // Always publish the envelope. Otherwise a public-only endpoint change
      // would leave a stale secret identity that runtime could not safely pair.
      this.secretStore.updateMany(secretMutations, candidate.commitId);
    } catch (error) {
      // Restore the precise snapshot that was current at the successful CAS.
      // A successful rollback preserves the original revision for a retry.
      try {
        this.projectConfigStore.mutate(draft => draft.setExtensionSettings(current));
      } catch {
        // Compensation did not persist, so the candidate public revision remains
        // authoritative. Expose only that revision for metadata invalidation.
        throw new ExtensionSettingsUnavailableError(candidate.revision);
      }
      if (error instanceof ExtensionSettingsSecretPersistenceError) throw error;
      // Secret owner errors must never expose a cause or any secret bytes.
      throw new ExtensionSettingsUnavailableError();
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
