import { YamlStore } from "./yaml-store.js";

export interface Personality {
	/** Unique identifier — lowercase alphanumeric + hyphens */
	name: string;
	/** Human-readable display label */
	label: string;
	/** Short tooltip for UI (one line) */
	description: string;
	/** 1-2 sentences injected into system prompt */
	promptFragment: string;
	createdAt: number;
	updatedAt: number;
}

function parsePersonality(data: Record<string, unknown>): Personality | null {
	if (!data.name) return null;
	return {
		name: data.name as string,
		label: (data.label as string) ?? (data.name as string),
		description: (data.description as string) ?? "",
		promptFragment: (data.promptFragment as string) ?? "",
		createdAt: (data.createdAt as number) ?? 0,
		updatedAt: (data.updatedAt as number) ?? 0,
	};
}

function serializePersonality(p: Personality): Record<string, unknown> {
	return {
		name: p.name,
		label: p.label,
		description: p.description,
		promptFragment: p.promptFragment,
		createdAt: p.createdAt,
		updatedAt: p.updatedAt,
	};
}

/**
 * File-backed personality store with builtin cascade support.
 * Each personality is a YAML file in personalities/<name>.yaml.
 */
export class PersonalityStore extends YamlStore<Personality> {
	constructor(configDir: string) {
		super(configDir, {
			subdir: "personalities",
			keyFn: p => p.name,
			parseItem: parsePersonality,
			serializeItem: serializePersonality,
			logPrefix: "[personality-store]",
		});
	}
}
