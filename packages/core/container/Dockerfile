ARG NODE_IMAGE=node:24.13.1-bookworm-slim@sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2
FROM ${NODE_IMAGE}
RUN useradd --create-home --uid 10001 dim-broker
COPY package/ /opt/dim-control-plane/
USER dim-broker
ENTRYPOINT ["node", "/opt/dim-control-plane/dist/brokerCli.js"]
