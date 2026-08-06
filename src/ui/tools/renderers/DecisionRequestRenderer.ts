import { html, type TemplateResult } from "lit";
import { ensureAskUserChoicesWidget } from "../../../app/lazy-widgets.js";
import {
	answerDecisionRequest,
	type DecisionRequestProjection,
	type DecisionValue,
} from "../../../app/extension-decisions.js";
import type { AskAnswer, AskQuestion, SubmitAnswers } from "../../components/AskUserChoicesWidget.js";

function answersFromResolution(request: DecisionRequestProjection): AskAnswer[] | null {
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

function decisionValueFromAnswer(request: DecisionRequestProjection, answers: AskAnswer[]): DecisionValue {
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
export class DecisionRequestRenderer {
	render(request: DecisionRequestProjection, sessionId: string): TemplateResult {
		void ensureAskUserChoicesWidget();
		const question: AskQuestion = {
			question: request.question,
			options: request.options.map((option) => option.label),
		};
		const submitAnswers: SubmitAnswers | undefined = request.status === "pending"
			? async (answers) => {
				const terminal = await answerDecisionRequest(
					sessionId,
					request.id,
					decisionValueFromAnswer(request, answers),
				);
				// The response is authoritative. Returning its terminal value makes
				// the reused widget read-only only after the decision POST succeeds.
				return terminal ? answersFromResolution(terminal) ?? answers : answers;
			}
			: undefined;
		const answers = answersFromResolution(request);
		const unavailable = request.status !== "pending" && !answers;
		return html`
			<section class="decision-request space-y-2" data-decision-request-id=${request.id}>
				<div class="text-sm font-medium">${request.title}</div>
				<ask-user-choices-widget
					.questions=${[question]}
					.answers=${answers}
					.sessionId=${sessionId}
					.toolUseId=${""}
					.draftKey=${request.id}
					.submitAnswers=${submitAnswers}
					.errored=${unavailable}
					.errorText=${unavailable ? "This decision is no longer available." : ""}
				></ask-user-choices-widget>
			</section>
		`;
	}
}
