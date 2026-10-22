// @ts-check
/** @typedef {{username:string,roles:string[]}} Account */
/** @param {import('./types.js').Session} session @param {HTMLElement} container */
export function mountAccountManagement(session, container) {
  const region = document.createElement("section"), heading = document.createElement("h3"), status = document.createElement("p"), table = document.createElement("div"), result = document.createElement("section");
  region.className = "account-management"; table.className = "feature-table";
  heading.textContent = "Manage browser accounts"; status.setAttribute("role", "status");
  container.append(region); region.append(heading, status, table);
  const dialog = container.closest("dialog");
  const current = () => region.isConnected && (!(dialog instanceof HTMLDialogElement) || dialog.open);
  const refresh = document.createElement("button"); refresh.type = "button"; refresh.className = "button button-secondary"; refresh.textContent = "Refresh accounts"; region.append(refresh);
  const form = document.createElement("form"); form.setAttribute("aria-label", "Manage browser account"); region.append(form, result);
  /** @param {string} label @param {HTMLInputElement|HTMLSelectElement} input */
  const field = (label, input) => { const wrapper = document.createElement("label"), title = document.createElement("span"); wrapper.className = "field"; title.textContent = label; input.setAttribute("aria-label", label); wrapper.append(title, input); form.append(wrapper); return input; };
  const operation = document.createElement("select"); field("Account action", operation);
  for (const [value, text] of [["add", "Add account"], ["set-roles", "Change account roles"], ["reset-password", "Reset account password"], ["remove", "Remove account"]]) { const option = document.createElement("option"); option.value = value ?? ""; option.textContent = text ?? ""; operation.append(option); }
  const username = document.createElement("input"); field("Account username", username); username.required = true; username.maxLength = 256; username.autocomplete = "off";
  const roles = document.createElement("fieldset"), legend = document.createElement("legend"); roles.className = "account-role-options"; legend.textContent = "Account roles"; roles.append(legend); form.append(roles);
  /** @type {Map<string,HTMLInputElement>} */ const checks = new Map();
  for (const role of ["read", "operator", "reviewer", "account-admin"]) { const label = document.createElement("label"), checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = role === "read"; checkbox.setAttribute("aria-label", `Grant ${role}`); label.append(checkbox, document.createTextNode(role)); roles.append(label); checks.set(role, checkbox); }
  const password = document.createElement("input"); field("Your current password", password); password.type = "password"; password.autocomplete = "current-password"; password.required = true;
  const submit = document.createElement("button"); submit.type = "submit"; submit.className = "button"; submit.textContent = "Save account"; form.append(submit);
  let pending = false, accepted = false, uncertain = false, signInRequired = false, loadVersion = 0;
  /** @type {Account[]} */ let accounts = [];
  const paintForm = () => { roles.hidden = !["add", "set-roles"].includes(operation.value); for (const control of [operation, username, password, ...checks.values()]) control.disabled = pending || signInRequired; submit.disabled = pending || accepted || uncertain || signInRequired; };
  /** @param {string} action @param {Account} account */
  const select = (action, account) => { if (pending || signInRequired) return; operation.value = action; username.value = account.username; for (const [role, check] of checks) check.checked = account.roles.includes(role); accepted = false; result.replaceChildren(); paintForm(); password.focus(); };
  const paintAccounts = () => {
    const listing = document.createElement("table"), head = document.createElement("thead"), title = document.createElement("tr");
    for (const name of ["Username", "Roles", "Actions"]) { const cell = document.createElement("th"); cell.scope = "col"; cell.textContent = name; title.append(cell); } head.append(title); listing.append(head);
    const body = document.createElement("tbody");
    for (const account of accounts) { const row = document.createElement("tr"), name = document.createElement("td"), granted = document.createElement("td"), actions = document.createElement("td"); name.textContent = account.username; granted.textContent = account.roles.join(", ");
      for (const [action, label] of [["set-roles", "Edit roles"], ["reset-password", "Reset password"], ["remove", "Remove"]]) { const button = document.createElement("button"); button.type = "button"; button.className = "button button-secondary"; button.textContent = label ?? ""; button.disabled = pending || signInRequired; button.addEventListener("click", () => select(action ?? "set-roles", account)); actions.append(button); }
      row.append(name, granted, actions); body.append(row);
    } listing.append(body); table.replaceChildren(listing);
  };
  /** @param {unknown} value @returns {Account[]} */
  const parseAccounts = (value) => { if (!Array.isArray(value)) throw new Error("Invalid account response"); return value.map((account) => { if (!account || typeof account !== "object" || typeof account.username !== "string" || !Array.isArray(account.roles) || !account.roles.every((/** @type {unknown} */ role) => typeof role === "string" && ["read", "operator", "reviewer", "account-admin"].includes(role))) throw new Error("Invalid account response"); return { username: account.username, roles: account.roles }; }); };
  async function load() {
    if (pending || signInRequired) return;
    const version = ++loadVersion; refresh.disabled = true;
    try { const response = await fetch("/v1/accounts", { credentials: "same-origin", signal: AbortSignal.timeout(15_000) }); if (!response.ok) throw new Error("Could not refresh accounts. Check your access and sign in again if it changed."); const body = await response.json(); const loaded = parseAccounts(body.accounts); if (!current() || version !== loadVersion) return; accounts = loaded; if (uncertain) status.textContent = "Accounts refreshed. Inspect the current state before making another change."; uncertain = false; paintAccounts(); paintForm(); }
    catch (error) { if (current() && version === loadVersion) status.textContent = error instanceof Error ? error.message : "Could not refresh accounts."; }
    finally { if (current() && version === loadVersion) refresh.disabled = signInRequired; }
  }
  refresh.addEventListener("click", () => void load());
  form.addEventListener("input", () => { if (!pending) { accepted = false; paintForm(); } });
  operation.addEventListener("change", paintForm);
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); if (pending || accepted || uncertain || signInRequired || !form.reportValidity()) return;
    const action = operation.value, target = username.value, selectedRoles = [...checks].filter(([, check]) => check.checked).map(([role]) => role);
    if (["add", "set-roles"].includes(action) && !selectedRoles.length) { status.textContent = "Select at least one role."; return; }
    if (["remove", "reset-password"].includes(action) && !window.confirm(`${action === "remove" ? "Remove" : "Reset the password for"} ${target}? Their existing sessions will end.`)) { password.value = ""; status.textContent = "Account change dismissed."; return; }
    const currentPassword = password.value; password.value = ""; ++loadVersion; pending = true; refresh.disabled = true; status.textContent = "Saving account…"; paintForm(); paintAccounts(); result.replaceChildren();
    try {
      const response = await fetch("/v1/accounts", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-dim-csrf": session.csrfToken }, body: JSON.stringify({ operation: action, username: target, currentPassword, ...(["add", "set-roles"].includes(action) ? { roles: selectedRoles } : {}) }), signal: AbortSignal.timeout(30_000) });
      const body = await response.json();
      if (!response.ok) { if (response.status === 429) { if (current()) status.textContent = "Authentication is busy. Wait a moment, enter your current password again, and retry."; return; } if (![400, 401, 403, 409].includes(response.status)) throw new Error("Account update could not be confirmed."); if (current()) status.textContent = typeof body.error === "string" ? body.error : "Account change was rejected."; return; }
      accepted = true;
      const updated = parseAccounts(body.accounts); if (!current()) return;
      accounts = updated; accepted = true; signInRequired = body.signInRequired === true; status.textContent = `Account ${target}: ${action} saved. Changes apply immediately.`;
      if (typeof body.password === "string") { const label = document.createElement("label"), title = document.createElement("span"), generated = document.createElement("input"), copy = document.createElement("button"), feedback = document.createElement("p"); title.textContent = "Generated password"; generated.setAttribute("aria-label", "Generated password"); generated.value = body.password; generated.readOnly = true; label.className = "field"; label.append(title, generated); copy.type = "button"; copy.className = "button button-secondary"; copy.textContent = "Copy generated password"; feedback.setAttribute("role", "status"); copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(generated.value); feedback.textContent = "Password copied."; } catch { generated.focus(); generated.select(); feedback.textContent = "Password selected. Copy it with your keyboard."; } }); const hint = document.createElement("p"); hint.textContent = "This password is shown once. Save it before closing this dialog."; result.append(label, copy, feedback, hint); }
      if (signInRequired) { const hint = document.createElement("p"), signIn = document.createElement("button"); hint.textContent = "Your account changed and your session ended. Save any generated password, then sign in again."; signIn.type = "button"; signIn.className = "button"; signIn.textContent = "Sign in again"; signIn.addEventListener("click", () => window.dispatchEvent(new Event("dim-session-expired"))); result.append(hint, signIn); }
    } catch { if (current()) { uncertain = true; status.textContent = "Could not confirm the account update. It may have been saved. Refresh accounts to inspect the current state before retrying."; } }
    finally { pending = false; password.value = ""; if (current()) { paintForm(); paintAccounts(); refresh.disabled = signInRequired; } }
  });
  dialog?.addEventListener("close", () => { password.value = ""; result.replaceChildren(); if (signInRequired && region.isConnected) window.dispatchEvent(new Event("dim-session-expired")); }, { once: true });
  void load();
}
