/**
 * Sandbox secret/token redaction and merging helpers.
 * Extracted from server.ts (commit: split server.ts).
 *
 * `sandbox_tokens` is a structured array `{key, enabled, value?}[]`;
 * `sandbox_credentials` is a JSON-stringified flat record. Real token values
 * live in the per-project SecretsStore — never on disk under config and
 * never sent to the browser.
 */
import type { SecretsStore } from "./secrets-store.js";
import type { ProjectConfigStore } from "./project-config-store.js";

/** Redact token values in sandbox config for API responses. Never send real secrets to the browser.
 *  `sandbox_tokens` is a structured array (post-native-YAML); other fields stay flat strings. */
export function redactSandboxSecrets(config: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...config };
	if (Array.isArray(result.sandbox_tokens)) {
		result.sandbox_tokens = (result.sandbox_tokens as Array<any>).map((e: any) => ({
			...e,
			value: e.value ? "__REDACTED__" : "",
		}));
	}
	if (typeof result.sandbox_credentials === "string" && result.sandbox_credentials) {
		try {
			const obj = JSON.parse(result.sandbox_credentials);
			if (typeof obj === "object" && obj !== null) {
				const redacted: Record<string, string> = {};
				for (const [k, v] of Object.entries(obj)) {
					redacted[k] = v ? "__REDACTED__" : "";
				}
				result.sandbox_credentials = JSON.stringify(redacted);
			}
		} catch { /* leave as-is */ }
	}
	return result;
}

/** Redact token values in resolved config (with source annotations).
 *  `sandbox_tokens.value` is now a structured array; sandbox_credentials remains a JSON string. */
export function redactSandboxSecretsResolved(config: Record<string, { value: unknown; source: string }>): Record<string, { value: unknown; source: string }> {
	const result = { ...config };
	if (result.sandbox_tokens && Array.isArray(result.sandbox_tokens.value)) {
		result.sandbox_tokens = {
			...result.sandbox_tokens,
			value: (result.sandbox_tokens.value as Array<any>).map((e: any) => ({
				...e,
				value: e.value ? "__REDACTED__" : "",
			})),
		};
	}
	for (const key of ["sandbox_credentials"] as const) {
		if (!result[key]) continue;
		const entry = { ...result[key] };
		if (key === "sandbox_credentials" && typeof entry.value === "string" && entry.value) {
			try {
				const obj = JSON.parse(entry.value);
				if (typeof obj === "object" && obj !== null) {
					const redacted: Record<string, string> = {};
					for (const [k, v] of Object.entries(obj)) {
						redacted[k] = v ? "__REDACTED__" : "";
					}
					entry.value = JSON.stringify(redacted);
					result[key] = entry;
				}
			} catch { /* leave as-is */ }
		}
	}
	return result;
}

/** Merge secrets into sandbox_tokens for GET responses (adds value from SecretsStore).
 *  Operates on a config object whose `sandbox_tokens` is the structured array (or absent). */
export function mergeSecretsIntoTokens(config: Record<string, unknown>, secretsStore: SecretsStore): void {
	const tokens = config.sandbox_tokens;
	if (!Array.isArray(tokens)) return;
	const secrets = secretsStore.getAll();
	config.sandbox_tokens = (tokens as Array<any>).map((e: any) => ({
		...e,
		value: secrets[e.key] || e.value || "",
	}));
}

/** Strip redacted sentinel from incoming structured sandbox_tokens, persisting real values
 *  to the SecretsStore. Returns the structured array suitable for setSandboxTokens(). */
export function mergeSandboxTokensStructured(
	incoming: Array<{ key: string; enabled?: boolean; value?: string }>,
	secretsStore?: SecretsStore | null,
): Array<{ key: string; enabled: boolean }> {
	if (secretsStore) {
		const updates: Record<string, string> = {};
		for (const e of incoming) {
			if (!e || typeof e.key !== "string") continue;
			if (e.value === "__REDACTED__") {
				// Keep existing
			} else if (e.value) {
				updates[e.key] = e.value;
			} else {
				updates[e.key] = "";
			}
		}
		secretsStore.update(updates);
	}
	return incoming
		.filter(e => e && typeof e.key === "string")
		.map(e => ({ key: e.key, enabled: e.enabled !== false }));
}

/** Merge redacted sentinel values with existing stored values before saving. */
export function mergeSandboxSecrets(updates: Record<string, string>, configStore: ProjectConfigStore, secretsStore?: SecretsStore | null): void {
	// sandbox_tokens is now handled via mergeSandboxTokensStructured at the
	// migrated-fields layer in the PUT handler. This helper only handles the
	// remaining legacy flat sandbox_credentials key.
	void configStore;
	void secretsStore;
	if (updates.sandbox_credentials) {
		try {
			const incoming = JSON.parse(updates.sandbox_credentials) as Record<string, string>;
			const existingRaw = configStore.get("sandbox_credentials") || "";
			let existingObj: Record<string, string> = {};
			try { existingObj = existingRaw ? JSON.parse(existingRaw) : {}; } catch { /* ignore */ }
			for (const [k, v] of Object.entries(incoming)) {
				if (v === "__REDACTED__") {
					incoming[k] = existingObj[k] || "";
				}
			}
			updates.sandbox_credentials = JSON.stringify(incoming);
		} catch { /* leave as-is */ }
	}
}
