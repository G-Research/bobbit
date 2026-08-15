import { html, type TemplateResult } from "lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import {
	acceptProjectImportProposal,
	rejectProjectImportProposal,
	type ProjectImportProposalProjection,
} from "../../../app/project-import-decisions.js";

/**
 * Project-owned proposal review card. It intentionally consumes the same
 * parsed/revisioned proposal projection used by the normal proposal workspace;
 * it has no session id or raw extension payload.
 */
export class ProjectImportProposalRenderer {
	render(proposal: ProjectImportProposalProjection): TemplateResult {
		let pending = false;
		let error = "";
		const decide = async (decision: "accept" | "reject") => {
			if (pending) return;
			pending = true;
			error = "";
			try {
				if (decision === "accept") await acceptProjectImportProposal(proposal);
				else await rejectProjectImportProposal(proposal);
			} catch (err) {
				error = err instanceof Error ? err.message : "Could not update proposal";
			} finally {
				pending = false;
				// The durable projection refresh will replace this card on success.
				document.dispatchEvent(new Event("bobbit-project-import-proposal-updated"));
			}
		};
		return html`
			<section class="rounded-md border border-border p-3 space-y-3" data-testid="project-import-proposal" data-project-import-proposal-id=${proposal.requestId}>
				<div class="flex items-center justify-between gap-3">
					<div class="text-sm font-medium">${proposal.proposalType[0].toUpperCase()}${proposal.proposalType.slice(1)} proposal</div>
					<span class="text-xs text-muted-foreground">Revision ${proposal.rev}</span>
				</div>
				<pre class="max-h-56 overflow-auto rounded bg-secondary/40 p-2 text-xs whitespace-pre-wrap" data-testid="project-import-proposal-fields">${JSON.stringify(proposal.fields, null, 2)}</pre>
				${error ? html`<p class="text-sm text-destructive" role="alert">${error}</p>` : ""}
				<div class="flex justify-end gap-2">
					${Button({ variant: "ghost", disabled: pending, onClick: () => void decide("reject"), children: "Reject" })}
					${Button({ variant: "default", disabled: pending || proposal.proposalType !== "role", onClick: () => void decide("accept"), children: pending ? "Applying…" : "Apply proposal" })}
				</div>
			</section>
		`;
	}
}
