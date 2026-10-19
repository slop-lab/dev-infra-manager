# Control-plane CI coordinator

`@slop-lab/dim-control-plane-plugin-ci` owns the durable execution aggregate, queue, worker leases, cancellation/retry, diagnostics and private result publication. It starts no Docker containers or VMs and requires no host core or workspace store.

Install it explicitly for the control plane:

```sh
dim installer install control-plane plugin @slop-lab/dim-control-plane-plugin-ci@0.10.0
```

The package exports `controlPlanePlugin` for `dim-control-plane`. Its private plugin configuration contains `service` (the CI service configuration), `stateDirectory`, `readinessToken`, `activationToken`, `expectedGenerationId`, and optional `listen: {host,port}`. It requires explicit Git authority credentials and registered worker identities/profiles. No worker or workflow compiler is implicitly installed or started.

The `dim-ci-service` executable is the installed service-image entrypoint. It provides configuration/state checks, generation activation, readiness and serving with the installer's fixed secret/state paths. Deployment remains the installer's atomic service-pair operation; installing this package alone does not deploy it.

Trusted host execution is supplied separately by `@slop-lab/dim-host-plugin-ci-worker`. Shared transport/configuration schemas belong to `@slop-lab/dim-contracts-ci`; the coordinator does not import a host worker or backend.
