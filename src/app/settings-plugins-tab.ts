/**
 * Settings → Plugins tab.
 *
 * Two modes:
 *   - System scope: list every discovered plugin (builtin, server, user) with
 *     load status and a Trust / Revoke button per non-builtin row.
 *   - Project scope: same listing, plus per-row Install / Uninstall against
 *     the active project. Installation copies the plugin's contributed
 *     workflows into project.yaml::plugin_workflows as frozen snapshots.
 *
 * Rendered live: we re-fetch the discovery list on every render and again
 * after any mutating action. Polling is not needed — the gateway list is the
 * source of truth and changes are infrequent.
 */
import { html, render } from "lit";
import { gatewayFetch } from "./api.js";

interface PluginContrib {
	workflows?: string[];
	roles?: string[];
	skills?: string[];
	tools_dirs?: string[];
	mcp?: string[];
}

interface PluginRecord {
	name: string;
	version: string;
	description?: string;
	source: "builtin" | "server" | "user" | "project";
	path: string;
	contributes: PluginContrib | null;
	entryPoints: { gateway?: string; ui?: string } | null;
	verifyStepTypes: string[];
	permissions: string[];
	manifestErrors: { field: string; message: string }[];
	load: { status: string; registeredTypes?: string[]; error?: string; errors?: unknown[] };
}

interface ProjectInstallRecord {
	name: string;
	version: string;
	installedAt: number;
	workflows: { id: string; namespacedId: string }[];
}

const containerKey = "__bobbit_plugin_tab_container";

async function fetchPlugins(): Promise<PluginRecord[]> {
	const resp = await gatewayFetch("/api/plugins");
	if (!resp.ok) return [];
	const body = await resp.json() as { plugins?: PluginRecord[] };
	return body.plugins ?? [];
}

async function fetchProjectInstalls(projectId: string): Promise<ProjectInstallRecord[]> {
	const resp = await gatewayFetch(`/api/projects/${encodeURIComponent(projectId)}/plugins`);
	if (!resp.ok) return [];
	const body = await resp.json() as { plugins?: ProjectInstallRecord[] };
	return body.plugins ?? [];
}

async function trust(name: string): Promise<void> {
	await gatewayFetch(`/api/plugins/${encodeURIComponent(name)}/trust`, { method: "POST" });
}

async function revoke(name: string): Promise<void> {
	await gatewayFetch(`/api/plugins/${encodeURIComponent(name)}/trust`, { method: "DELETE" });
}

async function install(projectId: string, name: string): Promise<{ ok: boolean; error?: string }> {
	const resp = await gatewayFetch(`/api/projects/${encodeURIComponent(projectId)}/plugins/${encodeURIComponent(name)}/install`, { method: "POST" });
	if (!resp.ok) {
		const body = await resp.json().catch(() => ({})) as { error?: string };
		return { ok: false, error: body.error };
	}
	return { ok: true };
}

async function uninstall(projectId: string, name: string): Promise<void> {
	await gatewayFetch(`/api/projects/${encodeURIComponent(projectId)}/plugins/${encodeURIComponent(name)}`, { method: "DELETE" });
}

function statusBadge(load: PluginRecord["load"]) {
	const colour = load.status === "loaded" ? "bg-green-500/15 text-green-600"
		: load.status === "needs-approval" ? "bg-amber-500/15 text-amber-600"
		: load.status === "manifest-invalid" || load.status === "error" ? "bg-red-500/15 text-red-600"
		: "bg-secondary text-muted-foreground";
	return html`<span class="text-xs px-2 py-0.5 rounded ${colour}">${load.status}</span>`;
}

function sourceBadge(source: PluginRecord["source"]) {
	const colour = source === "builtin" ? "bg-blue-500/15 text-blue-600"
		: source === "user" ? "bg-purple-500/15 text-purple-600"
		: source === "project" ? "bg-orange-500/15 text-orange-600"
		: "bg-secondary text-muted-foreground";
	return html`<span class="text-xs px-2 py-0.5 rounded ${colour}">${source}</span>`;
}

function pluginRow(opts: {
	p: PluginRecord;
	scope: "system" | "project";
	projectId?: string;
	installed: boolean;
	onMutate(): void;
}) {
	const { p, scope, projectId, installed, onMutate } = opts;
	const contrib = p.contributes ?? {};
	const contribLines = [
		(contrib.workflows && contrib.workflows.length > 0) ? `${contrib.workflows.length} workflow${contrib.workflows.length === 1 ? "" : "s"}` : "",
		(contrib.roles && contrib.roles.length > 0) ? `${contrib.roles.length} role${contrib.roles.length === 1 ? "" : "s"}` : "",
		(contrib.skills && contrib.skills.length > 0) ? `${contrib.skills.length} skill${contrib.skills.length === 1 ? "" : "s"}` : "",
		(contrib.tools_dirs && contrib.tools_dirs.length > 0) ? `${contrib.tools_dirs.length} tool dir${contrib.tools_dirs.length === 1 ? "" : "s"}` : "",
		(contrib.mcp && contrib.mcp.length > 0) ? `${contrib.mcp.length} MCP server${contrib.mcp.length === 1 ? "" : "s"}` : "",
		(p.verifyStepTypes.length > 0) ? `verify types: ${p.verifyStepTypes.join(", ")}` : "",
	].filter(Boolean).join(" · ");
	const isTrustable = p.source !== "builtin";
	const trusted = p.load.status === "loaded" || p.load.registeredTypes !== undefined;

	const handleTrust = async () => {
		await trust(p.name);
		onMutate();
	};
	const handleRevoke = async () => {
		await revoke(p.name);
		onMutate();
	};
	const handleInstall = async () => {
		if (!projectId) return;
		const result = await install(projectId, p.name);
		if (!result.ok) alert(`Install failed: ${result.error}`);
		onMutate();
	};
	const handleUninstall = async () => {
		if (!projectId) return;
		await uninstall(projectId, p.name);
		onMutate();
	};

	return html`
		<div class="border border-border rounded-md p-3 mb-2">
			<div class="flex items-start justify-between gap-3">
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2 flex-wrap">
						<span class="font-medium">${p.name}</span>
						<span class="text-xs text-muted-foreground">v${p.version}</span>
						${sourceBadge(p.source)}
						${statusBadge(p.load)}
						${installed ? html`<span class="text-xs px-2 py-0.5 rounded bg-green-500/15 text-green-600">installed</span>` : ""}
					</div>
					${p.description ? html`<div class="text-sm text-muted-foreground mt-1">${p.description}</div>` : ""}
					${contribLines ? html`<div class="text-xs text-muted-foreground mt-1">${contribLines}</div>` : ""}
					${p.manifestErrors.length > 0 ? html`
						<div class="mt-2 text-xs text-red-600">
							Manifest errors:
							<ul class="list-disc list-inside">
								${p.manifestErrors.map(e => html`<li>${e.field}: ${e.message}</li>`)}
							</ul>
						</div>
					` : ""}
					${p.load.status === "error" ? html`<div class="mt-2 text-xs text-red-600">Load error: ${p.load.error}</div>` : ""}
				</div>
				<div class="flex flex-col gap-1 items-end shrink-0">
					${isTrustable ? html`
						${trusted
							? html`<button class="text-xs px-2 py-1 rounded border border-border hover:bg-secondary" @click=${handleRevoke}>Revoke trust</button>`
							: html`<button class="text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:opacity-90" @click=${handleTrust}>Trust</button>`}
					` : html`<span class="text-xs text-muted-foreground">auto-trusted</span>`}
					${scope === "project" && projectId ? html`
						${installed
							? html`<button class="text-xs px-2 py-1 rounded border border-border hover:bg-secondary" @click=${handleUninstall}>Uninstall</button>`
							: html`<button class="text-xs px-2 py-1 rounded border border-border hover:bg-secondary" @click=${handleInstall} ?disabled=${p.load.status !== "loaded" && p.load.status !== "needs-approval"}>Install</button>`}
					` : ""}
				</div>
			</div>
		</div>
	`;
}

/** Render the system-scope Plugins tab body. */
export function renderSystemPluginsTab() {
	const container = document.createElement("div");
	(container as any)[containerKey] = true;

	const refresh = async () => {
		const plugins = await fetchPlugins();
		const view = plugins.length === 0
			? html`<div class="text-sm text-muted-foreground">No plugins discovered. Drop a folder containing <code>plugin.yaml</code> into <code>~/.bobbit/plugins/</code> or <code>./.bobbit/plugins/</code> and refresh.</div>`
			: html`
				<div class="text-sm text-muted-foreground mb-3">
					Plugins extend bobbit with workflow templates, roles, skills, tools, and new verify-step types.
					Untrusted plugins are discovered but their code is not run until you click Trust.
				</div>
				${plugins.map(p => pluginRow({ p, scope: "system", installed: false, onMutate: refresh }))}
			`;
		render(view, container);
	};
	refresh();
	return html`${container}`;
}

/** Render the project-scope Plugins tab body. */
export function renderProjectPluginsTab(projectId: string) {
	const container = document.createElement("div");
	(container as any)[containerKey] = true;

	const refresh = async () => {
		const [plugins, installs] = await Promise.all([fetchPlugins(), fetchProjectInstalls(projectId)]);
		const installedNames = new Set(installs.map(i => i.name));
		const view = plugins.length === 0
			? html`<div class="text-sm text-muted-foreground">No plugins discovered yet. Drop one into <code>~/.bobbit/plugins/</code> or <code>${"./.bobbit/plugins/"}</code> and refresh.</div>`
			: html`
				<div class="text-sm text-muted-foreground mb-3">
					Installing a plugin into this project copies its workflow templates as frozen snapshots under <code>plugin_workflows:</code> in <code>project.yaml</code>. Plugin-registered verify-step types are global, not per-project.
				</div>
				${plugins.map(p => pluginRow({
					p, scope: "project", projectId,
					installed: installedNames.has(p.name),
					onMutate: refresh,
				}))}
				${installs.length > 0 ? html`
					<div class="mt-4 pt-4 border-t border-border">
						<div class="text-sm font-medium mb-2">Installed in this project</div>
						${installs.map(i => html`
							<div class="text-xs text-muted-foreground mb-1">
								<span class="font-mono">${i.name}@${i.version}</span>
								${i.workflows.length > 0
									? html` — workflows: ${i.workflows.map(w => html`<code class="mx-1">${w.namespacedId}</code>`)}`
									: ""}
							</div>
						`)}
					</div>
				` : ""}
			`;
		render(view, container);
	};
	refresh();
	return html`${container}`;
}
