// @ts-check
/** @typedef {import('../../../../core/src/plugin-api.js').WebPluginWorkspaceBrowserContext} Context */
/** @typedef {{id:string,ingress:string,url:string,permalink?:string,approval:'not-required'|'pending'|'approved'|'revoked',port:number,containers:string[],protocol:'http'|'https'|'tcp'}} Route */
/** @typedef {{ingresses:Array<{name:string,description:string,scheme:string,driver:string}>,routes:Route[]}} Snapshot */
/** @param {HTMLElement} container @param {Context} context */
export function mount(container, context) {
  const { element: node, input: field } = context.ui;
  let disposed = false, busy = false, reconciliation = false, version = 0;
  /** @type {Map<string,string>} */ const ingressSchemes = new Map();
  const current = () => !disposed && context.isCurrent(), allowed = new Set(context.operations.map(({name}) => name));
  const status = node('p'), routes = node('div'), form = document.createElement('form'); status.setAttribute('role', 'status');
  form.className = 'feature-form'; form.setAttribute('aria-label', `Create route for ${context.workspace.name}`);
  const ingressField = node('label'), ingress = document.createElement('select'); ingressField.className = 'field'; ingress.setAttribute('aria-label','Ingress'); ingressField.append(node('span','Ingress'),ingress); form.append(ingressField);
  const name = field(form,'Route name','opencode'), port = field(form,'Service port','4096'), nested = field(form,'Nested container (optional)','');
  name.required = true; name.pattern = '[a-z0-9](?:[a-z0-9\\-]{0,30}[a-z0-9])?'; name.maxLength = 32; port.type = 'number'; port.required = true; port.min = '1'; port.max = '65535';
  const protocolField = node('label'), protocol = document.createElement('select'); protocolField.className = 'field'; protocol.setAttribute('aria-label','Protocol');
  for (const value of ['http','https','tcp']) { const option = document.createElement('option'); option.value = value; option.textContent = value; protocol.append(option); }
  protocolField.append(node('span','Protocol'),protocol); form.append(protocolField);
  function defaultProtocol() { protocol.value = ingressSchemes.get(ingress.value) === 'tcp' ? 'tcp' : 'http'; }
  ingress.addEventListener('change',defaultProtocol);
  const create = context.ui.button('Create route', 'primary'); create.type = 'submit'; form.append(create);
  form.append(node('p', 'OpenCode normally listens on port 4096. Leave Nested container empty for a service running directly in the workspace. Pending routes require explicit approval.'));
  const refresh = context.ui.button('Refresh routes');
  container.append(refresh,status,routes); if (allowed.has('routes.create')) container.append(form);
  /** @param {string} operation @param {Record<string,unknown>} [input] */
  const invoke = (operation,input = {}) => context.invoke(operation,{...input,controllerId:context.workspace.hostId,workspace:context.workspace.name,workspaceId:context.workspace.id},{timeoutMilliseconds:150_000});
  /** @param {boolean} disabled */
  function disable(disabled) { for (const control of container.querySelectorAll('button,input,select')) if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement || control instanceof HTMLSelectElement) control.disabled = disabled; }
  /** @param {Snapshot} snapshot */
  function render(snapshot) {
    if (!current()) return;
    const selected = ingress.value; ingress.replaceChildren(); ingressSchemes.clear();
    for (const entry of snapshot.ingresses) { ingressSchemes.set(entry.name,entry.scheme); const option = document.createElement('option'); option.value = entry.name; option.textContent = `${entry.name} (${entry.scheme})${entry.description ? ` — ${entry.description}` : ''}`; ingress.append(option); }
    if ([...ingress.options].some((option) => option.value === selected)) ingress.value = selected;
    if (ingress.value !== selected) defaultProtocol();
    create.disabled = busy || !snapshot.ingresses.length;
    routes.replaceChildren();
    if (!snapshot.ingresses.length) routes.append(node('p','No ingress is configured on this host. Ask an operator to configure an ingress; existing DNS can be used without a DNS provider integration.'));
    if (!snapshot.routes.length) routes.append(node('p','No external routes for this workspace.'));
    for (const route of snapshot.routes) {
      const item = node('section'); item.className = 'panel feature-form'; item.append(node('p',`${route.ingress}: port ${route.port} · ${route.approval}`));
      if (route.approval === 'approved' || route.approval === 'not-required') {
        /** @type {Array<[string,string]>} */ const addresses = [['Service URL',route.url]];
        if (route.permalink) addresses.push(['Permanent URL',route.permalink]);
        for (const [label,address] of addresses) {
          const row = node('p',`${label}: `);
          try { const url = new URL(address); if (['http:','https:'].includes(url.protocol) && !url.username && !url.password) { const link = document.createElement('a'); link.href = address; link.textContent = address; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); } else row.append(node('code',address)); } catch { row.append(node('span','Route address unavailable.')); }
          item.append(row);
          const copy = context.ui.button(`Copy ${label.charAt(0).toLowerCase() + label.slice(1)}`);
          copy.addEventListener('click', () => { void (async () => {
            try { await navigator.clipboard.writeText(address); if (current()) context.ui.feedback(status, `${label} copied.`); }
            catch {
              if (!current()) return;
              const caption = document.createElement('label'), fallback = document.createElement('input'); caption.textContent = `Select and copy ${label.charAt(0).toLowerCase() + label.slice(1)}`;
              fallback.readOnly = true; fallback.value = address; caption.append(fallback); item.append(caption); fallback.focus(); fallback.select();
              context.ui.feedback(status, 'Clipboard access is unavailable. Select and copy the address below.');
            }
          })(); }); item.append(copy);
        }
      } else item.append(node('p',route.approval === 'pending' ? 'Awaiting operator approval. This route is not available yet.' : 'This route has been revoked.'));
      if (route.approval === 'pending' && allowed.has('routes.approve')) action(item,'Approve route',()=>run('routes.approve',{id:route.id}));
      if (route.approval !== 'revoked' && allowed.has('routes.revoke')) {
        const revoke = context.ui.button('Revoke route', 'danger'), confirmation = node('div');
        confirmation.className = 'workspace-confirmation'; confirmation.hidden = true; confirmation.setAttribute('role', 'group'); confirmation.setAttribute('aria-label', `Revoke ${route.ingress} route`);
        confirmation.append(node('p', `Revoke ${route.ingress} for port ${route.port}? Its external URL will stop serving this workspace.`));
        const confirm = context.ui.button('Revoke route now', 'danger'), keep = context.ui.button('Keep route'); confirmation.append(confirm, keep);
        revoke.addEventListener('click', () => { confirmation.hidden = false; keep.focus(); });
        keep.addEventListener('click', () => { confirmation.hidden = true; revoke.focus(); context.ui.feedback(status, 'Route revocation dismissed.'); });
        confirm.addEventListener('click', () => { void run('routes.revoke',{id:route.id}); });
        item.append(revoke, confirmation);
      }
      routes.append(item);
    }
  }
  /** @param {HTMLElement} parent @param {string} label @param {()=>Promise<void>} callback */
  function action(parent,label,callback) { const button = context.ui.button(label); button.disabled = busy || reconciliation; button.addEventListener('click',()=>{void callback();}); parent.append(button); }
  /** @param {string} operation @param {Record<string,unknown>} [input] */
  async function run(operation,input = {}) {
    if (busy || !current() || reconciliation && operation !== 'routes.list') return; busy = true; const selected = ++version; disable(true); context.ui.feedback(status, 'Updating routes…');
    try { const result = /** @type {Snapshot} */ (await invoke(operation,input)); if (current() && selected === version) { reconciliation = false; render(result); context.ui.feedback(status, operation === 'routes.create' ? 'Route created. Approval status is shown below.' : 'Routes refreshed.'); } }
    catch (error) {
      if (current() && selected === version) {
        if (operation !== 'routes.list' && error instanceof Error && 'outcome' in error && error.outcome === 'unknown') reconciliation = true;
        context.ui.feedback(status, reconciliation ? 'Route change outcome is unknown. Changes remain locked until Refresh routes succeeds. Your input is kept; inspect current routes before another action.' : 'Routes could not be updated. Refresh routes before retrying; ask an operator to check the external-urls host plugin and ingress connection. Your input is kept.', 'error');
      }
    }
    finally { busy = false; if(current()) {disable(false); for (const control of routes.querySelectorAll('button')) control.disabled = reconciliation; create.disabled = reconciliation || !ingress.options.length;} }
  }
  refresh.addEventListener('click',()=>{void run('routes.list');});
  form.addEventListener('submit',(event)=>{event.preventDefault();if(!form.reportValidity() || !ingress.value)return;void run('routes.create',{ingress:ingress.value,name:name.value.trim(),port:Number(port.value),protocol:protocol.value,...(nested.value.trim()?{container:nested.value.trim()}: {})});});
  void run('routes.list');
  return ()=>{disposed=true;version++;};
}
