import { html, type TemplateResult } from "lit";
import { ensureAskUserChoicesWidget } from "../../../app/lazy-widgets.js";
import {
	answerProjectImportDecisionRequest,
	type ProjectImportDecisionRequestProjection,
} from "../../../app/project-import-decisions.js";
import {
	answersFromAuthoritativeSettlement,
	answersFromResolution,
	decisionValueFromAnswer,
	submissionFailureMessage,
	unavailableMessage,
	statusLabel,
} from "./DecisionRequestRenderer.js";
import type { AskQuestion, SubmitAnswers } from "../../components/AskUserChoicesWidget.js";

/**
 * Project-owned adapter for the shared choice widget. It deliberately has no
 * session id, tool use id, transcript lookup, or agent transport.
 */
export class ProjectImportDecisionRenderer {
	render(request: ProjectImportDecisionRequestProjection): TemplateResult {
		void ensureAskUserChoicesWidget();
		const question: AskQuestion = {
			question: request.question,
			options: request.options.map((option) => option.label),
		};
		const actionable = request.status === "pending" || request.status === "paused-awaiting-consent";
		const submitAnswers: SubmitAnswers | undefined = actionable
			? async (answers) => {
				const terminal = await answerProjectImportDecisionRequest(
					request.projectId,
					request.id,
					decisionValueFromAnswer(request, answers),
				);
				const settledAnswers = answersFromAuthoritativeSettlement(terminal);
				if (settledAnswers) return settledAnswers;
				throw new Error(submissionFailureMessage(terminal));
			}
			: undefined;
		const answers = answersFromResolution(request);
		const unavailable = !actionable && !answers;
		const label = statusLabel(request);
		return html`
			<section class="project-import-decision-request space-y-2" data-project-import-decision-request-id=${request.id} tabindex="-1">
				<div class="flex items-center gap-2">
					<div class="text-sm font-medium">${request.title}</div>
					${request.decisionClass === "consent-required"
						? html`<span class="decision-class-label text-xs" data-testid="project-import-decision-consent-required">Consent required</span>`
						: ""}
					${label
						? html`<span class="decision-status-label text-xs" data-testid="project-import-decision-status-${request.status}">${label}</span>`
						: ""}
				</div>
				<ask-user-choices-widget
					.questions=${[question]}
					.answers=${answers}
					.draftKey=${request.id}
					.submitAnswers=${submitAnswers}
					.errored=${unavailable}
					.errorText=${unavailable ? unavailableMessage(request) : ""}
				></ask-user-choices-widget>
			</section>
		`;
	}
}
