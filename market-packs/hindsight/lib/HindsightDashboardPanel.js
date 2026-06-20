var f=(a,d="")=>a==null?d:String(a),b=a=>a&&a.message?String(a.message):String(a);var U="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox",g=globalThis.__bobbitHindsightDashboardState||(globalThis.__bobbitHindsightDashboardState=new Map);function k(){return{mountKicked:!1,loadState:"loading",loadError:null,uiUrl:"",externalUrl:"",host:"",frameArmedFor:null,frameLoaded:!1,frameTimedOut:!1,frameTimer:null}}function R(a){let d=f(a,"").trim();if(!d)return"";try{return new URL(d).host||d}catch{return d}}function L(a=""){let d=globalThis.__bobbitHindsightIframeTimeoutMs;if(typeof d=="number"&&Number.isFinite(d)&&d>=0)return d;let l=String(a||""),s=l.match(/[?&](?:amp;)?__bobbit_hindsight_timeout_ms=(\d+)/);if(s)return Number(s[1]);try{let c=Number(new URL(l).searchParams.get("__bobbit_hindsight_timeout_ms"));if(Number.isFinite(c)&&c>=0)return c}catch{}return 7e3}function E(a=""){if(globalThis.__bobbitHindsightIframeForceTimeout===!0)return!0;let d=String(a||"");if(/[?&](?:amp;)?__bobbit_hindsight_force_timeout=1(?:&|$)/.test(d))return!0;try{return new URL(d).searchParams.get("__bobbit_hindsight_force_timeout")==="1"}catch{return!1}}function S({html:a,nothing:d}){let l=r=>{try{r&&r.requestRender&&r.requestRender()}catch{}},s=r=>g.get(r),c=r=>{if(r&&r.frameTimer){try{clearTimeout(r.frameTimer)}catch{}r.frameTimer=null}};async function x(r,o){let e=null,i=null,t=null;try{e=await r.callRoute("config",{method:"GET"})}catch(m){t=b(m)}try{i=await r.callRoute("status",{method:"GET"})}catch(m){t||(t=b(m))}let n=s(o);if(!n)return;let p=e&&e.config||{},u=f(i&&i.uiUrl||p.uiUrl||e&&e.uiUrl,"").trim(),w=f(i&&i.externalUrl||p.externalUrl||e&&e.externalUrl,"").trim();n.uiUrl=u,n.externalUrl=w,n.host=R(u),!u&&t&&!e&&!i?(n.loadState="error",n.loadError=t):(n.loadState="ready",n.loadError=null),l(r)}let v=(r,o,e)=>{let i=s(o);if(!i||i.frameArmedFor===e)return;c(i),i.frameArmedFor=e,i.frameLoaded=!1,i.frameTimedOut=!1;let t=L(e);i.frameTimer=setTimeout(()=>{let n=s(o);n&&(n.frameTimer=null,n.frameLoaded||(n.frameTimedOut=!0,l(r)))},t)},y=(r,o)=>{let e=s(o);e&&(E(e.uiUrl)||(c(e),e.frameLoaded=!0,e.frameTimedOut=!1,l(r)))},h=a`<style>
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
	</style>`,T=r=>a`
		${h}
		<div class="hd-root" data-testid="hindsight-dashboard" data-state="empty">
			<div class="hd-empty">
				<section class="hd-card" data-testid="hindsight-dashboard-empty">
					<h2>Hindsight dashboard URL is not configured.</h2>
					<p class="hd-muted">
						The embedded Hindsight dashboard opens the human UI at your configured
						dashboard URL. Configure it in the Marketplace to view and query memory
						without leaving Bobbit.
					</p>
					${r.externalUrl?a`<p class="hd-muted">The data-plane API URL (<span class="hd-mono">${r.externalUrl}</span>) is configured, but the dashboard UI URL is missing.</p>`:d}
					<a class="hd-cta" data-testid="hindsight-dashboard-configure" href="#/market">Configure in Marketplace</a>
				</section>
			</div>
		</div>`,_=(r,o,e)=>{let i=r.uiUrl,t=r.frameTimedOut&&!r.frameLoaded;return a`
			${h}
			<div class="hd-root" data-testid="hindsight-dashboard" data-state="embedded">
				<div class="hd-head">
					<div>
						<h1>Hindsight Memory</h1>
						<p class="hd-sub" data-testid="hindsight-dashboard-source">Embedded dashboard from ${r.host||i}</p>
					</div>
					<div class="hd-actions">
						<a class="hd-link" data-testid="hindsight-dashboard-open-external" href=${i} target="_blank" rel="noopener noreferrer">Open in browser ↗</a>
					</div>
				</div>
				${t?a`<div class="hd-warning" data-testid="hindsight-dashboard-embed-warning">The Hindsight dashboard did not load in-app. It may block embedding or be unreachable — open it in your browser instead.</div>`:d}
				${r.frameLoaded?a`<div class="hd-hint" data-testid="hindsight-dashboard-loaded-hint">If the frame is blank, open externally.</div>`:d}
				<div class="hd-frame-wrap">
					<iframe
						class="hd-frame"
						data-testid="hindsight-dashboard-frame"
						src=${i}
						sandbox=${U}
						referrerpolicy="no-referrer"
						title="Hindsight dashboard"
						@load=${()=>y(o,e)}
					></iframe>
				</div>
			</div>`};return{render(r,o){let e=r&&r.__sessionId||"hindsight-dashboard-default";if(!!!(o&&o.capabilities&&o.capabilities.callRoute&&typeof o.callRoute=="function"))return a`${h}<div class="hd-root" data-testid="hindsight-dashboard" data-state="unavailable"><div class="hd-empty"><p class="hd-muted">Hindsight memory is unavailable on this host.</p></div></div>`;let t=s(e);return t||(t=k(),g.set(e,t)),t.mountKicked||(t.mountKicked=!0,x(o,e)),t.loadState==="loading"?a`${h}<div class="hd-root" data-testid="hindsight-dashboard" data-state="loading"><div class="hd-empty"><p class="hd-muted" data-testid="hindsight-dashboard-loading">Loading Hindsight dashboard…</p></div></div>`:t.uiUrl?(v(o,e,t.uiUrl),_(t,o,e)):T(t)}}}export{S as default};
