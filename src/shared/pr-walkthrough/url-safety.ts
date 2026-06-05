const DEFAULT_TRUSTED_HOSTS = new Set([
	"github.com",
	"www.github.com",
	"api.github.com",
	"raw.githubusercontent.com",
	"gist.githubusercontent.com",
]);

export function safeExternalUrl(value: unknown, extraTrustedHosts: string[] = []): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(value.trim());
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
	const host = parsed.hostname.replace(/\.$/, "").toLowerCase();
	if (!isTrustedExternalHost(host, extraTrustedHosts)) return undefined;
	parsed.hash = parsed.hash || "";
	return parsed.toString();
}

export function isTrustedExternalHost(host: string, extraTrustedHosts: string[] = []): boolean {
	const normalized = host.replace(/\.$/, "").toLowerCase();
	if (DEFAULT_TRUSTED_HOSTS.has(normalized)) return true;
	return extraTrustedHosts.map(item => item.replace(/\.$/, "").toLowerCase()).includes(normalized);
}

const HOSTNAME_PATTERN = /^[a-z0-9.-]+$/;

/**
 * Normalize a single managed trusted host. Accepts a bare host or a pasted URL.
 * Returns the cleaned host (lowercase, trailing dot stripped) or undefined when invalid.
 * Rejects values that still contain a path, whitespace, credentials, or a port.
 */
export function normalizeTrustedHost(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	let candidate = value.trim();
	if (!candidate) return undefined;
	if (candidate.includes("://")) {
		try {
			candidate = new URL(candidate).hostname;
		} catch {
			return undefined;
		}
	}
	candidate = candidate.trim().toLowerCase().replace(/\.$/, "");
	if (!candidate) return undefined;
	// Reject anything that is not a bare hostname (paths, whitespace, creds, ports).
	if (/[\s/@:]/.test(candidate) || candidate.includes("://")) return undefined;
	if (!HOSTNAME_PATTERN.test(candidate)) return undefined;
	// Require EVERY label to be a valid DNS label: non-empty, <=63 chars, and no
	// leading/trailing hyphen. Rejects ".example.com", "example..com", "-x.com", etc.
	if (!candidate.split(".").every(label => label.length > 0 && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-"))) return undefined;
	return candidate;
}

/**
 * Normalize a managed trusted-host list. Accepts a string[] (preferences shape)
 * or a comma-separated string. Drops invalid/empty entries and dedupes preserving
 * first-seen order. This is the single normalizer used on save and on read.
 */
export function normalizeTrustedHosts(value: unknown): string[] {
	const raw: unknown[] = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(",")
			: [];
	const seen = new Set<string>();
	const result: string[] = [];
	for (const entry of raw) {
		const normalized = normalizeTrustedHost(entry);
		if (!normalized || seen.has(normalized)) continue;
		// Managed list holds only EXTRA hosts; baseline DEFAULT_TRUSTED_HOSTS are
		// always trusted via isTrustedExternalHost regardless of this list.
		if (DEFAULT_TRUSTED_HOSTS.has(normalized)) continue;
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}
