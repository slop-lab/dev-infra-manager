// @ts-check
/** @typedef {import('@slop-lab/dim-web/plugin-api').WebPluginBrowserContext} Context */
/** @typedef {{name:string,description:string,access:"read"|"operator"|"reviewer"}} Descriptor */
/** @typedef {{id:string,controllerKey:string,title:string,status:'ready'|'unavailable',operations:Descriptor[]}} Controller */
/** @typedef {(()=>void)&{canLeave:()=>boolean,isSaving:()=>boolean}} MountedRouter */
/** @param {HTMLElement} container @param {Context} context @param {(container:HTMLElement,context:Context)=>MountedRouter} mountSelected */
export function mountRouterControllers(container, context, mountSelected) {
  const { ui } = context;
  let alive = true, revision = 0, discoveryRevision = 0, edits = 0;
  /** @type {Controller[]} */ let controllers = [];
  /** @type {Controller|undefined} */ let selected;
  /** @type {MountedRouter|undefined} */ let panel;
  /** @type {Parameters<Context['onNavigate']>[0]|undefined} */ let navigate;
  const current = () => alive && context.isCurrent();
  const toolbar = ui.element('div', '', 'feature-actions'), feedback = ui.element('p'), content = ui.element('div');
  const picker = ui.select(toolbar, 'Router controller', []), refresh = ui.button('Refresh router controllers'); toolbar.append(refresh);
  container.append(toolbar, feedback, content);
  content.addEventListener("input", () => { edits++; }); content.addEventListener("change", () => { edits++; });
  function mayLeave() {
    if (panel?.isSaving()) { ui.feedback(feedback, 'Wait for the current routing policy save before changing controllers.'); return false; }
    return !panel || panel.canLeave() || window.confirm('Discard unsaved router changes and switch controllers?');
  }
  /** @param {Controller|undefined} controller @param {boolean} [confirmed] */
  function choose(controller, confirmed = false) {
    if (selected?.id === controller?.id && panel && controller?.status === 'ready') return true;
    if (!confirmed && !mayLeave()) { picker.value = selected?.id ?? ''; return false; }
    ++revision; panel?.(); panel = undefined; navigate = undefined; selected = controller; content.replaceChildren();
    picker.value = controller?.id ?? '';
    if (!controller || controller.status !== 'ready') { content.append(ui.element('p', controller ? 'LLM router is unavailable on this controller. Select its trusted operator connection with dim llm-router connect, then reconnect this feature.' : 'No router controllers are configured.')); return true; }
    const scope = revision, scoped = () => current() && scope === revision;
    panel = mountSelected(content, { ...context,
      operations: controller.operations.filter((operation) => context.operations.some((known) => known.name === operation.name && known.access === operation.access)),
      isCurrent: scoped,
      invoke(name, input = {}, options) {
        if (!scoped()) return Promise.reject(new Error('Router controller selection changed'));
        return context.invoke(name, { .../** @type {Record<string,unknown>} */ (input), controllerId: controller.id }, options);
      },
      navigation: { ...context.navigation, openFeature(feature, target) {
        return context.navigation.openFeature(feature, feature === 'llm-router' && target && typeof target === 'object' && !Array.isArray(target) ? { ...target, controllerKey: controller.controllerKey } : target);
      } },
      onNavigate(handler) { navigate = handler; return () => { if (navigate === handler) navigate = undefined; }; }
    });
    return true;
  }
  picker.addEventListener('change', () => { const next = controllers.find(({ id }) => id === picker.value); choose(next); });
  async function discover() {
    if (!mayLeave()) return;
    const request = ++discoveryRevision, scopeAtStart = revision, editsAtStart = edits;
    refresh.disabled = true; picker.disabled = true; ui.feedback(feedback, 'Discovering router controllers…');
    try {
      const value = /** @type {{controllers:Controller[]}} */ (await context.invoke('controllers.list', {}));
      if (!current() || request !== discoveryRevision || revision !== scopeAtStart) return;
      if (edits !== editsAtStart && !mayLeave()) return;
      controllers = value.controllers;
      picker.replaceChildren(); for (const controller of controllers) { const option = document.createElement('option'); option.value = controller.id; option.textContent = `${controller.title}${controller.status === 'ready' ? '' : ' (unavailable)'}`; picker.append(option); }
      const next = controllers.find(({ id }) => id === selected?.id) ?? controllers.find(({ status }) => status === 'ready') ?? controllers[0];
      // Re-discovery refreshes capability declarations and fences the previous panel's reads.
      ++revision; panel?.(); panel = undefined; navigate = undefined;
      choose(next, true); ui.feedback(feedback, 'Router controllers refreshed.');
    } catch { if (current() && request === discoveryRevision) ui.feedback(feedback, 'Could not discover router controllers. Current drafts are kept; retry discovery.', 'error'); }
    finally { if (current() && request === discoveryRevision) { refresh.disabled = false; picker.disabled = false; } }
  }
  refresh.addEventListener('click', () => { void discover(); });
  const loading = discover();
  const disposeNavigation = context.onNavigate(async (target, isCurrent) => {
    await loading;
    if (!current() || !isCurrent()) return { status: 'unavailable', code: 'session-ended', message: 'The router navigation request is no longer current.' };
    if (!target || typeof target !== 'object' || Array.isArray(target) || !('kind' in target) || target.kind !== 'project' || !('projectId' in target) || typeof target.projectId !== 'string'
      || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(target.projectId) || Object.keys(target).some((key) => !['kind', 'projectId', 'controllerKey'].includes(key))
      || ('controllerKey' in target && typeof target.controllerKey !== 'string')) return { status: 'unavailable', code: 'invalid-target', message: 'The routing project target is invalid.' };
    if (!('controllerKey' in target) && controllers.filter(({ status }) => status === 'ready').length > 1) return { status: 'unavailable', code: 'invalid-target', message: 'This routing project target must identify its router controller.' };
    const controller = 'controllerKey' in target ? controllers.find(({ controllerKey }) => controllerKey === target.controllerKey) : selected;
    if (!controller || controller.status !== 'ready') return { status: 'unavailable', code: 'target-unavailable', message: 'The requested router controller is unavailable.' };
    if (controller.id !== selected?.id) {
      const scope = revision;
      try {
        const projects = /** @type {Array<{id:string}>} */ (await context.invoke('projects', { controllerId: controller.id }));
        if (!current() || !isCurrent() || scope !== revision) return { status: 'unavailable', code: 'session-ended', message: 'The router navigation request is no longer current.' };
        if (!projects.some(({ id }) => id === target.projectId)) return { status: 'unavailable', code: 'target-unavailable', message: 'The routing project is unavailable on the requested controller.' };
      } catch { return { status: 'unavailable', code: 'load-failed', message: 'The routing project could not be discovered on the requested controller.' }; }
      if (!choose(controller)) return { status: 'blocked', message: 'Kept unsaved router changes on the selected controller.' };
    }
    if (!navigate) return { status: 'unavailable', code: 'target-unavailable', message: 'The requested router controller is unavailable.' };
    const scope = revision;
    return navigate({ kind: 'project', projectId: target.projectId }, () => current() && isCurrent() && scope === revision);
  });
  return () => { alive = false; ++revision; ++discoveryRevision; panel?.(); disposeNavigation(); };
}
