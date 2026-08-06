function x(e){return e instanceof Error?e.message:String(e||"Unable to load graph status.")}function f(e){if(Array.isArray(e))return e.filter(o=>!!o&&typeof o=="object");if(!e||typeof e!="object")return[];let n=e;if(n.component||n.state||n.freshness)return[n];let s=n.components??n.items??n.graphs;return Array.isArray(s)?f(s):[]}function g(e){return String(e?.state??e?.freshness??"UNAVAILABLE").replace(/-/g," ").toUpperCase()}function p(e){let s=(Array.isArray(e?.warnings)?e.warnings:[]).find(o=>typeof o=="string"&&o.trim());return typeof s=="string"?s:void 0}function v(e){return String(e?.component?.name??e?.component??"Component")}function $(e){let n=e?.revisions??{};return String(n.headRev??n.baseRev??e?.revision??"unknown").slice(0,12)}function h({html:e,nothing:n}){let s=new Map,o=a=>{try{a.requestRender?.()}catch{}};return{render(a,d){let u=typeof a?.__sessionId=="string"?a.__sessionId:"default",t=s.get(u)??{loaded:!1,loading:!1,rebuilding:!1};s.set(u,t);let c=async r=>{if(!d?.callRoute){t.error="Code Intelligence routes are unavailable.",o(d??{});return}try{r==="rebuild"?t.rebuilding=!0:t.loading=!0,t.error=void 0,o(d);let i=await d.callRoute(r,r==="rebuild"?{method:"POST",body:{scope:"eligible"}}:{method:"GET"});if(r==="status"&&(t.status=i),r==="config"&&(t.config=i),r==="rebuild"){let m=i&&typeof i=="object"?i:{};t.status=m.status??i}t.loaded=!0}catch(i){t.error=x(i)}finally{t.loading=!1,t.rebuilding=!1,o(d)}},l=f(t.status),b="v1 has no cross-repo edges.",y=l.length>0?g(l[0]):"STALE \u2014 no current graph is published.";return e`
				<section class="h-full overflow-auto p-4 space-y-4 text-sm" data-testid="code-intelligence-status-panel">
					<header class="flex items-start justify-between gap-3">
						<div>
							<h2 class="text-base font-semibold text-foreground">Code Intelligence</h2>
							<p class="text-muted-foreground">Host-side, component-scoped Graphify indexes.</p>
						</div>
						<div class="flex gap-2">
							<button class="rounded border border-border px-2 py-1 text-foreground hover:bg-muted disabled:opacity-50" data-testid=${t.loaded?"graph-status-refresh":"graph-status-load"} ?disabled=${t.loading} @click=${()=>{c("status")}}>${t.loading?"Loading\u2026":t.loaded?"Refresh":"Load status"}</button>
							<button class="rounded border border-border px-2 py-1 text-foreground hover:bg-muted disabled:opacity-50" data-testid="graph-status-config" ?disabled=${t.loading} @click=${()=>{c("config")}}>Configuration</button>
							<button class="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50" data-testid="code-intelligence-rebuild" ?disabled=${t.rebuilding} @click=${()=>{c("rebuild")}}>${t.rebuilding?"Queued\u2026":"Rebuild"}</button>
						</div>
					</header>
					<p class="rounded border border-border p-2 text-muted-foreground" data-testid="code-intelligence-no-cross-repo-warning">${b}</p>
					<p class="rounded border border-border p-2 font-medium text-foreground" data-testid="code-intelligence-freshness">${y}</p>
					<p class="text-muted-foreground" data-testid="code-intelligence-rebuild-status">${t.rebuilding?"Checking manual rebuild availability\u2026":"Automatic lifecycle processing is unavailable pending EP-8. Manual rebuild is route-only."}</p>
					${t.error?e`<p class="rounded border border-destructive p-2 text-destructive" role="alert">${t.error}</p>`:n}
					${t.loaded?n:e`<p class="text-muted-foreground">Load status to inspect freshness, lifecycle availability, and version drift.</p>`}
					${l.map(r=>e`
						<article class="rounded border border-border p-3 space-y-2" data-testid="graph-status-component">
							<div class="flex justify-between gap-3"><strong class="text-foreground">${v(r)}</strong><span class="font-mono text-xs text-muted-foreground">${$(r)}</span></div>
							<p class="font-medium text-foreground" data-testid="graph-status-state">${g(r)}</p>
							${p(r)?e`<p class="text-warning" data-testid="graph-status-component-warning">${p(r)}</p>`:n}
						</article>
					`)}
					${t.loaded&&l.length===0?e`<p class="text-muted-foreground">No eligible component graph is published yet.</p>`:n}
					${t.config?e`<pre class="overflow-auto rounded border border-border p-3 text-xs text-muted-foreground" data-testid="graph-status-config-value">${JSON.stringify(t.config,null,2)}</pre>`:n}
				</section>
			`}}}export{h as default};
