/**
 * Tiny disk-backed secret store dedicated to AgentMemory's bearer token.
 *
 * Lives at <stateDir>/agentmemory-secrets.json (gitignored, mode 0600
 * best-effort). Kept separate from the per-project SecretsStore because
 * the AgentMemory bearer is a system-level setting, not project state.
 *
 * NEVER returns or logs the secret value through any API path. Callers
 * should only invoke `get()` server-side when constructing outbound
 * requests.
 */

import fs from "node:fs";
import path from "node:path";

export interface SecretReader {
	get(key: string): string | undefined;
}

export interface SecretWriter extends SecretReader {
	set(key: string, value: string): void;
	remove(key: string): void;
}

export class AgentMemorySecretStore implements SecretWriter {
	private data: Record<string, string> = {};
	private readonly filePath: string;

	constructor(stateDir: string) {
		this.filePath = path.join(stateDir, "agentmemory-secrets.json");
		this.load();
	}

	private load(): void {
		try {
			if (!fs.existsSync(this.filePath)) return;
			const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
			if (raw && typeof raw === "object" && !Array.isArray(raw)) {
				const out: Record<string, string> = {};
				for (const [k, v] of Object.entries(raw)) {
					if (typeof v === "string") out[k] = v;
				}
				this.data = out;
			}
		} catch { /* ignore */ }
	}

	private save(): void {
		try {
			const dir = path.dirname(this.filePath);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2) + "\n", "utf-8");
			try { fs.chmodSync(this.filePath, 0o600); } catch { /* best-effort */ }
		} catch (err) {
			console.error("[agentmemory-secret-store] Failed to save:", err);
		}
	}

	get(key: string): string | undefined {
		return this.data[key];
	}

	has(key: string): boolean {
		return typeof this.data[key] === "string" && this.data[key].length > 0;
	}

	set(key: string, value: string): void {
		if (!value) { this.remove(key); return; }
		this.data[key] = value;
		this.save();
	}

	remove(key: string): void {
		delete this.data[key];
		this.save();
	}
}
