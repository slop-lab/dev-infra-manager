FROM python:3.13.7-slim@sha256:5f55cdf0c5d9dc1a415637a5ccc4a9e18663ad203673173b8cda8f8dcacef689
RUN groupadd --system --gid 10001 dim-scheduler \
 && useradd --system --uid 10001 --gid dim-scheduler --home-dir /var/lib/dim-scheduler dim-scheduler \
 && install -d -o dim-scheduler -g dim-scheduler -m 0700 /var/lib/dim-scheduler
COPY protocol.py storage.py store.py server.py /opt/dim-scheduler/
RUN chmod 0555 /opt/dim-scheduler/protocol.py /opt/dim-scheduler/storage.py /opt/dim-scheduler/store.py /opt/dim-scheduler/server.py
USER 10001:10001
WORKDIR /var/lib/dim-scheduler
VOLUME ["/var/lib/dim-scheduler"]
ENTRYPOINT ["python3", "/opt/dim-scheduler/server.py", "/var/lib/dim-scheduler/config.json"]
