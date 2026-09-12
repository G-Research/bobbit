import { errorFromResponse } from "./error-helpers.js";
import {
	activeGatewayConnection,
	gatewayFetch,
	normalizeGatewayBaseUrl,
} from "./gateway-fetch.js";

export const MCP_OPERATOR_CREDENTIAL_STORAGE_KEY = "mcp.operator.credentials.v1";
export const MCP_OPERATOR_STORAGE_WARNING = "This browser is paired for this tab, but the authorization could not be saved. Pair it again after reloading.";
export const MCP_OPERATOR_APPROVAL_HEADER = "X-Bobbit-Mcp-Operator";

const CREDENTIAL_PATTERN = /^v1\.[A-Za-z0-9_-]{21}[AQgw]\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const memoryCredentials = new Map<string, string>();
const forgottenGateways = new Set<string>();

export interface McpOperatorPairResult {
	persisted: boolean;
	warning?: string;
}

function gatewayKey(baseUrl = activeGatewayConnection().baseUrl): string {
	return normalizeGatewayBaseUrl(baseUrl);
}

function isCredential(value: unknown): value is string {
	return typeof value === "string" && CREDENTIAL_PATTERN.test(value);
}

function readStoredCredentials(): Record<string, string> {
	if (typeof localStorage === "undefined") return {};
	const raw = localStorage.getItem(MCP_OPERATOR_CREDENTIAL_STORAGE_KEY);
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const safe: Record<string, string> = {};
	for (const [gateway, credential] of Object.entries(parsed)) {
		if (!isCredential(credential)) continue;
		try {
			safe[normalizeGatewayBaseUrl(gateway)] = credential;
		} catch {
			// Ignore malformed or obsolete gateway keys.
		}
	}
	return safe;
}

function credentialForCurrentGateway(): string | undefined {
	const gateway = gatewayKey();
	if (forgottenGateways.has(gateway)) return undefined;
	const memory = memoryCredentials.get(gateway);
	if (memory) return memory;
	try {
		const stored = readStoredCredentials()[gateway];
		if (stored) memoryCredentials.set(gateway, stored);
		return stored;
	} catch {
		return undefined;
	}
}

function rememberCredential(gateway: string, credential: string): McpOperatorPairResult {
	memoryCredentials.set(gateway, credential);
	forgottenGateways.delete(gateway);
	try {
		if (typeof localStorage === "undefined") throw new Error("storage unavailable");
		const stored = readStoredCredentials();
		stored[gateway] = credential;
		localStorage.setItem(MCP_OPERATOR_CREDENTIAL_STORAGE_KEY, JSON.stringify(stored));
		return { persisted: true };
	} catch {
		return { persisted: false, warning: MCP_OPERATOR_STORAGE_WARNING };
	}
}

/** Whether the selected gateway has a credential available in this browser. */
export function hasMcpOperatorCredential(): boolean {
	return credentialForCurrentGateway() !== undefined;
}

/** The purpose-bound header for MCP decisions. Never attach this to generic requests. */
export function mcpOperatorApprovalHeaders(): Record<string, string> {
	const credential = credentialForCurrentGateway();
	return credential ? { [MCP_OPERATOR_APPROVAL_HEADER]: credential } : {};
}

/** Forget only the selected gateway credential after the server rejects it. */
export function forgetMcpOperatorCredential(baseUrl?: string): void {
	const gateway = gatewayKey(baseUrl);
	memoryCredentials.delete(gateway);
	forgottenGateways.add(gateway);
	try {
		if (typeof localStorage === "undefined") return;
		const stored = readStoredCredentials();
		delete stored[gateway];
		if (Object.keys(stored).length === 0) localStorage.removeItem(MCP_OPERATOR_CREDENTIAL_STORAGE_KEY);
		else localStorage.setItem(MCP_OPERATOR_CREDENTIAL_STORAGE_KEY, JSON.stringify(stored));
	} catch {
		// The in-memory tombstone keeps this tab fail-closed if storage is unavailable.
	}
}

/** Exchange a one-use terminal code and pair the selected gateway only. */
export async function pairMcpOperatorBrowser(code: string): Promise<McpOperatorPairResult> {
	const gateway = gatewayKey();
	const trimmedCode = code.trim();
	if (!trimmedCode) {
		const error = new Error("Enter the pairing code shown in the gateway terminal.");
		(error as Error & { code?: string }).code = "MCP_OPERATOR_PAIRING_REQUIRED";
		throw error;
	}
	const response = await gatewayFetch("/api/mcp-operator/pair", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code: trimmedCode }),
	});
	if (!response.ok) throw await errorFromResponse(response, `Could not pair this browser (${response.status})`);
	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new Error("The gateway returned an invalid MCP operator credential.");
	}
	const credential = data && typeof data === "object" ? (data as { credential?: unknown }).credential : undefined;
	if (!isCredential(credential)) throw new Error("The gateway returned an invalid MCP operator credential.");
	return rememberCredential(gateway, credential);
}

/** Test-only reset for module-owned fallback state. */
export function __resetMcpOperatorAuthForTests(): void {
	memoryCredentials.clear();
	forgottenGateways.clear();
}
