// Type declarations for the hand-written ESM helper gateway.js.
// Kept alongside gateway.js so the bundled Agent tool group stays
// self-contained (see gateway.js header). extension.ts imports these.

export interface GatewayCreds {
	token: string;
	baseUrl: string;
}

export interface GatewayCredsError {
	error: string;
}

export interface ApiCallOptions {
	retries?: number;
	extraHeaders?: Record<string, string>;
}

export interface ApiCallDetailedResult {
	ok: boolean;
	status: number;
	body: any;
	text: string;
}

export function readGatewayCreds(): GatewayCreds | GatewayCredsError;

export function apiCallDetailed(
	creds: GatewayCreds,
	method: string,
	urlPath: string,
	body?: unknown,
	opts?: ApiCallOptions,
): Promise<ApiCallDetailedResult>;

export function apiCall(
	creds: GatewayCreds,
	method: string,
	urlPath: string,
	body?: unknown,
	opts?: ApiCallOptions,
): Promise<any>;

export function __clearCredsCacheForTesting(): void;
