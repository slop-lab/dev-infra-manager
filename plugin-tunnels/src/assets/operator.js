// @ts-check
/** @param {string} id */
function element(id) { const value = document.getElementById(id); if (!value) throw new Error(`missing element ${id}`); return value; }
/** @param {unknown} value @returns {value is Record<string,unknown>} */
const object = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {string} url @param {string} [method] @param {Record<string,unknown>} [body] @returns {Promise<unknown>} */
async function api(url, method = "GET", body) {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`); return response.json();
}
/** @param {unknown} error */
function show(error) { element("error").textContent = error instanceof Error ? error.message : String(error); }
async function refresh() {
  const routes = await api("/v1/routes"), grants = await api("/v1/grants");
  if (!object(routes) || !Array.isArray(grants)) throw new Error("invalid operator response");
  element("routes").replaceChildren(); element("grants").replaceChildren();
  for (const [name, route] of Object.entries(routes)) {
    if (!object(route) || typeof route.protocol !== "string" || typeof route.host !== "string" || typeof route.port !== "number") throw new Error("invalid route");
    row("routes", name, `${name} → ${route.protocol} ${route.host}:${route.port}`, "Remove");
  }
  for (const grant of grants) {
    if (!object(grant) || typeof grant.token !== "string" || typeof grant.workspaceName !== "string" || typeof grant.route !== "string" || typeof grant.localPort !== "number") throw new Error("invalid workspace grant");
    row("grants", grant.token, `${grant.workspaceName} → ${grant.route} (localhost:${grant.localPort})`, "Revoke");
  }
}
/** @param {string} kind @param {string} key @param {string} label @param {string} action */
function row(kind, key, label, action) {
  const line = document.createElement("p"), text = document.createElement("span"), button = document.createElement("button");
  text.textContent = label; button.textContent = action;
  button.onclick = () => { void api(`/v1/${kind}/${encodeURIComponent(key)}`, "DELETE").then(refresh).catch(show); };
  line.append(text, button); element(kind).append(line);
}
const form = element("add");
if (!(form instanceof HTMLFormElement)) throw new Error("route form missing");
/** @param {SubmitEvent} event */
form.onsubmit = (event) => {
  event.preventDefault(); const fields = new FormData(form);
  void api("/v1/routes", "POST", { name: fields.get("name"), protocol: fields.get("protocol"), host: fields.get("host"), port: Number(fields.get("port")) }).then(refresh).catch(show);
};
void refresh().catch(show);
