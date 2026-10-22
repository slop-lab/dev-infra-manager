# LLM router CLI plugin

Install this client plugin with the host CLI to use `dim llm-router --help`. It connects to a router's explicit private operator connection; it does not open the service database or install a router backend.

```bash
dim llm-router account.create --connection /absolute/operator.json --provider codex
# Use the returned generated ID to start device login:
dim llm-router account.login.start --connection /absolute/operator.json --account ACCOUNT_ID
dim llm-router account.rename --connection /absolute/operator.json --account ACCOUNT_ID --reference "Work account"
dim llm-router overview --connection /absolute/operator.json
dim llm-router requests --connection /absolute/operator.json --active true
dim llm-router project.state --connection /absolute/operator.json --project demo --action pause
```

Enrollment generates a unique account ID and provider label unless `--account` or `--reference` is supplied. Labels can be changed later while account IDs, credential partitions and usage attribution remain stable.

To make a router available through a controller to DIM Web, select its private
operator connection on that controller:

```bash
dim llm-router connect --connection /absolute/controller/operator.json
dim llm-router console describe --json
```

The router may run on another control-plane machine. Selection stores only an
owned mode-0600 pointer in `$XDG_CONFIG_HOME/dim/llm/operator-selection.json` (or
`~/.config/dim/llm/operator-selection.json`); the connection and key remain private
on the controller. Without that pointer, discovery uses `dim/llm/operator.json`
under the same configuration root. Trusted host processes can instead set
`DIM_LLM_ROUTER_OPERATOR_CONNECTION_FILE` to an absolute operator connection.
An issuer connection for workspace attachments cannot authenticate operator actions.

Discovery publishes allowed operation descriptors and an opaque `selectionId`.
This identifies the selected endpoint and operator authority independently of
Native Git or deployment generations. Every bridged invocation requires
`--expected-selection HASH`; changed endpoint, actor or credentials require a
Web feature reconnect. The fingerprint is checked against the exact connection
and key snapshot used for the HTTP request. Web sends JSON through bounded stdin
(`--input -`), keeping provider API keys out of process arguments. Read-only
operator actors expose only their permitted read operations.

Project policy replacement takes `--policy-file` with an owned mode-0600 JSON file. Each operation rejects unrelated flags and validates its arguments with the same definition used by the service and Web plugin. Workspace inference principals and host issuer credentials cannot authenticate this interface.

The package also provides the standalone `dim-llm-router` executable with the same arguments (omit the `dim llm-router` prefix). This client requires no host runtime, local workspace installation or control-plane service implementation. Its host-core peer is optional and supplies only the compile-time host plugin interface; the executable's runtime dependencies are the remote client and operation contracts.
