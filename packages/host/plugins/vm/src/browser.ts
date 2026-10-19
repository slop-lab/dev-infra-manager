import { SpiceMainConn } from "dim-spice";

const form = document.querySelector("#login");
const status = document.querySelector("#status");
if (!(form instanceof HTMLFormElement) || !(status instanceof HTMLParagraphElement)) throw new Error("invalid VM console page");
let connection: SpiceMainConn | undefined;
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void connect().catch((error: unknown) => { status.textContent = error instanceof Error ? error.message : "Console connection failed"; });
});
async function connect(): Promise<void> {
  if (!(form instanceof HTMLFormElement) || !(status instanceof HTMLParagraphElement)) return;
  const data = new FormData(form), vm = data.get("vm"), token = data.get("token");
  if (typeof vm !== "string" || typeof token !== "string") throw new Error("VM and access token are required");
  const response = await fetch("/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ vm, token }) });
  if (!response.ok) throw new Error(await response.text());
  const password = form.querySelector('input[name="token"]');
  if (password instanceof HTMLInputElement) password.value = "";
  connection?.stop();
  connection = new SpiceMainConn({ uri: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/stream/${encodeURIComponent(vm)}`,
    screen_id: "screen", message_id: "messages", onerror: (error) => { status.textContent = error.message; } });
  status.textContent = `Connected to ${vm}. Keyboard and pointer input go to this VM.`;
}
