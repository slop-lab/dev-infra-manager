# Managed control-plane deployment

Private service image composition for the selected Git repository, review, merge
policy, workflow and CI integration plugins. This package is not published to npm.
It owns deployment entrypoints and cross-service credential checks; individual
plugins do not depend on it and can be installed independently.
