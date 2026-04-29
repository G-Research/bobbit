/**
 * Mission tools for the Commander agent.
 *
 * Registers the six mission_* tools defined in design §10. Each tool is a
 * thin REST wrapper around the gateway's /api/missions/* endpoints.
 *
 * The mission id is read from `BOBBIT_MISSION_ID` (set by the session manager
 * when spawning a Commander session). If it's not set the extension exits
 * silently — non-Commander roles never see these tools.
 *
 * Mirror of defaults/tools/team/extension.ts.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export default function (pi: ExtensionAPI) {
	const sessionId = process.env.BOBBIT_SESSION_ID;
	const missionId = process.env.BOBBIT_MISSION_ID;
	const sessionRole = process.env.BOBBIT_SESSION_ROLE;
	if (!sessionId || !missionId) {
		return;
	}
	// Mission-mutating tools are commander-only. Reviewer sub-sessions for
	// mission gates inherit BOBBIT_MISSION_ID (so the gateway can correlate
	// their work back to the mission) but must not be able to mutate plan
	// state, spawn child goals, or merge branches.
	if (sessionRole !== "commander") {
		console.error(
			`[mission-tools] Skipping registration for session ${sessionId} ` +
			`(role=${sessionRole ?? "<unset>"}); mission tools are commander-only`,
		);
		return;
	}

	let token: string;
	let baseUrl: string;
	const envToken = process.env.BOBBIT_TOKEN;
	const envUrl = process.env.BOBBIT_GATEWAY_URL;
	if (envToken && envUrl) {
		token = envToken;
		baseUrl = envUrl.replace(/\/+$/, "");
	} else {
		try {
			const stateDir = process.env.BOBBIT_DIR
				? path.join(process.env.BOBBIT_DIR, "state")
				: path.join(homedir(), ".pi");
			const tokenFile = process.env.BOBBIT_DIR ? "token" : "gateway-token";
			const urlFile = "gateway-url";
			token = fs.readFileSync(path.join(stateDir, tokenFile), "utf-8").trim();
			baseUrl = fs.readFileSync(path.join(stateDir, urlFile), "utf-8").trim().replace(/\/+$/, "");
		} catch {
			console.error("[mission-tools] Cannot read gateway credentials — tools not registered");
			return;
		}
	}

	async function api(method: string, urlPath: string, body?: unknown): Promise<unknown> {
		const resp = await fetch(`${baseUrl}${urlPath}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		const text = await resp.text();
		let data: unknown;
		try { data = JSON.parse(text); } catch { data = text; }
		if (!resp.ok) {
			const msg = typeof data === "object" && data !== null && "error" in data
				? String((data as Record<string, unknown>).error)
				: `HTTP ${resp.status}: ${text}`;
			throw new Error(msg);
		}
		return data;
	}

	function ok(data: unknown) {
		return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: undefined };
	}

	function err(msg: string) {
		return { content: [{ type: "text" as const, text: msg }], details: undefined, isError: true };
	}

	pi.registerTool({
		name: "mission_status",
		label: "Mission Status",
		description: "Full mission summary — mission record, plan, child goals, gates, integration branch.",
		promptSnippet: "Get the full mission summary.",
		parameters: Type.Object({}),
		async execute() {
			try { return ok(await api("GET", `/api/missions/${missionId}`)); }
			catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "mission_goal_status",
		label: "Mission Child Goal Status",
		description: "List child goal states for the mission, optionally filtered to one plan node.",
		promptSnippet: "List mission child goal states.",
		parameters: Type.Object({
			planId: Type.Optional(Type.String({ description: "Plan node id to filter to" })),
		}),
		async execute(_id, params) {
			try {
				const detail = await api("GET", `/api/missions/${missionId}`) as any;
				const children = Array.isArray(detail?.children) ? detail.children : [];
				const filtered = params.planId ? children.filter((c: any) => c.planId === params.planId) : children;
				return ok(filtered);
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "mission_plan_propose",
		label: "Mission Plan Propose",
		description: "Propose or update the mission plan (DAG of child goals). Server validates DAG; rejects if plan is frozen unless mission is paused with a replan_reason.",
		promptSnippet: "Write or update the mission plan.",
		parameters: Type.Object({
			plan: Type.Any({ description: "MissionPlan: { goals[], dependencies[], rationale, estimatedConcurrency, version }" }),
			replan_reason: Type.Optional(Type.String({ description: "Required when re-proposing a frozen plan; mission must be paused" })),
		}),
		async execute(_id, params) {
			try {
				const body: Record<string, unknown> = { plan: params.plan };
				if (params.replan_reason) body.replan_reason = params.replan_reason;
				return ok(await api("PATCH", `/api/missions/${missionId}/plan`, body));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "mission_goal_spawn",
		label: "Mission Goal Spawn",
		description: "Spawn a child goal for a plan node. Idempotent on (missionId, planId). Server enforces goal-plan gate passed and deps complete.",
		promptSnippet: "Spawn a child goal for a plan node.",
		parameters: Type.Object({
			planId: Type.String({ description: "Plan node id to spawn" }),
		}),
		async execute(_id, params) {
			try { return ok(await api("POST", `/api/missions/${missionId}/spawn-child/${encodeURIComponent(params.planId)}`)); }
			catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "mission_merge_child",
		label: "Mission Merge Child",
		description: "Merge a completed child goal's branch into the mission integration branch. Detects already-merged; reports conflicts.",
		promptSnippet: "Merge a child goal into the integration branch.",
		parameters: Type.Object({
			planId: Type.String({ description: "Plan node id to merge" }),
		}),
		async execute(_id, params) {
			try { return ok(await api("POST", `/api/missions/${missionId}/integrate-child/${encodeURIComponent(params.planId)}`)); }
			catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "mission_signal",
		label: "Mission Signal Gate",
		description: "Signal a mission-level workflow gate (charter, plan-review, goal-plan, execution, integration, mission-pr).",
		promptSnippet: "Signal a mission workflow gate.",
		parameters: Type.Object({
			gate_id: Type.String({ description: "Mission gate id (e.g. charter, plan-review, goal-plan, execution, integration, mission-pr)" }),
			content: Type.Optional(Type.String({ description: "Markdown content for content gates" })),
			metadata: Type.Optional(Type.Record(Type.String(), Type.String(), {
				description: "Flat key-value metadata for the gate signal (string \u2192 string). Pass an object literal, never a JSON string.",
			})),
		}),
		async execute(_id, params) {
			// TODO(mission-gate-owner): rewire to gateStore.signal({
			//   ownerKind: "mission", ownerId: missionId, gateId: params.gate_id, content: params.content
			// }) once the gate-store generalisation in Coder B's branch lands.
			// For phase 1 the endpoint returns 501 — surface that loudly so
			// Commander never assumes the signal succeeded.
			try {
				const body: Record<string, unknown> = {};
				if (params.content !== undefined) body.content = params.content;
				if (params.metadata !== undefined) body.metadata = params.metadata;
				return ok(await api("POST", `/api/missions/${missionId}/gates/${encodeURIComponent(params.gate_id)}/signal`, body));
			} catch (e: any) { return err(e.message); }
		},
	});

	console.log(`[mission-tools] Registered 6 mission tools for session ${sessionId}, mission ${missionId}`);
}
