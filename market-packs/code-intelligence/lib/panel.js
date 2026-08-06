function h(e){return e instanceof Error?e.message:String(e||"Unable to load graph status.")}function f(e){if(Array.isArray(e))return e.filter(o=>!!o&&typeof o=="object");if(!e||typeof e!="object")return[];let n=e;if(n.component||n.state||n.freshness)return[n];let s=n.components??n.items??n.graphs;return Array.isArray(s)?f(s):[]}function g(e){return String(e?.state??e?.freshness??"UNAVAILABLE").replace(/-/g," ").toUpperCase()}function p(e){let s=(Array.isArray(e?.warnings)?e.warnings:[]).find(o=>typeof o=="string"&&o.trim());return typeof s=="string"?s:void 0}function x(e){return String(e?.component?.name??e?.component??"Component")}function v(e){let n=e?.revisions??{};return String(n.headRev??n.baseRev??e?.revision??"unknown").slice(0,12)}function $({html:e,nothing:n}){let s=new Map,o=a=>{try{a.requestRender?.()}catch{}};return{render(a,i){let c=typeof a?.__sessionId=="string"?a.__sessionId:"default",t=s.get(c)??{loaded:!1,loading:!1,rebuilding:!1};s.set(c,t);let l=async r=>{if(!i?.callRoute){t.error="Code Intelligence routes are unavailable.",o(i??{});return}try{r==="rebuild"?t.rebuilding=!0:t.loading=!0,t.error=void 0,o(i);let d=await i.callRoute(r,r==="rebuild"?{method:"POST",body:{scope:"eligible"}}:{method:"GET"});if(r==="status"&&(t.status=d),r==="config"&&(t.config=d),r==="rebuild"){let m=d&&typeof d=="object"?d:{};t.status=m.status??d}t.loaded=!0}catch(d){t.error=h(d)}finally{t.loading=!1,t.rebuilding=!1,o(i)}},u=f(t.status),b="v1 has no cross-repo edges.",y=u.length>0?g(u[0]):"STALE \u2014 no current graph is published.";return e`
				<section class="h-full overflow-auto p-4 space-y-4 text-sm" data-testid="code-intelligence-status-panel">
					<header class="flex items-start justify-between gap-3">
						<div>
							<h2 class="text-base font-semibold text-foreground">Code Intelligence</h2>
							<p class="text-muted-foreground">Host-side, component-scoped Graphify indexes.</p>
						</div>
						<div class="flex gap-2">
							<button class="rounded border border-border px-2 py-1 text-foreground hover:bg-muted disabled:opacity-50" data-testid=${t.loaded?"graph-status-refresh":"graph-status-load"} ?disabled=${t.loading} @click=${()=>{l("status")}}>${t.loading?"Loading\u2026":t.loaded?"Refresh":"Load status"}</button>
							<button class="rounded border border-border px-2 py-1 text-foreground hover:bg-muted disabled:opacity-50" data-testid="graph-status-config" ?disabled=${t.loading} @click=${()=>{l("config")}}>Configuration</button>
							<button class="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50" data-testid="code-intelligence-rebuild" ?disabled=${t.rebuilding} @click=${()=>{l("rebuild")}}>${t.rebuilding?"Queued\u2026":"Rebuild"}</button>
						</div>
					</header>
					<p class="rounded border border-border p-2 text-muted-foreground" data-testid="code-intelligence-no-cross-repo-warning">${b}</p>
					<p class="rounded border border-border p-2 font-medium text-foreground" data-testid="code-intelligence-freshness">${y}</p>
					<p class="text-muted-foreground" data-testid="code-intelligence-rebuild-status">${t.rebuilding?"Rebuild queued through the shared graph runtime.":"Manual rebuild uses the shared graph runtime queue."}</p>
					${t.error?e`<p class="rounded border border-destructive p-2 text-destructive" role="alert">${t.error}</p>`:n}
					${t.loaded?n:e`<p class="text-muted-foreground">Load status to inspect freshness, queue activity, and version drift.</p>`}
					${u.map(r=>e`
						<article class="rounded border border-border p-3 space-y-2" data-testid="graph-status-component">
							<div class="flex justify-between gap-3"><strong class="text-foreground">${x(r)}</strong><span class="font-mono text-xs text-muted-foreground">${v(r)}</span></div>
							<p class="font-medium text-foreground" data-testid="graph-status-state">${g(r)}</p>
							${p(r)?e`<p class="text-warning" data-testid="graph-status-component-warning">${p(r)}</p>`:n}
						</article>
					`)}
					${t.loaded&&u.length===0?e`<p class="text-muted-foreground">No eligible component graph is published yet.</p>`:n}
					${t.config?e`<pre class="overflow-auto rounded border border-border p-3 text-xs text-muted-foreground" data-testid="graph-status-config-value">${JSON.stringify(t.config,null,2)}</pre>`:n}
				</section>
			`}}}export{$ as default};
