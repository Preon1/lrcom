#!/bin/sh
set -eu

PORT="${PORT:-8443}"
HOST="${HOST:-0.0.0.0}"
AUTO_TLS="${AUTO_TLS:-0}"
TLS_DIR="${TLS_DIR:-/tmp/lrcom-certs}"
TLS_KEY_PATH="${TLS_KEY_PATH:-}"
TLS_CERT_PATH="${TLS_CERT_PATH:-}"
TLS_SANS="${TLS_SANS:-DNS:localhost,IP:127.0.0.1}"

if [ "$AUTO_TLS" = "1" ] && { [ -z "$TLS_KEY_PATH" ] || [ -z "$TLS_CERT_PATH" ]; }; then
  mkdir -p "$TLS_DIR"
  key="$TLS_DIR/key.pem"
  cert="$TLS_DIR/cert.pem"

  if [ ! -f "$key" ] || [ ! -f "$cert" ]; then
    # Self-signed cert for personal/private usage.
    # Browsers will warn unless you trust it; still provides an encrypted channel.
    openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout "$key" -out "$cert" \
      -days 365 \
      -subj "/CN=localhost" \
      -addext "subjectAltName=$TLS_SANS" >/dev/null 2>&1
  fi

  export TLS_KEY_PATH="$key"
  export TLS_CERT_PATH="$cert"
fi

export PORT HOST

exec node /app/server/index.js
