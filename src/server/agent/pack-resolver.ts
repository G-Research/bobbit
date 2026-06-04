/**
 * The single resolver — one pipeline, pluggable loaders.
 *
 * {@link PackResolver} walks ONE ordered list of {@link PackEntry} packs
 * (low→high priority) and, for a given {@link EntityType}, produces the
 * resolved entities: a later (higher-priority) entry shadows an earlier
 * same-name entry, and shadowed entries are retained for conflict UI.
 *
 * The loaders below are PURE: `(entry) → entities`. They contain no
 * precedence logic — that lives entirely in the pipeline. Adding a new
 * entity type (`mcp/`, `panels/`) is adding a loader, not touching the core.
 *
 * See `docs/design/pack-based-marketplace.md` §2.
 */

import path from "node:path";
import type {
	EntityLoader,
	EntityType,
	LoadedEntity,
	PackEntry,
	ResolvedEntity,
} from "./pack-types.js";
import { parseRolesDir, parseToolsDir } from "./builtin-config.js";
import type { Role } from "./role-store.js";
import type { ToolInfo } from "./tool-manager.js";
import { scanSkillDir, scanCommandsDir, type SlashSkill } from "../skills/slash-skills.js";

// ── Pipeline ─────────────────────────────────────────────────────

export class PackResolver {
	constructor(
		private readonly entries: PackEntry[],
		private readonly loaders: EntityLoader<unknown>[],
	) {}

	/** Resolve all entities of `type`. `entries` are ordered low→high priority. */
	resolve<T>(type: EntityType): ResolvedEntity<T>[] {
		const byName = new Map<string, ResolvedEntity<T>>();
		for (const entry of this.entries) {
			// low → high
			if (entry.onlyTypes && !entry.onlyTypes.includes(type)) continue;
			for (const loader of this.loaders) {
				if (loader.type !== type || !loader.supports(entry)) continue;
				for (const { name, item } of loader.load(entry)) {
					const prev = byName.get(name);
					byName.set(name, {
						name,
						item: item as T,
						origin: entry,
						shadows: prev ? [...prev.shadows, prev.origin] : [],
					});
				}
			}
		}
		return [...byName.values()];
	}
}

// ── Shared helpers ───────────────────────────────────────────────

/** Return an entry's pre-loaded entities for a type, if any (adapter hook). */
function preloaded<T>(entry: PackEntry, type: EntityType): LoadedEntity<T>[] | null {
	const pre = entry.preloaded?.[type];
	return pre ? (pre as LoadedEntity<T>[]) : null;
}

// ── Role loader ──────────────────────────────────────────────────

export class RoleLoader implements EntityLoader<Role> {
	readonly type = "roles" as const;

	supports(entry: PackEntry): boolean {
		return !!entry.preloaded?.roles || entry.layout === "defaults-tree";
	}

	load(entry: PackEntry): LoadedEntity<Role>[] {
		const pre = preloaded<Role>(entry, "roles");
		if (pre) return pre;
		return parseRolesDir(path.join(entry.path, "roles")).map((r) => ({ name: r.name, item: r }));
	}
}

// ── Tool loader ──────────────────────────────────────────────────

export class ToolLoader implements EntityLoader<ToolInfo> {
	readonly type = "tools" as const;

	supports(entry: PackEntry): boolean {
		return !!entry.preloaded?.tools || entry.layout === "defaults-tree";
	}

	load(entry: PackEntry): LoadedEntity<ToolInfo>[] {
		const pre = preloaded<ToolInfo>(entry, "tools");
		if (pre) return pre;
		return parseToolsDir(path.join(entry.path, "tools")).map((t) => ({ name: t.name, item: t }));
	}
}

// ── Skill loader ─────────────────────────────────────────────────

export class SkillLoader implements EntityLoader<SlashSkill> {
	readonly type = "skills" as const;

	supports(entry: PackEntry): boolean {
		return (
			!!entry.preloaded?.skills ||
			entry.layout === "defaults-tree" ||
			entry.layout === "skills-flat" ||
			entry.layout === "commands-flat"
		);
	}

	load(entry: PackEntry): LoadedEntity<SlashSkill>[] {
		const pre = preloaded<SlashSkill>(entry, "skills");
		if (pre) return pre;

		let skills: SlashSkill[];
		switch (entry.layout) {
			case "defaults-tree":
				skills = scanSkillDir(path.join(entry.path, "skills"), entry.skillSource ?? "built-in");
				break;
			case "skills-flat":
				skills = scanSkillDir(entry.path, entry.skillSource ?? "custom");
				break;
			case "commands-flat":
				skills = scanCommandsDir(entry.path);
				break;
			default:
				skills = [];
		}
		return skills.map((s) => ({ name: s.name, item: s }));
	}
}

/** The MVP loader set (roles, tools, skills). */
export function defaultLoaders(): EntityLoader<unknown>[] {
	return [
		new RoleLoader() as EntityLoader<unknown>,
		new ToolLoader() as EntityLoader<unknown>,
		new SkillLoader() as EntityLoader<unknown>,
	];
}
