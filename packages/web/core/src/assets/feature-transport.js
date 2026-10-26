// @ts-check
/** @param {import('./feature-panels.js').Feature} feature @param {import('./types.js').Session} active @param {()=>boolean} current */
export function featureInvoker(feature, active, current) {
  /** @param {string} name @param {unknown} [input] @param {import('../plugin-api.js').WebPluginInvokeOptions} [options] */
  return async (name, input = {}, options) => {
    const timeout = options === undefined ? 35_000 : options?.timeoutMilliseconds;
    if (options !== undefined && (typeof options !== "object" || options === null || Object.keys(options).some((key) => key !== "timeoutMilliseconds"))
      || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 185_000) throw new Error("Invalid feature request timeout.");
    if (!current() || !feature.operations.some((operation) => operation.name === name)) throw new Error("This operation is not available to this account.");
    let response;
    try {
      response = await fetch(`/v1/extensions/${feature.id}/operations/${encodeURIComponent(name)}`, { method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", "x-dim-csrf": active.csrfToken }, body: JSON.stringify(input), signal: AbortSignal.timeout(timeout) });
    } catch (cause) {
      throw Object.assign(new Error("The operation did not return a reliable response, so its outcome is unknown. Refresh current state before retrying.", { cause }), { outcome: "unknown" });
    }
    if (!current()) throw new Error("Your session ended or workspace changed.");
    if (response.status === 401) window.dispatchEvent(new Event("dim-session-expired"));
    if (!response.ok) {
      let message = response.status === 401 ? "Your session ended. Sign in again." : response.status === 403 ? "This account does not have permission for that action." : response.status >= 500 ? "The operation did not return a reliable outcome, so its outcome is unknown. Refresh current state before retrying; your input is kept." : "The operation was rejected. Check the selected target and fields; your input is kept.";
      if ([400, 404, 409, 422].includes(response.status)) {
        try {
          const value = await response.json();
          if (value && typeof value === "object" && typeof value.error === "string" && value.error.trim() && value.error.length <= 1024) message = value.error;
        } catch { /* A rejected operation can still have an unreadable response. */ }
      }
      throw Object.assign(new Error(message), { outcome: response.status >= 500 ? "unknown" : "rejected" });
    }
    try { return await response.json(); }
    catch (cause) { throw Object.assign(new Error("The operation succeeded but its response was unreadable, so its outcome is unknown. Refresh current state before retrying.", { cause }), { outcome: "unknown" }); }
  };
}
