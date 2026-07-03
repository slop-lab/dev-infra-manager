# systemd Deployment

This directory contains a production-oriented controller unit template.

Install flow:

```bash
pnpm install --frozen-lockfile
pnpm run build
sudo mkdir -p /opt/dev-infra-manager /etc/dev-infra-manager /var/lib/dev-infra-manager
sudo rsync -a dist package.json pnpm-lock.yaml /opt/dev-infra-manager/
sudo cp config.example.json /etc/dev-infra-manager/config.json
sudo cp deploy/systemd/dev-infra-controller.service /etc/systemd/system/dev-infra-controller.service
sudo systemctl daemon-reload
sudo systemctl enable --now dev-infra-controller.service
```

Adjust `/etc/dev-infra-manager/config.json` before starting the service.

The service runs as root because the controller performs Docker deployment operations and may manage host-mounted job filesystems. Use a dedicated service account only after the required Docker, mount, and state directory permissions are explicitly delegated.
