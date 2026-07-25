FROM docker:29.1.3-dind

RUN apk add --no-cache busybox-extras curl
COPY start.sh /usr/local/bin/start-example-dev
RUN chmod +x /usr/local/bin/start-example-dev

ENTRYPOINT ["/usr/local/bin/start-example-dev"]
