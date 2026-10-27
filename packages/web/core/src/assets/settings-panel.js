// @ts-check
import { featureUi as ui } from './feature-ui.js';
import { hrefLocation } from './console-location.js';
/** @type {import('./types.js').Session|null} */ let session = null;
/** @type {HTMLElement|null} */ let content = null;
export function clearSettings() {
  session = null; content = null;
  document.getElementById('settings-panel')?.replaceChildren();
}
/** @param {import('./types.js').Session} active @param {import('./feature-panels.js').Feature[]} catalog @param {{section:string,reconnect:(id:string)=>Promise<boolean>}} task */
export function showSettings(active, catalog, task) {
  const {section,reconnect} = task;
  const root = document.getElementById('settings-panel'); if (!root) return;
  if (session !== active) {
    session = active;
    const heading = ui.element('h1', 'Settings & access');
    const intro = ui.element('p', 'Inspect this console’s connections and permissions. Service credentials and host configuration remain with their owners.', 'operations-intro');
    const nav = ui.element('nav', '', 'section-navigation'); nav.setAttribute('aria-label', 'Settings sections');
    for (const [path, label] of [['capabilities', 'Capabilities & connections'], ['access', 'Account & access']]) {
      const link = ui.element('a', label); link.href = hrefLocation(['settings', path ?? '']); nav.append(link);
    }
    content = ui.element('div', '', 'settings-content'); root.append(heading, intro, nav, content);
  }
  if (!content) return;
  root.querySelectorAll('nav a').forEach((link) => link.setAttribute('aria-current', link.getAttribute('href') === hrefLocation(['settings', section]) ? 'page' : 'false'));
  const existing = content.querySelector(`[data-settings-section="${section}"]`);
  content.querySelectorAll('[data-settings-section]').forEach((entry) => { if (entry instanceof HTMLElement) entry.hidden = entry !== existing; });
  if (existing && section === 'access') return;
  existing?.remove();
  const panel = ui.element('section', '', 'settings-section'); panel.dataset.settingsSection = section; content.append(panel);
  if (section === 'access') {
    panel.append(ui.element('h2', 'Account & access'), ui.element('p', `Signed in as ${active.username}. Browser roles: ${active.roles.join(', ')}.`), ui.element('p', 'Browser roles and service authority are independent. Account administration requires account-admin access and your current password.'));
    const access = ui.button('Manage account & access'); access.addEventListener('click', () => window.dispatchEvent(new Event('dim-account-access'))); panel.append(access); return;
  }
  panel.append(ui.element('h2', 'Installed Web capabilities'), ui.element('p', 'Installation, feature readiness and your account’s permissions are separate. Open a capability to inspect its individual service connections; a ready feature does not prove worker connectivity or provider reachability.', 'field-hint'));
  const features = ui.element('div', '', 'capability-list'); panel.append(features);
  for (const feature of catalog) {
    const row = ui.element('article', '', 'capability-row');
    const title = ui.element('h3', feature.title), state = ui.element('span', feature.status === 'ready' ? 'Feature ready' : feature.status === 'unavailable' ? 'Connection unavailable' : 'Connection required', `badge ${feature.status === 'ready' ? 'badge-approved' : 'badge-pending'}`);
    row.append(title, state, ui.element('p', feature.description), ui.element('p', `${feature.operations.length} operation${feature.operations.length === 1 ? '' : 's'} available to this account.`, 'field-hint'));
    const link = ui.element('a', (feature.surfaces ?? ['navigation']).includes('workspace') ? 'Open a workspace to use this capability' : `Open ${feature.title}`);
    link.href = hrefLocation((feature.surfaces ?? ['navigation']).includes('workspace') ? ['workspaces'] : ['features', feature.id]); row.append(link); features.append(row);
    if (feature.configured && active.roles.includes('operator')) {
      const retry = ui.button(`Reconnect ${feature.title}`), feedback = ui.element('p'); feedback.setAttribute('role','status');
      retry.addEventListener('click', () => { if (retry.disabled) return; retry.disabled = true; feedback.textContent = 'Reattesting this fixed connection…'; void reconnect(feature.id).then((ready) => { if (!row.isConnected) return; feedback.textContent = ready ? 'Connection reattested. Open the capability or refresh its state; existing drafts were kept.' : 'Connection is still unavailable. Ask the operator to inspect its service and private scope, then retry.'; state.textContent = ready ? 'Feature ready' : 'Connection unavailable'; state.className = `badge ${ready ? 'badge-approved' : 'badge-pending'}`; }).finally(() => { retry.disabled = false; }); }); row.append(retry,feedback);
    } else if (feature.configured && feature.status === 'unavailable') row.append(ui.element('p', 'A browser operator must reconnect this fixed private connection.', 'field-hint'));
  }
  if (!catalog.length) features.append(ui.element('p', 'No optional Web capabilities were discovered. If services were expected, reload this console or ask its owner to check the selected Web plugins.'));
  const hosts = ui.element('section', '', 'settings-section');
  hosts.append(ui.element('h2', 'Development hosts'), ui.element('p', active.capabilities.operations ? 'Workspace tasks use the configured local or SSH-selected hosts. Availability is shown independently on Workspaces.' : 'This console has no configured workspace operations. Its owner must add trusted hosts to the private server configuration.'));
  const hostLink = ui.element('a', 'Open Workspaces'); hostLink.href = hrefLocation(['workspaces']); if (active.capabilities.operations) hosts.append(hostLink);
  panel.append(hosts);
  const secondary = ui.element('section', '', 'settings-section');
  secondary.append(ui.element('h2', 'Host-owned runtime & network capabilities'), ui.element('p', 'The host’s installed plugins determine these capabilities. This Web catalog does not prove they are installed, configured or reachable. Inspect them on the selected host with the public CLI.'));
  const commands = ui.element('pre', 'dim --host HOST plugins\ndim --host HOST doctor'); secondary.append(commands);
  const list = ui.element('dl', '', 'capability-definitions');
  for (const [name, detail] of [
    ['VM & KVM', 'VM runtimes and auxiliary VM consoles require explicit host setup and reviewed images. Workspace creation exposes supported runtime/image selection; it does not initialize a VM host.'],
    ['Package caches & mirrors', 'cache-server owns persistent cache services. mirrors configures workspace clients and scoped public-package relays; it is not a general proxy or network isolation.'],
    ['Tailnet & tunnels', 'Tailscale, tunnels and External URLs retain host-owned grants and ingress. Approved service routes do not grant host administration.'],
    ['Images, shell & sessions', 'Image builds, interactive shells and agent session continuation use the public CLI or installed client. This console does not expose arbitrary host command execution.']
  ]) { const group = ui.element('div'); group.append(ui.element('dt', name), ui.element('dd', detail)); list.append(group); }
  secondary.append(list); panel.append(secondary);
}
