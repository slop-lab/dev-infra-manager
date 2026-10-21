// @ts-check
/** @typedef {{name:string,id:string,phase:string}} Workspace */
/** @typedef {{id:string,title:string,status:'ready'|'unavailable',workspaces:Workspace[],tools:Array<'opencode'|'codex'>}} Controller */
/** @typedef {{operations:Array<{name:string}>,invoke(name:string,input?:unknown,options?:{timeoutMilliseconds:number}):Promise<unknown>,isCurrent():boolean}} Context */
/** @typedef {{state:'running'|'stopped',port:number,url:string,username:string,credentialsFile:string,logFile:string}} Server */
/** @param {string} tag @param {string} [text] */
function element(tag, text = '') { const node = document.createElement(tag); node.textContent = text; return node; }
/** @param {HTMLElement} container @param {Context} context */
export function mount(container, context) {
  let disposed = false, revision = 0, discoveryVersion = 0;
  /** @type {string|undefined} */ let controllerId;
  /** @type {string|undefined} */ let selectedWorkspaceId;
  const current = () => !disposed && context.isCurrent();
  const allowed = new Set(context.operations.map(({ name }) => name));
  const selectors = element('div'), content = element('section'), notice = element('p'); notice.setAttribute('role', 'status');
  selectors.className = content.className = 'feature-form';
  container.append(element('p', 'Install tools in a running workspace and manage its OpenCode server. Installation can take a few minutes.'), selectors, notice, content);
  /** @param {Controller} controller @param {Workspace|undefined} workspace */
  function show(controller, workspace) {
    const version = ++revision;
    const scoped = () => current() && version === revision;
    content.replaceChildren(); notice.textContent = '';
    if (!workspace) { content.append(element('p', 'No workspaces on this controller. Create one from Workspaces, then refresh this view.')); return; }
    const selectedWorkspace = workspace;
    selectedWorkspaceId = workspace.id;
    content.append(element('h3', workspace.name), element('p', `Workspace state: ${workspace.phase}`));
    if (workspace.phase !== 'running') { content.append(element('p', 'Start this workspace from Workspaces before inspecting or installing tools.')); return; }
    const tools = element('div'), server = element('div'); tools.className = server.className = 'panel feature-form'; content.append(tools, server);
    /** @param {string} name @param {Record<string,unknown>} [input] */
    const invoke = (name, input = {}) => context.invoke(name, { ...input, controllerId: controller.id, workspace: workspace.name, workspaceId: workspace.id }, { timeoutMilliseconds: 185_000 });
    /** @type {HTMLButtonElement[]} */ const actions = [];
    let busy = false, stateVersion = 0;
    /** @param {HTMLElement} parent @param {string} label @param {()=>Promise<void>} action */
    function button(parent, label, action) {
      const node = document.createElement('button'); node.type = 'button'; node.className = 'button button-secondary'; node.textContent = label;
      node.addEventListener('click', async () => {
        if (!scoped() || busy) return;
        busy = true; ++stateVersion; for (const item of actions) item.disabled = true; notice.textContent = `${label}…`;
        try { await action(); if (scoped()) notice.textContent = `${label} completed.`; }
        catch { if (scoped()) notice.textContent = `${label} could not complete. Refresh status before retrying; the workspace or controller may be unavailable.`; }
        finally { busy = false; if (scoped()) for (const item of actions) item.disabled = false; }
      }); actions.push(node); parent.append(node); return node;
    }
    /** @param {unknown} result */
    function renderTools(result) {
      if (!scoped()) return;
      const value = /** @type {{tools:Array<{name:'opencode'|'codex',installed:boolean,version:string}>}} */ (result);
      tools.replaceChildren(element('h4', 'Installed tools'));
      for (const tool of value.tools) tools.append(element('p', `${tool.name}: ${tool.installed ? tool.version || 'installed' : 'not installed'}`));
    }
    /** @param {unknown} result */
    function renderServer(result) {
      if (!scoped()) return;
      const value = /** @type {Server} */ (result);
      server.replaceChildren(element('h4', 'OpenCode server'), element('p', `Server ${value.state}. Port ${value.port} is inside the workspace.`));
      if (value.state !== 'running') return;
      server.append(element('p', 'Starting the server does not expose a public endpoint. Use approved workspace networking, or run this command on your computer and keep it running:'));
      server.append(element('pre', `dim --host ${controller.id} forward ${selectedWorkspace.name} ${value.port}:${value.port}`));
      server.append(element('p', `After forwarding, the server address is ${value.url}. This is the workspace-local address until forwarding is active.`));
      const link = document.createElement('a'); link.href = 'https://slop-lab.github.io/dev-infra-manager/opencode-web/'; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open OpenCode Web'; server.append(link);
      server.append(element('p', `Add your forwarded or approved HTTPS server in OpenCode Web. Username: ${value.username}. Retrieve the password inside the workspace from ${value.credentialsFile}; it is not sent to this page.`));
      server.append(element('p', 'If the browser blocks a local HTTP connection from the HTTPS client, use your configured HTTPS workspace endpoint.'));
    }
    const toolbar = element('div'); toolbar.className = 'feature-actions'; content.prepend(toolbar);
    if (allowed.has('tools.status') && allowed.has('server.status')) button(toolbar, 'Refresh status', async () => {
      const [installed, running] = await Promise.all([invoke('tools.status'), invoke('server.status')]); renderTools(installed); renderServer(running);
    });
    if (allowed.has('tools.setup')) for (const tool of controller.tools) button(toolbar, `Install ${tool}`, async () => { renderTools(await invoke('tools.setup', { tool })); });
    if (allowed.has('server.start')) button(toolbar, 'Start OpenCode server', async () => { renderServer(await invoke('server.start')); });
    if (allowed.has('server.stop')) button(toolbar, 'Stop OpenCode server', async () => { renderServer(await invoke('server.stop')); });
    if (allowed.has('tools.status')) void invoke('tools.status').then((value) => { if (stateVersion === 0) renderTools(value); }).catch(() => { if (scoped() && stateVersion === 0) tools.textContent = 'Tool status unavailable. Use Refresh status to retry.'; });
    if (allowed.has('server.status')) void invoke('server.status').then((value) => { if (stateVersion === 0) renderServer(value); }).catch(() => { if (scoped() && stateVersion === 0) server.textContent = 'Server status unavailable. Install OpenCode if needed, then refresh status.'; });
  }
  async function discover() {
    const request = ++discoveryVersion; ++revision;
    content.replaceChildren(); notice.textContent = 'Discovering workspace tools…';
    for (const node of selectors.querySelectorAll('select,button')) if (node instanceof HTMLSelectElement || node instanceof HTMLButtonElement) node.disabled = true;
    try {
      const { controllers } = /** @type {{controllers:Controller[]}} */ (await context.invoke('controllers.list', {}));
      if (!current() || request !== discoveryVersion) return;
      selectors.replaceChildren(); notice.textContent = '';
      const select = document.createElement('select'), workspaceSelect = document.createElement('select');
      const controllerLabel = element('label'), workspaceLabel = element('label');
      controllerLabel.className = workspaceLabel.className = 'field';
      select.id = `tools-controller-${crypto.randomUUID()}`; workspaceSelect.id = `tools-workspace-${crypto.randomUUID()}`;
      select.setAttribute('aria-label', 'Controller'); workspaceSelect.setAttribute('aria-label', 'Workspace');
      controllerLabel.setAttribute('for', select.id); workspaceLabel.setAttribute('for', workspaceSelect.id);
      controllerLabel.append(element('span', 'Controller'), select); workspaceLabel.append(element('span', 'Workspace'), workspaceSelect);
      selectors.append(controllerLabel, workspaceLabel);
      for (const controller of controllers) { const option = document.createElement('option'); option.value = controller.id; option.textContent = `${controller.title}${controller.status === 'unavailable' ? ' (unavailable)' : ''}`; select.append(option); }
      const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = 'Refresh workspaces'; refresh.className = 'button button-secondary'; refresh.addEventListener('click', () => { void discover(); }); selectors.append(refresh);
      /** @param {Controller|undefined} controller */
      function choose(controller) {
        ++revision; workspaceSelect.replaceChildren(); content.replaceChildren();
        controllerId = controller?.id;
        if (!controller || controller.status !== 'ready') { content.append(element('p', 'The agent-tools host plugin is unavailable on this controller. Install it on the controller, then refresh.')); return; }
        select.value = controller.id;
        for (const workspace of controller.workspaces) { const option = document.createElement('option'); option.value = workspace.id; option.textContent = `${workspace.name} (${workspace.phase})`; workspaceSelect.append(option); }
        const selected = controller.workspaces.find(({ id }) => id === selectedWorkspaceId) ?? controller.workspaces.find(({ phase }) => phase === 'running') ?? controller.workspaces[0];
        workspaceSelect.value = selected?.id ?? ''; show(controller, selected);
      }
      select.addEventListener('change', () => choose(controllers.find(({ id }) => id === select.value)));
      workspaceSelect.addEventListener('change', () => { const controller = controllers.find(({ id }) => id === select.value); if (controller) show(controller, controller.workspaces.find(({ id }) => id === workspaceSelect.value)); });
      choose(controllers.find(({ id }) => id === controllerId) ?? controllers.find(({ status }) => status === 'ready') ?? controllers[0]);
    } catch { if (current() && request === discoveryVersion) { notice.textContent = 'Could not discover workspace tools. Reopen this feature to retry.'; selectors.replaceChildren(); } }
  }
  void discover();
  return () => { disposed = true; ++revision; ++discoveryVersion; };
}
