function v(e){return e instanceof Error?e.message:String(e||"Unable to load graph status.")}function y(e){if(Array.isArray(e))return e.filter(r=>!!r&&typeof r=="object");if(!e||typeof e!="object")return[];let n=e;for(let r of[n.components,n.items,n.graphs])if(Array.isArray(r))return y(r);return n.component?[n]:[]}function p(e){return String(e?.state??e?.freshness??"UNAVAILABLE").replace(/-/g," ").toUpperCase()}function f(e){let r=(Array.isArray(e?.warnings)?e.warnings:[]).find(a=>typeof a=="string"&&a.trim());return typeof r=="string"?r:void 0}function $(e){let n=e?.component,r=String(n?.name??n??"Component"),a=typeof n?.repo=="string"&&n.repo.trim()?n.repo:void 0;return a?`${r} \xB7 ${a}`:r}function h(e){let n=e?.revisions??{};return String(n.headRev??n.baseRev??e?.revision??"unknown").slice(0,12)}function b(e){return typeof e?.staleReason=="string"&&e.staleReason.trim()?e.staleReason.replace(/-/g," "):void 0}function w({html:e,nothing:n}){let r=new Map,a=l=>{try{l.requestRender?.()}catch{}};return{render(l,i){let g=typeof l?.__sessionId=="string"?l.__sessionId:"default",t=r.get(g)??{loaded:!1,loading:!1,rebuilding:!1};r.set(g,t);let u=async o=>{if(!i?.callRoute){t.error="Code Intelligence routes are unavailable.",a(i??{});return}try{o==="rebuild"?t.rebuilding=!0:t.loading=!0,t.error=void 0,a(i);let s=await i.callRoute(o,o==="rebuild"?{method:"POST",body:{scope:"eligible"}}:{method:"GET"});if(s&&typeof s=="object"&&s.ok===!1){let d=s.error;throw new Error(typeof d=="string"&&d?d:"Code Intelligence route request failed.")}if(o==="status"&&(t.status=s),o==="config"&&(t.config=s),o==="rebuild"){let d=s&&typeof s=="object"?s:{};t.status=d.status??s}t.loaded=!0}catch(s){t.error=v(s)}finally{t.loading=!1,t.rebuilding=!1,a(i)}},c=y(t.status),m="v1 has no cross-repo edges.",x=c.length>0?p(c[0]):"STALE \u2014 no current graph is published.";return e`
				<section class="h-full overflow-auto p-4 space-y-4 text-sm" data-testid="code-intelligence-status-panel">
					<header class="flex items-start justify-between gap-3">
						<div>
							<h2 class="text-base font-semibold text-foreground">Code Intelligence</h2>
							<p class="text-muted-foreground">Host-side, component-scoped Graphify indexes.</p>
						</div>
						<div class="flex gap-2">
							<button class="rounded border border-border px-2 py-1 text-foreground hover:bg-muted disabled:opacity-50" data-testid=${t.loaded?"graph-status-refresh":"graph-status-load"} ?disabled=${t.loading} @click=${()=>{u("status")}}>${t.loading?"Loading\u2026":t.loaded?"Refresh":"Load status"}</button>
							<button class="rounded border border-border px-2 py-1 text-foreground hover:bg-muted disabled:opacity-50" data-testid="graph-status-config" ?disabled=${t.loading} @click=${()=>{u("config")}}>Configuration</button>
							<button class="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50" data-testid="code-intelligence-rebuild" ?disabled=${t.rebuilding} @click=${()=>{u("rebuild")}}>${t.rebuilding?"Checking\u2026":"Rebuild"}</button>
						</div>
					</header>
					<p class="rounded border border-border p-2 text-muted-foreground" data-testid="code-intelligence-no-cross-repo-warning">${m}</p>
					<p class="rounded border border-border p-2 font-medium text-foreground" data-testid="code-intelligence-freshness">${x}</p>
					<p class="text-muted-foreground" data-testid="code-intelligence-rebuild-status">${t.rebuilding?"Checking manual rebuild availability\u2026":"Automatic lifecycle processing is unavailable pending EP-8. Manual rebuild is route-only."}</p>
					${t.error?e`<p class="rounded border border-destructive p-2 text-destructive" role="alert">${t.error}</p>`:n}
					${t.loaded?n:e`<p class="text-muted-foreground">Load status to inspect freshness, lifecycle availability, and version drift.</p>`}
					${c.map(o=>e`
						<article class="rounded border border-border p-3 space-y-2" data-testid="graph-status-component">
							<strong class="text-foreground" data-testid="graph-status-component-label">${$(o)}</strong>
							<p class="font-mono text-xs text-muted-foreground" data-testid="graph-status-component-revision">Revision: ${h(o)}</p>
							<p class="font-medium text-foreground" data-testid="graph-status-state">${p(o)}</p>
							${b(o)?e`<p class="text-muted-foreground" data-testid="graph-status-stale-reason">Stale reason: ${b(o)}</p>`:n}
							${f(o)?e`<p class="text-warning" data-testid="graph-status-component-warning">${f(o)}</p>`:n}
						</article>
					`)}
					${t.loaded&&c.length===0?e`<p class="text-muted-foreground" data-testid="graph-status-empty">No component graph status is available yet.</p>`:n}
					${t.config?e`<pre class="overflow-auto rounded border border-border p-3 text-xs text-muted-foreground" data-testid="graph-status-config-value">${JSON.stringify(t.config,null,2)}</pre>`:n}
				</section>
			`}}}export{w as default};
