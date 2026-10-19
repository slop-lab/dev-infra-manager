# Host mirrors development changelog

## Unreleased

Target: `0.10.0` internal-development candidate. The plugin remains part of the
matched unpublished source package set.

- Connect ordinary Git workspaces, new nested containers and optional shared CI
  to Docker Hub, npm, PyPI and APT caches through fixed protocol adapters. Keep
  cache-server deployment in the separate optional cache-server plugin, and
  select local or independently operated/NAS services through the same URL-only
  catalog. Preserve explicit package-manager settings and internal application
  HTTP routing. Private workspace UUID-fenced relays survive pause/resume,
  recreation and endpoint changes while rejecting discarded routes and upstream
  package-artifact escapes.
