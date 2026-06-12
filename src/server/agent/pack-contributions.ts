// src/server/agent/pack-contributions.ts
//
// Loaders for the PACK-SCOPED Extension Host contributions
// (pack-schema-v1-rationalisation §5.1). These declarations moved OFF the tool
// YAML to their own pack-level sites:
//
//   - `panels/<panel>.yaml`     → PanelContribution[]  (auto-discovered)
//   - `entrypoints/<ep>.yaml`   → EntrypointContribution[] (filtered by
//                                  manifest.contents.entrypoints[])
//   - `providers/<id>.yaml`     → ProviderContribution[] (filtered by
//                                  manifest.contents.providers[])
//   - `pack.yaml.routes`        → RouteContribution
//
// Mirrors the tolerance of `tool-contributions.ts`: a malformed file is warned +
// dropped and never crashes the scan — EXCEPT the hard conflicts of §5.4,
// which throw {@link PackContributionError}:
//
//   1. duplicate route name within a pack;
//   2. (duplicate host-global routeId — detected at registry build, cross-pack);
//   3. duplicate panel id within a pack;
//   4. duplicate entrypoint id within a pack;
//   5. duplicate provider id within a pack.
//
// Each contribution carries its declaring `sourceFile` + the absolute `packRoot`
// so the serve/import sites can resolve a path-bearing field RELATIVE to the
// declaring YAML and enforce realpath containment against the pack root (§2).

import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { PackManifest } from "./pack-types.js";
import { isSafeRelativePath, parseEntrypoints } from "./tool-contributions.js";
import { isSafeBasename } from "./pack-manifest.js";
import { isPackPathWithinRoot } from "../extension-host/path-guard.js";

// Panel ids may use dotted namespaces (e.g. `artifacts.viewer`).
const PANEL_ID_RE = /^[a-z0-9][a-z0-9_.-]*$/i;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_.-]*$/i;
const ROUTE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const PROVIDER_KINDS = new Set(["memory", "selector", "generic"]);
const PROVIDER_HOOKS = new Set(["sessionSetup", "beforePrompt", "afterTurn", "beforeCompact", "sessionShutdown"]);

/** A hard pack-contribution conflict (§5.4). Throwing aborts the pack's load so
 *  the registry can surface a loud error instead of silently registering an
 *  ambiguous surface. */
export class PackContributionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PackContributionError";
	}
}

/** A pack-scoped panel (panels/<file>.yaml). */
export interface PanelContribution {
	id: string; // unique within the pack (dotted allowed)
	title?: string;
	entry: string; // path relative to sourceFile, contained in packRoot
	/** Durable tab identity mode. Omitted/default is singleton compatibility. */
	instanceMode?: "singleton" | "parameterized";
	/** Allowlisted params key that must match the tab instanceKey for parameterized panels. */
	instanceParam?: string;
	/** Absolute path of the declaring YAML (panels/<file>.yaml). */
	sourceFile: string;
	/** Absolute pack root (market-packs/<name>). */
	packRoot: string;
}

/** A pack-scoped entrypoint (entrypoints/<file>.yaml). */
export interface EntrypointContribution {
	id: string; // unique within the pack
	kind: "composer-slash" | "git-widget-button" | "command-palette" | "route";
	label?: string; // required for launcher kinds
	routeId?: string; // required for kind:"route"; host-global
	target?: { action?: string; panelId?: string; route?: string; params?: Record<string, unknown> };
	paramKeys?: string[];
	/** The contents.entrypoints[] basename that lists this file — the SINGLE
	 *  activation toggle key. Maps one toggle onto BOTH the launcher id AND the
	 *  deep-link routeId the client registry keys by. */
	listName: string;
	sourceFile: string;
	packRoot: string;
}

/** The pack-level routes ref (pack.yaml `routes`). */
export interface RouteContribution {
	module: string; // path relative to pack.yaml, contained in packRoot
	names: string[]; // allowlist
	sourceFile: string; // = <packRoot>/pack.yaml
	packRoot: string;
}

export interface ProviderContribution {
	id: string;
	kind: "memory" | "selector" | "generic";
	module: string;
	hooks: string[];
	runtime?: string;
	budget: { maxTokens: number; timeoutMs: number };
	defaultEnabled: boolean;
	config?: Record<string, unknown>;
	listName: string;
	sourceFile: string;
	packRoot: string;
}

/** All pack-scoped contributions for ONE installed pack. */
export interface PackContributions {
	packId: string; // structural, from the pack root dir name
	packName: string;
	packRoot: string;
	panels: PanelContribution[];
	entrypoints: EntrypointContribution[];
	providers: ProviderContribution[];
	routes?: RouteContribution;
}

/** Structural packId from a pack root: the dir name AFTER `market-packs`, else
 *  the basename. Mirrors `pack-identity.ts::derivePackId` keyed on the root. */
export function packIdFromRoot(packRoot: string): string {
	const segs = packRoot.split(/[\\/]+/).filter((s) => s.length > 0);
	const idx = segs.lastIndexOf("market-packs");
	if (idx >= 0 && idx + 1 < segs.length) return segs[idx + 1] ?? "";
	return segs[segs.length - 1] ?? "";
}

function readYaml(file: string): unknown {
	const raw = fs.readFileSync(file, "utf-8");
	return parse(raw);
}

/**
 * Load every pack-scoped contribution for an installed pack. Tolerant (warn +
 * drop malformed files), except the §5.4 hard conflicts which throw
 * {@link PackContributionError}.
 */
export function loadPackContributions(packRoot: string, manifest: PackManifest): PackContributions {
	const packId = packIdFromRoot(packRoot);
	const out: PackContributions = {
		packId,
		packName: manifest.name,
		packRoot,
		panels: loadPanels(packRoot),
		entrypoints: loadEntrypoints(packRoot, manifest),
		providers: loadProviders(packRoot, manifest),
	};
	const routes = loadRoutes(packRoot, manifest);
	if (routes) out.routes = routes;
	return out;
}

/** Auto-discover `panels/*.yaml`. Duplicate panel id within the pack = hard conflict. */
function loadPanels(packRoot: string): PanelContribution[] {
	const dir = path.join(packRoot, "panels");
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
	} catch {
		return []; // no panels/ dir
	}
	const out: PanelContribution[] = [];
	const seen = new Set<string>();
	for (const f of files.sort()) {
		const sourceFile = path.join(dir, f);
		let data: unknown;
		try {
			data = readYaml(sourceFile);
		} catch (err) {
			console.warn(`[pack-contributions] skipping malformed panel ${sourceFile}: ${String(err)}`);
			continue;
		}
		if (!data || typeof data !== "object" || Array.isArray(data)) {
			console.warn(`[pack-contributions] panel ${sourceFile} is not a mapping; dropping`);
			continue;
		}
		const obj = data as Record<string, unknown>;
		const id = obj.id;
		const entry = obj.entry;
		if (typeof id !== "string" || !PANEL_ID_RE.test(id)) {
			console.warn(`[pack-contributions] panel ${sourceFile} has invalid id; dropping`);
			continue;
		}
		if (typeof entry !== "string" || !isSafeRelativePath(entry)) {
			console.warn(`[pack-contributions] panel '${id}' (${sourceFile}) has unsafe/missing entry; dropping`);
			continue;
		}
		if (seen.has(id)) {
			throw new PackContributionError(
				`pack "${packIdFromRoot(packRoot)}" declares panel id "${id}" more than once; panel ids must be unique within a pack`,
			);
		}
		seen.add(id);
		const panel: PanelContribution = { id, entry, sourceFile, packRoot };
		if (typeof obj.title === "string" && obj.title.length > 0) panel.title = obj.title;
		if (obj.instanceMode === "singleton" || obj.instanceMode === "parameterized") panel.instanceMode = obj.instanceMode;
		if (typeof obj.instanceParam === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(obj.instanceParam)) panel.instanceParam = obj.instanceParam;
		out.push(panel);
	}
	return out;
}

/** Load `entrypoints/<name>.yaml` ONLY for names listed in contents.entrypoints[].
 *  Duplicate entrypoint id within the pack = hard conflict. */
function loadEntrypoints(packRoot: string, manifest: PackManifest): EntrypointContribution[] {
	const listNames = manifest.contents.entrypoints ?? [];
	const dir = path.join(packRoot, "entrypoints");
	const out: EntrypointContribution[] = [];
	const seenId = new Set<string>();
	for (const listName of listNames) {
		if (typeof listName !== "string" || listName.length === 0) continue;
		// Defense-in-depth (validateManifest is the primary guard): a listName must
		// be a safe file basename — never path structure — before it is joined into
		// the entrypoints/ dir. Drop-with-warning keeps the tolerant-loader contract.
		if (!isSafeBasename(listName)) {
			console.warn(`[pack-contributions] entrypoint listName ${JSON.stringify(listName)} is not a safe basename; skipping`);
			continue;
		}
		// Resolve the file; tolerate either .yaml or .yml.
		let sourceFile = path.join(dir, `${listName}.yaml`);
		if (!fs.existsSync(sourceFile)) {
			const alt = path.join(dir, `${listName}.yml`);
			if (fs.existsSync(alt)) sourceFile = alt;
		}
		// Assert the resolved file stays within entrypoints/ (realpath-aware) — no
		// read outside the dir even if the basename guard were ever bypassed.
		if (!isPackPathWithinRoot(dir, sourceFile)) {
			console.warn(`[pack-contributions] entrypoint '${listName}' resolves outside entrypoints/ (${sourceFile}); skipping`);
			continue;
		}
		let data: unknown;
		try {
			data = readYaml(sourceFile);
		} catch (err) {
			console.warn(`[pack-contributions] skipping missing/malformed entrypoint '${listName}' (${sourceFile}): ${String(err)}`);
			continue;
		}
		// Reuse the tool-contributions field validator by wrapping the single object.
		const parsed = parseEntrypoints([data], sourceFile);
		if (parsed.length === 0) {
			console.warn(`[pack-contributions] entrypoint '${listName}' (${sourceFile}) failed validation; dropping`);
			continue;
		}
		const base = parsed[0];
		if (seenId.has(base.id)) {
			throw new PackContributionError(
				`pack "${packIdFromRoot(packRoot)}" declares entrypoint id "${base.id}" more than once; entrypoint ids must be unique within a pack`,
			);
		}
		seenId.add(base.id);
		out.push({ ...base, listName, sourceFile, packRoot });
	}
	return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return Math.min(max, Math.max(min, n));
}

// §0.2: providers are pack-scoped, keyed (packId, contributionId).
// They are NOT an EntityType; two packs may each ship id "memory" and both stay active.
export function loadProviders(packRoot: string, manifest: PackManifest): ProviderContribution[] {
	const listNames = manifest.contents.providers ?? [];
	const dir = path.join(packRoot, "providers");
	const out: ProviderContribution[] = [];
	const seenId = new Set<string>();
	for (const listName of listNames) {
		if (typeof listName !== "string" || listName.length === 0) continue;
		if (!isSafeBasename(listName)) {
			console.warn(`[pack-contributions] provider listName ${JSON.stringify(listName)} is not a safe basename; skipping`);
			continue;
		}
		let sourceFile = path.join(dir, `${listName}.yaml`);
		if (!fs.existsSync(sourceFile)) {
			const alt = path.join(dir, `${listName}.yml`);
			if (fs.existsSync(alt)) sourceFile = alt;
		}
		if (!isPackPathWithinRoot(dir, sourceFile)) {
			console.warn(`[pack-contributions] provider '${listName}' resolves outside providers/ (${sourceFile}); skipping`);
			continue;
		}
		let data: unknown;
		try {
			data = readYaml(sourceFile);
		} catch (err) {
			console.warn(`[pack-contributions] skipping missing/malformed provider '${listName}' (${sourceFile}): ${String(err)}`);
			continue;
		}
		if (!isPlainObject(data)) {
			console.warn(`[pack-contributions] provider '${listName}' (${sourceFile}) is not a mapping; dropping`);
			continue;
		}
		const id = data.id;
		if (typeof id !== "string" || !PROVIDER_ID_RE.test(id)) {
			console.warn(`[pack-contributions] provider '${listName}' (${sourceFile}) has invalid id; dropping`);
			continue;
		}
		const kindRaw = data.kind;
		const kind = kindRaw === undefined ? "generic" : kindRaw;
		if (typeof kind !== "string" || !PROVIDER_KINDS.has(kind)) {
			console.warn(`[pack-contributions] provider '${id}' (${sourceFile}) has invalid kind; dropping`);
			continue;
		}
		const mod = data.module;
		if (typeof mod !== "string" || !isSafeRelativePath(mod)) {
			console.warn(`[pack-contributions] provider '${id}' (${sourceFile}) has unsafe/missing module; dropping`);
			continue;
		}
		const resolvedModule = path.resolve(path.dirname(sourceFile), mod);
		if (!isPackPathWithinRoot(packRoot, resolvedModule)) {
			console.warn(`[pack-contributions] provider '${id}' (${sourceFile}) module resolves outside pack root; dropping`);
			continue;
		}
		const hooksRaw = data.hooks ?? [];
		if (!Array.isArray(hooksRaw) || !hooksRaw.every((h): h is string => typeof h === "string")) {
			console.warn(`[pack-contributions] provider '${id}' (${sourceFile}) has invalid hooks; dropping`);
			continue;
		}
		const unknownHook = hooksRaw.find((h) => !PROVIDER_HOOKS.has(h));
		if (unknownHook !== undefined) {
			console.warn(`[pack-contributions] provider '${id}' (${sourceFile}) declares unknown hook ${JSON.stringify(unknownHook)}; dropping`);
			continue;
		}
		if (seenId.has(id)) {
			throw new PackContributionError(
				`pack "${packIdFromRoot(packRoot)}" declares provider id "${id}" more than once; provider ids must be unique within a pack`,
			);
		}
		seenId.add(id);
		const budgetRaw = isPlainObject(data.budget) ? data.budget : {};
		const provider: ProviderContribution = {
			id,
			kind: kind as ProviderContribution["kind"],
			module: mod,
			hooks: hooksRaw,
			budget: {
				maxTokens: clampNumber(budgetRaw.maxTokens, 1600, 64, 8192),
				timeoutMs: clampNumber(budgetRaw.timeoutMs, 1500, 100, 10000),
			},
			defaultEnabled: data.defaultEnabled !== false,
			listName,
			sourceFile,
			packRoot,
		};
		if (typeof data.runtime === "string" && data.runtime.length > 0) provider.runtime = data.runtime;
		if (isPlainObject(data.config)) provider.config = data.config;
		out.push(provider);
	}
	return out;
}

/** Build the pack-level RouteContribution from pack.yaml.routes. Duplicate route
 *  name within the allowlist = hard conflict. */
function loadRoutes(packRoot: string, manifest: PackManifest): RouteContribution | undefined {
	const ref = manifest.routes;
	if (!ref || !ref.module) return undefined;
	if (!isSafeRelativePath(ref.module)) {
		console.warn(`[pack-contributions] pack "${packIdFromRoot(packRoot)}" routes.module "${ref.module}" is unsafe; dropping routes`);
		return undefined;
	}
	const names = (ref.names ?? []).filter((n): n is string => typeof n === "string" && ROUTE_NAME_RE.test(n));
	const seen = new Set<string>();
	for (const n of names) {
		if (seen.has(n)) {
			throw new PackContributionError(
				`pack "${packIdFromRoot(packRoot)}" declares route name "${n}" more than once; route names must be unique within a pack`,
			);
		}
		seen.add(n);
	}
	return {
		module: ref.module,
		names,
		sourceFile: path.join(packRoot, "pack.yaml"),
		packRoot,
	};
}
