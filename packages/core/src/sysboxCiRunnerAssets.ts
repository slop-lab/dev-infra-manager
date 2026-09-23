export const SYSBOX_CI_RUNNER_BASE_IMAGE =
  "gitea/act_runner@sha256:578925b4bdec5f60d93b5ba766cf02f2f9f32b1c8a4ec665ddf4d53d45f683c7";

export const SYSBOX_CI_RUNNER_IMAGE =
  "dev-infra-manager-ci-runner:act-runner-minimal-v2";

export const SYSBOX_CI_REGISTRATION_HELPER_IMAGE =
  "docker.io/library/alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce";

export const SYSBOX_CI_RUNNER_CONFIG = `runner:
  capacity: 1
container:
  privileged: false
  options: ""
  valid_volumes: []
  docker_host: '-'
  force_pull: true
  require_docker: true
  bind_workdir: true
`;

export const SYSBOX_CI_RUNNER_DOCKERFILE = `FROM ${SYSBOX_CI_RUNNER_BASE_IMAGE}
COPY config.yml /etc/dim-act-runner.yml
RUN rm -f /usr/bin/git /usr/local/bin/com.docker.cli \
    && command -v act_runner \
    && command -v dockerd \
    && command -v dockerd-entrypoint.sh \
    && command -v docker \
    && ! command -v node \
    && ! command -v git
`;
