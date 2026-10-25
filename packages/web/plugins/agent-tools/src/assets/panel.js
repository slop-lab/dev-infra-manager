// @ts-check
/** @typedef {{name:string,id:string,phase:string}} Workspace */
/** @typedef {{id:string,title:string,status:'ready'|'unavailable',workspaces:Workspace[],tools:Array<'opencode'|'codex'>}} Controller */
/** @typedef {import('@slop-lab/dim-web/plugin-api').WebPluginWorkspaceBrowserContext} Context */
/** @typedef {{state:'running'|'stopped',port:number,url:string,directory:string,username:string,credentialsFile:string,logFile:string,externalUrls?:Array<{url:string,permalink?:string,ingress:string,approval:string}>,externalUrlsAvailable?:boolean}} Server */
/** @param {HTMLElement} container @param {Context} context */
export function mount(container, context) {
  const { element } = context.ui;
  let disposed = false, revision = 0, discoveryVersion = 0;
  const current = () => !disposed && context.isCurrent();
  const allowed = new Set(context.operations.map(({ name }) => name));
  const content = element('section'), notice = element('p'); notice.setAttribute('role', 'status');
  content.className = 'feature-form';
  container.append(element('p', 'Install tools in a running workspace and manage its OpenCode server. Installation can take a few minutes.'), notice, content);
  const retryDiscovery = context.ui.button('Retry workspace tools'); retryDiscovery.hidden = true; container.prepend(retryDiscovery);
  /** @param {Controller} controller @param {Workspace|undefined} workspace */
  function show(controller, workspace) {
    const version = ++revision;
    const scoped = () => current() && version === revision;
    content.replaceChildren(); notice.textContent = '';
    if (!workspace) { content.append(element('p', 'No workspaces on this controller. Create one from Workspaces, then refresh this view.')); return; }
    const selectedWorkspace = workspace;
    content.append(element('h3', workspace.name), element('p', `Workspace state: ${workspace.phase}`));
    if (workspace.phase !== 'running') { content.append(element('p', 'Start this workspace from Workspaces before inspecting or installing tools.')); return; }
    const tools = element('div'), server = element('div'); tools.className = server.className = 'panel feature-form'; content.append(tools, server);
    /** @param {string} name @param {Record<string,unknown>} [input] */
    const invoke = (name, input = {}) => context.invoke(name, { ...input, controllerId: controller.id, workspace: workspace.name, workspaceId: workspace.id }, { timeoutMilliseconds: 185_000 });
    /** @type {Array<{node:HTMLButtonElement,write:boolean}>} */ let actions = [];
    /** @type {HTMLButtonElement|undefined} */ let startButton;
    /** @type {HTMLButtonElement|undefined} */ let stopButton;
    /** @type {'running'|'stopped'|undefined} */ let serverState;
    let busy = false, reconciliation = false, stateVersion = 0;
    function updateActions() {
      actions = actions.filter(({ node }) => node.isConnected);
      for (const item of actions) item.node.disabled = busy || reconciliation && item.write
        || item.node === startButton && serverState === 'running' || item.node === stopButton && serverState === 'stopped';
    }
    /** @param {HTMLElement} parent @param {string} label @param {()=>Promise<boolean|void>} action @param {boolean} [write] */
    function button(parent, label, action, write = false) {
      const node = context.ui.button(label);
      node.addEventListener('click', async () => {
        if (!scoped() || busy || write && reconciliation) return;
        busy = true; ++stateVersion; for (const item of actions) item.node.disabled = true; context.ui.feedback(notice, `${label}…`);
        try { const result = await action(); if (scoped() && result !== false) context.ui.feedback(notice, `${label} completed.`); }
        catch (error) {
          if (!scoped()) return;
          if (write && error instanceof Error && 'outcome' in error && error.outcome === 'unknown') reconciliation = true;
          context.ui.feedback(notice, reconciliation ? `${label}: outcome is unknown. Changes are locked until Refresh status succeeds. Do not repeat the action yet.` : `${label} could not complete. Refresh status before retrying; the workspace or controller may be unavailable.`, 'error');
        }
        finally { busy = false; if (scoped()) updateActions(); }
      }); actions.push({ node, write }); parent.append(node); return node;
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
      serverState = value.state;
      server.replaceChildren(element('h4', 'OpenCode server'), element('p', `Server ${value.state}. Port ${value.port} is inside the workspace.`));
      server.append(element('p', `Project directory: ${value.directory}`));
      button(server, 'Copy project directory', async () => {
        try { await navigator.clipboard.writeText(value.directory); }
        catch {
          if (!scoped()) return;
          const label = document.createElement('label'); label.textContent = 'Select and copy project directory';
          const path = document.createElement('input'); path.readOnly = true; path.value = value.directory; label.append(path); server.append(label); path.focus(); path.select();
        }
      });
      const publicRoutes = (value.externalUrls || []).filter((route) => ['approved', 'not-required'].includes(route.approval));
      if (publicRoutes.length) {
        server.append(element('p', value.state === 'running' ? 'External server URLs:' : 'Configured external URLs (server stopped):'));
        for (const route of publicRoutes) {
          /** @type {Array<[string,string]>} */ const addresses = [['Service URL', route.url]];
          if (route.permalink) addresses.push(['Permanent URL', route.permalink]);
          for (const [label, address] of addresses) {
            const row = element('p', `${label}: `);
            if (value.state === 'running') {
              const routeLink = document.createElement('a'); routeLink.href = address; routeLink.target = '_blank'; routeLink.rel = 'noopener noreferrer'; routeLink.textContent = address; row.append(routeLink);
            } else row.append(document.createTextNode(address));
            server.append(row);
            button(server, `Copy ${label.charAt(0).toLowerCase() + label.slice(1)}`, async () => { await copy(address, `Select and copy ${label.charAt(0).toLowerCase() + label.slice(1)}`, server); });
          }
        }
      } else {
        server.append(element('p', value.externalUrlsAvailable === false ? 'External route status unavailable. Refresh status or inspect External routes for this workspace.' : 'No approved external URL. Create a route for this server port in External routes, then refresh status.'));
        const configure = context.ui.button('Configure external access');
        configure.addEventListener('click', () => { if (!context.openFeature('external-urls')) context.ui.feedback(notice, 'External routes is not installed for this workspace. Ask an operator to install its Web and host plugins, or use the forwarding command below.'); });
        server.append(configure);
      }
      server.append(element('p', `Username: ${value.username}.`));
      const credentialActions = element('div'); credentialActions.className = 'feature-actions'; server.append(credentialActions);
      if (allowed.has('server.credentials')) button(credentialActions, 'Copy server password', async () => {
        const credential = /** @type {{password:string}} */ (await invoke('server.credentials'));
        if (!scoped()) return;
        try { await navigator.clipboard.writeText(credential.password); }
        catch {
          if (!scoped()) return;
          const label = document.createElement('label'); label.textContent = 'Select and copy server password';
          const fallback = document.createElement('input'); fallback.type = 'text'; fallback.readOnly = true; fallback.value = credential.password; fallback.autocomplete = 'off'; label.append(fallback); server.append(label); fallback.focus(); fallback.select();
          button(label, 'Hide password', async () => { fallback.value = ''; label.remove(); });
        }
      });
      if (allowed.has('server.password')) {
        const form = document.createElement('form'), label = document.createElement('label'), password = document.createElement('input');
        label.textContent = 'New server password'; password.type = 'password'; password.autocomplete = 'new-password'; password.minLength = 12; password.maxLength = 128; password.required = true; password.pattern = '[ -~]{12,128}'; label.append(password); form.append(label, element('p', 'Use 12–128 printable ASCII characters. Changing it restarts a running server.'));
        const save = button(form, 'Set server password', async () => {
          if (!form.reportValidity()) return;
          const next = password.value; password.value = '';
          renderServer(await invoke('server.password', { password: next }));
        }, true);
        form.addEventListener('submit', (event) => { event.preventDefault(); save.click(); }); server.append(form);
      }
      if (value.state !== 'running') { updateActions(); return; }
      server.append(element('p', 'For local forwarding, run this command on your computer and keep it running:'));
      server.append(element('pre', `dim --host ${controller.id} forward ${selectedWorkspace.name} ${value.port}:${value.port}`));
      button(server, 'Copy forwarding command', async () => { await copy(`dim --host ${controller.id} forward ${selectedWorkspace.name} ${value.port}:${value.port}`, 'Select and copy forwarding command', server); });
      server.append(element('p', `After forwarding, the server address is ${value.url}. This is the workspace-local address until forwarding is active.`));
      const link = document.createElement('a'); link.href = 'https://slop-lab.github.io/dev-infra-manager/opencode-web/'; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open OpenCode Web'; server.append(link);
      server.append(element('p', `Select this workspace's forwarded or approved HTTPS server in OpenCode Web. Use Add project to open ${value.directory}; Copy project directory provides the exact path. An operator can copy or change the server password here.`));
      server.append(element('p', 'If the browser blocks a local HTTP connection from the HTTPS client, use your configured HTTPS workspace endpoint.'));
      updateActions();
    }
    /** @param {string} value @param {string} caption @param {HTMLElement} parent */
    async function copy(value, caption, parent) {
      try { await navigator.clipboard.writeText(value); }
      catch {
        if (!scoped()) return;
        const label = document.createElement('label'), fallback = document.createElement('input'); label.textContent = caption;
        fallback.readOnly = true; fallback.value = value; label.append(fallback); parent.append(label); fallback.focus(); fallback.select();
      }
    }
    const toolbar = element('div'); toolbar.className = 'feature-actions'; content.prepend(toolbar);
    if (allowed.has('tools.status') && allowed.has('server.status')) button(toolbar, 'Refresh status', async () => {
      const [installed, running] = await Promise.allSettled([invoke('tools.status'), invoke('server.status')]);
      if (!scoped()) return false;
      if (installed.status === 'fulfilled') renderTools(installed.value);
      else tools.replaceChildren(element('h4', 'Installed tools'), element('p', 'Tool status unavailable. Server status is loaded independently; use Refresh status to retry.'));
      if (running.status === 'fulfilled') renderServer(running.value);
      else server.replaceChildren(element('h4', 'OpenCode server'), element('p', 'Server status unavailable. Tool status is loaded independently; use Refresh status to retry.'));
      if (installed.status === 'rejected' || running.status === 'rejected') { context.ui.feedback(notice, 'Some status reads failed. Available results are shown; Refresh status retries without changing the workspace.', 'error'); return false; }
      reconciliation = false;
    });
    if (allowed.has('tools.setup')) for (const tool of controller.tools) button(toolbar, `Install ${tool}`, async () => { renderTools(await invoke('tools.setup', { tool })); }, true);
    if (allowed.has('server.start')) startButton = button(toolbar, 'Start OpenCode server', async () => { renderServer(await invoke('server.start')); }, true);
    if (allowed.has('server.stop')) stopButton = button(toolbar, 'Stop OpenCode server', async () => { renderServer(await invoke('server.stop')); }, true);
    if (allowed.has('tools.status')) void invoke('tools.status').then((value) => { if (stateVersion === 0) renderTools(value); }).catch(() => { if (scoped() && stateVersion === 0) tools.textContent = 'Tool status unavailable. Use Refresh status to retry.'; });
    if (allowed.has('server.status')) void invoke('server.status').then((value) => { if (stateVersion === 0) renderServer(value); }).catch(() => { if (scoped() && stateVersion === 0) server.textContent = 'Server status unavailable. Install OpenCode if needed, then refresh status.'; });
  }
  async function discover() {
    const selected = ++discoveryVersion;
    retryDiscovery.hidden = true; retryDiscovery.disabled = true;
    notice.textContent = 'Discovering workspace tools…';
    try {
      const { controllers } = /** @type {{controllers:Controller[]}} */ (await context.invoke('controllers.list', {}));
      if (!current() || selected !== discoveryVersion) return;
      const controller = controllers.find(({ id }) => id === context.workspace.hostId);
      const workspace = controller?.workspaces.find(({ id, name }) => id === context.workspace.id && name === context.workspace.name);
      if (!controller || controller.status !== 'ready' || !workspace) {
        retryDiscovery.hidden = false;
        notice.textContent = 'Workspace tools are unavailable for this workspace identity. Refresh workspaces or ask the operator to install the agent-tools host plugin.'; return;
      }
      show(controller, workspace);
    } catch { if (current() && selected === discoveryVersion) { retryDiscovery.hidden = false; notice.textContent = 'Could not discover workspace tools. Use Retry workspace tools to retry.'; } }
    finally { if (current() && selected === discoveryVersion) retryDiscovery.disabled = false; }
  }
  retryDiscovery.addEventListener('click', () => { if (current() && !retryDiscovery.hidden && !retryDiscovery.disabled) void discover(); });
  void discover();
  return () => { disposed = true; ++revision; content.replaceChildren(); };
}
