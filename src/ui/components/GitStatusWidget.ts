import { html, LitElement, nothing, render } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import './DiffBlock.js';

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

    @property() sessionId = '';
    @property() goalId = '';
    @property() token = '';

    // PR status properties
    @property() prState?: string; // "OPEN" | "MERGED" | "CLOSED"
    @property() prUrl?: string;
    @property({ type: Number }) prNumber?: number;
    @property() prTitle?: string;
    @property() prMergeable?: string;
    @property({ type: Boolean }) viewerIsAdmin = false;
    @property() reviewDecision?: string; // "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null

    @state() private _modalFile: string | null = null;
    @state() private _loadingDiff: string | null = null;
    @state() private _diffContent: string | null = null;
    @state() private _diffError: string | null = null;

    @state() private _commitsLoading = false;
    @state() private _commits: Array<{sha:string;shortSha:string;message:string;author:string;timestamp:string;filesChanged:number;insertions:number;deletions:number}> = [];
    @state() private _commitsError: string | null = null;
    @state() private _commitsDirection: 'ahead' | 'behind' = 'ahead';
    @state() private _commitsVs?: 'primary';

    private _modalEl: HTMLElement | null = null;
    private _commitsModalEl: HTMLElement | null = null;

    private _onEscapeKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            if (this._commitsModalEl) this._closeCommitsModal();
            else if (this._modalEl) this._closeModal();
        }
    };

    @state() private expanded = false;
    @state() private merging = false;
    @state() private mergeError = '';
    @state() private mergeMethod: 'merge' | 'squash' | 'rebase' = 'squash';
    @state() private pulling = false;
    @state() private pullError = '';
    @state() private pushing = false;
    @state() private pushError = '';
    @state() private mergingPrimary = false;
    @state() private mergePrimaryError = '';

    private _dropdownEl: HTMLElement | null = null;

    private _onDocumentClick = (e: MouseEvent) => {
        const target = e.target as Node;
        if (this.expanded && !this.contains(target) && !this._dropdownEl?.contains(target)) {
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
        this._removeDropdown();
        this._removeModal();
        this._removeCommitsModal();
    }

    private _removeDropdown() {
        if (this._dropdownEl) {
            this._dropdownEl.remove();
            this._dropdownEl = null;
        }
    }

    private _toggle(e: MouseEvent) {
        e.stopPropagation();
        this.expanded = !this.expanded;
        if (this.expanded) {
            this.dispatchEvent(new CustomEvent('git-fetch', {
                bubbles: true,
                composed: true,
            }));
        }
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

    /** Pill segments: ~N dirty, ↓N behind primary (red), ↑N ahead primary (blue) */
    private _pillSegments() {
        const segments = [];
        // Dirty files
        if (!this.clean && this.statusFiles.length > 0) {
            segments.push(html`<span class="text-amber-600 dark:text-amber-400 shrink-0" style="font-weight:500">~${this.statusFiles.length}</span>`);
        }
        // Behind primary (red)
        if (!this.isOnPrimary && this.behindPrimary > 0) {
            segments.push(html`<span class="text-red-600 dark:text-red-400 shrink-0" style="font-weight:500">↓${this.behindPrimary}</span>`);
        }
        // Ahead of primary (blue)
        if (!this.isOnPrimary && this.aheadOfPrimary > 0) {
            segments.push(html`<span class="text-blue-600 dark:text-blue-400 shrink-0" style="font-weight:500">↑${this.aheadOfPrimary}</span>`);
        }
        return segments;
    }

    private _renderRemoteStatus() {
        // Remote tracking branch status — only show when there's something to report
        if (this.isOnPrimary) {
            // On primary: show ahead/behind remote
            if (this.ahead > 0 && this.behind > 0) {
                return html`<div class="text-muted-foreground">
                    Remote: <span class="text-amber-600 dark:text-amber-400" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" @click=${(e: MouseEvent) => { e.stopPropagation(); this._fetchCommits('ahead'); }}>${this.ahead} ahead</span>,
                    <span class="text-amber-600 dark:text-amber-400" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" @click=${(e: MouseEvent) => { e.stopPropagation(); this._fetchCommits('behind'); }}>${this.behind} behind</span>
                    ${this._renderPullButton()}
                </div>`;
            }
            if (this.ahead > 0) {
                return html`<div class="text-muted-foreground">
                    <span class="text-amber-600 dark:text-amber-400" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" @click=${(e: MouseEvent) => { e.stopPropagation(); this._fetchCommits('ahead'); }}>${this.ahead} unpushed</span> to remote
                    ${this._renderPushButton()}
                </div>`;
            }
            if (this.behind > 0) {
                return html`<div class="text-muted-foreground">
                    <span class="text-amber-600 dark:text-amber-400" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" @click=${(e: MouseEvent) => { e.stopPropagation(); this._fetchCommits('behind'); }}>${this.behind} behind</span> remote
                    ${this._renderPullButton()}
                </div>`;
            }
            return nothing; // up to date — don't clutter
        }

        // Feature branch: only show unpushed warning
        if (!this.hasUpstream) {
            return html`<div class="text-amber-600 dark:text-amber-400">Not pushed to remote ${this._renderPushButton()}</div>`;
        }
        if (this.ahead > 0) {
            return html`<div class="text-muted-foreground">
                <span class="text-amber-600 dark:text-amber-400" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" @click=${(e: MouseEvent) => { e.stopPropagation(); this._fetchCommits('ahead'); }}>${this.ahead} unpushed</span> to remote
                ${this._renderPushButton()}
            </div>`;
        }
        return nothing; // pushed and up to date — hide
    }

    private _renderPrimaryStatus() {
        if (this.isOnPrimary) {
            return html`<div class="text-green-600 dark:text-green-400">Up to date with origin/${this.primaryBranch}</div>`;
        }
        if (this.mergedIntoPrimary && this.behindPrimary === 0) {
            return html`<div class="text-green-600 dark:text-green-400">Merged into origin/${this.primaryBranch}</div>`;
        }
        if (this.aheadOfPrimary > 0 && this.behindPrimary > 0) {
            return html`<div class="text-muted-foreground">
                <span class="text-blue-600 dark:text-blue-400" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" @click=${(e: MouseEvent) => { e.stopPropagation(); this._fetchCommits('ahead', 'primary'); }}>${this.aheadOfPrimary} ahead</span>,
                <span class="text-red-600 dark:text-red-400" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" @click=${(e: MouseEvent) => { e.stopPropagation(); this._fetchCommits('behind', 'primary'); }}>${this.behindPrimary} behind</span>
                origin/${this.primaryBranch}
                ${this._renderMergePrimaryButton()}
            </div>`;
        }
        if (this.aheadOfPrimary > 0) {
            return html`<div class="text-muted-foreground">
                <span class="text-blue-600 dark:text-blue-400" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" @click=${(e: MouseEvent) => { e.stopPropagation(); this._fetchCommits('ahead', 'primary'); }}>${this.aheadOfPrimary} ahead</span>
                of origin/${this.primaryBranch}
                ${!this.prState ? this._renderAskPrButton() : nothing}
                ${!this.prState && this.viewerIsAdmin ? this._renderSquashPushButton() : nothing}
            </div>`;
        }
        if (this.behindPrimary > 0) {
            return html`<div class="text-muted-foreground">
                <span class="text-red-600 dark:text-red-400" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" @click=${(e: MouseEvent) => { e.stopPropagation(); this._fetchCommits('behind', 'primary'); }}>${this.behindPrimary} behind</span>
                origin/${this.primaryBranch}
                ${this._renderMergePrimaryButton()}
            </div>`;
        }
        return html`<div class="text-green-600 dark:text-green-400">Up to date with origin/${this.primaryBranch}</div>`;
    }

    /** Small PR status icon + number for the pill */
    private _prPillIcon() {
        if (!this.prState) return nothing;
        // When PR is open, color reflects review status
        let colorClass: string;
        let title: string;
        if (this.prState === 'MERGED') {
            colorClass = 'text-purple-600/70 dark:text-purple-400/70';
            title = `PR #${this.prNumber} merged`;
        } else if (this.prState === 'CLOSED') {
            colorClass = 'text-red-600/70 dark:text-red-400/70';
            title = `PR #${this.prNumber} closed`;
        } else if (this.reviewDecision === 'APPROVED') {
            colorClass = 'text-green-600/70 dark:text-green-400/70';
            title = `PR #${this.prNumber} approved`;
        } else if (this.reviewDecision === 'CHANGES_REQUESTED') {
            colorClass = 'text-red-600/70 dark:text-red-400/70';
            title = `PR #${this.prNumber} changes requested`;
        } else if (this.reviewDecision === 'REVIEW_REQUIRED') {
            colorClass = 'text-amber-600/70 dark:text-amber-400/70';
            title = `PR #${this.prNumber} awaiting review`;
        } else {
            colorClass = 'text-green-600/70 dark:text-green-400/70';
            title = `PR #${this.prNumber} open`;
        }
        const hasConflicts = this.prState === 'OPEN' && this.prMergeable === 'CONFLICTING';
        if (hasConflicts) title += ' — has conflicts';
        const pulseClass = hasConflicts ? ' pr-conflict-pulse' : '';
        return html`<span class="${colorClass}${pulseClass} shrink-0" style="display:inline-flex;align-items:center;gap:1px" title=${title}><span style="font-size:10px">⦿</span>${this.prNumber != null ? html`<span style="font-size:10px">#${this.prNumber}</span>` : nothing}</span>`;
    }

    /** Review decision badge for inside the PR section */
    private _renderReviewBadge() {
        if (!this.reviewDecision || this.prState !== 'OPEN') return nothing;
        const cfg: Record<string, { label: string; color: string; bg: string }> = {
            APPROVED: { label: 'Approved', color: 'oklch(0.68 0.12 145)', bg: 'oklch(0.68 0.12 145 / 0.12)' },
            CHANGES_REQUESTED: { label: 'Changes Requested', color: 'oklch(0.62 0.14 25)', bg: 'oklch(0.62 0.14 25 / 0.12)' },
            REVIEW_REQUIRED: { label: 'Awaiting Review', color: 'oklch(0.65 0.12 60)', bg: 'oklch(0.65 0.12 60 / 0.12)' },
        };
        const c = cfg[this.reviewDecision];
        if (!c) return nothing;
        return html`<span style="display:inline-block;padding:1px 6px;border-radius:9999px;font-size:10px;font-weight:600;color:${c.color};background:${c.bg}">${c.label}</span>`;
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
                    ${this._renderReviewBadge()}
                    ${this.prState === 'OPEN' && this.prMergeable === 'CONFLICTING' ? html`<span style="display:inline-block;padding:1px 6px;border-radius:9999px;font-size:10px;font-weight:600;color:oklch(0.62 0.14 25);background:oklch(0.62 0.14 25 / 0.12)">Has conflicts</span>` : nothing}
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
                        ${this.merging ? html`<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--muted-foreground)"><span style="display:inline-block;width:12px;height:12px;border:2px solid var(--border);border-top-color:var(--foreground);border-radius:50%;animation:git-spin 0.6s linear infinite"></span>Merging\u2026</span>` : html`
                        <button
                            style="font-size:11px;padding:2px 10px;border-radius:4px;border:1px solid var(--border);background:oklch(0.68 0.12 145 / 0.12);color:oklch(0.68 0.12 145);cursor:pointer;font-weight:500"
                            ?disabled=${this.prMergeable !== "MERGEABLE"}
                            @click=${() => this._handleMerge()}
                        >
                            Merge PR
                        </button>
                        ${this.viewerIsAdmin ? html`<button
                            style="font-size:11px;padding:2px 10px;border-radius:4px;border:1px solid var(--border);background:oklch(0.62 0.14 25 / 0.12);color:oklch(0.62 0.14 25);cursor:pointer;font-weight:500"
                            @click=${() => this._handleForceMerge()}
                            title="Merge with --admin to bypass branch protection rules"
                        >
                            Force Merge
                        </button>` : nothing}
                        ${this.prMergeable !== "MERGEABLE" && !this.viewerIsAdmin ? html`<span style="font-size:10px;color:var(--destructive)">${this.prMergeable === "CONFLICTING" ? "Has conflicts" : "Not mergeable"}</span>` : nothing}
                        `}
                    </div>
                    ${this.mergeError ? html`<div style="font-size:11px;color:var(--destructive);margin-top:4px">${this.mergeError}</div>` : nothing}
                ` : nothing}
            </div>
        `;
    }

    private _renderMergePrimaryButton() {
        return html`<button
            style="font-size:11px;padding:1px 8px;border-radius:4px;border:1px solid var(--border);background:oklch(0.55 0.12 250 / 0.12);color:oklch(0.55 0.12 250);cursor:pointer;font-weight:500;margin-left:4px"
            ?disabled=${this.mergingPrimary}
            @click=${(e: MouseEvent) => { e.stopPropagation(); this._handleMergePrimary(); }}
            title="Rebase this branch on top of origin/master"
        >${this.mergingPrimary ? 'Rebasing\u2026' : 'Rebase on master'}</button>${this.mergePrimaryError ? html`<span style="font-size:10px;color:var(--destructive);margin-left:4px">${this.mergePrimaryError}</span>` : nothing}`;
    }

    private _handleMergePrimary() {
        this.mergingPrimary = true;
        this.mergePrimaryError = '';
        this.dispatchEvent(new CustomEvent('git-merge-primary', {
            bubbles: true,
            composed: true,
        }));
    }

    public setMergePrimaryResult(error?: string) {
        this.mergingPrimary = false;
        this.mergePrimaryError = error || '';
    }

    private _renderAskCommitButton() {
        return html`<button
            style="font-size:11px;padding:1px 8px;border-radius:4px;border:1px solid var(--border);background:oklch(0.55 0.12 250 / 0.12);color:oklch(0.55 0.12 250);cursor:pointer;font-weight:500"
            @click=${(e: MouseEvent) => { e.stopPropagation(); this.dispatchEvent(new CustomEvent('ask-agent-commit', { bubbles: true, composed: true })); }}
        >Ask agent to commit</button>`;
    }

    private _renderAskPrButton() {
        return html`<button
            style="font-size:11px;padding:1px 8px;border-radius:4px;border:1px solid var(--border);background:oklch(0.55 0.12 250 / 0.12);color:oklch(0.55 0.12 250);cursor:pointer;font-weight:500;margin-left:4px"
            @click=${(e: MouseEvent) => { e.stopPropagation(); this.dispatchEvent(new CustomEvent('ask-agent-pr', { bubbles: true, composed: true })); }}
        >Ask agent to raise PR</button>`;
    }

    @state() private squashPushing = false;
    @state() private squashPushError = '';

    private _renderSquashPushButton() {
        return html`<button
            style="font-size:11px;padding:1px 8px;border-radius:4px;border:1px solid var(--border);background:oklch(0.55 0.12 145 / 0.12);color:oklch(0.55 0.12 145);cursor:pointer;font-weight:500;margin-left:4px"
            ?disabled=${this.squashPushing}
            @click=${(e: MouseEvent) => { e.stopPropagation(); this._handleSquashPush(); }}
            title="Squash all branch commits into one and push directly to master"
        >${this.squashPushing ? 'Pushing\u2026' : 'Squash push'}</button>${this.squashPushError ? html`<span style="font-size:10px;color:var(--destructive);margin-left:4px">${this.squashPushError}</span>` : nothing}`;
    }

    private _handleSquashPush() {
        this.squashPushing = true;
        this.squashPushError = '';
        this.dispatchEvent(new CustomEvent('git-squash-push', {
            bubbles: true,
            composed: true,
        }));
    }

    public setSquashPushResult(error?: string) {
        this.squashPushing = false;
        this.squashPushError = error || '';
    }

    private _renderPullButton() {
        return html`<button
            style="font-size:11px;padding:1px 8px;border-radius:4px;border:1px solid var(--border);background:oklch(0.55 0.12 250 / 0.12);color:oklch(0.55 0.12 250);cursor:pointer;font-weight:500;margin-left:4px"
            ?disabled=${this.pulling}
            @click=${() => this._handlePull()}
        >${this.pulling ? 'Pulling\u2026' : 'Pull'}</button>${this.pullError ? html`<span style="font-size:10px;color:var(--destructive);margin-left:4px">${this.pullError}</span>` : nothing}`;
    }

    private _handlePull() {
        this.pulling = true;
        this.pullError = '';
        this.dispatchEvent(new CustomEvent('git-pull', {
            bubbles: true,
            composed: true,
        }));
    }

    /** Called by the parent after pull completes or fails */
    public setPullResult(error?: string) {
        this.pulling = false;
        this.pullError = error || '';
    }

    private _renderPushButton() {
        return html`<button
            style="font-size:11px;padding:1px 8px;border-radius:4px;border:1px solid var(--border);background:oklch(0.55 0.12 145 / 0.12);color:oklch(0.55 0.12 145);cursor:pointer;font-weight:500;margin-left:4px"
            ?disabled=${this.pushing}
            @click=${() => this._handlePush()}
        >${this.pushing ? 'Pushing\u2026' : 'Push'}</button>${this.pushError ? html`<span style="font-size:10px;color:var(--destructive);margin-left:4px">${this.pushError}</span>` : nothing}`;
    }

    private _handlePush() {
        this.pushing = true;
        this.pushError = '';
        this.dispatchEvent(new CustomEvent('git-push', {
            bubbles: true,
            composed: true,
        }));
    }

    /** Called by the parent after push completes or fails */
    public setPushResult(error?: string) {
        this.pushing = false;
        this.pushError = error || '';
        // Refresh git status after push
        this.dispatchEvent(new CustomEvent('git-fetch', {
            bubbles: true,
            composed: true,
        }));
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

    private _handleForceMerge() {
        this.merging = true;
        this.mergeError = '';
        this.dispatchEvent(new CustomEvent('pr-merge', {
            bubbles: true,
            composed: true,
            detail: { method: this.mergeMethod, admin: true },
        }));
    }

    /** Called by the parent after merge completes or fails */
    public setMergeResult(error?: string) {
        this.merging = false;
        this.mergeError = error || '';
        // Refresh git status after merge attempt
        this.dispatchEvent(new CustomEvent('git-fetch', {
            bubbles: true,
            composed: true,
        }));
    }

    private async _openDiffModal(file: string) {
        this._modalFile = file;
        this._loadingDiff = file;
        this._diffContent = null;
        this._diffError = null;
        this._showModal();

        const base = this.sessionId
            ? `/api/sessions/${this.sessionId}/git-diff`
            : `/api/goals/${this.goalId}/git-diff`;
        const url = `${base}?file=${encodeURIComponent(file)}`;
        try {
            const headers: Record<string, string> = {};
            if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
            const resp = await fetch(url, { headers });
            if (this._modalFile !== file) return;
            if (!resp.ok) {
                const body = await resp.json().catch(() => ({}));
                this._diffError = (body as Record<string, string>).error || `HTTP ${resp.status}`;
            } else {
                const body = await resp.json();
                this._diffContent = (body as Record<string, string>).diff;
            }
        } catch (err) {
            if (this._modalFile !== file) return;
            this._diffError = String(err);
        }
        this._loadingDiff = null;
        this._renderModal();
    }

    private _showModal() {
        this._removeModal();
        this._modalEl = document.createElement('div');
        this._modalEl.id = 'git-diff-modal';
        document.body.appendChild(this._modalEl);
        document.addEventListener('keydown', this._onEscapeKey);
        this._renderModal();
    }

    private _renderModal() {
        if (!this._modalEl || !this._modalFile) return;

        let body;
        if (this._loadingDiff === this._modalFile) {
            body = html`<div class="flex items-center gap-2 text-muted-foreground p-8">
                <span style="display:inline-block;width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--foreground);border-radius:50%;animation:git-spin 0.6s linear infinite"></span>
                Loading diff\u2026
            </div>`;
        } else if (this._diffError) {
            body = html`<div class="p-8" style="color:var(--destructive)">${this._diffError}</div>`;
        } else if (this._diffContent) {
            body = html`<diff-block .content=${this._diffContent}></diff-block>`;
        } else {
            body = html`<div class="p-8 text-muted-foreground">No diff available</div>`;
        }

        render(html`
            <div style="position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px"
                 @click=${(e: MouseEvent) => { if (e.target === e.currentTarget) this._closeModal(); }}>
                <div style="position:absolute;inset:0;background:rgba(0,0,0,0.5)" @click=${() => this._closeModal()}></div>
                <div style="position:relative;width:100%;max-width:calc(100vw - 48px);height:calc(100vh - 48px);display:flex;flex-direction:column;background:var(--card);color:var(--foreground);border:1px solid var(--border);border-radius:8px;overflow:hidden;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25)">
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border);flex-shrink:0">
                        <span class="font-mono text-sm text-foreground truncate" title=${this._modalFile}>${this._modalFile}</span>
                        <button
                            style="background:none;border:none;color:var(--muted-foreground);cursor:pointer;padding:4px 8px;font-size:18px;line-height:1;border-radius:4px"
                            class="hover:text-foreground hover:bg-muted/50"
                            @click=${() => this._closeModal()}
                            title="Close"
                        >&times;</button>
                    </div>
                    <div style="flex:1;overflow:auto">${body}</div>
                </div>
            </div>
        `, this._modalEl);
    }

    private _closeModal() {
        this._modalFile = null;
        this._diffContent = null;
        this._diffError = null;
        this._removeModal();
    }

    private _removeModal() {
        document.removeEventListener('keydown', this._onEscapeKey);
        if (this._modalEl) {
            this._modalEl.remove();
            this._modalEl = null;
        }
    }

    private async _fetchCommits(direction: 'ahead' | 'behind' = 'ahead', vs?: 'primary') {
        this._commitsLoading = true;
        this._commits = [];
        this._commitsError = null;
        this._commitsDirection = direction;
        this._commitsVs = vs;
        this._showCommitsModal();

        const basePath = this.sessionId
            ? `/api/sessions/${this.sessionId}/commits`
            : `/api/goals/${this.goalId}/commits`;
        const params = new URLSearchParams();
        if (direction === 'behind') params.set('direction', 'behind');
        if (vs) params.set('vs', vs);
        const base = params.toString() ? `${basePath}?${params}` : basePath;
        try {
            const headers: Record<string, string> = {};
            if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
            const resp = await fetch(base, { headers });
            if (!resp.ok) {
                const body = await resp.json().catch(() => ({}));
                this._commitsError = (body as Record<string, string>).error || `HTTP ${resp.status}`;
            } else {
                const body = await resp.json();
                this._commits = (body as Record<string, unknown>).commits as typeof this._commits || [];
            }
        } catch (err) {
            this._commitsError = String(err);
        }
        this._commitsLoading = false;
        this._renderCommitsModal();
    }

    private _showCommitsModal() {
        this._removeCommitsModal();
        this._commitsModalEl = document.createElement('div');
        this._commitsModalEl.id = 'git-commits-modal';
        document.body.appendChild(this._commitsModalEl);
        document.addEventListener('keydown', this._onEscapeKey);
        this._renderCommitsModal();
    }

    private _renderCommitsModal() {
        if (!this._commitsModalEl) return;

        let body;
        if (this._commitsLoading) {
            body = html`<div class="flex items-center gap-2 text-muted-foreground p-8">
                <span style="display:inline-block;width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--foreground);border-radius:50%;animation:git-spin 0.6s linear infinite"></span>
                Loading commits\u2026
            </div>`;
        } else if (this._commitsError) {
            body = html`<div class="p-8" style="color:var(--destructive)">${this._commitsError}</div>`;
        } else if (this._commits.length === 0) {
            body = html`<div class="p-8 text-muted-foreground">${this._commitsDirection === 'behind' ? 'No incoming commits' : 'No unpushed commits'}</div>`;
        } else {
            body = html`<div class="flex flex-col">
                ${this._commits.map(c => html`
                    <div class="flex items-start gap-3 px-4 py-3 border-b border-border last:border-b-0 hover:bg-muted/30" style="min-width:0">
                        <span class="font-mono text-[11px] text-muted-foreground shrink-0 pt-0.5" title=${c.sha}>${c.shortSha}</span>
                        <div class="flex-1 min-w-0">
                            <div class="text-sm text-foreground break-words">${c.message}</div>
                            <div class="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground">
                                <span>${c.author}</span>
                                <span>${this._relativeTime(c.timestamp)}</span>
                                ${c.filesChanged > 0 ? html`<span class="flex items-center gap-1.5">
                                    <span>${c.filesChanged} file${c.filesChanged !== 1 ? 's' : ''}</span>
                                    ${c.insertions > 0 ? html`<span class="text-green-600 dark:text-green-400">+${c.insertions}</span>` : nothing}
                                    ${c.deletions > 0 ? html`<span class="text-red-600 dark:text-red-400">-${c.deletions}</span>` : nothing}
                                </span>` : nothing}
                            </div>
                        </div>
                    </div>
                `)}
            </div>`;
        }

        render(html`
            <div style="position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px"
                 @click=${(e: MouseEvent) => { if (e.target === e.currentTarget) this._closeCommitsModal(); }}>
                <div style="position:absolute;inset:0;background:rgba(0,0,0,0.5)" @click=${() => this._closeCommitsModal()}></div>
                <div style="position:relative;width:100%;max-width:600px;max-height:calc(100vh - 48px);display:flex;flex-direction:column;background:var(--card);color:var(--foreground);border:1px solid var(--border);border-radius:8px;overflow:hidden;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25)">
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border);flex-shrink:0">
                        <span class="text-sm font-medium text-foreground">${this._commits.length} ${this._commitsVs === 'primary' ? (this._commitsDirection === 'behind' ? 'Behind Master' : 'Ahead of Master') : (this._commitsDirection === 'behind' ? 'Incoming' : 'Unpushed')} Commit${this._commits.length !== 1 ? 's' : ''}</span>
                        <button
                            style="background:none;border:none;color:var(--muted-foreground);cursor:pointer;padding:4px 8px;font-size:18px;line-height:1;border-radius:4px"
                            class="hover:text-foreground hover:bg-muted/50"
                            @click=${() => this._closeCommitsModal()}
                            title="Close"
                        >&times;</button>
                    </div>
                    <div style="flex:1;overflow:auto">${body}</div>
                </div>
            </div>
        `, this._commitsModalEl);
    }

    private _closeCommitsModal() {
        this._commits = [];
        this._commitsError = null;
        this._commitsLoading = false;
        this._removeCommitsModal();
    }

    private _removeCommitsModal() {
        if (this._commitsModalEl) {
            document.removeEventListener('keydown', this._onEscapeKey);
            this._commitsModalEl.remove();
            this._commitsModalEl = null;
        }
    }

    private _relativeTime(timestamp: string): string {
        const now = Date.now();
        const then = new Date(timestamp).getTime();
        const seconds = Math.floor((now - then) / 1000);
        if (seconds < 60) return 'just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        if (days < 30) return `${days}d ago`;
        return new Date(timestamp).toLocaleDateString();
    }

    private _renderDropdownContent() {
        return html`
            <div class="flex items-center gap-1.5 mb-2 text-foreground font-medium text-sm">
                <span>⎇</span>
                <span class="break-all">${this.branch}</span>
            </div>

            <div class="flex flex-col gap-1 mb-2">
                ${this._renderPrimaryStatus()}
                ${this._renderRemoteStatus()}
            </div>

            ${this._renderPrSection()}

            ${this.statusFiles.length > 0
                ? html`
                      <div class="border-t border-border pt-2 mt-2">
                          <div class="text-muted-foreground mb-1 flex items-center gap-2">
                              <span class="text-amber-600 dark:text-amber-400">${this.statusFiles.length} uncommitted change${this.statusFiles.length !== 1 ? 's' : ''}</span>
                              ${this._renderAskCommitButton()}
                          </div>
                          <div class="flex flex-col gap-0.5 overflow-y-auto" style="max-height:200px">
                              ${this.statusFiles.map(
                                  (f) => html`
                                      <div class="flex items-center gap-2 py-0.5 min-w-0 rounded px-1 -mx-1 ${(this.sessionId || this.goalId) ? 'cursor-pointer hover:bg-muted/50' : ''}"
                                           @click=${() => (this.sessionId || this.goalId) ? this._openDiffModal(f.file) : undefined}>
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
        `;
    }

    render() {
        if (!this.branch && !this.loading) return nothing;

        const segments = this._pillSegments();
        // Show 'clean' only when no other indicators are present and no PR
        const showClean = this.clean && segments.length === 0 && !this.prState
            && (this.isOnPrimary || this.mergedIntoPrimary)
            && (this.isOnPrimary || this.aheadOfPrimary === 0);

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
                ${showClean ? html`<span class="text-green-600 dark:text-green-400 font-medium shrink-0">clean</span>` : nothing}
                ${segments}
                ${this._prPillIcon()}
            </button>
        `;
    }

    override updated(changed: Map<string, unknown>) {
        super.updated(changed);
        if (changed.has('expanded')) {
            if (this.expanded) {
                // Create portal dropdown on body
                this._dropdownEl = document.createElement('div');
                this._dropdownEl.id = 'git-status-dropdown';
                this._dropdownEl.className = 'fixed z-[9999] bg-card border border-border rounded-lg shadow-lg p-3 text-xs';
                this._dropdownEl.style.maxWidth = 'min(420px, calc(100vw - 1rem))';
                document.body.appendChild(this._dropdownEl);
                render(this._renderDropdownContent(), this._dropdownEl);
                this._positionDropdown();
            } else {
                this._removeDropdown();
            }
        } else if (this.expanded && this._dropdownEl) {
            // Re-render dropdown content when other reactive properties change
            render(this._renderDropdownContent(), this._dropdownEl);
        }
    }

    private _positionDropdown() {
        const btn = this.querySelector('button');
        const dropdown = this._dropdownEl;
        if (!btn || !dropdown) return;
        const rect = btn.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;
        const vw = window.innerWidth;
        const pad = 8; // min distance from viewport edge

        // Anchor right edge to button's right edge
        let rightVal = vw - rect.right;

        // Clamp: ensure dropdown doesn't overflow left edge of viewport
        const dropdownWidth = dropdown.offsetWidth || 0;
        if (dropdownWidth > 0) {
            const leftEdge = vw - rightVal - dropdownWidth;
            if (leftEdge < pad) {
                rightVal = Math.max(pad, vw - dropdownWidth - pad);
            }
        }

        dropdown.style.right = `${rightVal}px`;
        dropdown.style.left = '';

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
