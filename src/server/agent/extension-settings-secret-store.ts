import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FsLike } from "../gateway-deps.js";
import { realFs } from "../gateway-deps.js";

/** A server-derived reference to one declared extension contribution. */
export interface ExtensionSettingsSecretTargetRef {
  packId: string;
  kind: "provider" | "hook" | "runtime";
  id: string;
}

export type ExtensionSettingsSecretChanges = Readonly<Record<string, string | undefined>>;

/** A secret update owned by the one project-scoped secret-store publication. */
export interface ExtensionSettingsSecretMutation {
  ref: ExtensionSettingsSecretTargetRef;
  changes: ExtensionSettingsSecretChanges;
}

/** An opaque, platform-owned identity shared with the public settings record. */
export type ExtensionSettingsCommitId = string;

/**
 * The secret side and public project.yaml were not published as one commit.
 * A mismatch is therefore unsafe: callers must not combine their values.
 */
export class ExtensionSettingsSecretCommitMismatchError extends Error {
  readonly code = "EXTENSION_SETTINGS_SECRET_COMMIT_MISMATCH";

  constructor() {
    super("Extension settings secret and public state do not match. Repair the project state and retry.");
    this.name = "ExtensionSettingsSecretCommitMismatchError";
  }
}

/** Deliberately redacted: callers must not learn the file path or parser error. */
export class ExtensionSettingsSecretReadError extends Error {
  readonly code = "EXTENSION_SETTINGS_SECRET_READ_FAILED";

  constructor() {
    super("Extension settings secrets could not be read. Repair the project state and retry.");
    this.name = "ExtensionSettingsSecretReadError";
  }
}

/** Deliberately redacted: callers must not learn the file path or payload. */
export class ExtensionSettingsSecretPersistenceError extends Error {
  readonly code = "EXTENSION_SETTINGS_SECRET_PERSIST_FAILED";

  constructor() {
    super("Extension settings secrets could not be saved. Check project state permissions and retry.");
    this.name = "ExtensionSettingsSecretPersistenceError";
  }
}

/** Input is normally validated against a declaration before this owner is called. */
export class ExtensionSettingsSecretValidationError extends Error {
  readonly code = "EXTENSION_SETTINGS_SECRET_INVALID";

  constructor() {
    super("Extension settings secret input is invalid.");
    this.name = "ExtensionSettingsSecretValidationError";
  }
}

const MAX_SECRET_BYTES = 16 * 1024;
const MAX_FIELD_NAME_LENGTH = 64;
const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const COMMIT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isExtensionSettingsCommitId(value: unknown): value is ExtensionSettingsCommitId {
  return typeof value === "string" && COMMIT_ID_RE.test(value);
}

function isWellFormedText(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * This key is only an object property in the single owner-only JSON file. It is
 * never used as a path, and callers cannot select the file or a directory.
 */
export function extensionSettingsSecretKey(ref: ExtensionSettingsSecretTargetRef, field: string): string {
  return `${ref.packId}\0${ref.kind}\0${ref.id}\0${field}`;
}

function isSafeTargetRef(ref: ExtensionSettingsSecretTargetRef): boolean {
  return typeof ref.packId === "string" && ref.packId.length > 0 && !ref.packId.includes("\0")
    && (ref.kind === "provider" || ref.kind === "hook" || ref.kind === "runtime")
    && typeof ref.id === "string" && ref.id.length > 0 && !ref.id.includes("\0");
}

export function validateExtensionSettingsSecretChanges(ref: ExtensionSettingsSecretTargetRef, changes: ExtensionSettingsSecretChanges): void {
  if (!isSafeTargetRef(ref) || !changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new ExtensionSettingsSecretValidationError();
  }
  for (const [field, value] of Object.entries(changes)) {
    if (field.length > MAX_FIELD_NAME_LENGTH || !FIELD_NAME_RE.test(field)) throw new ExtensionSettingsSecretValidationError();
    if (value !== undefined && (typeof value !== "string" || !isWellFormedText(value) || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES)) {
      throw new ExtensionSettingsSecretValidationError();
    }
  }
}

/**
 * Per-project owner for extension-secret bytes. There is intentionally no bulk
 * read API: a runtime can ask for one server-derived field only.
 */
export class ExtensionSettingsSecretStore {
  private data: Record<string, string> = {};
  /** Legacy flat files deliberately have no commit identity. */
  private commitId: ExtensionSettingsCommitId | undefined;
  private versioned = false;
  private unreadable = false;
  private readonly filePath: string;
  private readonly fs: FsLike;

  constructor(stateDir: string, fsImpl: FsLike = realFs) {
    this.fs = fsImpl;
    this.filePath = path.join(stateDir, "extension-settings-secrets.json");
    this.load();
  }

  private load(): void {
    this.data = {};
    this.commitId = undefined;
    this.versioned = false;
    this.unreadable = false;
    try {
      this.fs.lstatSync(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
      this.unreadable = true;
      return;
    }

    try {
      const raw = JSON.parse(this.fs.readFileSync(this.filePath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid shape");
      const record = raw as Record<string, unknown>;
      // A marker makes this a versioned envelope even when its identity is
      // corrupt. It must never be reinterpreted as a legacy complete record.
      const valuesRaw = record.schema === 1 ? record.values : raw;
      if (!valuesRaw || typeof valuesRaw !== "object" || Array.isArray(valuesRaw)) throw new Error("invalid shape");
      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(valuesRaw)) {
        if (typeof value !== "string" || !isWellFormedText(value) || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
          throw new Error("invalid value");
        }
        next[key] = value;
      }
      if (record.schema === 1) {
        this.versioned = true;
        if (isExtensionSettingsCommitId(record.commitId)) this.commitId = record.commitId;
      }
      this.data = next;
    } catch {
      // A failed read must not be mistaken for a project with no secrets.
      this.data = {};
      this.commitId = undefined;
      this.versioned = false;
      this.unreadable = true;
    }
  }

  private assertReadable(): void {
    if (this.unreadable) throw new ExtensionSettingsSecretReadError();
  }

  /**
   * Pair public and owner-only records before runtime reads. Legacy data remains
   * readable only while both sides are legacy; a partial upgrade is unsafe.
   */
  assertCommitId(publicCommitId: ExtensionSettingsCommitId | undefined): void {
    this.assertReadable();
    if (publicCommitId === undefined && !this.versioned) return;
    if (publicCommitId !== undefined && this.versioned && this.commitId === publicCommitId) return;
    throw new ExtensionSettingsSecretCommitMismatchError();
  }

  has(ref: ExtensionSettingsSecretTargetRef, field: string): boolean {
    this.assertReadable();
    validateExtensionSettingsSecretChanges(ref, { [field]: undefined });
    return Object.prototype.hasOwnProperty.call(this.data, extensionSettingsSecretKey(ref, field));
  }

  /** Runtime-only read. Do not pass this value to logs, traces, or public projections. */
  getForRuntime(ref: ExtensionSettingsSecretTargetRef, field: string): string | undefined {
    this.assertReadable();
    validateExtensionSettingsSecretChanges(ref, { [field]: undefined });
    return this.data[extensionSettingsSecretKey(ref, field)];
  }

  /**
   * Atomically replace or clear fields on one server-derived target. The public
   * settings owner supplies the shared identity; this store never mints one.
   */
  update(ref: ExtensionSettingsSecretTargetRef, changes: ExtensionSettingsSecretChanges, commitId: ExtensionSettingsCommitId): void {
    this.updateMany([{ ref, changes }], commitId);
  }

  /**
   * Atomically publish every supplied target's secret changes in one owner-only
   * envelope. Calling this with no field changes still advances the envelope,
   * binding public-only mutations to the same durable commit identity.
   */
  updateMany(mutations: readonly ExtensionSettingsSecretMutation[], commitId: ExtensionSettingsCommitId): void {
    this.assertReadable();
    if (!Array.isArray(mutations) || !isExtensionSettingsCommitId(commitId)) throw new ExtensionSettingsSecretValidationError();

    const seen = new Set<string>();
    for (const mutation of mutations) {
      if (!mutation || typeof mutation !== "object") throw new ExtensionSettingsSecretValidationError();
      validateExtensionSettingsSecretChanges(mutation.ref, mutation.changes);
      for (const field of Object.keys(mutation.changes)) {
        const key = extensionSettingsSecretKey(mutation.ref, field);
        if (seen.has(key)) throw new ExtensionSettingsSecretValidationError();
        seen.add(key);
      }
    }

    const candidate = { ...this.data };
    for (const mutation of mutations) {
      const changes = mutation.changes as ExtensionSettingsSecretChanges;
      for (const [field, value] of Object.entries(changes) as Array<[string, string | undefined]>) {
        const key = extensionSettingsSecretKey(mutation.ref, field);
        if (value === undefined) delete candidate[key];
        else candidate[key] = value;
      }
    }
    this.save(candidate, commitId);
    this.data = candidate;
    this.commitId = commitId;
    this.versioned = true;
  }

  private save(candidate: Record<string, string>, commitId: ExtensionSettingsCommitId): void {
    const dir = path.dirname(this.filePath);
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      if (!this.fs.existsSync(dir)) this.fs.mkdirSync(dir, { recursive: true });
      // The mode is assigned to the temp inode before its secret bytes are
      // written; rename atomically publishes that owner-only inode.
      this.fs.writeFileSync(temp, JSON.stringify({ schema: 1, commitId, values: candidate }) + "\n", { encoding: "utf-8", mode: 0o600 });
      this.fs.renameSync(temp, this.filePath);
    } catch {
      try { this.fs.unlinkSync(temp); } catch { /* clean only this invocation's temp */ }
      // POSIX rename may have committed despite an error. Re-read durable state
      // so a compensating public rollback cannot keep a stale in-memory pair.
      this.load();
      throw new ExtensionSettingsSecretPersistenceError();
    }
  }
}
