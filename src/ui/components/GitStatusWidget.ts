import { html, LitElement, nothing, render } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import './DiffBlock.js';
import { listLauncherEntrypoints, runLauncherEntrypoint } from '../../app/pack-entrypoints.js';
import { ensureCommandPalette, openCommandPalette } from './CommandPalette.js';

@customElement('git-status-widget')
export class GitStatusWidget extends LitElement {
    @property() branch = '';
    @property() primaryBranch = 'master';
    /**
     * Display-ready ref name used for ahead/behind-primary comparisons.
     * `origin/<primaryBranch>` when origin has the ref, else the bare local
     * branch (e.g. when a configured `base_ref` points at a local-only branch).
     * Always render this verbatim — do NOT synthesise `origin/${primaryBranch}`.
     * Default mirrors today's behaviour for the bootstrap render before the
     * server payload lands.
     */
    @property() primaryRef = 'origin/master';
    @property({ type: Boolean }) isOnPrimary = true;
    @property() summary = '';
    @property({ type: Boolean }) clean = true;
    @property({ type: Boolean }) hasUpstream = false;
    @property({ type: Number }) ahead = 0;
    @property({ type: Number }) behind = 0;
    @property({ type: Number }) aheadOfPrimary = 0;
    @property({ type: Number }) behindPrimary = 0;
    @property({ type: Number }) insertionsVsPrimary = 0;
    @property({ type: Number }) deletionsVsPrimary = 0;
    @property({ type: Boolean }) mergedIntoPrimary = false;
    @property({ type: Boolean }) unpushed = false;
    @property({ type: Array }) statusFiles: Array<{ file: string; status: string }> = [];
    @property({ type: Boolean }) loading = false;
    @property({ type: Boolean }) partial = false;

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
    @property() headRefName?: string; // The actual branch name the PR targets

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

    /**
     * Multi-repo aware envelope. When set with >1 entry, the widget renders
     * per-repo collapsible sections inside the dropdown and shows an aggregate
     * count in the pill (e.g. "3 changed across 2 repos"). Single-key
     * (`"."`) cases use the flat render and the pill stays simple.
     *
     * Per-repo entries accept the canonical server envelope from
     * `GET /api/goals/:id/git-status`: each value carries either `statusFiles`
     * (preferred) or the legacy `status` field. We tolerate both so the
     * widget can be wired against either shape without server contortions.
     */
    @property({ type: Object }) repos?: Record<string, {
        summary?: string;
        clean?: boolean;
        statusFiles?: Array<{ file: string; status: string }>;
        status?: Array<{ file: string; status: string }>;
        aheadOfPrimary?: number;
        behindPrimary?: number;
        insertionsVsPrimary?: number;
        deletionsVsPrimary?: number;
    }>;

    /** Files for a per-repo entry, tolerating both `statusFiles` and `status`. */
    private _repoFiles(info: { statusFiles?: Array<{ file: string; status: string }>; status?: Array<{ file: string; status: string }> } | undefined): Array<{ file: string; status: string }> {
        if (!info) return [];
        return info.statusFiles ?? info.status ?? [];
    }

    /** Total dirty-file count across all repos in `repos` (multi-repo mode). */
    private _aggregateDirtyCount(): number {
        if (!this.repos) return 0;
        let n = 0;
        for (const info of Object.values(this.repos)) n += this._repoFiles(info).length;
        return n;
    }

    /** True if this widget is rendering multi-repo data (>1 entry, ignoring "." alone). */
    private _isMultiRepo(): boolean {
        if (!this.repos) return false;
        const keys = Object.keys(this.repos);
        return keys.length > 1;
    }

    /** Helper: how many distinct repos this widget has data for. */
    getRepoCount(): number {
        if (!this.repos) return 1;
        return Object.keys(this.repos).length;
    }

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
    private _closeToken = 0;

    @state() private _closing = false;

    private _onDocumentClick = (e: MouseEvent) => {
        const target = e.target as Node;
        if (this.expanded && !this._closing && !this.contains(target) && !this._dropdownEl?.contains(target)) {
            this._closeDropdown();
        }
    };

    private _onEscapeKeyDropdown = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && this.expanded && !this._closing && !this._modalEl && !this._commitsModalEl) {
            e.stopPropagation();
            this._closeDropdown();
        }
    };

    private _closeDropdown() {
        if (this._closing || !this._dropdownEl) return;
        this._closing = true;
        const closeToken = ++this._closeToken;
        this._dropdownEl.classList.add('git-dropdown-closing');
        const reset = () => {
            if (closeToken !== this._closeToken) return;
            this._closing = false;
            this.expanded = false;
        };
        this._dropdownEl.addEventListener('animationend', reset, { once: true });
        // Removing an animating portal fires animationcancel, not animationend.
        // Mirror the reset path so cancelled close animations cannot wedge the widget.
        this._dropdownEl.addEventListener('animationcancel', reset, { once: true });
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        document.addEventListener('click', this._onDocumentClick, true);
        document.addEventListener('keydown', this._onEscapeKeyDropdown, true);
        // Slice C1 — ensure the shared command-palette overlay host exists wherever
        // the session chrome renders, so pack `command-palette` launchers have a
        // surface. Idempotent; never auto-opens (open is a user gesture).
        try { ensureCommandPalette(); } catch { /* non-fatal */ }
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        document.removeEventListener('click', this._onDocumentClick, true);
        document.removeEventListener('keydown', this._onEscapeKeyDropdown, true);
        // Invalidate any in-flight close-animation listeners before removing the
        // portaled dropdown. The portal lives under document.body, not our
        // subtree, so disconnecting mid-close can cancel animationend entirely.
        this._closeToken++;
        this._removeDropdown();
        this._removeModal();
        this._removeCommitsModal();
        this._closing = false;
        this.expanded = false;
    }

    private _removeDropdown() {
        if (this._dropdownEl) {
            this._dropdownEl.remove();
            this._dropdownEl = null;
        }
    }

    private _toggle(e: MouseEvent) {
        e.stopPropagation();
        // Skeleton is non-interactive — no data to show in dropdown yet.
        if (this.loading && !this.branch) return;

        // Portal presence is the source of truth for whether the dropdown is
        // actually visible. If state says open but the portaled element was
        // removed during a disconnect/reconnect or external cleanup, treat this
        // click as an open and rebuild the portal instead of wedging in close.
        const hasConnectedDropdown = this._dropdownEl?.isConnected === true;
        const visiblyOpen = this.expanded && !this._closing && hasConnectedDropdown;
        if (visiblyOpen) {
            this._closeDropdown();
            return;
        }

        if (this._dropdownEl && (!hasConnectedDropdown || !this.expanded)) {
            this._removeDropdown();
        }
        this._closeToken++;
        this._closing = false;
        this._dropdownEl?.classList.remove('git-dropdown-closing');
        if (this._dropdownEl) {
            render(this._renderDropdownContent(), this._dropdownEl);
            this._positionDropdown();
        }
        const wasExpanded = this.expanded;
        this.expanded = true;
        if (wasExpanded && !this._dropdownEl) {
            this.requestUpdate('expanded', false);
        }
        this.dispatchEvent(new CustomEvent('git-fetch', {
            bubbles: true,
            composed: true,
        }));
        // Signal to parent (session-manager / goal-dashboard) that the
        // dropdown was opened so it can refetch with ?untracked=1 for
        // the full untracked-files list.
        this.dispatchEvent(new CustomEvent('git-status-dropdown-open', {
            bubbles: true,
            composed: true,
        }));
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

    /** Colored ahead/behind/insertion/deletion segment spans, shared by the flat
     *  pill (`_pillSegments`) and the multi-repo aggregate pill so styling never
     *  diverges. Order: ↓behind (red), ↑ahead (blue), +ins (green), -del (red). */
    private _segmentSpans(stats: { ahead: number; behind: number; ins: number; del: number }) {
        const spans = [];
        if (stats.behind > 0) {
            spans.push(html`<span class="text-red-600 dark:text-red-400 shrink-0" style="font-weight:500">↓${stats.behind}</span>`);
        }
        if (stats.ahead > 0) {
            spans.push(html`<span class="text-blue-600 dark:text-blue-400 shrink-0" style="font-weight:500">↑${stats.ahead}</span>`);
        }
        if (stats.ins > 0) {
            spans.push(html`<span class="text-green-600 dark:text-green-400 shrink-0" style="font-weight:500">+${stats.ins}</span>`);
        }
        if (stats.del > 0) {
            spans.push(html`<span class="text-red-600 dark:text-red-400 shrink-0" style="font-weight:500">-${stats.del}</span>`);
        }
        return spans;
    }

    /** Sum of primary-comparison stats across all repos (multi-repo mode). */
    private _aggregatePrimaryStats(): { ahead: number; behind: number; ins: number; del: number } {
        const acc = { ahead: 0, behind: 0, ins: 0, del: 0 };
        if (!this.repos) return acc;
        for (const info of Object.values(this.repos)) {
            if (typeof info.aheadOfPrimary === 'number') acc.ahead += info.aheadOfPrimary;
            if (typeof info.behindPrimary === 'number') acc.behind += info.behindPrimary;
            if (typeof info.insertionsVsPrimary === 'number') acc.ins += info.insertionsVsPrimary;
            if (typeof info.deletionsVsPrimary === 'number') acc.del += info.deletionsVsPrimary;
        }
        return acc;
    }

    /** Pill segments: ~N dirty, ↓N behind primary (red), ↑N ahead primary (blue) */
    private _pillSegments() {
        const segments = [];
        // Dirty files
        if (!this.clean && this.statusFiles.length > 0) {
            segments.push(html`<span class="text-amber-600 dark:text-amber-400 shrink-0" style="font-weight:500">~${this.statusFiles.length}</span>`);
        }
        // Ahead/behind/insertions/deletions vs primary (shared markup).
        if (!this.isOnPrimary) {
            segments.push(...this._segmentSpans({
                ahead: this.aheadOfPrimary,
                behind: this.behindPrimary,
                ins: this.insertionsVsPrimary,
                del: this.deletionsVsPrimary,
            }));
        }
        return segments;
    }

    private _renderRemoteStatus() {
        // Feature branches: remote is auto-pushed, no UI needed
        if (!this.isOnPrimary) return nothing;

        // On primary branch only: show ahead/behind remote (edge case)
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
        return nothing;
    }

    private _renderPrimaryStatus() {
        // Render the actual ref name (`primaryRef`) rather than synthesising
        // `origin/${primaryBranch}` — the project may have `base_ref` pointed
        // at a local-only branch with no origin counterpart.
        if (this.isOnPrimary) {
            return html`<div class="text-green-600 dark:text-green-400">Up to date with ${this.primaryRef}</div>`;
        }
        if (this.mergedIntoPrimary && this.behindPrimary === 0) {
            return html`<div class="text-green-600 dark:text-green-400">Merged into ${this.primaryRef}</div>`;
        }
        if (this.aheadOfPrimary > 0 && this.behindPrimary > 0) {
            return html`<div class="text-muted-foreground">
                <span class="text-blue-600 dark:text-blue-400" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" @click=${(e: MouseEvent) => { e.stopPropagation(); this._fetchCommits('ahead', 'primary'); }}>${this.aheadOfPrimary} ahead</span>,
                <span class="text-red-600 dark:text-red-400" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" @click=${(e: MouseEvent) => { e.stopPropagation(); this._fetchCommits('behind', 'primary'); }}>${this.behindPrimary} behind</span>
                ${this.primaryRef}
                ${this._renderMergePrimaryButton()}
            </div>`;
        }
        if (this.aheadOfPrimary > 0) {
            return html`<div class="text-muted-foreground">
                <span class="text-blue-600 dark:text-blue-400" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" @click=${(e: MouseEvent) => { e.stopPropagation(); this._fetchCommits('ahead', 'primary'); }}>${this.aheadOfPrimary} ahead</span>
                of ${this.primaryRef}
                ${!this.prState ? this._renderAskPrButton() : nothing}
                ${!this.prState && this.viewerIsAdmin ? this._renderSquashPushButton() : nothing}
            </div>`;
        }
        if (this.behindPrimary > 0) {
            return html`<div class="text-muted-foreground">
                <span class="text-red-600 dark:text-red-400" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" @click=${(e: MouseEvent) => { e.stopPropagation(); this._fetchCommits('behind', 'primary'); }}>${this.behindPrimary} behind</span>
                ${this.primaryRef}
                ${this._renderMergePrimaryButton()}
            </div>`;
        }
        return html`<div class="text-green-600 dark:text-green-400">Up to date with ${this.primaryRef}</div>`;
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
        return html`<span class="${colorClass}${pulseClass} shrink-0" style="display:inline-flex;align-items:center;gap:1px" title=${title}><span style="font-size:11px">⦿</span>${this.prNumber != null ? html`<span style="font-size:11px">#${this.prNumber}</span>` : nothing}</span>`;
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
        return html`<span style="display:inline-block;padding:1px 6px;border-radius:9999px;font-size:11px;font-weight:600;color:${c.color};background:${c.bg}">${c.label}</span>`;
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
                           class="text-blue-600 dark:text-blue-400 hover:underline" style="font-size:13px">
                            #${this.prNumber} ${this.prTitle}
                        </a>
                    ` : html`<span style="font-size:13px">#${this.prNumber} ${this.prTitle}</span>`}
                    <span style="display:inline-block;padding:1px 6px;border-radius:9999px;font-size:11px;font-weight:600;color:${badgeColor};background:${badgeBg}">
                        ${this.prState}
                    </span>
                    ${this._renderReviewBadge()}
                    ${this.prState === 'OPEN' && this.prMergeable === 'CONFLICTING' ? html`<span style="display:inline-block;padding:1px 6px;border-radius:9999px;font-size:11px;font-weight:600;color:oklch(0.62 0.14 25);background:oklch(0.62 0.14 25 / 0.12)">Has conflicts</span>` : nothing}
                </div>
                ${this.prState === 'OPEN' ? html`
                    <div style="display:flex;align-items:center;gap:6px;margin-top:6px">
                        <select
                            style="font-size:12px;padding:2px 4px;border-radius:4px;border:1px solid var(--border);background:var(--card);color:var(--foreground)"
                            .value=${this.mergeMethod}
                            @change=${(e: Event) => { this.mergeMethod = (e.target as HTMLSelectElement).value as any; }}
                            ?disabled=${this.merging}
                        >
                            <option value="merge">Merge</option>
                            <option value="squash">Squash</option>
                            <option value="rebase">Rebase</option>
                        </select>
                        ${this.merging ? html`<span style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--muted-foreground)"><span style="display:inline-block;width:12px;height:12px;border:2px solid var(--border);border-top-color:var(--foreground);border-radius:50%;animation:git-spin 0.6s linear infinite"></span>Merging\u2026</span>` : html`
                        <button
                            style="font-size:12px;padding:2px 10px;border-radius:4px;border:1px solid var(--border);background:oklch(0.68 0.12 145 / 0.12);color:oklch(0.68 0.12 145);cursor:pointer;font-weight:500"
                            ?disabled=${this.prMergeable !== "MERGEABLE"}
                            @click=${() => this._handleMerge()}
                        >
                            Merge PR
                        </button>
                        ${this.viewerIsAdmin ? html`<button
                            style="font-size:12px;padding:2px 10px;border-radius:4px;border:1px solid var(--border);background:oklch(0.62 0.14 25 / 0.12);color:oklch(0.62 0.14 25);cursor:pointer;font-weight:500"
                            @click=${() => this._handleForceMerge()}
                            title="Merge with --admin to bypass branch protection rules"
                        >
                            Force Merge
                        </button>` : nothing}
                        ${this.prMergeable !== "MERGEABLE" && !this.viewerIsAdmin ? html`<span style="font-size:11px;color:var(--destructive)">${this.prMergeable === "CONFLICTING" ? "Has conflicts" : "Not mergeable"}</span>` : nothing}
                        `}
                    </div>
                    ${this.mergeError ? html`<div style="font-size:12px;color:var(--destructive);margin-top:4px">${this.mergeError}</div>` : nothing}
                ` : nothing}
            </div>
        `;
    }

    private _renderMergePrimaryButton() {
        // Label uses the bare branch name to stay compact ("Rebase on dev");
        // tooltip carries the full resolved ref (`origin/dev` or local `dev`)
        // so the user can see exactly what the rebase will target.
        return html`<button
            style="font-size:12px;padding:1px 8px;border-radius:4px;border:1px solid var(--border);background:oklch(0.55 0.12 250 / 0.12);color:oklch(0.55 0.12 250);cursor:pointer;font-weight:500;margin-left:4px"
            ?disabled=${this.mergingPrimary}
            @click=${(e: MouseEvent) => { e.stopPropagation(); this._handleMergePrimary(); }}
            title="Rebase this branch on top of ${this.primaryRef}"
        >${this.mergingPrimary ? 'Rebasing\u2026' : `Rebase on ${this.primaryBranch}`}</button>${this.mergePrimaryError ? html`<span style="font-size:11px;color:var(--destructive);margin-left:4px">${this.mergePrimaryError}</span>` : nothing}`;
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
            style="font-size:12px;padding:1px 8px;border-radius:4px;border:1px solid var(--border);background:oklch(0.55 0.12 250 / 0.12);color:oklch(0.55 0.12 250);cursor:pointer;font-weight:500"
            @click=${(e: MouseEvent) => { e.stopPropagation(); this.dispatchEvent(new CustomEvent('ask-agent-commit', { bubbles: true, composed: true })); }}
        >Ask agent to commit</button>`;
    }

    private _renderAskPrButton() {
        return html`<button
            style="font-size:12px;padding:1px 8px;border-radius:4px;border:1px solid var(--border);background:oklch(0.55 0.12 250 / 0.12);color:oklch(0.55 0.12 250);cursor:pointer;font-weight:500;margin-left:4px"
            @click=${(e: MouseEvent) => { e.stopPropagation(); this.dispatchEvent(new CustomEvent('ask-agent-pr', { bubbles: true, composed: true })); }}
        >Ask agent to raise PR</button>`;
    }

    @state() private squashPushing = false;
    @state() private squashPushError = '';

    private _renderSquashPushButton() {
        return html`<button
            style="font-size:12px;padding:1px 8px;border-radius:4px;border:1px solid var(--border);background:oklch(0.55 0.12 145 / 0.12);color:oklch(0.55 0.12 145);cursor:pointer;font-weight:500;margin-left:4px"
            ?disabled=${this.squashPushing}
            @click=${(e: MouseEvent) => { e.stopPropagation(); this._handleSquashPush(); }}
            title="Squash all branch commits into one and push directly to ${this.primaryBranch}"
        >${this.squashPushing ? 'Pushing\u2026' : 'Squash push'}</button>${this.squashPushError ? html`<span style="font-size:11px;color:var(--destructive);margin-left:4px">${this.squashPushError}</span>` : nothing}`;
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
            style="font-size:12px;padding:1px 8px;border-radius:4px;border:1px solid var(--border);background:oklch(0.55 0.12 250 / 0.12);color:oklch(0.55 0.12 250);cursor:pointer;font-weight:500;margin-left:4px"
            ?disabled=${this.pulling}
            @click=${() => this._handlePull()}
        >${this.pulling ? 'Pulling\u2026' : 'Pull'}</button>${this.pullError ? html`<span style="font-size:11px;color:var(--destructive);margin-left:4px">${this.pullError}</span>` : nothing}`;
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
            style="font-size:12px;padding:1px 8px;border-radius:4px;border:1px solid var(--border);background:oklch(0.55 0.12 145 / 0.12);color:oklch(0.55 0.12 145);cursor:pointer;font-weight:500;margin-left:4px"
            ?disabled=${this.pushing}
            @click=${() => this._handlePush()}
        >${this.pushing ? 'Pushing\u2026' : 'Push'}</button>${this.pushError ? html`<span style="font-size:11px;color:var(--destructive);margin-left:4px">${this.pushError}</span>` : nothing}`;
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
            detail: { method: this.mergeMethod, ...(this.headRefName ? { branch: this.headRefName } : {}) },
        }));
    }

    private _handleForceMerge() {
        this.merging = true;
        this.mergeError = '';
        this.dispatchEvent(new CustomEvent('pr-merge', {
            bubbles: true,
            composed: true,
            detail: { method: this.mergeMethod, admin: true, ...(this.headRefName ? { branch: this.headRefName } : {}) },
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

    private async _openDiffModal(file: string, repo?: string) {
        this._modalFile = file;
        this._loadingDiff = file;
        this._diffContent = null;
        this._diffError = null;
        this._showModal();

        const base = this.sessionId
            ? `/api/sessions/${this.sessionId}/git-diff`
            : `/api/goals/${this.goalId}/git-diff`;
        let url = `${base}?file=${encodeURIComponent(file)}`;
        if (repo && repo !== '.') url += `&repo=${encodeURIComponent(repo)}`;
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
                        <span class="font-mono text-[12px] text-muted-foreground shrink-0 pt-0.5" title=${c.sha}>${c.shortSha}</span>
                        <div class="flex-1 min-w-0">
                            <div class="text-sm text-foreground break-words">${c.message}</div>
                            <div class="flex items-center gap-3 mt-1 text-[12px] text-muted-foreground">
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

    private _renderMultiRepoSections() {
        if (!this._isMultiRepo()) return null;
        const entries = Object.entries(this.repos!);
        const dirtyRepoCount = entries.filter(([, info]) => this._repoFiles(info).length > 0 || info.clean === false).length;
        const totalDirty = this._aggregateDirtyCount();
        const headerText = totalDirty > 0
            ? `${totalDirty} changed across ${dirtyRepoCount || entries.length} repo${(dirtyRepoCount || entries.length) === 1 ? '' : 's'}`
            : `${entries.length} repos clean`;
        return html`
            <div class="border-t border-border pt-2 mt-2 flex flex-col gap-1.5" data-testid="multi-repo-sections">
                <div class="text-[12px] text-muted-foreground uppercase tracking-wider font-medium flex items-center justify-between" data-testid="multi-repo-header">
                    <span>Repos</span>
                    <span class="text-muted-foreground normal-case tracking-normal" data-testid="multi-repo-aggregate">${headerText}</span>
                </div>
                ${entries.map(([repoName, info]) => {
                    const files = this._repoFiles(info);
                    const isClean = files.length === 0 && info.clean !== false;
                    const counts: any[] = [];
                    if (files.length > 0) counts.push(html`<span class="text-amber-600 dark:text-amber-400 text-[11px] font-medium" data-testid="repo-dirty-count">~${files.length}</span>`);
                    if (typeof info.aheadOfPrimary === 'number' && info.aheadOfPrimary > 0)
                        counts.push(html`<span class="text-blue-600 dark:text-blue-400 text-[11px] font-medium">↑${info.aheadOfPrimary}</span>`);
                    if (typeof info.behindPrimary === 'number' && info.behindPrimary > 0)
                        counts.push(html`<span class="text-red-600 dark:text-red-400 text-[11px] font-medium">↓${info.behindPrimary}</span>`);
                    if (counts.length === 0) counts.push(html`<span class="text-green-600 dark:text-green-400 text-[11px] font-medium" data-testid="repo-clean">clean</span>`);
                    // Auto-expand dirty repos; keep clean ones collapsed for compactness.
                    return html`
                        <details class="border border-border rounded-md" data-testid="multi-repo-entry" data-repo-name=${repoName} ?open=${!isClean}>
                            <summary class="text-[13px] font-medium text-foreground cursor-pointer py-1 px-2 flex items-center gap-2">
                                <code class="text-[12px] font-mono" data-testid="repo-name">${repoName === '.' ? '(root)' : repoName}</code>
                                <span class="flex items-center gap-1.5 ml-auto" data-testid="repo-counts">${counts}</span>
                            </summary>
                            ${files.length > 0
                                ? html`<div class="flex flex-col gap-0.5 px-2 pb-2 pt-1">
                                    ${files.map(f => html`
                                        <div class="flex items-center gap-2 py-0.5 min-w-0 rounded px-1 -mx-1 ${(this.sessionId || this.goalId) ? 'cursor-pointer hover:bg-muted/50' : ''}"
                                             @click=${() => (this.sessionId || this.goalId) ? this._openDiffModal(f.file, repoName) : undefined}>
                                            <span class="${this._statusColor(f.status)} font-mono w-[60px] shrink-0 text-right text-[11px]" title=${this._statusLabel(f.status)}>${this._statusLabel(f.status)}</span>
                                            <span class="text-foreground truncate text-[12px]" title=${f.file}>${f.file}</span>
                                        </div>
                                    `)}
                                </div>`
                                : html`<div class="text-[12px] text-muted-foreground italic px-2 pb-2" data-testid="repo-empty">Working tree clean</div>`}
                        </details>
                    `;
                })}
            </div>
        `;
    }

    /** Slice C1 — pack ENTRYPOINT launchers surfaced in the git-widget dropdown:
     *  `git-widget-button` launchers render directly as buttons; if any
     *  `command-palette` launchers are registered, a single "Command palette" entry
     *  opens the shared palette overlay. Both consume the client pack-entrypoints
     *  registry (`listLauncherEntrypoints` / `runLauncherEntrypoint`). NO auto-invoke
     *  — a launcher fires only from a real click (the user gesture). Best-effort:
     *  a registry read failure renders nothing and never breaks the dropdown. */
    private _renderPackLaunchers() {
        let gitButtons: Array<{ id: string; label: string }> = [];
        let hasPaletteCommands = false;
        try {
            // `id` carries the COMPOUND launcher key (packId+entrypointId) so two packs
            // declaring the same launcher id stay distinct + individually dispatchable.
            gitButtons = listLauncherEntrypoints('git-widget-button').map((l) => ({ id: l.key, label: l.label }));
            hasPaletteCommands = listLauncherEntrypoints('command-palette').length > 0;
        } catch { /* non-fatal */ }
        if (gitButtons.length === 0 && !hasPaletteCommands) return nothing;
        const btnStyle = 'font-size:12px;padding:2px 10px;border-radius:4px;border:1px solid var(--border);background:oklch(0.55 0.12 250 / 0.12);color:oklch(0.55 0.12 250);cursor:pointer;font-weight:500';
        return html`
            <div class="border-t border-border pt-2 mt-2" data-testid="git-widget-launchers">
                <div class="text-muted-foreground mb-1 font-medium">Extensions</div>
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                    ${gitButtons.map((b) => html`<button
                        type="button"
                        style=${btnStyle}
                        data-testid="git-widget-launcher"
                        data-entrypoint-id=${b.id}
                        @click=${(e: MouseEvent) => { e.stopPropagation(); this._runPackLauncher(b.id); }}
                    >${b.label}</button>`)}
                    ${hasPaletteCommands ? html`<button
                        type="button"
                        style=${btnStyle}
                        data-testid="git-widget-open-command-palette"
                        @click=${(e: MouseEvent) => { e.stopPropagation(); this._closeDropdown(); openCommandPalette(); }}
                    >Command palette\u2026</button>` : nothing}
                </div>
            </div>
        `;
    }

    /** Run a pack launcher on a genuine user click (the click's transient activation
     *  is the user gesture; no runWithUserGesture wrapper needed) and close the
     *  dropdown. */
    private _runPackLauncher(id: string): void {
        this._closeDropdown();
        try { runLauncherEntrypoint(id); } catch { /* non-fatal */ }
    }

    private _renderDropdownContent() {
        const multiRepoSections = this._renderMultiRepoSections();
        // In multi-repo mode the per-repo sections are the source of truth
        // for the dirty file list. The flat aggregate `statusFiles` (which
        // mirrors the goal worktree's own porcelain) is suppressed to avoid
        // double-counting / duplicate "uncommitted changes" lists.
        const showFlatFiles = !multiRepoSections && this.statusFiles.length > 0;
        return html`
            <div class="flex items-center gap-1.5 mb-2 text-foreground font-medium text-sm">
                <span>⎇</span>
                <span class="break-all">${this.branch}</span>
                ${multiRepoSections ? html`<span class="ml-auto text-[11px] text-muted-foreground" data-testid="multi-repo-badge">${Object.keys(this.repos!).length} repos</span>` : ''}
            </div>

            <div class="flex flex-col gap-1 mb-2">
                ${this._renderPrimaryStatus()}
                ${this._renderRemoteStatus()}
            </div>

            ${this._renderPrSection()}

            ${this._renderPackLaunchers()}

            ${multiRepoSections}

            ${showFlatFiles
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
                : multiRepoSections
                    ? nothing
                    : html`
                      <div class="text-green-600 dark:text-green-400 border-t border-border pt-2 mt-2">
                          Working tree clean
                      </div>
                  `}
        `;
    }

    render() {
        this._ensureWidgetStyles();

        // Skeleton state: loading with no data yet.
        if (this.loading && !this.branch) {
            return html`
                <button
                    class="git-status-pill skeleton inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-card border border-border text-muted-foreground text-[12px] leading-tight"
                    style="max-width:100%; height:var(--pill-h, auto); min-width:110px"
                    aria-busy="true"
                    disabled
                    data-state="skeleton"
                >
                    <span class="git-skeleton-shimmer" aria-hidden="true"></span>
                    <span class="shrink-0 relative z-10">⎇</span>
                    <span class="truncate relative z-10">Checking git\u2026</span>
                </button>
            `;
        }

        // Safety fallback — no data and not loading: hide. The parent
        // gitRepoKnown === 'no' gate normally prevents reaching here.
        if (!this.branch) return nothing;

        const segments = this._pillSegments();
        // Multi-repo aggregate: when we have a per-repo envelope with >1
        // entries, override the dirty-file count in the pill to reflect
        // the sum across repos (the flat `statusFiles` only covers the
        // goal worktree's own repo). Match the design's mock: e.g.
        // "3 changed across 2 repos".
        const multiRepoMode = this._isMultiRepo();
        const aggregateLabel = multiRepoMode
            ? (() => {
                const total = this._aggregateDirtyCount();
                if (total === 0) return null;
                const dirtyRepos = Object.values(this.repos!).filter(info => this._repoFiles(info).length > 0).length;
                return `${total} changed across ${dirtyRepos} repo${dirtyRepos === 1 ? '' : 's'}`;
            })()
            : null;
        // Multi-repo: colored segments for stats summed across all repos
        // (↓behind / ↑ahead / +ins / -del), reusing the flat pill styling.
        const aggregateStats = multiRepoMode ? this._aggregatePrimaryStats() : null;
        const aggregateSegments = aggregateStats ? this._segmentSpans(aggregateStats) : [];
        // Show 'clean' only when no other indicators are present and no PR.
        // Multi-repo mode derives clean-collapse from the AGGREGATE (every
        // repo clean + all summed primary stats zero), INDEPENDENT of
        // `isOnPrimary` — a clean `session/...` branch must still collapse to
        // the single green "clean". Flat/single-repo behavior is unchanged.
        const showClean = multiRepoMode
            ? (this.clean && !this.prState && !aggregateLabel && aggregateSegments.length === 0)
            : (this.clean && segments.length === 0 && !this.prState
                && (this.isOnPrimary || this.mergedIntoPrimary)
                && (this.isOnPrimary || this.aheadOfPrimary === 0));

        const stateAttr = this.loading ? 'refreshing' : this.partial ? 'partial' : 'ready';
        const refreshDot = this.loading
            ? html`<span class="git-refresh-dot" aria-label="Refreshing" title="Refreshing git status\u2026"></span>`
            : this.partial
                ? html`<span class="git-partial-dot" aria-label="Partial" title="Status scan timed out \u2014 showing partial data."></span>`
                : nothing;

        return html`
            <button
                class="git-status-pill inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-card border border-border text-muted-foreground hover:text-foreground transition-colors cursor-pointer text-[12px] leading-tight ${this.loading ? 'loading' : ''} ${this.partial ? 'partial' : ''}"
                style="max-width:100%; height:var(--pill-h, auto)"
                data-state=${stateAttr}
                @click=${this._toggle}
            >
                <span class="shrink-0 relative" style="display:inline-block">⎇${refreshDot}</span>
                <span class="truncate">${this.branch}</span>
                ${showClean ? html`<span class="text-green-600 dark:text-green-400 font-medium shrink-0">clean</span>` : nothing}
                ${multiRepoMode
                    ? html`${aggregateLabel
                        ? html`<span class="text-amber-600 dark:text-amber-400 font-medium shrink-0" data-testid="pill-multi-repo-aggregate">${aggregateLabel}</span>`
                        : nothing}${aggregateSegments}`
                    : segments}
                ${this._prPillIcon()}
            </button>
        `;
    }

    private _ensureWidgetStyles() {
        if (typeof document === 'undefined') return;
        if (document.getElementById('git-status-widget-styles')) return;
        const style = document.createElement('style');
        style.id = 'git-status-widget-styles';
        style.textContent = `
            @keyframes git-status-shimmer {
                0%   { background-position: -120% 0; }
                100% { background-position: 220% 0; }
            }
            @keyframes git-status-pulse {
                0%, 100% { opacity: 1; transform: scale(1); }
                50%      { opacity: 0.4; transform: scale(0.8); }
            }
            .git-status-pill.skeleton {
                position: relative;
                overflow: hidden;
                cursor: default;
                opacity: 0.85;
            }
            .git-skeleton-shimmer {
                position: absolute;
                inset: 0;
                background: linear-gradient(
                    90deg,
                    transparent 0%,
                    rgba(255, 255, 255, 0.08) 40%,
                    rgba(255, 255, 255, 0.18) 50%,
                    rgba(255, 255, 255, 0.08) 60%,
                    transparent 100%
                );
                background-size: 200% 100%;
                animation: git-status-shimmer 1.2s linear infinite;
                pointer-events: none;
                z-index: 0;
            }
            .git-refresh-dot {
                position: absolute;
                top: -1px;
                right: -3px;
                width: 6px;
                height: 6px;
                border-radius: 9999px;
                background: var(--primary, #60a5fa);
                animation: git-status-pulse 1s ease-in-out infinite;
                pointer-events: none;
            }
            .git-partial-dot {
                position: absolute;
                top: -1px;
                right: -3px;
                width: 6px;
                height: 6px;
                border-radius: 9999px;
                background: #f59e0b;
                box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.35);
                pointer-events: none;
            }
        `;
        document.head.appendChild(style);
    }

    override updated(changed: Map<string, unknown>) {
        super.updated(changed);
        if (changed.has('expanded')) {
            if (this.expanded) {
                // Inject animation styles once
                if (!document.getElementById('git-dropdown-anim-styles')) {
                    const styleEl = document.createElement('style');
                    styleEl.id = 'git-dropdown-anim-styles';
                    styleEl.textContent = `
                        @keyframes git-dropdown-in {
                            0%   { opacity: 0; transform: translateY(8px) scale(0.92); filter: blur(3px); }
                            70%  { opacity: 1; transform: translateY(-1px) scale(1.005); filter: blur(0); }
                            100% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
                        }
                        @keyframes git-dropdown-out {
                            0%   { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
                            100% { opacity: 0; transform: translateY(6px) scale(0.95); filter: blur(2px); }
                        }
                        #git-status-dropdown {
                            animation: git-dropdown-in 300ms cubic-bezier(0.175, 0.885, 0.32, 1.275);
                        }
                        #git-status-dropdown.git-dropdown-closing {
                            animation: git-dropdown-out 200ms cubic-bezier(0.4, 0, 1, 1) forwards;
                        }
                    `;
                    document.head.appendChild(styleEl);
                }
                // Create portal dropdown on body
                this._dropdownEl = document.createElement('div');
                this._dropdownEl.id = 'git-status-dropdown';
                this._dropdownEl.className = 'fixed z-[9999] bg-card border border-border rounded-lg shadow-lg p-3 text-[13px]';
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
