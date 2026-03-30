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
import { bobbitConfigDir } from "../bobbit-dir.js";
import type { GrantPolicy } from "./role-store.js";

/**
 * Extended policy type that includes 'always-allow' for the system fallback
 * and resolved policy values. The base GrantPolicy from role-store covers
 * the configurable policies; this adds the implicit "always allowed" state.
 */
export type ResolvedPolicy = GrantPolicy | 'always-allow';

const POLICY_FILE = () => path.join(bobbitConfigDir(), "tool-group-policies.yaml");

const VALID_POLICIES = new Set<string>(['always-ask', 'ask-once', 'never-ask', 'always-allow']);

export class ToolGroupPolicyStore {
	/** Read all group policies from disk. */
	getAll(): Record<string, ResolvedPolicy> {
		const filePath = POLICY_FILE();
		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			const data = parse(raw);
			if (!data || typeof data !== "object") return {};
			const result: Record<string, ResolvedPolicy> = {};
			for (const [key, value] of Object.entries(data)) {
				if (typeof value === "string" && VALID_POLICIES.has(value)) {
					result[key] = value as ResolvedPolicy;
				}
			}
			return result;
		} catch {
			// File doesn't exist or is invalid — return empty
			return {};
		}
	}

	/** Get the default policy for a specific group. Returns null if not set. */
	getGroupPolicy(group: string): ResolvedPolicy | null {
		const all = this.getAll();
		return all[group] ?? null;
	}

	/** Set or clear the default policy for a group. Pass null to remove. */
	setGroupPolicy(group: string, policy: ResolvedPolicy | null): void {
		const all = this.getAll();
		if (policy === null) {
			delete all[group];
		} else {
			all[group] = policy;
		}
		const filePath = POLICY_FILE();
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, stringify(all), "utf-8");
	}
}
