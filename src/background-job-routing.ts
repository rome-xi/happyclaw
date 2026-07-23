export interface BackgroundJobRouteGroup {
  folder: string;
  target_main_jid?: string;
  target_agent_id?: string;
}

interface ResolveBackgroundJobWorkspaceJidOptions {
  stampedJid?: string;
  expectedFolder: string;
  getGroup: (jid: string) => BackgroundJobRouteGroup | undefined;
  getAgentChatJid: (agentId: string) => string | null | undefined;
  resolveWorkspaceJid: (jid: string) => string | null;
}

function stripVirtualSuffix(jid: string): string {
  const match = jid.match(/#(?:agent|task):/);
  return match?.index === undefined ? jid : jid.slice(0, match.index);
}

/**
 * Resolve the canonical web JID that owns a background job.
 *
 * MCP requests are stamped with the latest source JID, which can be an IM
 * group/topic bound to a workspace rather than the workspace JID itself.
 * Folder-only guesses (`web:${folder}`) are legacy aliases and are not valid
 * for UUID-backed non-home workspaces, so every candidate is canonicalized and
 * checked against the expected execution folder before it is accepted.
 */
export function resolveBackgroundJobWorkspaceJid(
  opts: ResolveBackgroundJobWorkspaceJidOptions,
): string | null {
  const candidates: string[] = [];
  const addCandidate = (jid?: string | null): void => {
    if (jid && !candidates.includes(jid)) candidates.push(jid);
  };

  if (opts.stampedJid) {
    const stampedBaseJid = stripVirtualSuffix(opts.stampedJid);
    const stampedGroup = opts.getGroup(stampedBaseJid);

    if (stampedGroup?.target_agent_id) {
      addCandidate(opts.getAgentChatJid(stampedGroup.target_agent_id));
    }
    addCandidate(stampedGroup?.target_main_jid);

    // A direct web source (including a legacy web:<folder> alias) may be the
    // workspace itself. Non-web IM sources are only accepted via bindings.
    if (
      stampedBaseJid.startsWith('web:') ||
      stampedGroup?.folder === opts.expectedFolder
    ) {
      addCandidate(stampedBaseJid);
    }
  }

  // Compatibility for requests created before source-JID stamping existed.
  addCandidate(`web:${opts.expectedFolder}`);

  for (const candidate of candidates) {
    const canonicalJid = opts.resolveWorkspaceJid(candidate);
    if (!canonicalJid?.startsWith('web:')) continue;
    const canonicalGroup = opts.getGroup(canonicalJid);
    if (canonicalGroup?.folder === opts.expectedFolder) {
      return canonicalJid;
    }
  }

  return null;
}
