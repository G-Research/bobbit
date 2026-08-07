import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { packedWriteAgentSource } from "../browser/e2e/packaged-runtime-helpers.js";
import { sourceViteWriteAgentSource } from "../browser/e2e/source-vite-runtime-helpers.js";

const roots = new Set<string>();
const children = new Set<ChildProcessWithoutNullStreams>();

function digest(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function frame(promptId: string, body: string, bodyDigest = digest(body)): string {
	const envelope = Buffer.from(JSON.stringify({ v: 1, id: promptId, digest: bodyDigest }), "utf8").toString("base64url");
	return `\u001eBOBBIT_PROMPT_V1:${envelope}\u001f${body}`;
}

function startGeneratedAgent(source: string): {
	child: ChildProcessWithoutNullStreams;
	events: any[];
	waitFor: (predicate: (event: any) => boolean, from?: number) => Promise<any>;
	root: string;
} {
	const root = mkdtempSync(join(tmpdir(), "bobbit-generated-prompt-agent-"));
	roots.add(root);
	const file = join(root, "agent.mjs");
	writeFileSync(file, source, "utf8");
	const child = spawn(process.execPath, [file], {
		cwd: root,
		env: { ...process.env, BOBBIT_AGENT_DIR: root },
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	children.add(child);
	const events: any[] = [];
	let buffer = "";
	child.stdout.on("data", chunk => {
		buffer += String(chunk);
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line) events.push(JSON.parse(line));
		}
	});
	const waitFor = async (predicate: (event: any) => boolean, from = 0): Promise<any> => {
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			const found = events.slice(from).find(predicate);
			if (found) return found;
			if (child.exitCode !== null) throw new Error(`generated agent exited ${child.exitCode}: ${await new Promise<string>(resolve => {
				let stderr = "";
				child.stderr.on("data", chunk => { stderr += String(chunk); });
				setTimeout(() => resolve(stderr), 0);
			})}`);
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		throw new Error(`timed out waiting for generated-agent event; events=${JSON.stringify(events)}`);
	};
	return { child, events, waitFor, root };
}

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null) child.kill("SIGKILL");
		if (child.exitCode === null) await once(child, "close").catch(() => undefined);
	}
	children.clear();
	for (const root of roots) rmSync(root, { recursive: true, force: true });
	roots.clear();
});

describe.each([
	["packaged", packedWriteAgentSource],
	["source Vite", sourceViteWriteAgentSource],
])("%s generated standalone agent", (_label, sourceFactory) => {
	it("implements exact v1 framing, persistence ACK, idempotent redrive, and fail-closed identity validation", async () => {
		const { child, events, waitFor, root } = startGeneratedAgent(sourceFactory());
		const capability = await waitFor(event => event.type === "bobbit_prompt_delivery_capability");
		expect(capability).toEqual({
			type: "bobbit_prompt_delivery_capability",
			protocolVersion: 1,
			extensionVersion: "1.0.0",
		});
		await waitFor(event => event.type === "session_status" && event.status === "idle");

		const body = "generated child must see only this body";
		child.stdin.write(`${JSON.stringify({ type: "prompt", id: "request-1", message: frame("stable-1", body) })}\n`);
		const firstAck = await waitFor(event => event.type === "entry_appended" && event.entry?.data?.promptId === "stable-1");
		expect(firstAck.entry).toEqual({
			type: "custom",
			customType: "bobbit:prompt-delivery-ack-v1",
			data: { protocolVersion: 1, promptId: "stable-1", digest: digest(body) },
		});
		expect(events.filter(event => event.type === "agent_start")).toHaveLength(1);
		const userEvents = events.filter(event => event.type === "message_end" && event.message?.role === "user");
		expect(userEvents).toHaveLength(1);
		expect(userEvents[0].message.content).toEqual([{ type: "text", text: body }]);
		expect(JSON.stringify(userEvents[0])).not.toContain("BOBBIT_PROMPT_V1");

		const transcriptPath = join(root, readdirSync(root).find(name => name.endsWith(".jsonl"))!);
		const persisted = readFileSync(transcriptPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
		expect(persisted.some(entry => entry.customType === "bobbit:prompt-delivery-v1" && entry.data?.promptId === "stable-1")).toBe(true);
		expect(persisted.at(-1)).toEqual(firstAck.entry);

		const redriveFrom = events.length;
		child.stdin.write(`${JSON.stringify({ type: "prompt", id: "request-2", message: frame("stable-1", body) })}\n`);
		await waitFor(event => event.type === "entry_appended" && event.entry?.data?.promptId === "stable-1", redriveFrom);
		expect(events.filter(event => event.type === "agent_start")).toHaveLength(1);
		expect(events.filter(event => event.type === "message_end" && event.message?.role === "user")).toHaveLength(1);

		const collisionFrom = events.length;
		child.stdin.write(`${JSON.stringify({ type: "prompt", id: "request-3", message: frame("stable-1", "different body") })}\n`);
		expect(await waitFor(event => event.type === "bobbit_prompt_delivery_failure", collisionFrom)).toMatchObject({
			protocolVersion: 1,
			promptId: "stable-1",
			code: "identity-collision",
		});

		const malformedFrom = events.length;
		child.stdin.write(`${JSON.stringify({ type: "prompt", id: "request-4", message: frame("stable-2", "private body", "0".repeat(64)) })}\n`);
		expect(await waitFor(event => event.type === "bobbit_prompt_delivery_failure", malformedFrom)).toMatchObject({
			protocolVersion: 1,
			promptId: "stable-2",
			code: "invalid-envelope",
		});
		expect(JSON.stringify(events.slice(malformedFrom))).not.toContain("private body");

		child.stdin.end();
		await once(child, "close");
		children.delete(child);
	});
});
