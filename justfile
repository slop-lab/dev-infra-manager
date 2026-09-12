set shell := ["bash", "-uc"]

default:
    just --list

# Clone and build DIM production sources, rebuild the trusted workspace image, install the CLI, and restart the controller.
install-local:
    bash scripts/install-source-build.bash
