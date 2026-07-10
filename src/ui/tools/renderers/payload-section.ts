import { html } from "lit";

let payloadSectionId = 0;

/** Render a collapsed JSON/text payload block shared by the generic fallback renderers. */
export function renderPayloadSection(label: string, code: string, language: string) {
	const payloadType = language === "json" ? "JSON" : "text";
	const payloadId = `default-payload-${++payloadSectionId}`;
	const onToggle = (event: Event) => {
		const button = event.currentTarget as HTMLButtonElement;
		const section = button.closest("[data-default-payload-section]");
		const expanded = button.getAttribute("aria-expanded") === "true";
		const nextExpanded = !expanded;
		button.setAttribute("aria-expanded", String(nextExpanded));
		section?.querySelector<HTMLElement>(`[data-payload-region="${payloadId}"]`)?.toggleAttribute("hidden", !nextExpanded);
		section?.querySelector('[data-state="collapsed"]')?.toggleAttribute("hidden", nextExpanded);
		section?.querySelector('[data-state="expanded"]')?.toggleAttribute("hidden", !nextExpanded);
	};

	return html`
		<div class="rounded-md border border-border bg-muted/20 p-2" data-default-payload-section>
			<button
				type="button"
				class="cursor-pointer select-none rounded-sm text-left text-xs font-medium text-muted-foreground focus-visible:outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
				aria-expanded="false"
				aria-controls=${payloadId}
				@click=${onToggle}
			>
				${label} ${payloadType} payload
				<span class="font-normal opacity-80" data-state="collapsed">(collapsed; <span class="text-primary underline underline-offset-2 decoration-dotted">Expand</span> to inspect)</span>
				<span class="font-normal opacity-80" data-state="expanded" hidden>(<span class="text-primary underline underline-offset-2 decoration-dotted">Collapse</span>)</span>
			</button>
			<div id=${payloadId} data-payload-region=${payloadId} class="mt-2" hidden>
				<code-block .code=${code} language=${language}></code-block>
			</div>
		</div>
	`;
}
