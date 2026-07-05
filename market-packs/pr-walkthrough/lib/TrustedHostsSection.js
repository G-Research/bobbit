var u=/^[a-z0-9.-]+$/;function i(e){if(typeof e!="string")return;let t=e.trim();if(t){if(t.includes("://"))try{t=new URL(t).hostname}catch{return}if(t=t.trim().toLowerCase().replace(/\.$/,""),!!t&&!(/[\s/@:]/.test(t)||t.includes("://"))&&u.test(t)&&t.split(".").every(n=>n.length>0&&n.length<=63&&!n.startsWith("-")&&!n.endsWith("-")))return t}}var s="";function o(e){let t=e.preferences.get("githubTrustedHosts");return Array.isArray(t)?t.filter(n=>typeof n=="string"):[]}async function d(e){let t=i(s),n=o(e);if(!t||n.includes(t)){s="",e.requestRender();return}s="",e.requestRender(),await e.preferences.set("githubTrustedHosts",[...n,t])}async function a(e,t){await e.preferences.set("githubTrustedHosts",o(e).filter(n=>n!==t))}function c({html:e}){return{render(t){let n=o(t);return e`
				<div class="flex flex-col gap-1.5">
					<span class="text-sm font-medium text-foreground">Trusted GitHub hosts</span>
					<p class="text-xs text-muted-foreground">
						PR walkthroughs fetch repository and pull-request data (metadata and diffs) from these hosts.
						github.com and its API/raw hosts are always trusted. Only add hosts you trust.
					</p>
					<div class="flex flex-col gap-1.5" data-testid="github-trusted-hosts-list">
						${n.length===0?e`<p class="text-xs text-muted-foreground italic">No additional hosts trusted.</p>`:n.map(r=>e`
								<div class="flex items-center gap-2" data-testid="github-trusted-host-row" data-host=${r}>
									<code class="text-sm text-foreground flex-1 truncate">${r}</code>
									<button
										class="text-xs text-muted-foreground hover:text-destructive underline"
										data-testid="github-trusted-host-remove"
										@click=${()=>{a(t,r)}}
									>Remove</button>
								</div>
							`)}
					</div>
					<div class="flex items-center gap-2">
						<input
							type="text"
							placeholder="ghe.example.com"
							data-testid="github-trusted-host-input"
							class="flex-1 px-2 py-1 rounded border border-input bg-background text-sm"
							.value=${s}
							@input=${r=>{s=r.target.value,t.requestRender()}}
							@keydown=${r=>{r.key==="Enter"&&(r.preventDefault(),d(t))}}
						/>
						<button
							class="px-3 py-1.5 rounded border border-input text-sm hover:bg-secondary"
							data-testid="github-trusted-host-add"
							@click=${()=>{d(t)}}
						>Add</button>
					</div>
				</div>
			`}}}export{c as default};
