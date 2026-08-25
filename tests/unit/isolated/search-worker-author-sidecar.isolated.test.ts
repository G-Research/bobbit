import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
	appendPromptAuthorDispatch,
	appendPromptAuthorSettlement,
	initAuthorSidecarDir,
} from "../../../src/server/agent/author-sidecar.ts";
import { modelPrefixForPromptAuthor } from "../../../src/server/agent/message-author.ts";
import { ProgressBus } from "../../../src/server/search/progress-bus.ts";
import { SearchService } from "../../../src/server/search/search-service.ts";
import type { MessageAuthor } from "../../../src/shared/message-author.ts";

function sidecarFile(secretsDir: string, sessionId: string): string {
	return path.join(secretsDir, "author-sidecar", `${sessionId}.jsonl`);
}

function snippetWithoutHighlights(value: string): string {
	return value.replace(/<\/?b>/g, "");
}

describe("search worker author-sidecar initialization", () => {
	it("projects agent and system prefixes from v2 digest-only sidecars during rebuild", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "search-worker-author-sidecar-"));
		const stateDir = path.join(root, "state");
		const secretsDir = path.join(root, "secrets");
		const transcript = path.join(root, "session.jsonl");
		const sessionId = `search-author-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
		const previousSecretsDir = process.env.BOBBIT_SECRETS_DIR;
		process.env.BOBBIT_SECRETS_DIR = secretsDir;

		const agentAuthor: MessageAuthor = {
			kind: "agent",
			id: "session:relay-agent",
			label: "Relay Agent",
		};
		const systemAuthor: MessageAuthor = {
			kind: "system",
			id: "system:bobbit",
			label: "Bobbit",
		};
		const agentPrefix = modelPrefixForPromptAuthor(agentAuthor)!;
		const systemPrefix = modelPrefixForPromptAuthor(systemAuthor)!;
		const agentMarker = "WorkerDigestAgentProjectionToken";
		const systemMarker = "WorkerDigestSystemProjectionToken";
		const agentBaseText = `agent prompt ${agentMarker}`;
		const systemBaseText = `[System]: system prompt ${systemMarker}`;
		const agentModelText = `${agentPrefix}${agentBaseText}`;
		const systemModelText = `${systemPrefix}${systemBaseText}`;
		const rows = [
			{ id: "agent-message", message: { role: "user", content: agentModelText, timestamp: 100 } },
			{ id: "system-message", message: { role: "user", content: systemModelText, timestamp: 200 } },
		];
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(transcript, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

		initAuthorSidecarDir(stateDir);
		expect(appendPromptAuthorDispatch(sessionId, {
			promptId: "agent-prompt",
			dispatchedAt: 90,
			modelText: agentModelText,
			modelPrefix: agentPrefix,
			source: "agent",
			author: agentAuthor,
		})).toBe(true);
		expect(appendPromptAuthorSettlement(sessionId, {
			promptId: "agent-prompt",
			settledAt: 101,
			outcome: "echoed",
			messageId: "agent-message",
		})).toBe(true);
		expect(appendPromptAuthorDispatch(sessionId, {
			promptId: "system-prompt",
			dispatchedAt: 190,
			modelText: systemModelText,
			modelPrefix: systemPrefix,
			source: "system",
			author: systemAuthor,
		})).toBe(true);
		expect(appendPromptAuthorSettlement(sessionId, {
			promptId: "system-prompt",
			settledAt: 201,
			outcome: "echoed",
			messageId: "system-message",
		})).toBe(true);

		const rawSidecar = fs.readFileSync(sidecarFile(secretsDir, sessionId), "utf8");
		expect(rawSidecar).toContain('"schemaVersion":2');
		expect(rawSidecar).toMatch(/"modelTextDigest":"[A-Za-z0-9_-]{43}"/);
		expect(rawSidecar).not.toContain(agentMarker);
		expect(rawSidecar).not.toContain(systemMarker);
		expect(rawSidecar).not.toContain('"modelText"');

		const session = {
			id: sessionId,
			title: "Digest projection session",
			cwd: root,
			agentSessionFile: transcript,
			createdAt: 1,
			lastActivity: 200,
			projectId: "project-search-author",
		};
		const stores = {
			goalStore: { getAll: () => [] },
			sessionStore: { getAll: () => [session] },
			staffStore: { getAll: () => [] },
		};
		const service = new SearchService({
			stateDir,
			projectId: "project-search-author",
			progressBus: new ProgressBus(),
		});

		try {
			service.open(stores as any);
			await service.whenReady();
			await service.rebuildFromStores(
				stores.goalStore as any,
				stores.sessionStore as any,
				undefined,
				stores.staffStore as any,
			);

			const agentResults = await service.search(agentMarker, { type: "messages" });
			expect(agentResults.results).toHaveLength(1);
			const agentSnippet = snippetWithoutHighlights(agentResults.results[0]?.snippet ?? "");
			expect(agentSnippet).toContain(agentBaseText);
			expect(agentSnippet).not.toContain(agentPrefix);

			const systemResults = await service.search(systemMarker, { type: "messages" });
			expect(systemResults.results).toHaveLength(1);
			const systemSnippet = snippetWithoutHighlights(systemResults.results[0]?.snippet ?? "");
			expect(systemSnippet).toContain(systemBaseText);
			expect(systemSnippet.match(/\[System\]: /g)).toHaveLength(1);
		} finally {
			await service.close();
			if (previousSecretsDir === undefined) delete process.env.BOBBIT_SECRETS_DIR;
			else process.env.BOBBIT_SECRETS_DIR = previousSecretsDir;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
