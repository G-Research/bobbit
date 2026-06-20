var $=i=>i&&i.message?String(i.message):String(i),c=(i,d="")=>i==null?d:String(i),ue=["apiKey","externalDatabaseUrl","llmApiKey"];var H=`${encodeURIComponent("hindsight")}:${encodeURIComponent("hindsight")}`,k="http://localhost:9177",R="http://localhost:19177/banks/hermes?view=data";function B(){try{return globalThis.localStorage&&localStorage.getItem("gateway.url")||globalThis.location?.origin||""}catch{return globalThis.location?.origin||""}}function O(){try{return globalThis.localStorage&&localStorage.getItem("gateway.token")||""}catch{return""}}function T(i){let d=c(i,"").trim();if(!d)return!1;try{let w=new URL(d);return w.protocol==="http:"||w.protocol==="https:"}catch{return!1}}var _=globalThis.__bobbitHindsightPanelState||(globalThis.__bobbitHindsightPanelState=new Map);function ge(){return{mountKicked:!1,configState:"loading",configError:null,config:null,configured:!1,draft:null,secretTouched:{apiKey:!1,externalDatabaseUrl:!1,llmApiKey:!1},dirty:!1,saving:!1,saveErrors:[],statusState:"loading",status:null,statusError:null,searchState:"idle",searchResults:[],searchError:null,searchDormant:!1,searchQuery:"",searchScope:"",pollTimer:null,pollTicks:0,logsOpen:!1,logsState:"idle",logs:"",logsError:null,setupOpen:!1,setupProgress:null,setupTesting:!1,managedConsentAck:!1,runtimePhase:"idle",runtimeError:null}}function y(i){let d=i||{};return{mode:c(d.mode,"external"),externalUrl:c(d.externalUrl,""),uiUrl:c(d.uiUrl,""),bank:c(d.bank,"bobbit"),namespace:c(d.namespace,"default"),dataDir:c(d.dataDir,"~/.hindsight"),recallScope:d.recallScope==="project"?"project":"all",autoRecall:d.autoRecall!==!1,autoRetain:d.autoRetain!==!1,recallBudget:c(d.recallBudget,"1200"),timeoutMs:c(d.timeoutMs,"1500"),apiKey:"",externalDatabaseUrl:"",llmApiKey:""}}function pe({html:i,nothing:d,renderHeader:w}){let p=e=>{try{e&&e.requestRender&&e.requestRender()}catch{}},u=e=>_.get(e),L=e=>{if(e&&e.pollTimer){try{clearTimeout(e.pollTimer)}catch{}e.pollTimer=null}},v=e=>e==="managed"||e==="managed-external-postgres",C=(e,s)=>{let a=u(s);if(!a||!a.status){a&&L(a);return}let r=a.status,t=v(r.mode),o=a.runtimePhase==="starting"||r.runtimeStatus==="starting"||r.runtimeStatus===void 0&&r.configured&&!r.healthy;if(!(t&&r.configured&&!r.healthy&&o&&a.pollTicks<20)){L(a);return}a.pollTimer||(a.pollTimer=setTimeout(()=>{let l=u(s);l&&(l.pollTimer=null,l.pollTicks+=1,S(e,s,!0))},1500))};function A(e,s){e.config=s&&s.config?s.config:null,e.configured=!!(s&&s.configured),e.dirty?e.draft||(e.draft=y(e.config)):(e.draft=y(e.config),e.secretTouched={apiKey:!1,externalDatabaseUrl:!1,llmApiKey:!1})}async function E(e,s){try{let a=await e.callRoute("config",{method:"GET"}),r=u(s);return r?(A(r,a),r.configState="ready",p(e),!0):!1}catch(a){let r=u(s);return r&&(r.configState="error",r.configError=$(a),p(e)),!1}}async function S(e,s,a=!1){let r=u(s);r&&!a&&(r.statusState=r.status?"ready":"loading");try{let t=await e.callRoute("status",{method:"GET"}),o=u(s);if(!o)return;o.status=t||null,o.statusState="ready",o.statusError=null,o.runtimePhase==="starting"&&t&&(t.healthy||t.runtimeStatus==="running")&&(o.runtimePhase="idle"),C(e,s),p(e)}catch(t){let o=u(s);if(!o)return;o.statusState="error",o.statusError=$(t),p(e)}}let K=(e,s)=>{E(e,s),S(e,s)};function N(e){let s=e.config||{},a=e.draft||{},r={};a.mode!==s.mode&&(r.mode=a.mode);for(let t of["externalUrl","uiUrl","bank","namespace","dataDir"]){let o=c(a[t],""),n=c(s[t],"");o!==n&&(r[t]=o)}a.recallScope!==(s.recallScope==="project"?"project":"all")&&(r.recallScope=a.recallScope);for(let t of["autoRecall","autoRetain"])!!a[t]!=(s[t]!==!1)&&(r[t]=!!a[t]);for(let t of["recallBudget","timeoutMs"]){let o=Number(a[t]);Number.isFinite(o)&&o>0&&o!==Number(s[t])&&(r[t]=o)}for(let t of ue)e.secretTouched[t]&&(r[t]=c(a[t],""));return r}async function z(e,s){let a=u(s);if(!a||!a.draft||a.saving)return;a.saving=!0,a.saveErrors=[],p(e);let r;try{r=await e.callRoute("config",{method:"GET"})}catch(n){let l=u(s);if(!l)return;l.saving=!1,l.saveErrors=[`Couldn't verify the current configuration before saving: ${$(n)}. Save aborted to avoid overwriting a good config \u2014 try again.`],p(e);return}let t=u(s);if(!t)return;A(t,r);let o=N(t);try{let n=await e.callRoute("config",{method:"POST",body:o}),l=u(s);if(!l)return;if(l.saving=!1,n&&n.ok===!1){l.saveErrors=Array.isArray(n.errors)&&n.errors.length?n.errors:[c(n.error,"Save failed")],p(e);return}l.config=n&&n.config?n.config:l.config,l.configured=!!(n&&n.configured),l.draft=y(l.config),l.secretTouched={apiKey:!1,externalDatabaseUrl:!1,llmApiKey:!1},l.dirty=!1,l.pollTicks=0,S(e,s),p(e)}catch(n){let l=u(s);if(!l)return;l.saving=!1,l.saveErrors=[$(n)],p(e)}}let j=(e,s)=>{let a=u(s);a&&(a.draft=y(a.config),a.secretTouched={apiKey:!1,externalDatabaseUrl:!1,llmApiKey:!1},a.dirty=!1,p(e))};async function U(e,s){let a=u(s);if(a){a.logsState="loading",a.logsError=null,p(e);try{let r=B(),t=await fetch(`${r}/api/pack-runtimes/${H}/logs?tail=200`,{headers:{Authorization:`Bearer ${O()}`}}),o=u(s);if(!o)return;if(!t.ok){o.logsState="error",o.logsError=`HTTP ${t.status}`,p(e);return}let n=await t.json().catch(()=>({}));o.logs=c(n&&n.logs,""),o.logsState="loaded",o.logsError=n&&n.status==="docker-unavailable"?"Docker is not available":null,p(e)}catch(r){let t=u(s);if(!t)return;t.logsState="error",t.logsError=$(r),p(e)}}}let q=(e,s)=>{let a=u(s);a&&(a.logsOpen=!a.logsOpen,p(e),a.logsOpen&&U(e,s))};async function M(e,s,a){let r=u(s);if(r){r.runtimePhase=a==="start"?"starting":"stopping",r.runtimeError=null,a==="start"&&(r.pollTicks=0),p(e);try{let t=B(),o=await fetch(`${t}/api/pack-runtimes/${H}/${a}`,{method:"POST",headers:{Authorization:`Bearer ${O()}`,"Content-Type":"application/json"}}),n=u(s);if(!n)return;if(!o.ok){n.runtimePhase="error",n.runtimeError=`HTTP ${o.status}`,p(e);return}a==="stop"&&(n.runtimePhase="idle"),S(e,s),p(e)}catch(t){let o=u(s);if(!o)return;o.runtimePhase="error",o.runtimeError=$(t),p(e)}}}async function F(e,s){let a=u(s);if(!a)return;let r=c(a.searchQuery,"").trim();if(!r)return;a.searchState="searching",a.searchError=null,p(e);let t=a.searchScope||a.config&&a.config.recallScope||"all";try{let o=await e.callRoute("recall",{method:"POST",body:{query:r,scope:t}}),n=u(s);if(!n)return;if(o&&o.configured===!1)n.searchResults=[],n.searchDormant=!0,n.searchState="empty",n.searchError=null;else if(o&&o.error)n.searchResults=[],n.searchDormant=!1,n.searchState="error",n.searchError=String(o.error);else{let l=o&&Array.isArray(o.memories)?o.memories:[];n.searchResults=l,n.searchDormant=!1,n.searchState=l.length?"results":"empty",n.searchError=null}p(e)}catch(o){let n=u(s);if(!n)return;n.searchState="error",n.searchError=$(o),n.searchResults=[],p(e)}}async function G(e,s){let a=u(s);if(!a||a.setupTesting)return;a.setupTesting=!0,a.setupProgress={connection:"running",recall:"pending"},p(e);try{let t=await e.callRoute("status",{method:"GET"}),o=u(s);if(!o)return;o.status=t||o.status,o.statusState="ready",o.setupProgress={...o.setupProgress,connection:t&&t.healthy?"ok":"fail"},p(e)}catch{let t=u(s);t&&(t.setupProgress={...t.setupProgress,connection:"fail"},p(e))}let r=u(s);if(r){r.setupProgress={...r.setupProgress,recall:"running"},p(e);try{let t=await e.callRoute("recall",{method:"POST",body:{query:"hindsight setup smoke test",scope:"all"}}),o=u(s);if(!o)return;let n=!!t&&t.configured!==!1&&!t.error;o.setupProgress={...o.setupProgress,recall:n?"ok":"fail"},o.setupTesting=!1,p(e)}catch{let t=u(s);t&&(t.setupProgress={...t.setupProgress,recall:"fail"},t.setupTesting=!1,p(e))}}}let b=(e,s,a,r)=>{let t=u(s);!t||!t.draft||(t.draft={...t.draft,[a]:r},t.dirty=!0,p(e))},V=(e,s,a,r)=>{let t=u(s);!t||!t.draft||(t.draft={...t.draft,[a]:r},t.secretTouched={...t.secretTouched,[a]:!0},t.dirty=!0,p(e))},Y=(e,s,a)=>{let r=u(s);if(!r||!r.draft)return;let t={...r.draft};a==="external"?t.mode="external":a==="managed"||a==="managed-external-postgres"?t.mode=a:a==="hermes"&&(t.mode="external",t.externalUrl=k,t.bank="hermes",c(t.uiUrl,"").trim()||(t.uiUrl=R)),r.draft=t,r.dirty=!0,p(e)};function Q(e){let s=e.status;if(!(s?!!s.configured:!!e.configured))return{state:"dormant",label:"Not configured",hint:"No memory backend configured yet."};let r=s&&s.mode||e.config&&e.config.mode||"external";if(!v(r))return s&&s.healthy?{state:"connected",label:"Connected",hint:"Connected to your Hindsight."}:{state:"unreachable",label:"Unreachable",hint:"Can't reach Hindsight at the configured URL."};let t=s&&s.runtimeStatus;return t==="running"||s&&s.healthy?{state:"running",label:"Running",hint:"Managed runtime is running."}:t==="unhealthy"?{state:"unhealthy",label:"Unhealthy",hint:"Managed runtime is up but not healthy."}:t==="starting"||e.runtimePhase==="starting"?{state:"starting",label:"Starting\u2026",hint:"Managed runtime is starting\u2026"}:{state:"stopped",label:"Stopped",hint:"Managed runtime is stopped."}}let X=e=>{let s=e.config||{},a=s.mode,r=t=>!!s[`${t}Set`];return a==="managed"?r("llmApiKey"):a==="managed-external-postgres"?r("llmApiKey")&&r("externalDatabaseUrl"):!1},x=(e,s,a,r,t={})=>i`
		<label class="hs-field">
			<span class="hs-label">${e}</span>
			<input
				class="hs-input"
				data-testid=${s}
				type=${t.type||"text"}
				.value=${c(a,"")}
				placeholder=${t.placeholder||""}
				@input=${r}
			/>
			${t.hint?i`<span class="hs-hint">${t.hint}</span>`:d}
			${t.validity?t.validity:d}
		</label>`,P=(e,s,a,r,t,o,n={})=>{let l=r.draft||{},h=r.config&&r.config[`${a}Set`],f=!r.secretTouched[a]&&h?"\u2022\u2022\u2022\u2022 set":n.placeholder||"";return i`
			<label class="hs-field">
				<span class="hs-label">${e}</span>
				<input
					class="hs-input"
					data-testid=${s}
					type="password"
					autocomplete="off"
					.value=${c(l[a],"")}
					placeholder=${f}
					@input=${g=>V(t,o,a,g.currentTarget.value)}
				/>
				${n.hint?i`<span class="hs-hint">${n.hint}</span>`:d}
			</label>`},D=(e,s,a,r)=>i`
		<label class="hs-toggle">
			<input type="checkbox" data-testid=${s} .checked=${!!a} @change=${r} />
			<span>${e}</span>
		</label>`,W=e=>{let s=e.status||{},a=c(s.mode||e.config&&e.config.mode,"external");return v(a)?"managed runtime (loopback)":c(s.externalUrl||e.config&&e.config.externalUrl,"")||"\u2014"},J=(e,s,a)=>{let r=Q(e),t=e.status||{},o=c(t.mode||e.config&&e.config.mode,"external"),n=Number(t.queueDepth||0),l=c(t.uiUrl||e.config&&e.config.uiUrl,""),h=c(t.timeoutMs!=null?t.timeoutMs:e.config&&e.config.timeoutMs,""),f=c(t.recallBudget!=null?t.recallBudget:e.config&&e.config.recallBudget,""),g=t.lastError,m=g&&typeof g=="object"?c(g.message):c(g,"");return i`
			<section class="hs-card" data-testid="hindsight-status-card">
				<div class="hs-card-head">
					<h2 class="hs-card-title">Runtime status</h2>
					<div class="hs-card-actions">
						<span class="hs-badge" data-testid="hindsight-status-badge" data-state=${r.state} title=${r.hint||r.label}>${r.label}</span>
						<button class="hs-btn" data-testid="hindsight-refresh" type="button" ?disabled=${e.statusState==="loading"} @click=${()=>K(s,a)}>Refresh</button>
					</div>
				</div>
				${r.hint?i`<p class="hs-muted" data-testid="hindsight-state-hint">${r.hint}</p>`:d}
				${e.statusState==="error"?i`<p class="hs-error" data-testid="hindsight-status-error">${c(e.statusError,"Status unavailable")}</p>`:i`
						<dl class="hs-rows">
							<div class="hs-row"><dt>Mode</dt><dd data-testid="hindsight-status-mode">${o}</dd></div>
							<div class="hs-row"><dt>API URL</dt><dd class="hs-mono" data-testid="hindsight-api-url">${W(e)}</dd></div>
							${l?i`<div class="hs-row"><dt>UI URL</dt><dd><a class="hs-open-ui" data-testid="hindsight-open-ui" href=${l} target="_blank" rel="noopener noreferrer">Open Hindsight UI ↗</a></dd></div>`:d}
							<div class="hs-row"><dt>Bank</dt><dd>${c(t.bank||e.config&&e.config.bank,"bobbit")}</dd></div>
							<div class="hs-row"><dt>Namespace</dt><dd>${c(t.namespace||e.config&&e.config.namespace,"default")}</dd></div>
							<div class="hs-row"><dt>Recall scope</dt><dd>${c(t.recallScope||e.config&&e.config.recallScope,"all")}</dd></div>
							<div class="hs-row"><dt>Auto recall / retain</dt><dd>${t.autoRecall===!1?"off":"on"} / ${t.autoRetain===!1?"off":"on"}</dd></div>
							${h?i`<div class="hs-row"><dt>Timeout</dt><dd data-testid="hindsight-status-timeout">${h} ms</dd></div>`:d}
							${f?i`<div class="hs-row"><dt>Recall budget</dt><dd>${f} tokens</dd></div>`:d}
						</dl>
						<div class="hs-chips">
							<span class="hs-chip" data-testid="hindsight-queue-depth" data-queue-depth=${String(n)}>${n} queued ${n===1?"retain":"retains"}</span>
							${v(o)?i`<button class="hs-chip hs-chip-muted hs-chip-btn" data-testid="hindsight-logs-button" type="button" aria-expanded=${e.logsOpen?"true":"false"} @click=${()=>q(s,a)}>${e.logsOpen?"Hide logs":"View runtime logs"}</button>`:d}
						</div>
						${v(o)&&e.logsOpen?Z(e,s,a):d}
						${m?i`<p class="hs-last-error" data-testid="hindsight-last-error">Last error: ${m}</p>`:d}
					`}
			</section>`},Z=(e,s,a)=>i`
		<div class="hs-logs" data-testid="hindsight-logs-view" data-logs-state=${e.logsState}>
			<div class="hs-logs-head">
				<span class="hs-label">Runtime logs (tail ${200})</span>
				<button class="hs-btn" data-testid="hindsight-logs-refresh" type="button" ?disabled=${e.logsState==="loading"} @click=${()=>U(s,a)}>${e.logsState==="loading"?"Loading\u2026":"Refresh"}</button>
			</div>
			${e.logsState==="error"?i`<p class="hs-error" data-testid="hindsight-logs-error">${c(e.logsError,"Logs unavailable")}</p>`:e.logsState==="loading"&&!e.logs?i`<p class="hs-muted">Loading logs…</p>`:i`
						${e.logsError?i`<p class="hs-muted" data-testid="hindsight-logs-note">${c(e.logsError)}</p>`:d}
						<pre class="hs-logs-pre" data-testid="hindsight-logs-pre">${e.logs&&e.logs.length?e.logs:"No logs yet."}</pre>`}
		</div>`,ee=[{preset:"hermes",title:"Hermes-local / embedded",mode:"external",bobbit:"Nothing \u2014 client only",you:"Hermes runs Hindsight for you",note:`Preset: API ${k}, bank hermes. No Docker.`},{preset:"external",title:"Connect existing Hindsight",mode:"external",bobbit:"Nothing \u2014 client only",you:"The whole Hindsight deployment",note:"No Docker \u2014 Bobbit only talks to a URL you provide."},{preset:"managed",title:"Bobbit-managed (recommended)",mode:"managed",bobbit:"Docker: Hindsight API + Postgres",you:"An LLM API key; a data dir",note:"Starts local Docker containers when you press Start."},{preset:"managed-external-postgres",title:"Bobbit-managed + your Postgres",mode:"managed-external-postgres",bobbit:"Docker: Hindsight API",you:"Postgres URL; LLM key",note:"Starts local Docker containers when you press Start."}],te=()=>i`
		<div class="hs-subcard" data-testid="hindsight-ownership">
			<span class="hs-label">Who manages what</span>
			<dl class="hs-rows">
				<div class="hs-row"><dt>Bobbit-managed Docker runtime</dt><dd>Bobbit runs the Hindsight API + Postgres in Docker; you supply an LLM key + data dir.</dd></div>
				<div class="hs-row"><dt>Bobbit-managed + external Postgres</dt><dd>Bobbit runs the Hindsight API; you supply a Postgres URL + LLM key.</dd></div>
				<div class="hs-row"><dt>Existing external Hindsight</dt><dd>You run the whole deployment; Bobbit is a client of your API URL.</dd></div>
				<div class="hs-row"><dt>Hermes-local / embedded</dt><dd>Hermes runs Hindsight for you (e.g. ${k}); Bobbit just connects.</dd></div>
			</dl>
		</div>`,ae=()=>i`
		<div class="hs-subcard" data-testid="hindsight-defaults-explainer">
			<span class="hs-label">Recommended defaults</span>
			<dl class="hs-rows">
				<div class="hs-row"><dt>Data locality</dt><dd>Local / private — your memory stays on your machine unless you point at a shared deployment.</dd></div>
				<div class="hs-row"><dt>Bank</dt><dd><code>bobbit</code> (shared, tag-scoped). Use an existing bank like <code>hermes</code> only when connecting to one.</dd></div>
				<div class="hs-row"><dt>Namespace</dt><dd><code>default</code> unless your Hindsight uses namespaces.</dd></div>
				<div class="hs-row"><dt>Auto-retain</dt><dd>On (async) — memories are saved in the background after each turn; no latency cost.</dd></div>
				<div class="hs-row"><dt>Auto-recall</dt><dd>On — relevant memories are pulled in automatically.</dd></div>
				<div class="hs-row"><dt>Recall scope</dt><dd><code>all</code> — search across everything you've done.</dd></div>
				<div class="hs-row"><dt>Timeout</dt><dd><code>1500 ms</code> — conservative; Hindsight calls never stall a turn.</dd></div>
				<div class="hs-row"><dt>LLM key (managed)</dt><dd>You supply it — Bobbit forwards it to the local runtime only; never hardcodes a provider secret.</dd></div>
			</dl>
		</div>`,se=e=>{let s=e.setupProgress;if(!s)return d;let a=(r,t)=>i`
			<li class="hs-progress-row" data-state=${t}>
				<span class="hs-progress-icon" aria-hidden="true">${t==="ok"?"\u2713":t==="fail"?"\u2717":t==="running"?"\u2026":"\u2022"}</span>
				<span>${r}</span>
				<span class="hs-progress-state">${t}</span>
			</li>`;return i`
			<ul class="hs-progress" data-testid="hindsight-setup-progress">
				${a("Connection (health probe)",s.connection)}
				${a("Recall smoke test",s.recall)}
			</ul>
			<p class="hs-hint">Auto-retain happens on your next turn — Bobbit never writes a memory unsolicited.</p>`},re=(e,s,a)=>{let r=e.draft||y(null);return i`
			<section class="hs-card" data-testid="hindsight-setup">
				<div class="hs-card-head">
					<h2 class="hs-card-title">Set up Hindsight</h2>
					${e.configured?i`<button class="hs-btn" data-testid="hindsight-setup-close" type="button" @click=${()=>{let t=u(a);t&&(t.setupOpen=!1,p(s))}}>Hide guide</button>`:d}
				</div>
				<p class="hs-muted">Pick how Hindsight runs. Selecting a managed option only sets the mode — nothing starts until you press <strong>Start runtime</strong>.</p>
				<div class="hs-deploy-grid">
					${ee.map(t=>i`
						<button
							class="hs-deploy-card"
							data-testid=${`hindsight-deploy-${t.preset}`}
							type="button"
							aria-pressed=${r.mode===t.mode?"true":"false"}
							data-selected=${r.mode===t.mode?"true":"false"}
							@click=${()=>Y(s,a,t.preset)}
						>
							<span class="hs-deploy-title">${t.title}</span>
							<span class="hs-deploy-meta"><strong>Bobbit:</strong> ${t.bobbit}</span>
							<span class="hs-deploy-meta"><strong>You:</strong> ${t.you}</span>
							<span class="hs-deploy-note">${t.note}</span>
						</button>`)}
				</div>
				${te()}
				${ae()}
				<div class="hs-card-actions">
					<button class="hs-btn" data-testid="hindsight-setup-test" type="button" ?disabled=${e.setupTesting} @click=${()=>G(s,a)}>${e.setupTesting?"Testing\u2026":"Test connection"}</button>
				</div>
				${se(e)}
			</section>`},oe=e=>{let s=e.status||{},a=s.runtimeStatus,r=e.runtimePhase,t=!!s.healthy,o=(g,m)=>g?"ok":m?"running":"pending",n=r==="starting"||a==="starting"||a==="running"||t,l=a==="running"||a===void 0&&t,h=r==="error",f=(g,m)=>i`
			<li class="hs-progress-row" data-state=${m}>
				<span class="hs-progress-icon" aria-hidden="true">${m==="ok"?"\u2713":m==="fail"?"\u2717":m==="running"?"\u2026":"\u2022"}</span>
				<span>${g}</span>
				<span class="hs-progress-state">${m}</span>
			</li>`;return r==="idle"&&!n&&!h?d:i`
			<ul class="hs-progress" data-testid="hindsight-runtime-progress">
				${f("Start runtime",h?"fail":o(n&&(l||a==="starting"),r==="starting"))}
				${f("Health check",h?"fail":o(l,n&&!l))}
				${f("Running",l?"ok":"pending")}
			</ul>
			${e.runtimeError?i`<p class="hs-error" data-testid="hindsight-runtime-error">${c(e.runtimeError)}</p>`:d}`},ne=(e,s,a)=>{let r=e.draft||y(null),t=e.status||{},o=t.runtimeStatus,n=o==="running"||o==="unhealthy"||o==="starting"||t.healthy||e.runtimePhase==="starting",l=X(e),h=!e.configured||e.dirty||!l||!e.managedConsentAck||e.runtimePhase==="starting",f=r.mode==="managed-external-postgres";return i`
			<section class="hs-card" data-testid="hindsight-managed-card">
				<div class="hs-card-head"><h2 class="hs-card-title">Managed runtime</h2></div>
				<div class="hs-consent" data-testid="hindsight-managed-consent">
					<span class="hs-label">Before you start</span>
					<p class="hs-muted">Pressing <strong>Start runtime</strong> launches local <strong>Docker</strong> containers — the Hindsight API${f?"":" + a Postgres database"} on loopback ports. The first start may pull an image and take ~1–2 min. Nothing runs until you press Start; Stop keeps your data.</p>
					<ul class="hs-checklist">
						<li data-ok=${l?"true":"false"}>${l?"\u2713":"\u2022"} Required inputs: LLM API key${f?" + external Postgres URL":""} ${l?"present (saved)":"missing \u2014 set them in Configuration and Save"}</li>
						<li data-ok=${e.configured&&!e.dirty?"true":"false"}>${e.configured&&!e.dirty?"\u2713":"\u2022"} Configuration saved ${e.configured?e.dirty?"\u2014 unsaved changes; Save before starting":"":"\u2014 Save first"}</li>
					</ul>
					${e.dirty?i`<p class="hs-hint" data-testid="hindsight-managed-save-first">Save your changes before starting — Start uses the saved configuration, not your unsaved edits.</p>`:d}
					<label class="hs-toggle">
						<input type="checkbox" data-testid="hindsight-managed-consent-ack" .checked=${!!e.managedConsentAck} @change=${g=>{let m=u(a);m&&(m.managedConsentAck=g.currentTarget.checked,p(s))}} />
						<span>I understand this starts local Docker containers.</span>
					</label>
				</div>
				<div class="hs-card-actions">
					<button class="hs-btn hs-btn-primary" data-testid="hindsight-start-runtime" type="button" ?disabled=${h} @click=${()=>M(s,a,"start")}>${e.runtimePhase==="starting"?"Starting\u2026":"Start runtime (starts Docker)"}</button>
					<button class="hs-btn" data-testid="hindsight-stop-runtime" type="button" ?disabled=${!n||e.runtimePhase==="stopping"} @click=${()=>M(s,a,"stop")}>${e.runtimePhase==="stopping"?"Stopping\u2026":"Stop runtime"}</button>
				</div>
				${oe(e)}
			</section>`},ie=(e,s,a)=>{let r=e.draft||y(null),t=r.mode,o=g=>b(s,a,"mode",g.currentTarget.value),n=c(r.externalUrl,"").trim(),l=t==="external"&&n?i`<span class="hs-hint" data-testid="hindsight-url-validity" data-valid=${T(n)?"true":"false"}>${T(n)?"\u2713 Looks like a valid URL":"\u2717 Must be an http(s) URL"}</span>`:d,h=c(r.uiUrl,"").trim(),f=h?i`<span class="hs-hint" data-testid="hindsight-ui-url-validity" data-valid=${T(h)?"true":"false"}>${T(h)?"\u2713 Looks like a valid URL":"\u2717 Must be an http(s) URL"}</span>`:d;return i`
			<section class="hs-card" data-testid="hindsight-config-card">
				<div class="hs-card-head">
					<h2 class="hs-card-title">Configuration</h2>
					<button class="hs-btn hs-btn-primary" data-testid="hindsight-save" type="button" ?disabled=${e.saving} @click=${()=>z(s,a)}>${e.saving?"Saving\u2026":"Save"}</button>
				</div>

				${e.dirty?i`<div class="hs-banner" data-testid="hindsight-unsaved">
							<span>You have unsaved changes. Save persists them; Discard reverts to the stored config.</span>
							<button class="hs-btn" data-testid="hindsight-discard" type="button" @click=${()=>j(s,a)}>Discard</button>
						</div>`:d}

				<label class="hs-field">
					<span class="hs-label">Deployment mode</span>
					<select class="hs-input" data-testid="hindsight-mode" .value=${t} @change=${o}>
						<option value="external" ?selected=${t==="external"}>External (operator-supplied URL)</option>
						<option value="managed" ?selected=${t==="managed"}>Managed (Bobbit-run, managed Postgres)</option>
						<option value="managed-external-postgres" ?selected=${t==="managed-external-postgres"}>Managed + external Postgres</option>
					</select>
				</label>

				${t==="external"?x("API / data-plane URL","hindsight-external-url",r.externalUrl,g=>b(s,a,"externalUrl",g.currentTarget.value),{placeholder:k,hint:`API / data-plane URL Bobbit calls to recall & retain (e.g. ${k}). Activates external mode; empty keeps it dormant.`,validity:l}):d}

				${x("Dashboard UI URL","hindsight-ui-url",r.uiUrl,g=>b(s,a,"uiUrl",g.currentTarget.value),{placeholder:R,hint:`Optional human dashboard opened by "Open Hindsight UI" \u2014 never called by Bobbit (e.g. ${R}).`,validity:f})}

				${v(t)?x("Managed data dir","hindsight-data-dir",r.dataDir,g=>b(s,a,"dataDir",g.currentTarget.value),{placeholder:"~/.hindsight",hint:t==="managed"?"Host bind-mount path for managed Postgres data.":""}):d}

				${t==="managed-external-postgres"?P("External Postgres URL","hindsight-external-db-url","externalDatabaseUrl",e,s,a,{hint:"\u2192 runtime HINDSIGHT_API_DATABASE_URL. Required to start."}):d}

				${v(t)?P("LLM API key","hindsight-llm-api-key","llmApiKey",e,s,a,{hint:"\u2192 runtime HINDSIGHT_API_LLM_API_KEY. Required to start."}):d}

				${P("API key","hindsight-api-key","apiKey",e,s,a,{hint:"Optional bearer token for the Hindsight API."})}

				<div class="hs-grid2">
					${x("Bank","hindsight-bank",r.bank,g=>b(s,a,"bank",g.currentTarget.value),{placeholder:"bobbit"})}
					${x("Namespace","hindsight-namespace",r.namespace,g=>b(s,a,"namespace",g.currentTarget.value),{placeholder:"default"})}
				</div>

				<label class="hs-field">
					<span class="hs-label">Recall scope</span>
					<select class="hs-input" data-testid="hindsight-recall-scope" .value=${r.recallScope} @change=${g=>b(s,a,"recallScope",g.currentTarget.value)}>
						<option value="all" ?selected=${r.recallScope==="all"}>All</option>
						<option value="project" ?selected=${r.recallScope==="project"}>This project</option>
					</select>
				</label>

				<div class="hs-toggles">
					${D("Auto recall","hindsight-auto-recall",r.autoRecall,g=>b(s,a,"autoRecall",g.currentTarget.checked))}
					${D("Auto retain","hindsight-auto-retain",r.autoRetain,g=>b(s,a,"autoRetain",g.currentTarget.checked))}
				</div>

				<div class="hs-grid2">
					${x("Recall budget (tokens)","hindsight-recall-budget",r.recallBudget,g=>b(s,a,"recallBudget",g.currentTarget.value),{type:"number"})}
					${x("Timeout (ms)","hindsight-timeout",r.timeoutMs,g=>b(s,a,"timeoutMs",g.currentTarget.value),{type:"number"})}
				</div>

				${e.saveErrors&&e.saveErrors.length?i`<ul class="hs-errors" data-testid="hindsight-config-error">${e.saveErrors.map(g=>i`<li>${c(g)}</li>`)}</ul>`:d}
			</section>`},de=(e,s)=>{let a=c(e&&e.text,""),r=e&&typeof e.score=="number",t=e&&e.id!=null?String(e.id):"";return i`
			<li class="hs-memory" data-testid="hindsight-memory-result" data-memory-id=${t}>
				<div class="hs-memory-text">${a}</div>
				<div class="hs-memory-meta">
					${r?i`<span class="hs-chip">score ${Number(e.score).toFixed(2)}</span>`:d}
					${t?i`<span class="hs-memory-id">${t}</span>`:d}
				</div>
			</li>`},le=(e,s,a)=>{let r=o=>{o&&o.preventDefault(),F(s,a)},t=e.searchScope||e.config&&e.config.recallScope||"all";return i`
			<section class="hs-card" data-testid="hindsight-search-card">
				<h2 class="hs-card-title">Search memory</h2>
				<form class="hs-search-row" @submit=${r}>
					<input
						class="hs-input"
						data-testid="hindsight-search-input"
						type="text"
						placeholder="Search recalled memories…"
						.value=${c(e.searchQuery,"")}
						@input=${o=>{let n=u(a);n&&(n.searchQuery=o.currentTarget.value)}}
					/>
					<select class="hs-input hs-scope" data-testid="hindsight-search-scope" .value=${t} @change=${o=>{let n=u(a);n&&(n.searchScope=o.currentTarget.value,p(s))}}>
						<option value="all" ?selected=${t==="all"}>All</option>
						<option value="project" ?selected=${t==="project"}>This project</option>
					</select>
					<button class="hs-btn hs-btn-primary" data-testid="hindsight-search-submit" type="submit" ?disabled=${e.searchState==="searching"}>${e.searchState==="searching"?"Searching\u2026":"Search"}</button>
				</form>
				${ce(e)}
			</section>`},ce=e=>e.searchState==="searching"?i`<p class="hs-muted" data-testid="hindsight-search-loading">Searching…</p>`:e.searchState==="error"?i`<p class="hs-error" data-testid="hindsight-search-error">${c(e.searchError,"Search failed")}</p>`:e.searchState==="empty"?e.searchDormant?i`<p class="hs-muted" data-testid="hindsight-search-empty">Configure Hindsight to search memory.</p>`:i`<p class="hs-muted" data-testid="hindsight-search-empty">No memories matched.</p>`:e.searchState==="results"?i`<ul class="hs-memories">${e.searchResults.map((s,a)=>de(s,a))}</ul>`:d,I=i`<style>
		.hs-root { color: var(--foreground); background: var(--background); padding: 16px; min-height: 100%; box-sizing: border-box; display: flex; flex-direction: column; gap: 16px; font-size: 13px; }
		.hs-root h1 { font-size: 16px; margin: 0; }
		.hs-root h2 { font-size: 14px; margin: 0; }
		.hs-root code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: color-mix(in oklch, var(--muted-foreground) 12%, transparent); padding: 0 4px; border-radius: 4px; }
		.hs-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
		.hs-card { border: 1px solid var(--border); border-radius: 10px; background: var(--card); padding: 14px; display: flex; flex-direction: column; gap: 12px; }
		.hs-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
		.hs-card-title { color: var(--foreground); }
		.hs-card-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
		.hs-rows { display: grid; grid-template-columns: 1fr; gap: 6px; margin: 0; }
		.hs-row { display: flex; justify-content: space-between; gap: 12px; }
		.hs-row dt { color: var(--muted-foreground); flex: 0 0 auto; }
		.hs-row dd { margin: 0; color: var(--foreground); text-align: right; }
		.hs-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
		.hs-field { display: flex; flex-direction: column; gap: 4px; }
		.hs-label { color: var(--muted-foreground); font-size: 12px; }
		.hs-hint { color: var(--muted-foreground); font-size: 11px; }
		.hs-hint[data-valid="true"] { color: var(--positive); }
		.hs-hint[data-valid="false"] { color: var(--negative); }
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
		.hs-badge[data-state="connected"], .hs-badge[data-state="running"] { color: var(--positive); border-color: color-mix(in oklch, var(--positive) 45%, transparent); background: color-mix(in oklch, var(--positive) 14%, transparent); }
		.hs-badge[data-state="unreachable"], .hs-badge[data-state="unhealthy"] { color: var(--negative); border-color: color-mix(in oklch, var(--negative) 45%, transparent); background: color-mix(in oklch, var(--negative) 14%, transparent); }
		.hs-badge[data-state="starting"] { color: var(--warning); border-color: color-mix(in oklch, var(--warning) 45%, transparent); background: color-mix(in oklch, var(--warning) 14%, transparent); }
		.hs-chips { display: flex; gap: 8px; flex-wrap: wrap; }
		.hs-chip { display: inline-flex; align-items: center; padding: 2px 9px; border-radius: 999px; font-size: 12px; border: 1px solid var(--border); background: color-mix(in oklch, var(--chart-1) 10%, transparent); color: var(--foreground); }
		.hs-chip-muted { background: color-mix(in oklch, var(--muted-foreground) 10%, transparent); color: var(--muted-foreground); }
		.hs-chip-btn { cursor: pointer; font: inherit; }
		.hs-chip-btn:hover:not(:disabled) { border-color: var(--primary); color: var(--foreground); }
		.hs-open-ui { color: var(--primary); text-decoration: none; }
		.hs-open-ui:hover { text-decoration: underline; }
		.hs-banner { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; border-radius: 8px; border: 1px solid color-mix(in oklch, var(--warning) 45%, transparent); background: color-mix(in oklch, var(--warning) 12%, transparent); color: var(--foreground); font-size: 12px; }
		.hs-subcard { border: 1px solid var(--border); border-radius: 8px; background: var(--background); padding: 10px; display: flex; flex-direction: column; gap: 8px; }
		.hs-deploy-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
		.hs-deploy-card { text-align: left; display: flex; flex-direction: column; gap: 4px; border: 1px solid var(--border); border-radius: 8px; background: var(--background); color: var(--foreground); padding: 10px; cursor: pointer; font: inherit; }
		.hs-deploy-card:hover { border-color: var(--primary); }
		.hs-deploy-card[data-selected="true"] { border-color: var(--primary); background: color-mix(in oklch, var(--primary) 10%, transparent); }
		.hs-deploy-title { font-weight: 600; }
		.hs-deploy-meta { color: var(--muted-foreground); font-size: 11px; }
		.hs-deploy-note { color: var(--muted-foreground); font-size: 11px; font-style: italic; }
		.hs-consent { border: 1px solid color-mix(in oklch, var(--warning) 40%, transparent); border-radius: 8px; background: color-mix(in oklch, var(--warning) 8%, transparent); padding: 10px; display: flex; flex-direction: column; gap: 8px; }
		.hs-checklist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
		.hs-checklist li[data-ok="true"] { color: var(--positive); }
		.hs-checklist li[data-ok="false"] { color: var(--muted-foreground); }
		.hs-progress { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
		.hs-progress-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted-foreground); }
		.hs-progress-row[data-state="ok"] { color: var(--positive); }
		.hs-progress-row[data-state="fail"] { color: var(--negative); }
		.hs-progress-row[data-state="running"] { color: var(--warning); }
		.hs-progress-icon { width: 14px; display: inline-flex; justify-content: center; }
		.hs-progress-state { margin-left: auto; font-variant-numeric: tabular-nums; opacity: 0.8; }
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
		@media (max-width: 520px) { .hs-deploy-grid { grid-template-columns: 1fr; } }
	</style>`;return{render(e,s){let a=e&&e.__sessionId||"hindsight-default";if(!!!(s&&s.capabilities&&s.capabilities.callRoute&&typeof s.callRoute=="function"))return i`${I}<div class="hs-root" data-testid="hindsight-panel" data-state="unavailable"><p class="hs-muted">Hindsight memory is unavailable on this host.</p></div>`;let t=u(a);t||(t=ge(),_.set(a,t)),t.mountKicked||(t.mountKicked=!0,E(s,a),S(s,a));let o=t.configState==="loading"&&!t.draft,n=t.draft&&t.draft.mode||"external",l=!t.configured||t.setupOpen;return i`
				${I}
				<div class="hs-root" data-testid="hindsight-panel" data-config-state=${t.configState} data-status-state=${t.statusState}>
					<div class="hs-head">
						<h1>Hindsight Memory</h1>
						${t.configured&&!t.setupOpen?i`<button class="hs-btn" data-testid="hindsight-setup-toggle" type="button" @click=${()=>{let h=u(a);h&&(h.setupOpen=!0,p(s))}}>Setup guide</button>`:d}
					</div>
					${J(t,s,a)}
					${t.configState==="error"?i`<section class="hs-card"><p class="hs-error" data-testid="hindsight-config-load-error">${c(t.configError,"Config unavailable")}</p></section>`:o?i`<section class="hs-card"><p class="hs-muted" data-testid="hindsight-config-loading">Loading configuration…</p></section>`:i`
								${l?re(t,s,a):d}
								${ie(t,s,a)}
								${v(n)?ne(t,s,a):d}`}
					${le(t,s,a)}
				</div>`}}}export{pe as default};
