// @ts-check
/** @typedef {import('@slop-lab/dim-contracts-ci/query').ExecutionSummary} Job */
/** @typedef {{id:string,taskType:string,executionKind:string,phase:string}} Task */
/** @typedef {{id:string,state:string,executionKind:string,available?:boolean,job?:Job|Task}} WorkerSlot */
/** @typedef {{id:string,observedConnected?:boolean,lastSeenAt?:number,slots:WorkerSlot[]}} Worker */
/** @typedef {{ui:import('@slop-lab/dim-web/plugin-api').WebPluginUi,invoke:(name:string,input:Record<string,unknown>)=>Promise<unknown>,isCurrent:()=>boolean,openJob:(parent:HTMLElement,job:Job)=>void}} CapacityContext */
/** @param {HTMLElement} container @param {CapacityContext} context */
export function createWorkerCapacity(container, context) {
  const { ui, invoke, isCurrent, openJob } = context;
  let version = 0;
  function setup() {
    const details = document.createElement('details'); details.append(ui.element('summary', 'Set up execution workers'));
    details.append(ui.element('p', 'Install the execution-worker host plugin on the host that will run jobs. Worker capacity is configured by an operator; installing the plugin alone does not start workers.'));
    details.append(ui.element('p', 'Configure reviewed container, VM or task slots in the execution service, deploy that configuration, then run control-plane connect to write the matching private worker.json. Each worker needs its own configured identity and state directory.'));
    details.append(ui.element('p', 'On the selected worker host, start the generated configuration:'), ui.element('pre', 'dim execution worker /absolute/path/to/worker.json', 'log-output'));
    details.append(ui.element('p', 'Keep that process running, or supervise it as a host service. Remote workers need connectivity to the configured service endpoints. Idle slots describe reservations; they do not prove that a worker process is polling.'));
    const guide = ui.element('a', 'Execution worker setup guide'); guide.href = 'https://github.com/slop-lab/dev-infra-manager/blob/development/docs/guides/ci-runners.md'; guide.target = '_blank'; guide.rel = 'noopener noreferrer'; details.append(guide);
    return details;
  }
  return async () => {
    const request = ++version;
    try {
      const workers = /** @type {Worker[]} */ (await invoke('workers.list', {}));
      if (!isCurrent() || request !== version) return;
      container.replaceChildren(ui.element('h3', 'Configured workers'));
      if (!workers.length) { container.append(ui.element('p', 'No execution workers configured. Jobs will remain queued until matching capacity is configured and its worker is started.'), setup()); return; }
      const slots = workers.flatMap((worker) => worker.slots.map((slot) => ({worker, slot})));
      const headings = ['Worker', 'Connection', 'Slot', 'State', 'Execution kind', 'Current work', 'Details'];
      const table = ui.table(headings, slots.map(({worker, slot}) => [worker.id, worker.observedConnected === true ? 'Observed' : worker.observedConnected === false ? 'Not observed' : 'Unknown', slot.id, `${slot.state}${slot.available === false ? ' / unavailable' : ''}`, slot.executionKind, !slot.job ? 'None' : 'jobName' in slot.job ? `${slot.job.jobName} · ${slot.job.projectId}/${slot.job.repositoryId}` : `${slot.job.taskType} / ${slot.job.executionKind}`, '']));
      table.classList.add('execution-worker-table');
      const rows = table.querySelectorAll('tbody tr');
      slots.forEach(({slot}, index) => {
        for (const [column, cell] of [...(rows[index]?.children ?? [])].entries()) if (cell instanceof HTMLElement) cell.dataset.label = headings[column] ?? '';
        const cell = rows[index]?.lastElementChild, job = slot.job;
        if (cell instanceof HTMLElement && job && 'jobName' in job) openJob(cell, job);
      });
      container.append(table, setup());
    } catch {
      if (isCurrent() && request === version) { container.replaceChildren(ui.element('h3', 'Worker capacity')); const message = ui.element('p'); ui.feedback(message, 'Worker capacity read is unavailable. The selected execution result above is unchanged. Retry capacity independently; configured slots and worker connectivity could not be confirmed.', 'error'); container.append(message); }
    }
  };
}
