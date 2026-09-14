set shell := ["bash", "-uc"]

default:
    just --list

# Clone and build DIM production sources, package them, and build the trusted workspace image.
prepare-local:
    bash scripts/prepare-source-build.bash

# Install a prepared local package bundle without restarting the controller.
install-local:
    bash scripts/install-source-build.bash

# Restart the managed controller with the currently installed DIM package set.
restart-controller:
    if command -v mise >/dev/null 2>&1; then mise exec -- dim controller restart; else dim controller restart; fi
