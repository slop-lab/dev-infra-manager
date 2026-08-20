# systemd delegation

Use this provider when the nested engine reports the `systemd` cgroup driver.
The service or scope containing the engine must be created with delegation,
for example:

```ini
[Service]
Delegate=cpu memory pids
```

systemd remains the single writer for the service cgroup; Project setup owns
only descendants below the delegated namespace root. The Project-side command
is identical to the cgroupfs variant:

```bash
sudo dim-project-cgroup create agent-dind 1000 1000 cpu memory pids
```

See [`verify-systemd.bash`](verify-systemd.bash) for the executable contract
check.
