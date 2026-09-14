const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

function groupIsLive(groupPid) {
  try {
    process.kill(-groupPid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export function stopProcessGroup(run) {
  if (run.stopPromise) return run.stopPromise;
  run.stopPromise = (async () => {
    if (!run.groupPid || !groupIsLive(run.groupPid)) return;
    try {
      process.kill(-run.groupPid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    const termDeadline = Date.now() + 4_000;
    while (groupIsLive(run.groupPid) && Date.now() < termDeadline) await delay(50);
    if (groupIsLive(run.groupPid)) {
      try {
        process.kill(-run.groupPid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    await run.childClosed;
    const killDeadline = Date.now() + 1_000;
    while (groupIsLive(run.groupPid) && Date.now() < killDeadline) await delay(10);
  })();
  return run.stopPromise;
}
