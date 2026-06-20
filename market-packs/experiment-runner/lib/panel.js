var je=["cost.totalUsd","cost.tokensTotal","cost.cacheHitRate","gates.passRate","gates.firstPassClean","tasks.completionRate","time.wallClockMs","objective.value","command.metric"],Be={"cost.totalUsd":"lower-better","cost.tokensTotal":"lower-better","cost.cacheHitRate":"higher-better","gates.passRate":"higher-better","gates.firstPassClean":"higher-better","tasks.completionRate":"higher-better","time.wallClockMs":"lower-better","objective.value":"higher-better","command.metric":"neutral"},Oe=new Set(["cost.totalUsd","time.wallClockMs","gates.passRate","objective.value"]),K=[{id:"comparison-table",label:"Comparison table"},{id:"score-bars",label:"Score bars"},{id:"objective-curve",label:"Objective curve"},{id:"ledger-table",label:"Ledger"},{id:"summary-cards",label:"Summary cards"},{id:"raw-drilldown",label:"Raw runs"}],De=["median","mean","p90","min","max","count"],R={exp:n=>`exp/${n}`,state:n=>`exp/${n}/state`,runPrefix:n=>`exp/${n}/run/`,ledger:n=>`exp/${n}/ledger`,dashboard:n=>`exp/${n}/dashboard`,metrics:n=>`exp/${n}/metrics`,index:"index/experiments",draft:n=>`drafts/${n}`},Ne="bobbit:experiment-runner:draft:",f=n=>Array.isArray(n)?n:[],x=(n,l="")=>n==null?l:String(n),y=n=>{let l=Number(n);return Number.isFinite(l)?l:void 0},D=n=>x(n,"exp").replace(/[^a-zA-Z0-9_-]+/g,"-").replace(/^-+|-+$/g,"")||"exp";function Ue(n){let l=x(n).trim();if(l==="")return"";if(/^-?\d+(\.\d+)?$/.test(l))return Number(l);if(l==="true")return!0;if(l==="false")return!1;if(l.startsWith("{")&&l.endsWith("}")||l.startsWith("[")&&l.endsWith("]"))try{return JSON.parse(l)}catch{}return l}function V(n){let l={};for(let w of f(n)){let $=x(w&&w.key).trim();$&&(l[$]=Ue(w&&w.value))}return l}function W(n){let l=x(n).trim();if(l)try{let w=JSON.parse(l);return w&&typeof w=="object"?w:void 0}catch{return}}var Pe=n=>{let l=n.filter($=>Number.isFinite($)).slice().sort(($,k)=>$-k);if(!l.length)return;let w=Math.floor(l.length/2);return l.length%2?l[w]:(l[w-1]+l[w])/2},ee=(n,l)=>{let w=n.filter($=>Number.isFinite($));if(l==="count")return w.length;if(w.length)switch(l){case"mean":return w.reduce(($,k)=>$+k,0)/w.length;case"min":return Math.min(...w);case"max":return Math.max(...w);case"p90":{let $=w.slice().sort((k,h)=>k-h);return $[Math.min($.length-1,Math.floor(.9*$.length))]}default:return Pe(w)}},B=n=>{if(n==null||!Number.isFinite(n))return"\u2014";let l=Math.abs(n);return l!==0&&l<.01?n.toExponential(2):Number.isInteger(n)?String(n):n.toFixed(l>=100?1:3)},O=n=>n==null||!Number.isFinite(n)?"\u2014":`$${n.toFixed(2)}`;function J(){return[{key:"",value:""}]}function ae(){return je.map(n=>({metric:n,source:"built-in",collect:Oe.has(n),aggregation:"median",direction:Be[n]||"neutral",primary:n==="gates.passRate"}))}function H(){return{view:"mode-select",mode:null,experimentId:void 0,basics:{name:"",runnableUnit:"command",body:"",workflowId:""},ab:{variants:[{label:"baseline",metadata:J(),rolesJson:"",rolesOpen:!1},{label:"variant-b",metadata:J(),rolesJson:"",rolesOpen:!1}],repeats:3,sameCompletionBar:!0,concurrency:3},auto:{objectiveMetric:"objective.value",direction:"maximize",correctnessGateId:"",seed:J(),seedRolesJson:"",caps:{maxIterations:"",wallClockHours:"",costUsd:"",perIterBudget:""},stops:{plateauK:"",target:""},strategy:"greedy",batchSize:""},metrics:ae(),perRunBudget:"",confirmAck:!1}}var M=globalThis.__bobbitExperimentRunnerState||(globalThis.__bobbitExperimentRunnerState=new Map);function Le(n){let l=[],w=n.basics||{};x(w.name).trim()||l.push("Name is required"),x(w.body).trim()||l.push("Spec / command body is required");let $=f(n.ab&&n.ab.variants);$.length<2&&l.push("A/B needs at least two variants");let k=new Set,h=[];$.forEach((I,z)=>{let P=x(I.label).trim();P?k.has(P)&&l.push(`Variant label "${P}" is duplicated`):l.push(`Variant ${z+1} needs a label`),k.add(P),h.push(JSON.stringify({m:V(I.metadata),r:W(I.rolesJson)||null}))});for(let I=0;I<h.length;I++)for(let z=I+1;z<h.length;z++)h[I]===h[z]&&l.push(`Variant "${x($[z].label).trim()||z+1}" is identical to "${x($[I].label).trim()||I+1}"`);let g=y(n.ab&&n.ab.repeats);(!g||g<1)&&l.push("Repeats must be \u2265 1");let S=y(n.perRunBudget);(!S||S<=0)&&l.push("Set a per-run budget");let A=y(n.ab&&n.ab.concurrency);A!=null&&(A<1||A>8)&&l.push("Concurrency must be 1\u20138"),f(n.metrics).some(I=>I.collect)||l.push("Select at least one metric");let j=$.length*(g||0),U=S?j*S:void 0;return{valid:l.length===0,errors:l,runCount:j,estCostMax:U}}function Fe(n){let l=[],w=[],$=n.basics||{};x($.name).trim()||l.push("Name is required"),x($.body).trim()||l.push("Spec / command body is required");let k=n.auto||{};x(k.objectiveMetric).trim()||l.push("Choose an objective metric");let h=y(k.caps&&k.caps.perIterBudget);(!h||h<=0)&&l.push("Set a per-iteration budget");let g=k.caps||{},S=y(g.maxIterations)>0||y(g.wallClockHours)>0||y(g.costUsd)>0,A=k.stops||{},j=y(A.plateauK)>0||A.target!==""&&Number.isFinite(y(A.target));S||w.push("Set at least one hard cap (max-iterations, wall-clock, or cost)"),j||w.push("Set at least one stop condition (plateau-K or target)"),n.confirmAck||w.push("Acknowledge the autonomous-run warning");let U=y(g.maxIterations),I=y(g.costUsd),z;return h&&U&&(z=U*h),I!=null&&(z=z==null?I:Math.min(z,I)),{valid:l.length===0&&w.length===0,errors:l,checklist:w,estCostMax:z,hasCap:S,hasStop:j}}function te(n){return n.mode==="autoresearch"?Fe(n):Le(n)}function _e(n){let l=n.basics||{},w=f(n.metrics).filter(g=>g.collect).map(g=>({metricId:g.metric,aggregation:g.aggregation,direction:g.direction,primary:!!g.primary})),k=l.runnableUnit==="command"?{kind:"command",command:x(l.body)}:{kind:"agent",spec:x(l.body)},h={experimentId:n.experimentId,title:x(l.name).trim(),mode:n.mode==="autoresearch"?"autoresearch":"ab",runnable:k,workflowId:x(l.workflowId).trim()||void 0,metrics:w};if(h.mode==="ab"){let g=n.ab||{};h.variants=f(g.variants).map((S,A)=>({armId:D(x(S.label).trim()||`arm-${A}`),label:x(S.label).trim()||`arm-${A}`,metadata:V(S.metadata),inlineRoles:W(S.rolesJson)})),h.repeats=y(g.repeats)||1,h.sameCompletionBar=g.sameCompletionBar!==!1,h.maxConcurrency=y(g.concurrency)||3,h.perRunBudget=y(n.perRunBudget)}else{let g=n.auto||{};h.objective={metricId:g.objectiveMetric,direction:g.direction==="minimize"?"min":"max"},h.correctnessGateId=x(g.correctnessGateId).trim()||void 0,h.seed={metadata:V(g.seed),inlineRoles:W(g.seedRolesJson)};let S=y(g.caps&&g.caps.wallClockHours);h.caps={maxIterations:y(g.caps&&g.caps.maxIterations),maxWallClockMs:S?S*36e5:void 0,maxCostUsd:y(g.caps&&g.caps.costUsd)};let A=y(g.stops&&g.stops.target);h.stop={plateauK:y(g.stops&&g.stops.plateauK)},A!=null&&(h.stop.target=A),h.strategy=g.strategy==="best-of-batch"?"best-of-batch":"greedy",h.batchSize=y(g.batchSize),h.perRunBudget=y(g.caps&&g.caps.perIterBudget)}return h}function Je({html:n,nothing:l,renderHeader:w}){let $=async(e,t,r)=>{try{if(!e||!e.capabilities||!e.capabilities.callRoute||!e.callRoute)return{ok:!1,error:"routes-unavailable"};let a=await e.callRoute(t,r);return a&&typeof a=="object"&&a.error?{ok:!1,error:a.error}:{ok:!0,data:a}}catch(a){return{ok:!1,error:a&&a.message?String(a.message):String(a)}}},k=async(e,t)=>{try{return e&&e.store&&e.store.get?await e.store.get(t):null}catch{return null}},h=async(e,t,r)=>{try{e&&e.store&&e.store.put&&await e.store.put(t,r)}catch{}},g=async(e,t)=>{try{return e&&e.store&&e.store.list?await e.store.list(t)||[]:[]}catch{return[]}},S=e=>{try{e&&e.requestRender&&e.requestRender()}catch{}},A=(e,t)=>{try{e&&e.capabilities&&e.capabilities.ui&&e.ui&&e.ui.navigate&&e.ui.navigate({route:"experiment-runner",params:t})}catch{}},j=e=>`${Ne}${D(e)}`,U=e=>{try{let t=globalThis.localStorage&&globalThis.localStorage.getItem(j(e));return t?JSON.parse(t):void 0}catch{return}},I=(e,t)=>{try{globalThis.localStorage&&globalThis.localStorage.setItem(j(e),JSON.stringify(t))}catch{}},z=e=>M.get(e),P=(e,t,r)=>{M.set(t,r),S(e)},E=(e,t,r)=>{let s={...M.get(t)||{},...r};return M.set(t,s),S(e),s},T=(e,t,r)=>{let a=M.get(t)||{},s={...a.draft||H()};r(s);let i={...a,draft:s};M.set(t,i),I(t,s),h(a.host,R.draft(t),s),S(e)};function re(e,t,r,a){let s=M.get(t);return s&&s.hydrated?(s.host=e,r&&s.draft&&s.draft.experimentId!==r&&se(e,t,r,a),s):(s={hydrated:!1,host:e,draft:U(t)||H(),dashboard:null,experiments:[]},M.set(t,s),(async()=>{let i=await k(e,R.draft(t)),c=M.get(t)||s,d=i&&typeof i=="object"?i:c.draft;r&&(d={...d,experimentId:r,view:a||"dashboard"}),M.set(t,{...c,hydrated:!0,draft:d}),S(e),ne(e,t),d.experimentId&&d.view==="dashboard"&&N(e,t,d.experimentId)})(),M.get(t))}let X=e=>({experimentId:e.experimentId,title:x(e.title,e.experimentId),mode:e.mode==="autoresearch"?"autoresearch":"ab"});async function ne(e,t){let r=await $(e,"listExperiments",{method:"GET"}),a=[];if(r.ok&&Array.isArray(r.data))a=r.data.filter(s=>s&&typeof s=="object").map(X);else{let s=f(await k(e,R.index)).filter(c=>typeof c=="string");a=(await Promise.all(s.map(c=>k(e,R.exp(c))))).filter(c=>c&&typeof c=="object").map(X)}E(e,t,{experiments:a})}async function se(e,t,r,a){T(e,t,s=>{s.experimentId=r,s.view=a||"dashboard"}),await N(e,t,r)}async function N(e,t,r){E(e,t,{dashboardLoading:!0});let a,s,i=[],c=[],d,o,p=await $(e,"getExperiment",{method:"GET",query:{experimentId:r}});if(p.ok&&p.data&&p.data.def&&(a=p.data.def,s=p.data.state,i=f(p.data.runs),c=f(p.data.ledger),d=p.data.dashboard,o=p.data.metrics),!a){a=await k(e,R.exp(r)),s=await k(e,R.state(r)),c=f(await k(e,R.ledger(r))),d=await k(e,R.dashboard(r)),o=await k(e,R.metrics(r));let u=await g(e,R.runPrefix(r));for(let v of u){let C=await k(e,v);C&&typeof C=="object"&&i.push(C)}}if(d==null&&(d=await k(e,R.dashboard(r))),!f(o).length){let u=await k(e,R.metrics(r));f(u).length&&(o=u)}if(s&&s.status==="running"){let u=await $(e,"poll",{method:"POST",body:{experimentId:r}});u.ok&&u.data&&Array.isArray(u.data.runs)&&(i=u.data.runs)}let b=await $(e,"report",{method:"POST",body:{experimentId:r}}),m=b.ok&&b.data?b.data:null;E(e,t,{dashboardLoading:!1,dashboard:{experimentId:r,def:a,state:s,runs:i,ledger:c,spec:d,metrics:f(o).length?o:a&&a.metrics||[],report:m}})}async function ie(e,t){let a=M.get(t).draft;E(e,t,{launching:!0,launchError:void 0});let s=_e(a),i=await $(e,"defineExperiment",{method:"POST",body:s});if(!i.ok&&i.error!=="routes-unavailable"){E(e,t,{launching:!1,launchError:i.error});return}let c=a.experimentId;i.ok&&i.data&&i.data.experimentId&&(c=i.data.experimentId),c||(c=`${D(s.title)}-${Date.now().toString(36)}`),s.experimentId=c,await h(e,R.exp(c),s),await h(e,R.metrics(c),s.metrics),await oe(e,t,{experimentId:c,title:s.title,mode:s.mode,status:"running"});let d=await $(e,"launch",{method:"POST",body:{experimentId:c}});if(!d.ok&&d.error!=="routes-unavailable"){E(e,t,{launching:!1,launchError:d.error});return}T(e,t,o=>{o.experimentId=c,o.view="dashboard"}),E(e,t,{launching:!1}),A(e,{experimentId:c,view:"dashboard"}),await N(e,t,c),s.mode==="autoresearch"&&await $(e,"iterate",{method:"POST",body:{experimentId:c}})}async function oe(e,t,r){let a=f(await k(e,R.index)).filter(c=>typeof c=="string"&&c!==r.experimentId);a.push(r.experimentId),await h(e,R.index,a);let s=M.get(t)||{},i=f(s.experiments).filter(c=>c.experimentId!==r.experimentId);i.push(r),E(e,t,{experiments:i})}async function ce(e,t,r){await $(e,"cancel",{method:"POST",body:{experimentId:r}}),await N(e,t,r)}async function de(e,t,r,a){await $(e,"saveMetrics",{method:"POST",body:{experimentId:r,metrics:a}}),await h(e,R.metrics(r),a),await N(e,t,r)}async function le(e,t,r,a){let s=Array.isArray(a)?{widgets:a}:a&&Array.isArray(a.widgets)?a:{widgets:[]};await $(e,"saveDashboard",{method:"POST",body:{experimentId:r,dashboard:s}}),await h(e,R.dashboard(r),s),E(e,t,{dashboardEditing:!1}),await N(e,t,r)}let q=(e,t,r)=>T(e,t,a=>{a.view=r});function pe(e,t,r){let a=s=>T(e,t,i=>{i.mode=s,i.view="define"});return n`
			<div class="exp-view" data-testid="experiment-runner-view-mode-select">
				<h1 class="exp-h1">New experiment</h1>
				<p class="exp-sub">Pick how you want to run it. A/B is the safe, bounded default; Autoresearch is an opt-in autonomous loop.</p>
				<div class="exp-mode-grid">
					<button
						class="exp-mode-card recommended"
						data-testid="experiment-runner-mode-ab"
						type="button"
						autofocus
						@click=${()=>a("ab")}
					>
						<span class="exp-eyebrow">Recommended · bounded cost</span>
						<span class="exp-mode-title">A/B comparison</span>
						<span class="exp-mode-desc">Run a fixed set of variants × repeats, aggregate, and compare. Cost is projected before launch.</span>
					</button>
					<button
						class="exp-mode-card danger"
						data-testid="experiment-runner-mode-autoresearch"
						type="button"
						@click=${()=>a("autoresearch")}
					>
						<span class="exp-eyebrow warn">Autonomous · opt-in · hard caps required</span>
						<span class="exp-mode-title">Autoresearch</span>
						<span class="exp-mode-desc">Propose → evaluate → keep-best loop. Runs unattended until a cap or stop condition fires. Off by default.</span>
					</button>
				</div>
			</div>
		`}function ue(e,t,r){let a=r.basics||{},s=(i,c)=>T(e,t,d=>{d.basics={...d.basics,[i]:c}});return n`
			<section class="exp-card" data-testid="experiment-runner-basics">
				<h2 class="exp-h2">Experiment basics</h2>
				<label class="exp-label">Experiment name
					<input class="exp-input" data-testid="experiment-runner-name" type="text" maxlength="80"
						placeholder="e.g. retry-temperature-sweep" .value=${x(a.name)}
						@input=${i=>s("name",i.currentTarget.value)} />
				</label>
				<div class="exp-label">Runnable unit
					<div class="exp-radio-row" role="radiogroup" aria-label="Runnable unit">
						<label class="exp-radio"><input type="radio" name="exp-runnable-${D(t)}" data-testid="experiment-runner-runnable-goal"
							?checked=${a.runnableUnit==="goal"} @change=${()=>s("runnableUnit","goal")} /> Goal spec</label>
						<label class="exp-radio"><input type="radio" name="exp-runnable-${D(t)}" data-testid="experiment-runner-runnable-command"
							?checked=${a.runnableUnit!=="goal"} @change=${()=>s("runnableUnit","command")} /> Command</label>
					</div>
				</div>
				<label class="exp-label">${a.runnableUnit==="goal"?"Goal spec":"Command"} body
					<textarea class="exp-input exp-mono" data-testid="experiment-runner-body" rows="4"
						placeholder=${a.runnableUnit==="goal"?"A goal spec template\u2026":'A shell command emitting { "metric": <name>, "value": <n> } on stdout\u2026'}
						.value=${x(a.body)} @input=${i=>s("body",i.currentTarget.value)}></textarea>
				</label>
				<label class="exp-label">Workflow (optional)
					<input class="exp-input" data-testid="experiment-runner-workflow" type="text"
						placeholder="workflow id (optional)" .value=${x(a.workflowId)}
						@input=${i=>s("workflowId",i.currentTarget.value)} />
				</label>
			</section>
		`}function Y(e,t,r,a,s){let i=p=>p.length?p:J(),c=(p,b,m)=>a(u=>{let v=u.slice();return v[p]={...v[p],[b]:m},v}),d=p=>a(b=>{let m=b.slice();return m.splice(p,1),i(m)}),o=()=>a(p=>[...p,{key:"",value:""}]);return n`
			<div class="exp-kv" data-testid=${s}>
				${f(r).map((p,b)=>n`
					<div class="exp-kv-row">
						<input class="exp-input exp-kv-key" type="text" placeholder="key" .value=${x(p.key)}
							@input=${m=>c(b,"key",m.currentTarget.value)} />
						<input class="exp-input exp-kv-val" type="text" placeholder="value" .value=${x(p.value)}
							@input=${m=>c(b,"value",m.currentTarget.value)} />
						<button class="exp-icon-btn" type="button" title="Remove" aria-label="Remove key"
							@click=${()=>d(b)}>✕</button>
					</div>`)}
				<button class="exp-btn secondary tiny" type="button" @click=${o}>+ Add key</button>
			</div>
		`}function xe(e,t,r){let a=f(r.metrics),s=(i,c)=>T(e,t,d=>{let o=f(d.metrics).slice();c.primary&&o.forEach((p,b)=>{o[b]={...p,primary:b===i}}),o[i]={...o[i],...c},d.metrics=o});return n`
			<section class="exp-card" data-testid="experiment-runner-metrics">
				<h2 class="exp-h2">Metrics</h2>
				<p class="exp-hint">What to collect for every run — editable later without a re-run.</p>
				<table class="exp-table">
					<thead><tr><th>Collect</th><th>Metric</th><th>Aggregation</th><th>Direction</th><th>Primary</th></tr></thead>
					<tbody>
						${a.map((i,c)=>n`<tr data-testid="experiment-runner-metric-row" data-metric=${i.metric}>
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
		`}function be(e,t,r){let a=r.ab||{},s=f(a.variants),i=b=>T(e,t,m=>{m.ab={...m.ab,...b}}),c=(b,m)=>T(e,t,u=>{let v=f(u.ab.variants).slice();v[b]={...v[b],...m},u.ab={...u.ab,variants:v}}),d=b=>T(e,t,m=>{let u=f(m.ab.variants).slice();u.splice(b,1),m.ab={...m.ab,variants:u}}),o=b=>T(e,t,m=>{let u=f(m.ab.variants).slice(),v=b!=null?u[b]:null;u.push({label:`variant-${u.length+1}`,metadata:v?v.metadata.map(C=>({...C})):J(),rolesJson:v?v.rolesJson:"",rolesOpen:!1}),m.ab={...m.ab,variants:u}}),p=y(a.repeats);return n`
			<section class="exp-card" data-testid="experiment-runner-ab-form">
				<h2 class="exp-h2">Variants</h2>
				${s.map((b,m)=>n`
					<div class="exp-variant" data-testid="experiment-runner-variant-row" data-variant-index=${m}>
						<div class="exp-variant-head">
							<input class="exp-input" type="text" data-testid="experiment-runner-variant-label" placeholder="variant label"
								.value=${x(b.label)} @input=${u=>c(m,{label:u.currentTarget.value})} />
							<button class="exp-btn secondary tiny" type="button" @click=${()=>o(m)}>Duplicate</button>
							<button class="exp-btn secondary tiny" type="button" data-testid="experiment-runner-remove-variant"
								?disabled=${s.length<=2}
								title=${s.length<=2?"A/B needs at least two variants":"Remove variant"}
								@click=${()=>d(m)}>Remove</button>
						</div>
						<div class="exp-field-label">Metadata treatment</div>
						${Y(e,t,b.metadata,u=>T(e,t,v=>{let C=f(v.ab&&v.ab.variants).slice(),L=f(C[m]&&C[m].metadata).slice();C[m]={...C[m],metadata:u(L)},v.ab={...v.ab,variants:C}}),"experiment-runner-variant-metadata")}
						<details class="exp-details" ?open=${b.rolesOpen}>
							<summary @click=${()=>c(m,{rolesOpen:!b.rolesOpen})}>Advanced: per-arm roles</summary>
							<textarea class="exp-input exp-mono" rows="3" placeholder='{"coder": {"model": "…"}}'
								.value=${x(b.rolesJson)} @input=${u=>c(m,{rolesJson:u.currentTarget.value})}></textarea>
						</details>
					</div>`)}
				<button class="exp-btn secondary" type="button" data-testid="experiment-runner-add-variant" @click=${()=>o(null)}>+ Add variant</button>

				<div class="exp-grid2">
					<label class="exp-label">Repeats per variant
						<input class="exp-input" type="number" min="1" max="20" data-testid="experiment-runner-repeats"
							.value=${x(a.repeats)} @input=${b=>i({repeats:b.currentTarget.value})} />
						${p>10?n`<span class="exp-warn-hint">high run count</span>`:l}
					</label>
					<label class="exp-label">Concurrency cap
						<input class="exp-input" type="number" min="1" max="8" data-testid="experiment-runner-concurrency"
							.value=${x(a.concurrency)} @input=${b=>i({concurrency:b.currentTarget.value})} />
					</label>
				</div>
				<label class="exp-checkbox"><input type="checkbox" data-testid="experiment-runner-same-bar"
					?checked=${a.sameCompletionBar!==!1} @change=${b=>i({sameCompletionBar:b.currentTarget.checked})} />
					Only aggregate runs that reached the same completion bar</label>
				<label class="exp-label">Per-run budget (USD, the fixed comparable budget)
					<input class="exp-input" type="number" min="0" step="0.5" data-testid="experiment-runner-per-run-budget"
						placeholder="e.g. 0.80" .value=${x(r.perRunBudget)}
						@input=${b=>T(e,t,m=>{m.perRunBudget=b.currentTarget.value})} />
				</label>
			</section>
		`}function me(e,t,r){let a=r.auto||{},s=o=>T(e,t,p=>{p.auto={...p.auto,...o}}),i=o=>T(e,t,p=>{p.auto={...p.auto,caps:{...p.auto.caps,...o}}}),c=o=>T(e,t,p=>{p.auto={...p.auto,stops:{...p.auto.stops,...o}}}),d=f(r.metrics).map(o=>o.metric);return n`
			<div class="exp-warn-banner" data-testid="experiment-runner-autoresearch-banner">
				Autonomous optimization — runs unattended until a cap or stop condition is hit. Candidates failing verification are rejected even if the objective improves.
			</div>
			<section class="exp-card" data-testid="experiment-runner-auto-objective">
				<h2 class="exp-h2">Objective</h2>
				<div class="exp-grid2">
					<label class="exp-label">Objective metric
						<select class="exp-input" data-testid="experiment-runner-objective-metric" @change=${o=>s({objectiveMetric:o.currentTarget.value})}>
							${d.map(o=>n`<option value=${o} ?selected=${a.objectiveMetric===o}>${o}</option>`)}
						</select>
					</label>
					<div class="exp-label">Direction
						<div class="exp-radio-row" role="radiogroup" aria-label="Objective direction">
							<label class="exp-radio"><input type="radio" name="exp-dir-${D(t)}" data-testid="experiment-runner-direction-maximize"
								?checked=${a.direction!=="minimize"} @change=${()=>s({direction:"maximize"})} /> maximize</label>
							<label class="exp-radio"><input type="radio" name="exp-dir-${D(t)}" data-testid="experiment-runner-direction-minimize"
								?checked=${a.direction==="minimize"} @change=${()=>s({direction:"minimize"})} /> minimize</label>
						</div>
					</div>
				</div>
				<label class="exp-label">Correctness gate (optional workflow gate)
					<input class="exp-input" type="text" data-testid="experiment-runner-correctness-gate" placeholder="review-findings gate id (optional)"
						.value=${x(a.correctnessGateId)} @input=${o=>s({correctnessGateId:o.currentTarget.value})} />
					<span class="exp-hint">Candidates failing verification are rejected even if the objective improves.</span>
				</label>
				<div class="exp-field-label">Search seed (iteration-0 candidate)</div>
				${Y(e,t,a.seed,o=>T(e,t,p=>{p.auto={...p.auto,seed:o(f(p.auto&&p.auto.seed).slice())}}),"experiment-runner-seed-metadata")}
			</section>

			<section class="exp-card" data-testid="experiment-runner-auto-caps">
				<h2 class="exp-h2">Caps <span class="exp-req">— at least one required</span></h2>
				<div class="exp-grid2">
					<label class="exp-label">Max iterations
						<input class="exp-input" type="number" min="1" data-testid="experiment-runner-cap-max-iterations"
							.value=${x(a.caps.maxIterations)} @input=${o=>i({maxIterations:o.currentTarget.value})} />
					</label>
					<label class="exp-label">Wall-clock cap (hours)
						<input class="exp-input" type="number" min="0" step="0.5" data-testid="experiment-runner-cap-wallclock"
							.value=${x(a.caps.wallClockHours)} @input=${o=>i({wallClockHours:o.currentTarget.value})} />
					</label>
					<label class="exp-label">Cost cap (USD)
						<input class="exp-input" type="number" min="0" step="1" data-testid="experiment-runner-cap-cost"
							.value=${x(a.caps.costUsd)} @input=${o=>i({costUsd:o.currentTarget.value})} />
					</label>
					<label class="exp-label">Per-iteration budget (USD, required)
						<input class="exp-input" type="number" min="0" step="0.5" data-testid="experiment-runner-per-iter-budget"
							.value=${x(a.caps.perIterBudget)} @input=${o=>i({perIterBudget:o.currentTarget.value})} />
					</label>
				</div>
			</section>

			<section class="exp-card" data-testid="experiment-runner-auto-stops">
				<h2 class="exp-h2">Stop conditions <span class="exp-req">— at least one required</span></h2>
				<div class="exp-grid2">
					<label class="exp-label">Plateau over K iterations
						<input class="exp-input" type="number" min="1" data-testid="experiment-runner-stop-plateau"
							.value=${x(a.stops.plateauK)} @input=${o=>c({plateauK:o.currentTarget.value})} />
					</label>
					<label class="exp-label">Target value
						<input class="exp-input" type="number" step="any" data-testid="experiment-runner-stop-target"
							.value=${x(a.stops.target)} @input=${o=>c({target:o.currentTarget.value})} />
					</label>
				</div>
				<details class="exp-details">
					<summary>Advanced: search strategy</summary>
					<div class="exp-grid2">
						<label class="exp-label">Strategy
							<select class="exp-input" @change=${o=>s({strategy:o.currentTarget.value})}>
								<option value="greedy" ?selected=${a.strategy!=="best-of-batch"}>greedy</option>
								<option value="best-of-batch" ?selected=${a.strategy==="best-of-batch"}>best-of-batch</option>
							</select>
						</label>
						<label class="exp-label">Batch size
							<input class="exp-input" type="number" min="1" max="8" .value=${x(a.batchSize)}
								@input=${o=>s({batchSize:o.currentTarget.value})} />
						</label>
					</div>
				</details>
			</section>
		`}function ge(e,t,r,a){if(r.mode==="autoresearch"){let s=f(a.checklist);return n`
				<footer class="exp-projection" data-testid="experiment-runner-projection">
					<div class="exp-proj-stats">
						<span data-testid="experiment-runner-cost">${a.estCostMax!=null?`\u2264 ${O(a.estCostMax)}`:"cost unbounded by iterations"}</span>
						${a.hasStop?n`<span class="exp-pos">stop set</span>`:l}
					</div>
					${s.length?n`<ul class="exp-checklist" data-testid="experiment-runner-guardrail-checklist">
						${s.map(i=>n`<li class="exp-neg">✗ ${i}</li>`)}
					</ul>`:l}
					${f(a.errors).length?n`<ul class="exp-checklist" data-testid="experiment-runner-error">
						${a.errors.map(i=>n`<li class="exp-neg">✗ ${i}</li>`)}
					</ul>`:l}
					<label class="exp-checkbox danger"><input type="checkbox" data-testid="experiment-runner-confirm-ack"
						?checked=${!!r.confirmAck} @change=${i=>T(e,t,c=>{c.confirmAck=i.currentTarget.checked})} />
						I understand this runs autonomously and may cost ${a.estCostMax!=null?`up to ${O(a.estCostMax)}`:"an unbounded amount until a cap is hit"}.</label>
					<button class="exp-btn primary" type="button" data-testid="experiment-runner-review-launch" ?disabled=${!a.valid}
						title=${a.valid?"Review & launch":"Set caps + stop condition + acknowledge"}
						@click=${()=>q(e,t,"confirm")}>Review &amp; launch →</button>
				</footer>
			`}return n`
			<footer class="exp-projection" data-testid="experiment-runner-projection">
				<div class="exp-proj-stats">
					<span data-testid="experiment-runner-run-count">${f(r.ab&&r.ab.variants).length} variants × ${y(r.ab&&r.ab.repeats)||0} repeats = ${a.runCount} runs</span>
					<span data-testid="experiment-runner-cost">${a.estCostMax!=null?`est. \u2264 ${O(a.estCostMax)}`:"est. \u2014 set a per-run budget"}</span>
					<span>~${y(r.ab&&r.ab.concurrency)||1} concurrent</span>
				</div>
				${f(a.errors).length?n`<ul class="exp-checklist" data-testid="experiment-runner-error">
					${a.errors.map(s=>n`<li class="exp-neg">✗ ${s}</li>`)}
				</ul>`:l}
				<button class="exp-btn primary" type="button" data-testid="experiment-runner-review-launch" ?disabled=${!a.valid}
					title=${a.valid?"Review & launch":f(a.errors)[0]||"Complete the form"}
					@click=${()=>q(e,t,"confirm")}>Review &amp; launch →</button>
			</footer>
		`}function fe(e,t,r){let a=te(r);return n`
			<div class="exp-view exp-define" data-testid="experiment-runner-view-define" data-mode=${r.mode||"ab"}>
				<div class="exp-define-head">
					<button class="exp-btn link" type="button" @click=${()=>q(e,t,"mode-select")}>← mode</button>
					<span class="exp-mode-badge ${r.mode==="autoresearch"?"warn":""}">${r.mode==="autoresearch"?"AUTORESEARCH":"A/B"}</span>
				</div>
				${ue(e,t,r)}
				${r.mode==="autoresearch"?me(e,t,r):be(e,t,r)}
				${xe(e,t,r)}
				${ge(e,t,r,a)}
			</div>
		`}function ve(e,t,r){let a=te(r),s=r.mode==="autoresearch",i=M.get(t)||{};return n`
			<div class="exp-view" data-testid="experiment-runner-view-confirm">
				<h1 class="exp-h1">Confirm launch</h1>
				<section class="exp-card">
					<div class="exp-confirm-row"><span>Mode</span><strong>${s?"Autoresearch":"A/B comparison"}</strong></div>
					<div class="exp-confirm-row"><span>Name</span><strong>${x(r.basics&&r.basics.name)}</strong></div>
					${s?n`
							<div class="exp-confirm-row"><span>Objective</span><strong>${x(r.auto&&r.auto.objectiveMetric)} (${x(r.auto&&r.auto.direction)})</strong></div>
							<div class="exp-confirm-row"><span>Caps</span><strong>${x(y(r.auto.caps.maxIterations)?`\u2264 ${y(r.auto.caps.maxIterations)} iters`:"")} ${y(r.auto.caps.wallClockHours)?`\u2264 ${y(r.auto.caps.wallClockHours)}h`:""} ${y(r.auto.caps.costUsd)?`\u2264 ${O(y(r.auto.caps.costUsd))}`:""}</strong></div>
							<div class="exp-confirm-row"><span>Worst-case cost</span><strong>${a.estCostMax!=null?`\u2264 ${O(a.estCostMax)}`:"unbounded by iterations"}</strong></div>
							<div class="exp-confirm-note">A candidate that fails verification is discarded even if its objective improved.</div>`:n`
							<div class="exp-confirm-row"><span>Fan-out</span><strong>${a.runCount} child goals (${f(r.ab.variants).length} variants × ${y(r.ab.repeats)} repeats)</strong></div>
							<div class="exp-confirm-row"><span>Projected cost</span><strong>${a.estCostMax!=null?`\u2264 ${O(a.estCostMax)}`:"\u2014"}</strong></div>`}
				</section>
				${i.launchError?n`<div class="exp-error-box" data-testid="experiment-runner-launch-error">${i.launchError}</div>`:l}
				<div class="exp-confirm-actions">
					<button class="exp-btn secondary" type="button" @click=${()=>q(e,t,"define")}>← Back</button>
					<button class="exp-btn primary" type="button" data-testid="experiment-runner-launch" ?disabled=${!a.valid||i.launching}
						@click=${()=>ie(e,t)}>${i.launching?"Launching\u2026":s?`Launch loop (\u2264 ${a.estCostMax!=null?O(a.estCostMax):"capped"})`:`Launch ${a.runCount} runs`}</button>
				</div>
			</div>
		`}function Z(e){let t=e&&Array.isArray(e.spec)?e.spec:e&&e.spec&&Array.isArray(e.spec.widgets)?e.spec.widgets:null;return t&&t.length?t:e&&e.def&&e.def.mode==="autoresearch"?[{type:"summary-cards",title:"Summary"},{type:"objective-curve",title:"Best objective vs iteration"},{type:"ledger-table",title:"Ledger"},{type:"raw-drilldown",title:"Iterations"}]:[{type:"summary-cards",title:"Summary"},{type:"comparison-table",title:"Comparison"},{type:"score-bars",title:"Secondary metrics"},{type:"raw-drilldown",title:"Runs"}]}let F=e=>e&&(e.metricId||e.metric)||void 0;function G(e){let r=f(e&&e.metrics).filter(a=>a.collect!==!1).map(F).filter(Boolean);return r.length?r:["objective.value","cost.totalUsd","time.wallClockMs"]}function he(e){let r=f(e&&e.metrics).find(a=>a.primary);return r?F(r):e&&e.def&&e.def.objective?e.def.objective.metricId||e.def.objective.metric:G(e)[0]}let _=(e,t)=>{let r=e&&e.metrics,a=r?r[t]:void 0;return Number.isFinite(Number(a))?Number(a):a&&Number.isFinite(Number(a.value))?Number(a.value):void 0};function Q(e){let t=new Map;for(let r of f(e&&e.runs)){let a=x(r.armId,"arm");t.has(a)||t.set(a,[]),t.get(a).push(r)}return t}function $e(e,t){let r=G(t),a=!(t.def&&t.def.sameCompletionBar===!1),s=Q(t),i=f(t.metrics),c=d=>(i.find(o=>F(o)===d)||{}).aggregation||"median";return n`<table class="exp-table" data-testid="experiment-runner-widget-comparison-table">
			<thead><tr><th>Variant</th>${r.map(d=>n`<th class="exp-mono">${d}</th>`)}<th>n</th></tr></thead>
			<tbody>
				${[...s.entries()].map(([d,o])=>{let p=a?o.filter(m=>m.completionBar==="passed"):o,b=p.length?p:o;return n`<tr data-testid="experiment-runner-comparison-arm" data-arm=${d}>
						<td><strong>${d}</strong></td>
						${r.map(m=>n`<td class="exp-mono">${B(ee(b.map(u=>_(u,m)),c(m)))}</td>`)}
						<td>${b.length}</td>
					</tr>`})}
			</tbody>
		</table>`}function ye(e,t){let r=G(t),a=Q(t);return n`<div class="exp-scorebars" data-testid="experiment-runner-widget-score-bars">
			${r.map((s,i)=>{let c=[...a.entries()].map(([o,p])=>({arm:o,v:ee(p.map(b=>_(b,s)),"median")})),d=Math.max(1,...c.map(o=>Number.isFinite(o.v)?Math.abs(o.v):0));return n`<div class="exp-scorebar-group"><div class="exp-field-label exp-mono">${s}</div>
					${c.map(o=>n`<div class="exp-scorebar-row"><span class="exp-scorebar-label">${o.arm}</span>
						<span class="exp-scorebar-track"><span class="exp-scorebar-fill" style=${`width:${Math.round((Number.isFinite(o.v)?Math.abs(o.v):0)/d*100)}%;background:var(--chart-${i%6+1})`}></span></span>
						<span class="exp-mono">${B(o.v)}</span></div>`)}
				</div>`})}
		</div>`}function we(e,t){let r=he(t),a=t.def&&t.def.objective&&t.def.objective.direction||"maximize",s=f(t.runs).filter(o=>o.iteration!=null).sort((o,p)=>o.iteration-p.iteration),i=null,c=s.map(o=>{let p=_(o,r);return Number.isFinite(p)&&(i=i==null?p:a==="minimize"?Math.min(i,p):Math.max(i,p)),{iteration:o.iteration,v:p,best:i,kept:o.verified!==!1&&o.completionBar!=="failed"}}),d=y(t.def&&t.def.stop&&t.def.stop.target);return n`<div data-testid="experiment-runner-widget-objective-curve">
			${d!=null?n`<div class="exp-hint">target ${a==="minimize"?"\u2264":"\u2265"} ${B(d)}</div>`:l}
			<table class="exp-table"><thead><tr><th>Iter</th><th>objective</th><th>best</th><th>verdict</th></tr></thead>
				<tbody>${c.map(o=>n`<tr><td>${o.iteration}</td><td class="exp-mono">${B(o.v)}</td><td class="exp-mono exp-pos">${B(o.best)}</td><td>${o.kept?n`<span class="exp-pos">●</span>`:n`<span class="exp-neg">○</span>`}</td></tr>`)}</tbody>
			</table>
		</div>`}function ke(e,t){let r=f(t.ledger);return n`<table class="exp-table" data-testid="experiment-runner-widget-ledger-table">
			<thead><tr><th>Iter</th><th>verdict</th><th>objective</th><th>best</th></tr></thead>
			<tbody>${r.map(a=>{let s=x(a.verdict||a.decision,"\u2014"),i=/kept|accept/i.test(s)?"exp-pos":/verification|failed/i.test(s)?"exp-neg":"exp-muted";return n`<tr data-testid="experiment-runner-ledger-row"><td>${x(a.iteration)}</td><td class=${i}>${s}</td><td class="exp-mono">${B(y(a.objective))}</td><td class="exp-mono">${B(y(a.best))}</td></tr>`})}</tbody>
		</table>`}function Ce(e,t){let r=f(t.runs),a=r.filter(c=>["settled","collected","failed"].includes(c.status)).length,s=r.filter(c=>c.completionBar==="passed").length,i=r.reduce((c,d)=>c+(y(d.cost&&d.cost.totalUsd)||_(d,"cost.totalUsd")||0),0);return n`<div class="exp-cards" data-testid="experiment-runner-widget-summary-cards">
			<div class="exp-stat"><span class="exp-stat-n">${r.length}</span><span class="exp-stat-l">runs</span></div>
			<div class="exp-stat"><span class="exp-stat-n">${a}</span><span class="exp-stat-l">settled</span></div>
			<div class="exp-stat"><span class="exp-stat-n exp-pos">${s}</span><span class="exp-stat-l">passed bar</span></div>
			<div class="exp-stat"><span class="exp-stat-n">${O(i)}</span><span class="exp-stat-l">spend</span></div>
		</div>`}function Se(e,t){let r=G(t),a=f(t.runs);return n`<table class="exp-table" data-testid="experiment-runner-widget-raw-drilldown">
			<thead><tr><th>run</th><th>arm</th><th>${t.def&&t.def.mode==="autoresearch"?"iter":"rep"}</th><th>status</th><th>bar</th>${r.map(s=>n`<th class="exp-mono">${s}</th>`)}</tr></thead>
			<tbody>${a.map(s=>{let i=t.def&&t.def.sameCompletionBar!==!1&&s.completionBar&&s.completionBar!=="passed";return n`<tr class=${i?"exp-excluded":""} data-testid="experiment-runner-run-row" data-run=${x(s.runId)}>
					<td class="exp-mono">${x(s.runId)}</td><td>${x(s.armId)}</td>
					<td>${x(s.iteration!=null?s.iteration:s.repeat)}</td>
					<td>${x(s.status)}</td><td>${x(s.completionBar)}${i?n` <span class="exp-tag">excluded</span>`:l}</td>
					${r.map(c=>n`<td class="exp-mono">${B(_(s,c))}</td>`)}
				</tr>`})}</tbody>
		</table>`}let Ie={"comparison-table":$e,"score-bars":ye,"objective-curve":we,"ledger-table":ke,"summary-cards":Ce,"raw-drilldown":Se};function Te(e){try{let t=document.createElement("div");return t.setAttribute("data-testid","experiment-runner-report-html"),t.innerHTML=String(e),t}catch{return l}}function Re(e,t,r){if(r.report&&typeof r.report.html=="string"&&r.report.html.trim())return n`<div class="exp-dashboard-body" data-testid="experiment-runner-dashboard-body">${Te(r.report.html)}</div>`;let a=Z(r);return n`<div class="exp-dashboard-body" data-testid="experiment-runner-dashboard-body">
			${a.map(s=>{let i=Ie[s.type];return n`<section class="exp-widget exp-card" data-testid="experiment-runner-widget" data-widget-type=${s.type}>
					<h3 class="exp-widget-title">${x(s.title,s.type)}</h3>
					${i?i(e,r):n`<div class="exp-hint">Unknown widget: ${s.type}</div>`}
				</section>`})}
		</div>`}function Me(e,t,r){let a=Z(r).slice(),s=u=>E(e,t,{dashboardDraftSpec:u}),i=M.get(t)||{},c=i.dashboardDraftSpec||a,d=(u,v)=>{let C=c.slice(),L=u+v;L<0||L>=C.length||([C[u],C[L]]=[C[L],C[u]],s(C))},o=u=>{let v=c.slice();v.splice(u,1),s(v)},p=u=>s([...c,{type:u,title:(K.find(v=>v.id===u)||{}).label||u}]),b=(u,v)=>{let C=c.slice();C[u]={...C[u],title:v},s(C)},m=i.widgetTypes&&i.widgetTypes.length?i.widgetTypes:K;return n`<div class="exp-card" data-testid="experiment-runner-dashboard-editor">
			<h3 class="exp-h2">Edit dashboard</h3>
			${c.map((u,v)=>n`<div class="exp-editor-row" data-testid="experiment-runner-editor-widget" data-widget-type=${u.type}>
				<input class="exp-input" type="text" .value=${x(u.title)} @input=${C=>b(v,C.currentTarget.value)} />
				<span class="exp-badge exp-mono">${u.type}</span>
				<button class="exp-icon-btn" type="button" title="Move up" @click=${()=>d(v,-1)}>↑</button>
				<button class="exp-icon-btn" type="button" title="Move down" @click=${()=>d(v,1)}>↓</button>
				<button class="exp-icon-btn" type="button" title="Remove" @click=${()=>o(v)}>✕</button>
			</div>`)}
			<div class="exp-editor-add">
				<select class="exp-input" data-testid="experiment-runner-add-widget-type">
					${m.map(u=>n`<option value=${u.id}>${u.label||u.id}</option>`)}
				</select>
				<button class="exp-btn secondary" type="button" data-testid="experiment-runner-add-widget"
					@click=${u=>{let v=u.currentTarget.parentElement.querySelector("select");p(v.value)}}>+ Add widget</button>
			</div>
			<div class="exp-confirm-actions">
				<button class="exp-btn secondary" type="button" @click=${()=>E(e,t,{dashboardEditing:!1,dashboardDraftSpec:void 0})}>Cancel</button>
				<button class="exp-btn primary" type="button" data-testid="experiment-runner-save-dashboard"
					@click=${()=>{E(e,t,{dashboardDraftSpec:void 0}),le(e,t,r.experimentId,c)}}>Save dashboard</button>
			</div>
		</div>`}function Ae(e,t,r){let a=M.get(t)||{},s=a.dashboard,i=()=>E(e,t,{dashboard:null})&&T(e,t,v=>{Object.assign(v,H())});if(a.dashboardLoading&&!s)return n`<div class="exp-view" data-testid="experiment-runner-view-dashboard"><div class="exp-hint">Loading experiment…</div></div>`;if(!s)return n`<div class="exp-view" data-testid="experiment-runner-view-dashboard">
				<div class="exp-empty">No experiment loaded.</div>
				<button class="exp-btn primary" type="button" data-testid="experiment-runner-new-experiment" @click=${i}>New experiment</button>
			</div>`;let c=s.def||{},d=s.state||{},o=c.mode==="autoresearch",p=x(d.status,"running"),b=f(s.runs),m=b.filter(v=>["settled","collected","failed"].includes(v.status)).length,u=d.stopReason?`stopped: ${d.stopReason}`:p;return n`
			<div class="exp-view" data-testid="experiment-runner-view-dashboard" data-experiment-id=${s.experimentId}>
				<header class="exp-dash-head">
					<div class="exp-dash-titles">
						<span class="exp-mode-badge ${o?"warn":""}">${o?"AUTORESEARCH":"A/B"}</span>
						<h1 class="exp-h1">${x(c.title,s.experimentId)}</h1>
					</div>
					<div class="exp-dash-meta">
						<span class="exp-status" data-testid="experiment-runner-status" role="status">${p==="running"?`running ${m}/${b.length}`:u}</span>
					</div>
					<div class="exp-dash-actions">
						${p==="running"?n`<button class="exp-btn secondary" type="button" data-testid="experiment-runner-stop" @click=${()=>ce(e,t,s.experimentId)}>Stop experiment</button>`:l}
						<button class="exp-btn secondary" type="button" data-testid="experiment-runner-refresh" @click=${()=>N(e,t,s.experimentId)}>Refresh</button>
						<button class="exp-btn secondary" type="button" data-testid="experiment-runner-edit-dashboard"
							@click=${()=>E(e,t,{dashboardEditing:!a.dashboardEditing,dashboardDraftSpec:void 0})}>${a.dashboardEditing?"Close editor":"Edit dashboard"}</button>
						<button class="exp-btn link" type="button" data-testid="experiment-runner-new-experiment" @click=${i}>New experiment</button>
					</div>
				</header>
				${a.dashboardEditing?Me(e,t,s):l}
				<details class="exp-details" data-testid="experiment-runner-metrics-panel">
					<summary>Metrics — edit what is collected (re-extracts from stored outcomes, no re-run)</summary>
					${Ee(e,t,s)}
				</details>
				${Re(e,t,s)}
			</div>
		`}function Ee(e,t,r){let a=f(r.metrics).length?f(r.metrics):ae(),s=(i,c)=>{let d=a.map((o,p)=>p===i?{...o,collect:c}:o);E(e,t,{dashboard:{...r,metrics:d}}),de(e,t,r.experimentId,d)};return n`<table class="exp-table">
			<thead><tr><th>Collect</th><th>Metric</th></tr></thead>
			<tbody>${a.map((i,c)=>n`<tr><td><input type="checkbox" data-testid="experiment-runner-dash-metric-collect" data-metric=${F(i)}
				?checked=${i.collect!==!1} @change=${d=>s(c,d.currentTarget.checked)} /></td><td class="exp-mono">${F(i)}</td></tr>`)}</tbody>
		</table>`}let ze=`
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
	`;return{render(e,t){let r=e&&typeof e.__sessionId=="string"?e.__sessionId:"",a=e&&typeof e.experimentId=="string"?e.experimentId:"",s=e&&typeof e.view=="string"?e.view:void 0,i=r||"experiment-runner",c=re(t,i,a,s),d=c&&c.draft||H(),o=d.view||"mode-select",p;return o==="dashboard"?p=Ae(t,i,d):o==="confirm"?p=ve(t,i,d):o==="define"?p=fe(t,i,d):p=pe(t,i,d),n`
				<style>${ze}</style>
				<div class="exp-root" data-testid="experiment-runner-panel-root" data-view=${o} data-mode=${d.mode||""}>
					${p}
				</div>
			`}}}export{Je as default};
