import { guardProcessEnv } from "../../../tests2/core/helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import reviewExtension from "../../../defaults/tools/review/extension.ts";
import { getGateway } from "../../../tests2/harness/gateway.js";
import { createScope } from "../../../tests2/harness/scope.js";
import { configureAigwRuntimeFlags } from "../../../src/server/agent/aigw-manager.js";
import { invalidateModelCache } from "../../../src/server/agent/model-registry.js";
import {
	LARGE_CONTENT_THRESHOLD,
	truncateLargeToolContent,
	truncateLargeToolContentInMessages,
} from "../../../src/server/agent/truncate-large-content.js";

type TextBlock = {
	type: string;
	text: string;
	_truncated?: boolean;
};

type ToolResult = {
	content: TextBlock[];
	isError?: boolean;
};

type RegisteredTool = {
	name: string;
	execute: (toolCallId: string, params: unknown) => Promise<ToolResult>;
};

function registeredReviewOpen(): RegisteredTool {
	const tools = new Map<string, RegisteredTool>();
	reviewExtension({
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
	} as any);
	const tool = tools.get("review_open");
	assert.ok(tool, "review_open should be registered");
	return tool;
}

function assertActionableOpenStatus(receipt: Record<string, any>): void {
	const outcome = receipt.automaticOpen ?? receipt.openOutcome ?? receipt.open;
	assert.ok(
		outcome && typeof outcome === "object" && !Array.isArray(outcome),
		"bounded review receipt must expose a structured automatic-open outcome",
	);
	assert.ok(
		typeof outcome.status === "string" || typeof outcome.ok === "boolean",
		"automatic-open outcome must carry an actionable status",
	);
}

describe("review_open large-payload egress contract", () => {
	it("REVIEW_LARGE_PAYLOAD_RECEIPT_REQUIRED: emits a bounded payload-free actionable receipt before live and history truncation", async () => {
		const toolCallId = "review-large-payload-contract";
		const files = Array.from({ length: 20 }, (_, index) => ({
			title: `File ${String(index + 1).padStart(2, "0")}`,
			markdown: `# File ${index + 1}\nPRIVATE_REVIEW_BODY_${index}\n${"x".repeat(24_320)}`,
		}));
		const totalBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.markdown, "utf8"), 0);
		assert.ok(totalBytes > LARGE_CONTENT_THRESHOLD, "fixture must exercise the >32 KiB defect");

		const gateway = await getGateway();
		const scope = createScope(gateway);
		const previousGatewayUrl = process.env.BOBBIT_GATEWAY_URL;
		const previousToken = process.env.BOBBIT_TOKEN;
		const previousSessionId = process.env.BOBBIT_SESSION_ID;
		const previousSessionSecret = process.env.BOBBIT_SESSION_SECRET;

		try {
			const session = await scope.createSession({});
			process.env.BOBBIT_GATEWAY_URL = gateway.baseURL;
			process.env.BOBBIT_TOKEN = gateway.token;
			process.env.BOBBIT_SESSION_ID = session.id;
			process.env.BOBBIT_SESSION_SECRET = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(session.id);
			const result = await registeredReviewOpen().execute(toolCallId, {
				title: "Large review receipt regression",
				files,
			});
			assert.notEqual(
				result.isError,
				true,
				`REVIEW_LARGE_PAYLOAD_RECEIPT_REQUIRED: authenticated review_open unexpectedly returned ${result.content[0]?.text}`,
			);
			assert.equal(result.content.length, 1, "review_open should return one control receipt block");

			const message = {
				role: "toolResult",
				toolCallId,
				toolName: "review_open",
				content: result.content,
			};
			const live = truncateLargeToolContent({ type: "message_end", message });
			const liveBlock = live.message.content[0] as TextBlock;
			assert.notEqual(
				liveBlock._truncated,
				true,
				"REVIEW_LARGE_PAYLOAD_RECEIPT_REQUIRED: review_open result was truncated instead of emitting a bounded payload-free actionable receipt",
			);
			const history = truncateLargeToolContentInMessages([message]) as Array<typeof message>;
			assert.notEqual(
				(history[0].content[0] as TextBlock)._truncated,
				true,
				"REVIEW_LARGE_PAYLOAD_RECEIPT_REQUIRED: review_open history was truncated instead of retaining its bounded receipt",
			);

			assert.ok(
				Buffer.byteLength(liveBlock.text, "utf8") < LARGE_CONTENT_THRESHOLD,
				"bounded review receipt must stay below the generic 32 KiB truncation threshold",
			);
			for (let index = 0; index < files.length; index++) {
				assert.doesNotMatch(
					liveBlock.text,
					new RegExp(`PRIVATE_REVIEW_BODY_${index}(?:\\D|$)`),
					"canonical Markdown bodies must not appear in the review receipt",
				);
			}

			const receipt = JSON.parse(liveBlock.text) as Record<string, any>;
			assert.equal(receipt.action, "review_open");
			assert.equal(receipt.version, 2, "large review controls must use the durable v2 receipt");
			assert.equal(receipt.toolCallId, toolCallId, "receipt must bind to the originating tool call");
			assert.equal(typeof receipt.payloadId, "string");
			assert.ok(receipt.payloadId.length > 0, "receipt must address persisted review content");
			assert.equal(typeof receipt.reviewId, "string");
			assert.ok(receipt.reviewId.length > 0, "receipt must preserve stable review identity");
			assert.equal(typeof receipt.hash, "string");
			assert.ok(receipt.hash.length > 0, "receipt must bind the referenced content hash");
			assert.equal(receipt.totalBytes, totalBytes, "receipt must use cumulative UTF-8 byte accounting");
			assert.equal(typeof receipt.activeFileId, "string");
			assert.equal(receipt.files.length, files.length);
			assert.deepEqual(receipt.files.map((file: any) => file.title), files.map((file) => file.title));
			for (let index = 0; index < receipt.files.length; index++) {
				const metadata = receipt.files[index];
				assert.equal(typeof metadata.fileId, "string");
				assert.ok(metadata.fileId.length > 0, "receipt must preserve exact file identities");
				assert.equal(metadata.markdown, undefined, "receipt file metadata must not embed Markdown");
				assert.equal(
					metadata.bytes ?? metadata.markdownBytes,
					Buffer.byteLength(files[index].markdown, "utf8"),
					"receipt must preserve per-file UTF-8 byte metadata",
				);
			}
			assertActionableOpenStatus(receipt);
		} finally {
			if (previousGatewayUrl === undefined) delete process.env.BOBBIT_GATEWAY_URL;
			else process.env.BOBBIT_GATEWAY_URL = previousGatewayUrl;
			if (previousToken === undefined) delete process.env.BOBBIT_TOKEN;
			else process.env.BOBBIT_TOKEN = previousToken;
			if (previousSessionId === undefined) delete process.env.BOBBIT_SESSION_ID;
			else process.env.BOBBIT_SESSION_ID = previousSessionId;
			if (previousSessionSecret === undefined) delete process.env.BOBBIT_SESSION_SECRET;
			else process.env.BOBBIT_SESSION_SECRET = previousSessionSecret;
			try {
				await scope.cleanup();
			} finally {
				// getGateway() intentionally disables well-known discovery for gateway boot,
				// but that module-global flag shares this isolate:false Vitest fork with
				// later AIGW unit files. Restore ordinary loopback discovery after this
				// review fixture while retaining the harness network fences.
				configureAigwRuntimeFlags({ skipAigwDiscovery: false });
				invalidateModelCache();
			}
		}
	});
});
