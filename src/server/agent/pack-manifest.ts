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

	const contents = d.contents;
	if (!contents || typeof contents !== "object" || Array.isArray(contents)) {
		return fail("pack.yaml: contents is required (object with roles/tools/skills arrays)");
	}
	const c = contents as Record<string, unknown>;
	// MVP boundary: MCP installs are out of scope — reject any contents.mcp.
	if ("mcp" in c) {
		return fail("pack.yaml: contents.mcp is not allowed (MCP installs are out of scope in MVP)");
	}
	const roles = asStringArray(c.roles);
	const tools = asStringArray(c.tools);
	const skills = asStringArray(c.skills);
	if (roles === null) return fail("pack.yaml: contents.roles must be an array of strings");
	if (tools === null) return fail("pack.yaml: contents.tools must be an array of strings");
	if (skills === null) return fail("pack.yaml: contents.skills must be an array of strings");
	// NEW (pack-schema-v1 §1.2): contents.entrypoints — basenames of entrypoints/<name>.yaml
	// files. Optional + defaults to [] (a pack with no entrypoints stays valid); when
	// present it MUST be a string array.
	let entrypoints: string[] = [];
	if (c.entrypoints !== undefined) {
		const parsed = asStringArray(c.entrypoints);
		if (parsed === null) return fail("pack.yaml: contents.entrypoints must be an array of strings");
		entrypoints = parsed;
	}

	const manifest: PackManifest = {
		name: d.name as string,
		description: (d.description as string).trim(),
		version: (d.version as string).trim(),
		contents: { roles, tools, skills, entrypoints },
	};
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
