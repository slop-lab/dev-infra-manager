// @ts-check
import { featureUi } from './feature-ui.js';
import { scopedNavigation } from './navigation-broker.js';
import { featureInvoker } from './feature-transport.js';
import { scopedLocation } from './console-location.js';
/** @type {import('./feature-panels.js').Feature[]} */ let catalog = [];
/** @type {import('./types.js').Session|null} */ let session = null;
/** @type {Set<()=>void>} */ const mounts = new Set();
/** @param {import('./feature-panels.js').Feature[]} features @param {import('./types.js').Session|null} active */
export function updateWorkspaceFeatures(features, active) {
  catalog = features; session = active;
  for (const refresh of mounts) refresh();
}
/** @param {HTMLElement} container @param {{hostId:string,name:string,id:string,phase:string}} workspace @param {()=>boolean} active @param {()=>Promise<boolean>} refreshWorkspace */
export function mountWorkspaceFeatures(container, workspace, active, refreshWorkspace) {
  let revision = 0, disposed = false, phase = workspace.phase, phaseRevision = 0;
  const target = { ...workspace, get phase() { return phase; } };
  /** @type {Set<()=>void>} */ const changes = new Set();
  /** @type {Array<()=>void>} */ let cleanup = [];
  function refresh() {
    const selected = ++revision, currentSession = session;
    container.dataset.catalogReady = String(currentSession !== null);
    /** @type {Map<string,HTMLDetailsElement>} */ const sections = new Map();
    for (const dispose of cleanup) dispose(); cleanup = []; container.replaceChildren();
    if (disposed || !active() || !currentSession) return;
    for (const feature of catalog.filter((entry) => (entry.surfaces ?? ['navigation']).includes('workspace'))) {
      const details = document.createElement('details'), summary = document.createElement('summary'), content = document.createElement('div');
      summary.textContent = feature.title; details.className = 'workspace-feature'; details.dataset.featureId = feature.id;
      content.className = 'feature-form'; details.append(summary, content); container.append(details); sections.set(feature.id, details);
      let mounted = false;
      const current = () => !disposed && active() && selected === revision && session === currentSession;
      details.addEventListener('toggle', () => {
        if (!details.open || mounted || !current()) return; mounted = true;
        if (feature.status !== 'ready') { content.textContent = 'This host feature is unavailable. Ask an operator to check the installed host plugin and reconnect the Web service.'; return; }
        if (!feature.operations.length) { content.textContent = 'This account has no operations for this feature.'; return; }
        void (async () => {
          try {
            const plugin = await import(feature.browserEntry); if (!current()) return;
            if (typeof plugin.mount !== 'function') throw new Error('Missing workspace feature entrypoint');
            const invoke = featureInvoker(feature, currentSession, current);
            const dispose = await plugin.mount(content, { workspace: target, refreshWorkspace, operations: feature.operations, ui: featureUi, navigation: scopedNavigation(current), location: scopedLocation(['workspaces', workspace.hostId, workspace.id], current), onNavigate() { return () => {}; }, isCurrent: current,
              onWorkspaceChange(/** @type {()=>void} */ handler) { changes.add(handler); const disposeChange = () => changes.delete(handler); cleanup.push(disposeChange); return disposeChange; },
              async invoke(/** @type {string} */ name, /** @type {unknown} */ input, /** @type {import('../plugin-api.js').WebPluginInvokeOptions} */ options) { const atStart = phaseRevision; const result = await invoke(name, input, options); if (atStart !== phaseRevision) throw Object.assign(new Error('The workspace runtime changed while this operation was pending. Check current state before retrying.'), { outcome: 'unknown' }); return result; },
              openFeature(/** @type {string} */ id) { const target = sections.get(id); if (!current() || !target) return false; target.open = true; target.querySelector('summary')?.focus(); return true; } });
            if (typeof dispose === 'function') { if (current()) cleanup.push(dispose); else dispose(); }
          } catch { if (current()) { mounted = false; content.textContent = 'This workspace feature could not load. Close and reopen this section to retry; other workspace controls remain available.'; } }
        })();
      });
    }
    window.dispatchEvent(new Event('dim-workspace-features-ready'));
  }
  mounts.add(refresh); refresh();
  return Object.assign(() => { disposed = true; revision++; mounts.delete(refresh); for (const dispose of cleanup) dispose(); changes.clear(); container.replaceChildren(); }, {
    update(/** @type {string} */ nextPhase) { if (phase === nextPhase || disposed) return; phase = nextPhase; phaseRevision++; for (const handler of changes) handler(); }
  });
}
