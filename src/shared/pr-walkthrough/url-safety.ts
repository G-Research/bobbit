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

export function trustedHostsFromEnv(value: string | undefined): string[] {
	return (value ?? "").split(",").map(host => host.trim()).filter(Boolean);
}
