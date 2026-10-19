# Host mirrors development changelog

## Unreleased

Target: `0.10.0` internal-development candidate. The plugin remains part of the
matched unpublished source package set.

- Automatically attach host-owned Docker/APT caches to ordinary Git workspaces
  when the exact optional plugin is installed. Keep cache ownership and image
  selection in the plugin, preserve internal application HTTP routing, and
  supply read-only defaults to nested containers and shared CI. Stable private
  relays survive pause/resume and cache replacement while workspace UUID fencing
  closes discarded routes. Verify real nested Debian/Ubuntu cold, warm and
  unavailable-cache behavior without changing installed services.
