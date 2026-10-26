// @ts-check
import { routerLink } from "./routes.js";
import { createMutationReconciliation } from "./mutation-reconciliation.js";
/** @typedef {import('./panel.js').Context} Context */
/** @param {unknown} value @returns {Record<string,unknown>} */
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string,unknown>} */ (value) : {}; }
/** @param {unknown} value @returns {Record<string,unknown>[]} */
function rows(value) { return Array.isArray(value) ? value.map(object) : []; }
/** @param {HTMLElement} container @param {Context} context @param {()=>Promise<void>} refreshOverview */
export function mountAccounts(container, context, refreshOverview) {
  const { element: node, input } = context.ui;
  const mutations = createMutationReconciliation();
  /** @type {Map<string,Record<string,unknown>>} */ const mutationExpectations = new Map();
  /** @type {HTMLButtonElement|undefined} */ let newCodexIntent;
  /** @type {Map<string,string>} */ const renameDrafts = new Map();
/** @param {HTMLElement} parent @param {string} label */
function select(parent, label) { return context.ui.select(parent, label, []); }
/** @param {HTMLSelectElement} control @param {string} value @param {string} label */
function option(control, value, label) { const item = document.createElement('option'); item.value = value; item.textContent = label; control.append(item); }
/** @param {HTMLElement} parent @param {string} label @param {()=>Promise<void>} run @param {HTMLElement} feedback */
function button(parent, label, run, feedback) { const result = context.ui.button(label); result.addEventListener('click', () => { if (result.disabled) return; result.disabled = true; result.dataset.pending = 'true'; context.ui.feedback(feedback, `${label}…`); void run().catch((error) => { const key = result.dataset.mutationKey; if (key && error instanceof Error && 'outcome' in error && error.outcome === 'unknown') { mutations.unknown(key); result.dataset.accepted = 'true'; } context.ui.feedback(feedback, key?.startsWith('account.login:') && mutations.outcome(key) === 'unknown' ? 'The sign-in start outcome is unknown. The account list cannot recover a pending authorization code. Ask the router operator to inspect that account’s provider login before starting another authorization; completed account connection can still be checked with Refresh router.' : error instanceof Error ? error.message : 'Operation failed. Refresh before retrying.', 'error'); }).finally(() => { delete result.dataset.pending; result.disabled = result.dataset.accepted === 'true' || Boolean(result.dataset.mutationKey && mutations.locked(result.dataset.mutationKey)); }); }); parent.append(result); return result; }
/** @param {HTMLFormElement} form @param {HTMLButtonElement} submit */
function editable(form, submit) { form.addEventListener('submit', (event) => { event.preventDefault(); submit.click(); }); form.addEventListener('input', () => { const key = submit.dataset.mutationKey; if (key) mutations.edit(key); if (!key || mutations.outcome(key) !== 'unknown') delete submit.dataset.accepted; if (submit.dataset.pending !== 'true') submit.disabled = Boolean(key && mutations.locked(key)); }); }
  let alive = true;
  /** @type {Set<number>} */ const timers = new Set();
  /** @type {Map<string,unknown>} */ const activeSessions = new Map();
  const current = () => alive && context.isCurrent();
  /** @param {string} name */ const has = (name) => context.operations.some((operation) => operation.name === name);
  const panel = node('section'); panel.className = 'panel'; panel.append(node('h2', 'Provider accounts'));
  panel.dataset.routerSection = 'accounts';
  const feedback = node('p'), list = node('div'), sessions = node('div'), providerLayout = node('div', '', 'llm-provider-layout'), connected = node('section'), connections = node('section');
  feedback.setAttribute('role', 'status'); connected.append(node('h3', 'Connected accounts'), list, sessions); connections.append(node('h3', 'Connect another account')); providerLayout.append(connected, connections); panel.append(feedback, providerLayout); container.append(panel);
  const routePanel = node('section'); routePanel.className = 'panel';
  routePanel.dataset.routerSection = 'accounts';
  /** @type {HTMLSelectElement|null} */ let accountSelect = null;
  /** @type {Map<string,HTMLElement>} */ const sessionRows = new Map();
  /** @type {Map<string,Record<string,unknown>>} */ let accountRows = new Map();
  /** @type {Map<string,HTMLElement>} */ const accountElements = new Map();
  /** @type {Set<HTMLButtonElement>} */ const creationControls = new Set();
  /** @type {import('./routes.js').RouterRoute} */ let activeRoute = { section: 'accounts', objectId: '', valid: true };
  /** @type {Record<string,unknown>[]} */ let routes = [];
  let accountCatalogReady = false, accountReadRevision = 0;
  /** @type {string|undefined} */ let pendingCodexAccountId, pendingApiAccountId;
  /** @type {(accountId:string,model:Record<string,unknown>)=>void} */ let useAccountModel = () => {};
  /** @type {(value:unknown,read?:number)=>void} */ let setRoutes = () => {};
  /** @param {string} accountId @param {Record<string,unknown>} session */
  function renderSession(accountId, session) {
    let row = sessionRows.get(accountId); if (!row) { row = node('article'); row.className = 'operations-row'; sessionRows.set(accountId, row); sessions.append(row); }
    const label = String(accountRows.get(accountId)?.reference ?? 'Codex account');
    activeSessions.set(accountId, session.sessionId);
    const sessionCurrent = () => current() && activeSessions.get(accountId) === session.sessionId;
    row.replaceChildren(node('h3', `Sign in to ${label}`));
    const status = node('p'); status.setAttribute('role', 'status'); row.append(status);
    if (session.status === 'connected') { activeSessions.delete(accountId); status.textContent = 'Account connected.'; return; }
    status.textContent = 'Open the authorization page and complete sign-in. Then check the connection here.';
    if (typeof session.verificationUrl === 'string') {
      const url = new URL(session.verificationUrl);
      if (url.protocol === 'https:' && !url.username && !url.password) { const link = document.createElement('a'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open Codex authorization'; row.append(link); }
    }
    if (typeof session.userCode === 'string') row.append(node('p', `Authorization code: ${session.userCode}`));
    if (typeof session.expiresAt === 'number') row.append(node('p', `Expires: ${new Date(session.expiresAt).toLocaleString()}`));
    async function check() {
      const result = object(await context.invoke('account.login.status', { accountId, sessionId: session.sessionId })); if (!sessionCurrent()) return;
      if (result.status === 'connected') { activeSessions.delete(accountId); row?.replaceChildren(node('h3', `Sign in to ${label}`), node('p', 'Account connected.')); await refresh(); }
      else if (result.status === 'failed') { activeSessions.delete(accountId); status.textContent = typeof result.message === 'string' ? result.message : 'Authorization failed. Start sign-in again from the account list.'; }
      else { status.textContent = 'Waiting for authorization. This page checks the connection automatically.'; schedule(); }
    }
    function schedule() {
      if (!sessionCurrent()) return;
      const timer = window.setTimeout(() => { timers.delete(timer); if (sessionCurrent()) void check().catch(() => { if (sessionCurrent()) { status.textContent = 'Connection check unavailable. Retrying…'; schedule(); } }); }, 3000); timers.add(timer);
    }
    button(row, 'Check connection', check, status); schedule();
  }
  /** @param {string} accountId */
  async function login(accountId) {
    const existing = sessionRows.get(accountId); if (activeSessions.has(accountId) && existing) { existing.scrollIntoView({ block: 'nearest' }); return; }
    try { const result = object(await context.invoke('account.login.start', { accountId }, { timeoutMilliseconds: 65_000 })); if (current()) renderSession(accountId, result); }
    catch (error) {
      if (current() && error instanceof Error && 'outcome' in error && error.outcome === 'unknown') {
        const key = `account.login:${accountId}`; mutations.unknown(key); mutationExpectations.set(key, { kind: 'login', id: accountId });
        for (const control of container.querySelectorAll(`button[data-mutation-key="${CSS.escape(key)}"]`)) if (control instanceof HTMLButtonElement) control.disabled = true;
      }
      throw error;
    }
  }
  const readiness = node('p', 'Connect account actions are available after the current provider account catalog loads.', 'field-hint'); connections.append(readiness);
  function updateCreationReadiness() {
    readiness.hidden = accountCatalogReady;
    for (const control of creationControls) control.disabled = !accountCatalogReady || Boolean(control.dataset.mutationKey && mutations.locked(control.dataset.mutationKey)) || control.dataset.pending === 'true';
  }
  async function refresh() {
    if (!has('accounts')) return;
    const request = ++accountReadRevision, read = mutations.beginRead(), result = rows(await context.invoke('accounts')); if (!current() || request !== accountReadRevision) return;
    accountCatalogReady = true;
    accountRows = new Map(result.map((account) => [String(account.id), account])); accountElements.clear(); list.replaceChildren(); list.className = 'llm-object-list';
    for (const [key, expectation] of mutationExpectations) {
      const kind = expectation.kind;
      const committed = kind === 'create' ? result.some((account) => account.id === expectation.id && account.provider === expectation.provider)
        : kind === 'rename' ? result.some((account) => account.id === expectation.id && account.reference === expectation.reference)
        : kind === 'login' ? result.some((account) => account.id === expectation.id && account.status === 'connected') || undefined : undefined;
      const outcome = mutations.reconcile(read, key, committed); if (outcome !== 'unknown') mutationExpectations.delete(key);
      if (kind === 'create' && outcome === 'accepted') { if (key === 'account.create:codex') pendingCodexAccountId = undefined; else if (key === 'account.create:api') pendingApiAccountId = undefined; if (typeof expectation.settle === 'function' && expectation.settle()) mutations.edit(key); }
      if (kind === 'rename' && outcome === 'accepted') { const id = String(expectation.id), draft = renameDrafts.get(id); if (draft === undefined || draft === String(expectation.draft)) renameDrafts.delete(id); else mutations.edit(key); }
      if (kind === 'login' && outcome === 'accepted') mutations.edit(key);
      if (key === 'account.create:codex' && outcome === 'accepted' && newCodexIntent) { newCodexIntent.hidden = false; context.ui.feedback(feedback, 'Account list refreshed. Review the listed accounts before connecting another Codex account.'); }
      for (const control of container.querySelectorAll(`button[data-mutation-key="${CSS.escape(key)}"]`)) if (control instanceof HTMLButtonElement) { control.disabled = mutations.locked(key); if (!control.disabled) delete control.dataset.accepted; }
    }
    if (!result.length) list.append(node('p', 'No provider accounts connected yet.'));
    for (const account of result) { const row = node('article'); row.className = 'operations-row'; const id = String(account.id); row.dataset.accountId = id; accountElements.set(id, row);
      const heading = node('h3'), link = routerLink(context, String(account.reference), ['accounts', id], 'llm-object-link', () => applyRoute({ section: 'accounts', objectId: id, valid: true })); heading.append(link); row.append(heading, node('p', `${String(account.provider)} · ${String(account.status)}`));
      if (has('account.models')) {
        const catalog = node('div'), catalogStatus = node('p'); catalogStatus.setAttribute('role', 'status'); row.append(catalogStatus, catalog);
        button(row, 'Inspect account models', async () => {
          const models = rows(await context.invoke('account.models', { accountId: id })); if (!current()) return;
          const table = context.ui.table(['Model', 'API', 'Context tokens', 'Output tokens', ...(has('route.upsert') ? ['Route draft'] : [])], models.map((model) => [String(model.id), String(model.api), String(model.context ?? 'Unknown'), String(model.output ?? 'Unknown'), ...(has('route.upsert') ? [''] : [])]));
          if (has('route.upsert')) models.forEach((model, index) => { const cell = table.querySelectorAll('tbody tr')[index]?.lastElementChild; if (cell instanceof HTMLElement) button(cell, `Use ${String(model.id)}`, async () => { useAccountModel(id, model); }, catalogStatus); });
          catalog.replaceChildren(table);
          catalogStatus.textContent = models.length ? `${models.length} models available from this account. Provider quota is not inferred.` : 'No models returned by this account.';
        }, catalogStatus);
      }
      if (account.provider === 'codex' && has('account.login.start')) { const loginButton = button(row, account.status === 'connected' ? 'Sign in again' : 'Sign in', async () => { loginButton.dataset.mutationKey = `account.login:${id}`; mutationExpectations.set(loginButton.dataset.mutationKey, { kind: 'login', id }); await login(id); if (current()) feedback.textContent = 'Complete Codex sign-in below.'; }, feedback); loginButton.dataset.mutationKey = `account.login:${id}`; loginButton.disabled = mutations.locked(loginButton.dataset.mutationKey); }
      if (account.provider !== 'backend' && has('account.rename')) {
        const details = document.createElement('details'); details.append(node('summary', 'Rename account'));
        const form = document.createElement('form'); form.setAttribute('aria-label', `Rename ${String(account.reference)}`); details.append(form);
        const reference = input(form, 'Display name', renameDrafts.get(id) ?? String(account.reference)); reference.required = true; reference.maxLength = 200; reference.addEventListener('input', () => renameDrafts.set(id, reference.value));
        const submit = button(form, 'Save name', async () => { if (!form.reportValidity()) return; const draft = reference.value, renamed = draft.trim(); submit.dataset.mutationKey = `account.rename:${id}`; mutationExpectations.set(submit.dataset.mutationKey, { kind: 'rename', id, reference: renamed, draft }); await context.invoke('account.rename', { accountId: id, reference: renamed }); if (current()) { const superseded = reference.value !== draft; if (!superseded) renameDrafts.delete(id); mutations.accepted(submit.dataset.mutationKey); if (superseded) mutations.edit(submit.dataset.mutationKey); else submit.dataset.accepted = 'true'; feedback.textContent = 'Account name saved.'; try { await refresh(); } catch { if (current()) feedback.textContent = 'Account name saved. The account list could not refresh; use Refresh router. The rename was accepted.'; } } }, feedback); submit.dataset.mutationKey = `account.rename:${id}`; submit.disabled = mutations.locked(submit.dataset.mutationKey); editable(form, submit); row.append(details);
      }
      list.append(row);
    }
    applyRoute(activeRoute);
    if (accountSelect) { const selected = accountSelect.value; accountSelect.replaceChildren(); for (const account of result) option(accountSelect, String(account.id), String(account.reference)); if (accountRows.has(selected)) accountSelect.value = selected; }
    updateCreationReadiness();
  }
  if (has('account.create') && has('account.login.start')) {
    const connectCodex = button(connections, 'Connect Codex account', async () => {
      const id = pendingCodexAccountId ??= crypto.randomUUID(); connectCodex.dataset.mutationKey = 'account.create:codex'; mutationExpectations.set(connectCodex.dataset.mutationKey, { kind: 'create', id, provider: 'codex' });
      const account = object(await context.invoke('account.create', { accountId: id, provider: 'codex' }));
      if (!current()) return;
      accountRows.set(id, account); pendingCodexAccountId = undefined; mutationExpectations.delete(connectCodex.dataset.mutationKey); mutations.accepted(connectCodex.dataset.mutationKey); connectCodex.dataset.accepted = 'true'; if (newCodexIntent) newCodexIntent.hidden = false;
      feedback.textContent = 'Account added. Starting Codex sign-in…';
      await refresh().catch(() => {});
      if (!current()) return;
      try { await login(id); if (current()) feedback.textContent = 'Complete sign-in using the authorization link below.'; }
      catch { if (current()) feedback.textContent = mutations.outcome(`account.login:${id}`) === 'unknown' ? 'Account added, but the sign-in start outcome is unknown. Ask the router operator to inspect that account’s pending provider login; the account list cannot recover its authorization code.' : 'Account added. Sign-in could not start; retry from its account row.'; }
    }, feedback); connectCodex.dataset.mutationKey = 'account.create:codex'; creationControls.add(connectCodex); updateCreationReadiness();
    newCodexIntent = context.ui.button('Connect another Codex account'); newCodexIntent.hidden = true;
    newCodexIntent.addEventListener('click', () => { if (mutations.outcome('account.create:codex') !== 'accepted') return; pendingCodexAccountId = undefined; mutations.edit('account.create:codex'); delete connectCodex.dataset.accepted; updateCreationReadiness(); if (newCodexIntent) newCodexIntent.hidden = true; context.ui.feedback(feedback, 'A separate account connection is ready. The interrupted request will not be retried.'); }); connections.append(newCodexIntent);
  }
  if (has('account.create')) {
    const details = document.createElement('details'); details.append(node('summary', 'Connect API provider')); connections.append(details);
    const form = document.createElement('form'); form.setAttribute('aria-label', 'Connect API provider'); details.append(form);
    const provider = select(form, 'Provider type'); option(provider, 'openai', 'OpenAI compatible API'); option(provider, 'anthropic', 'Anthropic compatible API');
    const reference = input(form, 'Account label (optional)');
    const api = node('div'); form.append(api); const endpoint = input(api, 'API base URL'); endpoint.type = 'url'; const key = input(api, 'API key'); key.type = 'password'; key.autocomplete = 'new-password'; key.spellcheck = false;
    let previousDefault = '';
    const mode = () => { endpoint.required = true; key.required = true; key.value = ''; const next = provider.value === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'; if (!endpoint.value || endpoint.value === previousDefault) endpoint.value = next; previousDefault = next; }; mode(); provider.addEventListener('change', mode);
    let formRevision = 0; form.addEventListener('input', () => { formRevision++; }); form.addEventListener('change', () => { formRevision++; });
    form.append(node('p', 'Each account has its own credentials and routes. API keys are stored by the router and never returned to this page.'));
    const submit = button(form, 'Add provider account', async () => {
      if (!form.reportValidity()) { feedback.textContent = 'Complete the account fields.'; return; }
      const id = pendingApiAccountId ??= crypto.randomUUID(), submittedRevision = formRevision, submittedKey = key.value, submittedProvider = provider.value;
      const settle = () => { const superseded = formRevision !== submittedRevision; if (key.value === submittedKey) key.value = ''; return superseded; };
      submit.dataset.mutationKey = 'account.create:api'; mutationExpectations.set(submit.dataset.mutationKey, { kind: 'create', id, provider: submittedProvider, settle });
      const account = object(await context.invoke('account.create', { accountId: id, ...(reference.value.trim() ? { reference: reference.value.trim() } : {}), provider: submittedProvider, endpoint: endpoint.value.trim(), apiKey: submittedKey }));
      if (!current()) return; accountRows.set(id, account); pendingApiAccountId = undefined; mutationExpectations.delete(submit.dataset.mutationKey); mutations.accepted(submit.dataset.mutationKey); const superseded = settle(); if (superseded) mutations.edit(submit.dataset.mutationKey); else submit.dataset.accepted = 'true'; feedback.textContent = `${String(account.reference)} added. Create a route to use this API account.`;
      const reads = await Promise.allSettled([refresh(), refreshOverview()]); if (current() && reads.some((result) => result.status === 'rejected')) feedback.textContent = `${id} added. The account list could not refresh; use Refresh router. The account was accepted.`;
    }, feedback); submit.dataset.mutationKey = 'account.create:api'; creationControls.add(submit); updateCreationReadiness(); editable(form, submit);
  }
  if (has('route.upsert')) {
    container.append(routePanel); routePanel.append(node('h2', 'Route configuration'), node('p', 'A route selects one account. Keep account identities separate so routing can later use account usage without replacing credentials.'));
    const form = document.createElement('form'); form.setAttribute('aria-label', 'Route configuration'); routePanel.append(form);
    const existing = select(form, 'Load route'); option(existing, '', 'New route'); const routeId = input(form, 'Route ID'); routeId.required = true; routeId.pattern = '[a-z0-9][a-z0-9._\\-]{0,63}';
    accountSelect = select(form, 'Route account'); accountSelect.required = true;
    const modelScope = select(form, 'Allowed models'); option(modelScope, 'all', 'All models from this account'); option(modelScope, 'selected', 'Only selected models');
    form.append(node('p', 'All models follows the account’s available model catalog, including models added later. It does not grant access to other accounts.'));
    const modelList = document.createElement('fieldset'); modelList.append(node('legend', 'Selected models')); form.append(modelList);
    /** @type {Array<{row:HTMLElement,id:HTMLInputElement,name:HTMLInputElement,api:HTMLSelectElement,context:HTMLInputElement,output:HTMLInputElement}>} */ let models = [];
    /** @param {Record<string,unknown>} [initial] */
    function addModel(initial = {}) { const row = node('fieldset'); row.append(node('legend', 'Route model')); const id = input(row, 'Model ID', typeof initial.id === 'string' ? initial.id : ''), name = input(row, 'Model name', typeof initial.name === 'string' ? initial.name : ''); id.required = true; name.required = true;
      const api = select(row, 'Model API'); option(api, 'responses', 'Responses'); option(api, 'chat', 'Chat completions'); if (typeof initial.api === 'string') api.value = initial.api;
      const context = input(row, 'Context tokens', String(initial.context ?? '')), output = input(row, 'Output tokens', String(initial.output ?? '')); for (const bound of [context, output]) { bound.type = 'number'; bound.min = '1'; bound.step = '1'; bound.placeholder = 'Use client model catalog'; }
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button button-secondary'; remove.textContent = 'Remove model'; remove.addEventListener('click', () => { models = models.filter((model) => model.row !== row); row.remove(); form.dispatchEvent(new Event('input', { bubbles: true })); }); row.append(remove); models.push({ row, id, name, api, context, output }); modelList.append(row); }
    addModel(); let formRevision = 0; form.addEventListener('input', () => { formRevision++; }); form.addEventListener('change', () => { formRevision++; }); const routeFeedback = node('p'); routeFeedback.setAttribute('role', 'status'); form.append(routeFeedback);
    button(modelList, 'Add model', async () => { addModel(); routeFeedback.textContent = 'Model row added.'; form.dispatchEvent(new Event('input', { bubbles: true })); }, routeFeedback);
    const updateScope = () => { modelList.hidden = modelScope.value === 'all'; modelList.disabled = modelScope.value === 'all'; }; updateScope(); modelScope.addEventListener('change', updateScope);
    useAccountModel = (accountId, model) => {
      const changedAccount = accountSelect?.value !== accountId;
      if (changedAccount && models.some((row) => row.id.value.trim()) && !window.confirm('Replace selected models with a model from this account?')) return;
      if (accountSelect) accountSelect.value = accountId;
      if (changedAccount || models.every((row) => !row.id.value.trim())) { for (const model of models) model.row.remove(); models = []; }
      if (!models.some((row) => row.id.value === model.id)) addModel({ ...model, name: model.name || model.id });
      modelScope.value = 'selected'; updateScope(); form.dispatchEvent(new Event('input', { bubbles: true }));
      routeFeedback.textContent = `Model ${String(model.id)} added to the route draft. Enter a route ID and save the route.`;
      routePanel.scrollIntoView({ block: 'nearest' }); if (!routeId.value) routeId.focus();
    };
    const submit = button(form, 'Save route', async () => { if (!form.reportValidity() || (modelScope.value !== 'all' && !models.length)) { routeFeedback.textContent = modelScope.value === 'all' ? 'Enter a route ID and choose an account.' : 'Enter a route ID, choose an account and add at least one complete model.'; return; }
      const id = routeId.value.trim(), submittedRevision = formRevision, routeInput = { routeId: id, accountId: accountSelect?.value, models: modelScope.value === 'all' ? 'all' : models.map((model) => ({ id: model.id.value.trim(), name: model.name.value.trim(), api: model.api.value, ...(model.context.value ? { context: Number(model.context.value) } : {}), ...(model.output.value ? { output: Number(model.output.value) } : {}) })) }; submit.dataset.mutationKey = `route.upsert:${id}`; mutationExpectations.set(submit.dataset.mutationKey, { kind: 'route', revision: submittedRevision, ...routeInput }); await context.invoke('route.upsert', routeInput); if (!current()) return;
      mutationExpectations.delete(submit.dataset.mutationKey); mutations.accepted(submit.dataset.mutationKey); if (submittedRevision !== formRevision) mutations.edit(submit.dataset.mutationKey); else submit.dataset.accepted = 'true'; routeFeedback.textContent = `Route ${id} saved.`; try { await refreshOverview(); } catch { if (current()) routeFeedback.textContent = `Route ${id} saved. Routes could not refresh; use Refresh router. The route was accepted.`; }
    }, routeFeedback); editable(form, submit);
    existing.addEventListener('change', () => { const route = routes.find((value) => value.id === existing.value); routeId.value = route ? String(route.id) : ''; if (route && accountSelect) accountSelect.value = String(route.accountId); models = []; for (const row of modelList.querySelectorAll('fieldset')) row.remove(); modelScope.value = !route || route.models === 'all' ? 'all' : 'selected'; for (const model of route && route.models !== 'all' ? rows(route.models) : [{}]) addModel(model); updateScope(); form.dispatchEvent(new Event('input', { bubbles: true })); });
    /** @param {unknown} value */
    setRoutes = (/** @type {unknown} */ value, read = mutations.beginRead()) => { routes = rows(value); for (const [key, expectation] of mutationExpectations) if (expectation.kind === 'route') { const route = routes.find((item) => item.id === expectation.routeId); const committed = route !== undefined && route.accountId === expectation.accountId && JSON.stringify(route.models) === JSON.stringify(expectation.models); const outcome = mutations.reconcile(read, key, committed); if (outcome === 'accepted' && expectation.revision !== formRevision) mutations.edit(key); if (outcome !== 'unknown') mutationExpectations.delete(key); if (submit.dataset.mutationKey === key) { submit.disabled = mutations.locked(key); if (!submit.disabled) delete submit.dataset.accepted; } } const selected = existing.value; existing.replaceChildren(); option(existing, '', 'New route'); for (const route of routes) option(existing, String(route.id), String(route.id)); existing.value = selected; };
  }
  /** @param {import('./routes.js').RouterRoute} route */
  function applyRoute(route) {
    activeRoute = route;
    for (const [id, row] of accountElements) {
      const selected = route.section === 'accounts' && route.objectId === id;
      row.classList.toggle('llm-object-selected', selected);
      const link = row.querySelector('.llm-object-link'); if (link instanceof HTMLAnchorElement) link.setAttribute('aria-current', selected ? 'page' : 'false');
    }
    if (route.section === 'accounts' && route.objectId && accountRows.size && !accountRows.has(route.objectId)) context.ui.feedback(feedback, `Provider account ${route.objectId} is not available on this router.`, 'error');
  }
  return { refresh, applyRoute, beginOverviewRead: () => mutations.beginRead(), setRoutes: (/** @type {unknown} */ value, /** @type {number|undefined} */ read) => setRoutes(value, read), hasUnknown: () => mutations.anyUnknown(), hasPending: () => Boolean(container.querySelector('button[data-pending="true"]')), canLeave: () => activeSessions.size === 0, dispose() { alive = false; mutations.clear(); renameDrafts.clear(); for (const timer of timers) window.clearTimeout(timer); timers.clear(); activeSessions.clear(); } };
}
