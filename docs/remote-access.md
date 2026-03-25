# Remote Access via NordVPN Meshnet

Bobbit can be accessed from other devices (phone, tablet, laptop) over NordVPN's meshnet. This guide covers the setup for HTTPS, TLS trust, and PWA installation.

## Quick Start

```bash
npm run dev:nord    # Development (harness + Vite HMR)
npx bobbit --nord   # Production
```

This binds the server to your NordLynx mesh IP and enables TLS automatically.

## How It Works

1. **NordVPN Meshnet** provides a private IP (e.g. `100.x.x.x`) accessible from your other devices
2. **deSEC dynDNS** maps `yourname.dedyn.io` to the mesh IP (updated on every startup)
3. **Bobbit CA** signs TLS certs so browsers trust the HTTPS connection
4. Devices that install the CA cert get full HTTPS trust — no warnings, PWA support

## First-Time Setup

### 1. Configure deSEC (one-time)

Create `.bobbit/state/desec.json`:

```json
{
  "domain": "yourname.dedyn.io",
  "token": "<your-desec-api-token>"
}
```

Get a free domain and token at [desec.io](https://desec.io). The server updates the DNS record on every startup.

### 2. Install the CA Certificate on Remote Devices

The CA cert is at `.bobbit/state/tls/ca.crt`. The gateway also serves it at:

```
https://<mesh-ip>:3001/api/ca-cert?token=<auth-token>
```

#### Windows (Chrome/Edge)

1. Open `certmgr.msc` (Win+R → `certmgr.msc`)
2. Right-click **Trusted Root Certification Authorities > Certificates**
3. All Tasks > Import > select `ca.crt`
4. **Restart Chrome completely** (all windows)
5. Verify: `chrome://certificate-manager` — look for "Bobbit Local CA" under Trusted Root

If the CA ends up under "Personal" instead of "Trusted Root", the browser will show a security warning and `fetch()` / PWA installation will fail.

#### iOS / iPadOS

1. Download `ca.crt` from the gateway URL above (open in Safari)
2. Settings > General > VPN & Device Management > install the profile
3. Settings > General > About > Certificate Trust Settings > enable full trust for "Bobbit Local CA"

#### Android

1. Download `ca.crt`
2. Settings > Security > Encryption & credentials > Install a certificate > CA certificate
3. Confirm the warning

### 3. Access Bobbit

- **Dev mode**: `https://yourname.dedyn.io:5173` (Vite dev server with HMR)
- **Production**: `https://yourname.dedyn.io:3001` (built UI served by gateway)
- **PWA**: Install from the browser (requires trusted CA — no security warnings)

## Troubleshooting

### "Failed to fetch" in Connect dialog

The page loads but API calls fail. This means the browser loaded the page (possibly after clicking through a cert warning) but JavaScript `fetch()` rejects untrusted certs silently.

**Fix**: Install the CA cert in the correct store (Trusted Root, not Personal). Restart the browser. Verify no security warning appears in the address bar.

### "Not secure" warning / PWA won't install

Same root cause — the CA cert isn't fully trusted. Check the certificate store and restart the browser.

### Cert regeneration

If you change mesh IPs or the cert expires, delete the old cert and restart the server:

```bash
rm .bobbit/state/tls/cert.pem .bobbit/state/tls/key.pem
npm run dev:nord   # regenerates with current mesh IP + deSEC domain
```

The CA (`ca.crt`) is preserved, so devices that already trust it will trust the new cert automatically — no need to reinstall the CA.

### Vite proxy errors on startup

During `dev:nord`, the server and Vite start concurrently. Brief proxy errors are normal while the server initializes. They resolve once the server is ready.
