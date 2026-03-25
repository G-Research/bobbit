# Security Model

**This tool grants full shell access to the host machine.** The auth token is equivalent to an SSH key.

- 256-bit cryptographically random token generated on first run, persisted at `.bobbit/state/token` with mode `0600`
- All API routes and WebSocket connections require the token
- Constant-time token comparison prevents timing attacks
- IP-based rate limiting on failed auth attempts (automatic lockout)
- 5-second auth timeout on WebSocket connections
- Static file serving has directory traversal prevention (resolved path must start with static dir)
- Gateway binds to NordLynx mesh IP if available, otherwise `localhost` — never `0.0.0.0` unless explicitly requested
- TLS on by default for non-loopback addresses; disabled for localhost unless `--tls` is passed
- OAuth PKCE flow for obtaining API credentials securely
