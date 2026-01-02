# Last app container
FROM node:20-alpine

RUN apk add --no-cache openssl

WORKDIR /app

COPY server/package.json ./server/package.json
RUN cd server && npm install --omit=dev

COPY server ./server

RUN chmod +x /app/server/entrypoint.sh

ENV HOST=0.0.0.0
ENV PORT=8443
ENV PUBLIC_DIR=/app/server/public

# AUTO_TLS=1 will generate a self-signed cert (for personal/private use)
ENV AUTO_TLS=1

EXPOSE 8443

CMD ["/app/server/entrypoint.sh"]
