set shell := ["bash", "-uc"]

default:
    just --list

# Build DIM from an assembled self-development workspace, install it on this host, and restart the controller.
install-workspace-build workspace:
    bash scripts/install-workspace-build.bash "{{ workspace }}"
