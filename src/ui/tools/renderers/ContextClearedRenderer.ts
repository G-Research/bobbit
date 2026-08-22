import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html } from "lit";
import { Eraser } from "lucide";
import { renderHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

interface ContextClearedPayload {
	schemaVersion: 1;
	clearId: string;
	clearedAt: string;
}

/** Renderer for the outward-only `__context_cleared` transcript boundary. */
export class ContextClearedRenderer implements ToolRenderer<ContextClearedPayload, ContextClearedPayload> {
	render(
		params: ContextClearedPayload | undefined,
		result: ToolResultMessage<ContextClearedPayload> | undefined,
	): ToolRenderResult {
		const payload = (result?.details as ContextClearedPayload | undefined) ?? params;
		const clearId = payload?.schemaVersion === 1 && typeof payload.clearId === "string"
			? payload.clearId
			: "";

		return {
			content: html`
				<div
					data-testid="context-clear-card"
					data-boundary-id=${clearId}
					class="rounded-md border border-border bg-card p-3"
				>
					${renderHeader(
						"complete",
						Eraser,
						html`<span class="font-medium text-foreground">Context Cleared</span>`,
					)}
				</div>
			`,
			// The boundary supplies its own standard card so no generic tool wrapper
			// can obscure the stable card root/test identity.
			isCustom: true,
		};
	}
}
