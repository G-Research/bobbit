import { sanitizeModelErrorText } from "./model-error-sanitizer.js";

export type ModelProbeErrorCode = "model_not_found" | "authentication_failed" | "rate_limited";
export type ModelProbeUpstreamStatus = 401 | 403 | 404 | 429;

export interface ModelProbeSuccess {
	ok: true;
	modelResolved: string;
	latencyMs: number;
}

export interface ModelProbeFailure {
	ok: false;
	modelResolved?: string;
	latencyMs?: number;
	error: string;
	status?: ModelProbeUpstreamStatus;
	code?: ModelProbeErrorCode;
}

export type ModelProbeResult = ModelProbeSuccess | ModelProbeFailure;

const ERROR_CODES: Record<ModelProbeUpstreamStatus, ModelProbeErrorCode> = {
	401: "authentication_failed",
	403: "authentication_failed",
	404: "model_not_found",
	429: "rate_limited",
};

function trackedStatus(value: unknown): ModelProbeUpstreamStatus | undefined {
	return typeof value === "number" && value in ERROR_CODES
		? value as ModelProbeUpstreamStatus
		: undefined;
}

/**
 * Pi's transport failure is a prefix envelope. Do not scan its body: provider
 * text is untrusted and may contain unrelated status-looking numerals.
 */
function statusFromTrustedPiEnvelope(error: unknown): ModelProbeUpstreamStatus | undefined {
	if (!(error instanceof Error)) return undefined;
	const envelope = /^HTTP request failed\. status=(\d+); url=https?:\/\/[^;\s]+; body=/.exec(error.message);
	return trackedStatus(envelope ? Number(envelope[1]) : undefined);
}

/** Preserve Pi's trusted transport envelope without exposing provider bodies. */
export function classifyModelProbeError(error: unknown): { status?: ModelProbeUpstreamStatus; code?: ModelProbeErrorCode } {
	const status = statusFromTrustedPiEnvelope(error);
	return status ? { status, code: ERROR_CODES[status] } : {};
}

export function modelProbeFailure(
	error: unknown,
	details: Pick<ModelProbeFailure, "modelResolved" | "latencyMs"> = {},
): ModelProbeFailure {
	const message = sanitizeModelErrorText(error) || "Request failed";
	return { ok: false, ...details, error: message, ...classifyModelProbeError(error) };
}
