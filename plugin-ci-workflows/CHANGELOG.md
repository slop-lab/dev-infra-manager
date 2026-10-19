# Changelog

## Unreleased

- Jobs can request selected Project repositories within the imported CI allowlist.
  Reviews and executions bind exact commit/tree snapshots, and jobs run from
  `/workspace/<repositoryId>` without receiving repository credentials.
