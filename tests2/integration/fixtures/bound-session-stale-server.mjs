import fs from "node:fs";

const EXTRA_MARKER = "STALE_SERVER_DUPLICATE_EXTRA";
const EXTRA = `${EXTRA_MARKER}:` + `"\\\n\t\u0001`.repeat(18_000);

function queryFromParams(params) {
	const query = new URLSearchParams();
	for (const key of ["offset", "limit", "pattern", "context", "result_handle", "result_cursor", "result_limit"]) {
		if (params[key] !== undefined) query.set(key, String(params[key]));
	}
	if (params.case_sensitive === true) query.set("case_sensitive", "true");
	if (params.verbose === true) query.set("verbose", "true");
	if (params.include_tool_results === true || params.includeToolResults === true) {
		query.set("include_tool_results", "true");
	}
	return query;
}

function makeExecute(runtime) {
	return async function execute(_toolCallId, params) {
	fs.appendFileSync(runtime.fetchLog, `${JSON.stringify({
		winner: "server",
		caller: runtime.sessionId,
		target: params.session_id,
	})}\n`);
	const response = await fetch(`${runtime.gatewayUrl}/api/sessions/${encodeURIComponent(params.session_id)}/transcript?${queryFromParams(params)}`, {
		headers: {
			Authorization: `Bearer ${runtime.token}`,
			"X-Bobbit-Session-Id": runtime.sessionId,
		},
	});
	const envelope = await response.json();
	if (!response.ok) {
		return { content: [{ type: "text", text: JSON.stringify(envelope) }], isError: true };
	}
	return {
		content: [{ type: "text", text: JSON.stringify(envelope) }],
		details: {
			session_id: params.session_id,
			total: envelope.total,
			matchCount: envelope.matchCount,
			returned: envelope.returned,
			offsetStart: envelope.offsetStart,
			offsetEnd: envelope.offsetEnd,
			nextOffset: envelope.nextOffset,
			messages: envelope.messages,
			extra: EXTRA,
		},
	};
	};
}

export default function register(pi) {
	const execute = makeExecute({
		fetchLog: process.env.BOBBIT_LIFECYCLE_FETCH_LOG,
		gatewayUrl: process.env.BOBBIT_GATEWAY_URL,
		token: process.env.BOBBIT_TOKEN,
		sessionId: process.env.BOBBIT_SESSION_ID,
	});
	pi.registerTool({
		name: "read_session",
		label: "Stale server read session",
		description: "Historical server override without a local heavy-read guard.",
		parameters: {},
		execute,
	});
}
