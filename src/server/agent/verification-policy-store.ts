/**
 * YAML-backed store for the verification-policy override.
 * File: <configDir>/verification-policy.yaml
 *
 * Mirrors ToolGroupPolicyStore's shape (see tool-group-policy-store.ts):
 * builtin defaults are injected once at boot via `setBuiltinRaw`, and the
 * on-disk file supplies a local override layer re-read on every access.
 * Unlike ToolGroupPolicyStore (a flat `Record<string, GrantPolicy>` map),
 * VerificationPolicy is a fixed-shape object, so this store deliberately
 * stays at the RAW (pre-validation, pre-defaulting) layer — merging happens
 * per-field via `mergeVerificationPolicyRaw`, and the single defaulting/
 * validation pass (`resolveVerificationPolicy`) runs once, downstream, after
 * every cascade layer (builtin -> server -> project) has been combined. See
 * docs/design/verification-policy-seam.md §2.
 */

import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { mergeVerificationPolicyRaw } from "./verification-logic.js";

export class VerificationPolicyStore {
	private readonly policyFile: string;
	private builtinRaw: Record<string, unknown> = {};

	constructor(configDir: string) {
		this.policyFile = path.join(configDir, "verification-policy.yaml");
	}

	/**
	 * Inject the builtin defaults (parsed `defaults/verification-policy.yaml`
	 * raw, NOT yet run through `resolveVerificationPolicy`). Invoked once at
	 * boot for the server-scope instance, same as
	 * `ToolGroupPolicyStore.setBuiltins`. Per-project instances
	 * (`ProjectContext`) intentionally never receive this call — they only
	 * ever contribute the project-local override layer; `ConfigCascade`
	 * layers the true builtin defaults in separately.
	 */
	setBuiltinRaw(raw: Record<string, unknown>): void {
		this.builtinRaw = { ...raw };
	}

	/** Read the raw local override YAML from disk. Empty object if absent/invalid. */
	private getLocalRaw(): Record<string, unknown> {
		try {
			const raw = fs.readFileSync(this.policyFile, "utf-8");
			const data = parse(raw);
			return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
		} catch {
			// File doesn't exist or is invalid — no local override.
			return {};
		}
	}

	/**
	 * Raw builtin merged with the local on-disk override (gateRoles merged by
	 * key, everything else last-write-wins) — NOT yet defaulted/validated. See
	 * `resolveVerificationPolicy` for the final typed value.
	 */
	getMergedRaw(): Record<string, unknown> {
		return mergeVerificationPolicyRaw(this.builtinRaw, this.getLocalRaw());
	}
}
