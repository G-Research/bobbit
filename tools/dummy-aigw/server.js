#!/usr/bin/env node
/**
 * Dummy AI Gateway — proxies Claude models through Anthropic's Messages API
 * while emulating the two protocols Bobbit's AI Gateway integration uses:
 *
 *   1. OpenAI-compatible chat completions  → POST /v1/chat/completions
 *   2. AWS Bedrock Converse Stream         → POST /aws/model/{modelId}/converse-stream
 *   3. Model discovery                     → GET  /v1/models
 *
 * The goal is to let you test Bobbit's "AI Gateway" configuration flow outside
 * the secure zone: point Bobbit at `http://localhost:1111/v1`, pick a model,
 * and requests get translated and forwarded to api.anthropic.com using a real
 * ANTHROPIC_API_KEY that lives only on this process.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node server.js           # default port 1111
 *   ANTHROPIC_API_KEY=sk-ant-... PORT=4000 node server.js
 *
 * Optional env:
 *   AIGW_AUTH_TOKEN  — require this bearer token on incoming requests
 *   MODELS           — comma-separated override, e.g. "claude-haiku-4-5,claude-opus-4-5"
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";

// ── Config ─────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT || 1111);
const HOST = process.env.HOST || "127.0.0.1";
const AUTH_TOKEN = process.env.AIGW_AUTH_TOKEN || "";

/**
 * Resolve upstream Anthropic credentials.
 * Priority:
 *   1. ANTHROPIC_API_KEY env var (static API key, uses x-api-key header).
 *   2. AUTH_JSON_PATH env var or ~/.bobbit/agent/auth.json (OAuth access token).
 *
 * OAuth access tokens authenticate with `Authorization: Bearer` plus the
 * `anthropic-beta: oauth-2025-04-20` header.
 */
function resolveCredentials() {
	if (process.env.ANTHROPIC_API_KEY) {
		return { kind: "apiKey", value: process.env.ANTHROPIC_API_KEY };
	}
	const authPath = process.env.AUTH_JSON_PATH || path.join(os.homedir(), ".bobbit", "agent", "auth.json");
	try {
		const data = JSON.parse(fs.readFileSync(authPath, "utf-8"));
		const access = data?.anthropic?.access;
		if (access) return { kind: "oauth", value: access, authPath };
	} catch (err) {
		if (err.code !== "ENOENT") console.error(`[aigw] Failed to read ${authPath}:`, err.message);
	}
	return null;
}

const creds = resolveCredentials();
if (!creds) {
	console.error("ERROR: no Anthropic credentials found.");
	console.error("Set ANTHROPIC_API_KEY, or sign in to Bobbit so ~/.bobbit/agent/auth.json contains an Anthropic OAuth token.");
	process.exit(1);
}

// Default model list. Bobbit's discovery treats any ID containing "claude" as
// a Claude model and routes it through the Bedrock Converse path, so we use
// the "aws/us.anthropic.*" shape real gateways expose. The Bedrock path strip
// "aws/" and maps "us.anthropic.claude-X" → "claude-X" before calling upstream.
const DEFAULT_MODELS = [
	"aws/us.anthropic.claude-haiku-4-5",
	"aws/us.anthropic.claude-sonnet-4-5",
];
const MODELS = (process.env.MODELS || "").trim()
	? process.env.MODELS.split(",").map(s => s.trim()).filter(Boolean)
	: DEFAULT_MODELS;

const anthropicClientOptions = creds.kind === "apiKey"
	? { apiKey: creds.value }
	: { authToken: creds.value, defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" } };
const anthropic = new Anthropic(anthropicClientOptions);
const codec = new EventStreamCodec(toUtf8, fromUtf8);

console.log(`[aigw] Upstream auth: ${creds.kind}${creds.authPath ? ` (from ${creds.authPath})` : ""}`);

// ── Model ID normalization ─────────────────────────────────────────

/**
 * Strip gateway/region prefixes so we end up with a pure Anthropic model ID.
 *   "aws/us.anthropic.claude-sonnet-4-5"       → "claude-sonnet-4-5"
 *   "us.anthropic.claude-haiku-4-5"            → "claude-haiku-4-5"
 *   "anthropic.claude-opus-4-5-20251015-v1:0"  → "claude-opus-4-5-20251015"
 *   "claude-haiku-4-5"                         → "claude-haiku-4-5"
 */
function toAnthropicModelId(id) {
	let s = String(id || "");
	const slash = s.indexOf("/");
	if (slash >= 0) s = s.slice(slash + 1);
	s = s.replace(/^us\./, "").replace(/^eu\./, "").replace(/^apac\./, "");
	s = s.replace(/^anthropic\./, "");
	s = s.replace(/-v\d+:\d+$/, "");
	return s;
}

// ── Small helpers ──────────────────────────────────────────────────

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", c => chunks.push(c));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf-8");
			if (!raw) return resolve({});
			try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
		});
		req.on("error", reject);
	});
}

function sendJson(res, status, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(body),
		"Access-Control-Allow-Origin": "*",
	});
	res.end(body);
}

function checkAuth(req, res) {
	if (!AUTH_TOKEN) return true;
	const hdr = req.headers["authorization"] || "";
	const expected = `Bearer ${AUTH_TOKEN}`;
	if (hdr !== expected) {
		sendJson(res, 401, { error: { type: "unauthorized", message: "invalid bearer token" } });
		return false;
	}
	return true;
}

// Map Anthropic stop_reason → OpenAI finish_reason / Bedrock stopReason.
function mapStopReason(r) {
	switch (r) {
		case "end_turn": return { openai: "stop", bedrock: "end_turn" };
		case "max_tokens": return { openai: "length", bedrock: "max_tokens" };
		case "stop_sequence": return { openai: "stop", bedrock: "stop_sequence" };
		case "tool_use": return { openai: "tool_calls", bedrock: "tool_use" };
		case "pause_turn": return { openai: "stop", bedrock: "end_turn" };
		case "refusal": return { openai: "content_filter", bedrock: "content_filtered" };
		default: return { openai: "stop", bedrock: "end_turn" };
	}
}

// ── Request translators: OpenAI → Anthropic ────────────────────────

/**
 * Convert an OpenAI chat-completions body into Anthropic Messages params.
 * Supports: system, user/assistant messages with string or content-array
 * bodies, image_url parts (url or data-URI), tools, tool calls, tool results.
 */
function openaiToAnthropic(body) {
	const out = {
		model: toAnthropicModelId(body.model),
		max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 4096,
		messages: [],
	};
	if (typeof body.temperature === "number") out.temperature = body.temperature;
	if (typeof body.top_p === "number") out.top_p = body.top_p;
	if (Array.isArray(body.stop)) out.stop_sequences = body.stop;
	else if (typeof body.stop === "string") out.stop_sequences = [body.stop];

	const systemParts = [];
	for (const m of body.messages || []) {
		if (m.role === "system" || m.role === "developer") {
			const text = typeof m.content === "string"
				? m.content
				: (m.content || []).map(p => p.text || "").join("\n");
			if (text) systemParts.push(text);
			continue;
		}
		if (m.role === "tool") {
			// OpenAI tool result → Anthropic user message with tool_result block
			out.messages.push({
				role: "user",
				content: [{
					type: "tool_result",
					tool_use_id: m.tool_call_id,
					content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
				}],
			});
			continue;
		}
		if (m.role === "assistant") {
			const parts = [];
			if (typeof m.content === "string" && m.content) {
				parts.push({ type: "text", text: m.content });
			} else if (Array.isArray(m.content)) {
				for (const p of m.content) {
					if (p.type === "text" && p.text) parts.push({ type: "text", text: p.text });
				}
			}
			for (const tc of m.tool_calls || []) {
				let input = {};
				try { input = JSON.parse(tc.function?.arguments || "{}"); } catch { input = {}; }
				parts.push({ type: "tool_use", id: tc.id, name: tc.function?.name || "", input });
			}
			if (parts.length > 0) out.messages.push({ role: "assistant", content: parts });
			continue;
		}
		// user
		if (typeof m.content === "string") {
			out.messages.push({ role: "user", content: m.content });
		} else if (Array.isArray(m.content)) {
			const parts = [];
			for (const p of m.content) {
				if (p.type === "text") parts.push({ type: "text", text: p.text || "" });
				else if (p.type === "image_url") {
					const url = p.image_url?.url || "";
					if (url.startsWith("data:")) {
						const m1 = url.match(/^data:([^;]+);base64,(.*)$/);
						if (m1) {
							parts.push({
								type: "image",
								source: { type: "base64", media_type: m1[1], data: m1[2] },
							});
						}
					} else {
						parts.push({ type: "image", source: { type: "url", url } });
					}
				}
			}
			out.messages.push({ role: "user", content: parts });
		}
	}
	if (systemParts.length > 0) out.system = systemParts.join("\n\n");

	if (Array.isArray(body.tools) && body.tools.length > 0) {
		out.tools = body.tools
			.filter(t => t.type === "function" && t.function)
			.map(t => ({
				name: t.function.name,
				description: t.function.description || "",
				input_schema: t.function.parameters || { type: "object", properties: {} },
			}));
	}
	if (body.tool_choice) {
		if (body.tool_choice === "auto") out.tool_choice = { type: "auto" };
		else if (body.tool_choice === "required") out.tool_choice = { type: "any" };
		else if (body.tool_choice === "none") out.tool_choice = undefined;
		else if (typeof body.tool_choice === "object" && body.tool_choice.function?.name) {
			out.tool_choice = { type: "tool", name: body.tool_choice.function.name };
		}
	}
	return out;
}

// ── Request translators: Bedrock Converse → Anthropic ──────────────

function bedrockToAnthropic(modelId, body) {
	const out = {
		model: toAnthropicModelId(modelId),
		max_tokens: body.inferenceConfig?.maxTokens ?? 4096,
		messages: [],
	};
	if (typeof body.inferenceConfig?.temperature === "number") out.temperature = body.inferenceConfig.temperature;
	if (typeof body.inferenceConfig?.topP === "number") out.top_p = body.inferenceConfig.topP;
	if (Array.isArray(body.inferenceConfig?.stopSequences)) out.stop_sequences = body.inferenceConfig.stopSequences;

	if (Array.isArray(body.system) && body.system.length > 0) {
		out.system = body.system.map(b => b.text || "").filter(Boolean).join("\n\n");
	}

	for (const m of body.messages || []) {
		const role = m.role === "assistant" ? "assistant" : "user";
		const parts = [];
		for (const c of m.content || []) {
			if (c.text != null) parts.push({ type: "text", text: c.text });
			else if (c.image?.source?.bytes) {
				// Bedrock passes raw bytes; encode base64.
				const bytes = c.image.source.bytes;
				const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
				const format = c.image.format || "png";
				parts.push({
					type: "image",
					source: { type: "base64", media_type: `image/${format}`, data: buf.toString("base64") },
				});
			} else if (c.toolUse) {
				parts.push({
					type: "tool_use",
					id: c.toolUse.toolUseId,
					name: c.toolUse.name,
					input: c.toolUse.input || {},
				});
			} else if (c.toolResult) {
				const inner = [];
				for (const tc of c.toolResult.content || []) {
					if (tc.text != null) inner.push({ type: "text", text: tc.text });
					else if (tc.json != null) inner.push({ type: "text", text: JSON.stringify(tc.json) });
				}
				parts.push({
					type: "tool_result",
					tool_use_id: c.toolResult.toolUseId,
					content: inner.length ? inner : "",
					...(c.toolResult.status === "error" ? { is_error: true } : {}),
				});
			} else if (c.reasoningContent?.reasoningText?.text) {
				// Echo thinking back as text content — Anthropic's thinking is request-side only.
			}
		}
		if (parts.length > 0) out.messages.push({ role, content: parts });
	}

	if (body.toolConfig?.tools?.length) {
		out.tools = body.toolConfig.tools
			.filter(t => t.toolSpec)
			.map(t => ({
				name: t.toolSpec.name,
				description: t.toolSpec.description || "",
				input_schema: t.toolSpec.inputSchema?.json || { type: "object", properties: {} },
			}));
	}
	if (body.toolConfig?.toolChoice) {
		const tc = body.toolConfig.toolChoice;
		if (tc.auto) out.tool_choice = { type: "auto" };
		else if (tc.any) out.tool_choice = { type: "any" };
		else if (tc.tool?.name) out.tool_choice = { type: "tool", name: tc.tool.name };
	}

	// Optional thinking pass-through (additionalModelRequestFields.thinking)
	const extra = body.additionalModelRequestFields;
	if (extra?.thinking?.type === "enabled") {
		out.thinking = { type: "enabled", budget_tokens: extra.thinking.budget_tokens ?? 1024 };
	}
	return out;
}

// ── EventStream helpers (Bedrock binary framing) ───────────────────

function encodeEvent(res, eventType, payload) {
	const body = Buffer.from(JSON.stringify(payload), "utf-8");
	const encoded = codec.encode({
		headers: {
			":event-type": { type: "string", value: eventType },
			":content-type": { type: "string", value: "application/json" },
			":message-type": { type: "string", value: "event" },
		},
		body: new Uint8Array(body),
	});
	res.write(Buffer.from(encoded));
}

function encodeException(res, eventType, payload) {
	const body = Buffer.from(JSON.stringify(payload), "utf-8");
	const encoded = codec.encode({
		headers: {
			":exception-type": { type: "string", value: eventType },
			":content-type": { type: "string", value: "application/json" },
			":message-type": { type: "string", value: "exception" },
		},
		body: new Uint8Array(body),
	});
	res.write(Buffer.from(encoded));
}

// ── OpenAI chat-completions streaming handler ──────────────────────

async function handleChatCompletionsStream(req, res, body, anthropicReq, id, created, modelOut) {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"Access-Control-Allow-Origin": "*",
	});
	const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

	const anthIdxToToolIdx = new Map();
	let toolCounter = 0;
	let sentRole = false;

	try {
		const upstream = anthropic.messages.stream(anthropicReq);
		for await (const event of upstream) {
			if (event.type === "content_block_start") {
				if (event.content_block.type === "tool_use") {
					const toolIdx = toolCounter++;
					anthIdxToToolIdx.set(event.index, toolIdx);
					if (!sentRole) {
						send({
							id, object: "chat.completion.chunk", created, model: modelOut,
							choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
						});
						sentRole = true;
					}
					send({
						id, object: "chat.completion.chunk", created, model: modelOut,
						choices: [{
							index: 0,
							delta: {
								tool_calls: [{
									index: toolIdx,
									id: event.content_block.id,
									type: "function",
									function: { name: event.content_block.name, arguments: "" },
								}],
							},
							finish_reason: null,
						}],
					});
				}
			} else if (event.type === "content_block_delta") {
				if (event.delta.type === "text_delta") {
					if (!sentRole) {
						send({
							id, object: "chat.completion.chunk", created, model: modelOut,
							choices: [{ index: 0, delta: { role: "assistant", content: event.delta.text }, finish_reason: null }],
						});
						sentRole = true;
					} else {
						send({
							id, object: "chat.completion.chunk", created, model: modelOut,
							choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }],
						});
					}
				} else if (event.delta.type === "input_json_delta") {
					const toolIdx = anthIdxToToolIdx.get(event.index);
					if (toolIdx !== undefined) {
						send({
							id, object: "chat.completion.chunk", created, model: modelOut,
							choices: [{
								index: 0,
								delta: { tool_calls: [{ index: toolIdx, function: { arguments: event.delta.partial_json } }] },
								finish_reason: null,
							}],
						});
					}
				}
			} else if (event.type === "message_delta") {
				if (event.delta.stop_reason) {
					send({
						id, object: "chat.completion.chunk", created, model: modelOut,
						choices: [{ index: 0, delta: {}, finish_reason: mapStopReason(event.delta.stop_reason).openai }],
						usage: event.usage ? {
							prompt_tokens: event.usage.input_tokens ?? 0,
							completion_tokens: event.usage.output_tokens ?? 0,
							total_tokens: (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0),
						} : undefined,
					});
				}
			}
		}
		res.write("data: [DONE]\n\n");
		res.end();
	} catch (err) {
		console.error("[aigw] openai-stream error:", err?.message || err);
		send({ error: { type: "upstream_error", message: err?.message || String(err) } });
		res.write("data: [DONE]\n\n");
		res.end();
	}
}

// ── Bedrock Converse Stream handler ────────────────────────────────

async function handleConverseStream(req, res, modelId) {
	let body;
	try { body = await readJsonBody(req); }
	catch (e) { return sendJson(res, 400, { error: { message: `invalid JSON: ${e.message}` } }); }

	const anthropicReq = bedrockToAnthropic(modelId, body);

	res.writeHead(200, {
		"Content-Type": "application/vnd.amazon.eventstream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});

	const started = Date.now();
	// Track Anthropic block index → Bedrock contentBlockIndex (they're usually the same).
	// Also remember tool_use info so we can emit contentBlockStart.start.toolUse on first delta.
	const blockMeta = new Map(); // anthIndex -> { type, id?, name? }

	try {
		const upstream = anthropic.messages.stream(anthropicReq);
		encodeEvent(res, "messageStart", { role: "assistant" });

		for await (const event of upstream) {
			if (event.type === "content_block_start") {
				const cb = event.content_block;
				if (cb.type === "text") {
					blockMeta.set(event.index, { type: "text" });
					encodeEvent(res, "contentBlockStart", { contentBlockIndex: event.index, start: {} });
				} else if (cb.type === "tool_use") {
					blockMeta.set(event.index, { type: "tool_use", id: cb.id, name: cb.name });
					encodeEvent(res, "contentBlockStart", {
						contentBlockIndex: event.index,
						start: { toolUse: { toolUseId: cb.id, name: cb.name } },
					});
				} else if (cb.type === "thinking") {
					blockMeta.set(event.index, { type: "thinking" });
					encodeEvent(res, "contentBlockStart", { contentBlockIndex: event.index, start: {} });
				}
			} else if (event.type === "content_block_delta") {
				const meta = blockMeta.get(event.index) || { type: "text" };
				if (event.delta.type === "text_delta") {
					encodeEvent(res, "contentBlockDelta", {
						contentBlockIndex: event.index,
						delta: { text: event.delta.text },
					});
				} else if (event.delta.type === "input_json_delta") {
					encodeEvent(res, "contentBlockDelta", {
						contentBlockIndex: event.index,
						delta: { toolUse: { input: event.delta.partial_json } },
					});
				} else if (event.delta.type === "thinking_delta") {
					encodeEvent(res, "contentBlockDelta", {
						contentBlockIndex: event.index,
						delta: { reasoningContent: { text: event.delta.thinking } },
					});
				} else if (event.delta.type === "signature_delta") {
					encodeEvent(res, "contentBlockDelta", {
						contentBlockIndex: event.index,
						delta: { reasoningContent: { signature: event.delta.signature } },
					});
				}
			} else if (event.type === "content_block_stop") {
				encodeEvent(res, "contentBlockStop", { contentBlockIndex: event.index });
			} else if (event.type === "message_delta") {
				if (event.delta.stop_reason) {
					encodeEvent(res, "messageStop", { stopReason: mapStopReason(event.delta.stop_reason).bedrock });
				}
				if (event.usage) {
					encodeEvent(res, "metadata", {
						usage: {
							inputTokens: event.usage.input_tokens ?? 0,
							outputTokens: event.usage.output_tokens ?? 0,
							totalTokens: (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0),
							cacheReadInputTokens: event.usage.cache_read_input_tokens ?? 0,
							cacheWriteInputTokens: event.usage.cache_creation_input_tokens ?? 0,
						},
						metrics: { latencyMs: Date.now() - started },
					});
				}
			}
		}
		res.end();
	} catch (err) {
		console.error("[aigw] bedrock-stream error:", err?.message || err);
		const name = err?.name === "AbortError" ? "modelStreamErrorException" : "internalServerException";
		encodeException(res, name, { message: err?.message || String(err) });
		res.end();
	}
}

// ── Models list ────────────────────────────────────────────────────

function handleModelsList(req, res) {
	sendJson(res, 200, {
		object: "list",
		data: MODELS.map(id => ({
			id,
			object: "model",
			created: 1700000000,
			owned_by: "dummy-aigw",
		})),
	});
}

// ── Router ─────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url || "/", `http://${req.headers.host}`);
	const pathname = url.pathname;

	// CORS preflight
	if (req.method === "OPTIONS") {
		res.writeHead(204, {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
			"Access-Control-Allow-Headers": "content-type,authorization,x-amz-content-sha256,x-amz-date,x-amz-security-token",
			"Access-Control-Max-Age": "86400",
		});
		res.end();
		return;
	}

	console.log(`[aigw] ${req.method} ${pathname}`);

	if (pathname === "/" || pathname === "/health") {
		return sendJson(res, 200, { ok: true, models: MODELS });
	}

	if (!checkAuth(req, res)) return;

	// Model list — both common shapes
	if ((pathname === "/v1/models" || pathname === "/models") && req.method === "GET") {
		return handleModelsList(req, res);
	}

	// OpenAI chat completions
	if ((pathname === "/v1/chat/completions" || pathname === "/chat/completions") && req.method === "POST") {
		let body;
		try { body = await readJsonBody(req); }
		catch (e) { return sendJson(res, 400, { error: { message: `invalid JSON: ${e.message}` } }); }

		const anthropicReq = openaiToAnthropic(body);
		const id = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const created = Math.floor(Date.now() / 1000);
		const modelOut = body.model;

		if (body.stream === true) {
			return handleChatCompletionsStream(req, res, body, anthropicReq, id, created, modelOut);
		}
		// Non-streaming: reuse handler (but it re-reads body — just inline here)
		try {
			const msg = await anthropic.messages.create(anthropicReq);
			const toolCalls = [];
			let textOut = "";
			for (const b of msg.content) {
				if (b.type === "text") textOut += b.text;
				else if (b.type === "tool_use") {
					toolCalls.push({
						id: b.id, type: "function",
						function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
					});
				}
			}
			return sendJson(res, 200, {
				id, object: "chat.completion", created, model: modelOut,
				choices: [{
					index: 0,
					message: { role: "assistant", content: textOut, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
					finish_reason: mapStopReason(msg.stop_reason).openai,
				}],
				usage: {
					prompt_tokens: msg.usage?.input_tokens ?? 0,
					completion_tokens: msg.usage?.output_tokens ?? 0,
					total_tokens: (msg.usage?.input_tokens ?? 0) + (msg.usage?.output_tokens ?? 0),
				},
			});
		} catch (err) {
			console.error("[aigw] openai-completions error:", err?.message || err);
			return sendJson(res, err?.status || 502, {
				error: { type: "upstream_error", message: err?.message || String(err) },
			});
		}
	}

	// Bedrock Converse Stream — path shape is /aws/model/{modelId}/converse-stream
	// but the AWS SDK URL-encodes colons and dots, and we may receive it with
	// the full Bobbit-set AWS_ENDPOINT_URL_BEDROCK_RUNTIME which maps the /aws
	// prefix onto this gateway.
	const converseMatch = pathname.match(/^\/aws\/model\/([^/]+)\/converse-stream$/);
	if (converseMatch && req.method === "POST") {
		const modelId = decodeURIComponent(converseMatch[1]);
		return handleConverseStream(req, res, modelId);
	}

	// Non-streaming Bedrock Converse — not commonly used by Bobbit, but nice to have.
	const converseNSMatch = pathname.match(/^\/aws\/model\/([^/]+)\/converse$/);
	if (converseNSMatch && req.method === "POST") {
		const modelId = decodeURIComponent(converseNSMatch[1]);
		let body;
		try { body = await readJsonBody(req); }
		catch (e) { return sendJson(res, 400, { error: { message: `invalid JSON: ${e.message}` } }); }
		try {
			const msg = await anthropic.messages.create(bedrockToAnthropic(modelId, body));
			const content = [];
			for (const b of msg.content) {
				if (b.type === "text") content.push({ text: b.text });
				else if (b.type === "tool_use") content.push({ toolUse: { toolUseId: b.id, name: b.name, input: b.input ?? {} } });
			}
			return sendJson(res, 200, {
				output: { message: { role: "assistant", content } },
				stopReason: mapStopReason(msg.stop_reason).bedrock,
				usage: {
					inputTokens: msg.usage?.input_tokens ?? 0,
					outputTokens: msg.usage?.output_tokens ?? 0,
					totalTokens: (msg.usage?.input_tokens ?? 0) + (msg.usage?.output_tokens ?? 0),
				},
				metrics: { latencyMs: 0 },
			});
		} catch (err) {
			return sendJson(res, err?.status || 502, {
				message: err?.message || String(err),
				__type: "InternalServerException",
			});
		}
	}

	sendJson(res, 404, { error: { type: "not_found", message: `no route for ${req.method} ${pathname}` } });
});

server.listen(PORT, HOST, () => {
	console.log("───────────────────────────────────────────────");
	console.log(`Dummy AI Gateway listening on http://${HOST}:${PORT}`);
	console.log("Configure Bobbit with this URL (append /v1):");
	console.log(`    http://${HOST}:${PORT}/v1`);
	console.log("Available models:");
	for (const m of MODELS) console.log(`  - ${m}`);
	if (AUTH_TOKEN) console.log("(bearer auth required)");
	console.log("───────────────────────────────────────────────");
});
