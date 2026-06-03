/**
 * Marketplace MVP — pack manifest parsing + source scanning (§2, §5).
 *
 * A directory is a pack iff it contains `pack.yaml`. Scanning is one level
 * deep: only immediate children of the source root are considered. Declared
 * contents are validated against on-disk payloads via the entity-handler
 * registry, so adding an entity type does not touch this file.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ENTITY_HANDLERS, handlerForManifestKey } from "./entity-handlers.js";
import type { PackManifest, ScannedEntity, ScannedPack } from "./types.js";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface ManifestParseResult {
	manifest?: PackManifest;
	error?: string;
}

/** Parse + shallow-validate the identity fields of a pack.yaml document. */
export function parsePackManifest(yamlText: string): ManifestParseResult {
	let raw: unknown;
	try {
		raw = YAML.parse(yamlText);
	} catch (err) {
		return { error: `pack.yaml failed to parse: ${(err as Error).message}` };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { error: "pack.yaml must be a YAML object" };
	}
	const obj = raw as Record<string, unknown>;

	if (obj.apiVersion !== 1) {
		return { error: `unsupported apiVersion ${JSON.stringify(obj.apiVersion)} (MVP accepts 1)` };
	}
	for (const field of ["id", "name", "description", "version"] as const) {
		if (typeof obj[field] !== "string" || !(obj[field] as string).trim()) {
			return { error: `pack.yaml missing required string field: ${field}` };
		}
	}
	if (!ID_PATTERN.test(obj.id as string)) {
		return { error: `pack.yaml id "${obj.id as string}" must match ${ID_PATTERN}` };
	}
	if (!obj.contents || typeof obj.contents !== "object" || Array.isArray(obj.contents)) {
		return { error: "pack.yaml missing required object: contents" };
	}

	const contents = obj.contents as Record<string, unknown>;
	const hasAnySupported = Object.values(ENTITY_HANDLERS).some((h) => {
		const list = contents[h.manifestKey];
		return Array.isArray(list) && list.length > 0;
	});
	if (!hasAnySupported) {
		return { error: "pack.yaml contents must declare at least one of: roles, tools, skills" };
	}

	// Preserve the whole object (unknown keys + unknown contents keys) for
	// forward-compat; the typed view is a superset.
	return { manifest: obj as unknown as PackManifest };
}

/**
 * Build a ScannedPack from a pack directory. Returns a pack with `valid:false`
 * + `error` on any manifest/validation failure (non-fatal at source level).
 */
export function scanPackDir(sourceId: string, packDir: string): ScannedPack {
	const manifestPath = path.join(packDir, "pack.yaml");
	let packId = path.basename(packDir);

	const parsed = parsePackManifest(safeRead(manifestPath));
	if (!parsed.manifest) {
		return { sourceId, packId, dir: packDir, manifest: null, entities: [], hasTools: false, valid: false, error: parsed.error };
	}
	const manifest = parsed.manifest;
	packId = manifest.id;

	const entities: ScannedEntity[] = [];
	const errors: string[] = [];

	// Iterate declared contents through the handler registry. Unknown contents
	// keys (no handler) are ignored — forward-compat (§2.2).
	for (const [key, listRaw] of Object.entries(manifest.contents)) {
		const handler = handlerForManifestKey(key);
		if (!handler) continue; // unknown contents key — preserved, ignored
		const list = Array.isArray(listRaw) ? listRaw : [];
		for (const name of list) {
			if (typeof name !== "string" || !name.trim()) {
				errors.push(`${key}: entry must be a non-empty string`);
				continue;
			}
			const res = handler.validate(packDir, name);
			if (!res.ok) {
				errors.push(res.error ?? `${key}/${name} is invalid`);
				continue;
			}
			entities.push({ type: handler.type, name, sourcePath: handler.payloadPath(packDir, name) });
		}
	}

	const hasTools = entities.some((e) => e.type === "tool");
	if (errors.length > 0) {
		return { sourceId, packId, dir: packDir, manifest, entities, hasTools, valid: false, error: errors.join("; ") };
	}
	return { sourceId, packId, dir: packDir, manifest, entities, hasTools, valid: true };
}

/** Scan a synced source root → list of ScannedPack (one level deep). */
export function scanSource(sourceId: string, root: string): ScannedPack[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const packs: ScannedPack[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(root, entry.name);
		if (!fs.existsSync(path.join(dir, "pack.yaml"))) continue; // not a pack
		packs.push(scanPackDir(sourceId, dir));
	}
	return packs;
}

/**
 * Stable content hash over a pack's declared entity payloads. Used as the
 * freshness signal for local sources (no commit SHA). Hashes relative path +
 * bytes of every file under each entity's payload path.
 */
export function hashPackPayload(pack: ScannedPack): string {
	const hash = crypto.createHash("sha256");
	const sorted = [...pack.entities].sort((a, b) => (a.type + a.name).localeCompare(b.type + b.name));
	for (const entity of sorted) {
		hash.update(`\u0000${entity.type}:${entity.name}\u0000`);
		hashPath(hash, entity.sourcePath, entity.sourcePath);
	}
	return hash.digest("hex");
}

function hashPath(hash: crypto.Hash, root: string, p: string): void {
	let stat: fs.Stats;
	try { stat = fs.statSync(p); } catch { return; }
	if (stat.isDirectory()) {
		for (const name of fs.readdirSync(p).sort()) {
			hashPath(hash, root, path.join(p, name));
		}
	} else if (stat.isFile()) {
		hash.update(path.relative(root, p).replace(/\\/g, "/"));
		hash.update(fs.readFileSync(p));
	}
}

function safeRead(p: string): string {
	try { return fs.readFileSync(p, "utf-8"); } catch { return ""; }
}
