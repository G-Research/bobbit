// Hindsight's pack-owned, pure EP-7 settings adapter. This module deliberately
// performs no networking, model discovery, Docker/Compose work, or secret I/O.
// The server bridge owns EP-7 revision/secret resolution and calls these helpers
// only to validate/materialize an explicit generic-runtime control request.

export const DEFAULT_HINDSIGHT_OCI_IMAGE = "ghcr.io/vectorize-io/hindsight:0.8.6@sha256:274704505b2720ac9a5c816c559044c1e8c6b51d47017317ae049ed2952f5ab1";
export const HINDSIGHT_SETTINGS_SECRET_FIELDS = ["apiKey", "localLlmApiKey", "registryCredentials", "externalDatabaseUrl"] as const;
export type HindsightRuntimeMode = "external" | "local" | "docker" | "compose";
export type LocalLlmProvider = "openai-compatible" | "ollama";
export type DatabaseMode = "managed-volume" | "external";

export interface HindsightRuntimeSettings {
	runtimeMode: HindsightRuntimeMode;
	externalUrl?: string;
	localLlmProvider: LocalLlmProvider;
	localLlmModelId?: string;
	localLlmBaseUrl?: string;
	localLlmContextTokens: number;
	localLlmMaxOutputTokens: number;
	localLlmResidency: "resident" | "request";
	localLlmKeepAlive: number;
	ociImage: string;
	databaseMode: DatabaseMode;
	dataDir?: string;
}

export interface RuntimeSecrets {
	apiKey?: string;
	localLlmApiKey?: string;
	registryCredentials?: string;
	externalDatabaseUrl?: string;
}

export interface OciReference {
	reference: string;
	pinned: boolean;
	warning?: "OCI_REFERENCE_MUTABLE_TAG";
}

export interface RedactedModelDiagnostic {
	provider: LocalLlmProvider;
	modelId: string;
	endpointHost: string;
	contextTokens: number;
	maxOutputTokens: number;
	residency: "resident";
	keepAliveSeconds: number;
	fallback: "disabled";
	/** Populated by the runtime only after a successful explicit start. */
	observedLoadId?: string;
}

export type RuntimeSettingsValidation =
	| { ok: true; settings: HindsightRuntimeSettings; oci: OciReference; model?: RedactedModelDiagnostic; warnings: string[] }
	| { ok: false; code: string };

const DEFAULTS: HindsightRuntimeSettings = {
	runtimeMode: "external",
	localLlmProvider: "openai-compatible",
	localLlmContextTokens: 32_768,
	localLlmMaxOutputTokens: 4_096,
	localLlmResidency: "resident",
	localLlmKeepAlive: 3_600,
	ociImage: DEFAULT_HINDSIGHT_OCI_IMAGE,
	databaseMode: "managed-volume",
};
const CONTROL_OR_SPACE = /[\0-\x20\x7f;&|`$<>\\]/;
const OCI_RE = /^(?=.{1,255}$)(?:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?::(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9][A-Za-z0-9._-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function positiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
function asMode(value: unknown): HindsightRuntimeMode {
	return value === "local" || value === "docker" || value === "compose" || value === "external" ? value : "external";
}
function asProvider(value: unknown): LocalLlmProvider {
	return value === "ollama" || value === "openai-compatible" ? value : DEFAULTS.localLlmProvider;
}
function asDatabaseMode(value: unknown): DatabaseMode {
	return value === "external" || value === "managed-volume" ? value : DEFAULTS.databaseMode;
}
function textToken(value: string | undefined): boolean {
	return !!value && value.length <= 256 && !CONTROL_OR_SPACE.test(value);
}

/** Syntax-only OCI parsing. It intentionally never contacts a registry. */
export function parseOciReference(value: unknown): { ok: true; value: OciReference } | { ok: false; code: "HINDSIGHT_OCI_REFERENCE_INVALID" } {
	if (typeof value !== "string" || !value || CONTROL_OR_SPACE.test(value) || value.includes("://") || value.includes("//") || value.includes("..") || !OCI_RE.test(value)) {
		return { ok: false, code: "HINDSIGHT_OCI_REFERENCE_INVALID" };
	}
	const pinned = /@sha256:[a-f0-9]{64}$/.test(value);
	return { ok: true, value: { reference: value, pinned, ...(!pinned ? { warning: "OCI_REFERENCE_MUTABLE_TAG" as const } : {}) } };
}

/** Removes credentials, paths, queries, and fragments from diagnostic output. */
export function redactEndpointHost(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 2_048 || CONTROL_OR_SPACE.test(value)) return undefined;
	try {
		const url = new URL(value);
		if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || !url.hostname) return undefined;
		return url.port ? `${url.hostname}:${url.port}` : url.hostname;
	} catch { return undefined; }
}

/** A loopback model endpoint never needs a placeholder API key. */
export function isLoopbackHttpEndpoint(value: unknown): boolean {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash) return false;
		const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
		return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
	} catch { return false; }
}

export function resolveHindsightRuntimeSettings(values: Readonly<Record<string, unknown>>): HindsightRuntimeSettings {
	return {
		runtimeMode: asMode(values.runtimeMode),
		...(nonEmptyString(values.externalUrl) ? { externalUrl: nonEmptyString(values.externalUrl) } : {}),
		localLlmProvider: asProvider(values.localLlmProvider),
		...(nonEmptyString(values.localLlmModelId) ? { localLlmModelId: nonEmptyString(values.localLlmModelId) } : {}),
		...(nonEmptyString(values.localLlmBaseUrl) ? { localLlmBaseUrl: nonEmptyString(values.localLlmBaseUrl) } : {}),
		localLlmContextTokens: positiveInt(values.localLlmContextTokens, DEFAULTS.localLlmContextTokens),
		localLlmMaxOutputTokens: positiveInt(values.localLlmMaxOutputTokens, DEFAULTS.localLlmMaxOutputTokens),
		localLlmResidency: values.localLlmResidency === "request" ? "request" : "resident",
		localLlmKeepAlive: positiveInt(values.localLlmKeepAlive, DEFAULTS.localLlmKeepAlive),
		ociImage: nonEmptyString(values.ociImage) ?? DEFAULT_HINDSIGHT_OCI_IMAGE,
		databaseMode: asDatabaseMode(values.databaseMode),
		...(nonEmptyString(values.dataDir) ? { dataDir: nonEmptyString(values.dataDir) } : {}),
	};
}

export function localModelDiagnostic(settings: HindsightRuntimeSettings, observedLoadId?: string): RedactedModelDiagnostic | undefined {
	if (settings.runtimeMode === "external") return undefined;
	const endpointHost = redactEndpointHost(settings.localLlmBaseUrl);
	if (!endpointHost || !settings.localLlmModelId || settings.localLlmResidency !== "resident") return undefined;
	return {
		provider: settings.localLlmProvider, modelId: settings.localLlmModelId, endpointHost,
		contextTokens: settings.localLlmContextTokens, maxOutputTokens: settings.localLlmMaxOutputTokens,
		residency: "resident", keepAliveSeconds: settings.localLlmKeepAlive, fallback: "disabled",
		...(observedLoadId && textToken(observedLoadId) ? { observedLoadId } : {}),
	};
}

/** Validate only; callers may safely use this during EP-7 PATCH processing. */
/**
 * Syntax validation for an EP-7 save is deliberately inert: incomplete
 * credentials/model configuration is persisted as dormant and is checked only
 * by the explicit start materializer. `requireStartConfiguration` is therefore
 * false for PATCH and true for generic runtime control.
 */
export function validateHindsightRuntimeSettings(values: Readonly<Record<string, unknown>>, secrets: Readonly<RuntimeSecrets> = {}, requireStartConfiguration = false): RuntimeSettingsValidation {
	const settings = resolveHindsightRuntimeSettings(values);
	const parsedImage = parseOciReference(settings.ociImage);
	if (!parsedImage.ok) return parsedImage;
	const warnings = parsedImage.value.warning ? [parsedImage.value.warning] : [];
	if (settings.runtimeMode === "external") {
		if (settings.externalUrl !== undefined && !redactEndpointHost(settings.externalUrl)) return { ok: false, code: "HINDSIGHT_EXTERNAL_URL_INVALID" };
		if (requireStartConfiguration && !redactEndpointHost(settings.externalUrl)) return { ok: false, code: "HINDSIGHT_EXTERNAL_URL_REQUIRED" };
		return { ok: true, settings, oci: parsedImage.value, warnings };
	}
	// Saving remains inert and accepts a dormant selection. A local/Docker
	// Hindsight 0.8.6 start cannot prove a managed-volume backing, however, so
	// reject it before the generic supervisor records or launches anything.
	if (settings.localLlmResidency !== "resident") return { ok: false, code: "HINDSIGHT_RESIDENCY_REQUIRED" };
	if (requireStartConfiguration && settings.databaseMode === "managed-volume" && (settings.runtimeMode === "local" || settings.runtimeMode === "docker")) {
		return { ok: false, code: "HINDSIGHT_EXTERNAL_DATABASE_SETTING_REQUIRED" };
	}
	if (settings.localLlmModelId !== undefined && !textToken(settings.localLlmModelId)) return { ok: false, code: "HINDSIGHT_LOCAL_MODEL_INVALID" };
	if (settings.localLlmBaseUrl !== undefined && !redactEndpointHost(settings.localLlmBaseUrl)) return { ok: false, code: "HINDSIGHT_LOCAL_ENDPOINT_INVALID" };
	if (!requireStartConfiguration) return { ok: true, settings, oci: parsedImage.value, model: localModelDiagnostic(settings), warnings };
	if (!settings.localLlmModelId || !textToken(settings.localLlmModelId)) return { ok: false, code: "HINDSIGHT_LOCAL_MODEL_REQUIRED" };
	if (!redactEndpointHost(settings.localLlmBaseUrl)) return { ok: false, code: "HINDSIGHT_LOCAL_ENDPOINT_REQUIRED" };
	if (!isLoopbackHttpEndpoint(settings.localLlmBaseUrl) && !nonEmptyString(secrets.localLlmApiKey)) return { ok: false, code: "HINDSIGHT_LOCAL_API_KEY_REQUIRED" };
	if (settings.databaseMode === "external" && !nonEmptyString(secrets.externalDatabaseUrl)) return { ok: false, code: "HINDSIGHT_EXTERNAL_DATABASE_URL_REQUIRED" };
	const model = localModelDiagnostic(settings);
	if (!model) return { ok: false, code: "HINDSIGHT_LOCAL_MODEL_INVALID" };
	return { ok: true, settings, oci: parsedImage.value, model, warnings };
}

/**
 * Materializes only safe, declared generic-runtime setting values. Secret bytes
 * are returned separately for the bridge's EP-7 secret resolver and must never
 * be used in a public projection. Calling this cannot start or probe anything.
 */
export function materializeHindsightRuntimeSettings(values: Readonly<Record<string, unknown>>, revision: string, secrets: Readonly<RuntimeSecrets> = {}) {
	const validated = validateHindsightRuntimeSettings(values, secrets, true);
	if (!validated.ok) return validated;
	const { settings } = validated;
	const runtimeValues: Record<string, string | undefined> = {
		HINDSIGHT_OCI_IMAGE: validated.oci.reference,
		HINDSIGHT_LOCAL_LLM_PROVIDER: settings.localLlmProvider,
		HINDSIGHT_LOCAL_LLM_MODEL_ID: settings.localLlmModelId,
		HINDSIGHT_LOCAL_LLM_BASE_URL: settings.localLlmBaseUrl,
		HINDSIGHT_LOCAL_LLM_CONTEXT_TOKENS: String(settings.localLlmContextTokens),
		HINDSIGHT_LOCAL_LLM_MAX_OUTPUT_TOKENS: String(settings.localLlmMaxOutputTokens),
		HINDSIGHT_LOCAL_LLM_KEEP_ALIVE: String(settings.localLlmKeepAlive),
		HINDSIGHT_DATABASE_MODE: settings.databaseMode,
		...(settings.dataDir ? { HINDSIGHT_DATA_DIR: settings.dataDir } : {}),
	};
	return { ok: true as const, mode: settings.runtimeMode, revision, values: runtimeValues, secrets: { ...secrets }, diagnostic: validated.model, warnings: validated.warnings };
}
