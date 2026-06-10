var q=[{id:"orientation",label:"Orientation"},{id:"design",label:"Key design choices"},{id:"significant",label:"Significant changes"},{id:"other",label:"Other + omissions"},{id:"audit",label:"Audit"}];function _({html:s,nothing:i,renderHeader:$}){let p=new Map,v=new Set,w=e=>e==="add"?"background:color-mix(in oklch, var(--positive) 16%, transparent);color:var(--foreground);":e==="del"?"background:color-mix(in oklch, var(--negative) 16%, transparent);color:var(--foreground);":"color:var(--muted-foreground);",y=e=>e==="add"?"+":e==="del"?"-":" ",m=e=>e&&e.bundle&&Array.isArray(e.bundle.cards)?e.bundle.cards:[],b=e=>{let t=m(e);return t.length===0?void 0:t.find(o=>o.id===e.activeCardId)||t[0]},h=e=>s`
		<div class="mt-3 rounded border border-border overflow-hidden" data-testid="prw-diffblock" data-prw-file=${e.filePath}>
			<div class="px-2 py-1 text-xs font-mono bg-muted/40 text-foreground border-b border-border flex items-center justify-between gap-2">
				<span>${e.status??"modified"} ${e.filePath}</span>
				${e.oldPath&&e.oldPath!==e.filePath?s`<span class="text-muted-foreground">(was ${e.oldPath})</span>`:i}
			</div>
			${(e.hunks??[]).map(t=>s`
					<div class="px-2 py-0.5 text-xs font-mono" style="color:var(--muted-foreground);background:color-mix(in oklch, var(--info) 10%, transparent);">${t.header}</div>
					${(t.lines??[]).map(d=>s`<div class="px-2 font-mono text-xs whitespace-pre" style=${w(d.kind)}>${y(d.kind)}${d.text}</div>`)}
				`)}
		</div>
	`,k=e=>s`
		<div class="mt-2 rounded border-l-2 p-2 text-xs"
			style="border-color:var(--warning);background:color-mix(in oklch, var(--warning) 7%, transparent);"
			data-testid="prw-suggested-comment" data-prw-comment=${e.id}>
			<div class="font-mono text-[10px] text-muted-foreground">${e.diffBlockId}${e.lineId?` \xB7 ${e.lineId}`:""}</div>
			<div class="text-foreground mt-0.5">${e.body}</div>
		</div>
	`,C=e=>s`
		<div data-testid="prw-card" data-prw-card=${e.id}>
			<div class="text-[10px] font-semibold uppercase tracking-wide" style="color:var(--chart-1)">${e.phaseId}</div>
			<div class="text-base font-semibold text-foreground mt-1">${e.title}</div>
			${e.summary?s`<div class="text-xs text-muted-foreground mt-1 leading-relaxed">${e.summary}</div>`:i}
			${e.rationale?s`<div class="text-xs text-muted-foreground mt-1 leading-relaxed">${e.rationale}</div>`:i}
			${Array.isArray(e.checklist)&&e.checklist.length?s`<ul class="mt-2 pl-4 text-xs text-muted-foreground list-disc">${e.checklist.map(t=>s`<li>${t}</li>`)}</ul>`:i}
			${(e.diffBlocks??[]).map(h)}
			${Array.isArray(e.suggestedComments)&&e.suggestedComments.length?s`<div class="mt-2"><div class="text-[10px] uppercase tracking-wide text-muted-foreground">Suggested comments</div>${e.suggestedComments.map(k)}</div>`:i}
		</div>
	`,S=(e,t,d)=>{let o=m(e),a=b(e);return s`
			<div class="w-44 flex-none border-r border-border pr-2 overflow-auto" data-testid="prw-navrail">
				${q.map(r=>{let l=o.filter(c=>c.phaseId===r.id);return l.length===0?i:s`
						<div class="mt-2 first:mt-0">
							<div class="text-[10px] uppercase tracking-wide text-muted-foreground px-1">${r.label}</div>
							${l.map(c=>{let n=a&&a.id===c.id,f=()=>{let u=p.get(d)||e;p.set(d,{...u,activeCardId:c.id}),t&&t.requestRender&&t.requestRender()};return s`<button
									class="block w-full text-left text-xs px-2 py-1 mt-0.5 rounded ${n?"text-foreground":"text-muted-foreground"} hover:bg-muted/50"
									style=${n?"background:color-mix(in oklch, var(--primary) 12%, transparent);":""}
									data-testid="prw-nav-card" data-prw-nav=${c.id}
									@click=${f}
								>${c.navLabel??c.title}</button>`})}
						</div>
					`})}
			</div>
		`},A=(e,t,d)=>{let o=e.bundle;if(o&&o.found===!1)return s`<div class="mt-3 text-xs text-muted-foreground" data-testid="prw-empty">
				No walkthrough has been submitted for <span class="font-mono">${d}</span> yet. Run a PR walkthrough so the agent submits and persists one.
			</div>`;let a=o&&o.changeset||{},r=b(e),l=e.toolCall&&e.toolCall.input&&typeof e.toolCall.input.yaml=="string"?e.toolCall.input.yaml:void 0;return s`
			<div class="mt-2" data-testid="prw-bundle">
				<div class="text-sm font-semibold text-foreground" data-testid="prw-title">${a.prTitle??a.title??"Walkthrough"}</div>
				<div class="text-xs text-muted-foreground mt-0.5">
					<span class="font-mono">${(a.baseSha??"").slice(0,7)}…${(a.headSha??"").slice(0,7)}</span>
					· ${a.filesChanged??0} file(s)
					· <span style="color:var(--positive)">+${a.additions??0}</span>
					· <span style="color:var(--negative)">-${a.deletions??0}</span>
					${a.provider?s`· <span class="font-mono">${a.provider}</span>`:i}
				</div>
				<div class="text-[10px] text-muted-foreground mt-1">
					persisted: <span data-testid="prw-persisted-at">${String(o.persistedAt??"")}</span>
				</div>
				<div class="text-[10px] text-muted-foreground" data-testid="prw-toolcall">
					submit yaml: ${l?l.slice(0,80):"(none)"}
				</div>
				<div class="flex gap-3 mt-3">
					${S(e,t,d)}
					<div class="flex-1 min-w-0 overflow-auto">
						${r?C(r):s`<div class="text-xs text-muted-foreground" data-testid="prw-no-cards">This walkthrough has no cards.</div>`}
					</div>
				</div>
			</div>
		`};return{render(e,t){let d=e&&e.jobId||"job-litmus-1",o=e&&e.baseSha,a=e&&e.headSha,r=p.get(d),l=v.has(d);return s`
				<div class="p-3" data-testid="prw-panel-root" data-prw-job=${d}>
					<div class="flex items-center justify-between gap-2">
						<span class="text-sm font-semibold text-foreground">PR Walkthrough</span>
						<span class="text-xs text-muted-foreground font-mono">${d}</span>
					</div>
					${!r&&!l?s`<button
								class="mt-2 text-xs px-2 py-1 rounded border border-border bg-transparent text-foreground hover:bg-muted/50"
								data-testid="prw-load"
								@click=${async()=>{if(t){v.add(d),t.requestRender&&t.requestRender();try{let n=null;if(t.capabilities&&t.capabilities.session)try{let R=await t.session.readTranscript({pattern:"submit_pr_walkthrough_yaml",limit:100}),x;for(let I of R.messages||[])for(let g of I.content||[])g.type==="tool_use"&&g.tool==="submit_pr_walkthrough_yaml"&&(x=g.toolUseId);x&&(n=await t.session.readToolCall(x))}catch{}let f={jobId:d};o&&(f.baseSha=o),a&&(f.headSha=a);let u=await t.callRoute("bundle",{query:f}),P=Array.isArray(u&&u.cards)&&u.cards.length?u.cards[0].id:void 0;p.set(d,{bundle:u,toolCall:n,activeCardId:P})}catch(n){p.set(d,{error:n&&n.message?n.message:String(n)})}finally{v.delete(d),t.requestRender&&t.requestRender()}}}}
							>
								Load walkthrough
							</button>`:i}
					${l?s`<div class="mt-2 text-xs text-muted-foreground" data-testid="prw-loading">Loading…</div>`:i}
					${r&&r.error?s`<div class="mt-2 text-xs" style="color:var(--negative)" data-testid="prw-error">${r.error}</div>`:i}
					${r&&r.bundle?A(r,t,d):i}
				</div>
			`}}}export{_ as default};
