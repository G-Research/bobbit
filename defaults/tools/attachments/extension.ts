import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { apiCallDetailed, readGatewayCreds } from "../_shared/gateway.js";

const MAX_READ_BYTES = 64 * 1024;

type GatewayCall = typeof apiCallDetailed;

type ToolParams = {
	operation: "list" | "read";
	pointer: string;
	offset?: number;
	length?: number;
};

function errorResult(message: string) {
	return {
		isError: true,
		content: [{ type: "text" as const, text: `error: ${message}` }],
		details: undefined,
	};
}

function safeGatewayError(status: number, body: unknown): string {
	if (body && typeof body === "object" && !Array.isArray(body)) {
		const record = body as Record<string, unknown>;
		if (typeof record.error === "string" && record.error.length <= 512) return record.error;
	}
	if (status === 403) return "uploaded attachment access is forbidden";
	if (status === 404) return "uploaded attachment is unavailable";
	return `uploaded attachment request failed (HTTP ${status})`;
}

export function createUploadedAttachmentExtension(dependencies: { gatewayCall?: GatewayCall } = {}): ExtensionFactory {
	const gatewayCall = dependencies.gatewayCall ?? apiCallDetailed;
	return (pi) => {
		pi.registerTool({
			name: "session_attachment",
			label: "Session Attachment",
			description: "List metadata or read a bounded byte range from an immutable uploaded attachment.",
			parameters: Type.Object({
				operation: Type.Union([Type.Literal("list"), Type.Literal("read")]),
				pointer: Type.String({ minLength: 1, maxLength: 256 }),
				offset: Type.Optional(Type.Integer({ minimum: 0, description: "Read byte offset. Defaults to 0." })),
				length: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_BYTES, description: "Maximum bytes to read. Defaults to 65536." })),
			}, { additionalProperties: false }),

			async execute(_toolCallId, rawParams) {
				const params = rawParams as ToolParams;
				if (params.operation === "list" && (params.offset !== undefined || params.length !== undefined)) {
					return errorResult("offset and length are valid only for read operations");
				}
				const sessionId = process.env.BOBBIT_SESSION_ID;
				const sessionSecret = process.env.BOBBIT_SESSION_SECRET;
				const creds = readGatewayCreds();
				if (!sessionId || !sessionSecret || "error" in creds) return errorResult("uploaded attachment service is unavailable");
				let response;
				try {
					response = await gatewayCall(
						creds,
						"POST",
						`/api/sessions/${encodeURIComponent(sessionId)}/uploaded-attachments/query`,
						{
							operation: params.operation,
							pointer: params.pointer,
							...(params.operation === "read" && params.offset !== undefined ? { offset: params.offset } : {}),
							...(params.operation === "read" && params.length !== undefined ? { length: params.length } : {}),
						},
						{ extraHeaders: { "X-Bobbit-Session-Secret": sessionSecret } },
					);
				} catch {
					return errorResult("uploaded attachment service is unavailable");
				}
				if (!response.ok) return errorResult(safeGatewayError(response.status, response.body));
				return {
					content: [{ type: "text" as const, text: JSON.stringify(response.body) }],
					details: undefined,
				};
			},
		});
	};
}

const extension = createUploadedAttachmentExtension();
export default extension;
