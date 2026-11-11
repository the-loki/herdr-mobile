// Small domain helpers shared by the components. The vocabulary matches
// GLOSSARY.md: a pane may host an agent, and the agent carries the status.

export const STATUS_ORDER = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };

export function statusRank(status) {
  return STATUS_ORDER[status] ?? 9;
}

export function worstStatus(panes) {
  return panes.map((pane) => pane.agent_status ?? 'unknown').sort((a, b) => statusRank(a) - statusRank(b))[0] ?? 'unknown';
}

export function tailPath(path, segments = 2) {
  if (!path) return '';
  return path.split('/').filter(Boolean).slice(-segments).join('/');
}

export function paneLabel(pane) {
  if (!pane) return '';
  return pane.title || pane.label || pane.agent || tailPath(pane.cwd, 1) || pane.id;
}

export function workspaceLabel(workspaces, workspaceId) {
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  return workspace?.label || workspaceId;
}

export function sortByAttention(a, b) {
  const byStatus = statusRank(a.agent_status) - statusRank(b.agent_status);
  if (byStatus !== 0) return byStatus;
  return paneLabel(a).localeCompare(paneLabel(b));
}
