import type { VerifyStep, WorkflowGate } from "../workflow-store.js";
import type { GateSignal, GateSignalStep } from "../gate-store.js";

export interface VerifyStepResult {
	passed: boolean;
	output: string;
	sessionId?: string;
	artifact?: GateSignalStep["artifact"];
}

export type GateStateContextEntry = {
	metadata?: Record<string, string>;
	content?: string;
	status?: string;
	injectDownstream?: boolean;
};

export interface VerifyExecCtx {
	goalId: string;
	gateId: string;
	signalId: string;
	signal: GateSignal;
	gate: WorkflowGate;
	cwd: string;
	branch: string;
	primaryBranch: string;
	goalSpec?: string;
	allGateStates?: Map<string, GateStateContextEntry>;
	builtinVars: Record<string, string>;
	projectVars: Record<string, string>;
	agentVars: Record<string, string>;
	substituteVars(template: string): string;
	broadcast(event: unknown): void;
	persistActive(): void;
	isCancelled(): boolean;

	/**
	 * Spawn a one-shot LLM reviewer sub-agent. Returns the structured result
	 * exactly as it would be produced by a top-level `type: llm-review` step.
	 * Handlers (e.g. rubric-review/llm) use this to delegate to the existing
	 * reviewer-session machinery without re-implementing it.
	 */
	runLlmReview?(args: {
		prompt: string;
		role?: string;
		timeout?: number;
	}): Promise<VerifyStepResult>;
}

export interface VerifyHandler {
	readonly type: string;
	execute(ctx: VerifyExecCtx, step: VerifyStep): Promise<VerifyStepResult>;
}

export class VerifyHandlerRegistry {
	private handlers = new Map<string, VerifyHandler>();

	register(handler: VerifyHandler): void {
		this.handlers.set(handler.type, handler);
	}

	unregister(type: string): void {
		this.handlers.delete(type);
	}

	get(type: string): VerifyHandler | undefined {
		return this.handlers.get(type);
	}

	has(type: string): boolean {
		return this.handlers.has(type);
	}

	types(): string[] {
		return [...this.handlers.keys()];
	}
}

export function unknownTypeFailureResult(type: string): VerifyStepResult {
	return {
		passed: false,
		output: `No handler registered for verify step type '${type}'. The plugin that shipped this type may not be loaded or trusted.`,
	};
}
