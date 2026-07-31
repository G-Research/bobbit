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

function statusFromError(value: unknown, depth = 0): ModelProbeUpstreamStatus | undefined {
	if (!value || typeof value !== "object" || depth > 1) return undefined;
	const error = value as {
		status?: unknown;
		statusCode?: unknown;
		response?: { status?: unknown };
		cause?: unknown;
	};
	return trackedStatus(error.status)
		?? trackedStatus(error.statusCode)
		?? trackedStatus(error.response?.status)
		?? statusFromError(error.cause, depth + 1);
}

/**
 * Pi errors vary by provider: some retain a numeric status while others only
 * include it in their message. Preserve the user-actionable upstream classes
 * without passing provider response bodies or credentials through the API.
 */
export function classifyModelProbeError(error: unknown): { status?: ModelProbeUpstreamStatus; code?: ModelProbeErrorCode } {
	const message = error instanceof Error ? error.message : String(error ?? "");
	const statusFromMessage = /\b(?:HTTP\s+)?(401|403|404|429)\b/.exec(message)?.[1];
	const status = statusFromError(error) ?? trackedStatus(statusFromMessage ? Number(statusFromMessage) : undefined);
	return status ? { status, code: ERROR_CODES[status] } : {};
}

export function modelProbeFailure(
	error: unknown,
	details: Pick<ModelProbeFailure, "modelResolved" | "latencyMs"> = {},
): ModelProbeFailure {
	const message = sanitizeModelErrorText(error) || "Request failed";
	return { ok: false, ...details, error: message, ...classifyModelProbeError(error) };
}
