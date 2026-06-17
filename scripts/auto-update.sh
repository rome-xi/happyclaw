#!/bin/bash
# HappyClaw 自动更新脚本
# 拉取上游最新代码，合并本地改动，编译部署
# 失败时自动回滚，不影响运行中的服务

set -euo pipefail

cd "$HOME/happyclaw"

LOG_PREFIX="[auto-update]"
BACKUP_REF=""

log() { echo "$LOG_PREFIX $(date '+%H:%M:%S') $1"; }
err() { echo "$LOG_PREFIX $(date '+%H:%M:%S') ERROR: $1" >&2; }

# 1. Fetch upstream
log "Fetching origin..."
git fetch origin 2>&1

# 2. Check for new commits
NEW_COMMITS=$(git log --oneline HEAD..origin/main 2>/dev/null | wc -l)
if [ "$NEW_COMMITS" -eq 0 ]; then
    log "No new upstream commits. Nothing to do."
    echo "RESULT:no_update"
    exit 0
fi
log "Found $NEW_COMMITS new upstream commits"

# 3. Save current HEAD for rollback
BACKUP_REF=$(git rev-parse HEAD)
log "Current HEAD: $BACKUP_REF"

# 4. Stash local changes
STASH_RESULT=$(git stash 2>&1)
if echo "$STASH_RESULT" | grep -q "No local changes"; then
    HAS_STASH=false
else
    HAS_STASH=true
    log "Stashed local changes"
fi

# 5. Merge upstream (should fast-forward since we never commit locally)
log "Merging origin/main..."
if ! git merge origin/main 2>&1; then
    err "Merge failed (unexpected - should be fast-forward)"
    git merge --abort 2>/dev/null || true
    if [ "$HAS_STASH" = true ]; then git stash pop 2>/dev/null || true; fi
    echo "RESULT:merge_failed"
    exit 1
fi

# 6. Pop stash (apply local changes back)
if [ "$HAS_STASH" = true ]; then
    log "Applying local changes..."
    if ! git stash pop 2>&1; then
        # Check for conflicts
        CONFLICTS=$(git diff --name-only --diff-filter=U 2>/dev/null)
        if [ -n "$CONFLICTS" ]; then
            log "Conflicts detected in: $CONFLICTS"
            # For package-lock.json, always take upstream
            if echo "$CONFLICTS" | grep -q "package-lock.json"; then
                for f in $(echo "$CONFLICTS" | grep "package-lock.json"); do
                    git checkout --theirs "$f" 2>/dev/null
                    git add "$f" 2>/dev/null
                    log "Auto-resolved $f (took upstream version)"
                done
            fi
            # For other conflicts, check if they're just comment differences
            REMAINING=$(git diff --name-only --diff-filter=U 2>/dev/null)
            if [ -n "$REMAINING" ]; then
                err "Unresolved conflicts in: $REMAINING"
                echo "RESULT:conflicts:$REMAINING"
                exit 1
            fi
        fi
    fi
fi

# 7. Install dependencies if package.json changed
CHANGED_FILES=$(git diff --name-only "$BACKUP_REF"..HEAD 2>/dev/null || echo "")
if echo "$CHANGED_FILES" | grep -q "^package.json$\|^package-lock.json$"; then
    log "Backend package.json changed, running npm install..."
    npm install 2>&1 | tail -3
fi
if echo "$CHANGED_FILES" | grep -q "^web/package"; then
    log "Frontend package.json changed, running npm install..."
    (cd web && npm install 2>&1 | tail -3)
fi
if echo "$CHANGED_FILES" | grep -q "^container/agent-runner/package"; then
    log "Agent-runner package.json changed, updating SDK..."
    make update-sdk 2>&1 | tail -3
fi

# 8. Build
log "Building..."
if ! make build 2>&1; then
    err "Build failed! Rolling back..."
    git reset --hard "$BACKUP_REF"
    if [ "$HAS_STASH" = true ]; then git stash pop 2>/dev/null || true; fi
    # Rebuild with old code
    make build 2>&1 | tail -3
    echo "RESULT:build_failed"
    exit 1
fi
log "Build succeeded"

# 9. Restart service via systemd
# 本脚本作为 happyclaw 定时任务运行在 happyclaw.service 自己的 cgroup 里：
# 直接 kill 主进程会让 systemd 把 cgroup 连同本脚本和 nohup 子进程一并清掉，
# 且退出码 0 不触发 Restart=on-failure。因此用 systemd 定时器在脚本退出后重启。
log "Scheduling service restart via systemd (in 2s, after this script exits)..."
systemd-run --user --collect --on-active=2 \
    systemctl --user restart happyclaw.service 2>&1

UPSTREAM_HEAD=$(git rev-parse HEAD)
echo "RESULT:updated:$NEW_COMMITS commits merged ($BACKUP_REF -> $UPSTREAM_HEAD), restart scheduled"
exit 0
