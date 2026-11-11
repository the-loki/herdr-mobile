# 0003 — One pairing token, loopback by default

**Status:** accepted · 2026-11-10

## Context

The client can drive coding agents, so it is a remote code execution surface.
herdr has no authentication of its own: anyone who can open the socket can do
anything. Options ranged from “trust the network” to the relay's design
(enrolled per-device credentials, P-256 ECDH, AES-GCM frames over
WebSocket).

## Decision

- **A single bearer token**, generated on first start (32 random bytes, hex) and
  written to `<state>/token` with mode `0600`. Compared with
  `crypto.timingSafeEqual`; a length mismatch is rejected without throwing.
- Accepted as `Authorization: Bearer`, `?token=` (the pairing link), or the
  session cookie it is exchanged for. Rotating it means deleting the file.
- Cookie: `HttpOnly; SameSite=Strict; Path=/; Max-Age=30d`, plus `Secure` when
  the configured public URL is HTTPS.
- **Bind `127.0.0.1` by default.** A phone needs an explicit `--host 0.0.0.0`,
  Tailscale Serve, or a TLS reverse proxy.
- CSRF: every write must be `Content-Type: application/json` (a cross-site HTML
  form cannot set it), on top of `SameSite=Strict`.
- Response headers: CSP `default-src 'self'` (all script external, no inline),
  `frame-ancestors 'none'`, `nosniff`, `no-referrer`, `no-store`.
- The browser reaches an **allowlist** of herdr methods through `src/api.mjs`;
  `server.stop`, `plugin.*`, `layout.*` and the rest are not routable.

## Consequences

- Transport security is the deployer's job (Tailscale or a TLS proxy). No
  application-layer encryption, so a TLS-terminating proxy sees plaintext —
  documented in the README rather than hidden.
- One token means one trust domain: no per-device revocation, no read-only
  device. Accepted for a single-operator tool; it is fog on the map if the
  project ever grows.
- Losing the token file means re-pairing; there is no recovery flow by design.
