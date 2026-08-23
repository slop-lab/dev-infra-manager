# Single application repository

DIM-specific lifecycle code lives under `.dim/`. It creates an unprivileged
agent service and a private rootless DinD sidecar. There is intentionally no
`.dim/repos.yml`, branch protection, additional repository, or secret-bearing
service in this example.
