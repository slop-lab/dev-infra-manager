FROM node:22-alpine

RUN apk add --no-cache docker-cli

WORKDIR /app
COPY server.mjs /app/server.mjs

EXPOSE 7100
CMD ["node", "/app/server.mjs"]
