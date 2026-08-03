// Import from `gateway-fetch.js` (tiny, dependency-free) rather than `api.js`
// (which transitively pulls render.ts/session-manager.ts/dialogs.ts/recogito
// — ~9 MB of unrelated app shell). Keeps fixture bundles that include
// `Messages.ts` lean and avoids `__ready` flakes under parallel-worker
// contention.
import { gatewayFetch } from "../../app/gateway-fetch.js";
import { gatewayRoute } from "../../shared/base-path.js";

export type ToolContentExpected = "preview-snapshot";

/** A typed endpoint failure lets renderers separate terminal transcript errors from retryable transport failures. */
export class ToolContentFetchError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
	) {
		super(message);
		this.name = "ToolContentFetchError";
	}
}

async function contentFromResponse(res: Response): Promise<string> {
	let body: any;
	try {
		body = await res.json();
	} catch {
		body = undefined;
	}
	if (!res.ok) {
		const code = typeof body?.code === "string"
			? body.code
			: typeof body?.error?.code === "string"
				? body.error.code
				: undefined;
		const detail = typeof body?.message === "string"
			? body.message
			: typeof body?.error === "string"
				? body.error
				: res.statusText;
		throw new ToolContentFetchError(`Failed to fetch tool content: ${res.status} ${detail}`, res.status, code);
	}
	if (typeof body?.content !== "string") {
		throw new ToolContentFetchError("Failed to fetch tool content: response contained no text content", 502);
	}
	return body.content;
}

/**
 * Fetch full tool input content from the legacy positional endpoint.
 *
 * Kept for compatibility with older callers. New callers must use
 * `fetchToolContentByToolCall`, because visible client transcript rows can
 * include synthetic entries that do not exist in the agent runtime.
 */
export async function fetchToolContent(
	sessionId: string,
	messageIndex: number,
	blockIndex: number,
): Promise<string> {
	const res = await gatewayFetch(gatewayRoute(
		`/api/sessions/${encodeURIComponent(sessionId)}/tool-content/${messageIndex}/${blockIndex}`,
	));
	return contentFromResponse(res);
}

/** Fetch a tool-content block by its stable tool-call identity. */
export async function fetchToolContentByToolCall(
	sessionId: string,
	toolCallId: string,
	blockIndex: number,
	expected?: ToolContentExpected,
): Promise<string> {
	const query = expected ? `?expected=${encodeURIComponent(expected)}` : "";
	const res = await gatewayFetch(gatewayRoute(
		`/api/sessions/${encodeURIComponent(sessionId)}/tool-content/by-tool-call/${encodeURIComponent(toolCallId)}/${blockIndex}${query}`,
	));
	return contentFromResponse(res);
}
