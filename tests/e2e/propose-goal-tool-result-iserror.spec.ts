import { test, expect } from "./in-process-harness.js";
import {
	agentEndPredicate,
	apiFetch,
	connectWs,
	createSession,
	deleteSession,
	nonGitCwd,
} from "./e2e-setup.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_SOURCE = path.resolve(__dirname, "..", "fixtures", "market-sources", "propose-goal-iserror-src");
const PACK_NAME = "propose-goal-iserror";

const sessions: string[] = [];
const sourceIds = new Set<string>();
let installed = false;

async function addSource(sourceDir: string): Promise<string> {
	const add = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: sourceDir }),
	});
	const text = await add.text();
	if (add.status === 409) {
		const sourcesResp = await apiFetch("/api/marketplace/sources");
		expect(sourcesResp.status).toBe(200);
		const source = ((await sourcesResp.json()).sources ?? []).find((item: any) => item.url === sourceDir);
		expect(source, text).toBeTruthy();
		sourceIds.add(source.id);
		return source.id;
	}
	expect(add.status, text).toBe(201);
	const sourceId = (JSON.parse(text) as { source: { id: string } }).source.id;
	sourceIds.add(sourceId);
	return sourceId;
}

async function installPack(): Promise<void> {
	const sourceId = await addSource(FIXTURE_SOURCE);
	const install = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId, dirName: PACK_NAME, scope: "server" }),
	});
	const text = await install.text();
	expect(install.status, text).toBe(201);
	installed = true;
	const activation = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK_NAME, disabled: { piExtensions: [] } }),
	});
	expect(activation.status, await activation.text()).toBe(200);
}

function toolResultMessage(name: string) {
	return (m: any) => m.type === "event"
		&& m.data?.type === "message_end"
		&& m.data?.message?.role === "toolResult"
		&& m.data?.message?.toolName === name;
}

function textOf(message: any): string {
	return (message?.content ?? [])
		.map((part: any) => typeof part?.text === "string" ? part.text : "")
		.join("\n");
}

test.describe.configure({ mode: "serial" });

test.describe("propose_goal bridge isError preservation", () => {
	test.afterEach(async () => {
		for (const id of sessions.splice(0)) await deleteSession(id).catch(() => {});
		if (installed) {
			await apiFetch("/api/marketplace/installed", {
				method: "DELETE",
				body: JSON.stringify({ scope: "server", packName: PACK_NAME }),
			}).catch(() => {});
			installed = false;
		}
		for (const sourceId of [...sourceIds]) {
			await apiFetch(`/api/marketplace/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" }).catch(() => {});
			sourceIds.delete(sourceId);
		}
	});

	test("failed propose_goal tool result persists returned isError true", async () => {
		await installPack();
		const sessionId = await createSession({ cwd: nonGitCwd() });
		sessions.push(sessionId);

		const conn = await connectWs(sessionId);
		try {
			const input = {
				__sessionId: sessionId,
				title: "Missing Workflow Goal",
				spec: "A focused reproducing draft that intentionally omits workflow so validation rejects it.",
			};
			const cursor = conn.messageCount();
			conn.send({ type: "prompt", text: `PI_EXTENSION_TOOL:propose_goal::${JSON.stringify(input)}` });
			const live = await conn.waitForFrom(cursor, toolResultMessage("propose_goal"), 20_000);
			await conn.waitForFrom(cursor, agentEndPredicate(), 20_000).catch(() => {});

			const liveMessage = live.data.message;
			expect(textOf(liveMessage)).toContain("Workflow is required");
			expect(liveMessage.isError, "propose_goal failed tool result must persist isError:true (live broadcast)").toBe(true);

			const snapshotCursor = conn.messageCount();
			conn.send({ type: "get_messages" });
			const snapshot = await conn.waitForFrom(snapshotCursor, (m) => m.type === "messages", 20_000);
			const replayed = [...(snapshot.data as any[])]
				.reverse()
				.find((m) => m.role === "toolResult" && m.toolName === "propose_goal");
			expect(replayed, "snapshot should include the propose_goal tool result").toBeTruthy();
			expect(textOf(replayed)).toContain("Workflow is required");
			expect(replayed.isError, "propose_goal failed tool result must persist isError:true (snapshot replay)").toBe(true);
		} finally {
			conn.close();
		}
	});
});
