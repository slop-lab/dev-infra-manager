// @ts-check

/** @typedef {{endpoint:string,directory:string}} WorkspaceTarget */
export const openCodeWebClient = 'https://slop-lab.github.io/dev-infra-manager/opencode-web/';

/** @param {unknown} input @returns {string|undefined} */
export function normalizeWorkspaceEndpoint(input) {
  if (typeof input !== 'string' || input.length > 4096 || !/^https?:\/\//.test(input) || /[\x00-\x20\x7f\\?#]/.test(input)) return;
  try {
    const url = new URL(input);
    if (url.username || url.password || !url.hostname) return;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return;
    const start = input.indexOf('/', input.indexOf('://') + 3);
    const path = decodeURIComponent(start === -1 ? '' : input.slice(start));
    if (/[\x00-\x1f\x7f\\]/.test(path) || path.split('/').some(part => part === '.' || part === '..')) return;
    const endpoint = url.href.replace(/\/+$/, '');
    return endpoint.length <= 4096 ? endpoint : undefined;
  } catch { return; }
}

/** @param {unknown} input @returns {input is string} */
export function isWorkspaceDirectory(input) {
  return typeof input === 'string' && input.length <= 4096 && (input === '/workspace' || input.startsWith('/workspace/'))
    && !/[\x00-\x1f\x7f\\]/.test(input) && input.slice(1).split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

/** @param {WorkspaceTarget} target @returns {string|undefined} */
export function buildWorkspaceClientLink(target) {
  const endpoint = normalizeWorkspaceEndpoint(target.endpoint);
  if (!endpoint || !isWorkspaceDirectory(target.directory)) return;
  const url = new URL(openCodeWebClient);
  url.hash = `/dim/open?${new URLSearchParams({ server: endpoint, directory: target.directory })}`;
  return url.href;
}

/** @param {string} hash @returns {WorkspaceTarget|undefined} */
export function parseWorkspaceClientLink(hash) {
  const prefix = '#/dim/open?';
  if (hash.length > 65_536 || !hash.startsWith(prefix)) return;
  const query = hash.slice(prefix.length);
  try { decodeURIComponent(query.replace(/\+/g, ' ')); } catch { return; }
  const params = new URLSearchParams(query);
  if ([...params.keys()].length !== 2 || params.getAll('server').length !== 1 || params.getAll('directory').length !== 1) return;
  const endpoint = normalizeWorkspaceEndpoint(params.get('server')), directory = params.get('directory');
  if (!endpoint || !isWorkspaceDirectory(directory)) return;
  return { endpoint, directory };
}
