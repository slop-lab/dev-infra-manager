// @ts-check
import { mountAccountManagement } from "./account-management.js";
/** @param {string} value */
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
/** @param {import('./types.js').Session} session @param {HTMLElement} container */
export function showAccountAccess(session, container) {
  container.replaceChildren();
  /** @param {string} tag @param {string} text */
  const element = (tag, text) => { const node = document.createElement(tag); node.textContent = text; return node; };
  container.append(element("p", `Signed in as ${session.username}. Browser access and the service's reviewer identity are separate.`));
  const roles = document.createElement("ul");
  const descriptions = /** @type {Array<[string, string]>} */ ([["read", "Inspect workspaces, results and review evidence"], ["operator", "Manage workspaces, services and eligible promotions"], ["reviewer", "Approve or revoke reviews required from the configured reviewer"], ["account-admin", "Manage browser accounts and their roles"]]);
  for (const [name, description] of descriptions) {
    roles.append(element("li", `${session.roles.includes(name) ? "Enabled" : "Not granted"}: ${name} — ${description}`));
  }
  container.append(roles);
  if (session.roles.includes("account-admin")) { mountAccountManagement(session, container); return; }
  const authority = session.accountAdministration;
  if (!authority) {
    container.append(element("p", "Ask the console owner to configure browser access on the console server. Account permissions cannot be changed from this browser.")); return;
  }
  container.append(element("h3", "Manage browser access"), element("p", "Run these commands in a trusted terminal on the console server as the owner of its configuration. Browser sessions cannot grant permissions."));
  /** @param {string} label @param {string[]} args */
  const command = (label, args) => {
    const field = document.createElement("label"), input = document.createElement("input"), copy = document.createElement("button"), feedback = element("p", "");
    field.className = "field"; field.append(element("span", label)); input.readOnly = true; input.value = [...authority.command, args[0] ?? "list", "--config", authority.configPath, ...args.slice(1)].map(quote).join(" "); field.append(input);
    copy.type = "button"; copy.className = "button button-secondary"; copy.textContent = `Copy ${label.toLowerCase()}`;
    feedback.setAttribute("role", "status");
    copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(input.value); feedback.textContent = "Command copied."; } catch { input.focus(); input.select(); feedback.textContent = "Command selected. Copy it with your keyboard."; } });
    container.append(field, copy, feedback);
  };
  command("List browser accounts", ["list"]);
  command("Enable account administration for this account", ["set-roles", "--roles", [...session.roles, "account-admin"].join(","), "--", session.username]);
  if (!session.roles.includes("reviewer")) command("Enable review access for this account", ["set-roles", "--roles", [...session.roles, "reviewer"].join(","), "--", session.username]);
  command("Create a separate reviewer account", ["add", "--roles", "read,reviewer", "--", "reviewer"]);
  container.append(element("p", "After changing accounts, restart the console server and sign in again. With install-local, run: systemctl --user restart dim-web.service. Password reset and account removal are available through account --help."));
}
