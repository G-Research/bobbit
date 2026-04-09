import { PersonalityStore, type Personality } from "./personality-store.js";

/** Valid personality name pattern: lowercase alphanumeric + hyphens */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

export class PersonalityManager {
	constructor(private store: PersonalityStore) {
	}

	createPersonality(opts: {
		name: string;
		label: string;
		description: string;
		promptFragment: string;
	}): Personality {
		const { name, label, description, promptFragment } = opts;

		if (!name || typeof name !== "string") {
			throw new Error("Missing personality name");
		}
		if (!NAME_PATTERN.test(name)) {
			throw new Error("Personality name must be lowercase alphanumeric + hyphens (e.g. 'my-personality')");
		}
		if (this.store.getLocal(name)) {
			throw new Error(`Personality "${name}" already exists`);
		}

		if (!label || typeof label !== "string") {
			throw new Error("Missing personality label");
		}

		const now = Date.now();
		const personality: Personality = {
			name,
			label,
			description: description || "",
			promptFragment: promptFragment || "",
			createdAt: now,
			updatedAt: now,
		};
		this.store.put(personality);
		return personality;
	}

	getPersonality(name: string): Personality | undefined {
		return this.store.get(name);
	}

	listPersonalities(): Personality[] {
		return this.store.getAll();
	}

	updatePersonality(name: string, updates: {
		label?: string;
		description?: string;
		promptFragment?: string;
	}): boolean {
		return this.store.update(name, updates);
	}

	deletePersonality(name: string): boolean {
		const personality = this.store.get(name);
		if (!personality) return false;
		this.store.remove(name);
		return true;
	}

	/**
	 * Resolve personality names to their definitions.
	 * Returns only personalities that exist, silently skipping unknown names.
	 */
	resolvePersonalities(names: string[]): Array<{ label: string; promptFragment: string }> {
		const result: Array<{ label: string; promptFragment: string }> = [];
		for (const name of names) {
			const personality = this.store.get(name);
			if (personality) {
				result.push({ label: personality.label, promptFragment: personality.promptFragment });
			}
		}
		return result;
	}
}
