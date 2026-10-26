// @ts-check
import { featureUi } from './feature-ui.js';
import { scopedNavigation, registerFeatureDestination } from './navigation-broker.js';
import { readLocation, navigateLocation, scopedLocation, subscribeLocation, hrefLocation } from './console-location.js';
import { featureInvoker } from './feature-transport.js';
import { updateWorkspaceFeatures } from './workspace-features.js';
import { clearSettings, showSettings } from './settings-panel.js';
export { mountWorkspaceFeatures } from './workspace-features.js';
/** @typedef {import('./types.js').Session} Session */
/** @typedef {{name:string,description:string,access:string}} Operation */
/** @typedef {{id:string,title:string,description:string,configured:boolean,status:'ready'|'unconfigured'|'unavailable',browserEntry:string,surfaces?:Array<'navigation'|'workspace'>,operations:Operation[]}} Feature */
const navigation = document.getElementById('feature-navigation'), tabs = document.getElementById('feature-tabs'), panels = document.getElementById('feature-panels'), base = document.getElementById('feature-workspaces');
if (!(navigation instanceof HTMLElement) || !(tabs instanceof HTMLElement) || !(panels instanceof HTMLElement) || !(base instanceof HTMLAnchorElement)) throw new Error('Missing feature navigation');
const nav = navigation, tabList = tabs, panelList = panels, baseLink = base;
let generation = 0, routeSequence = 0;
/** @type {Feature[]} */ let catalog = [];
/** @type {Session|null} */ let session = null;
/** @type {Array<()=>void>} */ const disposers = [];
/** @type {Map<string,{button:HTMLAnchorElement,section:HTMLElement,feature:Feature,mounted:boolean,mounting:Promise<boolean>|null,navigate:import('../plugin-api.js').WebFeatureNavigationHandler|null,message:HTMLElement,reconnect:HTMLButtonElement}>} */ const views = new Map();
export function clearFeaturePlugins() {
  generation++; routeSequence++; session = null; catalog = [];
  updateWorkspaceFeatures([], null); clearSettings();
  for (const dispose of disposers.splice(0)) dispose();
  views.clear(); tabList.replaceChildren(); panelList.replaceChildren(); nav.hidden = true; panelList.hidden = true;
  const unavailable = document.getElementById('route-unavailable'); if (unavailable) unavailable.hidden = true;
}
/** @param {Session} active */
export async function showFeaturePlugins(active) {
  clearFeaturePlugins(); session = active; const selected = generation;
  baseLink.hidden = !active.capabilities.operations;
  nav.hidden = false;
  try {
    const response = await fetch('/v1/extensions', { credentials: 'same-origin', signal: AbortSignal.timeout(10_000) });
    if (response.status === 401) { window.dispatchEvent(new Event('dim-session-expired')); return; }
    if (!response.ok) throw new Error('Feature catalog unavailable');
    /** @type {Feature[]} */ const features = await response.json(); if (selected !== generation) return;
    catalog = features; updateWorkspaceFeatures(features, active);
    for (const feature of features.filter((entry) => (entry.surfaces ?? ['navigation']).includes('navigation'))) {
      const button = document.createElement('a'); button.className = 'console-link'; button.href = hrefLocation(['features', feature.id]); button.textContent = feature.title;
      const section = document.createElement('section'); section.className = 'feature-page'; section.hidden = true;
      const heading = document.createElement('h1'); heading.textContent = feature.title; heading.tabIndex = -1;
      const description = document.createElement('p'); description.className = 'operations-intro'; description.textContent = feature.description;
      const connection = document.createElement('div'); connection.className = 'feature-connection';
      const reconnect = document.createElement('button'); reconnect.type = 'button'; reconnect.className = 'button button-secondary'; reconnect.textContent = 'Reconnect feature'; reconnect.hidden = !feature.configured;
      const message = document.createElement('p'); message.setAttribute('role', 'status'); connection.append(reconnect, message);
      section.append(heading, description, connection); panelList.append(section); tabList.append(button);
      const view = { button, section, feature, mounted: false, mounting: null, navigate: null, message, reconnect }; views.set(feature.id, view);
      disposers.push(registerFeatureDestination(feature.id, (target, current) => openNavigationFeature(feature.id, target, current)));
      reconnect.addEventListener('click', () => { void reconnectFeature(feature.id); });
    }
  } catch {
    if (selected !== generation) return;
    const message = document.getElementById('shell-message');
    if (message) message.textContent = 'Installed services could not be discovered. Workspaces remain available. Reload to retry service discovery.';
  }
  if (selected !== generation) return;
  disposers.push(subscribeLocation(() => { void applyRoute(); }));
  if (!readLocation().length) navigateLocation(active.capabilities.operations ? ['workspaces'] : views.size ? ['features', views.keys().next().value ?? ''] : ['settings'], true);
  await applyRoute();
}
async function applyRoute() {
  const active = session; if (!active) return;
  const sequence = ++routeSequence, path = readLocation();
  const operations = document.getElementById('operations-panel'), settings = document.getElementById('settings-panel'), unavailable = document.getElementById('route-unavailable');
  if (!operations || !settings || !unavailable) return;
  const workspace = path[0] === 'workspaces' && active.capabilities.operations;
  const view = path[0] === 'features' && path[1] ? views.get(path[1]) : undefined;
  const setting = path[0] === 'settings' && path.length <= 2 && (!path[1] || ['capabilities', 'access'].includes(path[1]));
  operations.hidden = !workspace; settings.hidden = !setting; panelList.hidden = !view;
  unavailable.hidden = Boolean(workspace || setting || view);
  baseLink.toggleAttribute('aria-current', workspace);
  if (workspace) baseLink.setAttribute('aria-current', 'page');
  document.getElementById('feature-settings')?.setAttribute('aria-current', setting ? 'page' : 'false');
  for (const [id, entry] of views) { entry.section.hidden = entry !== view; entry.button.setAttribute('aria-current', entry === view ? 'page' : 'false'); }
  document.title = `${workspace ? 'Workspaces' : setting ? 'Settings & access' : view?.feature.title ?? 'Page unavailable'} · DIM`;
  if (setting) showSettings(active, catalog, path[1] ?? 'capabilities');
  if (view) {
    await ensureFeatureMounted(view);
    if (sequence !== routeSequence) return;
  }
}
/** @param {NonNullable<ReturnType<typeof views.get>>} view */
async function ensureFeatureMounted(view) {
  const active = session, selected = generation;
  if (!active) return false;
  if (view.mounting) return view.mounting;
  if (view.mounted) return true;
  view.mounting = mountFeature(view, active, selected);
  const mounted = await view.mounting;
  if (selected === generation) view.mounting = null;
  return mounted;
}
/** @param {NonNullable<ReturnType<typeof views.get>>} view @param {Session} active @param {number} selected */
async function mountFeature(view, active, selected) {
  view.mounted = true; view.section.querySelector('.feature-load-error')?.remove();
  const content = document.createElement('div'); content.className = 'feature-content'; view.section.append(content);
  if (!view.feature.configured) {
    const heading = document.createElement('h2'); heading.textContent = 'Connection required';
    const copy = document.createElement('p'); copy.textContent = 'This feature is installed. An operator must configure its private server connection before it can be used here.';
    content.className = 'feature-content panel feature-empty'; content.append(heading, copy); return false;
  }
  if (view.feature.status === 'unavailable') {
    const message = document.createElement('p'); message.setAttribute('role', 'alert'); message.textContent = 'This feature connection is unavailable. Use Reconnect feature to retry; workspaces and other connected features remain available.';
    content.append(message); return false;
  }
  if (!view.feature.operations.length) { content.textContent = 'This connection does not provide any operations for your account. Ask an operator to check its assigned permissions.'; return false; }
  try {
    const plugin = await import(view.feature.browserEntry);
    if (selected !== generation) return false;
    if (typeof plugin.mount !== 'function') throw new Error('Feature UI entrypoint is unavailable');
    const dispose = await plugin.mount(content, {
      operations: view.feature.operations, ui: featureUi, navigation: scopedNavigation(() => selected === generation),
      location: scopedLocation(['features', view.feature.id], () => selected === generation),
      onNavigate(/** @type {import('../plugin-api.js').WebFeatureNavigationHandler} */ handler) { view.navigate = handler; return () => { if (view.navigate === handler) view.navigate = null; }; },
      isCurrent: () => selected === generation, invoke: featureInvoker(view.feature, active, () => selected === generation)
    });
    content.dataset.pluginMounted = 'true';
    if (typeof dispose === 'function') { if (selected === generation) disposers.push(dispose); else dispose(); }
    return selected === generation;
  } catch {
    if (selected !== generation) return false;
    const message = document.createElement('p'); message.className = 'feature-load-error'; message.setAttribute('role', 'alert'); message.textContent = 'This feature could not load. Try opening it again; workspaces remain available.';
    view.mounted = false; content.remove(); view.section.append(message); return false;
  }
}
/** @param {string} id @param {unknown} target @param {()=>boolean} current @returns {Promise<import('../plugin-api.js').WebNavigationResult>} */
async function openNavigationFeature(id, target, current) {
  const view = views.get(id);
  if (!view) return { status: 'unavailable', code: 'not-installed', message: 'This feature is not installed in navigation.' };
  if (!view.feature.configured || view.feature.status !== 'ready' || !view.feature.operations.length) return { status: 'unavailable', code: view.feature.status === 'unavailable' ? 'not-ready' : 'not-authorized', message: 'This feature is not available to the current session.' };
  if (!await ensureFeatureMounted(view)) return { status: 'unavailable', code: 'load-failed', message: 'This feature could not load.' };
  if (!current()) return { status: 'unavailable', code: 'session-ended', message: 'This navigation request ended with the browser session.' };
  if (!view.navigate) return { status: 'unavailable', code: 'not-ready', message: 'This feature does not accept related-object navigation.' };
  const result = await view.navigate(target, current);
  if (current() && result.status !== 'unavailable' && view.section.hidden) {
    if (readLocation()[1] !== id) navigateLocation(['features', id]);
    await applyRoute();
  }
  return result;
}
/** @param {string} id */
async function reconnectFeature(id) {
  const view = views.get(id), active = session, selected = generation;
  if (!view || !active || view.reconnect.disabled) return;
  view.reconnect.disabled = true; view.message.textContent = 'Reconnecting…'; view.message.setAttribute('role', 'status');
  try {
    const response = await fetch(`/v1/extensions/${id}/reconnect`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-dim-csrf': active.csrfToken }, body: '{}', signal: AbortSignal.timeout(35_000) });
    if (selected !== generation) return;
    if (response.status === 401) window.dispatchEvent(new Event('dim-session-expired'));
    if (!response.ok) throw new Error('reconnect failed');
    /** @type {Feature} */ const fresh = await response.json();
    if (!fresh || fresh.id !== id) throw new Error('unexpected feature');
    if (view.mounting) await view.mounting;
    if (selected !== generation) return;
    const operations = view.feature.operations; operations.splice(0, operations.length, ...fresh.operations);
    view.feature = { ...fresh, operations }; catalog = catalog.map((entry) => entry.id === id ? view.feature : entry);
    if (fresh.status !== 'ready') throw new Error('connection unavailable');
    view.message.textContent = 'Connection refreshed. Refresh this feature to load current data; your form input is kept.';
    if (!view.section.querySelector('[data-plugin-mounted="true"]')) {
      view.section.querySelector('.feature-content')?.remove(); view.section.querySelector('.feature-load-error')?.remove(); view.mounted = false;
      if (!await ensureFeatureMounted(view) || !view.section.querySelector('[data-plugin-mounted="true"]')) throw new Error('feature mount unavailable');
    }
  } catch {
    if (selected !== generation) return;
    view.message.setAttribute('role', 'alert'); view.message.textContent = 'Connection is still unavailable. Ask an operator to check its service, credentials and configured scope, then retry.';
  } finally { view.reconnect.disabled = false; }
}
export function showWorkspaceView() {
  if (session?.capabilities.operations) navigateLocation(['workspaces']);
}
