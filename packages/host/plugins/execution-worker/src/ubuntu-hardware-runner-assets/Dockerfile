FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS node
FROM ubuntu:24.04@sha256:561618e2c15bf2397621dd04f96926663a3b5616c189cf7e38db7e82f5c538ea AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY guest-exit.c /tmp/guest-exit.c
RUN cc -static -O2 -Wall -Wextra -Werror /tmp/guest-exit.c -o /tmp/guest-exit
FROM ubuntu:24.04@sha256:561618e2c15bf2397621dd04f96926663a3b5616c189cf7e38db7e82f5c538ea
RUN apt-get update && apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils cloud-image-utils genisoimage libstdc++6 libatomic1 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY ubuntu.qcow2 /opt/dim/ubuntu.qcow2
COPY --from=build /tmp/guest-exit /opt/dim/tools/guest-exit
COPY --from=node /usr/local/bin/node /opt/dim/tools/node
COPY supervisor.ts guest-run.bash /opt/dim/
COPY dim-native-qemu-run /usr/local/bin/dim-native-qemu-run
RUN printf '{"type":"module"}\n' > /opt/dim/package.json && chmod 0555 /usr/local/bin/dim-native-qemu-run /opt/dim/tools/* && chmod 0444 /opt/dim/ubuntu.qcow2 /opt/dim/*.ts /opt/dim/*.bash
LABEL io.dim.execution.runner-profile="ubuntu-hardware-v1"
