import { html, type TemplateResult } from "lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import {
	acceptProjectImportProposal,
	rejectProjectImportProposal,
	type ProjectImportProposalProjection,
} from "../../../app/project-import-decisions.js";

type ProposalAction = "accept" | "reject";

type ProposalState = {
	pending?: ProposalAction;
	error?: string;
};

const MAX_PROPOSAL_STATES = 20;
const MAX_ERROR_LENGTH = 280;

/**
 * Project-owned proposal review card. It uses the normal parsed/revisioned
 * projection and retains feedback across Lit re-renders for its dialog only.
 */
export class ProjectImportProposalRenderer {
	private readonly states = new Map<string, ProposalState>();

	constructor(private readonly requestRender: () => void) {}

	/** Drop terminal/stale state as the bounded server projection changes. */
	reconcile(proposals: readonly ProjectImportProposalProjection[]): void {
		const visible = new Set(proposals.map(proposal => this.key(proposal)));
		for (const key of this.states.keys()) if (!visible.has(key)) this.states.delete(key);
	}

	clear(): void {
		this.states.clear();
	}

	render(proposal: ProjectImportProposalProjection): TemplateResult {
		const key = this.key(proposal);
		const state = this.states.get(key);
		const pending = proposal.status === "applying" || state?.pending !== undefined;
		const action = state?.pending;
		const error = state?.error ?? "";
		const decide = async (decision: ProposalAction) => {
			// State is set synchronously, so two click events cannot submit twice
			// before Lit has rendered the disabled controls.
			if (this.states.get(key)?.pending || proposal.status === "applying") return;
			this.setState(key, { pending: decision });
			try {
				if (decision === "accept") await acceptProjectImportProposal(proposal);
				else await rejectProjectImportProposal(proposal);
				// The authoritative refresh in the action removes a settled proposal.
				this.states.delete(key);
			} catch (err) {
				this.setState(key, { error: this.errorMessage(err) });
				return;
			}
			this.requestRender();
		};
		return html`
			<section class="rounded-md border border-border p-3 space-y-3" data-testid="project-import-proposal" data-project-import-proposal-id=${proposal.requestId}>
				<div class="flex items-center justify-between gap-3">
					<div class="text-sm font-medium">${proposal.proposalType[0].toUpperCase()}${proposal.proposalType.slice(1)} proposal</div>
					<span class="text-xs text-muted-foreground">${proposal.status === "applying" || pending ? "Applying (locked)" : `Revision ${proposal.rev}`}</span>
				</div>
				<pre class="max-h-56 overflow-auto rounded bg-secondary/40 p-2 text-xs whitespace-pre-wrap" data-testid="project-import-proposal-fields">${JSON.stringify(proposal.fields, null, 2)}</pre>
				${error ? html`<p class="text-sm text-destructive" role="alert" data-testid="project-import-proposal-error">${error}</p>` : ""}
				<div class="flex justify-end gap-2">
					<span data-testid="project-import-proposal-reject">${Button({ variant: "ghost", disabled: pending, onClick: () => void decide("reject"), children: action === "reject" ? "Rejecting…" : "Reject" })}</span>
					<span data-testid="project-import-proposal-accept">${Button({ variant: "default", disabled: pending, onClick: () => void decide("accept"), children: action === "accept" || proposal.status === "applying" ? "Applying…" : "Apply proposal" })}</span>
				</div>
			</section>
		`;
	}

	private key(proposal: ProjectImportProposalProjection): string {
		return `${proposal.projectId}:${proposal.requestId}`;
	}

	private setState(key: string, state: ProposalState): void {
		this.states.set(key, state);
		while (this.states.size > MAX_PROPOSAL_STATES) this.states.delete(this.states.keys().next().value!);
		this.requestRender();
	}

	private errorMessage(error: unknown): string {
		const message = error instanceof Error && error.message ? error.message : "Could not update proposal";
		return message.slice(0, MAX_ERROR_LENGTH);
	}
}
