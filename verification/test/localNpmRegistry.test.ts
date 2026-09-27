import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const registryHelper = resolve(workspaceRoot, "verification/scripts/lib/local-npm-registry.bash");
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local npm registry publication", () => {
  it("publishes prerelease tarballs under the non-release dim-local tag", async () => {
    // Given
    const root = await mkdtemp(resolve(tmpdir(), "dim-local-registry-test-"));
    fixtureRoots.push(root);
    const tools = resolve(root, "tools");
    const argumentsFile = resolve(root, "npm-arguments");
    await mkdir(tools);
    await writeFile(resolve(tools, "npm"), '#!/usr/bin/env bash\nprintf "%s\\n" "$@" >"$DIM_TEST_ARGUMENTS"\n');
    await chmod(resolve(tools, "npm"), 0o755);

    // When
    const result = spawnSync(
      "/usr/bin/bash",
      [
        "-c",
        'set -euo pipefail; source "$1"; DIM_LOCAL_REGISTRY_URL="http://127.0.0.1:49123"; dim_publish_to_local_registry "$2"',
        "bash",
        registryHelper,
        resolve(root, "dim-core-0.8.0-local-test.tgz")
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${tools}:/usr/bin:/bin`,
          DIM_TEST_ARGUMENTS: argumentsFile
        }
      }
    );

    // Then
    expect(result.status, result.stderr).toBe(0);
    expect((await readFile(argumentsFile, "utf8")).split("\n").filter(Boolean)).toEqual([
      "publish",
      resolve(root, "dim-core-0.8.0-local-test.tgz"),
      "--registry",
      "http://127.0.0.1:49123",
      "--tag",
      "dim-local"
    ]);
  });

  it("secures mutation and cleans up each randomized registry lifecycle", async () => {
    // Given
    const root = await mkdtemp(resolve(tmpdir(), "dim-local-registry-security-"));
    fixtureRoots.push(root);
    const packageDirectory = resolve(root, "package");
    const scenario = resolve(root, "scenario.bash");
    const evidence = resolve(root, "evidence");
    await mkdir(packageDirectory);
    await writeFile(
      resolve(packageDirectory, "package.json"),
      JSON.stringify({ name: "@slop-lab/registry-security-test", version: "0.0.0-test" })
    );
    await writeFile(resolve(packageDirectory, "index.js"), "export const verified = true;\n");
    await writeFile(
      scenario,
      `#!/usr/bin/env bash
set -euo pipefail
source "$1"
trap dim_stop_local_npm_registry EXIT

package_root="$2"
work_root="$3"
evidence_file="$4"
tarball="$(npm pack "$package_root" --pack-destination "$work_root" --silent)"
tarball="$work_root/$tarball"

first="$work_root/first"
mkdir -m 700 "$first"
dim_start_local_npm_registry "$first"
first_url="$DIM_LOCAL_REGISTRY_URL"
first_username="$DIM_LOCAL_REGISTRY_USERNAME"
first_password="$DIM_LOCAL_REGISTRY_PASSWORD"
first_pid="$DIM_LOCAL_REGISTRY_PID"

anonymous_npmrc="$work_root/anonymous.npmrc"
printf 'registry=%s\\n' "$DIM_LOCAL_REGISTRY_URL" >"$anonymous_npmrc"
chmod 600 "$anonymous_npmrc"
registration_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \\
  --request PUT "$DIM_LOCAL_REGISTRY_URL/-/user/org.couchdb.user:intruder" \\
  --header 'Content-Type: application/json' \\
  --data '{"_id":"org.couchdb.user:intruder","name":"intruder","password":"intruder-password","type":"user","roles":[]}')"
if env -u NODE_AUTH_TOKEN -u NPM_TOKEN NPM_CONFIG_USERCONFIG="$anonymous_npmrc" \\
  npm_config_registry="$DIM_LOCAL_REGISTRY_URL" npm publish "$tarball" \\
  --registry "$DIM_LOCAL_REGISTRY_URL" --tag dim-local >/dev/null 2>&1; then
  anonymous_publish=accepted
else
  anonymous_publish=rejected
fi

dim_publish_to_local_registry "$tarball"
anonymous_read="$(NPM_CONFIG_USERCONFIG="$anonymous_npmrc" npm_config_registry="$DIM_LOCAL_REGISTRY_URL" \\
  npm view '@slop-lab/registry-security-test@0.0.0-test' version --registry "$DIM_LOCAL_REGISTRY_URL")"
npm unpublish '@slop-lab/registry-security-test@0.0.0-test' --force \\
  --registry "$DIM_LOCAL_REGISTRY_URL" >/dev/null

config_mode="$(stat -c '%a' "$first/verdaccio.yaml")"
htpasswd_mode="$(stat -c '%a' "$first/htpasswd")"
npmrc_mode="$(stat -c '%a' "$first/npmrc")"
storage_mode="$(stat -c '%a' "$first/registry-storage")"
closed_signup="$(grep -c 'max_users: -1' "$first/verdaccio.yaml")"
loopback_listener="$(grep -c "listen: 127.0.0.1:\${first_url##*:}" "$first/verdaccio.yaml")"
dim_stop_local_npm_registry

if kill -0 "$first_pid" >/dev/null 2>&1; then
  stopped_process=no
else
  stopped_process=yes
fi
if curl --silent --fail --max-time 1 "$first_url/" >/dev/null 2>&1; then
  stopped_listener=no
else
  stopped_listener=yes
fi
if [[ -e "$first/verdaccio.yaml" || -e "$first/htpasswd" || -e "$first/npmrc" || \\
      -e "$first/registry-storage" || -e "$first/verdaccio.log" ]]; then
  artifacts_removed=no
else
  artifacts_removed=yes
fi

second="$work_root/second"
mkdir -m 700 "$second"
dim_start_local_npm_registry "$second"
second_url="$DIM_LOCAL_REGISTRY_URL"
second_username="$DIM_LOCAL_REGISTRY_USERNAME"
second_password="$DIM_LOCAL_REGISTRY_PASSWORD"
dim_stop_local_npm_registry

cat >"$evidence_file" <<EOF
registration_status=$registration_status
anonymous_publish=$anonymous_publish
anonymous_read=$anonymous_read
closed_signup=$closed_signup
loopback_listener=$loopback_listener
config_mode=$config_mode
htpasswd_mode=$htpasswd_mode
npmrc_mode=$npmrc_mode
storage_mode=$storage_mode
random_port=$([[ "$first_url" != "$second_url" && "$first_url" =~ ^http://127\\.0\\.0\\.1:[0-9]+$ ]] && printf yes || printf no)
random_username=$([[ "$first_username" != "$second_username" && "$first_username" == dim-publisher-* ]] && printf yes || printf no)
random_password=$([[ "$first_password" != "$second_password" && \${#first_password} -ge 24 ]] && printf yes || printf no)
stopped_process=$stopped_process
stopped_listener=$stopped_listener
artifacts_removed=$artifacts_removed
EOF
`
    );
    await chmod(scenario, 0o700);

    // When
    const result = spawnSync("/usr/bin/bash", [scenario, registryHelper, packageDirectory, root, evidence], {
      encoding: "utf8",
      timeout: 180_000
    });

    // Then
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const observations = new Map(
      (await readFile(evidence, "utf8")).trim().split("\n").map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
    );
    expect(observations.get("registration_status")).not.toMatch(/^2/);
    expect(observations.get("anonymous_publish")).toBe("rejected");
    expect(observations.get("anonymous_read")).toBe("0.0.0-test");
    expect(observations.get("closed_signup")).toBe("1");
    expect(observations.get("loopback_listener")).toBe("1");
    expect(observations.get("config_mode")).toBe("600");
    expect(observations.get("htpasswd_mode")).toBe("600");
    expect(observations.get("npmrc_mode")).toBe("600");
    expect(observations.get("storage_mode")).toBe("700");
    expect(observations.get("random_port")).toBe("yes");
    expect(observations.get("random_username")).toBe("yes");
    expect(observations.get("random_password")).toBe("yes");
    expect(observations.get("stopped_process")).toBe("yes");
    expect(observations.get("stopped_listener")).toBe("yes");
    expect(observations.get("artifacts_removed")).toBe("yes");
  }, 190_000);
});
