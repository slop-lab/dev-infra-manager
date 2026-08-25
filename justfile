set shell := ["bash", "-uc"]

default:
    just --list

# Clone DIM production sources, build and install them on this host, and restart the controller.
install-local:
    bash scripts/install-source-build.bash
