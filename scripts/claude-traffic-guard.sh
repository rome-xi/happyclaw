#!/usr/bin/env bash
# Claude 流量守护脚本
# 定期检查出口 IP，如果不是预期的台北家宽 IP，阻断所有 Claude/Anthropic 相关流量
# 双重拦截：iptables SNI 域名匹配 + /etc/hosts DNS 劫持
# 覆盖：本机直接请求 + WireGuard VPN 转发的请求

set -euo pipefail

# ===== 配置 =====
EXPECTED_IP="<REDACTED_IP>"
CHECK_URL="https://api.ipify.org"
CHECK_TIMEOUT=10
FLAG_FILE="/tmp/claude-traffic-blocked"
LOG_FILE="/home/theonlyheart/happyclaw/data/logs/claude-guard.log"
IPTABLES_CHAIN="CLAUDE_GUARD"
HOSTS_MARKER="# CLAUDE_GUARD_BLOCK"

# Anthropic 相关域名
ANTHROPIC_DOMAINS=(
    "api.anthropic.com"
    "claude.ai"
    "www.claude.ai"
    "statsig.anthropic.com"
    "sentry.anthropic.com"
    "console.anthropic.com"
    "auth.anthropic.com"
)

# SNI 匹配关键字（覆盖所有子域名）
SNI_PATTERNS=(
    "anthropic.com"
    "claude.ai"
)

# ===== 函数 =====

log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
    echo "$msg" >> "$LOG_FILE"
}

notify() {
    local msg="$1"
    log "NOTIFY: $msg"

    # 尝试通过 Telegram bot 直接发送
    if [[ -f /home/theonlyheart/happyclaw/scripts/notify-telegram.sh ]]; then
        bash /home/theonlyheart/happyclaw/scripts/notify-telegram.sh "$msg" 2>/dev/null || true
    fi
}

get_exit_ip() {
    local ip
    ip=$(curl -s --connect-timeout "$CHECK_TIMEOUT" --max-time "$CHECK_TIMEOUT" "$CHECK_URL" 2>/dev/null) || true
    if [[ -z "$ip" ]]; then
        ip=$(curl -s --connect-timeout "$CHECK_TIMEOUT" --max-time "$CHECK_TIMEOUT" "https://ifconfig.me" 2>/dev/null) || true
    fi
    if [[ -z "$ip" ]]; then
        ip=$(curl -s --connect-timeout "$CHECK_TIMEOUT" --max-time "$CHECK_TIMEOUT" "https://ip.sb" 2>/dev/null) || true
    fi
    echo "$ip"
}

ensure_chain() {
    if ! iptables -L "$IPTABLES_CHAIN" -n >/dev/null 2>&1; then
        iptables -N "$IPTABLES_CHAIN"
    fi
    if ! iptables -C OUTPUT -j "$IPTABLES_CHAIN" 2>/dev/null; then
        iptables -I OUTPUT -j "$IPTABLES_CHAIN"
    fi
    if ! iptables -C FORWARD -j "$IPTABLES_CHAIN" 2>/dev/null; then
        iptables -I FORWARD -j "$IPTABLES_CHAIN"
    fi
}

block_claude_traffic() {
    # === 第一层：iptables SNI 域名匹配 ===
    ensure_chain
    iptables -F "$IPTABLES_CHAIN"

    for pattern in "${SNI_PATTERNS[@]}"; do
        # 匹配 TLS ClientHello 中的 SNI 域名（明文）
        iptables -A "$IPTABLES_CHAIN" -p tcp --dport 443 -m string --string "$pattern" --algo bm -j DROP
    done

    # === 第二层：/etc/hosts DNS 劫持 ===
    # 先清除旧的标记行
    sed -i "/$HOSTS_MARKER/d" /etc/hosts

    for domain in "${ANTHROPIC_DOMAINS[@]}"; do
        echo "127.0.0.1 $domain $HOSTS_MARKER" >> /etc/hosts
    done

    touch "$FLAG_FILE"
    log "BLOCKED: Claude traffic blocked (SNI: ${SNI_PATTERNS[*]}, DNS: ${#ANTHROPIC_DOMAINS[@]} domains)"
}

unblock_claude_traffic() {
    # === 清除 iptables 规则 ===
    if iptables -L "$IPTABLES_CHAIN" -n >/dev/null 2>&1; then
        iptables -F "$IPTABLES_CHAIN"
    fi

    # === 清除 /etc/hosts 劫持 ===
    sed -i "/$HOSTS_MARKER/d" /etc/hosts

    rm -f "$FLAG_FILE"
    log "UNBLOCKED: Claude traffic unblocked. Exit IP matches $EXPECTED_IP"
}

is_blocked() {
    [[ -f "$FLAG_FILE" ]]
}

# ===== 主逻辑 =====

mkdir -p "$(dirname "$LOG_FILE")"

CURRENT_IP=$(get_exit_ip)

if [[ -z "$CURRENT_IP" ]]; then
    if ! is_blocked; then
        log "WARNING: Cannot determine exit IP, blocking Claude traffic as precaution"
        block_claude_traffic
        notify "无法检测出口 IP，已预防性阻断 Claude 流量"
    fi
    exit 0
fi

if [[ "$CURRENT_IP" == "$EXPECTED_IP" ]]; then
    if is_blocked; then
        unblock_claude_traffic
        notify "出口 IP 已恢复为 $EXPECTED_IP，Claude 流量已放行"
    fi
else
    if ! is_blocked; then
        block_claude_traffic
        notify "出口 IP 变为 $CURRENT_IP（预期 $EXPECTED_IP），已阻断 Claude 流量"
    else
        log "STILL BLOCKED: Current IP $CURRENT_IP != $EXPECTED_IP"
    fi
fi
