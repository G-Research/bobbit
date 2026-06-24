import { gatewayFetch } from "./gateway-fetch.js";

export type AccountOAuthProviderId = "anthropic" | "openai-codex" | "google-gemini-cli";

export interface AccountOAuthProvider {
	id: AccountOAuthProviderId;
	label: string;
	title: string;
	description: string;
	authenticatedLabel: string;
}

export interface AccountOAuthStatus {
	authenticated: boolean;
	expires?: number;
}

export interface ExpiredAccountOAuthCredential {
	provider: AccountOAuthProviderId;
	label: string;
	expires: number;
	reminderId: string;
}

export const ACCOUNT_OAUTH_PROVIDERS: readonly AccountOAuthProvider[] = [
	{
		id: "anthropic",
		label: "Anthropic",
		title: "Anthropic OAuth",
		description: "OAuth credentials used by agent sessions to access the Anthropic API. Re-authenticate to refresh expired tokens or switch accounts.",
		authenticatedLabel: "Authenticated",
	},
	{
		id: "openai-codex",
		label: "OpenAI",
		title: "OpenAI OAuth",
		description: "OAuth credentials used by agent sessions to access ChatGPT subscription GPT models through the OpenAI Codex provider.",
		authenticatedLabel: "Authenticated",
	},
	{
		id: "google-gemini-cli",
		label: "Google",
		title: "Google OAuth",
		description: "Connect your Google account to run Gemini (Code Assist) in agent sessions. This account path is unofficial and depends on your account's Code Assist quota and Google's terms — separate from a Google AI Studio API key. Re-authenticate to refresh expired tokens or switch accounts.",
		authenticatedLabel: "Authenticated",
	},
];

const ACCOUNT_OAUTH_PROVIDER_LABELS: Record<AccountOAuthProviderId, string> = Object.fromEntries(
	ACCOUNT_OAUTH_PROVIDERS.map((provider) => [provider.id, provider.label]),
) as Record<AccountOAuthProviderId, string>;

const DISMISSED_OAUTH_EXPIRY_REMINDERS_KEY = "bobbit.oauthExpiry.dismissed.v1";

export function accountOAuthProviderLabel(provider: string): string {
	if (provider === "google-gemini-cli" || provider === "google" || provider === "gemini") return "Google";
	if (provider === "openai-codex" || provider === "openai") return "OpenAI";
	if (provider === "anthropic") return "Anthropic";
	return provider;
}

function readDismissedOAuthExpiryReminders(): Set<string> {
	try {
		const raw = localStorage.getItem(DISMISSED_OAUTH_EXPIRY_REMINDERS_KEY);
		if (!raw) return new Set();
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return new Set();
		return new Set(parsed.filter((value): value is string => typeof value === "string"));
	} catch {
		return new Set();
	}
}

function writeDismissedOAuthExpiryReminders(ids: Set<string>): void {
	try {
		if (ids.size === 0) {
			localStorage.removeItem(DISMISSED_OAUTH_EXPIRY_REMINDERS_KEY);
			return;
		}
		localStorage.setItem(DISMISSED_OAUTH_EXPIRY_REMINDERS_KEY, JSON.stringify([...ids].sort()));
	} catch {
		// Storage failures should not block auth or normal app use.
	}
}

function reminderId(provider: AccountOAuthProviderId, expires: number): string {
	return `${provider}:${expires}`;
}

function clearDismissedOAuthExpiryRemindersForProvider(provider: AccountOAuthProviderId): void {
	const dismissed = readDismissedOAuthExpiryReminders();
	let changed = false;
	for (const id of [...dismissed]) {
		if (id.startsWith(`${provider}:`)) {
			dismissed.delete(id);
			changed = true;
		}
	}
	if (changed) writeDismissedOAuthExpiryReminders(dismissed);
}

export function dismissAccountOAuthExpiryReminders(credentials: readonly ExpiredAccountOAuthCredential[]): void {
	const dismissed = readDismissedOAuthExpiryReminders();
	for (const credential of credentials) dismissed.add(credential.reminderId);
	writeDismissedOAuthExpiryReminders(dismissed);
}

function isExpiredExistingCredential(status: unknown, now: number): status is { authenticated: false; expires: number } {
	if (!status || typeof status !== "object") return false;
	const data = status as { authenticated?: unknown; expires?: unknown };
	return data.authenticated === false
		&& typeof data.expires === "number"
		&& Number.isFinite(data.expires)
		&& data.expires < now;
}

export async function getExpiredAccountOAuthCredentials(now = Date.now()): Promise<ExpiredAccountOAuthCredential[]> {
	const dismissed = readDismissedOAuthExpiryReminders();
	const results = await Promise.all(ACCOUNT_OAUTH_PROVIDERS.map(async (provider) => {
		try {
			const res = await gatewayFetch(`/api/oauth/status?provider=${encodeURIComponent(provider.id)}`);
			if (!res.ok) return null;
			const status = await res.json() as AccountOAuthStatus;
			if (status?.authenticated === true) {
				clearDismissedOAuthExpiryRemindersForProvider(provider.id);
				return null;
			}
			if (!isExpiredExistingCredential(status, now)) return null;
			const id = reminderId(provider.id, status.expires);
			if (dismissed.has(id)) return null;
			return {
				provider: provider.id,
				label: ACCOUNT_OAUTH_PROVIDER_LABELS[provider.id],
				expires: status.expires,
				reminderId: id,
			} satisfies ExpiredAccountOAuthCredential;
		} catch {
			return null;
		}
	}));
	return results.filter((credential): credential is ExpiredAccountOAuthCredential => credential !== null);
}
