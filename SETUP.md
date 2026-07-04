# Subtext — Server & Phone Setup

Subtext is a PWA hosted on GitHub Pages. It works offline (phrasebook) out of the box;
live translation needs your Lemonade server reachable over Tailscale. This guide takes you
from zero to both phones translating.

## The shape of the setup

```
[Teen's phone] --Tailscale VPN--> [Strix Halo: tailscale serve (HTTPS :443) --> Lemonade (:13305)]
     |
     '-- Subtext app itself is served from GitHub Pages (works even when the server is off)
```

One Tailscale network ("tailnet"), two users. You own the tailnet and are its admin; the teen
is an invited member with their own login. Nothing about your accounts or configs is shared —
each person's devices hang off their own login. The free Personal plan covers 3 users / 100
devices.

## 1. Create your tailnet (you, once)

Go to https://login.tailscale.com/start and sign in with an identity you already have
(Google, Microsoft, Apple, or GitHub). That creates the tailnet and makes you admin.

## 2. Install Tailscale on the Strix Halo server

- **Windows:** installer from https://tailscale.com/download → run → sign in as you.
- **Linux:** `curl -fsSL https://tailscale.com/install.sh | sh` then `sudo tailscale up` → sign in as you.

Note the machine's name in the admin console (https://login.tailscale.com/admin/machines) —
you'll use it in URLs below. You can rename it to something short like `halo`.

## 3. Enable HTTPS for the tailnet (one-time)

In https://login.tailscale.com/admin/dns:

1. Make sure **MagicDNS** is enabled.
2. Click **Enable HTTPS Certificates**.

This is required: the app is served over HTTPS, and browsers refuse to let an HTTPS page call
a plain-HTTP address ("mixed content"). `tailscale serve` fixes that with a real certificate.

## 4. Front Lemonade with HTTPS

Start Lemonade Server as usual (it listens on `http://localhost:13305`). Then, on the server:

```
tailscale serve --bg http://localhost:13305
```

- `--bg` keeps it running in the background and re-applies after reboots.
- This publishes the server **only inside your tailnet** — not the public internet.
  (The public version of this command is `tailscale funnel`; don't use that one.)

Your OpenAI-compatible base URL is now:

```
https://<machine-name>.<your-tailnet>.ts.net/api/v1
```

Check `tailscale serve status` to see the exact hostname. Test from any of your devices:
opening `https://<machine>.<tailnet>.ts.net/api/v1/models` in a browser should show JSON
listing the loaded models.

### CORS check (one minute, do this once)

Browsers additionally require the server to send CORS headers before a web page may call it.
Test from any machine on the tailnet:

```
curl -si https://<machine>.<tailnet>.ts.net/api/v1/models -H "Origin: https://ct-coldboot.github.io" | grep -i access-control
```

- If you see `access-control-allow-origin: *` (or the github.io origin echoed back): you're done.
- If you see nothing: run the tiny proxy included in this repo instead, and point
  `tailscale serve` at it:

  ```
  python tools/cors-proxy.py            # listens on :8001, forwards to :13305, adds CORS
  tailscale serve --bg http://localhost:8001
  ```

## 5. Invite the teen to the tailnet

Admin console → **Users** → **Invite users** → enter their email. They accept the invite and
sign in with **their own** Google/Microsoft/Apple/GitHub account. They become a member of your
tailnet; you stay admin.

## 6. Teen's phone

1. Install **Tailscale** from the Play Store, sign in with their account, toggle the VPN on.
   It's fine to leave it on permanently — idle battery cost is near zero.
2. Open `https://<machine>.<tailnet>.ts.net/api/v1/models` in Chrome to confirm connectivity.
3. Open **https://ct-coldboot.github.io/nd-translator/** in Chrome → menu (⋮) →
   **Add to Home screen** → **Install**. Subtext now opens full-screen like a native app and
   works offline.
4. In Subtext: gear icon → set **Server address** to `https://<machine>.<tailnet>.ts.net/api/v1`,
   tap **Test connection**, pick the model from the list, done.

## 7. (Optional but recommended) Limit what the teen's devices can reach

By default, every tailnet member can reach every device. To restrict the teen to only the LLM
server: admin console → **Access Controls**, and use something like:

```jsonc
{
  "acls": [
    // you can reach everything
    {"action": "accept", "src": ["your-email@example.com"], "dst": ["*:*"]},
    // the teen can reach only the LLM server's HTTPS port
    {"action": "accept", "src": ["teen-email@example.com"], "dst": ["<machine-name>:443"]}
  ]
}
```

Replace the emails with the actual login emails shown on the Users page, and `<machine-name>`
with the server's name from the Machines page.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Status dot stays gray, "Test connection" times out | Tailscale VPN toggle is off on the phone, or the server machine is asleep |
| `/api/v1/models` works in the phone browser but the app says it can't connect | CORS — do the CORS check in step 4 |
| "Server returned 404" | Base URL is missing the `/api/v1` suffix |
| Cert warning in browser | HTTPS certificates not enabled (step 3), or MagicDNS off |
| App won't offer "Install" | It must be opened via the `https://` GitHub Pages URL, not a local file |
