var ze=["cost.totalUsd","cost.tokensTotal","cost.cacheHitRate","gates.passRate","gates.firstPassClean","tasks.completionRate","time.wallClockMs","objective.value","command.metric"],Ee={"cost.totalUsd":"lower-better","cost.tokensTotal":"lower-better","cost.cacheHitRate":"higher-better","gates.passRate":"higher-better","gates.firstPassClean":"higher-better","tasks.completionRate":"higher-better","time.wallClockMs":"lower-better","objective.value":"higher-better","command.metric":"neutral"},Be=new Set(["cost.totalUsd","time.wallClockMs","gates.passRate","objective.value"]),Z=[{id:"comparison-table",label:"Comparison table"},{id:"score-bars",label:"Score bars"},{id:"objective-curve",label:"Objective curve"},{id:"ledger-table",label:"Ledger"},{id:"summary-cards",label:"Summary cards"},{id:"raw-drilldown",label:"Raw runs"}],je=["median","mean","p90","min","max","count"],C={exp:n=>`exp/${n}`,state:n=>`exp/${n}/state`,runPrefix:n=>`exp/${n}/run/`,ledger:n=>`exp/${n}/ledger`,dashboard:n=>`exp/${n}/dashboard`,metrics:n=>`exp/${n}/metrics`,index:"index/experiments",draft:n=>`drafts/${n}`},Oe="bobbit:experiment-runner:draft:",f=n=>Array.isArray(n)?n:[],b=(n,l="")=>n==null?l:String(n),v=n=>{let l=Number(n);return Number.isFinite(l)?l:void 0},D=n=>b(n,"exp").replace(/[^a-zA-Z0-9_-]+/g,"-").replace(/^-+|-+$/g,"")||"exp";function De(n){let l=b(n).trim();if(l==="")return"";if(/^-?\d+(\.\d+)?$/.test(l))return Number(l);if(l==="true")return!0;if(l==="false")return!1;if(l.startsWith("{")&&l.endsWith("}")||l.startsWith("[")&&l.endsWith("]"))try{return JSON.parse(l)}catch{}return l}function H(n){let l={};for(let h of f(n)){let m=b(h&&h.key).trim();m&&(l[m]=De(h&&h.value))}return l}function V(n){let l=b(n).trim();if(l)try{let h=JSON.parse(l);return h&&typeof h=="object"?h:void 0}catch{return}}var Ne=n=>{let l=n.filter(m=>Number.isFinite(m)).slice().sort((m,p)=>m-p);if(!l.length)return;let h=Math.floor(l.length/2);return l.length%2?l[h]:(l[h-1]+l[h])/2},Q=(n,l)=>{let h=n.filter(m=>Number.isFinite(m));if(l==="count")return h.length;if(h.length)switch(l){case"mean":return h.reduce((m,p)=>m+p,0)/h.length;case"min":return Math.min(...h);case"max":return Math.max(...h);case"p90":{let m=h.slice().sort((p,w)=>p-w);return m[Math.min(m.length-1,Math.floor(.9*m.length))]}default:return Ne(h)}},j=n=>{if(n==null||!Number.isFinite(n))return"\u2014";let l=Math.abs(n);return l!==0&&l<.01?n.toExponential(2):Number.isInteger(n)?String(n):n.toFixed(l>=100?1:3)},O=n=>n==null||!Number.isFinite(n)?"\u2014":`$${n.toFixed(2)}`;function F(){return[{key:"",value:""}]}function ee(){return ze.map(n=>({metric:n,source:"built-in",collect:Be.has(n),aggregation:"median",direction:Ee[n]||"neutral",primary:n==="gates.passRate"}))}function G(){return{view:"mode-select",mode:null,experimentId:void 0,basics:{name:"",runnableUnit:"command",body:"",workflowId:""},ab:{variants:[{label:"baseline",metadata:F(),rolesJson:"",rolesOpen:!1},{label:"variant-b",metadata:F(),rolesJson:"",rolesOpen:!1}],repeats:3,sameCompletionBar:!0,concurrency:3},auto:{objectiveMetric:"objective.value",direction:"maximize",correctnessGateId:"",seed:F(),seedRolesJson:"",caps:{maxIterations:"",wallClockHours:"",costUsd:"",perIterBudget:""},stops:{plateauK:"",target:""},strategy:"greedy",batchSize:""},metrics:ee(),perRunBudget:"",confirmAck:!1}}var R=globalThis.__bobbitExperimentRunnerState||(globalThis.__bobbitExperimentRunnerState=new Map);function Ue(n){let l=[],h=n.basics||{};b(h.name).trim()||l.push("Name is required"),b(h.body).trim()||l.push("Spec / command body is required");let m=f(n.ab&&n.ab.variants);m.length<2&&l.push("A/B needs at least two variants");let p=new Set,w=[];m.forEach((k,M)=>{let L=b(k.label).trim();L?p.has(L)&&l.push(`Variant label "${L}" is duplicated`):l.push(`Variant ${M+1} needs a label`),p.add(L),w.push(JSON.stringify({m:H(k.metadata),r:V(k.rolesJson)||null}))});for(let k=0;k<w.length;k++)for(let M=k+1;M<w.length;M++)w[k]===w[M]&&l.push(`Variant "${b(m[M].label).trim()||M+1}" is identical to "${b(m[k].label).trim()||k+1}"`);let I=v(n.ab&&n.ab.repeats);(!I||I<1)&&l.push("Repeats must be \u2265 1");let z=v(n.perRunBudget);(!z||z<=0)&&l.push("Set a per-run budget");let E=v(n.ab&&n.ab.concurrency);E!=null&&(E<1||E>8)&&l.push("Concurrency must be 1\u20138"),f(n.metrics).some(k=>k.collect)||l.push("Select at least one metric");let B=m.length*(I||0),U=z?B*z:void 0;return{valid:l.length===0,errors:l,runCount:B,estCostMax:U}}function Le(n){let l=[],h=[],m=n.basics||{};b(m.name).trim()||l.push("Name is required"),b(m.body).trim()||l.push("Spec / command body is required");let p=n.auto||{};b(p.objectiveMetric).trim()||l.push("Choose an objective metric");let w=v(p.caps&&p.caps.perIterBudget);(!w||w<=0)&&l.push("Set a per-iteration budget");let I=p.caps||{},z=v(I.maxIterations)>0||v(I.wallClockHours)>0||v(I.costUsd)>0,E=p.stops||{},B=v(E.plateauK)>0||E.target!==""&&Number.isFinite(v(E.target));z||h.push("Set at least one hard cap (max-iterations, wall-clock, or cost)"),B||h.push("Set at least one stop condition (plateau-K or target)"),n.confirmAck||h.push("Acknowledge the autonomous-run warning");let U=v(I.maxIterations),k=v(I.costUsd),M;return w&&U&&(M=U*w),k!=null&&(M=M==null?k:Math.min(M,k)),{valid:l.length===0&&h.length===0,errors:l,checklist:h,estCostMax:M,hasCap:z,hasStop:B}}function K(n){return n.mode==="autoresearch"?Le(n):Ue(n)}function Pe(n){let l=n.basics||{},h=f(n.metrics).filter(p=>p.collect).map(p=>({metric:p.metric,aggregation:p.aggregation,direction:p.direction,primary:!!p.primary})),m={experimentId:n.experimentId,title:b(l.name).trim(),mode:n.mode==="autoresearch"?"autoresearch":"ab",runnable:{kind:l.runnableUnit==="goal"?"goal":"command",body:b(l.body)},workflowId:b(l.workflowId).trim()||void 0,metrics:h};if(m.mode==="ab"){let p=n.ab||{};m.variants=f(p.variants).map((w,I)=>({armId:D(b(w.label).trim()||`arm-${I}`),label:b(w.label).trim()||`arm-${I}`,metadata:H(w.metadata),inlineRoles:V(w.rolesJson)})),m.repeats=v(p.repeats)||1,m.sameCompletionBar=p.sameCompletionBar!==!1,m.maxConcurrency=v(p.concurrency)||3,m.perRunBudget=v(n.perRunBudget)}else{let p=n.auto||{};m.objective={metric:p.objectiveMetric,direction:p.direction==="minimize"?"minimize":"maximize"},m.correctnessGateId=b(p.correctnessGateId).trim()||void 0,m.seed={metadata:H(p.seed),inlineRoles:V(p.seedRolesJson)},m.caps={maxIterations:v(p.caps&&p.caps.maxIterations),wallClockMs:v(p.caps&&p.caps.wallClockHours)?v(p.caps.wallClockHours)*36e5:void 0,maxCostUsd:v(p.caps&&p.caps.costUsd),perRunBudget:v(p.caps&&p.caps.perIterBudget)},m.stop={plateauK:v(p.stops&&p.stops.plateauK),target:v(p.stops&&p.stops.target)},m.strategy=p.strategy==="best-of-batch"?"best-of-batch":"greedy",m.batchSize=v(p.batchSize),m.perRunBudget=v(p.caps&&p.caps.perIterBudget)}return m}function Fe({html:n,nothing:l,renderHeader:h}){let m=async(e,t,a)=>{try{return!e||!e.capabilities||!e.capabilities.callRoute||!e.callRoute?{ok:!1,error:"routes-unavailable"}:{ok:!0,data:await e.callRoute(t,a)}}catch(r){return{ok:!1,error:r&&r.message?String(r.message):String(r)}}},p=async(e,t)=>{try{return e&&e.store&&e.store.get?await e.store.get(t):null}catch{return null}},w=async(e,t,a)=>{try{e&&e.store&&e.store.put&&await e.store.put(t,a)}catch{}},I=async(e,t)=>{try{return e&&e.store&&e.store.list?await e.store.list(t)||[]:[]}catch{return[]}},z=e=>{try{e&&e.requestRender&&e.requestRender()}catch{}},E=(e,t)=>{try{e&&e.capabilities&&e.capabilities.ui&&e.ui&&e.ui.navigate&&e.ui.navigate({route:"experiment-runner",params:t})}catch{}},B=e=>`${Oe}${D(e)}`,U=e=>{try{let t=globalThis.localStorage&&globalThis.localStorage.getItem(B(e));return t?JSON.parse(t):void 0}catch{return}},k=(e,t)=>{try{globalThis.localStorage&&globalThis.localStorage.setItem(B(e),JSON.stringify(t))}catch{}},M=e=>R.get(e),L=(e,t,a)=>{R.set(t,a),z(e)},A=(e,t,a)=>{let s={...R.get(t)||{},...a};return R.set(t,s),z(e),s},T=(e,t,a)=>{let r=R.get(t)||{},s={...r.draft||G()};a(s);let i={...r,draft:s};R.set(t,i),k(t,s),w(r.host,C.draft(t),s),z(e)};function te(e,t,a,r){let s=R.get(t);return s&&s.hydrated?(s.host=e,a&&s.draft&&s.draft.experimentId!==a&&re(e,t,a,r),s):(s={hydrated:!1,host:e,draft:U(t)||G(),dashboard:null,experiments:[]},R.set(t,s),(async()=>{let i=await p(e,C.draft(t)),c=R.get(t)||s,d=i&&typeof i=="object"?i:c.draft;a&&(d={...d,experimentId:a,view:r||"dashboard"}),R.set(t,{...c,hydrated:!0,draft:d}),z(e),ae(e,t),d.experimentId&&d.view==="dashboard"&&N(e,t,d.experimentId)})(),R.get(t))}async function ae(e,t){let a=await m(e,"listExperiments",{method:"GET"}),r=[];if(a.ok&&a.data&&Array.isArray(a.data.experiments))r=a.data.experiments;else{let s=await p(e,C.index);s&&Array.isArray(s.experiments)&&(r=s.experiments)}A(e,t,{experiments:r})}async function re(e,t,a,r){T(e,t,s=>{s.experimentId=a,s.view=r||"dashboard"}),await N(e,t,a)}async function N(e,t,a){A(e,t,{dashboardLoading:!0});let r,s,i=[],c=[],d,o,u=await m(e,"getExperiment",{method:"GET",query:{experimentId:a}});if(u.ok&&u.data&&u.data.def&&(r=u.data.def,s=u.data.state,i=f(u.data.runs),c=f(u.data.ledger),d=u.data.dashboard,o=u.data.metrics),!r){r=await p(e,C.exp(a)),s=await p(e,C.state(a)),c=f(await p(e,C.ledger(a))),d=await p(e,C.dashboard(a)),o=await p(e,C.metrics(a));let x=await I(e,C.runPrefix(a));for(let y of x){let S=await p(e,y);S&&typeof S=="object"&&i.push(S)}}if(d==null&&(d=await p(e,C.dashboard(a))),!f(o).length){let x=await p(e,C.metrics(a));f(x).length&&(o=x)}if(s&&s.status==="running"){let x=await m(e,"poll",{method:"POST",body:{experimentId:a}});x.ok&&x.data&&Array.isArray(x.data.runs)&&(i=x.data.runs)}let g=await m(e,"report",{method:"POST",body:{experimentId:a}}),$=g.ok&&g.data?g.data:null;A(e,t,{dashboardLoading:!1,dashboard:{experimentId:a,def:r,state:s,runs:i,ledger:c,spec:d,metrics:f(o).length?o:r&&r.metrics||[],report:$}})}async function ne(e,t){let r=R.get(t).draft;A(e,t,{launching:!0,launchError:void 0});let s=Pe(r),i=await m(e,"defineExperiment",{method:"POST",body:{definition:s}}),c=r.experimentId;i.ok&&i.data&&i.data.experimentId&&(c=i.data.experimentId),c||(c=`${D(s.title)}-${Date.now().toString(36)}`),s.experimentId=c,await w(e,C.exp(c),s),await w(e,C.metrics(c),s.metrics),await se(e,t,{experimentId:c,title:s.title,mode:s.mode,status:"running"});let d=await m(e,"launch",{method:"POST",body:{experimentId:c}});if(!d.ok&&d.error!=="routes-unavailable"){A(e,t,{launching:!1,launchError:d.error});return}T(e,t,o=>{o.experimentId=c,o.view="dashboard"}),A(e,t,{launching:!1}),E(e,{experimentId:c,view:"dashboard"}),await N(e,t,c),s.mode==="autoresearch"&&await m(e,"iterate",{method:"POST",body:{experimentId:c}})}async function se(e,t,a){let r=await p(e,C.index)||{experiments:[]},s=f(r.experiments).filter(i=>i.experimentId!==a.experimentId);s.push(a),await w(e,C.index,{experiments:s}),A(e,t,{experiments:s})}async function ie(e,t,a){await m(e,"cancel",{method:"POST",body:{experimentId:a}}),await N(e,t,a)}async function oe(e,t,a,r){await m(e,"saveMetrics",{method:"POST",body:{experimentId:a,metrics:r}}),await w(e,C.metrics(a),r),await N(e,t,a)}async function ce(e,t,a,r){await m(e,"saveDashboard",{method:"POST",body:{experimentId:a,dashboard:r}}),await w(e,C.dashboard(a),r),A(e,t,{dashboardEditing:!1}),await N(e,t,a)}let _=(e,t,a)=>T(e,t,r=>{r.view=a});function de(e,t,a){let r=s=>T(e,t,i=>{i.mode=s,i.view="define"});return n`
			<div class="exp-view" data-testid="experiment-runner-view-mode-select">
				<h1 class="exp-h1">New experiment</h1>
				<p class="exp-sub">Pick how you want to run it. A/B is the safe, bounded default; Autoresearch is an opt-in autonomous loop.</p>
				<div class="exp-mode-grid">
					<button
						class="exp-mode-card recommended"
						data-testid="experiment-runner-mode-ab"
						type="button"
						autofocus
						@click=${()=>r("ab")}
					>
						<span class="exp-eyebrow">Recommended · bounded cost</span>
						<span class="exp-mode-title">A/B comparison</span>
						<span class="exp-mode-desc">Run a fixed set of variants × repeats, aggregate, and compare. Cost is projected before launch.</span>
					</button>
					<button
						class="exp-mode-card danger"
						data-testid="experiment-runner-mode-autoresearch"
						type="button"
						@click=${()=>r("autoresearch")}
					>
						<span class="exp-eyebrow warn">Autonomous · opt-in · hard caps required</span>
						<span class="exp-mode-title">Autoresearch</span>
						<span class="exp-mode-desc">Propose → evaluate → keep-best loop. Runs unattended until a cap or stop condition fires. Off by default.</span>
					</button>
				</div>
			</div>
		`}function le(e,t,a){let r=a.basics||{},s=(i,c)=>T(e,t,d=>{d.basics={...d.basics,[i]:c}});return n`
			<section class="exp-card" data-testid="experiment-runner-basics">
				<h2 class="exp-h2">Experiment basics</h2>
				<label class="exp-label">Experiment name
					<input class="exp-input" data-testid="experiment-runner-name" type="text" maxlength="80"
						placeholder="e.g. retry-temperature-sweep" .value=${b(r.name)}
						@input=${i=>s("name",i.currentTarget.value)} />
				</label>
				<div class="exp-label">Runnable unit
					<div class="exp-radio-row" role="radiogroup" aria-label="Runnable unit">
						<label class="exp-radio"><input type="radio" name="exp-runnable-${D(t)}" data-testid="experiment-runner-runnable-goal"
							?checked=${r.runnableUnit==="goal"} @change=${()=>s("runnableUnit","goal")} /> Goal spec</label>
						<label class="exp-radio"><input type="radio" name="exp-runnable-${D(t)}" data-testid="experiment-runner-runnable-command"
							?checked=${r.runnableUnit!=="goal"} @change=${()=>s("runnableUnit","command")} /> Command</label>
					</div>
				</div>
				<label class="exp-label">${r.runnableUnit==="goal"?"Goal spec":"Command"} body
					<textarea class="exp-input exp-mono" data-testid="experiment-runner-body" rows="4"
						placeholder=${r.runnableUnit==="goal"?"A goal spec template\u2026":'A shell command emitting { "metric": <name>, "value": <n> } on stdout\u2026'}
						.value=${b(r.body)} @input=${i=>s("body",i.currentTarget.value)}></textarea>
				</label>
				<label class="exp-label">Workflow (optional)
					<input class="exp-input" data-testid="experiment-runner-workflow" type="text"
						placeholder="workflow id (optional)" .value=${b(r.workflowId)}
						@input=${i=>s("workflowId",i.currentTarget.value)} />
				</label>
			</section>
		`}function W(e,t,a,r,s){let i=c=>r(c.length?c:F());return n`
			<div class="exp-kv" data-testid=${s}>
				${f(a).map((c,d)=>n`
					<div class="exp-kv-row">
						<input class="exp-input exp-kv-key" type="text" placeholder="key" .value=${b(c.key)}
							@input=${o=>{let u=a.slice();u[d]={...c,key:o.currentTarget.value},i(u)}} />
						<input class="exp-input exp-kv-val" type="text" placeholder="value" .value=${b(c.value)}
							@input=${o=>{let u=a.slice();u[d]={...c,value:o.currentTarget.value},i(u)}} />
						<button class="exp-icon-btn" type="button" title="Remove" aria-label="Remove key"
							@click=${()=>{let o=a.slice();o.splice(d,1),i(o)}}>✕</button>
					</div>`)}
				<button class="exp-btn secondary tiny" type="button" @click=${()=>i([...f(a),{key:"",value:""}])}>+ Add key</button>
			</div>
		`}function pe(e,t,a){let r=f(a.metrics),s=(i,c)=>T(e,t,d=>{let o=f(d.metrics).slice();c.primary&&o.forEach((u,g)=>{o[g]={...u,primary:g===i}}),o[i]={...o[i],...c},d.metrics=o});return n`
			<section class="exp-card" data-testid="experiment-runner-metrics">
				<h2 class="exp-h2">Metrics</h2>
				<p class="exp-hint">What to collect for every run — editable later without a re-run.</p>
				<table class="exp-table">
					<thead><tr><th>Collect</th><th>Metric</th><th>Aggregation</th><th>Direction</th><th>Primary</th></tr></thead>
					<tbody>
						${r.map((i,c)=>n`<tr data-testid="experiment-runner-metric-row" data-metric=${i.metric}>
							<td><input type="checkbox" data-testid="experiment-runner-metric-collect" data-metric=${i.metric}
								?checked=${!!i.collect} @change=${d=>s(c,{collect:d.currentTarget.checked})} /></td>
							<td><span class="exp-mono">${i.metric}</span> <span class="exp-badge">${i.source||"built-in"}</span></td>
							<td><select class="exp-input" ?disabled=${!i.collect} @change=${d=>s(c,{aggregation:d.currentTarget.value})}>
								${je.map(d=>n`<option value=${d} ?selected=${i.aggregation===d}>${d}</option>`)}
							</select></td>
							<td><select class="exp-input" ?disabled=${!i.collect} @change=${d=>s(c,{direction:d.currentTarget.value})}>
								${["higher-better","lower-better","neutral"].map(d=>n`<option value=${d} ?selected=${i.direction===d}>${d}</option>`)}
							</select></td>
							<td><input type="radio" name="exp-primary-${D(t)}" data-testid="experiment-runner-metric-primary" data-metric=${i.metric}
								?checked=${!!i.primary} ?disabled=${!i.collect} @change=${()=>s(c,{primary:!0})} /></td>
						</tr>`)}
					</tbody>
				</table>
			</section>
		`}function ue(e,t,a){let r=a.ab||{},s=f(r.variants),i=g=>T(e,t,$=>{$.ab={...$.ab,...g}}),c=(g,$)=>T(e,t,x=>{let y=f(x.ab.variants).slice();y[g]={...y[g],...$},x.ab={...x.ab,variants:y}}),d=g=>T(e,t,$=>{let x=f($.ab.variants).slice();x.splice(g,1),$.ab={...$.ab,variants:x}}),o=g=>T(e,t,$=>{let x=f($.ab.variants).slice(),y=g!=null?x[g]:null;x.push({label:`variant-${x.length+1}`,metadata:y?y.metadata.map(S=>({...S})):F(),rolesJson:y?y.rolesJson:"",rolesOpen:!1}),$.ab={...$.ab,variants:x}}),u=v(r.repeats);return n`
			<section class="exp-card" data-testid="experiment-runner-ab-form">
				<h2 class="exp-h2">Variants</h2>
				${s.map((g,$)=>n`
					<div class="exp-variant" data-testid="experiment-runner-variant-row" data-variant-index=${$}>
						<div class="exp-variant-head">
							<input class="exp-input" type="text" data-testid="experiment-runner-variant-label" placeholder="variant label"
								.value=${b(g.label)} @input=${x=>c($,{label:x.currentTarget.value})} />
							<button class="exp-btn secondary tiny" type="button" @click=${()=>o($)}>Duplicate</button>
							<button class="exp-btn secondary tiny" type="button" data-testid="experiment-runner-remove-variant"
								?disabled=${s.length<=2}
								title=${s.length<=2?"A/B needs at least two variants":"Remove variant"}
								@click=${()=>d($)}>Remove</button>
						</div>
						<div class="exp-field-label">Metadata treatment</div>
						${W(e,t,g.metadata,x=>c($,{metadata:x}),"experiment-runner-variant-metadata")}
						<details class="exp-details" ?open=${g.rolesOpen}>
							<summary @click=${()=>c($,{rolesOpen:!g.rolesOpen})}>Advanced: per-arm roles</summary>
							<textarea class="exp-input exp-mono" rows="3" placeholder='{"coder": {"model": "…"}}'
								.value=${b(g.rolesJson)} @input=${x=>c($,{rolesJson:x.currentTarget.value})}></textarea>
						</details>
					</div>`)}
				<button class="exp-btn secondary" type="button" data-testid="experiment-runner-add-variant" @click=${()=>o(null)}>+ Add variant</button>

				<div class="exp-grid2">
					<label class="exp-label">Repeats per variant
						<input class="exp-input" type="number" min="1" max="20" data-testid="experiment-runner-repeats"
							.value=${b(r.repeats)} @input=${g=>i({repeats:g.currentTarget.value})} />
						${u>10?n`<span class="exp-warn-hint">high run count</span>`:l}
					</label>
					<label class="exp-label">Concurrency cap
						<input class="exp-input" type="number" min="1" max="8" data-testid="experiment-runner-concurrency"
							.value=${b(r.concurrency)} @input=${g=>i({concurrency:g.currentTarget.value})} />
					</label>
				</div>
				<label class="exp-checkbox"><input type="checkbox" data-testid="experiment-runner-same-bar"
					?checked=${r.sameCompletionBar!==!1} @change=${g=>i({sameCompletionBar:g.currentTarget.checked})} />
					Only aggregate runs that reached the same completion bar</label>
				<label class="exp-label">Per-run budget (USD, the fixed comparable budget)
					<input class="exp-input" type="number" min="0" step="0.5" data-testid="experiment-runner-per-run-budget"
						placeholder="e.g. 0.80" .value=${b(a.perRunBudget)}
						@input=${g=>T(e,t,$=>{$.perRunBudget=g.currentTarget.value})} />
				</label>
			</section>
		`}function xe(e,t,a){let r=a.auto||{},s=o=>T(e,t,u=>{u.auto={...u.auto,...o}}),i=o=>T(e,t,u=>{u.auto={...u.auto,caps:{...u.auto.caps,...o}}}),c=o=>T(e,t,u=>{u.auto={...u.auto,stops:{...u.auto.stops,...o}}}),d=f(a.metrics).map(o=>o.metric);return n`
			<div class="exp-warn-banner" data-testid="experiment-runner-autoresearch-banner">
				Autonomous optimization — runs unattended until a cap or stop condition is hit. Candidates failing verification are rejected even if the objective improves.
			</div>
			<section class="exp-card" data-testid="experiment-runner-auto-objective">
				<h2 class="exp-h2">Objective</h2>
				<div class="exp-grid2">
					<label class="exp-label">Objective metric
						<select class="exp-input" data-testid="experiment-runner-objective-metric" @change=${o=>s({objectiveMetric:o.currentTarget.value})}>
							${d.map(o=>n`<option value=${o} ?selected=${r.objectiveMetric===o}>${o}</option>`)}
						</select>
					</label>
					<div class="exp-label">Direction
						<div class="exp-radio-row" role="radiogroup" aria-label="Objective direction">
							<label class="exp-radio"><input type="radio" name="exp-dir-${D(t)}" data-testid="experiment-runner-direction-maximize"
								?checked=${r.direction!=="minimize"} @change=${()=>s({direction:"maximize"})} /> maximize</label>
							<label class="exp-radio"><input type="radio" name="exp-dir-${D(t)}" data-testid="experiment-runner-direction-minimize"
								?checked=${r.direction==="minimize"} @change=${()=>s({direction:"minimize"})} /> minimize</label>
						</div>
					</div>
				</div>
				<label class="exp-label">Correctness gate (optional workflow gate)
					<input class="exp-input" type="text" data-testid="experiment-runner-correctness-gate" placeholder="review-findings gate id (optional)"
						.value=${b(r.correctnessGateId)} @input=${o=>s({correctnessGateId:o.currentTarget.value})} />
					<span class="exp-hint">Candidates failing verification are rejected even if the objective improves.</span>
				</label>
				<div class="exp-field-label">Search seed (iteration-0 candidate)</div>
				${W(e,t,r.seed,o=>s({seed:o}),"experiment-runner-seed-metadata")}
			</section>

			<section class="exp-card" data-testid="experiment-runner-auto-caps">
				<h2 class="exp-h2">Caps <span class="exp-req">— at least one required</span></h2>
				<div class="exp-grid2">
					<label class="exp-label">Max iterations
						<input class="exp-input" type="number" min="1" data-testid="experiment-runner-cap-max-iterations"
							.value=${b(r.caps.maxIterations)} @input=${o=>i({maxIterations:o.currentTarget.value})} />
					</label>
					<label class="exp-label">Wall-clock cap (hours)
						<input class="exp-input" type="number" min="0" step="0.5" data-testid="experiment-runner-cap-wallclock"
							.value=${b(r.caps.wallClockHours)} @input=${o=>i({wallClockHours:o.currentTarget.value})} />
					</label>
					<label class="exp-label">Cost cap (USD)
						<input class="exp-input" type="number" min="0" step="1" data-testid="experiment-runner-cap-cost"
							.value=${b(r.caps.costUsd)} @input=${o=>i({costUsd:o.currentTarget.value})} />
					</label>
					<label class="exp-label">Per-iteration budget (USD, required)
						<input class="exp-input" type="number" min="0" step="0.5" data-testid="experiment-runner-per-iter-budget"
							.value=${b(r.caps.perIterBudget)} @input=${o=>i({perIterBudget:o.currentTarget.value})} />
					</label>
				</div>
			</section>

			<section class="exp-card" data-testid="experiment-runner-auto-stops">
				<h2 class="exp-h2">Stop conditions <span class="exp-req">— at least one required</span></h2>
				<div class="exp-grid2">
					<label class="exp-label">Plateau over K iterations
						<input class="exp-input" type="number" min="1" data-testid="experiment-runner-stop-plateau"
							.value=${b(r.stops.plateauK)} @input=${o=>c({plateauK:o.currentTarget.value})} />
					</label>
					<label class="exp-label">Target value
						<input class="exp-input" type="number" step="any" data-testid="experiment-runner-stop-target"
							.value=${b(r.stops.target)} @input=${o=>c({target:o.currentTarget.value})} />
					</label>
				</div>
				<details class="exp-details">
					<summary>Advanced: search strategy</summary>
					<div class="exp-grid2">
						<label class="exp-label">Strategy
							<select class="exp-input" @change=${o=>s({strategy:o.currentTarget.value})}>
								<option value="greedy" ?selected=${r.strategy!=="best-of-batch"}>greedy</option>
								<option value="best-of-batch" ?selected=${r.strategy==="best-of-batch"}>best-of-batch</option>
							</select>
						</label>
						<label class="exp-label">Batch size
							<input class="exp-input" type="number" min="1" max="8" .value=${b(r.batchSize)}
								@input=${o=>s({batchSize:o.currentTarget.value})} />
						</label>
					</div>
				</details>
			</section>
		`}function be(e,t,a,r){if(a.mode==="autoresearch"){let s=f(r.checklist);return n`
				<footer class="exp-projection" data-testid="experiment-runner-projection">
					<div class="exp-proj-stats">
						<span data-testid="experiment-runner-cost">${r.estCostMax!=null?`\u2264 ${O(r.estCostMax)}`:"cost unbounded by iterations"}</span>
						${r.hasStop?n`<span class="exp-pos">stop set</span>`:l}
					</div>
					${s.length?n`<ul class="exp-checklist" data-testid="experiment-runner-guardrail-checklist">
						${s.map(i=>n`<li class="exp-neg">✗ ${i}</li>`)}
					</ul>`:l}
					${f(r.errors).length?n`<ul class="exp-checklist" data-testid="experiment-runner-error">
						${r.errors.map(i=>n`<li class="exp-neg">✗ ${i}</li>`)}
					</ul>`:l}
					<label class="exp-checkbox danger"><input type="checkbox" data-testid="experiment-runner-confirm-ack"
						?checked=${!!a.confirmAck} @change=${i=>T(e,t,c=>{c.confirmAck=i.currentTarget.checked})} />
						I understand this runs autonomously and may cost ${r.estCostMax!=null?`up to ${O(r.estCostMax)}`:"an unbounded amount until a cap is hit"}.</label>
					<button class="exp-btn primary" type="button" data-testid="experiment-runner-review-launch" ?disabled=${!r.valid}
						title=${r.valid?"Review & launch":"Set caps + stop condition + acknowledge"}
						@click=${()=>_(e,t,"confirm")}>Review &amp; launch →</button>
				</footer>
			`}return n`
			<footer class="exp-projection" data-testid="experiment-runner-projection">
				<div class="exp-proj-stats">
					<span data-testid="experiment-runner-run-count">${f(a.ab&&a.ab.variants).length} variants × ${v(a.ab&&a.ab.repeats)||0} repeats = ${r.runCount} runs</span>
					<span data-testid="experiment-runner-cost">${r.estCostMax!=null?`est. \u2264 ${O(r.estCostMax)}`:"est. \u2014 set a per-run budget"}</span>
					<span>~${v(a.ab&&a.ab.concurrency)||1} concurrent</span>
				</div>
				${f(r.errors).length?n`<ul class="exp-checklist" data-testid="experiment-runner-error">
					${r.errors.map(s=>n`<li class="exp-neg">✗ ${s}</li>`)}
				</ul>`:l}
				<button class="exp-btn primary" type="button" data-testid="experiment-runner-review-launch" ?disabled=${!r.valid}
					title=${r.valid?"Review & launch":f(r.errors)[0]||"Complete the form"}
					@click=${()=>_(e,t,"confirm")}>Review &amp; launch →</button>
			</footer>
		`}function me(e,t,a){let r=K(a);return n`
			<div class="exp-view exp-define" data-testid="experiment-runner-view-define" data-mode=${a.mode||"ab"}>
				<div class="exp-define-head">
					<button class="exp-btn link" type="button" @click=${()=>_(e,t,"mode-select")}>← mode</button>
					<span class="exp-mode-badge ${a.mode==="autoresearch"?"warn":""}">${a.mode==="autoresearch"?"AUTORESEARCH":"A/B"}</span>
				</div>
				${le(e,t,a)}
				${a.mode==="autoresearch"?xe(e,t,a):ue(e,t,a)}
				${pe(e,t,a)}
				${be(e,t,a,r)}
			</div>
		`}function ge(e,t,a){let r=K(a),s=a.mode==="autoresearch",i=R.get(t)||{};return n`
			<div class="exp-view" data-testid="experiment-runner-view-confirm">
				<h1 class="exp-h1">Confirm launch</h1>
				<section class="exp-card">
					<div class="exp-confirm-row"><span>Mode</span><strong>${s?"Autoresearch":"A/B comparison"}</strong></div>
					<div class="exp-confirm-row"><span>Name</span><strong>${b(a.basics&&a.basics.name)}</strong></div>
					${s?n`
							<div class="exp-confirm-row"><span>Objective</span><strong>${b(a.auto&&a.auto.objectiveMetric)} (${b(a.auto&&a.auto.direction)})</strong></div>
							<div class="exp-confirm-row"><span>Caps</span><strong>${b(v(a.auto.caps.maxIterations)?`\u2264 ${v(a.auto.caps.maxIterations)} iters`:"")} ${v(a.auto.caps.wallClockHours)?`\u2264 ${v(a.auto.caps.wallClockHours)}h`:""} ${v(a.auto.caps.costUsd)?`\u2264 ${O(v(a.auto.caps.costUsd))}`:""}</strong></div>
							<div class="exp-confirm-row"><span>Worst-case cost</span><strong>${r.estCostMax!=null?`\u2264 ${O(r.estCostMax)}`:"unbounded by iterations"}</strong></div>
							<div class="exp-confirm-note">A candidate that fails verification is discarded even if its objective improved.</div>`:n`
							<div class="exp-confirm-row"><span>Fan-out</span><strong>${r.runCount} child goals (${f(a.ab.variants).length} variants × ${v(a.ab.repeats)} repeats)</strong></div>
							<div class="exp-confirm-row"><span>Projected cost</span><strong>${r.estCostMax!=null?`\u2264 ${O(r.estCostMax)}`:"\u2014"}</strong></div>`}
				</section>
				${i.launchError?n`<div class="exp-error-box" data-testid="experiment-runner-launch-error">${i.launchError}</div>`:l}
				<div class="exp-confirm-actions">
					<button class="exp-btn secondary" type="button" @click=${()=>_(e,t,"define")}>← Back</button>
					<button class="exp-btn primary" type="button" data-testid="experiment-runner-launch" ?disabled=${!r.valid||i.launching}
						@click=${()=>ne(e,t)}>${i.launching?"Launching\u2026":s?`Launch loop (\u2264 ${r.estCostMax!=null?O(r.estCostMax):"capped"})`:`Launch ${r.runCount} runs`}</button>
				</div>
			</div>
		`}function X(e){let t=e&&Array.isArray(e.spec)?e.spec:e&&e.spec&&Array.isArray(e.spec.widgets)?e.spec.widgets:null;return t&&t.length?t:e&&e.def&&e.def.mode==="autoresearch"?[{type:"summary-cards",title:"Summary"},{type:"objective-curve",title:"Best objective vs iteration"},{type:"ledger-table",title:"Ledger"},{type:"raw-drilldown",title:"Iterations"}]:[{type:"summary-cards",title:"Summary"},{type:"comparison-table",title:"Comparison"},{type:"score-bars",title:"Secondary metrics"},{type:"raw-drilldown",title:"Runs"}]}function J(e){let a=f(e&&e.metrics).filter(r=>r.collect!==!1).map(r=>r.metric);return a.length?a:["objective.value","cost.totalUsd","time.wallClockMs"]}function fe(e){let a=f(e&&e.metrics).find(r=>r.primary);return a?a.metric:e&&e.def&&e.def.objective?e.def.objective.metric:J(e)[0]}let P=(e,t)=>{let a=e&&e.metrics,r=a?a[t]:void 0;return Number.isFinite(Number(r))?Number(r):r&&Number.isFinite(Number(r.value))?Number(r.value):void 0};function Y(e){let t=new Map;for(let a of f(e&&e.runs)){let r=b(a.armId,"arm");t.has(r)||t.set(r,[]),t.get(r).push(a)}return t}function ve(e,t){let a=J(t),r=!(t.def&&t.def.sameCompletionBar===!1),s=Y(t),i=f(t.metrics),c=d=>(i.find(o=>o.metric===d)||{}).aggregation||"median";return n`<table class="exp-table" data-testid="experiment-runner-widget-comparison-table">
			<thead><tr><th>Variant</th>${a.map(d=>n`<th class="exp-mono">${d}</th>`)}<th>n</th></tr></thead>
			<tbody>
				${[...s.entries()].map(([d,o])=>{let u=r?o.filter($=>$.completionBar==="passed"):o,g=u.length?u:o;return n`<tr data-testid="experiment-runner-comparison-arm" data-arm=${d}>
						<td><strong>${d}</strong></td>
						${a.map($=>n`<td class="exp-mono">${j(Q(g.map(x=>P(x,$)),c($)))}</td>`)}
						<td>${g.length}</td>
					</tr>`})}
			</tbody>
		</table>`}function he(e,t){let a=J(t),r=Y(t);return n`<div class="exp-scorebars" data-testid="experiment-runner-widget-score-bars">
			${a.map((s,i)=>{let c=[...r.entries()].map(([o,u])=>({arm:o,v:Q(u.map(g=>P(g,s)),"median")})),d=Math.max(1,...c.map(o=>Number.isFinite(o.v)?Math.abs(o.v):0));return n`<div class="exp-scorebar-group"><div class="exp-field-label exp-mono">${s}</div>
					${c.map(o=>n`<div class="exp-scorebar-row"><span class="exp-scorebar-label">${o.arm}</span>
						<span class="exp-scorebar-track"><span class="exp-scorebar-fill" style=${`width:${Math.round((Number.isFinite(o.v)?Math.abs(o.v):0)/d*100)}%;background:var(--chart-${i%6+1})`}></span></span>
						<span class="exp-mono">${j(o.v)}</span></div>`)}
				</div>`})}
		</div>`}function $e(e,t){let a=fe(t),r=t.def&&t.def.objective&&t.def.objective.direction||"maximize",s=f(t.runs).filter(o=>o.iteration!=null).sort((o,u)=>o.iteration-u.iteration),i=null,c=s.map(o=>{let u=P(o,a);return Number.isFinite(u)&&(i=i==null?u:r==="minimize"?Math.min(i,u):Math.max(i,u)),{iteration:o.iteration,v:u,best:i,kept:o.verified!==!1&&o.completionBar!=="failed"}}),d=v(t.def&&t.def.stop&&t.def.stop.target);return n`<div data-testid="experiment-runner-widget-objective-curve">
			${d!=null?n`<div class="exp-hint">target ${r==="minimize"?"\u2264":"\u2265"} ${j(d)}</div>`:l}
			<table class="exp-table"><thead><tr><th>Iter</th><th>objective</th><th>best</th><th>verdict</th></tr></thead>
				<tbody>${c.map(o=>n`<tr><td>${o.iteration}</td><td class="exp-mono">${j(o.v)}</td><td class="exp-mono exp-pos">${j(o.best)}</td><td>${o.kept?n`<span class="exp-pos">●</span>`:n`<span class="exp-neg">○</span>`}</td></tr>`)}</tbody>
			</table>
		</div>`}function ye(e,t){let a=f(t.ledger);return n`<table class="exp-table" data-testid="experiment-runner-widget-ledger-table">
			<thead><tr><th>Iter</th><th>verdict</th><th>objective</th><th>best</th></tr></thead>
			<tbody>${a.map(r=>{let s=b(r.verdict||r.decision,"\u2014"),i=/kept|accept/i.test(s)?"exp-pos":/verification|failed/i.test(s)?"exp-neg":"exp-muted";return n`<tr data-testid="experiment-runner-ledger-row"><td>${b(r.iteration)}</td><td class=${i}>${s}</td><td class="exp-mono">${j(v(r.objective))}</td><td class="exp-mono">${j(v(r.best))}</td></tr>`})}</tbody>
		</table>`}function we(e,t){let a=f(t.runs),r=a.filter(c=>["settled","collected","failed"].includes(c.status)).length,s=a.filter(c=>c.completionBar==="passed").length,i=a.reduce((c,d)=>c+(v(d.cost&&d.cost.totalUsd)||P(d,"cost.totalUsd")||0),0);return n`<div class="exp-cards" data-testid="experiment-runner-widget-summary-cards">
			<div class="exp-stat"><span class="exp-stat-n">${a.length}</span><span class="exp-stat-l">runs</span></div>
			<div class="exp-stat"><span class="exp-stat-n">${r}</span><span class="exp-stat-l">settled</span></div>
			<div class="exp-stat"><span class="exp-stat-n exp-pos">${s}</span><span class="exp-stat-l">passed bar</span></div>
			<div class="exp-stat"><span class="exp-stat-n">${O(i)}</span><span class="exp-stat-l">spend</span></div>
		</div>`}function ke(e,t){let a=J(t),r=f(t.runs);return n`<table class="exp-table" data-testid="experiment-runner-widget-raw-drilldown">
			<thead><tr><th>run</th><th>arm</th><th>${t.def&&t.def.mode==="autoresearch"?"iter":"rep"}</th><th>status</th><th>bar</th>${a.map(s=>n`<th class="exp-mono">${s}</th>`)}</tr></thead>
			<tbody>${r.map(s=>{let i=t.def&&t.def.sameCompletionBar!==!1&&s.completionBar&&s.completionBar!=="passed";return n`<tr class=${i?"exp-excluded":""} data-testid="experiment-runner-run-row" data-run=${b(s.runId)}>
					<td class="exp-mono">${b(s.runId)}</td><td>${b(s.armId)}</td>
					<td>${b(s.iteration!=null?s.iteration:s.repeat)}</td>
					<td>${b(s.status)}</td><td>${b(s.completionBar)}${i?n` <span class="exp-tag">excluded</span>`:l}</td>
					${a.map(c=>n`<td class="exp-mono">${j(P(s,c))}</td>`)}
				</tr>`})}</tbody>
		</table>`}let Se={"comparison-table":ve,"score-bars":he,"objective-curve":$e,"ledger-table":ye,"summary-cards":we,"raw-drilldown":ke};function Ce(e){try{let t=document.createElement("div");return t.setAttribute("data-testid","experiment-runner-report-html"),t.innerHTML=String(e),t}catch{return l}}function Te(e,t,a){if(a.report&&typeof a.report.html=="string"&&a.report.html.trim())return n`<div class="exp-dashboard-body" data-testid="experiment-runner-dashboard-body">${Ce(a.report.html)}</div>`;let r=X(a);return n`<div class="exp-dashboard-body" data-testid="experiment-runner-dashboard-body">
			${r.map(s=>{let i=Se[s.type];return n`<section class="exp-widget exp-card" data-testid="experiment-runner-widget" data-widget-type=${s.type}>
					<h3 class="exp-widget-title">${b(s.title,s.type)}</h3>
					${i?i(e,a):n`<div class="exp-hint">Unknown widget: ${s.type}</div>`}
				</section>`})}
		</div>`}function Re(e,t,a){let r=X(a).slice(),s=x=>A(e,t,{dashboardDraftSpec:x}),i=R.get(t)||{},c=i.dashboardDraftSpec||r,d=(x,y)=>{let S=c.slice(),q=x+y;q<0||q>=S.length||([S[x],S[q]]=[S[q],S[x]],s(S))},o=x=>{let y=c.slice();y.splice(x,1),s(y)},u=x=>s([...c,{type:x,title:(Z.find(y=>y.id===x)||{}).label||x}]),g=(x,y)=>{let S=c.slice();S[x]={...S[x],title:y},s(S)},$=i.widgetTypes&&i.widgetTypes.length?i.widgetTypes:Z;return n`<div class="exp-card" data-testid="experiment-runner-dashboard-editor">
			<h3 class="exp-h2">Edit dashboard</h3>
			${c.map((x,y)=>n`<div class="exp-editor-row" data-testid="experiment-runner-editor-widget" data-widget-type=${x.type}>
				<input class="exp-input" type="text" .value=${b(x.title)} @input=${S=>g(y,S.currentTarget.value)} />
				<span class="exp-badge exp-mono">${x.type}</span>
				<button class="exp-icon-btn" type="button" title="Move up" @click=${()=>d(y,-1)}>↑</button>
				<button class="exp-icon-btn" type="button" title="Move down" @click=${()=>d(y,1)}>↓</button>
				<button class="exp-icon-btn" type="button" title="Remove" @click=${()=>o(y)}>✕</button>
			</div>`)}
			<div class="exp-editor-add">
				<select class="exp-input" data-testid="experiment-runner-add-widget-type">
					${$.map(x=>n`<option value=${x.id}>${x.label||x.id}</option>`)}
				</select>
				<button class="exp-btn secondary" type="button" data-testid="experiment-runner-add-widget"
					@click=${x=>{let y=x.currentTarget.parentElement.querySelector("select");u(y.value)}}>+ Add widget</button>
			</div>
			<div class="exp-confirm-actions">
				<button class="exp-btn secondary" type="button" @click=${()=>A(e,t,{dashboardEditing:!1,dashboardDraftSpec:void 0})}>Cancel</button>
				<button class="exp-btn primary" type="button" data-testid="experiment-runner-save-dashboard"
					@click=${()=>{A(e,t,{dashboardDraftSpec:void 0}),ce(e,t,a.experimentId,c)}}>Save dashboard</button>
			</div>
		</div>`}function Ie(e,t,a){let r=R.get(t)||{},s=r.dashboard,i=()=>A(e,t,{dashboard:null})&&T(e,t,y=>{Object.assign(y,G())});if(r.dashboardLoading&&!s)return n`<div class="exp-view" data-testid="experiment-runner-view-dashboard"><div class="exp-hint">Loading experiment…</div></div>`;if(!s)return n`<div class="exp-view" data-testid="experiment-runner-view-dashboard">
				<div class="exp-empty">No experiment loaded.</div>
				<button class="exp-btn primary" type="button" data-testid="experiment-runner-new-experiment" @click=${i}>New experiment</button>
			</div>`;let c=s.def||{},d=s.state||{},o=c.mode==="autoresearch",u=b(d.status,"running"),g=f(s.runs),$=g.filter(y=>["settled","collected","failed"].includes(y.status)).length,x=d.stopReason?`stopped: ${d.stopReason}`:u;return n`
			<div class="exp-view" data-testid="experiment-runner-view-dashboard" data-experiment-id=${s.experimentId}>
				<header class="exp-dash-head">
					<div class="exp-dash-titles">
						<span class="exp-mode-badge ${o?"warn":""}">${o?"AUTORESEARCH":"A/B"}</span>
						<h1 class="exp-h1">${b(c.title,s.experimentId)}</h1>
					</div>
					<div class="exp-dash-meta">
						<span class="exp-status" data-testid="experiment-runner-status" role="status">${u==="running"?`running ${$}/${g.length}`:x}</span>
					</div>
					<div class="exp-dash-actions">
						${u==="running"?n`<button class="exp-btn secondary" type="button" data-testid="experiment-runner-stop" @click=${()=>ie(e,t,s.experimentId)}>Stop experiment</button>`:l}
						<button class="exp-btn secondary" type="button" data-testid="experiment-runner-refresh" @click=${()=>N(e,t,s.experimentId)}>Refresh</button>
						<button class="exp-btn secondary" type="button" data-testid="experiment-runner-edit-dashboard"
							@click=${()=>A(e,t,{dashboardEditing:!r.dashboardEditing,dashboardDraftSpec:void 0})}>${r.dashboardEditing?"Close editor":"Edit dashboard"}</button>
						<button class="exp-btn link" type="button" data-testid="experiment-runner-new-experiment" @click=${i}>New experiment</button>
					</div>
				</header>
				${r.dashboardEditing?Re(e,t,s):l}
				<details class="exp-details" data-testid="experiment-runner-metrics-panel">
					<summary>Metrics — edit what is collected (re-extracts from stored outcomes, no re-run)</summary>
					${Me(e,t,s)}
				</details>
				${Te(e,t,s)}
			</div>
		`}function Me(e,t,a){let r=f(a.metrics).length?f(a.metrics):ee(),s=(i,c)=>{let d=r.map((o,u)=>u===i?{...o,collect:c}:o);A(e,t,{dashboard:{...a,metrics:d}}),oe(e,t,a.experimentId,d)};return n`<table class="exp-table">
			<thead><tr><th>Collect</th><th>Metric</th></tr></thead>
			<tbody>${r.map((i,c)=>n`<tr><td><input type="checkbox" data-testid="experiment-runner-dash-metric-collect" data-metric=${i.metric}
				?checked=${i.collect!==!1} @change=${d=>s(c,d.currentTarget.checked)} /></td><td class="exp-mono">${i.metric}</td></tr>`)}</tbody>
		</table>`}let Ae=`
		.exp-root{display:flex;flex-direction:column;height:100%;overflow:auto;background:var(--background);color:var(--foreground);font-size:13px;}
		.exp-view{padding:16px;display:flex;flex-direction:column;gap:14px;}
		.exp-h1{font-size:18px;font-weight:600;margin:0;}
		.exp-h2{font-size:14px;font-weight:600;margin:0 0 8px;}
		.exp-sub,.exp-hint,.exp-empty{color:var(--muted-foreground);font-size:12px;margin:0;}
		.exp-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px;}
		.exp-mode-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
		.exp-mode-card{display:flex;flex-direction:column;gap:6px;text-align:left;padding:16px;border-radius:12px;border:1px solid var(--border);background:var(--card);color:var(--foreground);cursor:pointer;}
		.exp-mode-card.recommended{border-color:color-mix(in oklch, var(--primary) 50%, var(--border));}
		.exp-mode-card.danger{border-color:color-mix(in oklch, var(--warning) 45%, var(--border));}
		.exp-mode-card:hover{border-color:var(--primary);}
		.exp-mode-title{font-size:15px;font-weight:600;}
		.exp-mode-desc{font-size:12px;color:var(--muted-foreground);}
		.exp-eyebrow{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted-foreground);}
		.exp-eyebrow.warn,.exp-req{color:var(--warning);}
		.exp-label,.exp-field-label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted-foreground);}
		.exp-field-label{font-weight:600;}
		.exp-input{background:var(--background);color:var(--foreground);border:1px solid var(--border);border-radius:7px;padding:6px 8px;font-size:13px;font-family:inherit;}
		.exp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;}
		.exp-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
		.exp-radio-row{display:flex;gap:14px;align-items:center;color:var(--foreground);}
		.exp-radio,.exp-checkbox{display:flex;gap:6px;align-items:center;color:var(--foreground);font-size:12px;}
		.exp-checkbox.danger{color:var(--warning);}
		.exp-kv{display:flex;flex-direction:column;gap:6px;}
		.exp-kv-row{display:grid;grid-template-columns:1fr 1fr auto;gap:6px;}
		.exp-variant{border:1px dashed var(--border);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px;}
		.exp-variant-head{display:flex;gap:6px;align-items:center;}
		.exp-variant-head .exp-input{flex:1;}
		.exp-btn{border-radius:7px;padding:7px 12px;font-size:13px;cursor:pointer;border:1px solid var(--border);background:var(--card);color:var(--foreground);}
		.exp-btn.primary{background:var(--primary);color:var(--background);border-color:var(--primary);}
		.exp-btn.primary:disabled{opacity:.5;cursor:not-allowed;}
		.exp-btn.secondary{background:transparent;}
		.exp-btn.link{background:none;border:none;color:var(--muted-foreground);padding:4px;}
		.exp-btn.tiny{padding:3px 8px;font-size:11px;}
		.exp-icon-btn{background:transparent;border:1px solid var(--border);border-radius:6px;color:var(--muted-foreground);cursor:pointer;width:26px;height:26px;}
		.exp-projection{position:sticky;bottom:0;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;}
		.exp-proj-stats{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;}
		.exp-checklist{margin:0;padding-left:4px;list-style:none;display:flex;flex-direction:column;gap:3px;font-size:12px;}
		.exp-neg{color:var(--negative);}.exp-pos{color:var(--positive);}.exp-muted{color:var(--muted-foreground);}
		.exp-warn-hint,.exp-warn-banner{color:var(--warning);}
		.exp-warn-banner{background:color-mix(in oklch, var(--warning) 12%, transparent);border:1px solid color-mix(in oklch, var(--warning) 40%, var(--border));border-radius:8px;padding:10px;font-size:12px;}
		.exp-mode-badge{font-size:10px;font-weight:700;letter-spacing:.05em;padding:2px 7px;border-radius:999px;border:1px solid var(--border);color:var(--muted-foreground);}
		.exp-mode-badge.warn{color:var(--warning);border-color:color-mix(in oklch, var(--warning) 45%, var(--border));}
		.exp-define-head,.exp-dash-titles{display:flex;gap:10px;align-items:center;}
		.exp-table{width:100%;border-collapse:collapse;font-size:12px;}
		.exp-table th,.exp-table td{border-bottom:1px solid var(--border);padding:5px 6px;text-align:left;}
		.exp-table th{color:var(--muted-foreground);font-weight:600;}
		.exp-badge{font-size:10px;padding:1px 5px;border-radius:5px;border:1px solid var(--border);color:var(--muted-foreground);}
		.exp-details{border:1px solid var(--border);border-radius:8px;padding:8px;}
		.exp-details summary{cursor:pointer;font-size:12px;color:var(--muted-foreground);}
		.exp-confirm-row{display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px;}
		.exp-confirm-note,.exp-confirm-actions{margin-top:6px;}
		.exp-confirm-note{color:var(--warning);font-size:12px;}
		.exp-confirm-actions{display:flex;gap:10px;justify-content:flex-end;}
		.exp-error-box{color:var(--negative);border:1px solid var(--negative);border-radius:8px;padding:8px;font-size:12px;}
		.exp-dash-head{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;}
		.exp-dash-actions{display:flex;gap:6px;flex-wrap:wrap;}
		.exp-status{font-size:12px;color:var(--muted-foreground);}
		.exp-dashboard-body{display:flex;flex-direction:column;gap:12px;}
		.exp-widget-title{font-size:13px;font-weight:600;margin:0 0 8px;}
		.exp-cards{display:flex;gap:10px;flex-wrap:wrap;}
		.exp-stat{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:8px;padding:8px 12px;min-width:70px;}
		.exp-stat-n{font-size:18px;font-weight:700;}.exp-stat-l{font-size:11px;color:var(--muted-foreground);}
		.exp-scorebar-row{display:grid;grid-template-columns:90px 1fr 56px;gap:8px;align-items:center;margin:3px 0;}
		.exp-scorebar-track{background:color-mix(in oklch, var(--muted-foreground) 18%, transparent);border-radius:5px;height:10px;overflow:hidden;}
		.exp-scorebar-fill{display:block;height:100%;}
		.exp-excluded{opacity:.5;}
		.exp-tag{font-size:9px;border:1px solid var(--border);border-radius:4px;padding:0 3px;color:var(--muted-foreground);}
		.exp-editor-row{display:flex;gap:6px;align-items:center;margin:4px 0;}
		.exp-editor-row .exp-input{flex:1;}
		.exp-editor-add{display:flex;gap:6px;align-items:center;margin-top:8px;}
	`;return{render(e,t){let a=e&&typeof e.__sessionId=="string"?e.__sessionId:"",r=e&&typeof e.experimentId=="string"?e.experimentId:"",s=e&&typeof e.view=="string"?e.view:void 0,i=a||"experiment-runner",c=te(t,i,r,s),d=c&&c.draft||G(),o=d.view||"mode-select",u;return o==="dashboard"?u=Ie(t,i,d):o==="confirm"?u=ge(t,i,d):o==="define"?u=me(t,i,d):u=de(t,i,d),n`
				<style>${Ae}</style>
				<div class="exp-root" data-testid="experiment-runner-panel-root" data-view=${o} data-mode=${d.mode||""}>
					${u}
				</div>
			`}}}export{Fe as default};
