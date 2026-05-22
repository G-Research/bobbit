import fs from "node:fs";
import { dirname } from "node:path";

import { globalAuthPath } from "../bobbit-dir.js";
import { getAigwUrl } from "./aigw-manager.js";
import type { PreferencesStore } from "./preferences-store.js";

export const CLOUD_PROVIDERS = ["anthropic", "openai", "google"] as const;
export type CloudProviderId = typeof CLOUD_PROVIDERS[number];

export type CloudCredentialType = "oauth" | "api_key" | "env" | "host_token";
export type ProviderStatusValue =
	| "disabled"
	| "enabled_without_credential"
	| "authenticated"
	| "expired"
	| "invalid"
	| "oauth_unavailable"
	| "aigw_bypass";

export interface CloudProviderStatus {
	id: CloudProviderId;
	label: string;
	enabled: boolean;
	configured: boolean;
	authenticated: boolean;
	expired: boolean;
	needsReauth: boolean;
	status: ProviderStatusValue;
	credentialTypes: CloudCredentialType[];
	oauthSupported: boolean;
	apiKeySupported: boolean;
	expires?: number;
	message?: string;
}

export interface CloudAuthStatus {
	mode: "aigw" | "direct-cloud";
	aigwConfigured: boolean;
	authGateRequired: boolean;
	providers: CloudProviderStatus[];
}

export interface CloudProviderCredentialStatus {
	configured: boolean;
	authenticated: boolean;
	expired: boolean;
	invalid: boolean;
	expires?: number;
	credentialTypes: CloudCredentialType[];
	oauthConfigured: boolean;
	oauthUsable: boolean;
	apiKeyConfigured: boolean;
	envConfigured: boolean;
	hostTokenConfigured: boolean;
}

const LABELS: Record<CloudProviderId, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	google: "Google Gemini",
};

const PROVIDER_KEY_ALIASES: Record<CloudProviderId, string[]> = {
	anthropic: ["anthropic"],
	openai: ["openai", "openai-codex"],
	google: ["google", "google-gemini-cli"],
};

const OAUTH_ALIASES: Record<CloudProviderId, string[]> = {
	anthropic: ["anthropic"],
	openai: ["openai-codex", "openai"],
	google: ["google"],
};

const ENV_ALIASES: Record<CloudProviderId, string[]> = {
	anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
	openai: ["OPENAI_API_KEY"],
	google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

const ENABLED_PREFIX = "providerEnabled.";
const MIGRATION_COMPLETE_KEY = "providerEnabled.migrationComplete";

export function providerEnabledPreferenceKey(provider: CloudProviderId): string {
	return `${ENABLED_PREFIX}${provider}`;
}

export function isCloudProviderId(value: string | undefined | null): value is CloudProviderId {
	return !!value && (CLOUD_PROVIDERS as readonly string[]).includes(value);
}

export function normalizeCloudProvider(value: string | undefined | null): CloudProviderId | undefined {
	if (!value) return undefined;
	const normalized = value.toLowerCase();
	if (isCloudProviderId(normalized)) return normalized;
	if (normalized === "openai-codex") return "openai";
	if (normalized === "gemini" || normalized === "google-gemini" || normalized === "google-gemini-cli") return "google";
	return undefined;
}

export function cloudVendorForModelProvider(providerId: string | undefined | null): CloudProviderId | undefined {
	if (!providerId) return undefined;
	const provider = providerId.toLowerCase();
	if (provider === "anthropic") return "anthropic";
	if (provider === "openai" || provider === "openai-codex") return "openai";
	if (provider === "google" || provider === "google-gemini-cli") return "google";
	return undefined;
}

export function cloudVendorForProviderKey(providerId: string | undefined | null): CloudProviderId | undefined {
	if (!providerId) return undefined;
	for (const provider of CLOUD_PROVIDERS) {
		if (PROVIDER_KEY_ALIASES[provider].includes(providerId)) return provider;
	}
	return normalizeCloudProvider(providerId);
}

export function cloudVendorForOAuthProvider(providerId: string | undefined | null): CloudProviderId | undefined {
	if (!providerId) return undefined;
	const normalized = providerId.toLowerCase();
	if (normalized === "anthropic") return "anthropic";
	if (normalized === "openai" || normalized === "openai-codex") return "openai";
	if (normalized === "google" || normalized === "gemini" || normalized === "google-gemini") return "google";
	return undefined;
}

export function isProviderEnabled(prefs: PreferencesStore, provider: CloudProviderId): boolean {
	return prefs.get(providerEnabledPreferenceKey(provider)) === true;
}

export function setProviderEnabled(prefs: PreferencesStore, provider: CloudProviderId, enabled: boolean): void {
	prefs.set(providerEnabledPreferenceKey(provider), enabled === true);
}

export function shouldBypassCloudAuthUx(prefs: PreferencesStore): boolean {
	return Boolean(getAigwUrl(prefs));
}

export function migrateExistingCloudProviderPreferences(prefs: PreferencesStore): void {
	if (prefs.get(MIGRATION_COMPLETE_KEY) === true) return;
	for (const provider of CLOUD_PROVIDERS) {
		const prefKey = providerEnabledPreferenceKey(provider);
		if (prefs.get(prefKey) !== undefined) continue;
		const credentials = getCloudProviderCredentialStatus(prefs, provider);
		if (credentials.authenticated) {
			prefs.set(prefKey, true);
		}
	}
	prefs.set(MIGRATION_COMPLETE_KEY, true);
}

export function getCloudProviderCredentialStatus(
	prefs: PreferencesStore,
	provider: CloudProviderId,
): CloudProviderCredentialStatus {
	const authData = readAuthData();
	const credentialTypes = new Set<CloudCredentialType>();
	let expires: number | undefined;
	let oauthConfigured = false;
	let oauthUsable = false;
	let oauthExpired = false;
	let apiKeyConfigured = false;
	let envConfigured = false;
	let hostTokenConfigured = false;

	for (const keyProvider of PROVIDER_KEY_ALIASES[provider]) {
		if (firstNonEmpty(prefs.get(`providerKey.${keyProvider}`))) {
			apiKeyConfigured = true;
			credentialTypes.add("api_key");
		}
	}

	for (const envVar of ENV_ALIASES[provider]) {
		if (firstNonEmpty(process.env[envVar])) {
			envConfigured = true;
			credentialTypes.add("env");
		}
	}

	for (const authProvider of PROVIDER_KEY_ALIASES[provider]) {
		const entry = authData?.[authProvider];
		if (entry && typeof entry === "object" && firstNonEmpty(entry.key, entry.api_key, entry.apiKey)) {
			apiKeyConfigured = true;
			credentialTypes.add("api_key");
		}
	}

	for (const oauthProvider of OAUTH_ALIASES[provider]) {
		const entry = authData?.[oauthProvider];
		if (!entry || typeof entry !== "object" || entry.type !== "oauth") continue;
		oauthConfigured = true;
		credentialTypes.add("oauth");
		const entryExpires = typeof entry.expires === "number" ? entry.expires : undefined;
		if (entryExpires && (!expires || entryExpires < expires)) expires = entryExpires;
		const expired = Boolean(entryExpires && Date.now() > entryExpires);
		if (expired) oauthExpired = true;
		if (provider !== "google" && firstNonEmpty(entry.access, entry.access_token) && !expired) {
			oauthUsable = true;
		}
	}

	// Reserved for sandbox host-token integrations that do not surface as process.env.
	// Current host-token resolution ultimately maps to env/auth/prefs above, so avoid
	// reporting a duplicate source unless a future resolver sets this explicitly.
	hostTokenConfigured = false;

	const invalid = prefs.get(`providerCredentialInvalid.${provider}`) === true;
	const configured = credentialTypes.size > 0 || oauthConfigured || apiKeyConfigured || envConfigured || hostTokenConfigured;
	const authenticated = !invalid && (apiKeyConfigured || envConfigured || hostTokenConfigured || oauthUsable);

	return {
		configured,
		authenticated,
		expired: !authenticated && oauthExpired,
		invalid,
		...(expires !== undefined ? { expires } : {}),
		credentialTypes: Array.from(credentialTypes),
		oauthConfigured,
		oauthUsable,
		apiKeyConfigured,
		envConfigured,
		hostTokenConfigured,
	};
}

export function hasValidCloudProviderCredential(prefs: PreferencesStore, provider: CloudProviderId): boolean {
	return getCloudProviderCredentialStatus(prefs, provider).authenticated;
}

export function cloudProviderCredentialAliases(provider: CloudProviderId): { providerKeys: string[]; authJson: string[] } {
	return {
		providerKeys: [...PROVIDER_KEY_ALIASES[provider]],
		authJson: Array.from(new Set([...PROVIDER_KEY_ALIASES[provider], ...OAUTH_ALIASES[provider]])),
	};
}

export function removeBobbitOwnedCloudProviderCredentials(
	prefs: PreferencesStore,
	provider: CloudProviderId,
): { removedProviderKeys: string[]; removedAuthJsonEntries: string[] } {
	const aliases = cloudProviderCredentialAliases(provider);
	const removedProviderKeys: string[] = [];
	for (const alias of aliases.providerKeys) {
		const prefKey = `providerKey.${alias}`;
		if (prefs.get(prefKey) !== undefined) removedProviderKeys.push(alias);
		prefs.remove(prefKey);
	}
	prefs.remove(`providerCredentialInvalid.${provider}`);

	const authData = readAuthData();
	const removedAuthJsonEntries: string[] = [];
	if (authData) {
		for (const alias of aliases.authJson) {
			if (Object.prototype.hasOwnProperty.call(authData, alias)) {
				delete authData[alias];
				removedAuthJsonEntries.push(alias);
			}
		}
		if (removedAuthJsonEntries.length > 0) writeAuthData(authData);
	}

	return { removedProviderKeys, removedAuthJsonEntries };
}

export async function hasAnyEnabledAuthenticatedCloudProvider(prefs: PreferencesStore): Promise<boolean> {
	if (shouldBypassCloudAuthUx(prefs)) return true;
	return CLOUD_PROVIDERS.some((provider) => isProviderEnabled(prefs, provider) && hasValidCloudProviderCredential(prefs, provider));
}

export async function getCloudAuthStatus(prefs: PreferencesStore): Promise<CloudAuthStatus> {
	const aigwConfigured = shouldBypassCloudAuthUx(prefs);
	const providers = CLOUD_PROVIDERS.map((provider) => buildProviderStatus(prefs, provider, aigwConfigured));
	const hasEnabledAuthenticated = providers.some((provider) => provider.enabled && provider.authenticated);
	return {
		mode: aigwConfigured ? "aigw" : "direct-cloud",
		aigwConfigured,
		authGateRequired: aigwConfigured ? false : !hasEnabledAuthenticated,
		providers,
	};
}

export function parseModelPref(pref: string | undefined | null): { provider: string; modelId: string } | undefined {
	if (!pref || typeof pref !== "string") return undefined;
	const slash = pref.indexOf("/");
	if (slash <= 0 || slash >= pref.length - 1) return undefined;
	return { provider: pref.slice(0, slash), modelId: pref.slice(slash + 1) };
}

export function cloudVendorForModelPref(pref: string | undefined | null): CloudProviderId | undefined {
	const parsed = parseModelPref(pref);
	return parsed ? cloudVendorForModelProvider(parsed.provider) : undefined;
}

export function cloudModelPrefIsUsable(prefs: PreferencesStore, pref: string | undefined | null): boolean {
	const parsed = parseModelPref(pref);
	if (!parsed) return false;
	const vendor = cloudVendorForModelProvider(parsed.provider);
	if (!vendor) {
		return parsed.provider === "aigw" ? shouldBypassCloudAuthUx(prefs) : true;
	}
	return isProviderEnabled(prefs, vendor) && hasValidCloudProviderCredential(prefs, vendor);
}

function buildProviderStatus(prefs: PreferencesStore, provider: CloudProviderId, aigwConfigured: boolean): CloudProviderStatus {
	const enabled = isProviderEnabled(prefs, provider);
	const credentials = getCloudProviderCredentialStatus(prefs, provider);
	const oauthSupported = provider !== "google";
	const apiKeySupported = true;

	if (aigwConfigured) {
		return {
			id: provider,
			label: LABELS[provider],
			enabled,
			configured: credentials.configured,
			authenticated: false,
			expired: false,
			needsReauth: false,
			status: "aigw_bypass",
			credentialTypes: credentials.credentialTypes,
			oauthSupported,
			apiKeySupported,
			...(credentials.expires !== undefined ? { expires: credentials.expires } : {}),
			message: "AI Gateway is active, so Bobbit will not prompt for this provider.",
		};
	}

	const authenticated = enabled && credentials.authenticated;
	const expired = enabled && credentials.expired;
	const invalid = enabled && credentials.invalid;
	let status: ProviderStatusValue;
	let message: string | undefined;
	if (!enabled) {
		status = "disabled";
	} else if (authenticated) {
		status = "authenticated";
	} else if (provider === "google" && credentials.oauthConfigured && !credentials.apiKeyConfigured && !credentials.envConfigured && !credentials.hostTokenConfigured) {
		status = "oauth_unavailable";
		message = "Google sign-in is not available in this build. Add a Gemini API key instead.";
	} else if (invalid) {
		status = "invalid";
	} else if (expired) {
		status = "expired";
	} else {
		status = "enabled_without_credential";
	}

	const needsReauth = enabled && credentials.configured && !authenticated && (expired || invalid) && status !== "oauth_unavailable";
	return {
		id: provider,
		label: LABELS[provider],
		enabled,
		configured: credentials.configured,
		authenticated,
		expired,
		needsReauth,
		status,
		credentialTypes: credentials.credentialTypes,
		oauthSupported,
		apiKeySupported,
		...(credentials.expires !== undefined ? { expires: credentials.expires } : {}),
		...(message ? { message } : {}),
	};
}

function readAuthData(): Record<string, any> | undefined {
	try {
		const authPath = globalAuthPath();
		if (!fs.existsSync(authPath)) return undefined;
		const parsed = JSON.parse(fs.readFileSync(authPath, "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, any> : undefined;
	} catch {
		return undefined;
	}
}

function writeAuthData(authData: Record<string, any>): void {
	const authPath = globalAuthPath();
	const dir = dirname(authPath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(authPath, JSON.stringify(authData, null, 2), "utf-8");
	try {
		fs.chmodSync(authPath, 0o600);
	} catch {
		// chmod may fail on Windows, that's OK.
	}
}

function firstNonEmpty(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}
