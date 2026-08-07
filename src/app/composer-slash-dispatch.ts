import type { RegisteredLauncher } from "./pack-entrypoints.js";

/** Runtime identity supplied by the server on `session.state.runtime`. */
export type ComposerRuntime = "pi" | "claude-agent-sdk";

/** A server-authoritative claim that reserves a slash token without exposing a
 * skill body, path, or menu item. */
export interface ComposerSlashCollisionClaim {
	name: string;
}

/** The autocomplete-safe portion of the server's slash-skill catalogue. */
export interface ComposerSlashSkill {
	name: string;
	description: string;
	argumentHint?: string;
	source: string;
	/** `false` keeps a server-recognised skill out of the menu, but still masks launchers. */
	userInvocable?: boolean;
}

export interface ComposerSlashMenuItem extends ComposerSlashSkill {
	/** The compound launcher key. Present only for pack launchers. */
	entrypointKey?: string;
}

/** A snapshot shared by autocomplete and send-time command resolution. */
export interface ComposerSlashRegistry {
	/** Every server-recognised skill, including non-menu collision claims. */
	readonly skills: readonly ComposerSlashSkill[];
	/** User-visible skills and unambiguous, unmasked pack launchers. */
	readonly menuItems: readonly ComposerSlashMenuItem[];
	readonly skillNames: ReadonlySet<string>;
	readonly launchersByName: ReadonlyMap<string, RegisteredLauncher>;
}

export type ComposerSlashDispatch =
	| { kind: "compact" }
	| { kind: "unsupported-compact" }
	| { kind: "unavailable-compact" }
	| { kind: "skill" }
	| { kind: "launcher"; entrypointKey: string; label: string; body: Record<string, unknown> };

const COMMAND_NAME = /^[A-Za-z0-9_.-]+$/;
const isCompactName = (name: string): boolean => name.toLowerCase() === "compact";

/**
 * Build the command inventory from the current server catalogue and current pack
 * launcher registry. Skills claim their exact names even when hidden from the
 * menu; duplicate bare launcher ids are deliberately not dispatchable.
 */
export function createComposerSlashRegistry(input: {
	skills: ReadonlyArray<ComposerSlashSkill>;
	collisionClaims?: ReadonlyArray<ComposerSlashCollisionClaim>;
	launchers: ReadonlyArray<RegisteredLauncher>;
	runtime: ComposerRuntime | undefined;
}): ComposerSlashRegistry {
	const skills = input.skills.filter((skill): skill is ComposerSlashSkill =>
		!!skill
		&& typeof skill.name === "string"
		&& COMMAND_NAME.test(skill.name)
		&& typeof skill.description === "string",
	);
	const skillNames = new Set(skills.map((skill) => skill.name));
	for (const claim of input.collisionClaims ?? []) {
		if (claim && typeof claim.name === "string" && COMMAND_NAME.test(claim.name)) skillNames.add(claim.name);
	}
	const launchersById = new Map<string, RegisteredLauncher[]>();
	for (const launcher of input.launchers) {
		if (!launcher || !COMMAND_NAME.test(launcher.id)) continue;
		const matches = launchersById.get(launcher.id) ?? [];
		matches.push(launcher);
		launchersById.set(launcher.id, matches);
	}

	const launchersByName = new Map<string, RegisteredLauncher>();
	for (const [name, matches] of launchersById) {
		// A skill always owns the same exact token. A bare composer token cannot
		// choose between duplicate pack-local ids, even though their compound keys
		// are individually routable by other surfaces.
		if (!skillNames.has(name) && matches.length === 1) launchersByName.set(name, matches[0]);
	}

	const menuItems: ComposerSlashMenuItem[] = [
		...skills.filter((skill) => skill.userInvocable !== false && !isCompactName(skill.name)),
		...[...launchersByName.values()].filter((launcher) => !isCompactName(launcher.id)).map((launcher) => ({
			name: launcher.id,
			description: launcher.label,
			source: "pack",
			entrypointKey: launcher.key,
		})),
	];
	if (input.runtime === "pi") {
		menuItems.push({ name: "compact", description: "Compact conversation", source: "built-in" });
	}
	return { skills, menuItems, skillNames, launchersByName };
}

/** Resolve only exact full-composer commands. Skills intentionally fall through to
 * the ordinary prompt path, where the server owns expansion and replay snapshots. */
export function resolveComposerSlashDispatch(
	text: string,
	input: { runtime: ComposerRuntime | undefined; registry: ComposerSlashRegistry },
): ComposerSlashDispatch | undefined {
	if (text.trim().toLowerCase() === "/compact") {
		if (input.runtime === "claude-agent-sdk") return { kind: "unsupported-compact" };
		if (input.runtime === "pi") return { kind: "compact" };
		// Do not optimistically assume Pi while a session identity is loading: that
		// could both expose local compaction and leak the SDK's bundled command.
		return { kind: "unavailable-compact" };
	}
	const match = text.trim().match(/^\/([A-Za-z0-9_.-]+)(?:\s+([\s\S]+))?$/);
	if (!match) return undefined;
	const [, name, rawArgument = ""] = match;
	// A recognised skill must reach the existing server expansion pipeline, not a
	// colliding pack launcher.
	if (input.registry.skillNames.has(name)) return { kind: "skill" };
	const launcher = input.registry.launchersByName.get(name);
	if (!launcher) return undefined;
	const argument = rawArgument.trim();
	if (!argument) return { kind: "launcher", entrypointKey: launcher.key, label: launcher.label, body: {} };
	if (launcher.packId === "pr-walkthrough" || launcher.id === "pr-walkthrough") {
		return /^\d+$/.test(argument)
			? { kind: "launcher", entrypointKey: launcher.key, label: launcher.label, body: { prNumber: Number(argument) } }
			: { kind: "launcher", entrypointKey: launcher.key, label: launcher.label, body: { prUrl: argument } };
	}
	return { kind: "launcher", entrypointKey: launcher.key, label: launcher.label, body: { input: argument } };
}
