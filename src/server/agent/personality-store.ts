import fs from "node:fs";
import path from "node:path";
import { stringify, parse } from "yaml";

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

/**
 * File-backed personality store. Each personality is a YAML file in personalities/<name>.yaml
 * at the repo root. Version controlled — edits via the UI write back
 * to the same files so they can be committed.
 */
export class PersonalityStore {
	private personalities: Map<string, Personality> = new Map();
	private readonly personalitiesDir: string;

	constructor(configDir: string) {
		this.personalitiesDir = path.join(configDir, "personalities");
		fs.mkdirSync(this.personalitiesDir, { recursive: true });
		this.loadAll();
	}

	private personalityFilePath(name: string): string {
		const filePath = path.join(this.personalitiesDir, `${name}.yaml`);
		const resolved = path.resolve(filePath);
		if (!resolved.startsWith(path.resolve(this.personalitiesDir))) {
			throw new Error(`Invalid personality name: path traversal detected`);
		}
		return filePath;
	}

	private loadAll(): void {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(this.personalitiesDir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
			const filePath = path.join(this.personalitiesDir, entry.name);
			try {
				const raw = fs.readFileSync(filePath, "utf-8");
				const data = parse(raw);
				if (data && typeof data === "object" && data.name) {
					this.personalities.set(data.name, {
						name: data.name,
						label: data.label ?? data.name,
						description: data.description ?? "",
						promptFragment: data.promptFragment ?? "",
						createdAt: data.createdAt ?? 0,
						updatedAt: data.updatedAt ?? 0,
					});
				}
			} catch (err) {
				console.error(`[personality-store] Failed to load ${filePath}:`, err);
			}
		}
	}

	private saveOne(personality: Personality): void {
		const filePath = this.personalityFilePath(personality.name);
		try {
			const content = stringify({
				name: personality.name,
				label: personality.label,
				description: personality.description,
				promptFragment: personality.promptFragment,
				createdAt: personality.createdAt,
				updatedAt: personality.updatedAt,
			}, { lineWidth: 0 });
			fs.writeFileSync(filePath, content, "utf-8");
		} catch (err) {
			console.error(`[personality-store] Failed to save ${filePath}:`, err);
		}
	}

	put(personality: Personality): void {
		this.personalities.set(personality.name, personality);
		this.saveOne(personality);
	}

	get(name: string): Personality | undefined {
		return this.personalities.get(name);
	}

	remove(name: string): void {
		this.personalities.delete(name);
		const filePath = this.personalityFilePath(name);
		try { fs.unlinkSync(filePath); } catch { /* ignore */ }
	}

	/** Re-read all YAML files from disk, picking up external changes */
	reload(): void {
		this.personalities.clear();
		this.loadAll();
	}

	getAll(): Personality[] {
		this.reload();
		return Array.from(this.personalities.values());
	}

	update(name: string, updates: Partial<Omit<Personality, "name" | "createdAt">>): boolean {
		const existing = this.personalities.get(name);
		if (!existing) return false;
		const cleaned: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(updates)) {
			if (v !== undefined) cleaned[k] = v;
		}
		Object.assign(existing, cleaned, { updatedAt: Date.now() });
		this.saveOne(existing);
		return true;
	}
}
