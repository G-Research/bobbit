import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

@customElement('git-status-widget')
export class GitStatusWidget extends LitElement {
    @property() branch = '';
    @property() primaryBranch = 'master';
    @property({ type: Boolean }) isOnPrimary = true;
    @property() summary = '';
    @property({ type: Boolean }) clean = true;
    @property({ type: Boolean }) hasUpstream = false;
    @property({ type: Number }) ahead = 0;
    @property({ type: Number }) behind = 0;
    @property({ type: Number }) aheadOfPrimary = 0;
    @property({ type: Number }) behindPrimary = 0;
    @property({ type: Boolean }) mergedIntoPrimary = false;
    @property({ type: Boolean }) unpushed = false;
    @property({ type: Array }) statusFiles: Array<{ file: string; status: string }> = [];
    @property({ type: Boolean }) loading = false;

    // PR status properties
    @property() prState?: string; // "OPEN" | "MERGED" | "CLOSED"
    @property() prUrl?: string;
    @property({ type: Number }) prNumber?: number;
    @property() prTitle?: string;
    @property({ type: Boolean }) prMergeable?: boolean;

    @state() private expanded = false;
    @state() private merging = false;
    @state() private mergeError = '';
    @state() private mergeMethod: 'merge' | 'squash' | 'rebase' = 'merge';

    private _onDocumentClick = (e: MouseEvent) => {
        if (this.expanded && !this.contains(e.target as Node)) {
            this.expanded = false;
        }
    };

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        document.addEventListener('click', this._onDocumentClick, true);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        document.removeEventListener('click', this._onDocumentClick, true);
    }

    private _toggle(e: MouseEvent) {
        e.stopPropagation();
        this.expanded = !this.expanded;
    }

    private _statusColor(status: string): string {
        switch (status) {
            case 'M': return 'text-amber-600 dark:text-amber-400';
            case 'A': return 'text-green-600 dark:text-green-400';
            case 'D': return 'text-red-600 dark:text-red-400';
            case '?': return 'text-muted-foreground';
            case 'R': return 'text-blue-600 dark:text-blue-400';
            case 'U': return 'text-red-700 dark:text-red-500';
            default: return 'text-muted-foreground';
        }
    }

    private _statusLabel(status: string): string {
        switch (status) {
            case 'M': return 'modified';
            case 'A': return 'added';
            case 'D': return 'deleted';
            case '?': return 'untracked';
            case 'R': return 'renamed';
            case 'U': return 'unmerged';
            default: return status;
        }
    }

    /** Terse pill indicator: ↑ unpushed, ↗ not merged to primary, ✓ all good */
    private _pillIndicator() {
        if (!this.isOnPrimary && this.mergedIntoPrimary && !this.unpushed) {
            // All work is on primary — nothing to flag
            return nothing;
        }
        if (this.unpushed) {
            return html`<span class="text-amber-600 dark:text-amber-400 shrink-0">↑</span>`;
        }
        if (!this.isOnPrimary && !this.mergedIntoPrimary) {
            return html`<span class="text-blue-600 dark:text-blue-400 shrink-0">↗</span>`;
        }
        return nothing;
    }

    private _renderRemoteStatus() {
        if (this.isOnPrimary) {
            // On primary branch — show ahead/behind vs remote
            if (this.ahead > 0 && this.behind > 0) {
                return html`<span class="text-amber-600 dark:text-amber-400">${this.ahead} ahead, ${this.behind} behind remote</span>`;
            }
            if (this.ahead > 0) {
                return html`<span class="text-amber-600 dark:text-amber-400">${this.ahead} unpushed commit${this.ahead > 1 ? 's' : ''}</span>`;
            }
            if (this.behind > 0) {
                return html`<span class="text-amber-600 dark:text-amber-400">${this.behind} commit${this.behind > 1 ? 's' : ''} behind remote</span>`;
            }
            return html`<span class="text-green-600 dark:text-green-400">up to date with remote</span>`;
        }

        // On a feature branch
        if (this.mergedIntoPrimary) {
            return html`<span class="text-green-600 dark:text-green-400">merged into ${this.primaryBranch}</span>`;
        }
        if (!this.hasUpstream) {
            return html`<span class="text-amber-600 dark:text-amber-400">local only — not pushed</span>`;
        }
        if (this.ahead > 0) {
            return html`<span class="text-amber-600 dark:text-amber-400">${this.ahead} unpushed commit${this.ahead > 1 ? 's' : ''}</span>`;
        }
        return html`<span class="text-green-600 dark:text-green-400">pushed to remote branch</span>`;
    }

    private _renderPrimaryStatus() {
        if (this.isOnPrimary) return nothing;

        const primary = this.primaryBranch;
        if (this.mergedIntoPrimary && this.behindPrimary === 0) {
            return nothing; // Already shown as "merged into master" in remote status
        }
        if (this.mergedIntoPrimary && this.behindPrimary > 0) {
            return html`<div class="text-muted-foreground">
                ${primary} is <span class="text-blue-600 dark:text-blue-400">${this.behindPrimary} commit${this.behindPrimary > 1 ? 's' : ''} ahead</span> of this branch
            </div>`;
        }
        if (this.aheadOfPrimary > 0 && this.behindPrimary > 0) {
            return html`<div class="text-muted-foreground">
                vs ${primary}: <span class="text-blue-600 dark:text-blue-400">${this.aheadOfPrimary} ahead</span>, <span class="text-amber-600 dark:text-amber-400">${this.behindPrimary} behind</span>
            </div>`;
        }
        if (this.aheadOfPrimary > 0) {
            return html`<div class="text-muted-foreground">
                vs ${primary}: <span class="text-blue-600 dark:text-blue-400">${this.aheadOfPrimary} commit${this.aheadOfPrimary > 1 ? 's' : ''} not yet merged</span>
            </div>`;
        }
        return nothing;
    }

    /** Small PR status icon + number for the pill */
    private _prPillIcon() {
        if (!this.prState) return nothing;
        const colorClass = this.prState === 'OPEN' ? 'text-green-600/70 dark:text-green-400/70'
            : this.prState === 'MERGED' ? 'text-purple-600/70 dark:text-purple-400/70'
            : 'text-red-600/70 dark:text-red-400/70';
        return html`<span class="${colorClass} shrink-0" style="display:inline-flex;align-items:center;gap:1px" title="PR #${this.prNumber} ${this.prState.toLowerCase()}"><span style="font-size:10px">⦿</span>${this.prNumber != null ? html`<span style="font-size:10px">#${this.prNumber}</span>` : nothing}</span>`;
    }

    /** PR section for the expanded dropdown */
    private _renderPrSection() {
        if (!this.prState) return nothing;

        const badgeColor = this.prState === 'OPEN' ? 'oklch(0.68 0.12 145)'
            : this.prState === 'MERGED' ? 'oklch(0.62 0.13 300)'
            : 'oklch(0.62 0.14 25)';
        const badgeBg = this.prState === 'OPEN' ? 'oklch(0.68 0.12 145 / 0.12)'
            : this.prState === 'MERGED' ? 'oklch(0.62 0.13 300 / 0.12)'
            : 'oklch(0.62 0.14 25 / 0.12)';

        return html`
            <div class="border-t border-border pt-2 mt-2">
                <div class="text-muted-foreground mb-1 font-medium">Pull Request</div>
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                    ${this.prUrl ? html`
                        <a href=${this.prUrl} target="_blank" rel="noopener"
                           class="text-blue-600 dark:text-blue-400 hover:underline" style="font-size:12px">
                            #${this.prNumber} ${this.prTitle}
                        </a>
                    ` : html`<span style="font-size:12px">#${this.prNumber} ${this.prTitle}</span>`}
                    <span style="display:inline-block;padding:1px 6px;border-radius:9999px;font-size:10px;font-weight:600;color:${badgeColor};background:${badgeBg}">
                        ${this.prState}
                    </span>
                </div>
                ${this.prState === 'OPEN' ? html`
                    <div style="display:flex;align-items:center;gap:6px;margin-top:6px">
                        <select
                            style="font-size:11px;padding:2px 4px;border-radius:4px;border:1px solid var(--border);background:var(--card);color:var(--foreground)"
                            .value=${this.mergeMethod}
                            @change=${(e: Event) => { this.mergeMethod = (e.target as HTMLSelectElement).value as any; }}
                            ?disabled=${this.merging}
                        >
                            <option value="merge">Merge</option>
                            <option value="squash">Squash</option>
                            <option value="rebase">Rebase</option>
                        </select>
                        <button
                            style="font-size:11px;padding:2px 10px;border-radius:4px;border:1px solid var(--border);background:oklch(0.68 0.12 145 / 0.12);color:oklch(0.68 0.12 145);cursor:pointer;font-weight:500"
                            ?disabled=${this.merging || !this.prMergeable}
                            @click=${this._handleMerge}
                        >
                            ${this.merging ? 'Merging\u2026' : 'Merge PR'}
                        </button>
                        ${!this.prMergeable && !this.merging ? html`<span style="font-size:10px;color:var(--destructive)">Not mergeable</span>` : nothing}
                    </div>
                    ${this.mergeError ? html`<div style="font-size:11px;color:var(--destructive);margin-top:4px">${this.mergeError}</div>` : nothing}
                ` : nothing}
            </div>
        `;
    }

    private _handleMerge() {
        this.merging = true;
        this.mergeError = '';
        this.dispatchEvent(new CustomEvent('pr-merge', {
            bubbles: true,
            composed: true,
            detail: { method: this.mergeMethod },
        }));
    }

    /** Called by the parent after merge completes or fails */
    public setMergeResult(error?: string) {
        this.merging = false;
        this.mergeError = error || '';
    }

    render() {
        if (!this.branch && !this.loading) return nothing;

        const summaryColor = this.clean ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400';

        return html`
            <button
                class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-card border border-border text-muted-foreground hover:text-foreground transition-colors cursor-pointer text-[11px] leading-tight"
                style="max-width:100%"
                @click=${this._toggle}
            >
                ${this.loading
                    ? html`<span class="animate-pulse shrink-0">⎇</span>`
                    : html`<span class="shrink-0">⎇</span>`}
                <span class="truncate">${this.branch}</span>
                ${this.summary
                    ? html`<span class="${summaryColor} font-medium shrink-0">${this.summary}</span>`
                    : nothing}
                ${this._pillIndicator()}
                ${this._prPillIcon()}
            </button>

            ${this.expanded
                ? html`
                      <div
                          class="fixed z-50 bg-card border border-border rounded-lg shadow-lg p-3 text-xs"
                          style="max-width:min(420px, calc(100vw - 1rem))"
                          id="git-status-dropdown"
                      >
                          <div class="flex items-center gap-1.5 mb-2 text-foreground font-medium text-sm">
                              <span>⎇</span>
                              <span class="break-all">${this.branch}</span>
                              ${!this.isOnPrimary
                                  ? html`<span class="text-[10px] text-muted-foreground font-normal">(feature)</span>`
                                  : nothing}
                          </div>

                          <div class="flex flex-col gap-1 mb-2">
                              <div class="text-muted-foreground">
                                  Remote: ${this._renderRemoteStatus()}
                              </div>
                              ${this._renderPrimaryStatus()}
                          </div>

                          ${this._renderPrSection()}

                          ${this.statusFiles.length > 0
                              ? html`
                                    <div class="border-t border-border pt-2 mt-2">
                                        <div class="text-muted-foreground mb-1 font-medium">Changes</div>
                                        <div class="flex flex-col gap-0.5 max-h-[200px] overflow-y-auto">
                                            ${this.statusFiles.map(
                                                (f) => html`
                                                    <div class="flex items-center gap-2 py-0.5 min-w-0">
                                                        <span
                                                            class="${this._statusColor(f.status)} font-mono w-[70px] shrink-0 text-right"
                                                            title=${this._statusLabel(f.status)}
                                                        >
                                                            ${this._statusLabel(f.status)}
                                                        </span>
                                                        <span class="text-foreground truncate" title=${f.file}>
                                                            ${f.file}
                                                        </span>
                                                    </div>
                                                `
                                            )}
                                        </div>
                                    </div>
                                `
                              : html`
                                    <div class="text-green-600 dark:text-green-400 border-t border-border pt-2 mt-2">
                                        Working tree clean
                                    </div>
                                `}
                      </div>
                  `
                : nothing}
        `;
    }

    override updated(changed: Map<string, unknown>) {
        super.updated(changed);
        if (changed.has('expanded') && this.expanded) {
            this._positionDropdown();
        }
    }

    private _positionDropdown() {
        const btn = this.querySelector('button');
        const dropdown = this.querySelector('#git-status-dropdown') as HTMLElement;
        if (!btn || !dropdown) return;
        const rect = btn.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;

        // Anchor right edge to button's right edge
        dropdown.style.right = `${window.innerWidth - rect.right}px`;

        if (spaceAbove > spaceBelow) {
            // Open upward (default for chat input area)
            dropdown.style.bottom = `${window.innerHeight - rect.top + 4}px`;
            dropdown.style.top = '';
        } else {
            // Open downward (goal dashboard, near top of page)
            dropdown.style.top = `${rect.bottom + 4}px`;
            dropdown.style.bottom = '';
        }
    }
}
