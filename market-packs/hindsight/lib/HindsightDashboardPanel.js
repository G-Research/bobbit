var f=(r,n="")=>r==null?n:String(r),g=r=>r&&r.message?String(r.message):String(r);var k="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox",b=globalThis.__bobbitHindsightDashboardState||(globalThis.__bobbitHindsightDashboardState=new Map);function E(){return{mountKicked:!1,loadState:"loading",loadError:null,uiUrl:"",externalUrl:"",host:"",frameArmedFor:null,frameLoaded:!1,frameTimedOut:!1,frameTimer:null}}function R(r){let n=f(r,"").trim();if(!n)return"";try{return new URL(n).host||n}catch{return n}}function L(){let r=globalThis.__bobbitHindsightIframeTimeoutMs;return typeof r=="number"&&Number.isFinite(r)&&r>=0?r:7e3}function _({html:r,nothing:n}){let c=a=>{try{a&&a.requestRender&&a.requestRender()}catch{}},s=a=>b.get(a),m=a=>{if(a&&a.frameTimer){try{clearTimeout(a.frameTimer)}catch{}a.frameTimer=null}};async function x(a,i){let e=null,t=null,d=null;try{e=await a.callRoute("config",{method:"GET"})}catch(u){d=g(u)}try{t=await a.callRoute("status",{method:"GET"})}catch(u){d||(d=g(u))}let o=s(i);if(!o)return;let p=e&&e.config||{},h=f(t&&t.uiUrl||p.uiUrl||e&&e.uiUrl,"").trim(),w=f(t&&t.externalUrl||p.externalUrl||e&&e.externalUrl,"").trim();o.uiUrl=h,o.externalUrl=w,o.host=R(h),!h&&d&&!e&&!t?(o.loadState="error",o.loadError=d):(o.loadState="ready",o.loadError=null),c(a)}let v=(a,i,e)=>{let t=s(i);if(!t||t.frameArmedFor===e)return;m(t),t.frameArmedFor=e,t.frameLoaded=!1,t.frameTimedOut=!1;let d=L();t.frameTimer=setTimeout(()=>{let o=s(i);o&&(o.frameTimer=null,o.frameLoaded||(o.frameTimedOut=!0,c(a)))},d)},y=(a,i)=>{let e=s(i);e&&(m(e),e.frameLoaded=!0,e.frameTimedOut=!1,c(a))},l=r`<style>
		.hd-root { color: var(--foreground); background: var(--background); min-height: 100%; box-sizing: border-box; display: flex; flex-direction: column; font-size: 13px; }
		.hd-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border); flex: 0 0 auto; }
		.hd-head h1 { font-size: 15px; margin: 0; color: var(--foreground); }
		.hd-sub { color: var(--muted-foreground); font-size: 11px; margin: 2px 0 0; }
		.hd-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
		.hd-link { color: var(--primary); text-decoration: none; border: 1px solid var(--border); border-radius: 7px; padding: 6px 12px; font: inherit; }
		.hd-link:hover { border-color: var(--primary); text-decoration: underline; }
		.hd-frame-wrap { position: relative; flex: 1 1 auto; min-height: 320px; display: flex; }
		.hd-frame { border: 0; width: 100%; height: 100%; flex: 1 1 auto; background: var(--background); }
		.hd-warning { padding: 10px 16px; border-bottom: 1px solid color-mix(in oklch, var(--warning) 45%, transparent); background: color-mix(in oklch, var(--warning) 12%, transparent); color: var(--foreground); font-size: 12px; flex: 0 0 auto; }
		.hd-hint { padding: 6px 16px; color: var(--muted-foreground); font-size: 11px; flex: 0 0 auto; }
		.hd-empty { display: flex; flex-direction: column; gap: 12px; padding: 24px 16px; }
		.hd-card { border: 1px solid var(--border); border-radius: 10px; background: var(--card); padding: 16px; display: flex; flex-direction: column; gap: 10px; }
		.hd-card h2 { font-size: 14px; margin: 0; color: var(--foreground); }
		.hd-muted { color: var(--muted-foreground); margin: 0; }
		.hd-error { color: var(--negative); margin: 0; }
		.hd-cta { align-self: flex-start; background: var(--primary); color: var(--background); border: 1px solid var(--primary); border-radius: 7px; padding: 7px 14px; font: inherit; text-decoration: none; }
		.hd-cta:hover { text-decoration: underline; }
		.hd-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
	</style>`,T=a=>r`
		${l}
		<div class="hd-root" data-testid="hindsight-dashboard" data-state="empty">
			<div class="hd-empty">
				<section class="hd-card" data-testid="hindsight-dashboard-empty">
					<h2>Hindsight dashboard URL is not configured.</h2>
					<p class="hd-muted">
						The embedded Hindsight dashboard opens the human UI at your configured
						dashboard URL. Configure it in the Marketplace to view and query memory
						without leaving Bobbit.
					</p>
					${a.externalUrl?r`<p class="hd-muted">The data-plane API URL (<span class="hd-mono">${a.externalUrl}</span>) is configured, but the dashboard UI URL is missing.</p>`:n}
					<a class="hd-cta" data-testid="hindsight-dashboard-configure" href="#/market">Configure in Marketplace</a>
				</section>
			</div>
		</div>`,U=(a,i,e)=>{let t=a.uiUrl,d=a.frameTimedOut&&!a.frameLoaded;return r`
			${l}
			<div class="hd-root" data-testid="hindsight-dashboard" data-state="embedded">
				<div class="hd-head">
					<div>
						<h1>Hindsight Memory</h1>
						<p class="hd-sub" data-testid="hindsight-dashboard-source">Embedded dashboard from ${a.host||t}</p>
					</div>
					<div class="hd-actions">
						<a class="hd-link" data-testid="hindsight-dashboard-open-external" href=${t} target="_blank" rel="noopener noreferrer">Open in browser ↗</a>
					</div>
				</div>
				${d?r`<div class="hd-warning" data-testid="hindsight-dashboard-embed-warning">The Hindsight dashboard did not load in-app. It may block embedding or be unreachable — open it in your browser instead.</div>`:n}
				${a.frameLoaded?r`<div class="hd-hint" data-testid="hindsight-dashboard-loaded-hint">If the frame is blank, open externally.</div>`:n}
				<div class="hd-frame-wrap">
					<iframe
						class="hd-frame"
						data-testid="hindsight-dashboard-frame"
						src=${t}
						sandbox=${k}
						referrerpolicy="no-referrer"
						title="Hindsight dashboard"
						@load=${()=>y(i,e)}
					></iframe>
				</div>
			</div>`};return{render(a,i){let e=a&&a.__sessionId||"hindsight-dashboard-default";if(!!!(i&&i.capabilities&&i.capabilities.callRoute&&typeof i.callRoute=="function"))return r`${l}<div class="hd-root" data-testid="hindsight-dashboard" data-state="unavailable"><div class="hd-empty"><p class="hd-muted">Hindsight memory is unavailable on this host.</p></div></div>`;let d=s(e);return d||(d=E(),b.set(e,d)),d.mountKicked||(d.mountKicked=!0,x(i,e)),d.loadState==="loading"?r`${l}<div class="hd-root" data-testid="hindsight-dashboard" data-state="loading"><div class="hd-empty"><p class="hd-muted" data-testid="hindsight-dashboard-loading">Loading Hindsight dashboard…</p></div></div>`:d.uiUrl?(v(i,e,d.uiUrl),U(d,i,e)):T(d)}}}export{_ as default};
