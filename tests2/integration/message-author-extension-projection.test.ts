import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch } from "./_e2e/e2e-setup.js";
import {
	appendPromptAuthorDispatch,
	appendPromptAuthorSettlement,
	purgeAuthorSidecar,
} from "../../src/server/agent/author-sidecar.js";
import { projectOwnTranscriptJsonl } from "../../src/server/agent/transcript-reader.js";
import { createServerHostApi } from "../../src/server/extension-host/server-host-api.js";
import { mintSurfaceToken } from "../../src/server/extension-host/surface-binding.js";

const SYSTEM_AUTHOR = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
const MODEL_PREFIX = "[System]: ";

function terminalSurfaceToken(sessionId: string): string {
	return mintSurfaceToken({
		sessionId,
		packId: "terminal",
		contributionId: "panel:terminal.panel",
	});
}

function extSessionPath(sessionId: string, resource: "transcript" | "tool-call", extra = ""): string {
	const params = new URLSearchParams({
		sessionId,
		surfaceToken: terminalSurfaceToken(sessionId),
	});
	if (extra) {
		for (const [key, value] of new URLSearchParams(extra)) params.set(key, value);
	}
	return `/api/ext/session/${resource}?${params}`;
}

function seedPrefixedTranscript(gateway: any): {
	sessionId: string;
	transcriptFile: string;
	store: { remove(id: string): void };
	baseText: string;
} {
	const sessionId = crypto.randomUUID();
	const promptId = `prompt-${sessionId}`;
	const promptMessageId = `message-${sessionId}`;
	const baseText = "extension-visible accountable prompt";
	const piText = `${MODEL_PREFIX}${baseText}`;
	const transcriptFile = path.join(gateway.bobbitDir, "state", `${sessionId}.jsonl`);
	const rows = [
		{
			type: "message",
			id: promptMessageId,
			timestamp: 1_000,
			message: {
				role: "user",
				content: [
					{ type: "text", text: piText },
					{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				],
			},
		},
		{
			type: "message",
			id: `assistant-${sessionId}`,
			timestamp: 2_000,
			message: {
				role: "assistant",
				content: [{ type: "tool_use", id: "tool-use-1", name: "sample_tool", input: { value: 7 } }],
			},
		},
		{
			type: "message",
			id: `result-${sessionId}`,
			timestamp: 3_000,
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "tool-use-1", content: "tool output", is_error: false }],
			},
		},
	];
	fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
	fs.writeFileSync(transcriptFile, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

	const store = gateway.sessionManager.getSessionStore(gateway.defaultProjectId);
	store.put({
		id: sessionId,
		title: "extension author projection",
		cwd: gateway.bobbitDir,
		agentSessionFile: transcriptFile,
		createdAt: 1_000,
		lastActivity: 3_000,
		projectId: gateway.defaultProjectId,
	});

	expect(appendPromptAuthorDispatch(sessionId, {
		promptId,
		dispatchedAt: 900,
		modelText: piText,
		modelPrefix: MODEL_PREFIX,
		source: "system",
		author: SYSTEM_AUTHOR,
	})).toBe(true);
	expect(appendPromptAuthorSettlement(sessionId, {
		promptId,
		settledAt: 1_100,
		outcome: "echoed",
		messageId: promptMessageId,
		messageTimestamp: 1_000,
	})).toBe(true);

	return { sessionId, transcriptFile, store, baseText };
}

async function getExtensionResource(sessionId: string, pathName: string): Promise<Response> {
	return apiFetch(pathName, { headers: { "x-bobbit-session-id": sessionId } });
}

test("extension transcript reads and filters project model-only author prefixes", async ({ gateway }) => {
	const seeded = seedPrefixedTranscript(gateway);
	try {
		const transcriptResponse = await getExtensionResource(
			seeded.sessionId,
			extSessionPath(seeded.sessionId, "transcript"),
		);
		expect(transcriptResponse.status).toBe(200);
		const transcript = await transcriptResponse.json();
		expect(transcript.total).toBe(3);
		expect(transcript.messages[0]).toEqual({
			id: expect.any(String),
			role: "user",
			content: [{ type: "text", text: seeded.baseText }],
			ts: 1_000,
		});
		expect(JSON.stringify(transcript)).not.toContain(MODEL_PREFIX);
		expect(transcript.messages[0]).not.toHaveProperty("author");

		const prefixFilterResponse = await getExtensionResource(
			seeded.sessionId,
			extSessionPath(seeded.sessionId, "transcript", `pattern=${encodeURIComponent("[System]")}`),
		);
		expect(prefixFilterResponse.status).toBe(200);
		expect(await prefixFilterResponse.json()).toMatchObject({ total: 0, returned: 0, messages: [] });

		const visibleFilterResponse = await getExtensionResource(
			seeded.sessionId,
			extSessionPath(seeded.sessionId, "transcript", `pattern=${encodeURIComponent(seeded.baseText)}`),
		);
		expect(visibleFilterResponse.status).toBe(200);
		const visibleFilter = await visibleFilterResponse.json();
		expect(visibleFilter.total).toBe(1);
		expect(visibleFilter.messages[0].content).toEqual([{ type: "text", text: seeded.baseText }]);

		const toolCallResponse = await getExtensionResource(
			seeded.sessionId,
			extSessionPath(seeded.sessionId, "tool-call", "toolUseId=tool-use-1"),
		);
		expect(toolCallResponse.status).toBe(200);
		expect(await toolCallResponse.json()).toEqual({
			toolUseId: "tool-use-1",
			tool: "sample_tool",
			input: { value: 7 },
			output: "tool output",
			isError: false,
		});

		// Server action/route modules receive the same projected JSONL through their
		// bound Host API callback, so its contract filter cannot match the decoration.
		const serverHost = createServerHostApi({
			sessionId: seeded.sessionId,
			packId: "terminal",
			contributionId: "panel:terminal.panel",
			readOwnTranscript: async () => projectOwnTranscriptJsonl(
				seeded.sessionId,
				fs.readFileSync(seeded.transcriptFile, "utf8"),
			),
		});
		expect(await serverHost.session.readTranscript({ pattern: "[System]" })).toMatchObject({
			total: 0,
			returned: 0,
			messages: [],
		});
		expect(await serverHost.session.readTranscript({ pattern: seeded.baseText })).toMatchObject({
			total: 1,
			returned: 1,
			messages: [{ content: [{ type: "text", text: seeded.baseText }] }],
		});
		expect(await serverHost.session.readToolCall("tool-use-1")).toMatchObject({
			toolUseId: "tool-use-1",
			tool: "sample_tool",
			output: "tool output",
		});

		// Projection is in-memory only. Pi's accountable raw transcript stays intact.
		expect(fs.readFileSync(seeded.transcriptFile, "utf8")).toContain(`${MODEL_PREFIX}${seeded.baseText}`);
	} finally {
		seeded.store.remove(seeded.sessionId);
		purgeAuthorSidecar(seeded.sessionId);
		fs.rmSync(seeded.transcriptFile, { force: true });
	}
});
