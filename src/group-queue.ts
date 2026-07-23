import { ChildProcess, exec, execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { killProcessTree } from './container-runner.js';
import { getTaskById } from './db.js';
import { getSystemSettings } from './runtime-config.js';
import { logger } from './logger.js';
export type SendMessageResult = 'sent' | 'no_active';

export interface IpcMessageCursor {
  id: string;
  timestamp: string;
}

export interface IpcDeliveryMetadata {
  /** JID whose durable message rows must be replayed after a crash. */
  databaseJid: string;
  /** Exact DB rows represented by this formatted IPC envelope. */
  messageCursors: IpcMessageCursor[];
}

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  /** True when the active runner is executing a scheduled task (not user messages). */
  activeRunnerIsTask: boolean;
  /** Last time this runner produced any observable output. */
  lastActivityAt: number | null;
  /** True while the runner is inside an active query turn. */
  queryInFlight: boolean;
  /** IPC messages written by the host but not yet acknowledged by a real SDK
   * query event. Kept separate from pendingMessages because the warm runner is
   * expected to consume these without spawning a second process. */
  pendingIpcMessageIds: Set<string>;
  /** Pending IPC messages that have reached a fresh turn and are therefore
   * subject to the short provider-acceptance ACK deadline. Messages queued
   * behind an active turn deliberately stay out of this set. */
  ipcAckEligibleMessageIds: Set<string>;
  /** Route/card transitions delayed until the queued message actually starts
   * its own logical turn. Keyed by durable IPC message ID for exactly-once use. */
  ipcTurnStartCallbacks: Map<string, () => void | Promise<void>>;
  /** Delivery ownership retained after ACK until its own result completes. */
  ipcDeliveryMetadata: Map<string, IpcDeliveryMetadata>;
  /** ACKed IPC messages explicitly completed by a later query result. */
  completedIpcMessageIds: Set<string>;
  ipcAwaitingAckSince: number | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  displayName: string | null;
  groupFolder: string | null;
  agentId: string | null;
  /** Isolated task run ID — used for tasks-run/{taskRunId}/ IPC namespace. */
  taskRunId: string | null;
  /** Recovery runners consume only this DB lane from a shared IPC directory. */
  ipcDatabaseJidFilter: string | null;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  restarting: boolean;
  /** Provider profile ID selected for the current active runner (null = default/override). */
  selectedProviderId: string | null;
  /** True when a _drain sentinel has been written for the current active runner. */
  drainSentinelWritten: boolean;
  /** True when messages have been IPC-injected into the running agent via sendMessage().
   *  Used to detect lost messages on abnormal exit: if the agent crashes after IPC
   *  injection, the caller already advanced the cursor so processGroupMessages won't
   *  re-read those messages.  The close handler uses this flag to force pendingMessages
   *  so drainGroup triggers a fresh run. */
  hasIpcInjectedMessages: boolean;
  /** Durable DB lanes injected into this shared runner during its lifetime. */
  ipcInjectedDatabaseJids: Set<string>;
  /**
   * HappyClaw user id that started the current run (idle→active), or null when
   * unknown (IM / task / agent / drain runs, or no initiator supplied). The
   * stop/interrupt routes use it for a resource-level "owner OR initiator"
   * check, so a shared member can stop/interrupt only the run they started, not
   * the owner's. Set by the enqueue that starts a fresh run; cleared on idle.
   * Subsequent IPC-injected messages during an active run do NOT change it.
   */
  currentRunInitiator: string | null;
}

type ActiveGroupState = GroupState & { groupFolder: string };

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private activeContainerCount = 0;
  private activeHostProcessCount = 0;
  private waitingGroups = new Set<string>();
  private contextOverflowGroups = new Set<string>(); // 跟踪发生上下文溢出的 group
  /** DB lanes that must replay from lastCommittedCursor after runner loss. */
  private ipcRecoveryDatabaseJids = new Set<string>();
  // 记录最近一次 stopGroup 的时间戳（毫秒）。runForGroup finally 块会用它来
  // 决定是否跳过自动 drainGroup —— stopGroup 中清空 pendingMessages 之后，
  // hasIpcInjectedMessages 重新置 pendingMessages=true，会让用户的 'stop' 之后
  // 容器立即又被拉起来。同时让主消息循环在 OOM 计数前看一眼这个标志，避免
  // 把 user-stopped (SIGKILL → 137) 误判为真实 OOM 触发会话重置。
  private recentlyStoppedFolders = new Map<string, number>();
  private static RECENTLY_STOPPED_WINDOW_MS = 30_000;
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;
  private hostModeChecker: ((groupJid: string) => boolean) | null = null;
  private serializationKeyResolver: ((groupJid: string) => string) | null =
    null;
  private onMaxRetriesExceededFn: ((groupJid: string) => void) | null = null;
  private onContainerExitFn: ((groupJid: string) => void) | null = null;
  private onRunnerStateChangeFn:
    | ((chatJid: string, state: 'idle' | 'running') => void)
    | null = null;
  private userConcurrentLimitFn:
    | ((groupJid: string) => { allowed: boolean })
    | null = null;
  private onUnconsumedAgentIpcFn:
    | ((groupJid: string, agentId: string) => void)
    | null = null;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        activeRunnerIsTask: false,
        lastActivityAt: null,
        queryInFlight: false,
        pendingIpcMessageIds: new Set(),
        ipcAckEligibleMessageIds: new Set(),
        ipcTurnStartCallbacks: new Map(),
        ipcDeliveryMetadata: new Map(),
        completedIpcMessageIds: new Set(),
        ipcAwaitingAckSince: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        displayName: null,
        groupFolder: null,
        agentId: null,
        taskRunId: null,
        ipcDatabaseJidFilter: null,
        retryCount: 0,
        retryTimer: null,
        restarting: false,
        selectedProviderId: null,
        drainSentinelWritten: false,
        hasIpcInjectedMessages: false,
        ipcInjectedDatabaseJids: new Set(),
        currentRunInitiator: null,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  /** 当前重试轮次（0 = 首次尝试）。供 processMessages 侧识别静默重试轮。 */
  getRetryCount(groupJid: string): number {
    return this.groups.get(groupJid)?.retryCount ?? 0;
  }

  /** 本轮失败后队列是否还会再次重试（决定错误提示发本轮还是等最终失败）。 */
  willRetryAfterFailure(groupJid: string): boolean {
    if (this.contextOverflowGroups.has(groupJid)) return false;
    return (this.groups.get(groupJid)?.retryCount ?? 0) < MAX_RETRIES;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  setHostModeChecker(fn: (groupJid: string) => boolean): void {
    this.hostModeChecker = fn;
  }

  setSerializationKeyResolver(fn: (groupJid: string) => string): void {
    this.serializationKeyResolver = fn;
  }

  setOnMaxRetriesExceeded(fn: (groupJid: string) => void): void {
    this.onMaxRetriesExceededFn = fn;
  }

  setOnContainerExit(fn: (groupJid: string) => void): void {
    this.onContainerExitFn = fn;
  }

  setOnRunnerStateChange(
    fn: (chatJid: string, state: 'idle' | 'running') => void,
  ): void {
    this.onRunnerStateChangeFn = fn;
  }

  setUserConcurrentLimitChecker(
    fn: (groupJid: string) => { allowed: boolean },
  ): void {
    this.userConcurrentLimitFn = fn;
  }

  /**
   * Called when an agent runner exits with unconsumed IPC message files.
   * The callback should re-enqueue processAgentConversation for the agent.
   * See GitHub issue #240.
   */
  setOnUnconsumedAgentIpc(
    fn: (groupJid: string, agentId: string) => void,
  ): void {
    this.onUnconsumedAgentIpcFn = fn;
  }

  /**
   * 标记 group 发生了上下文溢出错误，跳过指数退避重试
   */
  markContextOverflow(groupJid: string): void {
    this.contextOverflowGroups.add(groupJid);
    logger.warn(
      { groupJid },
      'Marked group as context overflow - will skip retry backoff',
    );
  }

  /**
   * 公开 shutdown 状态供 scheduler 等子系统避免在关停过程中再启动新工作。
   * 调度器主循环 tick 期间若已 shutdown，应直接 skip 这次 tick，避免在
   * grace 窗口内 spawn 新脚本子进程导致孤儿。
   */
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  private clearRetryTimer(state: GroupState): void {
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    state.retryCount = 0;
  }

  /**
   * 仅取消正在排队的 retry 定时器，不重置 retryCount。
   * interruptQuery 用这个：用户中断当前查询不应抹掉之前的 backoff 进度，
   * 否则 N 次失败后正在退避的 runner 一被 interrupt 就回到 retry=0，
   * 死循环重试同一个失败请求。
   */
  private cancelRetryTimer(state: GroupState): void {
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
  }

  /**
   * Whether stopGroup was issued for this folder in the recent window.
   * Used by:
   *   1. runForGroup finally — skip pendingMessages re-arm + drainGroup
   *   2. main loop OOM handler — don't count user-stopped 137 as OOM
   *   3. anything else that needs to suppress auto-restart shortly after a stop
   */
  isRecentlyStopped(folder: string): boolean {
    const ts = this.recentlyStoppedFolders.get(folder);
    if (!ts) return false;
    if (Date.now() - ts > GroupQueue.RECENTLY_STOPPED_WINDOW_MS) {
      this.recentlyStoppedFolders.delete(folder);
      return false;
    }
    return true;
  }

  private isHostMode(groupJid: string): boolean {
    return this.hostModeChecker?.(groupJid) ?? false;
  }

  private getSerializationKey(groupJid: string): string {
    const key = this.serializationKeyResolver?.(groupJid)?.trim();
    return key || groupJid;
  }

  private findActiveRunnerFor(groupJid: string): string | null {
    const key = this.getSerializationKey(groupJid);
    for (const [jid, state] of this.groups.entries()) {
      if (!state.active) continue;
      if (this.getSerializationKey(jid) === key) return jid;
    }
    return null;
  }

  private hasCapacityFor(groupJid: string): boolean {
    const isHost = this.isHostMode(groupJid);
    const systemCapacity = isHost
      ? this.activeHostProcessCount <
        getSystemSettings().maxConcurrentHostProcesses
      : this.activeContainerCount < getSystemSettings().maxConcurrentContainers;
    if (!systemCapacity) return false;

    // User-level concurrent container limit (billing)
    if (this.userConcurrentLimitFn) {
      const result = this.userConcurrentLimitFn(groupJid);
      if (!result.allowed) return false;
    }
    return true;
  }

  private resolveActiveState(groupJid: string): ActiveGroupState | null {
    const own = this.getGroup(groupJid);
    if (own.active && own.groupFolder) return own as ActiveGroupState;

    const activeRunner = this.findActiveRunnerFor(groupJid);
    if (!activeRunner) return null;
    const shared = this.getGroup(activeRunner);
    if (!shared.active || !shared.groupFolder) return null;
    return shared as ActiveGroupState;
  }

  /**
   * Write a single _drain sentinel to the actual active main-agent runner that
   * owns this serialization key. This must target the runner state rather than
   * the caller's group state because sibling JIDs can share one process.
   */
  private requestDrainForActiveRunner(
    groupJid: string,
    reason: string,
  ): boolean {
    const activeRunner = this.findActiveRunnerFor(groupJid);
    if (!activeRunner) return false;

    const runnerState = this.getGroup(activeRunner);
    if (
      !runnerState.active ||
      !runnerState.groupFolder ||
      runnerState.agentId !== null
    ) {
      return false;
    }

    if (runnerState.drainSentinelWritten) {
      return true;
    }

    const wrote = this.writeDrainSentinel(runnerState as ActiveGroupState);
    if (!wrote) return false;
    runnerState.drainSentinelWritten = true;
    logger.info({ groupJid, activeRunner }, reason);
    return true;
  }

  /** 检查指定 JID 是否有自己直接启动的活跃 runner（非通过 folder 共享匹配） */
  hasDirectActiveRunner(groupJid: string): boolean {
    const state = this.groups.get(groupJid);
    return state?.active === true;
  }

  /**
   * The HappyClaw user id that started the currently-active *message* run owning
   * this jid's serialization key, or null if unknown / no active run. Used by
   * the stop/interrupt routes for a resource-level "owner OR initiator" ACL: a
   * shared member may stop/interrupt only a message run they started themselves.
   *
   * Task runs (`activeRunnerIsTask` — scheduled tasks, agent conversations,
   * terminal warmup) are deliberately EXCLUDED and return null → owner-only.
   * currentRunInitiator is stamped at message-enqueue time and is NOT touched by
   * runTask, so a base-jid task (e.g. terminal-warmup, index.ts) sharing the
   * GroupState can go active while a member's still-pending message left an
   * initiator on it; gating on `!activeRunnerIsTask` prevents that member from
   * being mis-read as the task run's initiator (which would let them stop the
   * owner's task). Not clearing the field in runTask is intentional — it lets
   * the member's own pending message run still expose them once it starts.
   *
   * Unlike resolveActiveState this does NOT require groupFolder to be set, so
   * the initiator is readable from the instant the run goes active (idle→active)
   * — even during the cold-start window before registerProcess. It matches on
   * `active` (+ not-a-task) + serialization key only.
   */
  getActiveRunInitiator(groupJid: string): string | null {
    const own = this.groups.get(groupJid);
    if (own?.active) {
      return own.activeRunnerIsTask ? null : (own.currentRunInitiator ?? null);
    }
    const activeRunner = this.findActiveRunnerFor(groupJid);
    if (!activeRunner) return null;
    const runner = this.groups.get(activeRunner);
    if (!runner || runner.activeRunnerIsTask) return null;
    return runner.currentRunInitiator ?? null;
  }

  /** Count active task runners whose JID starts with the given base JID + '#task:' */
  countActiveTaskRunners(baseJid: string): number {
    const prefix = baseJid + '#task:';
    let count = 0;
    for (const [jid, state] of this.groups.entries()) {
      if (state.active && jid.startsWith(prefix)) {
        count++;
      }
    }
    return count;
  }

  /** List active or queued virtual runners in the same folder family. Queued
   * descendants must be stopped before delete/clear, otherwise drainWaiting can
   * launch them after their workspace has already been removed. */
  listDescendantJids(baseJid: string): string[] {
    const baseKey = this.getSerializationKey(baseJid);
    const prefix = baseKey + '#';
    const result: string[] = [];
    for (const [jid, state] of this.groups.entries()) {
      const key = this.getSerializationKey(jid);
      if (!key.startsWith(prefix)) continue;
      if (
        state.active ||
        state.pendingTasks.length > 0 ||
        this.waitingGroups.has(jid)
      ) {
        result.push(jid);
      }
    }
    return result;
  }

  /**
   * Returns true if the active runner for this group (or its serialization
   * sibling) is currently executing a scheduled task rather than user messages.
   * Used by the message loop to avoid prematurely interrupting task containers.
   */
  isActiveRunnerTask(groupJid: string): boolean {
    const state = this.resolveActiveState(groupJid);
    return state?.activeRunnerIsTask === true;
  }

  markRunnerActivity(groupJid: string): void {
    const state = this.resolveActiveState(groupJid);
    if (!state?.active) return;
    state.lastActivityAt = Date.now();
  }

  /**
   * Mark that a message was IPC-injected into the running agent.
   * The caller has already advanced the next-pull cursor for this message. If
   * the agent crashes without completing it, the close handler uses its DB
   * lane to force a replay from lastCommittedCursor.
   */
  markIpcInjectedMessage(groupJid: string, databaseJid = groupJid): void {
    const state = this.resolveActiveState(groupJid);
    if (!state?.active) return;
    state.hasIpcInjectedMessages = true;
    state.ipcInjectedDatabaseJids ??= new Set<string>();
    state.ipcInjectedDatabaseJids.add(databaseJid);
  }

  needsIpcRecoveryReplay(databaseJid: string): boolean {
    return this.ipcRecoveryDatabaseJids.has(databaseJid);
  }

  clearIpcRecoveryReplay(databaseJid: string): void {
    this.ipcRecoveryDatabaseJids.delete(databaseJid);
  }

  private enqueueIpcRecovery(databaseJid: string): void {
    this.ipcRecoveryDatabaseJids.add(databaseJid);
    this.enqueueMessageCheck(databaseJid);
  }

  /**
   * A queued IPC envelope has crossed the logical-turn boundary. Route/card
   * ownership changes here (not at file-write time), and only now does the
   * short SDK-start watchdog apply to messages queued behind a running turn.
   */
  async markIpcMessagesTurnStarted(
    groupJid: string,
    messageIds: string[],
  ): Promise<void> {
    const state = this.resolveActiveState(groupJid);
    if (!state?.active || messageIds.length === 0) return;
    state.pendingIpcMessageIds ??= new Set<string>();
    state.ipcAckEligibleMessageIds ??= new Set<string>();
    state.ipcTurnStartCallbacks ??= new Map<
      string,
      () => void | Promise<void>
    >();

    const callbacks: Array<{
      messageId: string;
      callback: () => void | Promise<void>;
    }> = [];
    let armedWatchdog = false;
    for (const messageId of messageIds) {
      if (!state.pendingIpcMessageIds.has(messageId)) continue;
      if (!state.ipcAckEligibleMessageIds.has(messageId)) {
        state.ipcAckEligibleMessageIds.add(messageId);
        armedWatchdog = true;
      }
      const callback = state.ipcTurnStartCallbacks.get(messageId);
      if (callback) {
        state.ipcTurnStartCallbacks.delete(messageId);
        callbacks.push({ messageId, callback });
      }
    }
    if (armedWatchdog) state.ipcAwaitingAckSince ??= Date.now();

    for (const { messageId, callback } of callbacks) {
      try {
        await callback();
      } catch (err) {
        logger.warn(
          { groupJid, messageId, err },
          'IPC turn-start callback failed',
        );
      }
    }
  }

  /**
   * Apply an agent-runner acknowledgement only after provider acceptance for a
   * fresh query, or after Claude's SDK has pulled a pipe-in message. This closes
   * the consume-before-start hole without changing the warm-runner lifecycle.
   */
  markIpcMessagesStarted(groupJid: string, messageIds: string[]): void {
    const state = this.resolveActiveState(groupJid);
    if (!state?.active || messageIds.length === 0) return;
    state.pendingIpcMessageIds ??= new Set<string>();
    state.ipcAckEligibleMessageIds ??= new Set<string>();
    const retired = this.retireAcknowledgedIpcClaims(state, messageIds);
    for (const messageId of retired) {
      state.pendingIpcMessageIds.delete(messageId);
      state.ipcAckEligibleMessageIds.delete(messageId);
    }
    if (state.ipcAckEligibleMessageIds.size === 0) {
      state.ipcAwaitingAckSince = null;
    }
  }

  markIpcMessagesCompleted(groupJid: string, messageIds: string[]): void {
    const state = this.resolveActiveState(groupJid);
    if (!state?.active || messageIds.length === 0) return;
    state.completedIpcMessageIds ??= new Set<string>();
    for (const messageId of messageIds) {
      if (state.ipcDeliveryMetadata.has(messageId)) {
        state.completedIpcMessageIds.add(messageId);
      }
    }
  }

  /**
   * When the runner puts an ACKed claim back on disk, pause the short watchdog
   * until the next fresh-turn signal arms it again. Delivery ownership stays
   * unchanged so only that later query result can commit its DB cursor.
   */
  markIpcMessagesRequeued(groupJid: string, messageIds: string[]): void {
    const state = this.resolveActiveState(groupJid);
    if (!state?.active || messageIds.length === 0) return;
    state.pendingIpcMessageIds ??= new Set<string>();
    state.ipcAckEligibleMessageIds ??= new Set<string>();
    state.completedIpcMessageIds ??= new Set<string>();
    let requeued = false;
    for (const messageId of messageIds) {
      if (!state.ipcDeliveryMetadata.has(messageId)) continue;
      state.completedIpcMessageIds.delete(messageId);
      state.pendingIpcMessageIds.add(messageId);
      state.ipcAckEligibleMessageIds.delete(messageId);
      requeued = true;
    }
    if (requeued && state.ipcAckEligibleMessageIds.size === 0) {
      state.ipcAwaitingAckSince = null;
    }
  }

  /**
   * Return only deliveries explicitly tied to a completed query generation.
   * SDK pull/ACK alone is insufficient: an older result or interrupt can race
   * after a follow-up was pulled but before that follow-up was answered.
   */
  takeCompletedIpcDeliveries(groupJid: string): IpcDeliveryMetadata[] {
    const state = this.resolveActiveState(groupJid);
    if (!state?.active) return [];
    state.ipcDeliveryMetadata ??= new Map<string, IpcDeliveryMetadata>();
    state.completedIpcMessageIds ??= new Set<string>();
    const deliveries: IpcDeliveryMetadata[] = [];
    for (const messageId of [...state.completedIpcMessageIds]) {
      if (state.pendingIpcMessageIds.has(messageId)) continue;
      const delivery = state.ipcDeliveryMetadata.get(messageId);
      if (!delivery) {
        state.completedIpcMessageIds.delete(messageId);
        continue;
      }
      deliveries.push(delivery);
      state.ipcDeliveryMetadata.delete(messageId);
      state.completedIpcMessageIds.delete(messageId);
    }
    const remainingJids = new Set(
      [...state.ipcDeliveryMetadata.values()].map(
        (delivery) => delivery.databaseJid,
      ),
    );
    for (const databaseJid of [...state.ipcInjectedDatabaseJids]) {
      if (!remainingJids.has(databaseJid)) {
        state.ipcInjectedDatabaseJids.delete(databaseJid);
      }
    }
    if (state.ipcDeliveryMetadata.size === 0) {
      state.hasIpcInjectedMessages = false;
    }
    return deliveries;
  }

  /**
   * The runner only reports consumption; the host owns durable claim deletion.
   * This ordering means a runner crash before the output reaches the host leaves
   * the claim recoverable. A host crash after deletion still replays from the
   * uncommitted DB cursor, preferring a duplicate over silent loss.
   */
  private retireAcknowledgedIpcClaims(
    state: ActiveGroupState,
    messageIds: string[],
  ): Set<string> {
    const requested = new Set(messageIds);
    const retired = new Set<string>();
    const failed = new Set<string>();
    const inflightDir = path.join(this.resolveIpcInputDir(state), 'inflight');
    let files: string[];
    try {
      files = fs
        .readdirSync(inflightDir)
        .filter((file) => file.endsWith('.json'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return requested;
      logger.warn(
        { groupFolder: state.groupFolder, err },
        'Failed to list IPC claims while applying runner acknowledgement',
      );
      return retired;
    }

    for (const file of files) {
      const claimPath = path.join(inflightDir, file);
      let messageId = file.replace(/\.json$/, '');
      try {
        const data = JSON.parse(fs.readFileSync(claimPath, 'utf8')) as {
          messageId?: unknown;
        };
        if (typeof data.messageId === 'string') messageId = data.messageId;
      } catch (err) {
        if (requested.has(messageId)) failed.add(messageId);
        continue;
      }
      if (!requested.has(messageId)) continue;
      try {
        fs.unlinkSync(claimPath);
        retired.add(messageId);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          retired.add(messageId);
        } else {
          failed.add(messageId);
          logger.warn(
            { groupFolder: state.groupFolder, messageId, err },
            'Failed to retire acknowledged IPC claim',
          );
        }
      }
    }

    // A duplicate acknowledgement or legacy runner may reference a claim that
    // is already absent. Treat absence as retired, but never clear an ID whose
    // matching claim was unreadable or failed deletion.
    for (const messageId of requested) {
      if (!failed.has(messageId)) retired.add(messageId);
    }
    return retired;
  }

  markRunnerQueryIdle(groupJid: string): void {
    const state = this.resolveActiveState(groupJid);
    if (!state?.active) return;
    state.queryInFlight = false;
  }

  /**
   * Public check: does this group's main IPC input dir hold unconsumed
   * `.json` messages (orphaned by an agent that exited in its idle window)?
   * Used by processGroupMessages to avoid the "0 rows from DB → return without
   * spawning" short-circuit when an orphan file is still on disk, which would
   * otherwise leave the message forever unconsumed (see #inflight-message-drop).
   * Only checks the conversation-lane input (no agentId/taskRunId).
   */
  hasUnconsumedIpcInput(groupFolder: string): boolean {
    if (!groupFolder) return false;
    return this.hasRemainingIpcMessages(groupFolder, null, null);
  }

  hasUnconsumedAgentIpcInput(groupFolder: string, agentId: string): boolean {
    if (!groupFolder || !agentId) return false;
    return this.hasRemainingIpcMessages(groupFolder, agentId, null);
  }

  /**
   * Remove main-conversation IPC envelopes after their durable DB rows have
   * been selected for crash recovery. The database is the recovery source of
   * truth; leaving the same envelopes for the new runner would append the
   * follow-up a second time during its boot drain.
   */
  discardRecoveredIpcInput(
    groupFolder: string,
    databaseJid: string,
    recoveredCursors: IpcMessageCursor[],
  ): number {
    if (!groupFolder || !databaseJid) return 0;
    const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
    return this.discardRecoveredIpcEnvelopes(
      inputDir,
      databaseJid,
      recoveredCursors,
      { groupFolder },
    );
  }

  discardRecoveredAgentIpcInput(
    groupFolder: string,
    agentId: string,
    databaseJid: string,
    recoveredCursors: IpcMessageCursor[],
  ): number {
    if (!groupFolder || !agentId) return 0;
    const inputDir = path.join(
      DATA_DIR,
      'ipc',
      groupFolder,
      'agents',
      agentId,
      'input',
    );
    return this.discardRecoveredIpcEnvelopes(
      inputDir,
      databaseJid,
      recoveredCursors,
      { groupFolder, agentId },
    );
  }

  /** List durable DB lanes represented by queued/inflight envelopes. */
  getUnconsumedIpcDatabaseJids(
    groupFolder: string,
    fallbackJid: string,
    agentId?: string | null,
  ): Set<string> {
    const inputDir = agentId
      ? path.join(DATA_DIR, 'ipc', groupFolder, 'agents', agentId, 'input')
      : path.join(DATA_DIR, 'ipc', groupFolder, 'input');
    const jids = new Set<string>();
    for (const envelope of this.readIpcEnvelopes(inputDir)) {
      jids.add(envelope.databaseJid || fallbackJid);
    }
    return jids;
  }

  private readIpcEnvelopes(inputDir: string): Array<{
    path: string;
    databaseJid?: string;
    messageCursors: IpcMessageCursor[];
  }> {
    const envelopes: Array<{
      path: string;
      databaseJid?: string;
      messageCursors: IpcMessageCursor[];
    }> = [];
    for (const dir of [inputDir, path.join(inputDir, 'inflight')]) {
      let files: string[];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const envelopePath = path.join(dir, file);
        try {
          const data = JSON.parse(fs.readFileSync(envelopePath, 'utf8')) as {
            databaseJid?: unknown;
            messageCursors?: unknown;
          };
          const messageCursors = Array.isArray(data.messageCursors)
            ? data.messageCursors.filter(
                (cursor): cursor is IpcMessageCursor =>
                  !!cursor &&
                  typeof cursor === 'object' &&
                  typeof (cursor as IpcMessageCursor).id === 'string' &&
                  typeof (cursor as IpcMessageCursor).timestamp === 'string',
              )
            : [];
          envelopes.push({
            path: envelopePath,
            databaseJid:
              typeof data.databaseJid === 'string'
                ? data.databaseJid
                : undefined,
            messageCursors,
          });
        } catch {
          // Invalid envelopes are runner-owned; schedule the fallback lane so
          // a replacement runner can quarantine them, but keep ownership
          // unknown so DB recovery never deletes them as a sibling's message.
          envelopes.push({
            path: envelopePath,
            messageCursors: [],
          });
        }
      }
    }
    return envelopes;
  }

  private discardRecoveredIpcEnvelopes(
    inputDir: string,
    databaseJid: string,
    recoveredCursors: IpcMessageCursor[],
    context: { groupFolder: string; agentId?: string },
  ): number {
    const recovered = new Set(
      recoveredCursors.map((cursor) => `${cursor.timestamp}\0${cursor.id}`),
    );
    let removed = 0;
    for (const envelope of this.readIpcEnvelopes(inputDir)) {
      // Legacy/unattributed envelopes stay durable and may be replayed twice;
      // deleting an envelope owned by a sibling JID would silently lose it.
      if (envelope.databaseJid !== databaseJid) continue;
      if (envelope.messageCursors.length === 0) continue;
      if (
        !envelope.messageCursors.every((cursor) =>
          recovered.has(`${cursor.timestamp}\0${cursor.id}`),
        )
      ) {
        continue;
      }
      try {
        fs.unlinkSync(envelope.path);
        removed++;
      } catch (err) {
        logger.warn(
          { ...context, databaseJid, err },
          'Failed to discard DB-recovered IPC envelope',
        );
      }
    }
    return removed;
  }

  getStuckPendingGroups(
    idleThresholdMs: number,
    ipcAckThresholdMs = idleThresholdMs,
  ): Array<{ jid: string; idleMs: number }> {
    const now = Date.now();
    const stuck: Array<{ jid: string; idleMs: number }> = [];
    for (const [jid, state] of this.groups.entries()) {
      if (!state.active) continue;
      // Scheduled tasks are not user-message consumers. Conversation agents
      // are implemented on the task lane, however, and must remain visible to
      // the IPC ACK watchdog when a warm follow-up stalls.
      const isConversationAgent =
        state.activeRunnerIsTask && state.agentId !== null;
      if (state.activeRunnerIsTask && !isConversationAgent) continue;
      const awaitingIpcAck = (state.ipcAckEligibleMessageIds?.size ?? 0) > 0;
      if (!state.pendingMessages && !awaitingIpcAck) continue;
      if (state.agentId !== null && !isConversationAgent) continue;
      if (state.restarting) continue;
      const referenceTime = awaitingIpcAck
        ? state.ipcAwaitingAckSince
        : state.lastActivityAt;
      if (!referenceTime || referenceTime <= 0) continue;
      const idleMs = now - referenceTime;
      const threshold = awaitingIpcAck ? ipcAckThresholdMs : idleThresholdMs;
      if (idleMs < threshold) continue;
      stuck.push({ jid, idleMs });
    }
    return stuck;
  }

  /**
   * Get the PID of the active runner process for a group.
   * Returns undefined if no active process or running in container mode.
   */
  getRunnerPid(groupJid: string): number | undefined {
    const state = this.groups.get(groupJid);
    return state?.process?.pid;
  }

  /**
   * Resolve the active docker container name for a group, honoring the same
   * sibling-JID / serialization-key rules as `sendMessage()`. Returns null
   * when there is no active runner *or* the active runner is a host process.
   *
   * Used by the plugin-expander-core to decide whether an inline `!` bash
   * template can run inside the user's container.
   */
  getActiveContainerName(groupJid: string): string | null {
    const state = this.resolveActiveState(groupJid);
    return state?.containerName ?? null;
  }

  /**
   * Returns true iff `sendMessage(groupJid, ...)` would return 'sent' right
   * now — i.e. there is an active runner and it is compatible with piping a
   * user message in. Specifically:
   *   - `resolveActiveState(groupJid)` returns non-null (active state, own
   *     or via serialization sibling), AND
   *   - the active runner is NOT a scheduled-task runner unless the caller
   *     IS a `#agent:` conversation virtual JID (those are user-message
   *     handlers started via `enqueueTask`).
   *
   * This predicate exists ONLY to gate web.ts eager plugin-command expansion
   * against the same compatibility rules `sendMessage` uses internally.
   * Returning `true` when `sendMessage` would actually return `no_active`
   * causes a double-fire: eager expand runs inline `!` here, sendMessage
   * rejects, cold-start re-reads the original DB row, expands a SECOND time,
   * and inline `!` runs again under the wrong runner context (#21 round-13
   * P1-1). The name is deliberately specific to discourage accidental reuse
   * for "is a runner up at all?" semantics — that's `resolveActiveState() !==
   * null`, which doesn't match `sendMessage`'s acceptance set.
   */
  hasActiveMainRunnerForMessage(groupJid: string): boolean {
    const state = this.resolveActiveState(groupJid);
    if (!state) return false;
    // Task-runner exclusion mirrors sendMessage(). Conversation agents
    // (`#agent:` virtual JIDs) DO accept IPC messages — exempt them.
    if (state.activeRunnerIsTask && !groupJid.includes('#agent:')) {
      return false;
    }
    return true;
  }

  enqueueMessageCheck(groupJid: string, initiatorUserId?: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    const activeRunner = this.findActiveRunnerFor(groupJid);
    if (state.active || (activeRunner && activeRunner !== groupJid)) {
      state.pendingMessages = true;
      this.waitingGroups.add(groupJid);
      // Write _drain to the actual active runner so sibling JIDs sharing one
      // folder also unblock immediately instead of waiting for idle timeout.
      this.requestDrainForActiveRunner(
        groupJid,
        'Drain sentinel written during enqueueMessageCheck to unblock pending messages',
      );
      logger.debug(
        { groupJid, activeRunner: activeRunner || groupJid },
        'Group runner active, message queued',
      );
      return;
    }

    // Past the active / shared-active check → this jid will start its OWN fresh
    // run (now, or once capacity frees). Record who initiated it so the
    // stop/interrupt routes can do an owner-or-initiator check. Only overwrite
    // when an initiator is explicitly supplied, so internal drain re-enqueues
    // (no initiator) don't wipe a pending run's initiator.
    if (initiatorUserId !== undefined) {
      state.currentRunInitiator = initiatorUserId;
    }

    if (!this.hasCapacityFor(groupJid)) {
      const isHost = this.isHostMode(groupJid);
      state.pendingMessages = true;
      this.waitingGroups.add(groupJid);
      logger.debug(
        {
          groupJid,
          activeContainerCount: this.activeContainerCount,
          activeHostProcessCount: this.activeHostProcessCount,
          mode: isHost ? 'host' : 'container',
        },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.waitingGroups.delete(groupJid);
    this.runForGroup(groupJid, 'messages');
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing of the same task
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    const activeRunner = this.findActiveRunnerFor(groupJid);
    if (state.active || (activeRunner && activeRunner !== groupJid)) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      this.waitingGroups.add(groupJid);
      logger.debug(
        { groupJid, taskId, activeRunner: activeRunner || groupJid },
        'Group runner active, task queued',
      );
      return;
    }

    if (!this.hasCapacityFor(groupJid)) {
      const isHost = this.isHostMode(groupJid);
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      this.waitingGroups.add(groupJid);
      logger.debug(
        {
          groupJid,
          taskId,
          activeContainerCount: this.activeContainerCount,
          activeHostProcessCount: this.activeHostProcessCount,
          mode: isHost ? 'host' : 'container',
        },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.waitingGroups.delete(groupJid);
    this.runTask(groupJid, { id: taskId, groupJid, fn });
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    opts: {
      containerName: string | null;
      groupFolder?: string;
      displayName?: string;
      agentId?: string;
      taskRunId?: string;
      ipcDatabaseJidFilter?: string;
      selectedProviderId?: string | null;
    },
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = opts.containerName;
    state.displayName = opts.displayName || null;
    if (opts.groupFolder) state.groupFolder = opts.groupFolder;
    state.agentId = opts.agentId || null;
    state.taskRunId = opts.taskRunId || null;
    state.ipcDatabaseJidFilter = opts.ipcDatabaseJidFilter || null;
    state.selectedProviderId = opts.selectedProviderId ?? null;
    if (state.ipcDatabaseJidFilter && !state.drainSentinelWritten) {
      state.drainSentinelWritten = this.writeDrainSentinel(
        state as ActiveGroupState,
      );
    }
  }

  /**
   * Resolve IPC input directory for a group state.
   * Sub-agents use a nested path: data/ipc/{folder}/agents/{agentId}/input/
   */
  private resolveIpcInputDir(state: ActiveGroupState): string {
    if (state.taskRunId) {
      return path.join(
        DATA_DIR,
        'ipc',
        state.groupFolder,
        'tasks-run',
        state.taskRunId,
        'input',
      );
    }
    if (state.agentId) {
      return path.join(
        DATA_DIR,
        'ipc',
        state.groupFolder,
        'agents',
        state.agentId,
        'input',
      );
    }
    return path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   *
   * Returns:
   * - 'sent': message written to IPC (包括 queryInFlight 时的排队写入)
   * - 'no_active': no active container/process for this group
   */
  sendMessage(
    groupJid: string,
    text: string,
    images?: Array<{ data: string; mimeType?: string }>,
    onTurnStarted?: () => void | Promise<void>,
    sourceJid?: string,
    delivery?: IpcDeliveryMetadata,
  ): SendMessageResult {
    const state = this.resolveActiveState(groupJid);
    if (!state) return 'no_active';

    const databaseJid = delivery?.databaseJid || groupJid;
    if (
      state.ipcDatabaseJidFilter &&
      state.ipcDatabaseJidFilter !== databaseJid
    ) {
      logger.debug(
        {
          groupJid,
          databaseJid,
          recoveryDatabaseJid: state.ipcDatabaseJidFilter,
        },
        'Recovery runner is pinned to another DB lane; deferring message',
      );
      return 'no_active';
    }

    // If the active runner is a scheduled task (not a user-message handler),
    // do NOT pipe user messages into it.  The task container has no knowledge
    // of the user conversation context, so any IPC message injected here would
    // be silently consumed (or confusingly processed) by the task agent and the
    // reply would never reach the user.  Returning 'no_active' causes the
    // caller to enqueue a fresh message-processing run that will execute once
    // the task finishes.  See GitHub issue riba2534/happyclaw#151.
    //
    // Exception: conversation agent tasks (virtual JIDs with #agent:) are
    // user-message handlers started via enqueueTask.  They DO accept IPC
    // messages — blocking them causes a deadlock where the agent waits for
    // IPC input that never arrives.
    if (state.activeRunnerIsTask && !groupJid.includes('#agent:')) {
      logger.debug(
        { groupJid },
        'Active runner is a scheduled task; deferring user message until task completes',
      );
      return 'no_active';
    }

    // queryInFlight=true：当前 query 正在执行，将消息写入 IPC 文件排队。
    // runner 不会把它 pipe 进当前 SDK stream；当前逻辑 turn 完成后，
    // waitForIpcMessage() → drainIpcInput() 才合并为一个新的完整 prompt，
    // 实现自然聚合（如飞书转发+评论场景），同时避免副作用执行两遍。
    // 不写 _drain：容器无需退出重启，仍可复用当前进程。

    const wasQueryInFlight = state.queryInFlight;
    const inputDir = this.resolveIpcInputDir(state);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const filename = `${messageId}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(
        tempPath,
        JSON.stringify({
          type: 'message',
          messageId,
          createdAt: Date.now(),
          text,
          images,
          sourceJid,
          databaseJid,
          messageCursors: delivery?.messageCursors || [],
        }),
      );
      fs.renameSync(tempPath, filepath);
      state.queryInFlight = true;
      state.pendingIpcMessageIds ??= new Set<string>();
      state.pendingIpcMessageIds.add(messageId);
      state.ipcAckEligibleMessageIds ??= new Set<string>();
      state.ipcTurnStartCallbacks ??= new Map<
        string,
        () => void | Promise<void>
      >();
      if (onTurnStarted) {
        state.ipcTurnStartCallbacks.set(messageId, onTurnStarted);
      }
      state.ipcDeliveryMetadata ??= new Map<string, IpcDeliveryMetadata>();
      state.ipcDeliveryMetadata.set(
        messageId,
        delivery ?? {
          databaseJid: groupJid,
          messageCursors: [],
        },
      );
      // An idle warm runner should claim promptly, so retain the short
      // no-child watchdog. A message queued behind a live query becomes
      // eligible only when the runner announces its fresh turn.
      if (!wasQueryInFlight) {
        state.ipcAckEligibleMessageIds.add(messageId);
        state.ipcAwaitingAckSince ??= Date.now();
      }
      state.hasIpcInjectedMessages = true;
      state.ipcInjectedDatabaseJids ??= new Set<string>();
      state.ipcInjectedDatabaseJids.add(databaseJid);
      return 'sent';
    } catch (err) {
      // 不静默：磁盘满 / 权限错 / inode 耗尽这些根因不应该被伪装成
      // 'no_active'。下游会重新 enqueueMessageCheck 走 fallback 路径，
      // 但运维需要看到根因日志。
      logger.warn(
        { groupJid, inputDir, err },
        'GroupQueue.sendMessage: failed to write IPC input file, falling back to no_active',
      );
      return 'no_active';
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.resolveActiveState(groupJid);
    if (!state) return;

    const inputDir = this.resolveIpcInputDir(state);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  /**
   * Remove leftover _drain and _close sentinel files from the IPC input
   * directory.  Called in finally blocks after a runner exits so that a
   * subsequent runner for the same folder does not immediately see stale
   * sentinels and exit prematurely.
   */
  private cleanupIpcSentinels(
    groupFolder: string,
    agentId?: string | null,
    taskRunId?: string | null,
  ): void {
    const inputDir = taskRunId
      ? path.join(DATA_DIR, 'ipc', groupFolder, 'tasks-run', taskRunId, 'input')
      : agentId
        ? path.join(DATA_DIR, 'ipc', groupFolder, 'agents', agentId, 'input')
        : path.join(DATA_DIR, 'ipc', groupFolder, 'input');
    for (const name of ['_drain', '_close', '_interrupt']) {
      try {
        fs.unlinkSync(path.join(inputDir, name));
      } catch {
        // file may not exist – that's fine
      }
    }
  }

  /**
   * Check if there are unconsumed IPC message files (.json) in the input directory.
   * Called after process exit to detect messages written via sendMessage() that were
   * never consumed due to a race condition (process exiting before reading IPC).
   * See GitHub issue #240.
   */
  /**
   * Check for unconsumed IPC messages after agent/task exit and recover.
   * Handles the race where sendMessage() wrote a file but the process
   * exited before reading it (issue #240).
   */
  private recoverUnconsumedIpc(
    groupJid: string,
    state: GroupState,
    context: string,
  ): boolean {
    if (!state.groupFolder) return false;
    // restartGroup owns recovery while a watchdog/administrator restart is in
    // progress. Re-enqueuing from the exiting runner's finally block would
    // start a replacement before restartGroup has finished waiting, causing
    // the replacement to be mistaken for the old process and killed again.
    if (state.restarting) return false;
    // 与 runForGroup finally 的逻辑保持一致：刚被 stopGroup 标记的 folder 不
    // 应该在这里重新点亮 pendingMessages，否则 stopGroup 之后的 drainGroup 路径
    // 会拉起一个新 runner。
    if (this.isRecentlyStopped(state.groupFolder)) {
      return false;
    }
    try {
      if (
        !this.hasRemainingIpcMessages(
          state.groupFolder,
          state.agentId,
          state.taskRunId,
        )
      )
        return false;

      if (state.agentId && this.onUnconsumedAgentIpcFn) {
        logger.warn(
          { groupJid, agentId: state.agentId },
          `Unconsumed IPC messages found after ${context}, re-enqueuing`,
        );
        this.ipcRecoveryDatabaseJids.add(groupJid);
        this.onUnconsumedAgentIpcFn(groupJid, state.agentId);
        return true;
      } else if (!state.taskRunId) {
        const recoveryJids = this.getUnconsumedIpcDatabaseJids(
          state.groupFolder,
          groupJid,
        );
        for (const databaseJid of recoveryJids) {
          this.enqueueIpcRecovery(databaseJid);
        }
        logger.warn(
          { groupJid, recoveryJids: [...recoveryJids] },
          `Unconsumed IPC messages found after ${context}, re-enqueuing DB lanes`,
        );
        return recoveryJids.size > 0;
      }
    } catch (err) {
      logger.warn({ groupJid, err }, 'Failed to check remaining IPC messages');
    }
    return false;
  }

  private hasRemainingIpcMessages(
    groupFolder: string,
    agentId?: string | null,
    taskRunId?: string | null,
  ): boolean {
    const inputDir = taskRunId
      ? path.join(DATA_DIR, 'ipc', groupFolder, 'tasks-run', taskRunId, 'input')
      : agentId
        ? path.join(DATA_DIR, 'ipc', groupFolder, 'agents', agentId, 'input')
        : path.join(DATA_DIR, 'ipc', groupFolder, 'input');
    try {
      const files = fs.readdirSync(inputDir);
      if (files.some((f) => f.endsWith('.json'))) return true;
      const inflightDir = path.join(inputDir, 'inflight');
      return fs.readdirSync(inflightDir).some((f) => f.endsWith('.json'));
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to finish the current query and then exit.
   * Unlike _close which exits immediately from waitForIpcMessage, _drain
   * is only checked after the current query completes, ensuring one-question-
   * one-answer semantics.
   */
  private writeDrainSentinel(state: ActiveGroupState): boolean {
    const inputDir = this.resolveIpcInputDir(state);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_drain'), '');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal a specific group's active container to gracefully exit.
   * Used by provider switch: after the container exits, processGroupMessages
   * will automatically restart it (picking up the new provider via override).
   * Uses _drain (not _close) so the current query finishes before exit.
   */
  requestGracefulRestart(groupJid: string): boolean {
    const state = this.groups.get(groupJid);
    if (!state?.active || !state.groupFolder) return false;
    const written = this.writeDrainSentinel(state as ActiveGroupState);
    if (written) {
      // Ensure close handler triggers a new run even if no messages are pending
      state.pendingMessages = true;
      logger.info(
        { groupJid, groupFolder: state.groupFolder },
        'Sent drain signal for provider switch',
      );
    }
    return written;
  }

  /**
   * Close all active containers/processes so they restart with fresh credentials.
   * Called after OAuth token refresh to ensure running agents pick up new tokens.
   */
  closeAllActiveForCredentialRefresh(): number {
    let closed = 0;
    for (const [jid, state] of this.groups) {
      if (state.active && state.groupFolder) {
        const inputDir = this.resolveIpcInputDir(state as ActiveGroupState);
        try {
          fs.mkdirSync(inputDir, { recursive: true });
          fs.writeFileSync(path.join(inputDir, '_close'), '');
          closed++;
          logger.info(
            { groupJid: jid, groupFolder: state.groupFolder },
            'Sent close signal for credential refresh',
          );
        } catch {
          // ignore
        }
      }
    }
    if (closed > 0) {
      logger.info(
        { closed },
        'Closed active containers/processes for credential refresh',
      );
    }
    return closed;
  }

  /**
   * Interrupt the current query for the same chat only (do not cross-interrupt
   * sibling chats that share a serialized runner/folder).
   *
   * Writes a _interrupt sentinel that agent-runner detects and calls
   * query.interrupt(). The container stays alive and accepts new messages.
   */
  interruptQuery(groupJid: string): boolean {
    // Use resolveActiveState so sibling JIDs (feishu/telegram sharing the
    // same folder as a web group) are correctly resolved to the active runner.
    const state = this.resolveActiveState(groupJid);
    if (!state) return false;

    // 只取消等待中的 retry 定时器（如果有），不重置 retryCount —— 不让用户
    // 中断把已积累的 backoff 进度归零。
    this.cancelRetryTimer(state);

    const inputDir = this.resolveIpcInputDir(state);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      try {
        fs.chmodSync(inputDir, 0o777);
      } catch {
        /* ignore */
      }
      fs.writeFileSync(path.join(inputDir, '_interrupt'), '');
      logger.info({ groupJid, inputDir }, 'Interrupt sentinel written');
      return true;
    } catch (err) {
      logger.warn(
        { groupJid, inputDir, err },
        'Failed to write interrupt sentinel',
      );
      return false;
    }
  }

  /**
   * Force-stop a group's active container and clear queued work.
   * Returns a promise that resolves when the container has fully exited
   * (state.active becomes false), not just when docker stop completes.
   */
  async stopGroup(
    groupJid: string,
    options?: { force?: boolean },
  ): Promise<void> {
    const force = options?.force ?? false;
    const requestedState = this.getGroup(groupJid);
    requestedState.pendingMessages = false;
    requestedState.pendingTasks = [];
    this.clearRetryTimer(requestedState);
    // 标记 stop 时间：runForGroup finally + index.ts OOM 计数 + 主消息循环
    // 都用这个时间窗判断 user-stopped vs 真 OOM / IPC-injected drain。
    if (requestedState.groupFolder) {
      this.recentlyStoppedFolders.set(requestedState.groupFolder, Date.now());
    }

    const activeRunner = this.findActiveRunnerFor(groupJid);
    const targetJid = activeRunner || groupJid;
    const state = this.getGroup(targetJid);
    if (targetJid !== groupJid) {
      state.pendingMessages = false;
      state.pendingTasks = [];
      this.clearRetryTimer(state);
    }
    if (state.groupFolder) {
      this.recentlyStoppedFolders.set(state.groupFolder, Date.now());
    }
    this.waitingGroups.delete(groupJid);
    this.waitingGroups.delete(targetJid);

    if (state.groupFolder) {
      this.closeStdin(targetJid);
    }

    if (force) {
      // Force mode: skip graceful stop, go straight to kill
      if (state.containerName) {
        const name = state.containerName;
        await new Promise<void>((resolve) => {
          execFile('docker', ['kill', name], { timeout: 5000 }, () =>
            resolve(),
          );
        });
      } else if (state.process && !state.process.killed) {
        killProcessTree(state.process, 'SIGKILL');
      }

      if (state.active) {
        const start = Date.now();
        while (state.active && Date.now() - start < 5000) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    } else {
      // Graceful mode: try SIGTERM/docker stop first
      if (state.containerName) {
        const name = state.containerName;
        await new Promise<void>((resolve) => {
          execFile('docker', ['stop', name], { timeout: 10000 }, () =>
            resolve(),
          );
        });
      } else if (state.process && !state.process.killed) {
        killProcessTree(state.process, 'SIGTERM');
      }

      // Wait for state.active to become false (runForGroup/runTask finally block)
      if (state.active) {
        const maxWait = 10000;
        const start = Date.now();
        while (state.active && Date.now() - start < maxWait) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }

      // Graceful stop timed out — force-kill the container
      if (state.active && state.containerName) {
        const killName = state.containerName;
        logger.warn(
          { groupJid: targetJid, containerName: killName },
          'Graceful stop timed out, force-killing container',
        );
        await new Promise<void>((resolve) => {
          execFile('docker', ['kill', killName], { timeout: 5000 }, () =>
            resolve(),
          );
        });
        const killStart = Date.now();
        while (state.active && Date.now() - killStart < 5000) {
          await new Promise((r) => setTimeout(r, 100));
        }
      } else if (state.active && state.process) {
        killProcessTree(state.process, 'SIGKILL');
        const killStart = Date.now();
        while (state.active && Date.now() - killStart < 5000) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }

    if (state.active) {
      logger.error(
        { groupJid: targetJid },
        'Container still active after force-kill in stopGroup',
      );
      throw new Error(`Failed to stop container for group ${targetJid}`);
    }
  }

  /**
   * Stop the running container, wait for it to finish, then start a new one.
   */
  async restartGroup(groupJid: string): Promise<void> {
    const activeRunner = this.findActiveRunnerFor(groupJid);
    const targetJid = activeRunner || groupJid;
    const state = this.getGroup(targetJid);
    const restartingAgentId = state.agentId;
    const restartingGroupFolder = state.groupFolder;
    const restartingDatabaseJids = new Set(state.ipcInjectedDatabaseJids ?? []);

    if (state.restarting) {
      logger.warn(
        { groupJid: targetJid },
        'Restart already in progress, skipping',
      );
      return;
    }
    state.restarting = true;

    try {
      if (state.groupFolder) {
        this.closeStdin(targetJid);
      }

      // Give agent-runner time to detect _close sentinel and exit gracefully
      // before sending SIGTERM.  The IPC poll interval is 500ms, so 2s is
      // generous enough for the agent to finish its current operation and
      // emit the final session ID.
      if (state.groupFolder && !state.containerName) {
        const graceStart = Date.now();
        while (state.active && Date.now() - graceStart < 2000) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      // Stop docker container / host process
      if (state.containerName) {
        const name = state.containerName;
        await new Promise<void>((resolve) => {
          execFile('docker', ['stop', name], { timeout: 15000 }, () =>
            resolve(),
          );
        });
      } else if (state.active && state.process && !state.process.killed) {
        killProcessTree(state.process, 'SIGTERM');
      }

      // Wait for runForGroup to finish and reset state
      const maxWait = 20000;
      const start = Date.now();
      while (state.active && Date.now() - start < maxWait) {
        await new Promise((r) => setTimeout(r, 200));
      }

      if (state.active) {
        logger.warn(
          { groupJid: targetJid },
          'Timeout waiting for container to stop, force-killing',
        );
        // Force-kill the container to avoid conflicts with the new one
        if (state.containerName) {
          const killName = state.containerName;
          await new Promise<void>((resolve) => {
            execFile('docker', ['kill', killName], { timeout: 5000 }, () =>
              resolve(),
            );
          });
          // Brief wait for process cleanup after force-kill
          const killStart = Date.now();
          while (state.active && Date.now() - killStart < 5000) {
            await new Promise((r) => setTimeout(r, 200));
          }
        } else if (state.process) {
          killProcessTree(state.process, 'SIGKILL');
          const killStart = Date.now();
          while (state.active && Date.now() - killStart < 5000) {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      }

      if (state.active) {
        logger.error(
          { groupJid: targetJid },
          'Container still active after force-kill in restartGroup',
        );
        throw new Error(`Failed to restart container for group ${targetJid}`);
      }
    } finally {
      state.restarting = false;
    }

    // Trigger recovery only after the old runner is fully inactive and the
    // restart guard has been released. Conversation-agent runners are task
    // lane jobs, so they must be re-enqueued through their dedicated callback
    // rather than the main-message queue.
    logger.info(
      { groupJid: targetJid, conversationAgent: !!restartingAgentId },
      'Restarting runner',
    );
    if (restartingAgentId) {
      this.ipcRecoveryDatabaseJids.add(targetJid);
      this.onUnconsumedAgentIpcFn?.(targetJid, restartingAgentId);
    } else {
      if (restartingGroupFolder) {
        for (const databaseJid of this.getUnconsumedIpcDatabaseJids(
          restartingGroupFolder,
          groupJid,
        )) {
          restartingDatabaseJids.add(databaseJid);
        }
      }
      if (restartingDatabaseJids.size === 0) {
        restartingDatabaseJids.add(groupJid);
      }
      for (const databaseJid of restartingDatabaseJids) {
        this.enqueueIpcRecovery(databaseJid);
      }
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    // Defensive re-entrancy guard: never start a second runner on a GroupState
    // that is already active. Pending work is picked up by the active runner's
    // finally → drainGroup, so returning here loses nothing.
    if (state.active) {
      logger.warn(
        { groupJid, reason },
        'runForGroup called on already-active group, ignoring re-entry',
      );
      return;
    }
    const isHostMode = this.isHostMode(groupJid);
    state.active = true;
    state.activeRunnerIsTask = false;
    state.lastActivityAt = Date.now();
    state.queryInFlight = true;
    state.pendingMessages = false;
    this.waitingGroups.delete(groupJid);
    this.activeCount++;
    if (isHostMode) {
      this.activeHostProcessCount++;
    } else {
      this.activeContainerCount++;
    }

    logger.debug(
      {
        groupJid,
        reason,
        activeCount: this.activeCount,
        activeContainerCount: this.activeContainerCount,
      },
      'Starting container for group',
    );

    try {
      this.onRunnerStateChangeFn?.(groupJid, 'running');
    } catch (err) {
      logger.error({ groupJid, err }, 'onRunnerStateChange(running) failed');
    }

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
          // Defensive: clear any lingering retry timer from a previous failed
          // run that was superseded by a successful drain-triggered run.
          this.clearRetryTimer(state);
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      // Clean up stale sentinel files before clearing groupFolder/agentId
      const exitFolder = state.groupFolder;
      const isStopRequested = exitFolder
        ? this.isRecentlyStopped(exitFolder)
        : false;
      if (state.groupFolder) {
        try {
          this.cleanupIpcSentinels(
            state.groupFolder,
            state.agentId,
            state.taskRunId,
          );
        } catch (err) {
          logger.warn({ groupJid, err }, 'Failed to clean up IPC sentinels');
        }
        this.recoverUnconsumedIpc(groupJid, state, 'agent exit');
      }
      // If messages were IPC-injected during this run, always mark pending
      // so drainGroup triggers a fresh processGroupMessages.  If the agent
      // already replied to them, processGroupMessages will find 0 new messages
      // (cursor was committed) and return immediately — harmless.  If the
      // agent crashed, this ensures the messages are re-read from DB.
      //
      // BUT: when the user just clicked Stop, this re-armed pendingMessages
      // was racing stopGroup's clear → the agent restarted itself instantly.
      // Honor stopGroup's intent by skipping this re-arm if a stop was issued
      // for this folder in the last RECENTLY_STOPPED_WINDOW_MS.
      if (state.hasIpcInjectedMessages && !isStopRequested) {
        const recoveryJids =
          state.ipcInjectedDatabaseJids?.size > 0
            ? [...state.ipcInjectedDatabaseJids]
            : [groupJid];
        for (const databaseJid of recoveryJids) {
          this.enqueueIpcRecovery(databaseJid);
        }
        logger.debug(
          { groupJid, recoveryCount: recoveryJids.length },
          'IPC-injected DB lanes detected, scheduling safety re-check',
        );
      } else if (state.hasIpcInjectedMessages && isStopRequested) {
        logger.info(
          { groupJid, folder: exitFolder },
          'Stop requested recently, skipping pendingMessages re-arm',
        );
      }
      state.active = false;
      state.drainSentinelWritten = false;
      state.hasIpcInjectedMessages = false;
      state.ipcInjectedDatabaseJids?.clear();
      state.ipcDeliveryMetadata?.clear();
      state.completedIpcMessageIds?.clear();
      state.pendingIpcMessageIds?.clear();
      state.ipcAckEligibleMessageIds?.clear();
      state.ipcTurnStartCallbacks?.clear();
      state.ipcAwaitingAckSince = null;
      state.lastActivityAt = null;
      state.queryInFlight = false;
      state.process = null;
      state.containerName = null;
      state.displayName = null;
      state.groupFolder = null;
      state.agentId = null;
      state.taskRunId = null;
      state.ipcDatabaseJidFilter = null;
      state.currentRunInitiator = null;
      this.activeCount--;
      if (isHostMode) {
        this.activeHostProcessCount--;
      } else {
        this.activeContainerCount--;
      }
      try {
        this.onRunnerStateChangeFn?.(groupJid, 'idle');
      } catch (err) {
        logger.error({ groupJid, err }, 'onRunnerStateChange(idle) failed');
      }
      try {
        this.onContainerExitFn?.(groupJid);
      } catch (err) {
        logger.error({ groupJid, err }, 'onContainerExit callback failed');
      }
      // Skip auto-drain when a stop was just requested — drainGroup would
      // start a fresh runForGroup if any pending* slipped through.
      if (!isStopRequested) {
        try {
          this.drainGroup(groupJid);
        } catch (err) {
          logger.error({ groupJid, err }, 'drainGroup failed');
        }
      } else {
        logger.info(
          { groupJid, folder: exitFolder },
          'Stop requested recently, skipping drainGroup',
        );
      }
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    // Defensive re-entrancy guard (see runForGroup): a task must never start on
    // an already-active GroupState, or it would overwrite the live process
    // handle and double-count the concurrency slot.
    if (state.active) {
      logger.warn(
        { groupJid, taskId: task.id },
        'runTask called on already-active group, re-queuing task',
      );
      state.pendingTasks.unshift(task);
      this.waitingGroups.add(groupJid);
      return;
    }
    const isHostMode = this.isHostMode(groupJid);
    state.active = true;
    state.activeRunnerIsTask = true;
    state.lastActivityAt = Date.now();
    state.queryInFlight = false;
    this.waitingGroups.delete(groupJid);
    this.activeCount++;
    if (isHostMode) {
      this.activeHostProcessCount++;
    } else {
      this.activeContainerCount++;
    }

    logger.debug(
      {
        groupJid,
        taskId: task.id,
        activeCount: this.activeCount,
        activeContainerCount: this.activeContainerCount,
      },
      'Running queued task',
    );

    try {
      this.onRunnerStateChangeFn?.(groupJid, 'running');
    } catch (err) {
      logger.error({ groupJid, err }, 'onRunnerStateChange(running) failed');
    }

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      // Clean up stale sentinel files before clearing groupFolder/agentId
      let recoveryScheduled = false;
      if (state.groupFolder) {
        try {
          this.cleanupIpcSentinels(
            state.groupFolder,
            state.agentId,
            state.taskRunId,
          );
        } catch (err) {
          logger.warn({ groupJid, err }, 'Failed to clean up IPC sentinels');
        }
        recoveryScheduled = this.recoverUnconsumedIpc(
          groupJid,
          state,
          'task exit',
        );
      }
      if (
        !recoveryScheduled &&
        state.agentId &&
        state.hasIpcInjectedMessages &&
        !state.restarting &&
        this.onUnconsumedAgentIpcFn
      ) {
        // The host may already have retired the consumed claim, but the DB
        // cursor is not committed until a reply is persisted. Re-check the
        // agent DB lane after any premature task-runner exit.
        this.ipcRecoveryDatabaseJids.add(groupJid);
        this.onUnconsumedAgentIpcFn(groupJid, state.agentId);
      }
      state.active = false;
      state.activeRunnerIsTask = false;
      state.drainSentinelWritten = false;
      state.hasIpcInjectedMessages = false;
      state.ipcInjectedDatabaseJids?.clear();
      state.ipcDeliveryMetadata?.clear();
      state.completedIpcMessageIds?.clear();
      state.pendingIpcMessageIds?.clear();
      state.ipcAckEligibleMessageIds?.clear();
      state.ipcTurnStartCallbacks?.clear();
      state.ipcAwaitingAckSince = null;
      state.lastActivityAt = null;
      state.queryInFlight = false;
      state.process = null;
      state.containerName = null;
      state.displayName = null;
      state.groupFolder = null;
      state.agentId = null;
      state.ipcDatabaseJidFilter = null;
      state.taskRunId = null;
      this.activeCount--;
      if (isHostMode) {
        this.activeHostProcessCount--;
      } else {
        this.activeContainerCount--;
      }
      try {
        this.onRunnerStateChangeFn?.(groupJid, 'idle');
      } catch (err) {
        logger.error({ groupJid, err }, 'onRunnerStateChange(idle) failed');
      }
      try {
        this.onContainerExitFn?.(groupJid);
      } catch (err) {
        logger.error({ groupJid, err }, 'onContainerExit callback failed');
      }
      try {
        this.drainGroup(groupJid);
      } catch (err) {
        logger.error({ groupJid, err }, 'drainGroup failed');
      }
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    // 清除可能存在的旧定时器（不重置 retryCount，因为这里在递增）
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }

    // 检查是否为上下文溢出错误，如果是则跳过重试
    if (this.contextOverflowGroups.has(groupJid)) {
      logger.warn(
        { groupJid },
        'Skipping retry for context overflow error (agent already retried 3 times)',
      );
      state.retryCount = 0;
      this.contextOverflowGroups.delete(groupJid); // 清除标记
      return;
    }

    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      try {
        this.onMaxRetriesExceededFn?.(groupJid);
      } catch (err) {
        logger.error({ groupJid, err }, 'onMaxRetriesExceeded callback failed');
      }
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);
    if (state.restarting) return;
    const activeRunner = this.findActiveRunnerFor(groupJid);
    if (activeRunner && activeRunner !== groupJid) {
      this.waitingGroups.add(groupJid);
      return;
    }
    if (!this.hasCapacityFor(groupJid)) {
      this.waitingGroups.add(groupJid);
      return;
    }

    // Tasks first (they won't be re-discovered from SQLite like messages)
    while (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      // Check if scheduled task is still active before occupying a slot.
      // Only skip tasks that exist in the DB and are no longer active.
      // Dynamic tasks (agent conversations, etc.) don't have DB entries
      // and must always be allowed to run.
      const dbTask = getTaskById(task.id);
      if (dbTask && dbTask.status !== 'active') {
        logger.info(
          { groupJid, taskId: task.id },
          'Skipping cancelled/deleted task during drain',
        );
        continue;
      }
      this.runTask(groupJid, task);
      return;
    }

    // Then pending messages — but NOT if a retry timer is already scheduled.
    // When processMessagesFn() fails, both scheduleRetry() and drainGroup() fire.
    // Without this guard, drainGroup would start a new container while the retry
    // timer later starts another, causing duplicate processing of the same messages.
    if (state.pendingMessages && !state.retryTimer) {
      this.runForGroup(groupJid, 'drain');
      return;
    }

    this.waitingGroups.delete(groupJid);

    // GC one-shot virtual JIDs (#task:/#agent:) once fully idle. Each task run
    // uses a unique taskRunId → a unique JID, so without this the groups Map
    // grows without bound. Only virtual JIDs are collected; real chat JIDs are
    // bounded by the number of registered groups and keep useful state. We only
    // reach here when there are no pending tasks and no runnable messages.
    if (this.isVirtualJid(groupJid)) {
      const s = this.groups.get(groupJid);
      if (
        s &&
        !s.active &&
        !s.queryInFlight &&
        !s.pendingMessages &&
        s.pendingTasks.length === 0 &&
        !s.retryTimer &&
        !s.restarting &&
        !this.waitingGroups.has(groupJid)
      ) {
        this.groups.delete(groupJid);
        this.contextOverflowGroups.delete(groupJid);
        // fall through to drainWaiting so other waiting groups still get a slot
      }
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  /** Virtual JIDs are one-shot per run (`{jid}#task:{id}` / `{jid}#agent:{id}`). */
  private isVirtualJid(jid: string): boolean {
    return jid.includes('#task:') || jid.includes('#agent:');
  }

  private drainWaiting(): void {
    // Drain waiting groups one at a time, re-checking capacity after each launch.
    // runTask/runForGroup increment counters synchronously, so capacity checks
    // stay accurate even though the async work is not awaited.
    const candidates = [...this.waitingGroups];

    for (const jid of candidates) {
      const activeRunner = this.findActiveRunnerFor(jid);
      // Any active runner sharing this serialization key — including jid's OWN
      // runner — means no new runner may start. enqueueMessageCheck adds a jid
      // to waitingGroups even while its own runner is active (state.active), so
      // without checking self-active we would start a SECOND concurrent runner
      // on the same GroupState (duplicate replies, orphaned containers, broken
      // counters). Pending work is drained by the active runner's
      // finally → drainGroup, so skipping here is safe (no starvation).
      if (activeRunner) continue;
      if (!this.hasCapacityFor(jid)) continue;

      this.waitingGroups.delete(jid);
      const state = this.getGroup(jid);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        // Skip cancelled/deleted scheduled tasks (but allow dynamic tasks
        // like agent conversations that have no DB entry).
        let validTask: QueuedTask | undefined;
        while (state.pendingTasks.length > 0) {
          const candidate = state.pendingTasks.shift()!;
          const dbTask = getTaskById(candidate.id);
          if (dbTask && dbTask.status !== 'active') {
            logger.info(
              { groupJid: jid, taskId: candidate.id },
              'Skipping cancelled/deleted task during drainWaiting',
            );
            continue;
          }
          validTask = candidate;
          break;
        }
        if (validTask) {
          this.runTask(jid, validTask);
        } else if (state.pendingMessages && !state.retryTimer) {
          // All tasks were stale, fall through to messages
          // (skip if retry timer is pending to avoid duplicate processing)
          this.runForGroup(jid, 'drain');
        }
      } else if (state.pendingMessages && !state.retryTimer) {
        // Skip if retry timer is pending to avoid duplicate processing
        this.runForGroup(jid, 'drain');
      }
      // If neither pending, skip this group
    }
  }

  getStatus(): {
    activeCount: number;
    activeContainerCount: number;
    activeHostProcessCount: number;
    waitingCount: number;
    waitingGroupJids: string[];
    groups: Array<{
      jid: string;
      active: boolean;
      pendingMessages: boolean;
      pendingTasks: number;
      containerName: string | null;
      displayName: string | null;
      groupFolder: string | null;
      selectedProviderId: string | null;
    }>;
  } {
    const groups: Array<{
      jid: string;
      active: boolean;
      pendingMessages: boolean;
      pendingTasks: number;
      containerName: string | null;
      displayName: string | null;
      groupFolder: string | null;
      selectedProviderId: string | null;
    }> = [];

    for (const [jid, state] of this.groups) {
      groups.push({
        jid,
        active: state.active,
        pendingMessages: state.pendingMessages,
        pendingTasks: state.pendingTasks.length,
        containerName: state.containerName,
        displayName: state.displayName,
        groupFolder: state.groupFolder,
        selectedProviderId: state.selectedProviderId,
      });
    }

    return {
      activeCount: this.activeCount,
      activeContainerCount: this.activeContainerCount,
      activeHostProcessCount: this.activeHostProcessCount,
      waitingCount: this.waitingGroups.size,
      waitingGroupJids: Array.from(this.waitingGroups),
      groups,
    };
  }

  async shutdown(gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // 清除所有待执行的重试定时器，防止关闭期间容器重启
    for (const state of this.groups.values()) {
      this.clearRetryTimer(state);
    }

    logger.info(
      {
        activeCount: this.activeCount,
        activeContainerCount: this.activeContainerCount,
        gracePeriodMs,
      },
      'GroupQueue shutting down, waiting for containers',
    );

    // 主动写 _close sentinel：runForGroup 的 query() loop 一直在等 IPC 输入，
    // 没有 sentinel 就需要等到 grace 用完再被 SIGTERM/docker stop 强制结束。
    // 写入后 agent 看到 sentinel 自然 break loop、走 finally 清理、conversation
    // archive 完成。和 closeAllActiveForCredentialRefresh 的策略一致。
    for (const [, state] of this.groups) {
      if (!state.active || !state.groupFolder) continue;
      const inputDir = state.taskRunId
        ? path.join(
            DATA_DIR,
            'ipc',
            state.groupFolder,
            'tasks-run',
            state.taskRunId,
            'input',
          )
        : state.agentId
          ? path.join(
              DATA_DIR,
              'ipc',
              state.groupFolder,
              'agents',
              state.agentId,
              'input',
            )
          : path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
      try {
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(path.join(inputDir, '_close'), '');
      } catch {
        // best effort — fall back to SIGTERM/docker stop later
      }
    }

    // Wait for activeCount to reach zero or timeout
    const startTime = Date.now();
    while (this.activeCount > 0 && Date.now() - startTime < gracePeriodMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // If still active after grace period, force stop all containers
    if (this.activeCount > 0) {
      logger.warn(
        {
          activeCount: this.activeCount,
          activeContainerCount: this.activeContainerCount,
        },
        'Grace period expired, force stopping containers',
      );

      const stopPromises: Promise<void>[] = [];
      for (const [jid, state] of this.groups) {
        if (state.containerName) {
          const containerName = state.containerName;
          const promise = new Promise<void>((resolve) => {
            execFile(
              'docker',
              ['stop', '-t', '5', containerName],
              { timeout: 10000 },
              (err) => {
                if (err) {
                  logger.error(
                    { jid, containerName, err },
                    'Failed to stop container',
                  );
                }
                resolve();
              },
            );
          });
          stopPromises.push(promise);
        } else if (state.process && !state.process.killed) {
          const proc = state.process;
          const promise = new Promise<void>((resolve) => {
            if (!killProcessTree(proc, 'SIGTERM')) {
              resolve();
              return;
            }
            setTimeout(() => {
              if (proc.exitCode === null && proc.signalCode === null) {
                killProcessTree(proc, 'SIGKILL');
              }
              resolve();
            }, 3000);
          });
          stopPromises.push(promise);
        }
      }

      await Promise.all(stopPromises);
    }

    logger.info(
      { activeCount: this.activeCount },
      'GroupQueue shutdown complete',
    );
  }
}
