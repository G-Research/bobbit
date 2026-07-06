// src/server/routes/goal-gate-heavy-routes.ts
//
// STR-01 goals cohort G3a: heavy gate signal/inspect routes migrated out of
// handleApiRoute's legacy if/else chain into the core route registry.
// See docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx and registry params
// replacing regex captures.

import { randomUUID } from "node:crypto";
import fs from "node:fs";

import { computePlanFreezeUpdate } from "../agent/parent-workflow-freeze.js";
import { goalBranchContainer } from "../agent/verification-harness.js";
import type { Workflow } from "../agent/workflow-store.js";
import {
	GateArtifactResolutionError,
	buildArtifactLookup,
	isTextInspectableArtifact,
	resolveArtifactFromLookup,
	stripPlaywrightErrorContextBoilerplate,
	validateRetainedArtifactPath,
} from "../gate-artifacts.js";
import { buildGateVerificationSnapshot, UnknownVerificationStepError } from "../gate-verification-snapshot.js";
import { detectPrimaryBranch, parseBaseRef } from "../skills/git.js";
import { execGitSafe } from "../skills/git-gh.js";
import {
	TextSelectionError,
	selectText,
	type TextSelectionMode,
	type TextSelectionOptions,
} from "../utils/text-selection.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

function parseGateInspectIntegerParam(params: URLSearchParams, name: string): number | undefined {
	const raw = params.get(name);
	if (raw === null || raw === "") return undefined;
	if (!/^-?\d+$/.test(raw)) throw new TextSelectionError(`${name} must be an integer`);
	return Number(raw);
}

function parseGateInspectSelectionOptions(params: URLSearchParams): TextSelectionOptions {
	const rawMode = params.get("mode");
	let mode: TextSelectionMode | undefined;
	if (rawMode !== null) {
		if (!["full", "grep", "head", "tail", "slice"].includes(rawMode)) {
			throw new TextSelectionError(`mode must be one of: full, grep, head, tail, slice`);
		}
		mode = rawMode as TextSelectionMode;
	}
	return {
		mode,
		implicitDefault: rawMode === null,
		pattern: params.get("pattern") ?? undefined,
		context: parseGateInspectIntegerParam(params, "context"),
		maxResults: parseGateInspectIntegerParam(params, "max_results"),
		lines: parseGateInspectIntegerParam(params, "lines"),
		from: parseGateInspectIntegerParam(params, "from"),
		to: parseGateInspectIntegerParam(params, "to"),
	};
}

/** Check if gateId transitively depends on targetId in the workflow DAG */
function hasTransitiveDep(workflow: Workflow, gateId: string, targetId: string, visited = new Set<string>()): boolean {
	if (visited.has(gateId)) return false;
	visited.add(gateId);
	const gate = workflow.gates.find(g => g.id === gateId);
	if (!gate) return false;
	for (const dep of gate.dependsOn) {
		if (dep === targetId) return true;
		if (hasTransitiveDep(workflow, dep, targetId, visited)) return true;
	}
	return false;
}

// GET /api/goals/:goalId/gates/:gateId/inspect — scoped gate data retrieval
async function handleGoalGateInspect(routeCtx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, projectContextManager, url, verificationHarness } = routeCtx;
	const goalId = params.goalId;
	const gateId = params.gateId;
	const ctx = projectContextManager.getContextForGoal(goalId);
	if (!ctx) { json({ error: "Goal not found" }, 404); return; }
	const gate = ctx.gateStore.getGate(goalId, gateId);
	if (!gate) { json({ error: "Gate not found" }, 404); return; }

	const section = url.searchParams.get("section");
	if (!section || !["content", "verification", "signals", "artifact"].includes(section)) {
		json({ error: "section query parameter is required: 'content', 'verification', 'signals', or 'artifact'" }, 400);
		return;
	}

	const stepName = url.searchParams.get("step") ?? undefined;
	if (stepName !== undefined && section !== "verification" && section !== "artifact") {
		json({ error: "step is only valid with section='verification' or section='artifact'" }, 400);
		return;
	}
	if (url.searchParams.has("retry") && section !== "artifact") {
		json({ error: "retry is only valid with section='artifact'" }, 400);
		return;
	}

	let selectionOptions: TextSelectionOptions;
	try {
		selectionOptions = { ...parseGateInspectSelectionOptions(url.searchParams), includeDiagnostics: true };
		if (section === "artifact" && selectionOptions.mode === undefined) {
			selectionOptions = { ...selectionOptions, mode: "tail", lines: selectionOptions.lines ?? 200 };
		}
		selectText("", selectionOptions);
	} catch (err) {
		if (err instanceof TextSelectionError) { json({ error: err.message }, 400); return; }
		throw err;
	}

	const resolveSignal = () => {
		const idxStr = url.searchParams.get("signal_index");
		let idx = idxStr !== null ? parseInt(idxStr, 10) : -1;
		if (isNaN(idx)) idx = -1;
		if (idx < 0) idx = gate.signals.length + idx;
		if (idx < 0 || idx >= gate.signals.length) return null;
		return { signal: gate.signals[idx], index: idx };
	};

	if (section === "content") {
		const resolved = resolveSignal();
		if (!resolved) { json({ error: "Signal not found" }, 404); return; }
		try {
			const rawText = resolved.signal.content || "";
			const selected = selectText(rawText, selectionOptions);
			json({
				gateId, section: "content",
				signalIndex: resolved.index,
				signalId: resolved.signal.id,
				text: resolved.signal.content ? selected.text : null,
				selection: selected.selection,
			});
		} catch (err) {
			if (err instanceof TextSelectionError) { json({ error: err.message }, 400); return; }
			throw err;
		}
		return;
	}

	if (section === "verification") {
		const resolved = resolveSignal();
		if (!resolved) { json({ error: "Signal not found" }, 404); return; }
		try {
			const snapshot = buildGateVerificationSnapshot({
				goalId,
				gateId,
				signalId: resolved.signal.id,
				verification: resolved.signal.verification,
				activeVerification: verificationHarness.getActiveVerification(resolved.signal.id),
				selectionOptions,
				stepName,
			});
			json({
				gateId, section: "verification",
				signalIndex: resolved.index,
				signalId: resolved.signal.id,
				status: snapshot.status,
				summary: snapshot.summary,
				counts: snapshot.counts,
				active: snapshot.active,
				steps: snapshot.steps,
				selection: snapshot.selection,
			});
		} catch (err) {
			if (err instanceof TextSelectionError) { json({ error: err.message }, 400); return; }
			if (err instanceof UnknownVerificationStepError) { json({ error: err.message }, 400); return; }
			throw err;
		}
		return;
	}

	if (section === "artifact") {
		const resolved = resolveSignal();
		if (!resolved) { json({ error: "Signal not found" }, 404); return; }
		const artifactTarget = url.searchParams.get("artifact") ?? "";
		if (!artifactTarget) {
			json({ error: "artifact query parameter is required with section='artifact'" }, 400);
			return;
		}
		let retry: number | undefined;
		const rawRetry = url.searchParams.get("retry");
		if (rawRetry !== null && rawRetry !== "") {
			if (!/^\d+$/.test(rawRetry)) { json({ error: "retry must be a non-negative integer" }, 400); return; }
			retry = Number(rawRetry);
		}

		const candidateSteps = resolved.signal.verification.steps.filter(step =>
			step.type === "command"
			&& step.diagnostics
			&& step.diagnostics.artifacts
			&& step.diagnostics.artifacts.length > 0
			&& (stepName === undefined || step.name === stepName),
		);
		if (stepName !== undefined && candidateSteps.length === 0) {
			json({
				error: `Unknown verification step "${stepName}" with retained artifacts.`,
				validSteps: resolved.signal.verification.steps
					.filter(step => step.type === "command" && step.diagnostics?.artifacts?.length)
					.map(step => step.name),
			}, 400);
			return;
		}

		const matches: Array<{ stepName: string; diagnostics: NonNullable<typeof candidateSteps[number]["diagnostics"]>; artifact: ReturnType<typeof resolveArtifactFromLookup> }> = [];
		const resolutionErrors: Array<{ stepName: string; error: GateArtifactResolutionError }> = [];
		const validSteps = candidateSteps.map(step => step.name);
		const validArtifactsByStep = candidateSteps.map(step => {
			const lookup = buildArtifactLookup(step.diagnostics);
			return {
				step: step.name,
				validArtifactIds: [...new Set(lookup.index.files.map(file => file.id))],
				validArtifacts: lookup.index.files.map(file => ({ id: file.id, relativePath: file.relativePath, retry: file.retry })),
			};
		});
		for (const step of candidateSteps) {
			if (!step.diagnostics) continue;
			const lookup = buildArtifactLookup(step.diagnostics);
			try {
				matches.push({
					stepName: step.name,
					diagnostics: step.diagnostics,
					artifact: resolveArtifactFromLookup(lookup, artifactTarget, retry),
				});
			} catch (err) {
				if (!(err instanceof GateArtifactResolutionError)) throw err;
				resolutionErrors.push({ stepName: step.name, error: err });
			}
		}

		if (matches.length === 0) {
			const nonUnknownError = resolutionErrors.find(({ error }) => !error.message.startsWith(`Unknown artifact "${artifactTarget}".`));
			json({ error: nonUnknownError?.error.message ?? `Unknown artifact "${artifactTarget}".`, validSteps, validArtifactsByStep }, 400);
			return;
		}
		if (matches.length > 1) {
			json({
				error: `Artifact "${artifactTarget}" is ambiguous across verification steps; pass step to disambiguate.`,
				validSteps: matches.map(match => match.stepName),
				validArtifacts: matches.map(match => ({ step: match.stepName, id: match.artifact.id, relativePath: match.artifact.relativePath, retry: match.artifact.retry })),
			}, 400);
			return;
		}

		const match = matches[0];
		try {
			const retainedPath = validateRetainedArtifactPath(match.diagnostics, match.artifact);
			if (!isTextInspectableArtifact(match.artifact)) {
				json({ error: `Artifact "${match.artifact.relativePath}" is not a text artifact; use read(path) or inspect the file directly.`, validSteps, validArtifactsByStep }, 400);
				return;
			}
			let text = fs.readFileSync(retainedPath, "utf8");
			if (match.artifact.relativePath.endsWith("/error-context.md") || match.artifact.relativePath === "error-context.md") {
				text = stripPlaywrightErrorContextBoilerplate(text);
			}
			const selected = selectText(text, selectionOptions);
			json({
				gateId, section: "artifact",
				signalIndex: resolved.index,
				signalId: resolved.signal.id,
				step: match.stepName,
				artifact: match.artifact,
				text: selected.text,
				selection: selected.selection,
			});
		} catch (err) {
			if (err instanceof TextSelectionError) { json({ error: err.message }, 400); return; }
			if (err instanceof Error) { json({ error: err.message, validSteps, validArtifactsByStep }, 400); return; }
			throw err;
		}
		return;
	}

	if (section === "signals") {
		const summaries = gate.signals.map((s, i) => ({
			index: i,
			id: s.id,
			timestamp: s.timestamp,
			sessionId: s.sessionId,
			commitSha: s.commitSha,
			verdict: s.verification?.status || "running",
			hasContent: !!s.content,
			metadataKeys: s.metadata ? Object.keys(s.metadata) : [],
		}));
		try {
			const rendered = summaries.map(s => JSON.stringify(s)).join("\n");
			const selected = selectText(rendered, selectionOptions);
			const selectedLines = new Set(selected.selectedLineNumbers);
			const signals = summaries.filter((_, i) => selectedLines.has(i + 1));
			json({
				gateId, section: "signals",
				signals,
				signalsTotal: summaries.length,
				signalsShown: signals.length,
				signalsTruncated: signals.length < summaries.length,
				text: selected.text,
				selection: selected.selection,
			});
		} catch (err) {
			if (err instanceof TextSelectionError) { json({ error: err.message }, 400); return; }
			throw err;
		}
		return;
	}
}

// POST /api/goals/:goalId/gates/:gateId/signal — signal a gate
async function handleGoalGateSignal(routeCtx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const {
		broadcastToGoal,
		getGoalAcrossProjects,
		json,
		projectContextManager,
		readBody,
		req,
		verificationHarness,
	} = routeCtx;
	const goalId = params.goalId;
	const gateId = params.gateId;
	const goal = getGoalAcrossProjects(goalId);
	if (!goal) { json({ error: "Goal not found" }, 404); return; }
	if (goal.archived) { json({ error: "Goal is archived" }, 409); return; }
	// Pause-cascade: a paused goal must reject gate signals. This is the
	// most upstream block for both llm-review-* verifier spawns and
	// command/qa-step kickoffs in the same handler chain.
	if (goal.paused) { json({ error: `Goal ${goalId} is paused`, code: "GOAL_PAUSED", goalId }, 409); return; }
	if (!goal.workflow) { json({ error: "Goal has no workflow" }, 400); return; }
	const gateSignalCtx = projectContextManager.getContextForGoal(goalId);
	if (!gateSignalCtx) { json({ error: "Goal not found in any project" }, 404); return; }
	const gateStore = gateSignalCtx.gateStore;
	const gateDef = goal.workflow.gates.find(g => g.id === gateId);
	if (!gateDef) { json({ error: `Unknown gate: ${gateId}` }, 404); return; }

	const body = await readBody(req);
	const signalSessionId = body?.sessionId || "unknown";

	// Validate dependencies are met
	for (const depId of gateDef.dependsOn) {
		const depGate = gateStore.getGate(goalId, depId);
		// A bypassed upstream gate counts as satisfied (like passed).
		if (!depGate || (depGate.status !== "passed" && depGate.status !== "bypassed")) {
			const depDef = goal.workflow.gates.find(g => g.id === depId);
			json({ error: `Upstream gate "${depDef?.name || depId}" has not passed yet` }, 409);
			return;
		}
	}

	// Validate metadata against gate's schema
	if (gateDef.metadata && body?.metadata) {
		for (const key of Object.keys(gateDef.metadata)) {
			if (!(key in body.metadata)) {
				json({ error: `Missing required metadata field: ${key}` }, 400);
				return;
			}
		}
	} else if (gateDef.metadata && !body?.metadata) {
		const required = Object.keys(gateDef.metadata);
		if (required.length > 0) {
			json({ error: `Missing required metadata fields: ${required.join(", ")}` }, 400);
			return;
		}
	}

	// Gov-2: an ACCEPTED signal of the `goal-plan` gate on a parent-workflow
	// goal FREEZES the execution gate's verify[] (sets
	// execution.metadata.frozen = "true" durably on the goal's workflow
	// snapshot). Applied here — after dependency/metadata validation has
	// passed (so a rejected signal never freezes) but before the
	// cache/dup early-return branches (so the freeze is durable even when
	// the signal short-circuits to a cached pass). Idempotent: re-signal is
	// a harmless no-op write. After this, GET /api/goals/:id/plan reports
	// frozen:true. See src/server/agent/parent-workflow-freeze.ts.
	const freezeResult = computePlanFreezeUpdate(goal, gateId);
	if (freezeResult.freeze && freezeResult.workflow) {
		// Persist via the goal store's `update` (same path applyPlanSteps
		// uses) — `updateGoal`'s partial type does not expose `workflow`.
		gateSignalCtx.goalManager.getGoalStore().update(goalId, { workflow: freezeResult.workflow });
		goal.workflow = freezeResult.workflow;
	}

	// Get commit SHA
	let commitSha = "unknown";
	try {
		commitSha = await execGitSafe("git rev-parse HEAD", goal.cwd, "unknown");
	} catch { /* ignore */ }

	// Reject if verification is already running for this gate+commit
	if (commitSha !== "unknown") {
		const activeVers = verificationHarness.getActiveVerifications(goalId);
		const runningDup = activeVers.find(v => {
			if (v.gateId !== gateId || v.overallStatus !== "running") return false;
			const gs = gateStore.getGate(goalId, gateId);
			const s = gs?.signals.find(s => s.id === v.signalId);
			return s?.commitSha === commitSha;
		});
		if (runningDup) {
			// Check if sessions are actually alive — auto-cancel zombies
			const alive = verificationHarness.areVerificationSessionsAlive(runningDup.signalId);
			if (!alive) {
				console.log(`[api] Auto-cancelling zombie verification ${runningDup.signalId} for gate ${gateId}`);
				await verificationHarness.cancelStaleVerifications(goalId, gateId);
				// Fall through to create new signal
			} else {
				// Surface the step states so a future 409 is diagnosable from
				// logs alone — see goal "Unstick verification lock on restart".
				const stepSummary = runningDup.steps.map((s: any) => ({
					name: s.name,
					status: s.status,
					pid: s.pid,
					bootEpoch: s.bootEpoch,
					sessionId: s.sessionId,
				}));
				console.warn(`[api] Rejecting gate_signal as duplicate: gate=${gateId} signalId=${runningDup.signalId} aliveCheck=true steps=${JSON.stringify(stepSummary)}`);
				json({ error: "Verification already in progress for this commit", existingSignalId: runningDup.signalId }, 409);
				return;
			}
		}
	}

	// Auto-pass if a prior signal for the same commit already fully passed.
	// Manual reset preserves signal history for auditability, so this route-level
	// fast path must honor the same reset cache boundary as VerificationHarness.
	// Human sign-offs are never reusable consent; let the harness run them again.
	if (commitSha !== "unknown") {
		const existingGateForCache = gateStore.getGate(goalId, gateId);
		if (existingGateForCache) {
			const cacheInvalidatedAt = existingGateForCache.verificationCacheInvalidatedAt;
			const incomingContent = typeof body?.content === "string" ? body.content : "";
			const priorPassed = existingGateForCache.signals.find(s =>
				s.commitSha === commitSha
				&& ((typeof s.content === "string" ? s.content : "") === incomingContent)
				&& s.verification?.status === "passed"
				&& (cacheInvalidatedAt === undefined || s.timestamp > cacheInvalidatedAt)
				&& !s.verification.steps.some(step => step.type === "human-signoff")
			);
			if (priorPassed?.verification) {
				const phaseByStepName = new Map((gateDef.verify || []).map((s: any) => [s.name, s.phase ?? 0]));
				const cachedSteps = priorPassed.verification.steps.map((s: any) => {
					const status = s.skipped ? "skipped" : (s.status ?? (s.passed ? "passed" : "failed"));
					return {
						...s,
						status,
						...(status === "skipped" ? { skipped: true } : {}),
						phase: s.phase ?? phaseByStepName.get(s.name) ?? 0,
						output: `[cached from prior signal] ${s.output}`,
					};
				});
				// Create a signal record with cached results
				const cachedSignal = {
					id: randomUUID(),
					gateId,
					goalId,
					sessionId: body?.sessionId || "unknown",
					timestamp: Date.now(),
					commitSha,
					metadata: body?.metadata,
					content: body?.content,
					contentVersion: body?.content ? (existingGateForCache.currentContentVersion || 0) + 1 : undefined,
					verification: {
						status: "passed" as const,
						steps: cachedSteps,
					},
				};
				gateStore.recordSignal(cachedSignal);
				if (body?.content && cachedSignal.contentVersion) {
					gateStore.updateGateContent(goalId, gateId, body.content, cachedSignal.contentVersion);
				}
				if (body?.metadata) {
					gateStore.updateGateMetadata(goalId, gateId, body.metadata);
				}
				gateStore.updateGateStatus(goalId, gateId, "passed");
				broadcastToGoal(goalId, { type: "gate_signal_received", goalId, gateId, signalId: cachedSignal.id });
				broadcastToGoal(goalId, { type: "gate_verification_complete", goalId, gateId, signalId: cachedSignal.id, status: "passed" });
				broadcastToGoal(goalId, { type: "gate_status_changed", goalId, gateId, status: "passed" });
				const verifySteps = cachedSignal.verification.steps.map((s: any) => ({
					name: s.name,
					type: s.type,
					status: s.status,
					passed: s.passed,
					skipped: s.skipped,
					phase: s.phase,
					duration_ms: s.duration_ms,
					output: s.output,
				}));
				json({ signal: { id: cachedSignal.id, gateId, goalId, status: "passed", steps: verifySteps, cached: true } }, 201);
				return;
			}
		}
	}

	// Compute content version
	const existingGate = gateStore.getGate(goalId, gateId);
	const contentVersion = body?.content ? (existingGate?.currentContentVersion || 0) + 1 : undefined;

	// Check if this is a re-signal of a passed gate — cascade reset
	if (existingGate && existingGate.status === "passed") {
		gateStore.cascadeReset(goalId, gateId, goal.workflow);
		// Broadcast resets for downstream gates
		for (const g of goal.workflow.gates) {
			if (g.dependsOn.includes(gateId) || hasTransitiveDep(goal.workflow, g.id, gateId)) {
				const downstream = gateStore.getGate(goalId, g.id);
				if (downstream) {
					broadcastToGoal(goalId, { type: "gate_status_changed", goalId, gateId: g.id, status: downstream.status });
				}
			}
		}
	}

	// Cancel any in-flight verifications for the same gate BEFORE seeding
	// the new one — otherwise cancelStaleVerifications would observe and
	// tear down the just-seeded active entry.
	await verificationHarness.cancelStaleVerifications(goalId, gateId);

	// Create signal record. Step enumeration is performed synchronously
	// via `beginVerification` BEFORE `recordSignal` so the gate-store and
	// `activeVerifications` agree on the step list from the very first
	// persisted state. See goal "Fix verification progress race".
	const signalId = randomUUID();
	const signal = {
		id: signalId,
		gateId,
		goalId,
		sessionId: signalSessionId,
		timestamp: Date.now(),
		commitSha,
		metadata: body?.metadata,
		content: body?.content,
		contentVersion,
		verification: { status: "running" as const, steps: [] as any[] },
	};

	const initialSteps = verificationHarness.beginVerification(signal as any, gateDef);
	signal.verification = { status: "running", steps: initialSteps };

	gateStore.recordSignal(signal);

	// Update gate content/metadata if provided
	if (body?.content && contentVersion) {
		gateStore.updateGateContent(goalId, gateId, body.content, contentVersion);
	}
	if (body?.metadata) {
		gateStore.updateGateMetadata(goalId, gateId, body.metadata);
	}

	// Broadcast signal received
	broadcastToGoal(goalId, { type: "gate_signal_received", goalId, gateId, signalId: signal.id });

	// Broadcast verification started AFTER signal received — WS clients
	// depend on this ordering (see tests/e2e/verification-core.spec.ts
	// "WS events have correct shape, timestamps, and ordering"). The
	// `gate_verification_started` event used to be fired synchronously
	// inside `beginVerification` which inverted the order on the wire.
	const activeForBroadcast = verificationHarness.getActiveVerification(signal.id);
	if (activeForBroadcast && initialSteps.length > 0) {
		broadcastToGoal(goalId, {
			type: "gate_verification_started",
			goalId,
			gateId,
			signalId: signal.id,
			startedAt: activeForBroadcast.startedAt,
			steps: (gateDef.verify || []).map((s: any) => ({ name: s.name, type: s.type, phase: s.phase ?? 0 })),
		});
	}

	// Build gate state map for metadata variable resolution + LLM reviewer context
	const allGateStates = new Map<string, { metadata?: Record<string, string>; content?: string; status?: string; injectDownstream?: boolean }>();
	for (const gs of gateStore.getGatesForGoal(goalId)) {
		const def = goal.workflow?.gates?.find((g: any) => g.id === gs.gateId);
		allGateStates.set(gs.gateId, {
			metadata: gs.currentMetadata,
			content: gs.currentContent,
			status: gs.status,
			injectDownstream: def?.injectDownstream,
		});
	}

	// Fire-and-forget verification — project `base_ref` is the configured
	// integration target; when unset, fall back to the repo's detected primary.
	// `parseBaseRef` normalizes remote refs like `origin/master` to `master`
	// for workflow variables such as `{{baseBranch}}` and legacy `{{master}}`.
	const branchContainer = goalBranchContainer(goal);
	const configuredBase = parseBaseRef(gateSignalCtx.projectConfigStore.get("base_ref") || "");
	const primary = configuredBase.branch || (await detectPrimaryBranch(branchContainer).catch(() => "master"));
	verificationHarness.verifyGateSignal(
		signal, gateDef, branchContainer, goal.branch, primary, allGateStates, goal.spec,
	).catch(err => console.error("[verification] Gate signal error:", err));

	const verifySteps = initialSteps.map((s: any) => ({
		name: s.name,
		type: s.type,
		status: s.status,
		passed: s.passed,
		skipped: s.skipped,
		phase: s.phase,
		duration_ms: s.duration_ms,
		output: s.output,
	}));
	const signalResponse = { id: signal.id, gateId, goalId, status: "running", steps: verifySteps };
	const response: { signal: typeof signalResponse; agentReminder?: string } = { signal: signalResponse };
	if (verificationHarness.getActiveVerification(signal.id)?.overallStatus === "running") {
		response.agentReminder = "Gate signal accepted. Verification is running asynchronously. Do not poll with `gate_status` or `gate_inspect`. Go idle now and wait for the server to deliver verification results or further instructions.";
	}
	json(response, 201);
	return;
}

export function registerGoalGateHeavyRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/goals/:goalId/gates/:gateId/inspect", handleGoalGateInspect);
	table.register("POST", "/api/goals/:goalId/gates/:gateId/signal", handleGoalGateSignal);
}
