import type { HostProfile } from "./config.js";
import { dim } from "./selectedCommand.js";
import { array, json, parsePlugins, record, text } from "./scenarioValues.js";

export async function preflightHost(profile: HostProfile, installedSourceSha: string): Promise<{ readonly ok: boolean; readonly details: readonly string[] }> {
  const details: string[] = [];
  const version = await dim(profile.name, ["--version"], true), actualVersion = version.stdout.trim();
  details.push(actualVersion === profile.expectedHostVersion
    ? `host-version=${/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9._-]{1,180})?$/.test(actualVersion) ? actualVersion : "validated selection"}`
    : "host-version does not match the reviewed selected-host profile");
  const doctor = await dim(profile.name, ["doctor", "--json"], true), checks = array(json(doctor.stdout, "doctor output"), "doctor output");
  let doctorReady = checks.length > 0;
  for (const value of checks) {
    const check = record(value, "doctor check"), name = text(check["name"], "doctor check name"), ok = check["ok"] === true;
    doctorReady &&= ok;
    text(check["detail"], "doctor check detail");
    details.push(`${ok ? "ok" : "unavailable"}: ${/^[a-zA-Z0-9 ._-]{1,80}$/.test(name) ? name : "host check"}`);
  }
  const plugins = parsePlugins((await dim(profile.name, ["plugins"], true)).stdout);
  for (const required of profile.requiredPlugins) details.push(plugins.some(({ name }) => name === required) ? `plugin=${required}` : `missing-plugin=${required}`);
  const listed = array(json((await dim(profile.name, ["list", "--json"], true)).stdout, "workspace list"), "workspace list");
  const workspaceAvailable = !listed.some((value) => record(value, "workspace")["name"] === profile.workspace);
  details.push(workspaceAvailable ? `workspace-name available=${profile.workspace}` : `workspace-name already exists=${profile.workspace}`);
  details.push(`operator-declared-source-sha=${installedSourceSha}`);
  return { ok: version.exitCode === 0 && actualVersion === profile.expectedHostVersion && doctor.exitCode === 0 && doctorReady
    && profile.requiredPlugins.every((required) => plugins.some(({ name }) => name === required)) && workspaceAvailable, details };
}
