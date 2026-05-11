import { randomUUID } from "node:crypto";
import type { VerifyHandler, VerifyExecCtx, VerifyStepResult } from "./registry.js";
import type { VerifyStep } from "../workflow-store.js";

/**
 * `external-job` waits for an external system (training run, batch experiment,
 * scheduled compute) to POST a verdict to `/api/verify/external/:token`.
 *
 * The step's `timeout` (seconds, default 24h) bounds the wait. The callback
 * must echo the goalId/gateId/signalId triple it was issued for; otherwise a
 * leaked token would be a gate-control primitive.
 *
 * v1: in-memory token store. Gateway restart drops pending callbacks; they
 * time out cleanly. Restart-resume is a follow-up.
 */

const DEFAULT_TIMEOUT_SECONDS = 24 * 60 * 60;

interface PendingExternal {
	token: string;
	goalId: string;
	gateId: string;
	signalId: string;
	stepName: string;
	expiresAt: number;
	resolve(result: VerifyStepResult): void;
}

const pending = new Map<string, PendingExternal>();

export interface ExternalJobCallbackBody {
	goalId: string;
	gateId: string;
	signalId: string;
	passed: boolean;
	summary?: string;
	artifact?: {
		content: string;
		contentType: string;
		metadata?: Record<string, string>;
	};
}

export type ExternalJobCallbackOutcome =
	| { ok: true }
	| { ok: false; status: number; error: string };

export function deliverExternalJobCallback(token: string, body: ExternalJobCallbackBody): ExternalJobCallbackOutcome {
	const entry = pending.get(token);
	if (!entry) {
		return { ok: false, status: 404, error: "unknown or already-resolved token" };
	}
	if (Date.now() > entry.expiresAt) {
		pending.delete(token);
		return { ok: false, status: 410, error: "token expired" };
	}
	if (entry.goalId !== body.goalId || entry.gateId !== body.gateId || entry.signalId !== body.signalId) {
		return { ok: false, status: 403, error: "token does not match goal/gate/signal triple" };
	}
	pending.delete(token);
	entry.resolve({
		passed: body.passed === true,
		output: body.summary ?? (body.passed ? "External job reported success." : "External job reported failure."),
		artifact: body.artifact,
	});
	return { ok: true };
}

export function pendingExternalCount(): number {
	return pending.size;
}

/** Test-only: clear all pending entries. Do not call from production code. */
export function _clearPendingExternalForTests(): void {
	pending.clear();
}

export const externalJobHandler: VerifyHandler = {
	type: "external-job",
	async execute(ctx: VerifyExecCtx, step: VerifyStep): Promise<VerifyStepResult> {
		const timeoutSeconds = typeof step.timeout === "number" && step.timeout > 0 ? step.timeout : DEFAULT_TIMEOUT_SECONDS;
		const token = randomUUID();
		const expiresAt = Date.now() + timeoutSeconds * 1000;
		const entry: PendingExternal = {
			token,
			goalId: ctx.goalId,
			gateId: ctx.gateId,
			signalId: ctx.signalId,
			stepName: step.name,
			expiresAt,
			resolve: () => {},
		};

		ctx.broadcast({
			type: "gate_verification_external_pending",
			goalId: ctx.goalId,
			gateId: ctx.gateId,
			signalId: ctx.signalId,
			stepName: step.name,
			token,
			expiresAt,
		});

		return new Promise<VerifyStepResult>(resolve => {
			entry.resolve = resolve;
			pending.set(token, entry);

			const timer = setTimeout(() => {
				if (pending.delete(token)) {
					resolve({
						passed: false,
						output: `External job timed out after ${timeoutSeconds}s. No callback was received on POST /api/verify/external/${token}.`,
					});
				}
			}, timeoutSeconds * 1000);
			if (typeof timer.unref === "function") timer.unref();
		});
	},
};
