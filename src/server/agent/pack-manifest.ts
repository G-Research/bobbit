/**
 * Read / write / validate `pack.yaml` (the authored pack manifest) and
 * `.pack-meta.yaml` (the generated install-provenance record).
 *
 * A directory is a pack IFF it contains a valid `pack.yaml`. An invalid or
 * missing manifest is **skipped with a warning**, never fatal. See
 * `docs/design/pack-based-marketplace.md` §1.4, §1.5.
 */

import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { PackManifest, PackMeta, PackRoutesRef, PackScope } from "./pack-types.js";

/** Route name guard — mirrors the per-pack route allowlist token shape. */
const ROUTE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Pack name guard — used as a directory name; reject traversal/unsafe. */
const PACK_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isValidPackName(name: unknown): name is string {
	return (
		typeof name === "string" &&
		PACK_NAME_RE.test(name) &&
		!name.includes("..") &&
		!name.includes("/") &&
		!name.includes("\\")
	);
}

/**
 * Safe-basename guard for `contents.entrypoints[]` entries (pack-schema-v1 §1.2).
 * Each entry is the basename of an `entrypoints/<name>.yaml` file and is later
 * `path.join`ed into the pack's `entrypoints/` dir, so it MUST NOT carry path
 * structure. Reject anything that is empty, contains a path separator, a `..`
 * segment, a null byte, or is absolute / Windows drive-absolute. The strict
 * charset (`/^[A-Za-z0-9._-]+$/`) already excludes separators, `:` and NUL, but
 * the explicit `..` check is kept for clarity and defense-in-depth.
 */
const SAFE_BASENAME_RE = /^[A-Za-z0-9._-]+$/;
export function isSafeBasename(name: unknown): name is string {
	return (
		typeof name === "string" &&
		name.length > 0 &&
		!name.includes("\0") &&
		!name.includes("/") &&
		!name.includes("\\") &&
		!name.includes("..") &&
		SAFE_BASENAME_RE.test(name)
	);
}

function nonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.trim().length > 0;
}

function asStringArray(v: unknown): string[] | null {
	if (!Array.isArray(v)) return null;
	const out: string[] = [];
	for (const x of v) {
		if (typeof x !== "string") return null;
		out.push(x);
	}
	return out;
}

/**
 * Validate a parsed object as a {@link PackManifest}. Returns the normalized
 * manifest, or `null` with a reason pushed onto `problems`.
 */
export function validateManifest(
	data: unknown,
	problems?: string[],
): PackManifest | null {
	const fail = (msg: string): null => {
		problems?.push(msg);
		return null;
	};
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return fail("pack.yaml is not a mapping");
	}
	const d = data as Record<string, unknown>;

	if (!isValidPackName(d.name)) {
		return fail(`invalid pack name: ${JSON.stringify(d.name)} (must match /^[a-z0-9][a-z0-9-]*$/)`);
	}
	if (!nonEmptyString(d.description)) return fail("pack.yaml: description is required and non-empty");
	if (!nonEmptyString(d.version)) return fail("pack.yaml: version is required and non-empty");

	let schema = 1;
	if (d.schema !== undefined) {
		if (typeof d.schema !== "number" || !Number.isInteger(d.schema) || d.schema <= 0) {
			return fail("pack.yaml: schema must be a positive integer");
		}
		schema = d.schema;
		if (schema > 2) problems?.push(`pack.yaml: schema ${schema} is newer than supported (2)`);
	}

	const parseCapabilities = (key: "provides" | "requires"): string[] | undefined | null => {
		const raw = d[key];
		if (raw === undefined) return undefined;
		const parsed = asStringArray(raw);
		if (parsed === null) return fail(`pack.yaml: ${key} must be an array of strings`);
		for (const entry of parsed) {
			if (!PACK_NAME_RE.test(entry)) {
				return fail(`pack.yaml: ${key} entry ${JSON.stringify(entry)} must match /^[a-z0-9][a-z0-9-]*$/`);
			}
		}
		return parsed;
	};
	const provides = parseCapabilities("provides");
	if (provides === null) return null;
	const requires = parseCapabilities("requires");
	if (requires === null) return null;

	const contents = d.contents;
	if (!contents || typeof contents !== "object" || Array.isArray(contents)) {
		return fail("pack.yaml: contents is required (object with roles/tools/skills arrays)");
	}
	const c = contents as Record<string, unknown>;
	// MVP boundary for v1: MCP installs were out of scope. Schema 2 accepts the
	// catalogue key only; no MCP loader is introduced in this PR.
	if (schema < 2 && "mcp" in c) {
		return fail("pack.yaml: contents.mcp is not allowed (MCP installs are out of scope in MVP)");
	}
	const roles = asStringArray(c.roles);
	const tools = asStringArray(c.tools);
	const skills = asStringArray(c.skills);
	if (roles === null) return fail("pack.yaml: contents.roles must be an array of strings");
	if (tools === null) return fail("pack.yaml: contents.tools must be an array of strings");
	if (skills === null) return fail("pack.yaml: contents.skills must be an array of strings");
	const parseContentsBasenames = (yamlKey: string, raw: unknown): string[] | null => {
		if (raw === undefined) return [];
		const parsed = asStringArray(raw);
		if (parsed === null) return fail(`pack.yaml: contents.${yamlKey} must be an array of strings`);
		// Path-traversal guard: each entry is a file basename joined into a
		// contribution subdir — reject separators, `..`, absolute/drive forms.
		for (const e of parsed) {
			if (!isSafeBasename(e)) {
				return fail(
					`pack.yaml: contents.${yamlKey} entry ${JSON.stringify(e)} is not a safe basename ` +
						`(must match /^[A-Za-z0-9._-]+$/ with no path separators or ".." segments)`,
				);
			}
		}
		return parsed;
	};
	// contents.entrypoints — basenames of entrypoints/<name>.yaml files.
	const entrypoints = parseContentsBasenames("entrypoints", c.entrypoints);
	if (entrypoints === null) return null;
	const providers = parseContentsBasenames("providers", c.providers);
	if (providers === null) return null;
	const hooks = parseContentsBasenames("hooks", c.hooks);
	if (hooks === null) return null;
	const mcp = parseContentsBasenames("mcp", c.mcp);
	if (mcp === null) return null;
	const piExtensions = parseContentsBasenames("pi-extensions", c["pi-extensions"]);
	if (piExtensions === null) return null;
	const runtimes = parseContentsBasenames("runtimes", c.runtimes);
	if (runtimes === null) return null;
	const workflows = parseContentsBasenames("workflows", c.workflows);
	if (workflows === null) return null;

	const manifest: PackManifest = {
		name: d.name as string,
		description: (d.description as string).trim(),
		version: (d.version as string).trim(),
		contents: { roles, tools, skills, entrypoints, providers, hooks, mcp, piExtensions, runtimes, workflows },
	};
	if (d.schema !== undefined) manifest.schema = schema;
	if (provides !== undefined) manifest.provides = provides;
	if (requires !== undefined) manifest.requires = requires;
	// NEW (pack-schema-v1 §1.2): optional top-level `routes: { module?, names? }`.
	// Tolerant — a malformed routes block is dropped (no routes), never fatal.
	const routes = parseRoutesRef(d.routes);
	if (routes) manifest.routes = routes;
	if (nonEmptyString(d.author)) manifest.author = (d.author as string).trim();
	if (nonEmptyString(d.homepage)) manifest.homepage = (d.homepage as string).trim();
	return manifest; // unknown top-level keys ignored (forward-compat)
}

/**
 * Parse the optional top-level `routes` block of a pack.yaml into a
 * {@link PackRoutesRef}. Tolerant: a non-object, missing module, or all-invalid
 * names yields `undefined` (the pack contributes no routes). `module` path-safety
 * is enforced at resolve/import time against the pack root, so only obvious
 * garbage is dropped here. Route names are filtered to the allowlist token shape.
 */
function parseRoutesRef(raw: unknown): PackRoutesRef | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const obj = raw as Record<string, unknown>;
	const out: PackRoutesRef = {};
	if (typeof obj.module === "string" && obj.module.trim().length > 0) {
		out.module = obj.module.trim();
	}
	if (Array.isArray(obj.names)) {
		const names = obj.names.filter((n): n is string => typeof n === "string" && ROUTE_NAME_RE.test(n));
		if (names.length > 0) out.names = names;
	}
	if (out.module === undefined && out.names === undefined) return undefined;
	return out;
}

/** Parse a `pack.yaml` string into a manifest, or `null` if invalid. */
export function parseManifest(raw: string, problems?: string[]): PackManifest | null {
	let data: unknown;
	try {
		data = parse(raw);
	} catch (err) {
		problems?.push(`pack.yaml: YAML parse error: ${String(err)}`);
		return null;
	}
	return validateManifest(data, problems);
}

/**
 * Read + validate `<dir>/pack.yaml`. Returns the manifest or `null`.
 * On failure logs a warning (skip-with-warning helper, design §1.4).
 */
export function readManifest(dir: string): PackManifest | null {
	const file = path.join(dir, "pack.yaml");
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return null; // no pack.yaml ⇒ not a pack (silent — common case)
	}
	const problems: string[] = [];
	const manifest = parseManifest(raw, problems);
	if (!manifest) {
		console.warn(`[pack-manifest] skipping pack at ${dir}: ${problems.join("; ")}`);
	}
	return manifest;
}

/** Serialize a manifest to `pack.yaml` text. */
export function stringifyManifest(manifest: PackManifest): string {
	return stringify(manifest);
}

export function writeManifest(dir: string, manifest: PackManifest): void {
	fs.writeFileSync(path.join(dir, "pack.yaml"), stringifyManifest(manifest), "utf-8");
}

// ── .pack-meta.yaml ──────────────────────────────────────────────

const SCOPES: ReadonlySet<string> = new Set(["builtin", "global-user", "server", "project"]);

/** Validate a parsed object as {@link PackMeta}; `null` if invalid. */
export function validateMeta(data: unknown, problems?: string[]): PackMeta | null {
	const fail = (msg: string): null => {
		problems?.push(msg);
		return null;
	};
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return fail(".pack-meta.yaml is not a mapping");
	}
	const d = data as Record<string, unknown>;
	if (!nonEmptyString(d.packName)) return fail(".pack-meta.yaml: packName required");
	if (!nonEmptyString(d.version)) return fail(".pack-meta.yaml: version required");
	if (typeof d.scope !== "string" || !SCOPES.has(d.scope)) {
		return fail(`.pack-meta.yaml: invalid scope ${JSON.stringify(d.scope)}`);
	}
	return {
		sourceUrl: typeof d.sourceUrl === "string" ? d.sourceUrl : "",
		sourceRef: typeof d.sourceRef === "string" ? d.sourceRef : "",
		commit: typeof d.commit === "string" ? d.commit : "",
		packName: d.packName as string,
		version: d.version as string,
		installedAt: typeof d.installedAt === "string" ? d.installedAt : "",
		updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : "",
		scope: d.scope as PackScope,
	};
}

/** Read + validate `<dir>/.pack-meta.yaml`. Returns meta or `null`. */
export function readMeta(dir: string): PackMeta | null {
	const file = path.join(dir, ".pack-meta.yaml");
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return null;
	}
	let data: unknown;
	try {
		data = parse(raw);
	} catch (err) {
		console.warn(`[pack-manifest] invalid .pack-meta.yaml at ${dir}: ${String(err)}`);
		return null;
	}
	const problems: string[] = [];
	const meta = validateMeta(data, problems);
	if (!meta) console.warn(`[pack-manifest] invalid .pack-meta.yaml at ${dir}: ${problems.join("; ")}`);
	return meta;
}

export function stringifyMeta(meta: PackMeta): string {
	return stringify(meta);
}

export function writeMeta(dir: string, meta: PackMeta): void {
	fs.writeFileSync(path.join(dir, ".pack-meta.yaml"), stringifyMeta(meta), "utf-8");
}
