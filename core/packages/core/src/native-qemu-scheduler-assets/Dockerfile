FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
WORKDIR /usr/local/lib/dim
COPY dist/*.js ./
RUN groupadd --gid 10003 dim-service \
 && useradd --uid 10003 --gid 10003 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin dim-service \
 && install -d -o 10003 -g 10003 -m 0700 /var/lib/dim-native-qemu \
 && chmod 0444 ./*.js && chmod 0555 ./nativeQemuServiceCli.js
USER 10003:10003
EXPOSE 8080
ENTRYPOINT ["node", "/usr/local/lib/dim/nativeQemuServiceCli.js"]
