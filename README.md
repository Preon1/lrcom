# LRcom (Last Resort Communication)

Minimal ephemeral voice chat: open the page, enter a name, see online users, click to call, accept/reject incoming calls.

**Privacy model**: No registration, no cookies, no persistent sessions. Server keeps only in-memory presence while your WebSocket is connected. When you close the tab, your name disappears.

## How it works

- Audio uses **WebRTC** (Opus) between browsers.
- The server only does **signaling** (WebSocket) + presence.
- Media is encrypted by WebRTC (**DTLS-SRTP**).

## Important: HTTPS for microphone

Browsers only allow `getUserMedia()` (microphone) in a **secure context**:
- `https://...` (recommended), OR
- `http://localhost` (allowed for local testing)

If you access this from another machine over plain HTTP, mic permission will fail.

## Run with Docker

From this folder:

1) Create a `.env` file (recommended for Internet use):

- Copy `.env.example` to `.env` and fill in `LRCOM_TURN_HOST`, `LRCOM_TURN_SECRET`, and `LRCOM_TURN_EXTERNAL_IP`.

2) Start:

```bash
docker compose up --build
```

Then open:

- Local machine: `https://localhost:8443`

For LAN/Internet use, put it behind HTTPS (recommended) or mount certs and enable HTTPS in the container.

## HTTPS (default)

By default, the container generates a **self-signed** certificate (personal/private use). Your browser will show a warning unless you add the cert to your trust store.

If you want a “clean” trusted setup, put LRcom behind a proper reverse proxy with a real certificate.

### Using your own cert

Provide a key+cert and set env vars:

- `TLS_KEY_PATH=/certs/key.pem`
- `TLS_CERT_PATH=/certs/cert.pem`

Example compose override:

```yaml
services:
  lrcom:
    volumes:
      - ./certs:/certs:ro
    environment:
      - AUTO_TLS=0
      - TLS_KEY_PATH=/certs/key.pem
      - TLS_CERT_PATH=/certs/cert.pem
```

### LAN access (important)

If you access LRcom via your LAN IP (e.g. `https://192.168.1.50:8443`), the certificate must include that IP in **SANs**.

Set (Windows example):

```bash
setx LRCOM_TLS_SANS "DNS:localhost,IP:127.0.0.1,IP:192.168.1.50"
```

## TURN server

`docker-compose.yml` includes a coturn service for NAT traversal. LRcom generates time-limited TURN credentials from `TURN_SECRET`.

Set these env vars (recommended):

- `LRCOM_TURN_SECRET`: shared secret used by both LRcom and coturn
- `LRCOM_TURN_HOST`: hostname/IP that browsers should use to reach TURN (e.g. `localhost`, your LAN IP, or your domain)
- `LRCOM_TURN_EXTERNAL_IP`: often required when coturn runs in Docker so relay addresses are reachable (set to your host LAN/public IP)

Example:

```bash
setx LRCOM_TURN_SECRET "a-strong-random-secret"
setx LRCOM_TURN_HOST "192.168.1.50"
setx LRCOM_TURN_EXTERNAL_IP "192.168.1.50"
```

### If you can only open ~10 UDP ports

TURN needs a relay port range for media. This repo defaults to **10 UDP relay ports**:

- `49160-49169/udp`

You can change it:

```bash
setx LRCOM_TURN_MIN_PORT "49160"
setx LRCOM_TURN_MAX_PORT "49169"
```

Tradeoff: fewer relay ports means fewer simultaneous TURN-relayed calls. Rough rule of thumb: a 2-person call typically consumes ~2 relay ports total (one per participant), so 10 ports supports about ~5 concurrent calls that require TURN.

## Security notes (practical)

- WebRTC encrypts media, but you still must protect **signaling** with HTTPS/WSS to reduce MITM risk.
- This project intentionally does not log calls or store user data.
- Names are limited to simple characters and must be unique while online.

## Limitations

- No user authentication (by design).
- No identity verification beyond TLS to the server (so don’t treat the displayed name as strongly authenticated).
