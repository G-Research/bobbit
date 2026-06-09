var u={create:"Created artifact",update:"Updated artifact",rewrite:"Rewrote artifact",get:"Got artifact",delete:"Deleted artifact",logs:"Got logs"};function g({html:i,nothing:s,renderHeader:c}){return{render(d,m,y,n){let t=d||{},p=typeof t.command=="string"?t.command:"create",e=typeof t.artifactId=="string"?t.artifactId:"art-demo-1",r=typeof t.filename=="string"?t.filename:"artifact.html",l=typeof t.content=="string"?t.content:"",o={filename:r,content:l},f=u[p]||"Artifact";return{isCustom:!1,content:i`
					<div class="flex items-center gap-2 text-sm" data-testid="artifact-pill-root">
						<span class="text-muted-foreground" data-testid="artifact-pill-label">${f}</span>
						<span
							class="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-muted/50 border border-border rounded cursor-pointer hover:bg-muted transition-colors"
							data-testid="artifact-pill"
							data-artifact-id=${e}
							@click=${async a=>{a?.preventDefault?.(),a?.stopPropagation?.(),await n?.host?.store?.put(e,o),n?.host?.ui?.openPanel({panelId:"artifacts.viewer",params:{artifactId:e}})}}
						>
							<span class="text-foreground">${r}</span>
						</span>
						<button
							class="text-xs px-2 py-0.5 rounded border border-border bg-transparent text-foreground"
							data-testid="artifact-deeplink"
							data-artifact-id=${e}
							@click=${async a=>{a?.preventDefault?.(),a?.stopPropagation?.(),await n?.host?.store?.put(e,o),n?.host?.ui?.navigate({route:"artifacts",params:{artifactId:e}})}}
						>
							Open via link
						</button>
					</div>
				`}}}}export{g as default};
