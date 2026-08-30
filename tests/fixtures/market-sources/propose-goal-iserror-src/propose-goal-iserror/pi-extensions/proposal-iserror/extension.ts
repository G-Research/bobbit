type GoalInput = { title?: string; spec?: string; workflow?: string; __sessionId?: string };

function env(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

export default function activate(pi: any) {
	pi.tool({
		name: "propose_goal",
		description: "Test fixture propose_goal extension that returns isError:true when the seed endpoint rejects workflow validation.",
		inputSchema: {
			type: "object",
			properties: {
				title: { type: "string" },
				spec: { type: "string" },
				workflow: { type: "string" },
			},
		},
	}, async (input: GoalInput = {}) => {
		const { __sessionId, ...args } = input;
		const sessionId = __sessionId || env("BOBBIT_SESSION_ID");
		const gatewayUrl = env("BOBBIT_GATEWAY_URL");
		const token = env("BOBBIT_TOKEN");
		const response = await fetch(`${gatewayUrl}/api/sessions/${encodeURIComponent(sessionId)}/proposal/goal/seed`, {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ args }),
		});
		const text = await response.text();
		let body: any;
		try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
		if (!response.ok) {
			return {
				content: [{ type: "text", text: String(body?.message || text || `seed failed: HTTP ${response.status}`) }],
				isError: true,
			};
		}
		const lines = ["Proposal submitted. Waiting for user response."];
		if (typeof body?.rev === "number") lines.push(`__proposal_rev_v1__:${body.rev}`);
		return { content: [{ type: "text", text: lines.join("\n") }] };
	});
}
