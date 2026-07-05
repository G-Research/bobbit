#!/usr/bin/env node
/**
 * RPC-tax-at-transcript-size benchmark for
 * docs/design/in-process-bridge-spike.md "Sizing results" section.
 *
 * The spike's own steady-state measurement used an EMPTY session
 * (`get_state` on a session with no messages), and explicitly flagged that it
 * "did not reproduce the transcript-size-scaling serialization tax" that
 * `rpc-bridge.ts:641-645`'s `get_messages` (ships the ENTIRE transcript as
 * JSON every call) and `session-manager.ts`'s re-`JSON.stringify` (to
 * broadcast) are both subject to. This script closes that gap: it seeds a
 * REAL pi `--session <path>` transcript file (pi's own on-disk JSONL wire
 * format — one `{type:"message", id, parentId, timestamp, message:{role,
 * content,...}}` event per line, reverse-engineered from a real
 * `pi --print` run, not guessed) at three sizes, spawns a real
 * `pi --mode rpc` child pointed at each, and measures repeated `get_messages`
 * RPC round trips — the actual code path Bobbit calls on every session
 * snapshot/reload (see docs/design/boot-timing-instrumentation.md).
 *
 * No API keys needed: get_messages, like get_state, never calls a model.
 *
 * Usage: node scripts/bench-rpc-transcript-tax.mjs
 * (run from repo root so node_modules/@earendil-works/pi-coding-agent
 * resolves, and so the CLI path below is correct)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const N_ROUNDTRIPS = 8; // per size, after the process is warm
const SIZES = [50, 500, 2000]; // message COUNT (user+assistant pairs = SIZES/2 turns)
const cliPath = path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

function median(times) {
	const sorted = [...times].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

// Representative per-message text length. Real coding-agent turns run from a
// short instruction to a multi-paragraph explanation/diff; 300 chars is a
// conservative-but-not-toy middle ground (NOT tuned to make the curve look a
// particular way — same filler sentence repeated to hit the target length).
const FILLER = "The quick brown fox jumps over the lazy dog while refactoring the session bridge. ";
function fillerText(targetChars) {
	return FILLER.repeat(Math.ceil(targetChars / FILLER.length)).slice(0, targetChars);
}

/** Build a synthetic pi session JSONL transcript with `count` message events
 *  (alternating user/assistant), matching the real on-disk wire format. */
function buildTranscript(count) {
	const sessionId = "01900000-0000-7000-8000-000000000000";
	const lines = [];
	lines.push(JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() }));
	let parentId = null;
	for (let i = 0; i < count; i++) {
		const id = `m${i}`;
		const role = i % 2 === 0 ? "user" : "assistant";
		const message = role === "user"
			? { role, content: [{ type: "text", text: fillerText(300) }], timestamp: Date.now() }
			: { role, content: [{ type: "text", text: fillerText(300) }], api: "google-generative-ai", provider: "google", model: "gemini-2.5-flash", timestamp: Date.now() };
		lines.push(JSON.stringify({ type: "message", id, parentId, timestamp: new Date().toISOString(), message }));
		parentId = id;
	}
	return lines.join("\n") + "\n";
}

function spawnRpc(sessionPath) {
	return spawn(process.execPath, [
		cliPath, "--mode", "rpc", "--session", sessionPath,
		"--no-approve", "--no-context-files", "--no-builtin-tools",
	], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
	});
}

function measureGetMessages(child, n) {
	return new Promise((resolve, reject) => {
		let buf = "";
		let ready = false, count = 0, pendingT0 = null, payloadBytes = 0;
		const times = [];
		function sendNext() {
			pendingT0 = performance.now();
			child.stdin.write(JSON.stringify({ type: "get_messages" }) + "\n");
		}
		child.stdout.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			let nl;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line.trim()) continue;
				if (!ready) { ready = true; sendNext(); continue; }
				payloadBytes = Buffer.byteLength(line, "utf8");
				let msg;
				try { msg = JSON.parse(line); } catch { continue; }
				if (msg.type === "response" && msg.command === "get_messages") {
					times.push(performance.now() - pendingT0);
					count++;
					if (count >= n) { resolve({ times, payloadBytes }); return; }
					sendNext();
				}
			}
		});
		child.on("error", reject);
		child.stdin.write(JSON.stringify({ type: "get_state" }) + "\n"); // primes `ready`
		setTimeout(() => { if (count < n) reject(new Error(`get_messages timeout after ${count}/${n}`)); }, 15_000);
	});
}

async function main() {
	const workDir = mkdtempSync(path.join(tmpdir(), "bobbit-rpc-tax-"));
	console.log(`Scratch dir: ${workDir}`);
	console.log(`\n=== get_messages RPC round trip vs. transcript size (N=${N_ROUNDTRIPS} warm calls per size) ===`);
	const results = [];
	try {
		for (const size of SIZES) {
			const transcript = buildTranscript(size);
			const sessionPath = path.join(workDir, `session-${size}.jsonl`);
			writeFileSync(sessionPath, transcript);
			const transcriptBytes = Buffer.byteLength(transcript, "utf8");

			const child = spawnRpc(sessionPath);
			try {
				const { times, payloadBytes } = await measureGetMessages(child, N_ROUNDTRIPS);
				const med = median(times);
				results.push({ size, transcriptBytes, payloadBytes, med, times });
				console.log(
					`messages=${String(size).padStart(5)} transcriptFile=${String(transcriptBytes).padStart(9)}B ` +
					`get_messages-response=${String(payloadBytes).padStart(9)}B median=${med.toFixed(2)}ms ` +
					`all=[${times.map(t => t.toFixed(1)).join(", ")}]`,
				);
			} finally {
				child.kill("SIGKILL");
			}
		}
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}

	if (results.length >= 2) {
		const first = results[0], last = results[results.length - 1];
		const msgRatio = last.size / first.size;
		const timeRatio = last.med / (first.med || 0.001);
		console.log(`\n${first.size} -> ${last.size} messages (${msgRatio}x): median RPC time ${first.med.toFixed(2)}ms -> ${last.med.toFixed(2)}ms (${timeRatio.toFixed(2)}x)`);
	}
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
