var f=i=>i&&i.message?String(i.message):String(i),l=(i,c="")=>i==null?c:String(i),H=["apiKey","externalDatabaseUrl","llmApiKey"];var q=`${encodeURIComponent("hindsight")}:${encodeURIComponent("hindsight")}`;function F(){try{return globalThis.localStorage&&localStorage.getItem("gateway.url")||globalThis.location?.origin||""}catch{return globalThis.location?.origin||""}}function G(){try{return globalThis.localStorage&&localStorage.getItem("gateway.token")||""}catch{return""}}var w=globalThis.__bobbitHindsightPanelState||(globalThis.__bobbitHindsightPanelState=new Map);function Q(){return{mountKicked:!1,configState:"loading",configError:null,config:null,configured:!1,draft:null,secretTouched:{apiKey:!1,externalDatabaseUrl:!1,llmApiKey:!1},dirty:!1,saving:!1,saveErrors:[],statusState:"loading",status:null,statusError:null,searchState:"idle",searchResults:[],searchError:null,searchDormant:!1,searchQuery:"",searchScope:"",pollTimer:null,pollTicks:0,logsOpen:!1,logsState:"idle",logs:"",logsError:null}}function $(i){let c=i||{};return{mode:l(c.mode,"external"),externalUrl:l(c.externalUrl,""),bank:l(c.bank,"bobbit"),namespace:l(c.namespace,"default"),dataDir:l(c.dataDir,"~/.hindsight"),recallScope:c.recallScope==="project"?"project":"all",autoRecall:c.autoRecall!==!1,autoRetain:c.autoRetain!==!1,recallBudget:l(c.recallBudget,"1200"),timeoutMs:l(c.timeoutMs,"1500"),apiKey:"",externalDatabaseUrl:"",llmApiKey:""}}function V({html:i,nothing:c,renderHeader:R}){let u=e=>{try{e&&e.requestRender&&e.requestRender()}catch{}},d=e=>w.get(e),E=e=>{if(e&&e.pollTimer){try{clearTimeout(e.pollTimer)}catch{}e.pollTimer=null}},k=(e,t)=>{let r=d(t);if(!r||!r.status)return;let s=r.status;if(!((s.mode==="managed"||s.mode==="managed-external-postgres")&&s.configured&&!s.healthy&&r.pollTicks<20)){E(r);return}r.pollTimer||(r.pollTimer=setTimeout(()=>{let n=d(t);n&&(n.pollTimer=null,n.pollTicks+=1,m(e,t,!0))},1500))};async function A(e,t){try{let r=await e.callRoute("config",{method:"GET"}),s=d(t);if(!s)return;s.config=r&&r.config?r.config:null,s.configured=!!(r&&r.configured),s.draft=$(s.config),s.secretTouched={apiKey:!1,externalDatabaseUrl:!1,llmApiKey:!1},s.dirty=!1,s.configState="ready",u(e)}catch(r){let s=d(t);if(!s)return;s.configState="error",s.configError=f(r),u(e)}}async function m(e,t,r=!1){let s=d(t);s&&!r&&(s.statusState=s.status?"ready":"loading");try{let a=await e.callRoute("status",{method:"GET"}),o=d(t);if(!o)return;o.status=a||null,o.statusState="ready",o.statusError=null,k(e,t),u(e)}catch(a){let o=d(t);if(!o)return;o.statusState="error",o.statusError=f(a),u(e)}}function L(e){let t=e.config||{},r=e.draft||{},s={};r.mode!==t.mode&&(s.mode=r.mode);for(let a of["externalUrl","bank","namespace","dataDir"]){let o=l(r[a],""),n=l(t[a],"");o!==n&&(s[a]=o)}r.recallScope!==(t.recallScope==="project"?"project":"all")&&(s.recallScope=r.recallScope);for(let a of["autoRecall","autoRetain"])!!r[a]!=(t[a]!==!1)&&(s[a]=!!r[a]);for(let a of["recallBudget","timeoutMs"]){let o=Number(r[a]);Number.isFinite(o)&&o>0&&o!==Number(t[a])&&(s[a]=o)}for(let a of H)e.secretTouched[a]&&(s[a]=l(r[a],""));return s}async function D(e,t){let r=d(t);if(!r||!r.draft||r.saving)return;r.saving=!0,r.saveErrors=[],u(e);let s=L(r);try{let a=await e.callRoute("config",{method:"POST",body:s}),o=d(t);if(!o)return;if(o.saving=!1,a&&a.ok===!1){o.saveErrors=Array.isArray(a.errors)&&a.errors.length?a.errors:[l(a.error,"Save failed")],u(e);return}o.config=a&&a.config?a.config:o.config,o.configured=!!(a&&a.configured),o.draft=$(o.config),o.secretTouched={apiKey:!1,externalDatabaseUrl:!1,llmApiKey:!1},o.dirty=!1,o.pollTicks=0,m(e,t),u(e)}catch(a){let o=d(t);if(!o)return;o.saving=!1,o.saveErrors=[f(a)],u(e)}}async function S(e,t){let r=d(t);if(r){r.logsState="loading",r.logsError=null,u(e);try{let s=F(),a=await fetch(`${s}/api/pack-runtimes/${q}/logs?tail=200`,{headers:{Authorization:`Bearer ${G()}`}}),o=d(t);if(!o)return;if(!a.ok){o.logsState="error",o.logsError=`HTTP ${a.status}`,u(e);return}let n=await a.json().catch(()=>({}));o.logs=l(n&&n.logs,""),o.logsState="loaded",o.logsError=n&&n.status==="docker-unavailable"?"Docker is not available":null,u(e)}catch(s){let a=d(t);if(!a)return;a.logsState="error",a.logsError=f(s),u(e)}}}let M=(e,t)=>{let r=d(t);r&&(r.logsOpen=!r.logsOpen,u(e),r.logsOpen&&S(e,t))};async function _(e,t){let r=d(t);if(!r)return;let s=l(r.searchQuery,"").trim();if(!s)return;r.searchState="searching",r.searchError=null,u(e);let a=r.searchScope||r.config&&r.config.recallScope||"all";try{let o=await e.callRoute("recall",{method:"POST",body:{query:s,scope:a}}),n=d(t);if(!n)return;if(o&&o.configured===!1)n.searchResults=[],n.searchDormant=!0,n.searchState="empty",n.searchError=null;else if(o&&o.error)n.searchResults=[],n.searchDormant=!1,n.searchState="error",n.searchError=String(o.error);else{let p=o&&Array.isArray(o.memories)?o.memories:[];n.searchResults=p,n.searchDormant=!1,n.searchState=p.length?"results":"empty",n.searchError=null}u(e)}catch(o){let n=d(t);if(!n)return;n.searchState="error",n.searchError=f(o),n.searchResults=[],u(e)}}let g=(e,t,r,s)=>{let a=d(t);!a||!a.draft||(a.draft={...a.draft,[r]:s},a.dirty=!0,u(e))},I=(e,t,r,s)=>{let a=d(t);!a||!a.draft||(a.draft={...a.draft,[r]:s},a.secretTouched={...a.secretTouched,[r]:!0},a.dirty=!0,u(e))};function P(e){let t=e.status;return(t?!!t.configured:!!e.configured)?t&&t.healthy?{state:"connected",label:"Connected",hint:""}:(t&&t.mode||e.config&&e.config.mode||"external")==="external"?{state:"unreachable",label:"Unreachable",hint:""}:{state:"starting",label:"Starting",hint:"Managed runtime not running"}:{state:"dormant",label:"Dormant",hint:"Not configured"}}let b=e=>e==="managed"||e==="managed-external-postgres",h=(e,t,r,s,a={})=>i`
		<label class="hs-field">
			<span class="hs-label">${e}</span>
			<input
				class="hs-input"
				data-testid=${t}
				type=${a.type||"text"}
				.value=${l(r,"")}
				placeholder=${a.placeholder||""}
				@input=${s}
			/>
			${a.hint?i`<span class="hs-hint">${a.hint}</span>`:c}
		</label>`,x=(e,t,r,s,a,o,n={})=>{let p=s.draft||{},v=s.config&&s.config[`${r}Set`],N=!s.secretTouched[r]&&v?"\u2022\u2022\u2022\u2022 set":n.placeholder||"";return i`
			<label class="hs-field">
				<span class="hs-label">${e}</span>
				<input
					class="hs-input"
					data-testid=${t}
					type="password"
					autocomplete="off"
					.value=${l(p[r],"")}
					placeholder=${N}
					@input=${z=>I(a,o,r,z.currentTarget.value)}
				/>
				${n.hint?i`<span class="hs-hint">${n.hint}</span>`:c}
			</label>`},T=(e,t,r,s)=>i`
		<label class="hs-toggle">
			<input type="checkbox" data-testid=${t} .checked=${!!r} @change=${s} />
			<span>${e}</span>
		</label>`,U=(e,t,r)=>{let s=P(e),a=e.status||{},o=l(a.mode||e.config&&e.config.mode,"external"),n=Number(a.queueDepth||0),p=a.lastError,v=p&&typeof p=="object"?l(p.message):l(p,"");return i`
			<section class="hs-card" data-testid="hindsight-status-card">
				<div class="hs-card-head">
					<h2 class="hs-card-title">Runtime status</h2>
					<div class="hs-card-actions">
						<span class="hs-badge" data-testid="hindsight-status-badge" data-state=${s.state} title=${s.hint||s.label}>${s.label}</span>
						<button class="hs-btn" data-testid="hindsight-refresh" type="button" ?disabled=${e.statusState==="loading"} @click=${()=>m(t,r)}>Refresh</button>
					</div>
				</div>
				${e.statusState==="error"?i`<p class="hs-error" data-testid="hindsight-status-error">${l(e.statusError,"Status unavailable")}</p>`:i`
						<dl class="hs-rows">
							<div class="hs-row"><dt>Mode</dt><dd data-testid="hindsight-status-mode">${o}</dd></div>
							<div class="hs-row"><dt>Bank</dt><dd>${l(a.bank||e.config&&e.config.bank,"bobbit")}</dd></div>
							<div class="hs-row"><dt>Namespace</dt><dd>${l(a.namespace||e.config&&e.config.namespace,"default")}</dd></div>
							<div class="hs-row"><dt>Recall scope</dt><dd>${l(a.recallScope||e.config&&e.config.recallScope,"all")}</dd></div>
							<div class="hs-row"><dt>Auto recall / retain</dt><dd>${a.autoRecall===!1?"off":"on"} / ${a.autoRetain===!1?"off":"on"}</dd></div>
						</dl>
						<div class="hs-chips">
							<span class="hs-chip" data-testid="hindsight-queue-depth" data-queue-depth=${String(n)}>${n} queued ${n===1?"retain":"retains"}</span>
							${b(o)?i`<button class="hs-chip hs-chip-muted hs-chip-btn" data-testid="hindsight-logs-button" type="button" aria-expanded=${e.logsOpen?"true":"false"} @click=${()=>M(t,r)}>${e.logsOpen?"Hide logs":"View runtime logs"}</button>`:c}
						</div>
						${b(o)&&e.logsOpen?K(e,t,r):c}
						${v?i`<p class="hs-last-error" data-testid="hindsight-last-error">Last error: ${v}</p>`:c}
					`}
			</section>`},K=(e,t,r)=>i`
		<div class="hs-logs" data-testid="hindsight-logs-view" data-logs-state=${e.logsState}>
			<div class="hs-logs-head">
				<span class="hs-label">Runtime logs (tail ${200})</span>
				<button class="hs-btn" data-testid="hindsight-logs-refresh" type="button" ?disabled=${e.logsState==="loading"} @click=${()=>S(t,r)}>${e.logsState==="loading"?"Loading\u2026":"Refresh"}</button>
			</div>
			${e.logsState==="error"?i`<p class="hs-error" data-testid="hindsight-logs-error">${l(e.logsError,"Logs unavailable")}</p>`:e.logsState==="loading"&&!e.logs?i`<p class="hs-muted">Loading logs…</p>`:i`
						${e.logsError?i`<p class="hs-muted" data-testid="hindsight-logs-note">${l(e.logsError)}</p>`:c}
						<pre class="hs-logs-pre" data-testid="hindsight-logs-pre">${e.logs&&e.logs.length?e.logs:"No logs yet."}</pre>`}
		</div>`,O=(e,t,r)=>{let s=e.draft||$(null),a=s.mode,o=n=>g(t,r,"mode",n.currentTarget.value);return i`
			<section class="hs-card" data-testid="hindsight-config-card">
				<div class="hs-card-head">
					<h2 class="hs-card-title">Configuration</h2>
					<button class="hs-btn hs-btn-primary" data-testid="hindsight-save" type="button" ?disabled=${e.saving} @click=${()=>D(t,r)}>${e.saving?"Saving\u2026":"Save"}</button>
				</div>

				<label class="hs-field">
					<span class="hs-label">Deployment mode</span>
					<select class="hs-input" data-testid="hindsight-mode" .value=${a} @change=${o}>
						<option value="external" ?selected=${a==="external"}>External (operator-supplied URL)</option>
						<option value="managed" ?selected=${a==="managed"}>Managed (Bobbit-run, managed Postgres)</option>
						<option value="managed-external-postgres" ?selected=${a==="managed-external-postgres"}>Managed + external Postgres</option>
					</select>
				</label>

				${a==="external"?h("External URL","hindsight-external-url",s.externalUrl,n=>g(t,r,"externalUrl",n.currentTarget.value),{placeholder:"https://hindsight.example.com",hint:"Activates external mode; empty keeps it dormant."}):c}

				${b(a)?h("Managed data dir","hindsight-data-dir",s.dataDir,n=>g(t,r,"dataDir",n.currentTarget.value),{placeholder:"~/.hindsight",hint:a==="managed"?"Host bind-mount path for managed Postgres data.":""}):c}

				${a==="managed-external-postgres"?x("External Postgres URL","hindsight-external-db-url","externalDatabaseUrl",e,t,r,{hint:"\u2192 runtime HINDSIGHT_API_DATABASE_URL. Required to start."}):c}

				${b(a)?x("LLM API key","hindsight-llm-api-key","llmApiKey",e,t,r,{hint:"\u2192 runtime HINDSIGHT_API_LLM_API_KEY. Required to start."}):c}

				${x("API key","hindsight-api-key","apiKey",e,t,r,{hint:"Optional bearer token for the Hindsight API."})}

				<div class="hs-grid2">
					${h("Bank","hindsight-bank",s.bank,n=>g(t,r,"bank",n.currentTarget.value),{placeholder:"bobbit"})}
					${h("Namespace","hindsight-namespace",s.namespace,n=>g(t,r,"namespace",n.currentTarget.value),{placeholder:"default"})}
				</div>

				<label class="hs-field">
					<span class="hs-label">Recall scope</span>
					<select class="hs-input" data-testid="hindsight-recall-scope" .value=${s.recallScope} @change=${n=>g(t,r,"recallScope",n.currentTarget.value)}>
						<option value="all" ?selected=${s.recallScope==="all"}>All</option>
						<option value="project" ?selected=${s.recallScope==="project"}>This project</option>
					</select>
				</label>

				<div class="hs-toggles">
					${T("Auto recall","hindsight-auto-recall",s.autoRecall,n=>g(t,r,"autoRecall",n.currentTarget.checked))}
					${T("Auto retain","hindsight-auto-retain",s.autoRetain,n=>g(t,r,"autoRetain",n.currentTarget.checked))}
				</div>

				<div class="hs-grid2">
					${h("Recall budget (tokens)","hindsight-recall-budget",s.recallBudget,n=>g(t,r,"recallBudget",n.currentTarget.value),{type:"number"})}
					${h("Timeout (ms)","hindsight-timeout",s.timeoutMs,n=>g(t,r,"timeoutMs",n.currentTarget.value),{type:"number"})}
				</div>

				${e.saveErrors&&e.saveErrors.length?i`<ul class="hs-errors" data-testid="hindsight-config-error">${e.saveErrors.map(n=>i`<li>${l(n)}</li>`)}</ul>`:c}
			</section>`},j=(e,t)=>{let r=l(e&&e.text,""),s=e&&typeof e.score=="number",a=e&&e.id!=null?String(e.id):"";return i`
			<li class="hs-memory" data-testid="hindsight-memory-result" data-memory-id=${a}>
				<div class="hs-memory-text">${r}</div>
				<div class="hs-memory-meta">
					${s?i`<span class="hs-chip">score ${Number(e.score).toFixed(2)}</span>`:c}
					${a?i`<span class="hs-memory-id">${a}</span>`:c}
				</div>
			</li>`},C=(e,t,r)=>{let s=o=>{o&&o.preventDefault(),_(t,r)},a=e.searchScope||e.config&&e.config.recallScope||"all";return i`
			<section class="hs-card" data-testid="hindsight-search-card">
				<h2 class="hs-card-title">Search memory</h2>
				<form class="hs-search-row" @submit=${s}>
					<input
						class="hs-input"
						data-testid="hindsight-search-input"
						type="text"
						placeholder="Search recalled memories…"
						.value=${l(e.searchQuery,"")}
						@input=${o=>{let n=d(r);n&&(n.searchQuery=o.currentTarget.value)}}
					/>
					<select class="hs-input hs-scope" data-testid="hindsight-search-scope" .value=${a} @change=${o=>{let n=d(r);n&&(n.searchScope=o.currentTarget.value,u(t))}}>
						<option value="all" ?selected=${a==="all"}>All</option>
						<option value="project" ?selected=${a==="project"}>This project</option>
					</select>
					<button class="hs-btn hs-btn-primary" data-testid="hindsight-search-submit" type="submit" ?disabled=${e.searchState==="searching"}>${e.searchState==="searching"?"Searching\u2026":"Search"}</button>
				</form>
				${B(e)}
			</section>`},B=e=>e.searchState==="searching"?i`<p class="hs-muted" data-testid="hindsight-search-loading">Searching…</p>`:e.searchState==="error"?i`<p class="hs-error" data-testid="hindsight-search-error">${l(e.searchError,"Search failed")}</p>`:e.searchState==="empty"?e.searchDormant?i`<p class="hs-muted" data-testid="hindsight-search-empty">Configure Hindsight to search memory.</p>`:i`<p class="hs-muted" data-testid="hindsight-search-empty">No memories matched.</p>`:e.searchState==="results"?i`<ul class="hs-memories">${e.searchResults.map((t,r)=>j(t,r))}</ul>`:c,y=i`<style>
		.hs-root { color: var(--foreground); background: var(--background); padding: 16px; min-height: 100%; box-sizing: border-box; display: flex; flex-direction: column; gap: 16px; font-size: 13px; }
		.hs-root h1 { font-size: 16px; margin: 0; }
		.hs-root h2 { font-size: 14px; margin: 0; }
		.hs-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
		.hs-card { border: 1px solid var(--border); border-radius: 10px; background: var(--card); padding: 14px; display: flex; flex-direction: column; gap: 12px; }
		.hs-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
		.hs-card-title { color: var(--foreground); }
		.hs-card-actions { display: flex; align-items: center; gap: 8px; }
		.hs-rows { display: grid; grid-template-columns: 1fr; gap: 6px; margin: 0; }
		.hs-row { display: flex; justify-content: space-between; gap: 12px; }
		.hs-row dt { color: var(--muted-foreground); }
		.hs-row dd { margin: 0; color: var(--foreground); font-variant-numeric: tabular-nums; }
		.hs-field { display: flex; flex-direction: column; gap: 4px; }
		.hs-label { color: var(--muted-foreground); font-size: 12px; }
		.hs-hint { color: var(--muted-foreground); font-size: 11px; }
		.hs-input { width: 100%; box-sizing: border-box; background: var(--background); color: var(--foreground); border: 1px solid var(--border); border-radius: 7px; padding: 7px 9px; font: inherit; }
		.hs-input:focus { outline: none; border-color: var(--primary); }
		.hs-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
		.hs-toggles { display: flex; gap: 18px; flex-wrap: wrap; }
		.hs-toggle { display: inline-flex; align-items: center; gap: 6px; color: var(--foreground); }
		.hs-btn { background: var(--background); color: var(--foreground); border: 1px solid var(--border); border-radius: 7px; padding: 6px 12px; font: inherit; cursor: pointer; }
		.hs-btn:hover:not(:disabled) { border-color: var(--primary); }
		.hs-btn:disabled { opacity: 0.55; cursor: default; }
		.hs-btn-primary { background: var(--primary); color: var(--background); border-color: var(--primary); }
		.hs-badge { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; border: 1px solid var(--border); color: var(--muted-foreground); background: color-mix(in oklch, var(--muted-foreground) 12%, transparent); }
		.hs-badge[data-state="connected"] { color: var(--positive); border-color: color-mix(in oklch, var(--positive) 45%, transparent); background: color-mix(in oklch, var(--positive) 14%, transparent); }
		.hs-badge[data-state="unreachable"] { color: var(--negative); border-color: color-mix(in oklch, var(--negative) 45%, transparent); background: color-mix(in oklch, var(--negative) 14%, transparent); }
		.hs-badge[data-state="starting"] { color: var(--warning); border-color: color-mix(in oklch, var(--warning) 45%, transparent); background: color-mix(in oklch, var(--warning) 14%, transparent); }
		.hs-chips { display: flex; gap: 8px; flex-wrap: wrap; }
		.hs-chip { display: inline-flex; align-items: center; padding: 2px 9px; border-radius: 999px; font-size: 12px; border: 1px solid var(--border); background: color-mix(in oklch, var(--chart-1) 10%, transparent); color: var(--foreground); }
		.hs-chip-muted { background: color-mix(in oklch, var(--muted-foreground) 10%, transparent); color: var(--muted-foreground); }
		.hs-chip-btn { cursor: pointer; font: inherit; }
		.hs-chip-btn:hover:not(:disabled) { border-color: var(--primary); color: var(--foreground); }
		.hs-logs { border: 1px solid var(--border); border-radius: 8px; background: var(--background); padding: 10px; display: flex; flex-direction: column; gap: 8px; }
		.hs-logs-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
		.hs-logs-pre { margin: 0; max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--foreground); }
		.hs-muted { color: var(--muted-foreground); margin: 0; }
		.hs-error { color: var(--negative); margin: 0; }
		.hs-last-error { color: var(--muted-foreground); font-size: 12px; margin: 0; }
		.hs-errors { color: var(--negative); margin: 0; padding-left: 18px; font-size: 12px; }
		.hs-search-row { display: flex; gap: 8px; align-items: center; }
		.hs-search-row .hs-input { flex: 1; }
		.hs-scope { flex: 0 0 auto; width: auto; }
		.hs-memories { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
		.hs-memory { border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: var(--background); display: flex; flex-direction: column; gap: 6px; }
		.hs-memory-text { color: var(--foreground); white-space: pre-wrap; word-break: break-word; }
		.hs-memory-meta { display: flex; gap: 8px; align-items: center; }
		.hs-memory-id { color: var(--muted-foreground); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
	</style>`;return{render(e,t){let r=e&&e.__sessionId||"hindsight-default";if(!!!(t&&t.capabilities&&t.capabilities.callRoute&&typeof t.callRoute=="function"))return i`${y}<div class="hs-root" data-testid="hindsight-panel" data-state="unavailable"><p class="hs-muted">Hindsight memory is unavailable on this host.</p></div>`;let a=d(r);a||(a=Q(),w.set(r,a)),a.mountKicked||(a.mountKicked=!0,A(t,r),m(t,r));let o=a.configState==="loading"&&!a.draft;return i`
				${y}
				<div class="hs-root" data-testid="hindsight-panel" data-config-state=${a.configState} data-status-state=${a.statusState}>
					<div class="hs-head">
						<h1>Hindsight Memory</h1>
					</div>
					${U(a,t,r)}
					${a.configState==="error"?i`<section class="hs-card"><p class="hs-error" data-testid="hindsight-config-load-error">${l(a.configError,"Config unavailable")}</p></section>`:o?i`<section class="hs-card"><p class="hs-muted" data-testid="hindsight-config-loading">Loading configuration…</p></section>`:O(a,t,r)}
					${C(a,t,r)}
				</div>`}}}export{V as default};
