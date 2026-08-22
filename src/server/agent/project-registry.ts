import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_PROJECT_COLOR_DARK,
  DEFAULT_PROJECT_COLOR_LIGHT,
  PALETTE_PRIMARY_COLORS,
} from "../../shared/palette-colors.js";
import { getProjectRoot, headquartersDir } from "../bobbit-dir.js";
import { runPreflight, type PreflightReport } from "./project-preflight.js";

export type ProjectKind = "normal" | "headquarters" | "system";

export interface RegisteredProject {
  id: string;           // UUID or stable built-in project id
  name: string;         // Display name
  rootPath: string;     // Absolute path to project directory
  createdAt: number;    // Epoch ms
  kind?: ProjectKind;   // Special project discriminator; absent means normal for legacy records
  color?: string;       // Deprecated — kept for backward compat
  palette?: string;     // One of 10 palette IDs or undefined
  colorLight: string;   // Accent color for light mode (always present)
  colorDark: string;    // Accent color for dark mode (always present)
  position?: number;    // User-controlled normal-project ordering; hidden/system/HQ projects do not participate
  provisional?: boolean; // True while a project assistant is setting up this project
  /**
   * True for synthetic projects that should be filtered out of UI listings
   * but still resolvable by id (e.g. the "system" project used as the
   * persistence anchor for system-scope tool-assistant sessions). Hidden
   * projects must never appear in /api/projects responses.
   */
  hidden?: boolean;
  /**
   * Optional parent project id for hierarchical role/field inheritance.
   * When set, ConfigCascade walks the ancestor chain when resolving
   * role `model`/`thinkingLevel`/`promptTemplate` fields. Cycles and
   * references to hidden/provisional/non-existent projects are rejected
   * by `update()`.
   */
  parentProjectId?: string;
}

/** Stable id for the synthetic system project. */
export const SYSTEM_PROJECT_ID = "system";
/** Stable id for the user-facing server workspace alias. */
export const HEADQUARTERS_PROJECT_ID = "headquarters";
/** Server-owned display name for the Headquarters project. */
export const HEADQUARTERS_PROJECT_NAME = "Headquarters";

export function isHeadquartersProject(project: Pick<RegisteredProject, "id" | "kind"> | string | undefined | null): boolean {
  if (!project) return false;
  if (typeof project === "string") return project === HEADQUARTERS_PROJECT_ID;
  return project.id === HEADQUARTERS_PROJECT_ID || project.kind === "headquarters";
}

export function isSystemProject(project: Pick<RegisteredProject, "id" | "kind"> | string | undefined | null): boolean {
  if (!project) return false;
  if (typeof project === "string") return project === SYSTEM_PROJECT_ID;
  return project.id === SYSTEM_PROJECT_ID || project.kind === "system";
}

export type SpecialProjectMutationErrorCode =
  | "HEADQUARTERS_IMMUTABLE"
  | "SYSTEM_PROJECT_IMMUTABLE"
  | "HIDDEN_PROJECT_IMMUTABLE";

export class SpecialProjectMutationError extends Error {
  readonly status = 403;
  constructor(
    public readonly code: SpecialProjectMutationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SpecialProjectMutationError";
  }
}

export function assertNormalMutableProject(project: RegisteredProject, action: string): void {
  if (isHeadquartersProject(project)) {
    const message = action === "removed"
      ? "Headquarters cannot be removed. Hide it from project lists in Settings instead."
      : `Headquarters is managed by the server and cannot be ${action}. Hide it from project lists in Settings instead.`;
    throw new SpecialProjectMutationError("HEADQUARTERS_IMMUTABLE", message);
  }
  if (isSystemProject(project)) {
    throw new SpecialProjectMutationError("SYSTEM_PROJECT_IMMUTABLE", `The system project is managed by the server and cannot be ${action}.`);
  }
  if (project.hidden) {
    throw new SpecialProjectMutationError("HIDDEN_PROJECT_IMMUTABLE", `Hidden projects are managed by the server and cannot be ${action}.`);
  }
}

export type ProjectOrderErrorCode = "invalid_project_order" | "stale_project_order";

export class ProjectOrderError extends Error {
  constructor(
    public readonly code: ProjectOrderErrorCode,
    message: string,
    public readonly details: { expectedProjectIds?: string[]; receivedProjectIds?: string[] } = {},
  ) {
    super(message);
    this.name = "ProjectOrderError";
  }
}

/**
 * Detect whether `rootPath` resolves through a symlink to a different
 * absolute path. Best-effort — EPERM/ENOENT are swallowed and treated as
 * non-symlink.
 */
export function detectSymlinkRoot(
  rootPath: string,
): { symlink: false } | { symlink: true; canonical: string } {
  try {
    const real = fs.realpathSync(rootPath);
    const a = path.resolve(rootPath);
    const b = path.resolve(real);
    if (a !== b) return { symlink: true, canonical: b };
  } catch {
    /* best-effort */
  }
  return { symlink: false };
}

type ProjectPathApi = typeof path.posix;
type PathIdentityStat = Pick<fs.Stats, "dev" | "ino"> & Partial<Pick<fs.Stats, "isDirectory">>;

function isWindowsProjectPath(rootPath: string): boolean {
  // Use the input dialect rather than the host OS so persisted projects can be
  // compared deterministically in cross-platform tests and migrations. On
  // POSIX, though, a double-forward-slash path is still a native absolute path
  // (`//tmp/project` and `/tmp/project` identify the same directory), not a
  // Windows UNC path. Explicit backslash UNC paths remain portable fixtures.
  return /^[a-z]:[\\/]/i.test(rootPath)
    || rootPath.startsWith("\\\\")
    || (process.platform === "win32" && rootPath.startsWith("//"));
}

function projectPathApi(rootPath: string): ProjectPathApi {
  return isWindowsProjectPath(rootPath) ? path.win32 : path.posix;
}

function isNativeProjectPathApi(pathApi: ProjectPathApi): boolean {
  return process.platform === "win32" ? pathApi === path.win32 : pathApi === path.posix;
}

function projectPathFlavor(pathApi: ProjectPathApi): "posix" | "win32" {
  return pathApi === path.win32 ? "win32" : "posix";
}

function normalizeProjectPath(
  value: string,
  pathApi: ProjectPathApi,
  options: { foldCase?: boolean } = {},
): string {
  const resolved = pathApi.resolve(value);
  const root = pathApi.parse(resolved).root;
  const isRoot = pathApi.normalize(resolved) === pathApi.normalize(root);
  const normalized = (isRoot ? root : resolved.replace(/[\\/]+$/, "")).replace(/\\/g, "/");
  // Drive letters and UNC authorities are root syntax rather than directory
  // entries. Their spelling is stable across Windows implementations, while
  // every descendant remains case-preserving until this volume proves an alias.
  const normalizedRoot = root.replace(/\\/g, "/");
  const rooted = pathApi === path.win32
    ? `${normalizedRoot.toLowerCase()}${normalized.slice(normalizedRoot.length)}`
    : normalized;
  return options.foldCase ? rooted.toLowerCase() : rooted;
}

export interface ProjectPathIdentityOptions {
  /** Read-only seams for path-identity tests and unusual filesystems. */
  realpathSync?: (candidate: string) => string;
  lstatSync?: (candidate: string) => PathIdentityStat;
  /** Overrides the native classifier for tests and unusual filesystems. */
  isCaseInsensitiveAt?: (existingAncestor: string) => boolean | undefined;
  /** Create and remove a unique, caller-owned case probe below `parent`. */
  createCaseProbe?: (parent: string, pathApi: "posix" | "win32") => string;
  removeCaseProbe?: (probePath: string) => void;
  /** Read at most `limit` directory names for non-mutating case evidence. */
  readDirectoryEntries?: (parent: string, limit: number) => readonly string[];
  /** Cache directory entry case semantics, invalidated by this fingerprint. */
  caseSemanticsCache?: Map<string, CaseSemanticsCacheRecord>;
  caseSemanticsFingerprint?: (existingAncestor: string) => string | undefined;
  /** Lets tests model native Windows/POSIX volumes on another host. */
  isNativePathApi?: (pathApi: "posix" | "win32") => boolean;
}

type CaseSemantics = "insensitive" | "sensitive" | "unknown";

/** Bound read-only evidence so identity lookups never scan a large directory. */
export const CASE_EVIDENCE_ENTRY_LIMIT = 8;

export interface CaseSemanticsCacheRecord {
  fingerprint: string;
  directoryIdentity: string;
  semantics: Exclude<CaseSemantics, "unknown">;
}

function nativeCaseSemanticsFingerprint(existingAncestor: string): string | undefined {
  try {
    const stat = fs.statSync(existingAncestor);
    if (stat.dev === 0 || stat.ino === 0) return undefined;
    return [stat.dev, stat.ino, stat.mode, stat.mtimeMs, stat.ctimeMs].join(":");
  } catch {
    return undefined;
  }
}

function toggledCase(value: string): string | undefined {
  const match = /[a-zA-Z]/.exec(value);
  if (!match || match.index === undefined) return undefined;
  const index = match.index;
  const char = value[index];
  const toggled = char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase();
  return `${value.slice(0, index)}${toggled}${value.slice(index + 1)}`;
}

function isExpectedMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Compare the requested entry with one case-variant spelling. `lstat` gives a
 * bounded authoritative answer even where realpath preserves input casing
 * (APFS). Equal inode pairs only prove a directory-wide alias when both are
 * directories: files can be hard-linked under case-varied names on a
 * case-sensitive filesystem.
 */
function classifyKnownEntry(
  parent: string,
  entry: string,
  pathApi: ProjectPathApi,
  realpathSync: (candidate: string) => string,
  lstatSync: (candidate: string) => PathIdentityStat,
): CaseSemantics {
  const variant = toggledCase(entry);
  if (!variant) return "unknown";
  const target = pathApi.join(parent, entry);
  const alternate = pathApi.join(parent, variant);
  try {
    realpathSync(alternate);
  } catch (error) {
    return isExpectedMissingPath(error) ? "sensitive" : "unknown";
  }
  try {
    const a = lstatSync(target);
    const b = lstatSync(alternate);
    // Zero device/inode values are not a stable identity (some network
    // filesystems expose them), so retain spelling rather than claiming an
    // alias. Unequal entries are safely case-sensitive; equal non-directories
    // are inconclusive because they may be hard links.
    if (a.dev === 0 || a.ino === 0 || b.dev === 0 || b.ino === 0) return "unknown";
    if (a.dev !== b.dev || a.ino !== b.ino) return "sensitive";
    return a.isDirectory?.() && b.isDirectory?.() ? "insensitive" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Read a fixed number of names without materializing the whole directory.
 * This is the read-only fallback when an owned probe cannot be created.
 */
function readLimitedDirectoryEntries(parent: string, limit: number): string[] {
  const directory = fs.opendirSync(parent);
  const entries: string[] = [];
  try {
    while (entries.length < limit) {
      const entry = directory.readSync();
      if (!entry) break;
      entries.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return entries;
}

/**
 * A bounded directory sample can prove its containing directory's behavior
 * without mutation. Each usable spelling is verified by alternate lookup and
 * exact entry identity, so a case-paired NTFS entry remains sensitive.
 */
function readOnlyCaseSemantics(
  parent: string,
  pathApi: ProjectPathApi,
  realpathSync: (candidate: string) => string,
  lstatSync: (candidate: string) => PathIdentityStat,
  readDirectoryEntries: (parent: string, limit: number) => readonly string[],
): CaseSemantics {
  let entries: readonly string[];
  try {
    entries = readDirectoryEntries(parent, CASE_EVIDENCE_ENTRY_LIMIT);
  } catch {
    return "unknown";
  }
  for (const entry of entries.slice(0, CASE_EVIDENCE_ENTRY_LIMIT)) {
    const semantics = classifyKnownEntry(parent, entry, pathApi, realpathSync, lstatSync);
    if (semantics !== "unknown") return semantics;
  }
  return "unknown";
}

function directoryIdentity(
  directory: string,
  lstatSync: (candidate: string) => PathIdentityStat,
): string | undefined {
  try {
    const stat = lstatSync(directory);
    return stat.dev === 0 || stat.ino === 0 ? undefined : `${stat.dev}:${stat.ino}`;
  } catch {
    return undefined;
  }
}

/** Classify an empty or otherwise inconclusive directory with one owned probe. */
function probeCaseSemantics(
  parent: string,
  pathApi: ProjectPathApi,
  realpathSync: (candidate: string) => string,
  lstatSync: (candidate: string) => PathIdentityStat,
  createCaseProbe?: (parent: string, pathApi: "posix" | "win32") => string,
  removeCaseProbe?: (probePath: string) => void,
): CaseSemantics {
  let probe: string | undefined;
  let result: CaseSemantics = "unknown";
  try {
    probe = createCaseProbe?.(parent, projectPathFlavor(pathApi))
      ?? fs.mkdtempSync(pathApi.join(parent, ".bobbit-case-probe-"));
    result = classifyKnownEntry(pathApi.dirname(probe), pathApi.basename(probe), pathApi, realpathSync, lstatSync);
  } catch {
    // Keep the conservative spelling-preserving result.
  } finally {
    if (probe) {
      try {
        if (removeCaseProbe) removeCaseProbe(probe);
        else fs.rmSync(probe, { recursive: true, force: true });
      } catch {
        // A failed cleanup means this run cannot publish probe evidence.
        result = "unknown";
      }
    }
  }
  return result;
}

/**
 * Determine a directory's case behavior in constant filesystem work. Only
 * stable, non-mutating evidence is cached with its observed fingerprint.
 */
function hasCaseInsensitiveEntries(
  parent: string,
  entry: string | undefined,
  pathApi: ProjectPathApi,
  realpathSync: (candidate: string) => string,
  lstatSync: (candidate: string) => PathIdentityStat,
  isCaseInsensitiveAt?: (existingAncestor: string) => boolean | undefined,
  createCaseProbe?: (parent: string, pathApi: "posix" | "win32") => string,
  removeCaseProbe?: (probePath: string) => void,
  readDirectoryEntries?: (parent: string, limit: number) => readonly string[],
  cache?: Map<string, CaseSemanticsCacheRecord>,
  fingerprint?: (existingAncestor: string) => string | undefined,
): boolean {
  const override = isCaseInsensitiveAt?.(parent);
  if (override !== undefined) return override;
  const cacheKey = `${projectPathFlavor(pathApi)}:${pathApi.resolve(parent)}`;
  const fingerprintFor = fingerprint ?? nativeCaseSemanticsFingerprint;

  const beforeIdentity = directoryIdentity(parent, lstatSync);
  const before = fingerprintFor(parent);
  const cached = before && beforeIdentity ? cache?.get(cacheKey) : undefined;
  if (cached && cached.fingerprint === before && cached.directoryIdentity === beforeIdentity) {
    return cached.semantics === "insensitive";
  }

  const known = entry
    ? classifyKnownEntry(parent, entry, pathApi, realpathSync, lstatSync)
    : readOnlyCaseSemantics(
      parent, pathApi, realpathSync, lstatSync,
      readDirectoryEntries ?? readLimitedDirectoryEntries,
    );
  if (known === "unknown") {
    // A probe mutates its parent, so the metadata fingerprint cannot show
    // continuity. The current lookup can still use its result when the
    // parent dev+ino identity is stable across the probe; never cache it.
    const semantics = probeCaseSemantics(parent, pathApi, realpathSync, lstatSync, createCaseProbe, removeCaseProbe);
    const afterProbeIdentity = directoryIdentity(parent, lstatSync);
    return beforeIdentity !== undefined
      && beforeIdentity === afterProbeIdentity
      && semantics === "insensitive";
  }

  // A stable nonzero dev/ino keeps conclusive read-only evidence valid for this
  // lookup even when sibling churn changes directory metadata. Publishing that
  // evidence to the cache remains stricter: it requires the full fingerprint
  // to be present and unchanged. A replacement or failed stat stays conservative.
  const after = fingerprintFor(parent);
  const afterIdentity = directoryIdentity(parent, lstatSync);
  if (before && after && beforeIdentity && beforeIdentity === afterIdentity) {
    if (before === after) {
      cache?.set(cacheKey, { fingerprint: before, directoryIdentity: beforeIdentity, semantics: known });
    }
    return known === "insensitive";
  }
  return false;
}

/**
 * Fold each component only when its parent proves that the component has a
 * case alias. This preserves case-sensitive NTFS descendants and APFS aliases.
 */
function normalizeExistingPathCase(
  canonical: string,
  pathApi: ProjectPathApi,
  realpathSync: (candidate: string) => string,
  lstatSync: (candidate: string) => PathIdentityStat,
  options: ProjectPathIdentityOptions,
): string {
  const root = pathApi.parse(canonical).root;
  const segments = pathApi.relative(root, canonical).split(/[\\/]+/).filter(Boolean);
  let parent = root;
  const normalized: string[] = [];

  for (const segment of segments) {
    const insensitive = hasCaseInsensitiveEntries(
      parent, segment, pathApi, realpathSync, lstatSync, options.isCaseInsensitiveAt,
      options.createCaseProbe, options.removeCaseProbe, options.readDirectoryEntries,
      options.caseSemanticsCache, options.caseSemanticsFingerprint,
    );
    normalized.push(insensitive ? segment.toLowerCase() : segment);
    parent = pathApi.join(parent, segment);
  }
  const foldRoot = options.isCaseInsensitiveAt?.(root) === true;
  return normalizeProjectPath(pathApi.join(foldRoot ? root.toLowerCase() : root, ...normalized), pathApi, { foldCase: false });
}

/**
 * Canonical project identity. Existing prefixes are realpath-resolved; spelling
 * folds only with bounded, per-directory proof of an actual case alias.
 */
export function canonicalProjectPath(
  rootPath: string,
  options: ProjectPathIdentityOptions = {},
): string {
  const pathApi = projectPathApi(rootPath);
  const resolved = pathApi.resolve(rootPath);
  const nativePathApi = options.isNativePathApi?.(projectPathFlavor(pathApi)) ?? isNativeProjectPathApi(pathApi);
  if (!nativePathApi) return normalizeProjectPath(resolved, pathApi, { foldCase: false });

  const realpathSync = options.realpathSync ?? (candidate => fs.realpathSync(candidate));
  const lstatSync = options.lstatSync ?? (candidate => fs.lstatSync(candidate));
  let existing = resolved;
  const suffix: string[] = [];
  while (true) {
    try {
      const canonical = pathApi.resolve(realpathSync(existing));
      const insensitive = suffix.length > 0 && hasCaseInsensitiveEntries(
        canonical, undefined, pathApi, realpathSync, lstatSync, options.isCaseInsensitiveAt,
        options.createCaseProbe, options.removeCaseProbe, options.readDirectoryEntries,
        options.caseSemanticsCache, options.caseSemanticsFingerprint,
      );
      const normalizedSuffix = [...suffix].reverse().map(segment => insensitive ? segment.toLowerCase() : segment);
      const normalizedCanonical = normalizeExistingPathCase(canonical, pathApi, realpathSync, lstatSync, options);
      return normalizeProjectPath(pathApi.join(normalizedCanonical, ...normalizedSuffix), pathApi, { foldCase: false });
    } catch {
      const parent = pathApi.dirname(existing);
      if (parent === existing) return normalizeProjectPath(resolved, pathApi, { foldCase: false });
      suffix.push(pathApi.basename(existing));
      existing = parent;
    }
  }
}

export type ProjectPathIdentity = (rootPath: string) => string;

export function createProjectPathIdentity(options: ProjectPathIdentityOptions = {}): ProjectPathIdentity {
  const caseSemanticsCache = options.caseSemanticsCache ?? new Map<string, CaseSemanticsCacheRecord>();
  return rootPath => canonicalProjectPath(rootPath, { ...options, caseSemanticsCache });
}

/**
 * Thrown by `register()` (and friends) when the supplied rootPath is a
 * symlink to a different canonical path and the caller has not opted in via
 * `acceptCanonical`. The REST surface translates this into a structured 400
 * carrying both paths so the UI can prompt the user.
 */
/**
 * Thrown when a server-side preflight pass surfaces any `fail` check. The
 * REST surface translates this into a 400 carrying the full report.
 */
export class PreflightFailedError extends Error {
  readonly code = "preflight_failed";
  constructor(
    public readonly rootPath: string,
    public readonly report: PreflightReport,
    failingSummary: string,
  ) {
    super(`Project preflight failed for ${rootPath}: ${failingSummary}`);
    this.name = "PreflightFailedError";
  }
}

export class SymlinkProjectRootError extends Error {
  readonly code = "symlink_root";
  constructor(public readonly rootPath: string, public readonly canonical: string) {
    super(
      `rootPath ${rootPath} is a symlink to ${canonical}; pass acceptCanonical to register the canonical path.`,
    );
    this.name = "SymlinkProjectRootError";
  }
}

export class ProjectRegistry {
  private projects = new Map<string, RegisteredProject>();
  private readonly storePath: string;
  private readonly pathIdentity: ProjectPathIdentity;

  constructor(stateDir: string, options: { pathIdentity?: ProjectPathIdentity } = {}) {
    this.storePath = path.join(stateDir, "projects.json");
    this.pathIdentity = options.pathIdentity ?? createProjectPathIdentity();
    this.load();
  }

  private sameProjectPath(a: string, b: string): boolean {
    return this.pathIdentity(a) === this.pathIdentity(b);
  }

  private isVisibleListProject(project: RegisteredProject): boolean {
    return !project.hidden && !isSystemProject(project);
  }

  private participatesInVisibleOrder(project: RegisteredProject): boolean {
    // Headquarters is a first-class, user-reorderable project like any other
    // visible project; only hidden/system anchors are excluded.
    return this.isVisibleListProject(project);
  }

  private listSortCategory(project: RegisteredProject): number {
    if (this.participatesInVisibleOrder(project)) return 1;
    return 2;
  }

  private positionSortValue(project: RegisteredProject): number {
    return Number.isFinite(project.position) ? project.position! : Number.POSITIVE_INFINITY;
  }

  private compareVisibleOrderEntries(
    a: { project: RegisteredProject; index: number },
    b: { project: RegisteredProject; index: number },
  ): number {
    const posA = this.positionSortValue(a.project);
    const posB = this.positionSortValue(b.project);
    if (posA !== posB) return posA - posB;
    if (a.project.createdAt !== b.project.createdAt) return a.project.createdAt - b.project.createdAt;
    return a.index - b.index;
  }

  private normalizeVisiblePositions(): boolean {
    const entries = [...this.projects.values()].map((project, index) => ({ project, index }));
    let changed = false;

    for (const { project } of entries) {
      if (!this.participatesInVisibleOrder(project) && project.position !== undefined) {
        delete project.position;
        changed = true;
      }
    }

    const visible = entries
      .filter(entry => this.participatesInVisibleOrder(entry.project))
      .sort((a, b) => this.compareVisibleOrderEntries(a, b));

    for (let i = 0; i < visible.length; i++) {
      const project = visible[i].project;
      if (project.position !== i) {
        project.position = i;
        changed = true;
      }
    }

    return changed;
  }

  private nextVisiblePosition(): number {
    this.normalizeVisiblePositions();
    const positions = [...this.projects.values()]
      .filter(project => this.participatesInVisibleOrder(project))
      .map(project => project.position)
      .filter((position): position is number => Number.isFinite(position));
    return positions.length > 0 ? Math.max(...positions) + 1 : 0;
  }

  /**
   * Guard: throw if another registered project already occupies `rootPath`
   * (compared by canonical path), excluding `opts.excludeId`.
   *
   * Duplicate normal/provisional projects at the same canonical path are
   * always rejected, and the physical Headquarters directory is always
   * immutable. `opts.allowSpecialAnchors` controls hidden/system anchors:
   *
   * - `register()` passes `true` so the synthetic `system` anchor and other
   *   hidden synthetic projects do not block registering a normal project
   *   sharing their path (e.g. the server run directory).
   * - `update()` passes `false` so a normal project can never be repointed
   *   onto Headquarters, the system anchor, or any hidden/special workspace.
   */
  private assertRootPathAvailable(
    rootPath: string,
    opts: { excludeId?: string; allowSpecialAnchors: boolean },
  ): void {
    for (const existing of this.projects.values()) {
      if (opts.excludeId !== undefined && existing.id === opts.excludeId) continue;
      if (!this.sameProjectPath(existing.rootPath, rootPath)) continue;
      if (isHeadquartersProject(existing)) {
        throw new SpecialProjectMutationError(
          "HEADQUARTERS_IMMUTABLE",
          `Headquarters owns ${rootPath}; choose the server run directory instead of the Headquarters directory.`,
        );
      }
      if (isSystemProject(existing)) {
        if (opts.allowSpecialAnchors) continue;
        throw new SpecialProjectMutationError(
          "SYSTEM_PROJECT_IMMUTABLE",
          `The system workspace owns ${rootPath}; choose a different directory.`,
        );
      }
      if (existing.hidden) {
        if (opts.allowSpecialAnchors) continue;
        throw new SpecialProjectMutationError(
          "HIDDEN_PROJECT_IMMUTABLE",
          `A server-managed workspace owns ${rootPath}; choose a different directory.`,
        );
      }
      throw new Error(`A project is already registered at ${rootPath} (id=${existing.id})`);
    }
  }

  /**
   * Read projects from disk.
   *
   * A MISSING file is the normal fresh-start condition: clear the map and
   * return an empty registry (no throw).
   *
   * A PRESENT-but-unparseable file (invalid JSON, a non-ENOENT read error on
   * an existing path, or a parsed value that is not an array) is FATAL.
   * `projects.json` is the authoritative record of durable project identity;
   * silently discarding it and continuing would let startup overwrite it with
   * only synthetic records, permanently losing every normal project. Instead
   * we preserve a timestamped raw-bytes backup and throw so startup fails
   * loudly and the corrupt file is never overwritten.
   */
  load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.storePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        // File missing — fresh start.
        this.projects.clear();
        return;
      }
      // Present but unreadable (permissions, etc.) — corrupt/fatal.
      this.failCorruptRegistry(err);
    }

    let arr: any[];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error(`expected a JSON array, got ${parsed === null ? "null" : typeof parsed}`);
      }
      arr = parsed;
    } catch (err) {
      this.failCorruptRegistry(err);
    }

    let changed = false;
    this.projects.clear();
    for (const p of arr) {
      // Migration: ensure colorLight/colorDark always present
      if (!p.colorLight || !p.colorDark) {
        if (p.color) {
          p.colorLight = p.colorLight || p.color;
          p.colorDark = p.colorDark || p.color;
        } else {
          p.colorLight = p.colorLight || DEFAULT_PROJECT_COLOR_LIGHT;
          p.colorDark = p.colorDark || DEFAULT_PROJECT_COLOR_DARK;
        }
        changed = true;
      }
      this.projects.set(p.id, p as RegisteredProject);
    }

    if (this.normalizeVisiblePositions()) changed = true;
    if (changed) {
      try { this.save(); } catch (err) { console.warn(`[project-registry] failed to persist migrations: ${err}`); }
    }
  }

  /**
   * Preserve a raw-bytes backup of the corrupt registry, then throw a clear
   * fatal error. Never returns.
   */
  private failCorruptRegistry(cause: unknown): never {
    const backupPath = this.backupCorruptRegistry();
    const reason = cause instanceof Error ? cause.message : String(cause);
    const backupNote = backupPath
      ? `A raw backup was saved to ${backupPath}.`
      : `A raw backup could not be created.`;
    throw new Error(
      `Authoritative project registry ${this.storePath} is malformed (${reason}); ` +
      `refusing to start to avoid overwriting durable project identity. ` +
      `${backupNote} Repair or restore projects.json and restart.`,
    );
  }

  /**
   * Best-effort: copy the corrupt registry to a timestamped
   * `projects.json.corrupt-<epochMs>` sibling so the raw bytes are preserved
   * before we refuse to start. Skips writing if an existing `.corrupt-*`
   * backup already holds identical bytes (so repeated boots don't spam
   * near-duplicate files). Returns the backup path, or null if none could be
   * created.
   */
  private backupCorruptRegistry(): string | null {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(this.storePath);
    } catch {
      return null;
    }
    try {
      const dir = path.dirname(this.storePath);
      const base = path.basename(this.storePath);
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith(`${base}.corrupt-`)) continue;
        try {
          if (fs.readFileSync(path.join(dir, name)).equals(bytes)) {
            return path.join(dir, name);
          }
        } catch { /* ignore an unreadable sibling backup */ }
      }
      const backupPath = path.join(dir, `${base}.corrupt-${Date.now()}`);
      fs.writeFileSync(backupPath, bytes);
      return backupPath;
    } catch {
      return null;
    }
  }

  /** Atomically persist projects to disk (write tmp + rename). */
  save(): void {
    const dir = path.dirname(this.storePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.storePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.list(), null, 2), "utf-8");
    fs.renameSync(tmp, this.storePath);
  }

  /** Return all registered projects. Visible projects are ordered by position; hidden projects are appended by createdAt. */
  list(): RegisteredProject[] {
    return [...this.projects.values()]
      .map((project, index) => ({ project, index }))
      .sort((a, b) => {
        const categoryA = this.listSortCategory(a.project);
        const categoryB = this.listSortCategory(b.project);
        if (categoryA !== categoryB) return categoryA - categoryB;
        if (categoryA === 1) return this.compareVisibleOrderEntries(a, b);
        if (a.project.createdAt !== b.project.createdAt) return a.project.createdAt - b.project.createdAt;
        return a.index - b.index;
      })
      .map(entry => entry.project);
  }

  /**
   * Persist a user-controlled ordering of the visible projects.
   *
   * `options.excludeIds` lists participating projects that are NOT part of the
   * caller's reorder scope (e.g. Headquarters when it is hidden from project
   * lists via preference). Excluded projects are not expected in the payload
   * and keep their current slot; the received ids fill the remaining slots in
   * the given order. This keeps strict staleness detection for the ids the
   * caller actually controls.
   */
  setVisibleOrder(projectIds: string[], options?: { excludeIds?: readonly string[] }): RegisteredProject[] {
    if (!Array.isArray(projectIds) || projectIds.some(id => typeof id !== "string")) {
      throw new ProjectOrderError("invalid_project_order", "projectIds must be an array of strings");
    }

    const seen = new Set<string>();
    for (const id of projectIds) {
      if (seen.has(id)) {
        throw new ProjectOrderError("invalid_project_order", `Duplicate project id in order: ${id}`);
      }
      seen.add(id);
    }

    const excluded = new Set(options?.excludeIds ?? []);
    const participating = this.list().filter(project => this.participatesInVisibleOrder(project));
    const expectedProjectIds = participating
      .filter(project => !excluded.has(project.id))
      .map(project => project.id);
    const receivedProjectIds = [...projectIds];

    for (const id of receivedProjectIds) {
      const project = this.projects.get(id);
      if (!project || !this.participatesInVisibleOrder(project) || excluded.has(id)) {
        throw new ProjectOrderError("invalid_project_order", `Invalid project id in order: ${id}`);
      }
    }

    const expectedSet = new Set(expectedProjectIds);
    if (receivedProjectIds.length !== expectedProjectIds.length || receivedProjectIds.some(id => !expectedSet.has(id))) {
      throw new ProjectOrderError("stale_project_order", "Project order is stale", {
        expectedProjectIds,
        receivedProjectIds,
      });
    }

    // Rebuild the full participating order: excluded projects keep their slot,
    // received ids fill the remaining slots in their new order.
    const receivedQueue = [...receivedProjectIds];
    const finalOrder = participating.map(project =>
      excluded.has(project.id) ? project.id : receivedQueue.shift()!,
    );
    finalOrder.forEach((id, position) => {
      const project = this.projects.get(id)!;
      project.position = position;
    });
    this.save();
    return this.list().filter(project => this.isVisibleListProject(project));
  }

  /** Lookup by project ID. */
  get(id: string): RegisteredProject | undefined {
    return this.projects.get(id);
  }

  /** Find a project whose rootPath matches its canonical identity. Excludes
   * hidden synthetic projects (e.g. "system") so that real-project lookups don't
   * accidentally match the install-dir anchor of the hidden system project. */
  getByPath(rootPath: string): RegisteredProject | undefined {
    for (const p of this.projects.values()) {
      if (p.hidden) continue;
      if (this.sameProjectPath(p.rootPath, rootPath)) return p;
    }
    return undefined;
  }

  /** Find the project whose rootPath contains the given cwd (longest match wins).
   * Excludes hidden synthetic projects — they should never match by cwd.
   *
   * Both sides are canonicalized via realpathSync (best-effort, with textual
   * fallback on EPERM/ENOENT) so a cwd reached through a symlink resolves to
   * a project registered at the canonical path (or vice versa).
   * `getByPath()` uses this same canonical identity for upserts, so symlink,
   * separator, and case aliases on a demonstrably insensitive filesystem
   * cannot create a second project. */
  findByCwd(cwd: string): RegisteredProject | undefined {
    const cwdPathApi = projectPathApi(cwd);
    const normalized = this.pathIdentity(cwd);
    let best: RegisteredProject | undefined;
    let bestLen = 0;
    for (const p of this.projects.values()) {
      if (p.hidden) continue;
      const rootPathApi = projectPathApi(p.rootPath);
      // Different dialects cannot contain one another. This also ensures the
      // relative comparison uses win32 semantics for drive and UNC projects on
      // every host.
      if (rootPathApi !== cwdPathApi) continue;
      const root = this.pathIdentity(p.rootPath);
      // Identities are already slash-normalized and have folded only proven
      // insensitive components. Use POSIX relative semantics here so win32's
      // unconditional case-insensitive comparison cannot re-merge a sensitive
      // Windows descendant.
      const relative = path.posix.relative(root, normalized);
      if ((relative === "" || (!relative.startsWith("../") && relative !== ".." && !path.posix.isAbsolute(relative))) && root.length > bestLen) {
        best = p;
        bestLen = root.length;
      }
    }
    return best;
  }

  /**
   * Register a new project.
   * - Validates rootPath is absolute.
   * - Scaffolds `.bobbit/config/` and `.bobbit/state/` if they don't exist.
   * - Persists immediately.
   */
  register(
    name: string,
    rootPath: string,
    opts?: { color?: string; palette?: string; colorLight?: string; colorDark?: string; acceptCanonical?: boolean },
  ): RegisteredProject {
    if (!path.isAbsolute(rootPath)) {
      throw new Error(`rootPath must be absolute, got: ${rootPath}`);
    }

    if (!fs.existsSync(rootPath)) {
      throw new Error("Project root path does not exist: " + rootPath);
    }

    // Symlink guard: if rootPath resolves through a symlink, require the
    // caller to opt in to the canonical path. Otherwise worktree creation,
    // .bobbit/state scaffolding, and path-containment checks would operate
    // inconsistently against both the symlink and its target.
    const sym = detectSymlinkRoot(rootPath);
    if (sym.symlink) {
      if (opts?.acceptCanonical) {
        rootPath = sym.canonical;
      } else {
        throw new SymlinkProjectRootError(rootPath, sym.canonical);
      }
    }

    // Check for duplicate normal projects by canonical path. Special hidden
    // anchors do not block registering the server run directory as a normal
    // project, but the physical Headquarters directory itself is immutable.
    this.assertRootPathAvailable(rootPath, { allowSpecialAnchors: true });

    // Defense in depth: re-run preflight server-side. The REST endpoint may
    // have already shown the report to the user, but we never trust the
    // client to have actually heeded it. Any `fail` aborts registration.
    // Callers that legitimately need to bypass (e.g. the synthetic system
    // project or the project-assistant scaffolding path) call sister
    // methods (registerSystemProject / registerProvisional) which do not
    // invoke this guard.
    try {
      const report = runPreflight(rootPath, {
        registeredProjects: this.list(),
        gatewayProjectRoot: getProjectRoot(),
      });
      if (report.hasFail) {
        const failing = report.checks.filter(c => c.level === "fail")
          .map(c => `${c.id}: ${c.detail}`)
          .join("; ");
        throw new PreflightFailedError(rootPath, report, failing);
      }
    } catch (err) {
      if (err instanceof PreflightFailedError) throw err;
      // Any other failure inside preflight is non-fatal — log and proceed,
      // matching the pre-preflight behavior so a broken check can't lock
      // out all project registration.
      console.warn(`[project-registry] preflight failed unexpectedly: ${err}`);
    }

    // Scaffold .bobbit directories
    const bobbitDir = path.join(rootPath, ".bobbit");
    fs.mkdirSync(path.join(bobbitDir, "config"), { recursive: true });
    fs.mkdirSync(path.join(bobbitDir, "state"), { recursive: true });

    // Determine colors: explicit > palette-seeded > legacy color > defaults
    let colorLight = opts?.colorLight;
    let colorDark = opts?.colorDark;
    const palette = opts?.palette;

    if (palette && PALETTE_PRIMARY_COLORS[palette]) {
      if (!colorLight) colorLight = PALETTE_PRIMARY_COLORS[palette].light;
      if (!colorDark) colorDark = PALETTE_PRIMARY_COLORS[palette].dark;
    }

    if (!colorLight && opts?.color) colorLight = opts.color;
    if (!colorDark && opts?.color) colorDark = opts.color;

    colorLight = colorLight || DEFAULT_PROJECT_COLOR_LIGHT;
    colorDark = colorDark || DEFAULT_PROJECT_COLOR_DARK;

    const project: RegisteredProject = {
      id: randomUUID(),
      name,
      rootPath,
      createdAt: Date.now(),
      position: this.nextVisiblePosition(),
      color: colorLight, // backward compat
      colorLight,
      colorDark,
      ...(palette ? { palette } : {}),
    };

    this.projects.set(project.id, project);
    this.save();
    return project;
  }

  /** Update mutable fields of an existing project. */
  update(
    id: string,
    updates: Partial<Pick<RegisteredProject, "name" | "color" | "rootPath" | "palette" | "colorLight" | "colorDark">> & {
      parentProjectId?: string | null;
    },
  ): RegisteredProject {
    const project = this.projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    assertNormalMutableProject(project, "updated");

    // Root-path collision guard. Reject repointing this normal project onto
    // another visible normal/provisional project's canonical root or onto any
    // server-owned special anchor (Headquarters, the system project, or a
    // hidden synthetic anchor) before mutating any fields. Only Headquarters
    // plus a single same-root normal project may share a directory
    // relationship, and that is established via register(), never by editing a
    // normal project onto a special anchor.
    if (updates.rootPath !== undefined) {
      this.assertRootPathAvailable(path.resolve(updates.rootPath), {
        excludeId: id,
        allowSpecialAnchors: false,
      });
    }

    if (updates.parentProjectId !== undefined) {
      const v = updates.parentProjectId;
      if (v === null || v === "") {
        delete project.parentProjectId;
      } else if (typeof v === "string") {
        if (v === id) {
          throw new Error(`parentProjectId cannot reference self (${id})`);
        }
        const target = this.projects.get(v);
        if (!target) throw new Error(`parentProjectId references unknown project: ${v}`);
        if (target.hidden) throw new Error(`parentProjectId cannot reference a hidden project: ${v}`);
        if (target.provisional) throw new Error(`parentProjectId cannot reference a provisional project: ${v}`);
        // Cycle detection: walk target's ancestor chain and refuse if id reappears.
        const seen = new Set<string>([id]);
        let cursor: string | undefined = target.parentProjectId;
        let hops = 0;
        while (cursor && hops < 64) {
          if (seen.has(cursor)) {
            throw new Error(`parentProjectId would create a cycle through ${cursor}`);
          }
          seen.add(cursor);
          const next: RegisteredProject | undefined = this.projects.get(cursor);
          if (!next) break;
          cursor = next.parentProjectId;
          hops++;
        }
        project.parentProjectId = v;
      } else {
        throw new Error(`parentProjectId must be a string or null`);
      }
    }

    if (updates.name !== undefined) project.name = updates.name;
    if (updates.rootPath !== undefined) project.rootPath = path.resolve(updates.rootPath);

    // Handle palette change
    if (updates.palette !== undefined) {
      project.palette = updates.palette || undefined; // empty string → clear palette
      // Auto-seed colors from palette when colors not explicitly provided
      if (project.palette && PALETTE_PRIMARY_COLORS[project.palette]) {
        if (updates.colorLight === undefined) {
          project.colorLight = PALETTE_PRIMARY_COLORS[project.palette].light;
        }
        if (updates.colorDark === undefined) {
          project.colorDark = PALETTE_PRIMARY_COLORS[project.palette].dark;
        }
      } else if (!project.palette) {
        // Clearing palette → reset accents to defaults (unless caller supplied explicit overrides)
        if (updates.colorLight === undefined) {
          project.colorLight = DEFAULT_PROJECT_COLOR_LIGHT;
        }
        if (updates.colorDark === undefined) {
          project.colorDark = DEFAULT_PROJECT_COLOR_DARK;
        }
      }
    }

    // Explicit color overrides
    if (updates.colorLight !== undefined) project.colorLight = updates.colorLight;
    if (updates.colorDark !== undefined) project.colorDark = updates.colorDark;

    // Legacy color field — keep in sync
    if (updates.color !== undefined) project.color = updates.color;
    else project.color = project.colorLight;

    this.projects.set(id, project);
    this.save();
    return project;
  }

  /**
   * Remove a project from the registry.
   * Does NOT delete files on disk — only unregisters.
   * Callers (e.g. server.ts) should guard against removing the last remaining project.
   */
  /**
   * Return ancestor projects in order (closest parent first). Stops at the
   * root, on a missing reference, or on any cycle (defensive — bounded to
   * 32 hops).
   */
  getAncestors(projectId: string): RegisteredProject[] {
    const out: RegisteredProject[] = [];
    const seen = new Set<string>([projectId]);
    let cursor: string | undefined = this.projects.get(projectId)?.parentProjectId;
    let hops = 0;
    while (cursor && hops < 32) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const next = this.projects.get(cursor);
      if (!next) break;
      out.push(next);
      cursor = next.parentProjectId;
      hops++;
    }
    return out;
  }

  remove(id: string): void {
    const project = this.projects.get(id);
    if (!project) {
      throw new Error(`Project not found: ${id}`);
    }
    assertNormalMutableProject(project, "removed");
    this.projects.delete(id);
    this.normalizeVisiblePositions();
    this.save();
  }

  /**
   * Ensure the built-in user-facing Headquarters project exists. Headquarters
   * is the project-list alias for the server workspace, so it bypasses normal
   * add-project preflight and scaffolds the supplied server config/state dirs
   * instead of `<rootPath>/.bobbit`.
   */
  ensureHeadquartersProject(
    rootPath: string,
    opts: { stateDir?: string; configDir?: string } = {},
  ): RegisteredProject {
    if (!path.isAbsolute(rootPath)) {
      throw new Error(`rootPath must be absolute, got: ${rootPath}`);
    }

    // Compatibility: older startup code passed the server run directory here.
    // Treat that as a request for the physical Headquarters directory; callers
    // updated for the split pass headquartersDir() directly.
    const requestedRoot = this.sameProjectPath(rootPath, getProjectRoot()) ? headquartersDir(rootPath) : rootPath;
    const canonicalRoot = (() => {
      try { return path.resolve(fs.realpathSync(requestedRoot)); }
      catch { return path.resolve(requestedRoot); }
    })();

    try { if (opts.stateDir) fs.mkdirSync(opts.stateDir, { recursive: true }); } catch { /* best-effort */ }
    try { if (opts.configDir) fs.mkdirSync(opts.configDir, { recursive: true }); } catch { /* best-effort */ }

    const existing = this.projects.get(HEADQUARTERS_PROJECT_ID);

    let project = existing;

    if (!project) {
      project = {
        id: HEADQUARTERS_PROJECT_ID,
        name: HEADQUARTERS_PROJECT_NAME,
        rootPath: canonicalRoot,
        createdAt: Date.now(),
        kind: "headquarters",
        colorLight: DEFAULT_PROJECT_COLOR_LIGHT,
        colorDark: DEFAULT_PROJECT_COLOR_DARK,
        // Headquarters is a normal, user-reorderable project: a freshly
        // registered one appends to the end of the visible order just like any
        // other new project. Its position persists and can be changed by drag.
        position: this.nextVisiblePosition(),
      };
    }

    project.name = HEADQUARTERS_PROJECT_NAME;
    project.rootPath = canonicalRoot;
    project.kind = "headquarters";
    // hide/show is presentation-only preference state — remove the field rather
    // than pinning `hidden: false` here, consistent with the position/provisional/
    // parentProjectId cleanup below.
    delete project.hidden;
    delete project.provisional;
    // Headquarters participates in user-controlled ordering; preserve any saved
    // position and let normalizeVisiblePositions() assign one when missing.
    delete project.parentProjectId;
    project.colorLight = project.colorLight || DEFAULT_PROJECT_COLOR_LIGHT;
    project.colorDark = project.colorDark || DEFAULT_PROJECT_COLOR_DARK;
    project.color = project.color || project.colorLight;

    this.projects.set(HEADQUARTERS_PROJECT_ID, project);
    // Same-root normal projects are independent user scopes; never promote,
    // delete, or rewrite them as part of Headquarters repair.

    this.normalizeVisiblePositions();
    this.save();
    return project;
  }

  /**
   * Register the synthetic "system" project anchored at the bobbit install
   * directory. Idempotent — safe to call repeatedly. Used as the
   * `projectId` for system-scope tool-assistant sessions so they have a
   * valid persistence anchor without forcing the user to register a real
   * project. Marked `hidden: true` so callers can filter it out of UI
   * listings.
   */
  registerSystemProject(rootPath: string): RegisteredProject {
    if (!path.isAbsolute(rootPath)) {
      throw new Error(`rootPath must be absolute, got: ${rootPath}`);
    }
    // The system project is hidden and synthetic — there is no user-facing
    // confirm dialog. Silently use the canonical path if rootPath is a
    // symlink to keep state consistent.
    {
      const sym = detectSymlinkRoot(rootPath);
      if (sym.symlink) rootPath = sym.canonical;
    }
    const existing = this.projects.get(SYSTEM_PROJECT_ID);
    if (existing) {
      let changed = false;
      if (!existing.hidden) {
        existing.hidden = true;
        changed = true;
      }
      if (existing.kind !== "system") {
        existing.kind = "system";
        changed = true;
      }
      if (existing.rootPath !== rootPath) {
        existing.rootPath = rootPath;
        changed = true;
      }
      if (existing.position !== undefined) {
        delete existing.position;
        changed = true;
      }
      if (existing.provisional !== undefined) {
        delete existing.provisional;
        changed = true;
      }
      if (changed) {
        this.normalizeVisiblePositions();
        this.save();
      }
      return existing;
    }
    // Scaffold .bobbit dirs only if rootPath exists. The bobbit install dir
    // normally does, but tests may pass a placeholder.
    if (fs.existsSync(rootPath)) {
      const bobbitDir = path.join(rootPath, ".bobbit");
      try {
        fs.mkdirSync(path.join(bobbitDir, "config"), { recursive: true });
        fs.mkdirSync(path.join(bobbitDir, "state"), { recursive: true });
      } catch { /* best-effort — read-only install dirs are fine */ }
    }
    const project: RegisteredProject = {
      id: SYSTEM_PROJECT_ID,
      name: "System",
      rootPath,
      createdAt: Date.now(),
      kind: "system",
      colorLight: DEFAULT_PROJECT_COLOR_LIGHT,
      colorDark: DEFAULT_PROJECT_COLOR_DARK,
      hidden: true,
    };
    this.projects.set(project.id, project);
    this.save();
    return project;
  }

  /**
   * Register a provisional project (used by project assistant sessions).
   * Provisional projects are real persisted projects with `provisional: true`.
   * For scaffolding (Path C), the rootPath may not exist yet — skip existence check.
   * Deduplicates: if a normal or provisional project already exists at the same canonical rootPath, reuse it.
   */
  registerProvisional(name: string, rootPath: string): RegisteredProject {
    if (!path.isAbsolute(rootPath)) {
      throw new Error(`rootPath must be absolute, got: ${rootPath}`);
    }
    // Provisional projects are transient assistant scaffolds — the user is
    // not shown a path-confirmation dialog at this point. Silently use the
    // canonical path if rootPath is a symlink, matching the
    // acceptCanonical=true branch of register().
    {
      const sym = detectSymlinkRoot(rootPath);
      if (sym.symlink) rootPath = sym.canonical;
    }

    // Deduplicate by canonical root. Project-assistant setup should attach to
    // an existing visible normal/provisional scope instead of creating a second
    // project at the same path. Hidden/system anchors remain internal and do
    // not block provisioning; Headquarters' physical directory stays immutable.
    // Preserve the input dialect for the injected path-identity seam. Native
    // path.resolve() turns an absolute POSIX fixture into a Windows path on
    // Windows, preventing its identity from matching the persisted POSIX root.
    const normalized = projectPathApi(rootPath).resolve(rootPath);
    for (const p of this.projects.values()) {
      if (!this.sameProjectPath(p.rootPath, normalized)) continue;
      if (isHeadquartersProject(p)) {
        assertNormalMutableProject(p, "used as a provisional project");
      }
      if (p.hidden || isSystemProject(p)) continue;
      return p;
    }

    // Scaffold .bobbit directories only if rootPath exists
    if (fs.existsSync(rootPath)) {
      const bobbitDir = path.join(rootPath, ".bobbit");
      fs.mkdirSync(path.join(bobbitDir, "config"), { recursive: true });
      fs.mkdirSync(path.join(bobbitDir, "state"), { recursive: true });
    }

    const project: RegisteredProject = {
      id: randomUUID(),
      name,
      rootPath,
      createdAt: Date.now(),
      position: this.nextVisiblePosition(),
      colorLight: DEFAULT_PROJECT_COLOR_LIGHT,
      colorDark: DEFAULT_PROJECT_COLOR_DARK,
      provisional: true,
    };

    this.projects.set(project.id, project);
    this.save();
    return project;
  }

  /**
   * Promote a provisional project to a full project.
   * Clears `provisional` flag and optionally updates the name.
   * If rootPath now exists but wasn't scaffolded, scaffold it.
   */
  promote(id: string, updates: { name?: string }): RegisteredProject {
    const project = this.projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    assertNormalMutableProject(project, "promoted");
    // Idempotent — if already promoted, just update the name and return
    delete project.provisional;
    if (updates.name !== undefined) project.name = updates.name;

    // Scaffold .bobbit directories if they don't exist yet (e.g. scaffolding path)
    if (fs.existsSync(project.rootPath)) {
      const bobbitDir = path.join(project.rootPath, ".bobbit");
      fs.mkdirSync(path.join(bobbitDir, "config"), { recursive: true });
      fs.mkdirSync(path.join(bobbitDir, "state"), { recursive: true });
    }

    this.projects.set(id, project);
    this.save();
    return project;
  }

  /**
   * Remove a provisional project. Safety guard: throws if the project is not provisional.
   * Does NOT delete files on disk — only unregisters.
   */
  removeProvisional(id: string): void {
    const project = this.projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    assertNormalMutableProject(project, "removed");
    if (!project.provisional) throw new Error(`Cannot remove non-provisional project ${id} via removeProvisional()`);
    this.projects.delete(id);
    this.normalizeVisiblePositions();
    this.save();
  }

}
