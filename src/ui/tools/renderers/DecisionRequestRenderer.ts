import { html, type TemplateResult } from "lit";
import { ensureAskUserChoicesWidget } from "../../../app/lazy-widgets.js";
import {
	answerDecisionRequest,
	type DecisionRequestProjection,
	type DecisionRequestWidgetProjection,
	type DecisionValue,
} from "../../../app/extension-decisions.js";
import type { AskAnswer, AskQuestion, SubmitAnswers } from "../../components/AskUserChoicesWidget.js";

export function answersFromResolution(request: DecisionRequestWidgetProjection): AskAnswer[] | null {
	const value = request.resolution?.value;
	if (!value) return null;
	const selected = value.kind === "option"
		? request.options.find((option) => option.value === value.value)?.label
		: "Other";
	if (!selected) return null;
	return [{
		question: request.question,
		selected,
		other_text: value.kind === "other" ? value.text : null,
	}];
}

export function decisionValueFromAnswer(request: DecisionRequestWidgetProjection, answers: AskAnswer[]): DecisionValue {
	const answer = answers[0];
	if (!answer || Array.isArray(answer.selected)) throw new Error("Invalid decision answer");
	if (answer.selected === "Other") {
		const text = typeof answer.other_text === "string" ? answer.other_text.trim() : "";
		if (!text) throw new Error("Other answer is required");
		return { kind: "other", text };
	}
	const option = request.options.find((candidate) => candidate.label === answer.selected);
	if (!option) throw new Error("Invalid decision option");
	return { kind: "option", value: option.value };
}

/**
 * Thin data adapter over the existing ask-user-choices widget. It deliberately
 * owns no option DOM, validation, keyboard handling, ARIA, or draft mechanics.
 */
export function statusLabel(request: DecisionRequestWidgetProjection): string | null {
	if (request.status === "paused-awaiting-consent") return "Awaiting consent";
	if (request.status === "defaulted") return "Default applied";
	if (request.status === "denied") return "Denied";
	return null;
}

export function unavailableMessage(request: DecisionRequestWidgetProjection): string {
	if (request.status === "denied") return "This consent request was denied.";
	if (request.status === "defaulted") return "The safe default was applied.";
	return "This decision is no longer available.";
}

/** A decision answer is accepted only when the server supplies its settled value. */
export function answersFromAuthoritativeSettlement(request: DecisionRequestWidgetProjection | null): AskAnswer[] | null {
	if (!request || (request.status !== "resolved" && request.status !== "defaulted")) return null;
	return answersFromResolution(request);
}

export function submissionFailureMessage(request: DecisionRequestWidgetProjection | null): string {
	if (request?.status === "denied") return unavailableMessage(request);
	if (request?.status === "paused-awaiting-consent") return "This consent request is still awaiting consent.";
	return "This decision is no longer available.";
}

export class DecisionRequestRenderer {
	render(request: DecisionRequestProjection, sessionId: string): TemplateResult {
		void ensureAskUserChoicesWidget();
		const question: AskQuestion = {
			question: request.question,
			options: request.options.map((option) => option.label),
		};
		const actionable = request.status === "pending" || request.status === "paused-awaiting-consent";
		const submitAnswers: SubmitAnswers | undefined = actionable
			? async (answers) => {
				const terminal = await answerDecisionRequest(
					sessionId,
					request.id,
					decisionValueFromAnswer(request, answers),
				);
				// The response is authoritative. Do not let a denied, paused, or
				// malformed response turn the clicked draft into a false acceptance.
				const settledAnswers = answersFromAuthoritativeSettlement(terminal);
				if (settledAnswers) return settledAnswers;
				throw new Error(submissionFailureMessage(terminal));
			}
			: undefined;
		const answers = answersFromResolution(request);
		const unavailable = !actionable && !answers;
		const label = statusLabel(request);
		return html`
			<section class="decision-request space-y-2" data-decision-request-id=${request.id} tabindex="-1">
				<div class="flex items-center gap-2">
					<div class="text-sm font-medium">${request.title}</div>
					${request.decisionClass === "consent-required"
						? html`<span class="decision-class-label text-xs" data-testid="decision-consent-required">Consent required</span>`
						: ""}
					${label
						? html`<span class="decision-status-label text-xs" data-testid="decision-status-${request.status}">${label}</span>`
						: ""}
				</div>
				<ask-user-choices-widget
					.questions=${[question]}
					.answers=${answers}
					.sessionId=${sessionId}
					.toolUseId=${""}
					.draftKey=${request.id}
					.submitAnswers=${submitAnswers}
					.errored=${unavailable}
					.errorText=${unavailable ? unavailableMessage(request) : ""}
				></ask-user-choices-widget>
			</section>
		`;
	}
}
