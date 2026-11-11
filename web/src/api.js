// Thin client for the plugin's own HTTP API. Every call is same-origin and
// authenticated by the pairing cookie the server set when the link was opened.

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(payload?.error?.message ?? `request failed (${response.status})`, response.status, payload?.error?.code);
  }
  return payload;
}

export const api = {
  state: () => request('/api/state'),
  health: () => request('/api/health'),
  paneText: (paneId, { source = 'visible', lines } = {}) => {
    const query = new URLSearchParams({ source });
    if (lines) query.set('lines', String(lines));
    return request(`/api/pane/${encodeURIComponent(paneId)}?${query}`);
  },
  transcript: (paneId, { before, limit } = {}) => {
    const query = new URLSearchParams();
    if (before !== undefined) query.set('before', String(before));
    if (limit) query.set('limit', String(limit));
    const suffix = query.toString() ? `?${query}` : '';
    return request(`/api/pane/${encodeURIComponent(paneId)}/transcript${suffix}`);
  },
  input: (paneId, { text, submit }) =>
    request(`/api/pane/${encodeURIComponent(paneId)}/input`, { method: 'POST', body: { text, submit } }),
  keys: (paneId, keys) => request(`/api/pane/${encodeURIComponent(paneId)}/keys`, { method: 'POST', body: { keys } }),
  focus: (paneId) => request(`/api/pane/${encodeURIComponent(paneId)}/focus`, { method: 'POST', body: {} }),
  renamePane: (paneId, label) =>
    request(`/api/pane/${encodeURIComponent(paneId)}/rename`, { method: 'POST', body: { label } }),
  closePane: (paneId) => request(`/api/pane/${encodeURIComponent(paneId)}/close`, { method: 'POST', body: {} }),
  splitPane: (paneId, direction, command) =>
    request('/api/panes/split', { method: 'POST', body: { pane_id: paneId, direction, command: command || undefined } }),
  newWorkspace: ({ label, cwd }) =>
    request('/api/workspaces', { method: 'POST', body: { label: label || undefined, cwd: cwd || undefined } }),
  closeWorkspace: (workspaceId) =>
    request(`/api/workspaces/${encodeURIComponent(workspaceId)}/close`, { method: 'POST', body: {} }),
  newTab: (workspaceId, label) =>
    request('/api/tabs', { method: 'POST', body: { workspace_id: workspaceId, label: label || undefined } }),
  closeTab: (tabId) => request(`/api/tabs/${encodeURIComponent(tabId)}/close`, { method: 'POST', body: {} }),
};
