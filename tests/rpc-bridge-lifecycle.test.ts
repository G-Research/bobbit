import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RpcBridge } from "../src/server/agent/rpc-bridge.ts";

function writeCrashOnPromptCli(): { dir: string; file: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-rpc-crash-"));
	const file = path.join(dir, "crash-on-prompt.mjs");
	fs.writeFileSync(file, `
process.stdin.setEncoding("utf8");
let received = "";
process.stdin.on("data", (chunk) => {
  received += chunk;
  if (received.includes("\\n")) {
    process.stderr.write("synthetic pi child crash after pending prompt\\n");
    setTimeout(() => process.exit(17), 10);
  }
});
setInterval(() => {}, 1000);
`, "utf-8");
	return { dir, file };
}

function timeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer!));
}

describe("RpcBridge lifecycle", () => {
	it("rejects a pending prompt exactly once when the Pi child exits unexpectedly", async () => {
		const cli = writeCrashOnPromptCli();
		const bridge = new RpcBridge({ cliPath: cli.file });
		let processExitEvents = 0;
		const unsubscribe = bridge.onEvent((event) => {
			if (event?.type === "process_exit") processExitEvents++;
		});

		await bridge.start();

		let rejectionCount = 0;
		const result = await timeout(
			bridge.prompt("trigger crash").then(
				(value) => ({ ok: true as const, value }),
				(error) => {
					rejectionCount++;
					return { ok: false as const, error };
				},
			),
			2000,
			"pending prompt did not reject after child process exit",
		);

		assert.equal(result.ok, false, "prompt should reject when the child exits before replying");
		assert.match(String(result.error?.message || result.error), /Agent process exited with code 17/);
		assert.match(String(result.error?.message || result.error), /synthetic pi child crash/);
		assert.equal(rejectionCount, 1, "pending prompt promise must reject exactly once");

		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(processExitEvents, 1, "process_exit event should be emitted exactly once");
		assert.equal(bridge.running, false, "bridge should clear its process after exit");

		try {
			await timeout(bridge.stop(), 500, "first stop() hung after child exit");
			await timeout(bridge.stop(), 500, "second stop() hung after child exit");
			assert.equal(rejectionCount, 1, "idempotent stop cleanup must not re-reject the prompt");
			assert.equal(processExitEvents, 1, "idempotent stop cleanup must not emit duplicate process_exit events");
		} finally {
			unsubscribe();
			fs.rmSync(cli.dir, { recursive: true, force: true });
		}
	});
});
