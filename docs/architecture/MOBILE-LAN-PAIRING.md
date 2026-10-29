# Mobile LAN pairing and installable PWA

The mobile surface (`/mobile`, `src/studio/ui/mobile.html` + `mobile.mjs`) is served by Studio on your PC.
By default Studio listens on `127.0.0.1` only, so a phone cannot reach it. LAN pairing is an **explicit opt-in**
that changes nothing unless you ask for it.

## Pair a phone (2 steps)

1. On the PC (phone and PC on the same WiFi):
   ```powershell
   node bin/studio.mjs serve --lan-pair          # Studio only
   node bin/studio.mjs start --lan-pair          # capture browser + Studio
   # or: $env:CAPTURE_STUDIO_LAN_PAIR='1'; node bin/studio.mjs serve
   ```
   The terminal prints a pairing URL (`http://<PC-LAN-IP>:<port>/mobile?token=...`) and a QR code.
2. On the phone, scan the QR code with the camera (or type the URL into Chrome). Studio exchanges the token for an
   `HttpOnly` cookie, drops it from the address bar and opens `/mobile`. Done. The cookie lasts 30 days.

Options: `--studio-port N` (fixed port), `--lan-host IP` (pick which PC address goes in the URL when the PC has
several adapters), `CAPTURE_STUDIO_TOKEN=<16+ chars>` (reuse your own token instead of a random one).
Windows will show a firewall prompt the first time; allow **private networks** only.

## Security model

- Off by default. Without `--lan-pair` / `CAPTURE_STUDIO_LAN_PAIR=1` the bind is still `127.0.0.1` and the default
  `local` access mode is unchanged.
- LAN-pair **requires token mode**. `startStudio({ lanPair: true })` throws if `accessMode` is not `token` or the
  token is shorter than 16 characters, before anything is started. The CLI always generates a random 144-bit token.
- Host/Origin checks stay exact-match, not wildcard: in LAN mode they accept loopback plus this PC's own non-loopback
  IPv4 addresses and hostname (`<ip>:<port>`, `<hostname>[.local]:<port>`). Any other `Host` (for example a
  DNS-rebinding name) gets `421`, any other `Origin` gets `403`, even with a valid token.
- The token grants the whole Studio API, not just `/mobile`. Treat the URL like a password, and stop Studio
  (Ctrl+C) when you are done.
- Plain HTTP on a trusted WiFi only. There is no TLS.

## Installable PWA

`/mobile` links `/mobile.webmanifest` (name "VIVIM Mobile", standalone, inline SVG icons) and registers
`/mobile-sw.js` (scope `/mobile`). The worker caches only the read-only shell (`/mobile`, `/ui/mobile.mjs`),
network-first. It never handles `/api/*` or any non-GET request, so data and every mutation always hit the live PC
(nothing is cached, queued or replayed offline). Manifest and worker are served behind the same token check.

Chrome registers service workers and offers the install prompt only in a **secure context**, and `http://<LAN-IP>`
is not one. Over plain LAN HTTP the page works normally and Chrome's menu still offers **Add to Home screen** as a
shortcut, but not offline shell caching or full install. To get the full PWA install, either:

- USB debugging: `adb reverse tcp:<port> tcp:<port>`, then open `http://localhost:<port>/mobile?token=...` on the
  phone (localhost is secure and passes the Host check), or
- `chrome://flags/#unsafely-treat-insecure-origin-as-secure` on the phone with `http://<PC-LAN-IP>:<port>` added.

## Code map

- `src/studio/server.mjs`: `lanPair` option, bind host, Host/Origin allow-list, token landing for `/mobile`, manifest/worker routes.
- `src/studio/lan-pair.mjs`: LAN address discovery, pairing URL, in-tree QR encoder (no dependency).
- `bin/commands/capture.mjs`: `--lan-pair`, `--lan-host` on `start` and `serve`.
- `src/studio/ui/manifest.webmanifest`, `src/studio/ui/mobile-sw.js`: PWA assets.
