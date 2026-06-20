var je=["cost.totalUsd","cost.tokensTotal","cost.cacheHitRate","gates.passRate","gates.firstPassClean","tasks.completionRate","time.wallClockMs","objective.value","command.metric"],Be={"cost.totalUsd":"lower-better","cost.tokensTotal":"lower-better","cost.cacheHitRate":"higher-better","gates.passRate":"higher-better","gates.firstPassClean":"higher-better","tasks.completionRate":"higher-better","time.wallClockMs":"lower-better","objective.value":"higher-better","command.metric":"neutral"},Oe=new Set(["cost.totalUsd","time.wallClockMs","gates.passRate","objective.value"]),K=[{id:"comparison-table",label:"Comparison table"},{id:"score-bars",label:"Score bars"},{id:"objective-curve",label:"Objective curve"},{id:"ledger-table",label:"Ledger"},{id:"summary-cards",label:"Summary cards"},{id:"raw-drilldown",label:"Raw runs"}],De=["median","mean","p90","min","max","count"],T={exp:n=>`exp/${n}`,state:n=>`exp/${n}/state`,runPrefix:n=>`exp/${n}/run/`,ledger:n=>`exp/${n}/ledger`,dashboard:n=>`exp/${n}/dashboard`,metrics:n=>`exp/${n}/metrics`,index:"index/experiments",draft:n=>`drafts/${n}`},Ne="bobbit:experiment-runner:draft:",g=n=>Array.isArray(n)?n:[],x=(n,l="")=>n==null?l:String(n),h=n=>{let l=Number(n);return Number.isFinite(l)?l:void 0},D=n=>x(n,"exp").replace(/[^a-zA-Z0-9_-]+/g,"-").replace(/^-+|-+$/g,"")||"exp";function Ue(n){let l=x(n).trim();if(l==="")return"";if(/^-?\d+(\.\d+)?$/.test(l))return Number(l);if(l==="true")return!0;if(l==="false")return!1;if(l.startsWith("{")&&l.endsWith("}")||l.startsWith("[")&&l.endsWith("]"))try{return JSON.parse(l)}catch{}return l}function V(n){let l={};for(let $ of g(n)){let v=x($&&$.key).trim();v&&(l[v]=Ue($&&$.value))}return l}function W(n){let l=x(n).trim();if(l)try{let $=JSON.parse(l);return $&&typeof $=="object"?$:void 0}catch{return}}var Pe=n=>{let l=n.filter(v=>Number.isFinite(v)).slice().sort((v,k)=>v-k);if(!l.length)return;let $=Math.floor(l.length/2);return l.length%2?l[$]:(l[$-1]+l[$])/2},ee=(n,l)=>{let $=n.filter(v=>Number.isFinite(v));if(l==="count")return $.length;if($.length)switch(l){case"mean":return $.reduce((v,k)=>v+k,0)/$.length;case"min":return Math.min(...$);case"max":return Math.max(...$);case"p90":{let v=$.slice().sort((k,f)=>k-f);return v[Math.min(v.length-1,Math.floor(.9*v.length))]}default:return Pe($)}},B=n=>{if(n==null||!Number.isFinite(n))return"\u2014";let l=Math.abs(n);return l!==0&&l<.01?n.toExponential(2):Number.isInteger(n)?String(n):n.toFixed(l>=100?1:3)},O=n=>n==null||!Number.isFinite(n)?"\u2014":`$${n.toFixed(2)}`;function _(){return[{key:"",value:""}]}function ae(){return je.map(n=>({metric:n,source:"built-in",collect:Oe.has(n),aggregation:"median",direction:Be[n]||"neutral",primary:n==="gates.passRate"}))}function H(){return{view:"mode-select",mode:null,experimentId:void 0,basics:{name:"",runnableUnit:"command",body:"",workflowId:""},ab:{variants:[{label:"baseline",metadata:_(),rolesJson:"",rolesOpen:!1},{label:"variant-b",metadata:_(),rolesJson:"",rolesOpen:!1}],repeats:3,sameCompletionBar:!0,concurrency:3},auto:{objectiveMetric:"objective.value",direction:"maximize",correctnessGateId:"",seed:_(),seedRolesJson:"",caps:{maxIterations:"",wallClockHours:"",costUsd:"",perIterBudget:""},stops:{plateauK:"",target:""},strategy:"greedy",batchSize:""},metrics:ae(),perRunBudget:"",confirmAck:!1}}var M=globalThis.__bobbitExperimentRunnerState||(globalThis.__bobbitExperimentRunnerState=new Map);function Le(n){let l=[],$=n.basics||{};x($.name).trim()||l.push("Name is required"),x($.body).trim()||l.push("Spec / command body is required");let v=g(n.ab&&n.ab.variants);v.length<2&&l.push("A/B needs at least two variants");let k=new Set,f=[];v.forEach((S,z)=>{let P=x(S.label).trim();P?k.has(P)&&l.push(`Variant label "${P}" is duplicated`):l.push(`Variant ${z+1} needs a label`),k.add(P),f.push(JSON.stringify({m:V(S.metadata),r:W(S.rolesJson)||null}))});for(let S=0;S<f.length;S++)for(let z=S+1;z<f.length;z++)f[S]===f[z]&&l.push(`Variant "${x(v[z].label).trim()||z+1}" is identical to "${x(v[S].label).trim()||S+1}"`);let b=h(n.ab&&n.ab.repeats);(!b||b<1)&&l.push("Repeats must be \u2265 1");let C=h(n.perRunBudget);(!C||C<=0)&&l.push("Set a per-run budget");let A=h(n.ab&&n.ab.concurrency);A!=null&&(A<1||A>8)&&l.push("Concurrency must be 1\u20138"),g(n.metrics).some(S=>S.collect)||l.push("Select at least one metric");let j=v.length*(b||0),U=C?j*C:void 0;return{valid:l.length===0,errors:l,runCount:j,estCostMax:U}}function Fe(n){let l=[],$=[],v=n.basics||{};x(v.name).trim()||l.push("Name is required"),x(v.body).trim()||l.push("Spec / command body is required");let k=n.auto||{};x(k.objectiveMetric).trim()||l.push("Choose an objective metric");let f=h(k.caps&&k.caps.perIterBudget);(!f||f<=0)&&l.push("Set a per-iteration budget");let b=k.caps||{},C=h(b.maxIterations)>0||h(b.wallClockHours)>0||h(b.costUsd)>0,A=k.stops||{},j=h(A.plateauK)>0||A.target!==""&&Number.isFinite(h(A.target));C||$.push("Set at least one hard cap (max-iterations, wall-clock, or cost)"),j||$.push("Set at least one stop condition (plateau-K or target)"),n.confirmAck||$.push("Acknowledge the autonomous-run warning");let U=h(b.maxIterations),S=h(b.costUsd),z;return f&&U&&(z=U*f),S!=null&&(z=z==null?S:Math.min(z,S)),{valid:l.length===0&&$.length===0,errors:l,checklist:$,estCostMax:z,hasCap:C,hasStop:j}}function te(n){return n.mode==="autoresearch"?Fe(n):Le(n)}function _e(n){let l=n.basics||{},$=g(n.metrics).filter(b=>b.collect).map(b=>({metricId:b.metric,aggregation:b.aggregation,direction:b.direction,primary:!!b.primary})),k=l.runnableUnit==="command"?{kind:"command",command:x(l.body)}:{kind:"agent",spec:x(l.body)},f={experimentId:n.experimentId,title:x(l.name).trim(),mode:n.mode==="autoresearch"?"autoresearch":"ab",runnable:k,workflowId:x(l.workflowId).trim()||void 0,metrics:$};if(f.mode==="ab"){let b=n.ab||{};f.variants=g(b.variants).map((C,A)=>({armId:D(x(C.label).trim()||`arm-${A}`),label:x(C.label).trim()||`arm-${A}`,metadata:V(C.metadata),inlineRoles:W(C.rolesJson)})),f.repeats=h(b.repeats)||1,f.sameCompletionBar=b.sameCompletionBar!==!1,f.maxConcurrency=h(b.concurrency)||3,f.perRunBudget=h(n.perRunBudget)}else{let b=n.auto||{};f.objective={metricId:b.objectiveMetric,direction:b.direction==="minimize"?"min":"max"},f.correctnessGateId=x(b.correctnessGateId).trim()||void 0,f.seed={metadata:V(b.seed),inlineRoles:W(b.seedRolesJson)};let C=h(b.caps&&b.caps.wallClockHours);f.caps={maxIterations:h(b.caps&&b.caps.maxIterations),maxWallClockMs:C?C*36e5:void 0,maxCostUsd:h(b.caps&&b.caps.costUsd)};let A=h(b.stops&&b.stops.target);f.stop={plateauK:h(b.stops&&b.stops.plateauK)},A!=null&&(f.stop.target=A),f.strategy=b.strategy==="best-of-batch"?"best-of-batch":"greedy",f.batchSize=h(b.batchSize),f.perRunBudget=h(b.caps&&b.caps.perIterBudget)}return f}function Je({html:n,nothing:l,renderHeader:$}){let v=async(e,t,a)=>{try{return!e||!e.capabilities||!e.capabilities.callRoute||!e.callRoute?{ok:!1,error:"routes-unavailable"}:{ok:!0,data:await e.callRoute(t,a)}}catch(r){return{ok:!1,error:r&&r.message?String(r.message):String(r)}}},k=async(e,t)=>{try{return e&&e.store&&e.store.get?await e.store.get(t):null}catch{return null}},f=async(e,t,a)=>{try{e&&e.store&&e.store.put&&await e.store.put(t,a)}catch{}},b=async(e,t)=>{try{return e&&e.store&&e.store.list?await e.store.list(t)||[]:[]}catch{return[]}},C=e=>{try{e&&e.requestRender&&e.requestRender()}catch{}},A=(e,t)=>{try{e&&e.capabilities&&e.capabilities.ui&&e.ui&&e.ui.navigate&&e.ui.navigate({route:"experiment-runner",params:t})}catch{}},j=e=>`${Ne}${D(e)}`,U=e=>{try{let t=globalThis.localStorage&&globalThis.localStorage.getItem(j(e));return t?JSON.parse(t):void 0}catch{return}},S=(e,t)=>{try{globalThis.localStorage&&globalThis.localStorage.setItem(j(e),JSON.stringify(t))}catch{}},z=e=>M.get(e),P=(e,t,a)=>{M.set(t,a),C(e)},E=(e,t,a)=>{let s={...M.get(t)||{},...a};return M.set(t,s),C(e),s},R=(e,t,a)=>{let r=M.get(t)||{},s={...r.draft||H()};a(s);let i={...r,draft:s};M.set(t,i),S(t,s),f(r.host,T.draft(t),s),C(e)};function re(e,t,a,r){let s=M.get(t);return s&&s.hydrated?(s.host=e,a&&s.draft&&s.draft.experimentId!==a&&se(e,t,a,r),s):(s={hydrated:!1,host:e,draft:U(t)||H(),dashboard:null,experiments:[]},M.set(t,s),(async()=>{let i=await k(e,T.draft(t)),c=M.get(t)||s,d=i&&typeof i=="object"?i:c.draft;a&&(d={...d,experimentId:a,view:r||"dashboard"}),M.set(t,{...c,hydrated:!0,draft:d}),C(e),ne(e,t),d.experimentId&&d.view==="dashboard"&&N(e,t,d.experimentId)})(),M.get(t))}let X=e=>({experimentId:e.experimentId,title:x(e.title,e.experimentId),mode:e.mode==="autoresearch"?"autoresearch":"ab"});async function ne(e,t){let a=await v(e,"listExperiments",{method:"GET"}),r=[];if(a.ok&&Array.isArray(a.data))r=a.data.filter(s=>s&&typeof s=="object").map(X);else{let s=g(await k(e,T.index)).filter(c=>typeof c=="string");r=(await Promise.all(s.map(c=>k(e,T.exp(c))))).filter(c=>c&&typeof c=="object").map(X)}E(e,t,{experiments:r})}async function se(e,t,a,r){R(e,t,s=>{s.experimentId=a,s.view=r||"dashboard"}),await N(e,t,a)}async function N(e,t,a){E(e,t,{dashboardLoading:!0});let r,s,i=[],c=[],d,o,p=await v(e,"getExperiment",{method:"GET",query:{experimentId:a}});if(p.ok&&p.data&&p.data.def&&(r=p.data.def,s=p.data.state,i=g(p.data.runs),c=g(p.data.ledger),d=p.data.dashboard,o=p.data.metrics),!r){r=await k(e,T.exp(a)),s=await k(e,T.state(a)),c=g(await k(e,T.ledger(a))),d=await k(e,T.dashboard(a)),o=await k(e,T.metrics(a));let u=await b(e,T.runPrefix(a));for(let w of u){let I=await k(e,w);I&&typeof I=="object"&&i.push(I)}}if(d==null&&(d=await k(e,T.dashboard(a))),!g(o).length){let u=await k(e,T.metrics(a));g(u).length&&(o=u)}if(s&&s.status==="running"){let u=await v(e,"poll",{method:"POST",body:{experimentId:a}});u.ok&&u.data&&Array.isArray(u.data.runs)&&(i=u.data.runs)}let m=await v(e,"report",{method:"POST",body:{experimentId:a}}),y=m.ok&&m.data?m.data:null;E(e,t,{dashboardLoading:!1,dashboard:{experimentId:a,def:r,state:s,runs:i,ledger:c,spec:d,metrics:g(o).length?o:r&&r.metrics||[],report:y}})}async function ie(e,t){let r=M.get(t).draft;E(e,t,{launching:!0,launchError:void 0});let s=_e(r),i=await v(e,"defineExperiment",{method:"POST",body:s}),c=r.experimentId;i.ok&&i.data&&i.data.experimentId&&(c=i.data.experimentId),c||(c=`${D(s.title)}-${Date.now().toString(36)}`),s.experimentId=c,await f(e,T.exp(c),s),await f(e,T.metrics(c),s.metrics),await oe(e,t,{experimentId:c,title:s.title,mode:s.mode,status:"running"});let d=await v(e,"launch",{method:"POST",body:{experimentId:c}});if(!d.ok&&d.error!=="routes-unavailable"){E(e,t,{launching:!1,launchError:d.error});return}R(e,t,o=>{o.experimentId=c,o.view="dashboard"}),E(e,t,{launching:!1}),A(e,{experimentId:c,view:"dashboard"}),await N(e,t,c),s.mode==="autoresearch"&&await v(e,"iterate",{method:"POST",body:{experimentId:c}})}async function oe(e,t,a){let r=g(await k(e,T.index)).filter(c=>typeof c=="string"&&c!==a.experimentId);r.push(a.experimentId),await f(e,T.index,r);let s=M.get(t)||{},i=g(s.experiments).filter(c=>c.experimentId!==a.experimentId);i.push(a),E(e,t,{experiments:i})}async function ce(e,t,a){await v(e,"cancel",{method:"POST",body:{experimentId:a}}),await N(e,t,a)}async function de(e,t,a,r){await v(e,"saveMetrics",{method:"POST",body:{experimentId:a,metrics:r}}),await f(e,T.metrics(a),r),await N(e,t,a)}async function le(e,t,a,r){let s=Array.isArray(r)?{widgets:r}:r&&Array.isArray(r.widgets)?r:{widgets:[]};await v(e,"saveDashboard",{method:"POST",body:{experimentId:a,dashboard:s}}),await f(e,T.dashboard(a),s),E(e,t,{dashboardEditing:!1}),await N(e,t,a)}let J=(e,t,a)=>R(e,t,r=>{r.view=a});function pe(e,t,a){let r=s=>R(e,t,i=>{i.mode=s,i.view="define"});return n`
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
		`}function ue(e,t,a){let r=a.basics||{},s=(i,c)=>R(e,t,d=>{d.basics={...d.basics,[i]:c}});return n`
			<section class="exp-card" data-testid="experiment-runner-basics">
				<h2 class="exp-h2">Experiment basics</h2>
				<label class="exp-label">Experiment name
					<input class="exp-input" data-testid="experiment-runner-name" type="text" maxlength="80"
						placeholder="e.g. retry-temperature-sweep" .value=${x(r.name)}
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
						.value=${x(r.body)} @input=${i=>s("body",i.currentTarget.value)}></textarea>
				</label>
				<label class="exp-label">Workflow (optional)
					<input class="exp-input" data-testid="experiment-runner-workflow" type="text"
						placeholder="workflow id (optional)" .value=${x(r.workflowId)}
						@input=${i=>s("workflowId",i.currentTarget.value)} />
				</label>
			</section>
		`}function Y(e,t,a,r,s){let i=c=>r(c.length?c:_());return n`
			<div class="exp-kv" data-testid=${s}>
				${g(a).map((c,d)=>n`
					<div class="exp-kv-row">
						<input class="exp-input exp-kv-key" type="text" placeholder="key" .value=${x(c.key)}
							@input=${o=>{let p=a.slice();p[d]={...c,key:o.currentTarget.value},i(p)}} />
						<input class="exp-input exp-kv-val" type="text" placeholder="value" .value=${x(c.value)}
							@input=${o=>{let p=a.slice();p[d]={...c,value:o.currentTarget.value},i(p)}} />
						<button class="exp-icon-btn" type="button" title="Remove" aria-label="Remove key"
							@click=${()=>{let o=a.slice();o.splice(d,1),i(o)}}>✕</button>
					</div>`)}
				<button class="exp-btn secondary tiny" type="button" @click=${()=>i([...g(a),{key:"",value:""}])}>+ Add key</button>
			</div>
		`}function xe(e,t,a){let r=g(a.metrics),s=(i,c)=>R(e,t,d=>{let o=g(d.metrics).slice();c.primary&&o.forEach((p,m)=>{o[m]={...p,primary:m===i}}),o[i]={...o[i],...c},d.metrics=o});return n`
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
								${De.map(d=>n`<option value=${d} ?selected=${i.aggregation===d}>${d}</option>`)}
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
		`}function be(e,t,a){let r=a.ab||{},s=g(r.variants),i=m=>R(e,t,y=>{y.ab={...y.ab,...m}}),c=(m,y)=>R(e,t,u=>{let w=g(u.ab.variants).slice();w[m]={...w[m],...y},u.ab={...u.ab,variants:w}}),d=m=>R(e,t,y=>{let u=g(y.ab.variants).slice();u.splice(m,1),y.ab={...y.ab,variants:u}}),o=m=>R(e,t,y=>{let u=g(y.ab.variants).slice(),w=m!=null?u[m]:null;u.push({label:`variant-${u.length+1}`,metadata:w?w.metadata.map(I=>({...I})):_(),rolesJson:w?w.rolesJson:"",rolesOpen:!1}),y.ab={...y.ab,variants:u}}),p=h(r.repeats);return n`
			<section class="exp-card" data-testid="experiment-runner-ab-form">
				<h2 class="exp-h2">Variants</h2>
				${s.map((m,y)=>n`
					<div class="exp-variant" data-testid="experiment-runner-variant-row" data-variant-index=${y}>
						<div class="exp-variant-head">
							<input class="exp-input" type="text" data-testid="experiment-runner-variant-label" placeholder="variant label"
								.value=${x(m.label)} @input=${u=>c(y,{label:u.currentTarget.value})} />
							<button class="exp-btn secondary tiny" type="button" @click=${()=>o(y)}>Duplicate</button>
							<button class="exp-btn secondary tiny" type="button" data-testid="experiment-runner-remove-variant"
								?disabled=${s.length<=2}
								title=${s.length<=2?"A/B needs at least two variants":"Remove variant"}
								@click=${()=>d(y)}>Remove</button>
						</div>
						<div class="exp-field-label">Metadata treatment</div>
						${Y(e,t,m.metadata,u=>c(y,{metadata:u}),"experiment-runner-variant-metadata")}
						<details class="exp-details" ?open=${m.rolesOpen}>
							<summary @click=${()=>c(y,{rolesOpen:!m.rolesOpen})}>Advanced: per-arm roles</summary>
							<textarea class="exp-input exp-mono" rows="3" placeholder='{"coder": {"model": "…"}}'
								.value=${x(m.rolesJson)} @input=${u=>c(y,{rolesJson:u.currentTarget.value})}></textarea>
						</details>
					</div>`)}
				<button class="exp-btn secondary" type="button" data-testid="experiment-runner-add-variant" @click=${()=>o(null)}>+ Add variant</button>

				<div class="exp-grid2">
					<label class="exp-label">Repeats per variant
						<input class="exp-input" type="number" min="1" max="20" data-testid="experiment-runner-repeats"
							.value=${x(r.repeats)} @input=${m=>i({repeats:m.currentTarget.value})} />
						${p>10?n`<span class="exp-warn-hint">high run count</span>`:l}
					</label>
					<label class="exp-label">Concurrency cap
						<input class="exp-input" type="number" min="1" max="8" data-testid="experiment-runner-concurrency"
							.value=${x(r.concurrency)} @input=${m=>i({concurrency:m.currentTarget.value})} />
					</label>
				</div>
				<label class="exp-checkbox"><input type="checkbox" data-testid="experiment-runner-same-bar"
					?checked=${r.sameCompletionBar!==!1} @change=${m=>i({sameCompletionBar:m.currentTarget.checked})} />
					Only aggregate runs that reached the same completion bar</label>
				<label class="exp-label">Per-run budget (USD, the fixed comparable budget)
					<input class="exp-input" type="number" min="0" step="0.5" data-testid="experiment-runner-per-run-budget"
						placeholder="e.g. 0.80" .value=${x(a.perRunBudget)}
						@input=${m=>R(e,t,y=>{y.perRunBudget=m.currentTarget.value})} />
				</label>
			</section>
		`}function me(e,t,a){let r=a.auto||{},s=o=>R(e,t,p=>{p.auto={...p.auto,...o}}),i=o=>R(e,t,p=>{p.auto={...p.auto,caps:{...p.auto.caps,...o}}}),c=o=>R(e,t,p=>{p.auto={...p.auto,stops:{...p.auto.stops,...o}}}),d=g(a.metrics).map(o=>o.metric);return n`
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
						.value=${x(r.correctnessGateId)} @input=${o=>s({correctnessGateId:o.currentTarget.value})} />
					<span class="exp-hint">Candidates failing verification are rejected even if the objective improves.</span>
				</label>
				<div class="exp-field-label">Search seed (iteration-0 candidate)</div>
				${Y(e,t,r.seed,o=>s({seed:o}),"experiment-runner-seed-metadata")}
			</section>

			<section class="exp-card" data-testid="experiment-runner-auto-caps">
				<h2 class="exp-h2">Caps <span class="exp-req">— at least one required</span></h2>
				<div class="exp-grid2">
					<label class="exp-label">Max iterations
						<input class="exp-input" type="number" min="1" data-testid="experiment-runner-cap-max-iterations"
							.value=${x(r.caps.maxIterations)} @input=${o=>i({maxIterations:o.currentTarget.value})} />
					</label>
					<label class="exp-label">Wall-clock cap (hours)
						<input class="exp-input" type="number" min="0" step="0.5" data-testid="experiment-runner-cap-wallclock"
							.value=${x(r.caps.wallClockHours)} @input=${o=>i({wallClockHours:o.currentTarget.value})} />
					</label>
					<label class="exp-label">Cost cap (USD)
						<input class="exp-input" type="number" min="0" step="1" data-testid="experiment-runner-cap-cost"
							.value=${x(r.caps.costUsd)} @input=${o=>i({costUsd:o.currentTarget.value})} />
					</label>
					<label class="exp-label">Per-iteration budget (USD, required)
						<input class="exp-input" type="number" min="0" step="0.5" data-testid="experiment-runner-per-iter-budget"
							.value=${x(r.caps.perIterBudget)} @input=${o=>i({perIterBudget:o.currentTarget.value})} />
					</label>
				</div>
			</section>

			<section class="exp-card" data-testid="experiment-runner-auto-stops">
				<h2 class="exp-h2">Stop conditions <span class="exp-req">— at least one required</span></h2>
				<div class="exp-grid2">
					<label class="exp-label">Plateau over K iterations
						<input class="exp-input" type="number" min="1" data-testid="experiment-runner-stop-plateau"
							.value=${x(r.stops.plateauK)} @input=${o=>c({plateauK:o.currentTarget.value})} />
					</label>
					<label class="exp-label">Target value
						<input class="exp-input" type="number" step="any" data-testid="experiment-runner-stop-target"
							.value=${x(r.stops.target)} @input=${o=>c({target:o.currentTarget.value})} />
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
							<input class="exp-input" type="number" min="1" max="8" .value=${x(r.batchSize)}
								@input=${o=>s({batchSize:o.currentTarget.value})} />
						</label>
					</div>
				</details>
			</section>
		`}function ge(e,t,a,r){if(a.mode==="autoresearch"){let s=g(r.checklist);return n`
				<footer class="exp-projection" data-testid="experiment-runner-projection">
					<div class="exp-proj-stats">
						<span data-testid="experiment-runner-cost">${r.estCostMax!=null?`\u2264 ${O(r.estCostMax)}`:"cost unbounded by iterations"}</span>
						${r.hasStop?n`<span class="exp-pos">stop set</span>`:l}
					</div>
					${s.length?n`<ul class="exp-checklist" data-testid="experiment-runner-guardrail-checklist">
						${s.map(i=>n`<li class="exp-neg">✗ ${i}</li>`)}
					</ul>`:l}
					${g(r.errors).length?n`<ul class="exp-checklist" data-testid="experiment-runner-error">
						${r.errors.map(i=>n`<li class="exp-neg">✗ ${i}</li>`)}
					</ul>`:l}
					<label class="exp-checkbox danger"><input type="checkbox" data-testid="experiment-runner-confirm-ack"
						?checked=${!!a.confirmAck} @change=${i=>R(e,t,c=>{c.confirmAck=i.currentTarget.checked})} />
						I understand this runs autonomously and may cost ${r.estCostMax!=null?`up to ${O(r.estCostMax)}`:"an unbounded amount until a cap is hit"}.</label>
					<button class="exp-btn primary" type="button" data-testid="experiment-runner-review-launch" ?disabled=${!r.valid}
						title=${r.valid?"Review & launch":"Set caps + stop condition + acknowledge"}
						@click=${()=>J(e,t,"confirm")}>Review &amp; launch →</button>
				</footer>
			`}return n`
			<footer class="exp-projection" data-testid="experiment-runner-projection">
				<div class="exp-proj-stats">
					<span data-testid="experiment-runner-run-count">${g(a.ab&&a.ab.variants).length} variants × ${h(a.ab&&a.ab.repeats)||0} repeats = ${r.runCount} runs</span>
					<span data-testid="experiment-runner-cost">${r.estCostMax!=null?`est. \u2264 ${O(r.estCostMax)}`:"est. \u2014 set a per-run budget"}</span>
					<span>~${h(a.ab&&a.ab.concurrency)||1} concurrent</span>
				</div>
				${g(r.errors).length?n`<ul class="exp-checklist" data-testid="experiment-runner-error">
					${r.errors.map(s=>n`<li class="exp-neg">✗ ${s}</li>`)}
				</ul>`:l}
				<button class="exp-btn primary" type="button" data-testid="experiment-runner-review-launch" ?disabled=${!r.valid}
					title=${r.valid?"Review & launch":g(r.errors)[0]||"Complete the form"}
					@click=${()=>J(e,t,"confirm")}>Review &amp; launch →</button>
			</footer>
		`}function fe(e,t,a){let r=te(a);return n`
			<div class="exp-view exp-define" data-testid="experiment-runner-view-define" data-mode=${a.mode||"ab"}>
				<div class="exp-define-head">
					<button class="exp-btn link" type="button" @click=${()=>J(e,t,"mode-select")}>← mode</button>
					<span class="exp-mode-badge ${a.mode==="autoresearch"?"warn":""}">${a.mode==="autoresearch"?"AUTORESEARCH":"A/B"}</span>
				</div>
				${ue(e,t,a)}
				${a.mode==="autoresearch"?me(e,t,a):be(e,t,a)}
				${xe(e,t,a)}
				${ge(e,t,a,r)}
			</div>
		`}function ve(e,t,a){let r=te(a),s=a.mode==="autoresearch",i=M.get(t)||{};return n`
			<div class="exp-view" data-testid="experiment-runner-view-confirm">
				<h1 class="exp-h1">Confirm launch</h1>
				<section class="exp-card">
					<div class="exp-confirm-row"><span>Mode</span><strong>${s?"Autoresearch":"A/B comparison"}</strong></div>
					<div class="exp-confirm-row"><span>Name</span><strong>${x(a.basics&&a.basics.name)}</strong></div>
					${s?n`
							<div class="exp-confirm-row"><span>Objective</span><strong>${x(a.auto&&a.auto.objectiveMetric)} (${x(a.auto&&a.auto.direction)})</strong></div>
							<div class="exp-confirm-row"><span>Caps</span><strong>${x(h(a.auto.caps.maxIterations)?`\u2264 ${h(a.auto.caps.maxIterations)} iters`:"")} ${h(a.auto.caps.wallClockHours)?`\u2264 ${h(a.auto.caps.wallClockHours)}h`:""} ${h(a.auto.caps.costUsd)?`\u2264 ${O(h(a.auto.caps.costUsd))}`:""}</strong></div>
							<div class="exp-confirm-row"><span>Worst-case cost</span><strong>${r.estCostMax!=null?`\u2264 ${O(r.estCostMax)}`:"unbounded by iterations"}</strong></div>
							<div class="exp-confirm-note">A candidate that fails verification is discarded even if its objective improved.</div>`:n`
							<div class="exp-confirm-row"><span>Fan-out</span><strong>${r.runCount} child goals (${g(a.ab.variants).length} variants × ${h(a.ab.repeats)} repeats)</strong></div>
							<div class="exp-confirm-row"><span>Projected cost</span><strong>${r.estCostMax!=null?`\u2264 ${O(r.estCostMax)}`:"\u2014"}</strong></div>`}
				</section>
				${i.launchError?n`<div class="exp-error-box" data-testid="experiment-runner-launch-error">${i.launchError}</div>`:l}
				<div class="exp-confirm-actions">
					<button class="exp-btn secondary" type="button" @click=${()=>J(e,t,"define")}>← Back</button>
					<button class="exp-btn primary" type="button" data-testid="experiment-runner-launch" ?disabled=${!r.valid||i.launching}
						@click=${()=>ie(e,t)}>${i.launching?"Launching\u2026":s?`Launch loop (\u2264 ${r.estCostMax!=null?O(r.estCostMax):"capped"})`:`Launch ${r.runCount} runs`}</button>
				</div>
			</div>
		`}function Z(e){let t=e&&Array.isArray(e.spec)?e.spec:e&&e.spec&&Array.isArray(e.spec.widgets)?e.spec.widgets:null;return t&&t.length?t:e&&e.def&&e.def.mode==="autoresearch"?[{type:"summary-cards",title:"Summary"},{type:"objective-curve",title:"Best objective vs iteration"},{type:"ledger-table",title:"Ledger"},{type:"raw-drilldown",title:"Iterations"}]:[{type:"summary-cards",title:"Summary"},{type:"comparison-table",title:"Comparison"},{type:"score-bars",title:"Secondary metrics"},{type:"raw-drilldown",title:"Runs"}]}let L=e=>e&&(e.metricId||e.metric)||void 0;function q(e){let a=g(e&&e.metrics).filter(r=>r.collect!==!1).map(L).filter(Boolean);return a.length?a:["objective.value","cost.totalUsd","time.wallClockMs"]}function he(e){let a=g(e&&e.metrics).find(r=>r.primary);return a?L(a):e&&e.def&&e.def.objective?e.def.objective.metricId||e.def.objective.metric:q(e)[0]}let F=(e,t)=>{let a=e&&e.metrics,r=a?a[t]:void 0;return Number.isFinite(Number(r))?Number(r):r&&Number.isFinite(Number(r.value))?Number(r.value):void 0};function Q(e){let t=new Map;for(let a of g(e&&e.runs)){let r=x(a.armId,"arm");t.has(r)||t.set(r,[]),t.get(r).push(a)}return t}function $e(e,t){let a=q(t),r=!(t.def&&t.def.sameCompletionBar===!1),s=Q(t),i=g(t.metrics),c=d=>(i.find(o=>L(o)===d)||{}).aggregation||"median";return n`<table class="exp-table" data-testid="experiment-runner-widget-comparison-table">
			<thead><tr><th>Variant</th>${a.map(d=>n`<th class="exp-mono">${d}</th>`)}<th>n</th></tr></thead>
			<tbody>
				${[...s.entries()].map(([d,o])=>{let p=r?o.filter(y=>y.completionBar==="passed"):o,m=p.length?p:o;return n`<tr data-testid="experiment-runner-comparison-arm" data-arm=${d}>
						<td><strong>${d}</strong></td>
						${a.map(y=>n`<td class="exp-mono">${B(ee(m.map(u=>F(u,y)),c(y)))}</td>`)}
						<td>${m.length}</td>
					</tr>`})}
			</tbody>
		</table>`}function ye(e,t){let a=q(t),r=Q(t);return n`<div class="exp-scorebars" data-testid="experiment-runner-widget-score-bars">
			${a.map((s,i)=>{let c=[...r.entries()].map(([o,p])=>({arm:o,v:ee(p.map(m=>F(m,s)),"median")})),d=Math.max(1,...c.map(o=>Number.isFinite(o.v)?Math.abs(o.v):0));return n`<div class="exp-scorebar-group"><div class="exp-field-label exp-mono">${s}</div>
					${c.map(o=>n`<div class="exp-scorebar-row"><span class="exp-scorebar-label">${o.arm}</span>
						<span class="exp-scorebar-track"><span class="exp-scorebar-fill" style=${`width:${Math.round((Number.isFinite(o.v)?Math.abs(o.v):0)/d*100)}%;background:var(--chart-${i%6+1})`}></span></span>
						<span class="exp-mono">${B(o.v)}</span></div>`)}
				</div>`})}
		</div>`}function we(e,t){let a=he(t),r=t.def&&t.def.objective&&t.def.objective.direction||"maximize",s=g(t.runs).filter(o=>o.iteration!=null).sort((o,p)=>o.iteration-p.iteration),i=null,c=s.map(o=>{let p=F(o,a);return Number.isFinite(p)&&(i=i==null?p:r==="minimize"?Math.min(i,p):Math.max(i,p)),{iteration:o.iteration,v:p,best:i,kept:o.verified!==!1&&o.completionBar!=="failed"}}),d=h(t.def&&t.def.stop&&t.def.stop.target);return n`<div data-testid="experiment-runner-widget-objective-curve">
			${d!=null?n`<div class="exp-hint">target ${r==="minimize"?"\u2264":"\u2265"} ${B(d)}</div>`:l}
			<table class="exp-table"><thead><tr><th>Iter</th><th>objective</th><th>best</th><th>verdict</th></tr></thead>
				<tbody>${c.map(o=>n`<tr><td>${o.iteration}</td><td class="exp-mono">${B(o.v)}</td><td class="exp-mono exp-pos">${B(o.best)}</td><td>${o.kept?n`<span class="exp-pos">●</span>`:n`<span class="exp-neg">○</span>`}</td></tr>`)}</tbody>
			</table>
		</div>`}function ke(e,t){let a=g(t.ledger);return n`<table class="exp-table" data-testid="experiment-runner-widget-ledger-table">
			<thead><tr><th>Iter</th><th>verdict</th><th>objective</th><th>best</th></tr></thead>
			<tbody>${a.map(r=>{let s=x(r.verdict||r.decision,"\u2014"),i=/kept|accept/i.test(s)?"exp-pos":/verification|failed/i.test(s)?"exp-neg":"exp-muted";return n`<tr data-testid="experiment-runner-ledger-row"><td>${x(r.iteration)}</td><td class=${i}>${s}</td><td class="exp-mono">${B(h(r.objective))}</td><td class="exp-mono">${B(h(r.best))}</td></tr>`})}</tbody>
		</table>`}function Ce(e,t){let a=g(t.runs),r=a.filter(c=>["settled","collected","failed"].includes(c.status)).length,s=a.filter(c=>c.completionBar==="passed").length,i=a.reduce((c,d)=>c+(h(d.cost&&d.cost.totalUsd)||F(d,"cost.totalUsd")||0),0);return n`<div class="exp-cards" data-testid="experiment-runner-widget-summary-cards">
			<div class="exp-stat"><span class="exp-stat-n">${a.length}</span><span class="exp-stat-l">runs</span></div>
			<div class="exp-stat"><span class="exp-stat-n">${r}</span><span class="exp-stat-l">settled</span></div>
			<div class="exp-stat"><span class="exp-stat-n exp-pos">${s}</span><span class="exp-stat-l">passed bar</span></div>
			<div class="exp-stat"><span class="exp-stat-n">${O(i)}</span><span class="exp-stat-l">spend</span></div>
		</div>`}function Se(e,t){let a=q(t),r=g(t.runs);return n`<table class="exp-table" data-testid="experiment-runner-widget-raw-drilldown">
			<thead><tr><th>run</th><th>arm</th><th>${t.def&&t.def.mode==="autoresearch"?"iter":"rep"}</th><th>status</th><th>bar</th>${a.map(s=>n`<th class="exp-mono">${s}</th>`)}</tr></thead>
			<tbody>${r.map(s=>{let i=t.def&&t.def.sameCompletionBar!==!1&&s.completionBar&&s.completionBar!=="passed";return n`<tr class=${i?"exp-excluded":""} data-testid="experiment-runner-run-row" data-run=${x(s.runId)}>
					<td class="exp-mono">${x(s.runId)}</td><td>${x(s.armId)}</td>
					<td>${x(s.iteration!=null?s.iteration:s.repeat)}</td>
					<td>${x(s.status)}</td><td>${x(s.completionBar)}${i?n` <span class="exp-tag">excluded</span>`:l}</td>
					${a.map(c=>n`<td class="exp-mono">${B(F(s,c))}</td>`)}
				</tr>`})}</tbody>
		</table>`}let Ie={"comparison-table":$e,"score-bars":ye,"objective-curve":we,"ledger-table":ke,"summary-cards":Ce,"raw-drilldown":Se};function Te(e){try{let t=document.createElement("div");return t.setAttribute("data-testid","experiment-runner-report-html"),t.innerHTML=String(e),t}catch{return l}}function Re(e,t,a){if(a.report&&typeof a.report.html=="string"&&a.report.html.trim())return n`<div class="exp-dashboard-body" data-testid="experiment-runner-dashboard-body">${Te(a.report.html)}</div>`;let r=Z(a);return n`<div class="exp-dashboard-body" data-testid="experiment-runner-dashboard-body">
			${r.map(s=>{let i=Ie[s.type];return n`<section class="exp-widget exp-card" data-testid="experiment-runner-widget" data-widget-type=${s.type}>
					<h3 class="exp-widget-title">${x(s.title,s.type)}</h3>
					${i?i(e,a):n`<div class="exp-hint">Unknown widget: ${s.type}</div>`}
				</section>`})}
		</div>`}function Me(e,t,a){let r=Z(a).slice(),s=u=>E(e,t,{dashboardDraftSpec:u}),i=M.get(t)||{},c=i.dashboardDraftSpec||r,d=(u,w)=>{let I=c.slice(),G=u+w;G<0||G>=I.length||([I[u],I[G]]=[I[G],I[u]],s(I))},o=u=>{let w=c.slice();w.splice(u,1),s(w)},p=u=>s([...c,{type:u,title:(K.find(w=>w.id===u)||{}).label||u}]),m=(u,w)=>{let I=c.slice();I[u]={...I[u],title:w},s(I)},y=i.widgetTypes&&i.widgetTypes.length?i.widgetTypes:K;return n`<div class="exp-card" data-testid="experiment-runner-dashboard-editor">
			<h3 class="exp-h2">Edit dashboard</h3>
			${c.map((u,w)=>n`<div class="exp-editor-row" data-testid="experiment-runner-editor-widget" data-widget-type=${u.type}>
				<input class="exp-input" type="text" .value=${x(u.title)} @input=${I=>m(w,I.currentTarget.value)} />
				<span class="exp-badge exp-mono">${u.type}</span>
				<button class="exp-icon-btn" type="button" title="Move up" @click=${()=>d(w,-1)}>↑</button>
				<button class="exp-icon-btn" type="button" title="Move down" @click=${()=>d(w,1)}>↓</button>
				<button class="exp-icon-btn" type="button" title="Remove" @click=${()=>o(w)}>✕</button>
			</div>`)}
			<div class="exp-editor-add">
				<select class="exp-input" data-testid="experiment-runner-add-widget-type">
					${y.map(u=>n`<option value=${u.id}>${u.label||u.id}</option>`)}
				</select>
				<button class="exp-btn secondary" type="button" data-testid="experiment-runner-add-widget"
					@click=${u=>{let w=u.currentTarget.parentElement.querySelector("select");p(w.value)}}>+ Add widget</button>
			</div>
			<div class="exp-confirm-actions">
				<button class="exp-btn secondary" type="button" @click=${()=>E(e,t,{dashboardEditing:!1,dashboardDraftSpec:void 0})}>Cancel</button>
				<button class="exp-btn primary" type="button" data-testid="experiment-runner-save-dashboard"
					@click=${()=>{E(e,t,{dashboardDraftSpec:void 0}),le(e,t,a.experimentId,c)}}>Save dashboard</button>
			</div>
		</div>`}function Ae(e,t,a){let r=M.get(t)||{},s=r.dashboard,i=()=>E(e,t,{dashboard:null})&&R(e,t,w=>{Object.assign(w,H())});if(r.dashboardLoading&&!s)return n`<div class="exp-view" data-testid="experiment-runner-view-dashboard"><div class="exp-hint">Loading experiment…</div></div>`;if(!s)return n`<div class="exp-view" data-testid="experiment-runner-view-dashboard">
				<div class="exp-empty">No experiment loaded.</div>
				<button class="exp-btn primary" type="button" data-testid="experiment-runner-new-experiment" @click=${i}>New experiment</button>
			</div>`;let c=s.def||{},d=s.state||{},o=c.mode==="autoresearch",p=x(d.status,"running"),m=g(s.runs),y=m.filter(w=>["settled","collected","failed"].includes(w.status)).length,u=d.stopReason?`stopped: ${d.stopReason}`:p;return n`
			<div class="exp-view" data-testid="experiment-runner-view-dashboard" data-experiment-id=${s.experimentId}>
				<header class="exp-dash-head">
					<div class="exp-dash-titles">
						<span class="exp-mode-badge ${o?"warn":""}">${o?"AUTORESEARCH":"A/B"}</span>
						<h1 class="exp-h1">${x(c.title,s.experimentId)}</h1>
					</div>
					<div class="exp-dash-meta">
						<span class="exp-status" data-testid="experiment-runner-status" role="status">${p==="running"?`running ${y}/${m.length}`:u}</span>
					</div>
					<div class="exp-dash-actions">
						${p==="running"?n`<button class="exp-btn secondary" type="button" data-testid="experiment-runner-stop" @click=${()=>ce(e,t,s.experimentId)}>Stop experiment</button>`:l}
						<button class="exp-btn secondary" type="button" data-testid="experiment-runner-refresh" @click=${()=>N(e,t,s.experimentId)}>Refresh</button>
						<button class="exp-btn secondary" type="button" data-testid="experiment-runner-edit-dashboard"
							@click=${()=>E(e,t,{dashboardEditing:!r.dashboardEditing,dashboardDraftSpec:void 0})}>${r.dashboardEditing?"Close editor":"Edit dashboard"}</button>
						<button class="exp-btn link" type="button" data-testid="experiment-runner-new-experiment" @click=${i}>New experiment</button>
					</div>
				</header>
				${r.dashboardEditing?Me(e,t,s):l}
				<details class="exp-details" data-testid="experiment-runner-metrics-panel">
					<summary>Metrics — edit what is collected (re-extracts from stored outcomes, no re-run)</summary>
					${ze(e,t,s)}
				</details>
				${Re(e,t,s)}
			</div>
		`}function ze(e,t,a){let r=g(a.metrics).length?g(a.metrics):ae(),s=(i,c)=>{let d=r.map((o,p)=>p===i?{...o,collect:c}:o);E(e,t,{dashboard:{...a,metrics:d}}),de(e,t,a.experimentId,d)};return n`<table class="exp-table">
			<thead><tr><th>Collect</th><th>Metric</th></tr></thead>
			<tbody>${r.map((i,c)=>n`<tr><td><input type="checkbox" data-testid="experiment-runner-dash-metric-collect" data-metric=${L(i)}
				?checked=${i.collect!==!1} @change=${d=>s(c,d.currentTarget.checked)} /></td><td class="exp-mono">${L(i)}</td></tr>`)}</tbody>
		</table>`}let Ee=`
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
	`;return{render(e,t){let a=e&&typeof e.__sessionId=="string"?e.__sessionId:"",r=e&&typeof e.experimentId=="string"?e.experimentId:"",s=e&&typeof e.view=="string"?e.view:void 0,i=a||"experiment-runner",c=re(t,i,r,s),d=c&&c.draft||H(),o=d.view||"mode-select",p;return o==="dashboard"?p=Ae(t,i,d):o==="confirm"?p=ve(t,i,d):o==="define"?p=fe(t,i,d):p=pe(t,i,d),n`
				<style>${Ee}</style>
				<div class="exp-root" data-testid="experiment-runner-panel-root" data-view=${o} data-mode=${d.mode||""}>
					${p}
				</div>
			`}}}export{Je as default};
