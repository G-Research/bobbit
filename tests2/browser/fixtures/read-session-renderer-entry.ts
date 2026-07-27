import { render } from "lit";
import { ReadSessionRenderer } from "../../../src/ui/tools/renderers/ReadSessionRenderer.js";

const SESSION_ID = "87654321-1234-4123-8123-canonicalcard";
const RAW_SENTINEL = "UNBOUNDED_RAW_PROVIDER_RESULT_MUST_STAY_HIDDEN";

function boot(): void {
	const app = document.getElementById("app");
	if (!app) throw new Error("#app missing");
	document.documentElement.style.setProperty("--background", "#fafafa");
	document.documentElement.style.setProperty("--foreground", "#171717");
	document.documentElement.style.setProperty("--muted-foreground", "#606060");
	document.documentElement.style.setProperty("--border", "#c7c7c7");
	document.documentElement.style.setProperty("--positive", "#147a3d");
	document.documentElement.style.setProperty("--warning", "#9a5b00");
	document.documentElement.style.setProperty("--destructive", "#b42318");

	const envelope = {
		total: 5,
		returned: 1,
		offsetStart: 2,
		offsetEnd: 2,
		nextOffset: 3,
		partial: true,
		truncatedBy: "transport_budget",
		continuationRequest: { kind: "page", offset: 3 },
		authors: {
			a1: { kind: "agent", id: "fixture-agent-id", label: "Fixture Reviewer" },
		},
		messages: [{
			index: 2,
			role: "assistant",
			ts: null,
			text: "",
			authorRef: "a1",
			toolCalls: [{
				ref: "t1",
				name: "read_session",
				argumentsPreview: "{\"limit\":2}",
				argumentsTruncated: false,
			}],
			toolResults: [{
				ref: "t1",
				name: "read_session",
				status: "ok",
				size: { type: "array", chars: 9000, lines: 120, bytes: 9400, blocks: 8 },
				omitted: true,
				handle: "rs1:m2:b0:browser-bounded-handle",
			}],
		}],
	};
	const result = {
		role: "toolResult",
		toolCallId: "read-session-browser-call",
		toolName: "read_session",
		isError: false,
		content: [{ type: "text", text: JSON.stringify(envelope) }],
		details: {
			session_id: SESSION_ID,
			total: 5,
			returned: 1,
			messages: [{ text: RAW_SENTINEL }],
		},
		timestamp: Date.now(),
	};
	const output = new ReadSessionRenderer().render({ session_id: SESSION_ID }, result as any, false);
	render(output.content, app);

	const fetchOffsets: string[] = [];
	window.fetch = (async (input: RequestInfo | URL) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href);
		fetchOffsets.push(url.searchParams.get("offset") || "");
		return new Response(JSON.stringify({
			total: 1,
			returned: 1,
			offsetStart: 0,
			offsetEnd: 0,
			messages: [{
				index: 0,
				role: "user",
				ts: null,
				text: "<direct-rest-row>escaped</direct-rest-row>",
				author: { kind: "agent", id: "direct-agent", label: "Direct REST Author" },
			}],
		}), { status: 200, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;

	Object.assign(window, {
		__readSessionFixtureReady: true,
		__readSessionRawSentinel: RAW_SENTINEL,
		__readSessionFetchOffsets: fetchOffsets,
	});
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
