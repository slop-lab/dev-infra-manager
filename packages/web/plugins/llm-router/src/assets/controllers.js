// @ts-check
/** @typedef {import('@slop-lab/dim-web/plugin-api').WebPluginBrowserContext} Context */
/** @typedef {{name:string,description:string,access:"read"|"operator"|"reviewer"}} Descriptor */
/** @typedef {{id:string,controllerKey:string,title:string,status:'ready'|'unavailable',operations:Descriptor[]}} Controller */
/** @typedef {(()=>void)&{canLeave:()=>boolean,isSaving:()=>boolean,hasUnknown:()=>boolean,hasPending:()=>boolean}} MountedRouter */
/** @typedef {import('@slop-lab/dim-web/plugin-api').WebPluginLocation} Location */
/** @param {HTMLElement} container @param {Context} context @param {(container:HTMLElement,context:Context)=>MountedRouter} mountSelected */
export function mountRouterControllers(container, context, mountSelected) {
  const { ui } = context;
  let alive = true, revision = 0, discoveryRevision = 0, edits = 0;
  /** @type {Controller[]} */ let controllers = [];
  /** @type {Controller|undefined} */ let selected;
  /** @type {MountedRouter|undefined} */ let panel;
  /** @type {Parameters<Context['onNavigate']>[0]|undefined} */ let navigate;
  /** @type {readonly string[]} */ let acceptedPath = [];
  const current = () => alive && context.isCurrent();
  const toolbar = ui.element('div', '', 'feature-actions'), feedback = ui.element('p'), content = ui.element('div');
  const picker = ui.select(toolbar, 'Router controller', []), refresh = ui.button('Refresh router controllers'); toolbar.append(refresh);
  const scopeIdentity = ui.element('p', '', 'llm-scope'); container.append(toolbar, scopeIdentity, feedback, content);
  content.addEventListener("input", () => { edits++; }); content.addEventListener("change", () => { edits++; });
  function mayLeave() {
    if (panel?.hasUnknown()) { ui.feedback(feedback, 'Cannot change or rediscover router controllers while a router write has an unknown outcome. Use Refresh router for authoritative recovery; an unknown provider sign-in start may require the router operator to inspect the pending login or this Web session to end.', 'error'); return false; }
    if (panel?.isSaving() || panel?.hasPending()) { ui.feedback(feedback, 'Wait for the current router operation before changing controllers.'); return false; }
    return !panel || panel.canLeave() || window.confirm('Discard unsaved router changes and switch controllers?');
  }
  /** @param {readonly string[]} path @param {string} controllerKey */
  function globalPath(path, controllerKey) {
    const [section = 'accounts', ...rest] = path;
    return [section, controllerKey, ...rest];
  }
  /** @param {readonly string[]} path @param {string} controllerKey */
  function localPath(path, controllerKey) {
    if (!path.length) return [];
    const [section = 'accounts', selectedController, ...rest] = path;
    return selectedController === controllerKey ? [section, ...rest] : ['invalid'];
  }
  /** @param {Location|undefined} location @param {string} controllerKey @returns {Location|undefined} */
  function scopedLocation(location, controllerKey) {
    if (!location) return undefined;
    return {
      get revision() { return location.revision; },
      get path() { return localPath(location.path, controllerKey); },
      href: (path) => location.href(globalPath(path, controllerKey)),
      navigate: (path, options) => location.navigate(globalPath(path, controllerKey), options),
      subscribe(handler) { return location.subscribe((path) => { if (path[1] === controllerKey) handler(localPath(path, controllerKey)); }); }
    };
  }
  /** @param {Controller|undefined} controller @param {boolean} [confirmed] */
  function choose(controller, confirmed = false) {
    if (selected?.id === controller?.id && panel && controller?.status === 'ready') return true;
    if (!confirmed && !mayLeave()) { picker.value = selected?.id ?? ''; return false; }
    ++revision; panel?.(); panel = undefined; navigate = undefined; selected = controller; content.replaceChildren();
    picker.value = controller?.id ?? '';
    if (!controller || controller.status !== 'ready') { scopeIdentity.textContent = controller ? `Router authority: ${controller.title} · unavailable` : 'Router authority: unavailable'; content.append(ui.element('p', controller ? 'LLM router is unavailable on this controller. Select its trusted operator connection with dim llm-router connect, then reconnect this feature.' : 'The requested router controller is unavailable or missing from this location. Select a configured controller explicitly; no other authority was selected.')); return true; }
    const scopeRevision = revision, scoped = () => current() && scopeRevision === revision;
    const location = scopedLocation(context.location, controller.controllerKey);
    scopeIdentity.textContent = `Router authority: ${controller.title} · ${controller.controllerKey}`;
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
      ...(location ? { location } : {}),
      onNavigate(handler) { navigate = handler; return () => { if (navigate === handler) navigate = undefined; }; }
    });
    return true;
  }
  picker.addEventListener('change', () => {
    const next = controllers.find(({ id }) => id === picker.value);
    if (!choose(next) || !next || !context.location) return;
    context.location.navigate(globalPath(['accounts'], next.controllerKey));
  });
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
      const ready = controllers.filter(({ status }) => status === 'ready'), path = context.location?.path ?? [];
      const next = path.length ? controllers.find(({ controllerKey }) => controllerKey === path[1]) : controllers.find(({ id }) => id === selected?.id) ?? ready[0] ?? controllers[0];
      // Re-discovery refreshes capability declarations and fences the previous panel's reads.
      ++revision; panel?.(); panel = undefined; navigate = undefined;
      choose(next, true); acceptedPath = path.length ? path : next ? globalPath(['accounts'], next.controllerKey) : []; ui.feedback(feedback, 'Router controllers refreshed.');
    } catch { if (current() && request === discoveryRevision) ui.feedback(feedback, 'Could not discover router controllers. Current drafts are kept; retry discovery.', 'error'); }
    finally { if (current() && request === discoveryRevision) { refresh.disabled = false; picker.disabled = false; } }
  }
  refresh.addEventListener('click', () => { void discover(); });
  const loading = discover();
  const disposeLocation = context.location?.subscribe((path) => {
    if (!controllers.length) return;
    const controller = path.length ? controllers.find(({ controllerKey }) => controllerKey === path[1]) : selected ?? controllers.find(({ status }) => status === 'ready');
    if (controller?.id !== selected?.id && !choose(controller)) { context.location?.navigate(acceptedPath, { replace: true }); return; }
    acceptedPath = path.length ? [...path] : controller ? globalPath(['accounts'], controller.controllerKey) : [];
  }) ?? (() => {});
  const disposeNavigation = context.onNavigate(async (target, isCurrent) => {
    await loading;
    if (!current() || !isCurrent()) return { status: 'unavailable', code: 'session-ended', message: 'The router navigation request is no longer current.' };
    if (!target || typeof target !== 'object' || Array.isArray(target) || !('kind' in target) || target.kind !== 'project' || !('projectId' in target) || typeof target.projectId !== 'string'
      || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(target.projectId) || Object.keys(target).some((key) => !['kind', 'projectId', 'controllerKey'].includes(key))
      || ('controllerKey' in target && typeof target.controllerKey !== 'string')) return { status: 'unavailable', code: 'invalid-target', message: 'The routing project target is invalid.' };
    if (!('controllerKey' in target)) return { status: 'unavailable', code: 'invalid-target', message: 'This routing project target must identify its router controller.' };
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
  return () => { alive = false; ++revision; ++discoveryRevision; panel?.(); disposeLocation(); disposeNavigation(); };
}
