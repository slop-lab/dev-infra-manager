# LLM router CLI plugin

Install this client plugin with the host CLI to use `dim llm-router --help`. It connects to a router's explicit private operator connection; it does not open the service database or install a router backend.

```bash
dim llm-router overview --connection /absolute/operator.json
dim llm-router requests --connection /absolute/operator.json --active true
dim llm-router project.state --connection /absolute/operator.json --project demo --action pause
```

Project policy replacement takes `--policy-file` with an owned mode-0600 JSON file. Each operation rejects unrelated flags and validates its arguments with the same definition used by the service and Web plugin. Workspace inference principals and host issuer credentials cannot authenticate this interface.

The package also provides the standalone `dim-llm-router` executable with the same arguments (omit the `dim llm-router` prefix). This client requires no host runtime, local workspace installation or control-plane service implementation. Its host-core peer is optional and supplies only the compile-time host plugin interface; the executable's runtime dependencies are the remote client and operation contracts.
