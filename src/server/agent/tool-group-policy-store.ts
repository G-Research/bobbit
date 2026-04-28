/**
 * YAML-backed store for group-level default tool grant policies.
 * File: .bobbit/config/tool-group-policies.yaml
 *
 * Maps group name → GrantPolicy. Reloads from disk on every read
 * to stay consistent with manual edits (same pattern as ToolManager).
 */

import fs from "node:fs";
import path from "node:path";
import { stringify, parse } from "yaml";
import type { GrantPolicy } from "./role-store.js";

const VALID_POLICIES = new Set<string>(['allow', 'ask', 'never', 'always-ask', 'ask-once', 'never-ask', 'always-allow']);

export class ToolGroupPolicyStore {
	private readonly policyFile: string;
	private builtinPolicies: Record<string, GrantPolicy> = {};

	constructor(configDir: string) {
		this.policyFile = path.join(configDir, "tool-group-policies.yaml");
	}

	setBuiltins(policies: Record<string, GrantPolicy>): void {
		this.builtinPolicies = { ...policies };
	}

	/** Read all group policies from disk. */
	private getLocal(): Record<string, GrantPolicy> {
		const filePath = this.policyFile;
		const result: Record<string, GrantPolicy> = {};
		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			const data = parse(raw);
			if (!data || typeof data !== "object") return result;
			for (const [key, value] of Object.entries(data)) {
				if (typeof value === "string" && VALID_POLICIES.has(value)) {
					result[key] = value as GrantPolicy;
				}
			}
			return result;
		} catch {
			// File doesn't exist or is invalid — return no local overrides.
			return result;
		}
	}

	/** Read all group policies from disk, merged over builtin defaults. */
	getAll(): Record<string, GrantPolicy> {
		return { ...this.builtinPolicies, ...this.getLocal() };
	}

	/** Get the default policy for a specific group. Returns null if not set. */
	getGroupPolicy(group: string): GrantPolicy | null {
		const all = this.getAll();
		return all[group] ?? null;
	}

	/** Set or clear the default policy for a group. Pass null to remove. */
	setGroupPolicy(group: string, policy: GrantPolicy | null): void {
		const all = this.getLocal();
		if (policy === null) {
			delete all[group];
		} else {
			all[group] = policy;
		}
		const filePath = this.policyFile;
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, stringify(all), "utf-8");
	}
}
