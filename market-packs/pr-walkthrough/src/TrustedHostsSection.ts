// Pack CLIENT settings-section module — "Trusted GitHub hosts"
// (docs/design/pack-settings-contribution.md §4.5 migration). Moved out of
// core `settings-page.ts` (was a pr-walkthrough feature living in core UI,
// justified only by a build-pipeline workaround — see the design doc §1). Now
// that this widget is no longer part of the Settings chunk, it imports the
// SHARED normalizer directly instead of hand-duplicating it (the acceptance
// criterion for this migration) — `panel.js` in this same pack already
// imports a sibling shared module the identical way, proving the import graph
// from this pack's `src/` is clean.
//
// ALL preference reads/writes go through the narrow `SettingsHostApi` —
// `host.preferences.get/set("githubTrustedHosts")` — never a raw fetch. The
// server re-checks this section's declared `preferenceKeys` allowlist (and the
// non-negotiable Claude-Code/agent-dir blocklist) on every write regardless of
// anything this module claims; see settings/trusted-hosts.yaml +
// src/server/extension-host/settings-section-preferences.ts.

import { normalizeTrustedHost } from "../../../src/shared/pr-walkthrough/url-safety.ts";
import type { SettingsHostApi } from "../../../src/shared/extension-host/host-api.ts";

type Toolkit = { html: typeof import("lit").html; nothing: typeof import("lit").nothing };

// Module-level UI-local state (the in-progress input text) — NOT a preference,
// so it lives here rather than round-tripping through `host.preferences`. A
// settings section is a page-lived singleton (like a pack panel instance), so
// this is safe across repaints; `host.requestRender()` is how a local-state
// change becomes visible (mirrors `HostApi.requestRender()`'s contract).
let hostInput = "";

function currentHosts(host: SettingsHostApi): string[] {
	const raw = host.preferences.get("githubTrustedHosts");
	return Array.isArray(raw) ? raw.filter((h): h is string => typeof h === "string") : [];
}

async function addTrustedHost(host: SettingsHostApi): Promise<void> {
	const normalized = normalizeTrustedHost(hostInput);
	const hosts = currentHosts(host);
	if (!normalized || hosts.includes(normalized)) {
		// Invalid or duplicate — clear the input and re-render without persisting,
		// mirroring the pre-migration behavior exactly.
		hostInput = "";
		host.requestRender();
		return;
	}
	hostInput = "";
	host.requestRender();
	await host.preferences.set("githubTrustedHosts", [...hosts, normalized]);
}

async function removeTrustedHost(host: SettingsHostApi, target: string): Promise<void> {
	await host.preferences.set("githubTrustedHosts", currentHosts(host).filter((h) => h !== target));
}

export default function createTrustedHostsSection({ html }: Toolkit) {
	return {
		render(host: SettingsHostApi) {
			const hosts = currentHosts(host);
			return html`
				<div class="flex flex-col gap-1.5">
					<span class="text-sm font-medium text-foreground">Trusted GitHub hosts</span>
					<p class="text-xs text-muted-foreground">
						PR walkthroughs fetch repository and pull-request data (metadata and diffs) from these hosts.
						github.com and its API/raw hosts are always trusted. Only add hosts you trust.
					</p>
					<div class="flex flex-col gap-1.5" data-testid="github-trusted-hosts-list">
						${hosts.length === 0
							? html`<p class="text-xs text-muted-foreground italic">No additional hosts trusted.</p>`
							: hosts.map((h) => html`
								<div class="flex items-center gap-2" data-testid="github-trusted-host-row" data-host=${h}>
									<code class="text-sm text-foreground flex-1 truncate">${h}</code>
									<button
										class="text-xs text-muted-foreground hover:text-destructive underline"
										data-testid="github-trusted-host-remove"
										@click=${() => void removeTrustedHost(host, h)}
									>Remove</button>
								</div>
							`)}
					</div>
					<div class="flex items-center gap-2">
						<input
							type="text"
							placeholder="ghe.example.com"
							data-testid="github-trusted-host-input"
							class="flex-1 px-2 py-1 rounded border border-input bg-background text-sm"
							.value=${hostInput}
							@input=${(e: Event) => { hostInput = (e.target as HTMLInputElement).value; host.requestRender(); }}
							@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); void addTrustedHost(host); } }}
						/>
						<button
							class="px-3 py-1.5 rounded border border-input text-sm hover:bg-secondary"
							data-testid="github-trusted-host-add"
							@click=${() => void addTrustedHost(host)}
						>Add</button>
					</div>
				</div>
			`;
		},
	};
}
