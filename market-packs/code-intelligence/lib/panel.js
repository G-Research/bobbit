function v(e){return e instanceof Error?e.message:String(e||"Unable to load graph status.")}function b(e){if(Array.isArray(e))return e.filter(r=>!!r&&typeof r=="object");if(!e||typeof e!="object")return[];let n=e;for(let r of[n.components,n.items,n.graphs])if(Array.isArray(r))return b(r);return n.component?[n]:[]}function g(e){return String(e?.state??e?.freshness??"UNAVAILABLE").replace(/-/g," ").toUpperCase()}function p(e){let r=(Array.isArray(e?.warnings)?e.warnings:[]).find(s=>typeof s=="string"&&s.trim());return typeof r=="string"?r:void 0}function $(e){let n=e?.component,r=String(n?.name??n??"Component"),s=typeof n?.repo=="string"&&n.repo.trim()?n.repo:void 0;return s?`${r} \xB7 ${s}`:r}function h(e){let n=e?.revisions??{};return String(n.headRev??n.baseRev??e?.revision??"unknown").slice(0,12)}function f(e){return typeof e?.staleReason=="string"&&e.staleReason.trim()?e.staleReason.replace(/-/g," "):void 0}function w({html:e,nothing:n}){let r=new Map,s=d=>{try{d.requestRender?.()}catch{}};return{render(d,i){let u=typeof d?.__sessionId=="string"?d.__sessionId:"default",t=r.get(u)??{loaded:!1,loading:!1,rebuilding:!1};r.set(u,t);let c=async o=>{if(!i?.callRoute){t.error="Code Intelligence routes are unavailable.",s(i??{});return}try{o==="rebuild"?t.rebuilding=!0:t.loading=!0,t.error=void 0,s(i);let a=await i.callRoute(o,o==="rebuild"?{method:"POST",body:{scope:"eligible"}}:{method:"GET"});if(o==="status"&&(t.status=a),o==="config"&&(t.config=a),o==="rebuild"){let x=a&&typeof a=="object"?a:{};t.status=x.status??a}t.loaded=!0}catch(a){t.error=v(a)}finally{t.loading=!1,t.rebuilding=!1,s(i)}},l=b(t.status),y="v1 has no cross-repo edges.",m=l.length>0?g(l[0]):"STALE \u2014 no current graph is published.";return e`
				<section class="h-full overflow-auto p-4 space-y-4 text-sm" data-testid="code-intelligence-status-panel">
					<header class="flex items-start justify-between gap-3">
						<div>
							<h2 class="text-base font-semibold text-foreground">Code Intelligence</h2>
							<p class="text-muted-foreground">Host-side, component-scoped Graphify indexes.</p>
						</div>
						<div class="flex gap-2">
							<button class="rounded border border-border px-2 py-1 text-foreground hover:bg-muted disabled:opacity-50" data-testid=${t.loaded?"graph-status-refresh":"graph-status-load"} ?disabled=${t.loading} @click=${()=>{c("status")}}>${t.loading?"Loading\u2026":t.loaded?"Refresh":"Load status"}</button>
							<button class="rounded border border-border px-2 py-1 text-foreground hover:bg-muted disabled:opacity-50" data-testid="graph-status-config" ?disabled=${t.loading} @click=${()=>{c("config")}}>Configuration</button>
							<button class="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50" data-testid="code-intelligence-rebuild" ?disabled=${t.rebuilding} @click=${()=>{c("rebuild")}}>${t.rebuilding?"Checking\u2026":"Rebuild"}</button>
						</div>
					</header>
					<p class="rounded border border-border p-2 text-muted-foreground" data-testid="code-intelligence-no-cross-repo-warning">${y}</p>
					<p class="rounded border border-border p-2 font-medium text-foreground" data-testid="code-intelligence-freshness">${m}</p>
					<p class="text-muted-foreground" data-testid="code-intelligence-rebuild-status">${t.rebuilding?"Checking manual rebuild availability\u2026":"Automatic lifecycle processing is unavailable pending EP-8. Manual rebuild is route-only."}</p>
					${t.error?e`<p class="rounded border border-destructive p-2 text-destructive" role="alert">${t.error}</p>`:n}
					${t.loaded?n:e`<p class="text-muted-foreground">Load status to inspect freshness, lifecycle availability, and version drift.</p>`}
					${l.map(o=>e`
						<article class="rounded border border-border p-3 space-y-2" data-testid="graph-status-component">
							<strong class="text-foreground" data-testid="graph-status-component-label">${$(o)}</strong>
							<p class="font-mono text-xs text-muted-foreground" data-testid="graph-status-component-revision">Revision: ${h(o)}</p>
							<p class="font-medium text-foreground" data-testid="graph-status-state">${g(o)}</p>
							${f(o)?e`<p class="text-muted-foreground" data-testid="graph-status-stale-reason">Stale reason: ${f(o)}</p>`:n}
							${p(o)?e`<p class="text-warning" data-testid="graph-status-component-warning">${p(o)}</p>`:n}
						</article>
					`)}
					${t.loaded&&l.length===0?e`<p class="text-muted-foreground" data-testid="graph-status-empty">No component graph status is available yet.</p>`:n}
					${t.config?e`<pre class="overflow-auto rounded border border-border p-3 text-xs text-muted-foreground" data-testid="graph-status-config-value">${JSON.stringify(t.config,null,2)}</pre>`:n}
				</section>
			`}}}export{w as default};
