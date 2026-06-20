var je=["cost.totalUsd","cost.tokensTotal","cost.cacheHitRate","gates.passRate","gates.firstPassClean","tasks.completionRate","time.wallClockMs","objective.value","command.metric"],Be={"cost.totalUsd":"lower-better","cost.tokensTotal":"lower-better","cost.cacheHitRate":"higher-better","gates.passRate":"higher-better","gates.firstPassClean":"higher-better","tasks.completionRate":"higher-better","time.wallClockMs":"lower-better","objective.value":"higher-better","command.metric":"neutral"},Oe=new Set(["cost.totalUsd","time.wallClockMs","gates.passRate","objective.value"]),K=[{id:"comparison-table",label:"Comparison table"},{id:"score-bars",label:"Score bars"},{id:"objective-curve",label:"Objective curve"},{id:"ledger-table",label:"Ledger"},{id:"summary-cards",label:"Summary cards"},{id:"raw-drilldown",label:"Raw runs"}],Ne=["median","mean","p90","min","max","count"],A={exp:n=>`exp/${n}`,state:n=>`exp/${n}/state`,runPrefix:n=>`exp/${n}/run/`,ledger:n=>`exp/${n}/ledger`,dashboard:n=>`exp/${n}/dashboard`,metrics:n=>`exp/${n}/metrics`,index:"index/experiments",draft:n=>`drafts/${n}`},De="bobbit:experiment-runner:draft:",v=n=>Array.isArray(n)?n:[],u=(n,l="")=>n==null?l:String(n),y=n=>{let l=Number(n);return Number.isFinite(l)?l:void 0},D=n=>u(n,"exp").replace(/[^a-zA-Z0-9_-]+/g,"-").replace(/^-+|-+$/g,"")||"exp";function Ue(n){let l=u(n).trim();if(l==="")return"";if(/^-?\d+(\.\d+)?$/.test(l))return Number(l);if(l==="true")return!0;if(l==="false")return!1;if(l.startsWith("{")&&l.endsWith("}")||l.startsWith("[")&&l.endsWith("]"))try{return JSON.parse(l)}catch{}return l}function V(n){let l={};for(let w of v(n)){let $=u(w&&w.key).trim();$&&(l[$]=Ue(w&&w.value))}return l}function W(n){let l=u(n).trim();if(l)try{let w=JSON.parse(l);return w&&typeof w=="object"?w:void 0}catch{return}}var Pe=n=>{let l=n.filter($=>Number.isFinite($)).slice().sort(($,k)=>$-k);if(!l.length)return;let w=Math.floor(l.length/2);return l.length%2?l[w]:(l[w-1]+l[w])/2},ee=(n,l)=>{let w=n.filter($=>Number.isFinite($));if(l==="count")return w.length;if(w.length)switch(l){case"mean":return w.reduce(($,k)=>$+k,0)/w.length;case"min":return Math.min(...w);case"max":return Math.max(...w);case"p90":{let $=w.slice().sort((k,S)=>k-S);return $[Math.min($.length-1,Math.floor(.9*$.length))]}default:return Pe(w)}},O=n=>{if(n==null||!Number.isFinite(n))return"\u2014";let l=Math.abs(n);return l!==0&&l<.01?n.toExponential(2):Number.isInteger(n)?String(n):n.toFixed(l>=100?1:3)},N=n=>n==null||!Number.isFinite(n)?"\u2014":`$${n.toFixed(2)}`;function q(){return[{key:"",value:""}]}function ae(){return je.map(n=>({metric:n,source:"built-in",collect:Oe.has(n),aggregation:"median",direction:Be[n]||"neutral",primary:n==="gates.passRate"}))}function H(){return{view:"mode-select",mode:null,experimentId:void 0,basics:{name:"",runnableUnit:"command",body:"",workflowId:""},ab:{variants:[{label:"baseline",metadata:q(),rolesJson:"",rolesOpen:!1},{label:"variant-b",metadata:q(),rolesJson:"",rolesOpen:!1}],repeats:3,sameCompletionBar:!0,concurrency:3},auto:{objectiveMetric:"objective.value",direction:"maximize",correctnessGateId:"",seed:q(),seedRolesJson:"",caps:{maxIterations:"",wallClockHours:"",costUsd:"",perIterBudget:""},stops:{plateauK:"",target:""},strategy:"greedy",batchSize:""},metrics:ae(),perRunBudget:"",confirmAck:!1}}var E=globalThis.__bobbitExperimentRunnerState||(globalThis.__bobbitExperimentRunnerState=new Map);function Le(n){let l=[],w=n.basics||{};u(w.name).trim()||l.push("Name is required"),u(w.body).trim()||l.push("Spec / command body is required");let $=v(n.ab&&n.ab.variants);$.length<2&&l.push("A/B needs at least two variants");let k=new Set,S=[];$.forEach((I,j)=>{let L=u(I.label).trim();L?k.has(L)&&l.push(`Variant label "${L}" is duplicated`):l.push(`Variant ${j+1} needs a label`),k.add(L),S.push(JSON.stringify({m:V(I.metadata),r:W(I.rolesJson)||null}))});for(let I=0;I<S.length;I++)for(let j=I+1;j<S.length;j++)S[I]===S[j]&&l.push(`Variant "${u($[j].label).trim()||j+1}" is identical to "${u($[I].label).trim()||I+1}"`);let C=y(n.ab&&n.ab.repeats);(!C||C<1)&&l.push("Repeats must be \u2265 1");let h=y(n.perRunBudget);(!h||h<=0)&&l.push("Set a per-run budget");let T=y(n.ab&&n.ab.concurrency);T!=null&&(T<1||T>8)&&l.push("Concurrency must be 1\u20138"),v(n.metrics).some(I=>I.collect)||l.push("Select at least one metric");let M=$.length*(C||0),P=h?M*h:void 0;return{valid:l.length===0,errors:l,runCount:M,estCostMax:P}}function Fe(n){let l=[],w=[],$=n.basics||{};u($.name).trim()||l.push("Name is required"),u($.body).trim()||l.push("Spec / command body is required");let k=n.auto||{};u(k.objectiveMetric).trim()||l.push("Choose an objective metric");let S=y(k.caps&&k.caps.perIterBudget);(!S||S<=0)&&l.push("Set a per-iteration budget");let C=k.caps||{},h=y(C.maxIterations)>0||y(C.wallClockHours)>0||y(C.costUsd)>0,T=k.stops||{},M=y(T.plateauK)>0||T.target!==""&&Number.isFinite(y(T.target));h||w.push("Set at least one hard cap (max-iterations, wall-clock, or cost)"),M||w.push("Set at least one stop condition (plateau-K or target)"),n.confirmAck||w.push("Acknowledge the autonomous-run warning");let P=y(C.maxIterations),I=y(C.costUsd),j;return S&&P&&(j=P*S),I!=null&&(j=j==null?I:Math.min(j,I)),{valid:l.length===0&&w.length===0,errors:l,checklist:w,estCostMax:j,hasCap:h,hasStop:M}}function te(n){return n.mode==="autoresearch"?Fe(n):Le(n)}function _e(n){let l=n.basics||{},w={"higher-better":"max","lower-better":"min"},$=v(n.metrics).filter(h=>h.collect).map(h=>{let T={metricId:h.metric,aggregation:h.aggregation,primary:!!h.primary},M=w[h.direction];return M&&(T.directionOverride=M),T}),S=l.runnableUnit==="command"?{kind:"command",command:u(l.body)}:{kind:"agent",spec:u(l.body)},C={experimentId:n.experimentId,title:u(l.name).trim(),mode:n.mode==="autoresearch"?"autoresearch":"ab",runnable:S,workflowId:u(l.workflowId).trim()||void 0,metrics:$};if(C.mode==="ab"){let h=n.ab||{};C.variants=v(h.variants).map((T,M)=>({armId:D(u(T.label).trim()||`arm-${M}`),label:u(T.label).trim()||`arm-${M}`,metadata:V(T.metadata),inlineRoles:W(T.rolesJson)})),C.repeats=y(h.repeats)||1,C.sameCompletionBar=h.sameCompletionBar!==!1,C.maxConcurrency=y(h.concurrency)||3,C.perRunBudget=y(n.perRunBudget)}else{let h=n.auto||{};C.objective={metricId:h.objectiveMetric,direction:h.direction==="minimize"?"min":"max"},C.correctnessGateId=u(h.correctnessGateId).trim()||void 0,C.seed={metadata:V(h.seed),inlineRoles:W(h.seedRolesJson)};let T=y(h.caps&&h.caps.wallClockHours);C.caps={maxIterations:y(h.caps&&h.caps.maxIterations),maxWallClockMs:T?T*36e5:void 0,maxCostUsd:y(h.caps&&h.caps.costUsd)};let M=y(h.stops&&h.stops.target);C.stop={plateauK:y(h.stops&&h.stops.plateauK)},M!=null&&(C.stop.target=M),C.strategy=h.strategy==="best-of-batch"?"best-of-batch":"greedy",C.batchSize=y(h.batchSize),C.perRunBudget=y(h.caps&&h.caps.perIterBudget)}return C}function qe({html:n,nothing:l,renderHeader:w}){let $=async(e,t,r)=>{try{if(!e||!e.capabilities||!e.capabilities.callRoute||!e.callRoute)return{ok:!1,error:"routes-unavailable"};let a=await e.callRoute(t,r);return a&&typeof a=="object"&&a.error?{ok:!1,error:a.error}:{ok:!0,data:a}}catch(a){return{ok:!1,error:a&&a.message?String(a.message):String(a)}}},k=async(e,t)=>{try{return e&&e.store&&e.store.get?await e.store.get(t):null}catch{return null}},S=async(e,t,r)=>{try{e&&e.store&&e.store.put&&await e.store.put(t,r)}catch{}},C=async(e,t)=>{try{return e&&e.store&&e.store.list?await e.store.list(t)||[]:[]}catch{return[]}},h=e=>{try{e&&e.requestRender&&e.requestRender()}catch{}},T=(e,t)=>{try{e&&e.capabilities&&e.capabilities.ui&&e.ui&&e.ui.navigate&&e.ui.navigate({route:"experiment-runner",params:t})}catch{}},M=e=>`${De}${D(e)}`,P=e=>{try{let t=globalThis.localStorage&&globalThis.localStorage.getItem(M(e));return t?JSON.parse(t):void 0}catch{return}},I=(e,t)=>{try{globalThis.localStorage&&globalThis.localStorage.setItem(M(e),JSON.stringify(t))}catch{}},j=e=>E.get(e),L=(e,t,r)=>{E.set(t,r),h(e)},z=(e,t,r)=>{let s={...E.get(t)||{},...r};return E.set(t,s),h(e),s},R=(e,t,r)=>{let a=E.get(t)||{},s={...a.draft||H()};r(s);let i={...a,draft:s};E.set(t,i),I(t,s),S(a.host,A.draft(t),s),h(e)};function re(e,t,r,a){let s=E.get(t);return s&&s.hydrated?(s.host=e,r&&s.draft&&s.draft.experimentId!==r&&se(e,t,r,a),s):(s={hydrated:!1,host:e,draft:P(t)||H(),dashboard:null,experiments:[]},E.set(t,s),(async()=>{let i=await k(e,A.draft(t)),c=E.get(t)||s,d=i&&typeof i=="object"?i:c.draft;r&&(d={...d,experimentId:r,view:a||"dashboard"}),E.set(t,{...c,hydrated:!0,draft:d}),h(e),ne(e,t),d.experimentId&&d.view==="dashboard"&&U(e,t,d.experimentId)})(),E.get(t))}let X=e=>({experimentId:e.experimentId,title:u(e.title,e.experimentId),mode:e.mode==="autoresearch"?"autoresearch":"ab"});async function ne(e,t){let r=await $(e,"listExperiments",{method:"GET"}),a=[];if(r.ok&&Array.isArray(r.data))a=r.data.filter(s=>s&&typeof s=="object").map(X);else{let s=v(await k(e,A.index)).filter(c=>typeof c=="string");a=(await Promise.all(s.map(c=>k(e,A.exp(c))))).filter(c=>c&&typeof c=="object").map(X)}z(e,t,{experiments:a})}async function se(e,t,r,a){R(e,t,s=>{s.experimentId=r,s.view=a||"dashboard"}),await U(e,t,r)}async function U(e,t,r){z(e,t,{dashboardLoading:!0});let a,s,i=[],c=[],d,o,p=await $(e,"getExperiment",{method:"GET",query:{experimentId:r}});if(p.ok&&p.data&&p.data.def&&(a=p.data.def,s=p.data.state,i=v(p.data.runs),c=v(p.data.ledger),d=p.data.dashboard,o=p.data.metrics),!a){a=await k(e,A.exp(r)),s=await k(e,A.state(r)),c=v(await k(e,A.ledger(r))),d=await k(e,A.dashboard(r)),o=await k(e,A.metrics(r));let x=await C(e,A.runPrefix(r));for(let f of x){let B=await k(e,f);B&&typeof B=="object"&&i.push(B)}}if(d==null&&(d=await k(e,A.dashboard(r))),!v(o).length){let x=await k(e,A.metrics(r));v(x).length&&(o=x)}let g=x=>v(x).some(f=>f&&f.status==="settled");if(s&&s.status==="running")if(a&&a.mode==="autoresearch"){let x=await $(e,"iterate",{method:"POST",body:{experimentId:r}});x.ok&&x.data&&Array.isArray(x.data.ledger)&&(c=x.data.ledger);let f=await $(e,"getExperiment",{method:"GET",query:{experimentId:r}});f.ok&&f.data&&f.data.def&&(s=f.data.state,i=v(f.data.runs),v(f.data.ledger).length&&(c=f.data.ledger))}else{let x=await $(e,"poll",{method:"POST",body:{experimentId:r}});if(x.ok&&x.data&&Array.isArray(x.data.runs)&&(i=x.data.runs),g(i)){let f=await $(e,"collect",{method:"POST",body:{experimentId:r}});f.ok&&f.data&&Array.isArray(f.data.runs)&&(i=f.data.runs)}if(v(i).some(f=>f&&f.status==="pending")){let f=await $(e,"launch",{method:"POST",body:{experimentId:r}});f.ok&&f.data&&Array.isArray(f.data.launched)&&(i=f.data.launched)}}let m=await $(e,"report",{method:"POST",body:{experimentId:r}}),b=m.ok&&m.data?m.data:null;z(e,t,{dashboardLoading:!1,dashboard:{experimentId:r,def:a,state:s,runs:i,ledger:c,spec:d,metrics:v(o).length?o:a&&a.metrics||[],report:b}})}async function ie(e,t){let a=E.get(t).draft;z(e,t,{launching:!0,launchError:void 0});let s=_e(a),i=await $(e,"defineExperiment",{method:"POST",body:s});if(!i.ok&&i.error!=="routes-unavailable"){z(e,t,{launching:!1,launchError:i.error});return}let c=a.experimentId;i.ok&&i.data&&i.data.experimentId&&(c=i.data.experimentId),c||(c=`${D(s.title)}-${Date.now().toString(36)}`),s.experimentId=c,i.ok||(await S(e,A.exp(c),s),await S(e,A.metrics(c),s.metrics)),await oe(e,t,{experimentId:c,title:s.title,mode:s.mode,status:"running"});let d=s.mode==="autoresearch"?"iterate":"launch",o=await $(e,d,{method:"POST",body:{experimentId:c}});if(!o.ok&&o.error!=="routes-unavailable"){z(e,t,{launching:!1,launchError:o.error});return}R(e,t,p=>{p.experimentId=c,p.view="dashboard"}),z(e,t,{launching:!1}),T(e,{experimentId:c,view:"dashboard"}),await U(e,t,c)}async function oe(e,t,r){let a=v(await k(e,A.index)).filter(c=>typeof c=="string"&&c!==r.experimentId);a.push(r.experimentId),await S(e,A.index,a);let s=E.get(t)||{},i=v(s.experiments).filter(c=>c.experimentId!==r.experimentId);i.push(r),z(e,t,{experiments:i})}async function ce(e,t,r){await $(e,"cancel",{method:"POST",body:{experimentId:r}}),await U(e,t,r)}async function de(e,t,r,a){await $(e,"saveMetrics",{method:"POST",body:{experimentId:r,metrics:a}}),await S(e,A.metrics(r),a),await U(e,t,r)}async function le(e,t,r,a){let s=Array.isArray(a)?{widgets:a}:a&&Array.isArray(a.widgets)?a:{widgets:[]};await $(e,"saveDashboard",{method:"POST",body:{experimentId:r,dashboard:s}}),await S(e,A.dashboard(r),s),z(e,t,{dashboardEditing:!1}),await U(e,t,r)}let G=(e,t,r)=>R(e,t,a=>{a.view=r});function pe(e,t,r){let a=s=>R(e,t,i=>{i.mode=s,i.view="define"});return n`
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
		`}function ue(e,t,r){let a=r.basics||{},s=(i,c)=>R(e,t,d=>{d.basics={...d.basics,[i]:c}});return n`
			<section class="exp-card" data-testid="experiment-runner-basics">
				<h2 class="exp-h2">Experiment basics</h2>
				<label class="exp-label">Experiment name
					<input class="exp-input" data-testid="experiment-runner-name" type="text" maxlength="80"
						placeholder="e.g. retry-temperature-sweep" .value=${u(a.name)}
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
						.value=${u(a.body)} @input=${i=>s("body",i.currentTarget.value)}></textarea>
				</label>
				<label class="exp-label">Workflow (optional)
					<input class="exp-input" data-testid="experiment-runner-workflow" type="text"
						placeholder="workflow id (optional)" .value=${u(a.workflowId)}
						@input=${i=>s("workflowId",i.currentTarget.value)} />
				</label>
			</section>
		`}function Y(e,t,r,a,s){let i=p=>p.length?p:q(),c=(p,g,m)=>a(b=>{let x=b.slice();return x[p]={...x[p],[g]:m},x}),d=p=>a(g=>{let m=g.slice();return m.splice(p,1),i(m)}),o=()=>a(p=>[...p,{key:"",value:""}]);return n`
			<div class="exp-kv" data-testid=${s}>
				${v(r).map((p,g)=>n`
					<div class="exp-kv-row">
						<input class="exp-input exp-kv-key" type="text" placeholder="key" .value=${u(p.key)}
							@input=${m=>c(g,"key",m.currentTarget.value)} />
						<input class="exp-input exp-kv-val" type="text" placeholder="value" .value=${u(p.value)}
							@input=${m=>c(g,"value",m.currentTarget.value)} />
						<button class="exp-icon-btn" type="button" title="Remove" aria-label="Remove key"
							@click=${()=>d(g)}>✕</button>
					</div>`)}
				<button class="exp-btn secondary tiny" type="button" @click=${o}>+ Add key</button>
			</div>
		`}function xe(e,t,r){let a=v(r.metrics),s=(i,c)=>R(e,t,d=>{let o=v(d.metrics).slice();c.primary&&o.forEach((p,g)=>{o[g]={...p,primary:g===i}}),o[i]={...o[i],...c},d.metrics=o});return n`
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
								${Ne.map(d=>n`<option value=${d} ?selected=${i.aggregation===d}>${d}</option>`)}
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
		`}function be(e,t,r){let a=r.ab||{},s=v(a.variants),i=g=>R(e,t,m=>{m.ab={...m.ab,...g}}),c=(g,m)=>R(e,t,b=>{let x=v(b.ab.variants).slice();x[g]={...x[g],...m},b.ab={...b.ab,variants:x}}),d=g=>R(e,t,m=>{let b=v(m.ab.variants).slice();b.splice(g,1),m.ab={...m.ab,variants:b}}),o=g=>R(e,t,m=>{let b=v(m.ab.variants).slice(),x=g!=null?b[g]:null;b.push({label:`variant-${b.length+1}`,metadata:x?x.metadata.map(f=>({...f})):q(),rolesJson:x?x.rolesJson:"",rolesOpen:!1}),m.ab={...m.ab,variants:b}}),p=y(a.repeats);return n`
			<section class="exp-card" data-testid="experiment-runner-ab-form">
				<h2 class="exp-h2">Variants</h2>
				${s.map((g,m)=>n`
					<div class="exp-variant" data-testid="experiment-runner-variant-row" data-variant-index=${m}>
						<div class="exp-variant-head">
							<input class="exp-input" type="text" data-testid="experiment-runner-variant-label" placeholder="variant label"
								.value=${u(g.label)} @input=${b=>c(m,{label:b.currentTarget.value})} />
							<button class="exp-btn secondary tiny" type="button" @click=${()=>o(m)}>Duplicate</button>
							<button class="exp-btn secondary tiny" type="button" data-testid="experiment-runner-remove-variant"
								?disabled=${s.length<=2}
								title=${s.length<=2?"A/B needs at least two variants":"Remove variant"}
								@click=${()=>d(m)}>Remove</button>
						</div>
						<div class="exp-field-label">Metadata treatment</div>
						${Y(e,t,g.metadata,b=>R(e,t,x=>{let f=v(x.ab&&x.ab.variants).slice(),B=v(f[m]&&f[m].metadata).slice();f[m]={...f[m],metadata:b(B)},x.ab={...x.ab,variants:f}}),"experiment-runner-variant-metadata")}
						<details class="exp-details" ?open=${g.rolesOpen}>
							<summary @click=${()=>c(m,{rolesOpen:!g.rolesOpen})}>Advanced: per-arm roles</summary>
							<textarea class="exp-input exp-mono" rows="3" placeholder='{"coder": {"model": "…"}}'
								.value=${u(g.rolesJson)} @input=${b=>c(m,{rolesJson:b.currentTarget.value})}></textarea>
						</details>
					</div>`)}
				<button class="exp-btn secondary" type="button" data-testid="experiment-runner-add-variant" @click=${()=>o(null)}>+ Add variant</button>

				<div class="exp-grid2">
					<label class="exp-label">Repeats per variant
						<input class="exp-input" type="number" min="1" max="20" data-testid="experiment-runner-repeats"
							.value=${u(a.repeats)} @input=${g=>i({repeats:g.currentTarget.value})} />
						${p>10?n`<span class="exp-warn-hint">high run count</span>`:l}
					</label>
					<label class="exp-label">Concurrency cap
						<input class="exp-input" type="number" min="1" max="8" data-testid="experiment-runner-concurrency"
							.value=${u(a.concurrency)} @input=${g=>i({concurrency:g.currentTarget.value})} />
					</label>
				</div>
				<label class="exp-checkbox"><input type="checkbox" data-testid="experiment-runner-same-bar"
					?checked=${a.sameCompletionBar!==!1} @change=${g=>i({sameCompletionBar:g.currentTarget.checked})} />
					Only aggregate runs that reached the same completion bar</label>
				<label class="exp-label">Per-run budget (USD, the fixed comparable budget)
					<input class="exp-input" type="number" min="0" step="0.5" data-testid="experiment-runner-per-run-budget"
						placeholder="e.g. 0.80" .value=${u(r.perRunBudget)}
						@input=${g=>R(e,t,m=>{m.perRunBudget=g.currentTarget.value})} />
				</label>
			</section>
		`}function me(e,t,r){let a=r.auto||{},s=o=>R(e,t,p=>{p.auto={...p.auto,...o}}),i=o=>R(e,t,p=>{p.auto={...p.auto,caps:{...p.auto.caps,...o}}}),c=o=>R(e,t,p=>{p.auto={...p.auto,stops:{...p.auto.stops,...o}}}),d=v(r.metrics).map(o=>o.metric);return n`
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
						.value=${u(a.correctnessGateId)} @input=${o=>s({correctnessGateId:o.currentTarget.value})} />
					<span class="exp-hint">Candidates failing verification are rejected even if the objective improves.</span>
				</label>
				<div class="exp-field-label">Search seed (iteration-0 candidate)</div>
				${Y(e,t,a.seed,o=>R(e,t,p=>{p.auto={...p.auto,seed:o(v(p.auto&&p.auto.seed).slice())}}),"experiment-runner-seed-metadata")}
			</section>

			<section class="exp-card" data-testid="experiment-runner-auto-caps">
				<h2 class="exp-h2">Caps <span class="exp-req">— at least one required</span></h2>
				<div class="exp-grid2">
					<label class="exp-label">Max iterations
						<input class="exp-input" type="number" min="1" data-testid="experiment-runner-cap-max-iterations"
							.value=${u(a.caps.maxIterations)} @input=${o=>i({maxIterations:o.currentTarget.value})} />
					</label>
					<label class="exp-label">Wall-clock cap (hours)
						<input class="exp-input" type="number" min="0" step="0.5" data-testid="experiment-runner-cap-wallclock"
							.value=${u(a.caps.wallClockHours)} @input=${o=>i({wallClockHours:o.currentTarget.value})} />
					</label>
					<label class="exp-label">Cost cap (USD)
						<input class="exp-input" type="number" min="0" step="1" data-testid="experiment-runner-cap-cost"
							.value=${u(a.caps.costUsd)} @input=${o=>i({costUsd:o.currentTarget.value})} />
					</label>
					<label class="exp-label">Per-iteration budget (USD, required)
						<input class="exp-input" type="number" min="0" step="0.5" data-testid="experiment-runner-per-iter-budget"
							.value=${u(a.caps.perIterBudget)} @input=${o=>i({perIterBudget:o.currentTarget.value})} />
					</label>
				</div>
			</section>

			<section class="exp-card" data-testid="experiment-runner-auto-stops">
				<h2 class="exp-h2">Stop conditions <span class="exp-req">— at least one required</span></h2>
				<div class="exp-grid2">
					<label class="exp-label">Plateau over K iterations
						<input class="exp-input" type="number" min="1" data-testid="experiment-runner-stop-plateau"
							.value=${u(a.stops.plateauK)} @input=${o=>c({plateauK:o.currentTarget.value})} />
					</label>
					<label class="exp-label">Target value
						<input class="exp-input" type="number" step="any" data-testid="experiment-runner-stop-target"
							.value=${u(a.stops.target)} @input=${o=>c({target:o.currentTarget.value})} />
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
							<input class="exp-input" type="number" min="1" max="8" .value=${u(a.batchSize)}
								@input=${o=>s({batchSize:o.currentTarget.value})} />
						</label>
					</div>
				</details>
			</section>
		`}function ge(e,t,r,a){if(r.mode==="autoresearch"){let s=v(a.checklist);return n`
				<footer class="exp-projection" data-testid="experiment-runner-projection">
					<div class="exp-proj-stats">
						<span data-testid="experiment-runner-cost">${a.estCostMax!=null?`\u2264 ${N(a.estCostMax)}`:"cost unbounded by iterations"}</span>
						${a.hasStop?n`<span class="exp-pos">stop set</span>`:l}
					</div>
					${s.length?n`<ul class="exp-checklist" data-testid="experiment-runner-guardrail-checklist">
						${s.map(i=>n`<li class="exp-neg">✗ ${i}</li>`)}
					</ul>`:l}
					${v(a.errors).length?n`<ul class="exp-checklist" data-testid="experiment-runner-error">
						${a.errors.map(i=>n`<li class="exp-neg">✗ ${i}</li>`)}
					</ul>`:l}
					<label class="exp-checkbox danger"><input type="checkbox" data-testid="experiment-runner-confirm-ack"
						?checked=${!!r.confirmAck} @change=${i=>R(e,t,c=>{c.confirmAck=i.currentTarget.checked})} />
						I understand this runs autonomously and may cost ${a.estCostMax!=null?`up to ${N(a.estCostMax)}`:"an unbounded amount until a cap is hit"}.</label>
					<button class="exp-btn primary" type="button" data-testid="experiment-runner-review-launch" ?disabled=${!a.valid}
						title=${a.valid?"Review & launch":"Set caps + stop condition + acknowledge"}
						@click=${()=>G(e,t,"confirm")}>Review &amp; launch →</button>
				</footer>
			`}return n`
			<footer class="exp-projection" data-testid="experiment-runner-projection">
				<div class="exp-proj-stats">
					<span data-testid="experiment-runner-run-count">${v(r.ab&&r.ab.variants).length} variants × ${y(r.ab&&r.ab.repeats)||0} repeats = ${a.runCount} runs</span>
					<span data-testid="experiment-runner-cost">${a.estCostMax!=null?`est. \u2264 ${N(a.estCostMax)}`:"est. \u2014 set a per-run budget"}</span>
					<span>~${y(r.ab&&r.ab.concurrency)||1} concurrent</span>
				</div>
				${v(a.errors).length?n`<ul class="exp-checklist" data-testid="experiment-runner-error">
					${a.errors.map(s=>n`<li class="exp-neg">✗ ${s}</li>`)}
				</ul>`:l}
				<button class="exp-btn primary" type="button" data-testid="experiment-runner-review-launch" ?disabled=${!a.valid}
					title=${a.valid?"Review & launch":v(a.errors)[0]||"Complete the form"}
					@click=${()=>G(e,t,"confirm")}>Review &amp; launch →</button>
			</footer>
		`}function fe(e,t,r){let a=te(r);return n`
			<div class="exp-view exp-define" data-testid="experiment-runner-view-define" data-mode=${r.mode||"ab"}>
				<div class="exp-define-head">
					<button class="exp-btn link" type="button" @click=${()=>G(e,t,"mode-select")}>← mode</button>
					<span class="exp-mode-badge ${r.mode==="autoresearch"?"warn":""}">${r.mode==="autoresearch"?"AUTORESEARCH":"A/B"}</span>
				</div>
				${ue(e,t,r)}
				${r.mode==="autoresearch"?me(e,t,r):be(e,t,r)}
				${xe(e,t,r)}
				${ge(e,t,r,a)}
			</div>
		`}function ve(e,t,r){let a=te(r),s=r.mode==="autoresearch",i=E.get(t)||{};return n`
			<div class="exp-view" data-testid="experiment-runner-view-confirm">
				<h1 class="exp-h1">Confirm launch</h1>
				<section class="exp-card">
					<div class="exp-confirm-row"><span>Mode</span><strong>${s?"Autoresearch":"A/B comparison"}</strong></div>
					<div class="exp-confirm-row"><span>Name</span><strong>${u(r.basics&&r.basics.name)}</strong></div>
					${s?n`
							<div class="exp-confirm-row"><span>Objective</span><strong>${u(r.auto&&r.auto.objectiveMetric)} (${u(r.auto&&r.auto.direction)})</strong></div>
							<div class="exp-confirm-row"><span>Caps</span><strong>${u(y(r.auto.caps.maxIterations)?`\u2264 ${y(r.auto.caps.maxIterations)} iters`:"")} ${y(r.auto.caps.wallClockHours)?`\u2264 ${y(r.auto.caps.wallClockHours)}h`:""} ${y(r.auto.caps.costUsd)?`\u2264 ${N(y(r.auto.caps.costUsd))}`:""}</strong></div>
							<div class="exp-confirm-row"><span>Worst-case cost</span><strong>${a.estCostMax!=null?`\u2264 ${N(a.estCostMax)}`:"unbounded by iterations"}</strong></div>
							<div class="exp-confirm-note">A candidate that fails verification is discarded even if its objective improved.</div>`:n`
							<div class="exp-confirm-row"><span>Fan-out</span><strong>${a.runCount} child goals (${v(r.ab.variants).length} variants × ${y(r.ab.repeats)} repeats)</strong></div>
							<div class="exp-confirm-row"><span>Projected cost</span><strong>${a.estCostMax!=null?`\u2264 ${N(a.estCostMax)}`:"\u2014"}</strong></div>`}
				</section>
				${i.launchError?n`<div class="exp-error-box" data-testid="experiment-runner-launch-error">${i.launchError}</div>`:l}
				<div class="exp-confirm-actions">
					<button class="exp-btn secondary" type="button" @click=${()=>G(e,t,"define")}>← Back</button>
					<button class="exp-btn primary" type="button" data-testid="experiment-runner-launch" ?disabled=${!a.valid||i.launching}
						@click=${()=>ie(e,t)}>${i.launching?"Launching\u2026":s?`Launch loop (\u2264 ${a.estCostMax!=null?N(a.estCostMax):"capped"})`:`Launch ${a.runCount} runs`}</button>
				</div>
			</div>
		`}function Z(e){let t=e&&Array.isArray(e.spec)?e.spec:e&&e.spec&&Array.isArray(e.spec.widgets)?e.spec.widgets:null;return t&&t.length?t:e&&e.def&&e.def.mode==="autoresearch"?[{type:"summary-cards",title:"Summary"},{type:"objective-curve",title:"Best objective vs iteration"},{type:"ledger-table",title:"Ledger"},{type:"raw-drilldown",title:"Iterations"}]:[{type:"summary-cards",title:"Summary"},{type:"comparison-table",title:"Comparison"},{type:"score-bars",title:"Secondary metrics"},{type:"raw-drilldown",title:"Runs"}]}let F=e=>e&&(e.metricId||e.metric)||void 0;function J(e){let r=v(e&&e.metrics).filter(a=>a.collect!==!1).map(F).filter(Boolean);return r.length?r:["objective.value","cost.totalUsd","time.wallClockMs"]}function he(e){let r=v(e&&e.metrics).find(a=>a.primary);return r?F(r):e&&e.def&&e.def.objective?e.def.objective.metricId||e.def.objective.metric:J(e)[0]}let _=(e,t)=>{let r=e&&e.metrics,a=r?r[t]:void 0;return Number.isFinite(Number(a))?Number(a):a&&Number.isFinite(Number(a.value))?Number(a.value):void 0};function Q(e){let t=new Map;for(let r of v(e&&e.runs)){let a=u(r.armId,"arm");t.has(a)||t.set(a,[]),t.get(a).push(r)}return t}function $e(e,t){let r=J(t),a=!(t.def&&t.def.sameCompletionBar===!1),s=Q(t),i=v(t.metrics),c=d=>(i.find(o=>F(o)===d)||{}).aggregation||"median";return n`<table class="exp-table" data-testid="experiment-runner-widget-comparison-table">
			<thead><tr><th>Variant</th>${r.map(d=>n`<th class="exp-mono">${d}</th>`)}<th>n</th></tr></thead>
			<tbody>
				${[...s.entries()].map(([d,o])=>{let p=a?o.filter(m=>m.completionBar==="passed"):o,g=p.length?p:o;return n`<tr data-testid="experiment-runner-comparison-arm" data-arm=${d}>
						<td><strong>${d}</strong></td>
						${r.map(m=>n`<td class="exp-mono">${O(ee(g.map(b=>_(b,m)),c(m)))}</td>`)}
						<td>${g.length}</td>
					</tr>`})}
			</tbody>
		</table>`}function ye(e,t){let r=J(t),a=Q(t);return n`<div class="exp-scorebars" data-testid="experiment-runner-widget-score-bars">
			${r.map((s,i)=>{let c=[...a.entries()].map(([o,p])=>({arm:o,v:ee(p.map(g=>_(g,s)),"median")})),d=Math.max(1,...c.map(o=>Number.isFinite(o.v)?Math.abs(o.v):0));return n`<div class="exp-scorebar-group"><div class="exp-field-label exp-mono">${s}</div>
					${c.map(o=>n`<div class="exp-scorebar-row"><span class="exp-scorebar-label">${o.arm}</span>
						<span class="exp-scorebar-track"><span class="exp-scorebar-fill" style=${`width:${Math.round((Number.isFinite(o.v)?Math.abs(o.v):0)/d*100)}%;background:var(--chart-${i%6+1})`}></span></span>
						<span class="exp-mono">${O(o.v)}</span></div>`)}
				</div>`})}
		</div>`}function we(e,t){let r=he(t),a=t.def&&t.def.objective&&t.def.objective.direction||"maximize",s=v(t.runs).filter(o=>o.iteration!=null).sort((o,p)=>o.iteration-p.iteration),i=null,c=s.map(o=>{let p=_(o,r);return Number.isFinite(p)&&(i=i==null?p:a==="minimize"?Math.min(i,p):Math.max(i,p)),{iteration:o.iteration,v:p,best:i,kept:o.verified!==!1&&o.completionBar!=="failed"}}),d=y(t.def&&t.def.stop&&t.def.stop.target);return n`<div data-testid="experiment-runner-widget-objective-curve">
			${d!=null?n`<div class="exp-hint">target ${a==="minimize"?"\u2264":"\u2265"} ${O(d)}</div>`:l}
			<table class="exp-table"><thead><tr><th>Iter</th><th>objective</th><th>best</th><th>verdict</th></tr></thead>
				<tbody>${c.map(o=>n`<tr><td>${o.iteration}</td><td class="exp-mono">${O(o.v)}</td><td class="exp-mono exp-pos">${O(o.best)}</td><td>${o.kept?n`<span class="exp-pos">●</span>`:n`<span class="exp-neg">○</span>`}</td></tr>`)}</tbody>
			</table>
		</div>`}function ke(e,t){let r=v(t.ledger);return n`<table class="exp-table" data-testid="experiment-runner-widget-ledger-table">
			<thead><tr><th>Iter</th><th>verdict</th><th>objective</th><th>best</th></tr></thead>
			<tbody>${r.map(a=>{let s=u(a.verdict||a.decision,"\u2014"),i=/kept|accept/i.test(s)?"exp-pos":/verification|failed/i.test(s)?"exp-neg":"exp-muted";return n`<tr data-testid="experiment-runner-ledger-row"><td>${u(a.iteration)}</td><td class=${i}>${s}</td><td class="exp-mono">${O(y(a.objective))}</td><td class="exp-mono">${O(y(a.best))}</td></tr>`})}</tbody>
		</table>`}function Ce(e,t){let r=v(t.runs),a=r.filter(c=>["settled","collected","failed"].includes(c.status)).length,s=r.filter(c=>c.completionBar==="passed").length,i=r.reduce((c,d)=>c+(y(d.cost&&d.cost.totalUsd)||_(d,"cost.totalUsd")||0),0);return n`<div class="exp-cards" data-testid="experiment-runner-widget-summary-cards">
			<div class="exp-stat"><span class="exp-stat-n">${r.length}</span><span class="exp-stat-l">runs</span></div>
			<div class="exp-stat"><span class="exp-stat-n">${a}</span><span class="exp-stat-l">settled</span></div>
			<div class="exp-stat"><span class="exp-stat-n exp-pos">${s}</span><span class="exp-stat-l">passed bar</span></div>
			<div class="exp-stat"><span class="exp-stat-n">${N(i)}</span><span class="exp-stat-l">spend</span></div>
		</div>`}function Se(e,t){let r=J(t),a=v(t.runs);return n`<table class="exp-table" data-testid="experiment-runner-widget-raw-drilldown">
			<thead><tr><th>run</th><th>arm</th><th>${t.def&&t.def.mode==="autoresearch"?"iter":"rep"}</th><th>status</th><th>bar</th>${r.map(s=>n`<th class="exp-mono">${s}</th>`)}</tr></thead>
			<tbody>${a.map(s=>{let i=t.def&&t.def.sameCompletionBar!==!1&&s.completionBar&&s.completionBar!=="passed";return n`<tr class=${i?"exp-excluded":""} data-testid="experiment-runner-run-row" data-run=${u(s.runId)}>
					<td class="exp-mono">${u(s.runId)}</td><td>${u(s.armId)}</td>
					<td>${u(s.iteration!=null?s.iteration:s.repeat)}</td>
					<td>${u(s.status)}</td><td>${u(s.completionBar)}${i?n` <span class="exp-tag">excluded</span>`:l}</td>
					${r.map(c=>n`<td class="exp-mono">${O(_(s,c))}</td>`)}
				</tr>`})}</tbody>
		</table>`}let Te={"comparison-table":$e,"score-bars":ye,"objective-curve":we,"ledger-table":ke,"summary-cards":Ce,"raw-drilldown":Se};function Ie(e){try{let t=document.createElement("div");return t.setAttribute("data-testid","experiment-runner-report-html"),t.innerHTML=String(e),t}catch{return l}}function Re(e,t,r){if(r.report&&typeof r.report.html=="string"&&r.report.html.trim())return n`<div class="exp-dashboard-body" data-testid="experiment-runner-dashboard-body">${Ie(r.report.html)}</div>`;let a=Z(r);return n`<div class="exp-dashboard-body" data-testid="experiment-runner-dashboard-body">
			${a.map(s=>{let i=Te[s.type];return n`<section class="exp-widget exp-card" data-testid="experiment-runner-widget" data-widget-type=${s.type}>
					<h3 class="exp-widget-title">${u(s.title,s.type)}</h3>
					${i?i(e,r):n`<div class="exp-hint">Unknown widget: ${s.type}</div>`}
				</section>`})}
		</div>`}function Ae(e,t,r){let a=Z(r).slice(),s=b=>z(e,t,{dashboardDraftSpec:b}),i=E.get(t)||{},c=i.dashboardDraftSpec||a,d=(b,x)=>{let f=c.slice(),B=b+x;B<0||B>=f.length||([f[b],f[B]]=[f[B],f[b]],s(f))},o=b=>{let x=c.slice();x.splice(b,1),s(x)},p=b=>s([...c,{type:b,title:(K.find(x=>x.id===b)||{}).label||b}]),g=(b,x)=>{let f=c.slice();f[b]={...f[b],title:x},s(f)},m=i.widgetTypes&&i.widgetTypes.length?i.widgetTypes:K;return n`<div class="exp-card" data-testid="experiment-runner-dashboard-editor">
			<h3 class="exp-h2">Edit dashboard</h3>
			${c.map((b,x)=>n`<div class="exp-editor-row" data-testid="experiment-runner-editor-widget" data-widget-type=${b.type}>
				<input class="exp-input" type="text" .value=${u(b.title)} @input=${f=>g(x,f.currentTarget.value)} />
				<span class="exp-badge exp-mono">${b.type}</span>
				<button class="exp-icon-btn" type="button" title="Move up" @click=${()=>d(x,-1)}>↑</button>
				<button class="exp-icon-btn" type="button" title="Move down" @click=${()=>d(x,1)}>↓</button>
				<button class="exp-icon-btn" type="button" title="Remove" @click=${()=>o(x)}>✕</button>
			</div>`)}
			<div class="exp-editor-add">
				<select class="exp-input" data-testid="experiment-runner-add-widget-type">
					${m.map(b=>n`<option value=${b.id}>${b.label||b.id}</option>`)}
				</select>
				<button class="exp-btn secondary" type="button" data-testid="experiment-runner-add-widget"
					@click=${b=>{let x=b.currentTarget.parentElement.querySelector("select");p(x.value)}}>+ Add widget</button>
			</div>
			<div class="exp-confirm-actions">
				<button class="exp-btn secondary" type="button" @click=${()=>z(e,t,{dashboardEditing:!1,dashboardDraftSpec:void 0})}>Cancel</button>
				<button class="exp-btn primary" type="button" data-testid="experiment-runner-save-dashboard"
					@click=${()=>{z(e,t,{dashboardDraftSpec:void 0}),le(e,t,r.experimentId,c)}}>Save dashboard</button>
			</div>
		</div>`}function Me(e,t,r){let a=E.get(t)||{},s=a.dashboard,i=()=>z(e,t,{dashboard:null})&&R(e,t,x=>{Object.assign(x,H())});if(a.dashboardLoading&&!s)return n`<div class="exp-view" data-testid="experiment-runner-view-dashboard"><div class="exp-hint">Loading experiment…</div></div>`;if(!s)return n`<div class="exp-view" data-testid="experiment-runner-view-dashboard">
				<div class="exp-empty">No experiment loaded.</div>
				<button class="exp-btn primary" type="button" data-testid="experiment-runner-new-experiment" @click=${i}>New experiment</button>
			</div>`;let c=s.def||{},d=s.state||{},o=c.mode==="autoresearch",p=u(d.status,"running"),g=v(s.runs),m=g.filter(x=>["settled","collected","failed"].includes(x.status)).length,b=d.stopReason?`stopped: ${d.stopReason}`:p;return n`
			<div class="exp-view" data-testid="experiment-runner-view-dashboard" data-experiment-id=${s.experimentId}>
				<header class="exp-dash-head">
					<div class="exp-dash-titles">
						<span class="exp-mode-badge ${o?"warn":""}">${o?"AUTORESEARCH":"A/B"}</span>
						<h1 class="exp-h1">${u(c.title,s.experimentId)}</h1>
					</div>
					<div class="exp-dash-meta">
						<span class="exp-status" data-testid="experiment-runner-status" role="status">${p==="running"?`running ${m}/${g.length}`:b}</span>
					</div>
					<div class="exp-dash-actions">
						${p==="running"?n`<button class="exp-btn secondary" type="button" data-testid="experiment-runner-stop" @click=${()=>ce(e,t,s.experimentId)}>Stop experiment</button>`:l}
						<button class="exp-btn secondary" type="button" data-testid="experiment-runner-refresh" @click=${()=>U(e,t,s.experimentId)}>Refresh</button>
						<button class="exp-btn secondary" type="button" data-testid="experiment-runner-edit-dashboard"
							@click=${()=>z(e,t,{dashboardEditing:!a.dashboardEditing,dashboardDraftSpec:void 0})}>${a.dashboardEditing?"Close editor":"Edit dashboard"}</button>
						<button class="exp-btn link" type="button" data-testid="experiment-runner-new-experiment" @click=${i}>New experiment</button>
					</div>
				</header>
				${a.dashboardEditing?Ae(e,t,s):l}
				<details class="exp-details" data-testid="experiment-runner-metrics-panel">
					<summary>Metrics — edit what is collected (re-extracts from stored outcomes, no re-run)</summary>
					${Ee(e,t,s)}
				</details>
				${Re(e,t,s)}
			</div>
		`}function Ee(e,t,r){let a=v(r.metrics).length?v(r.metrics):ae(),s=(i,c)=>{let d=a.map((o,p)=>p===i?{...o,collect:c}:o);z(e,t,{dashboard:{...r,metrics:d}}),de(e,t,r.experimentId,d)};return n`<table class="exp-table">
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
	`;return{render(e,t){let r=e&&typeof e.__sessionId=="string"?e.__sessionId:"",a=e&&typeof e.experimentId=="string"?e.experimentId:"",s=e&&typeof e.view=="string"?e.view:void 0,i=r||"experiment-runner",c=re(t,i,a,s),d=c&&c.draft||H(),o=d.view||"mode-select",p;return o==="dashboard"?p=Me(t,i,d):o==="confirm"?p=ve(t,i,d):o==="define"?p=fe(t,i,d):p=pe(t,i,d),n`
				<style>${ze}</style>
				<div class="exp-root" data-testid="experiment-runner-panel-root" data-view=${o} data-mode=${d.mode||""}>
					${p}
				</div>
			`}}}export{qe as default};
