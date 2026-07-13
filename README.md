# FusionAuth SSO PoC

Proof of concept for Single Sign-On with [FusionAuth](https://fusionauth.io/) as the
identity provider. Two independent web apps share one FusionAuth session: log in to
**App 1**, then open **App 2** and you're already authenticated — no second login.

## Architecture

```
                ┌────────────────────┐
   browser ───► │  FusionAuth (9011) │ ◄── OIDC Authorization Code + PKCE
                │  + PostgreSQL      │
                └────────────────────┘
                     ▲          ▲
        OIDC login   │          │  OIDC login
                ┌────┴───┐  ┌───┴────┐
                │ App 1  │  │ App 2  │
                │ :3000  │  │ :3001  │
                └────────┘  └────────┘
```

- **FusionAuth + Postgres** run in Docker Compose.
- **Kickstart** (`kickstart/kickstart.json`) auto-provisions two applications, an API
  key, an admin, and a test user on first boot — zero manual clicking.
- **Both apps** are the *same* Express server (`app/server.js`) launched twice with
  different env files. Each runs the OIDC Authorization Code flow with PKCE by hand
  (no client lib) so the mechanics are visible.

## Prerequisites

- Docker + Docker Compose
- Node.js 20+ (for `--env-file` support and global `fetch`)

## 1. Start FusionAuth

```bash
docker compose up -d
```

First boot takes ~30–60s (DB migration + kickstart). Watch readiness:

```bash
docker compose logs -f fusionauth
```

Admin console: <http://localhost:9011>  ·  login `admin@example.com` / `password`

## 2. Start the two demo apps

```bash
cd app
npm install
npm run app1   # http://localhost:3000
```

In a second terminal:

```bash
cd app
npm run app2   # http://localhost:3001
```

## 3. Try SSO

1. Open <http://localhost:3000> → click **Log in with FusionAuth**.
2. Sign in as `user@example.com` / `password`.
3. You land back on App 1, authenticated (ID-token claims shown).
4. Open <http://localhost:3001> — **no button, no login screen**. App 2 signs you in
   automatically. That's real SSO: one login, both apps.
5. **Log out** from an app ends the FusionAuth SSO session and that app's own session —
   but **not** the other app's local session (see the single-logout gap below).

### Why App 2 is automatic but App 1 isn't

App 2 sets `AUTO_SSO=1` (`app2.env`). On landing while logged out, it immediately does a
**silent auth** request — `/oauth2/authorize` with `prompt=none`. If FusionAuth already
has a session (because you logged into App 1), it returns an auth code with no UI, so
App 2 logs in with zero clicks. App 1 has `AUTO_SSO` unset, so it stays a normal landing
page with a login button — it's the entry point where you actually authenticate.

> **FusionAuth 1.53 caveat:** the OIDC spec says `prompt=none` with no session should
> redirect back with `error=login_required` (letting the app show its own button). FusionAuth
> instead renders its hosted login page. So the app's graceful "no session → show button"
> fallback works against a spec-compliant IdP, but with FusionAuth an `AUTO_SSO` app with
> **no** existing session lands the user on the FusionAuth login page (or, in an iframe, a
> blank frame — see below). The seamless "already logged in" path works with FusionAuth.

## Seeded credentials

| Purpose        | Email               | Password   |
| -------------- | ------------------- | ---------- |
| Admin console  | `admin@example.com` | `password` |
| SSO test user  | `user@example.com`  | `password` |

## 4. Iframe SSO behavior

App 1's home page embeds App 2 in an `<iframe>` (driven by `EMBED_APP_URL` in
`app1.env`). This surfaces the classic embedded-SSO trade-offs:

- **App 2's own pages frame fine** — the Express app sets no `X-Frame-Options`.
- **Silent SSO works inside the iframe.** With `AUTO_SSO` on, the embedded App 2 fires a
  `prompt=none` request on load; if FusionAuth already has a session it returns a code
  with **no login page to render**, so the iframe logs in with zero user interaction.
  All three origins are `localhost` (cookies ignore port), so they're the *same site* —
  the FusionAuth session cookie is sent into the frame. Observed: after logging into
  App 1, its embedded App 2 shows "Signed in as user@example.com" with no button.
- **Interactive login inside the iframe is blocked.** FusionAuth's hosted login page
  returns `X-Frame-Options: DENY`. So when **no** session exists, the iframe's silent
  attempt renders the login page → browser refuses to frame it → blank frame. An
  embedded app can therefore *only* SSO silently; it can never show the FusionAuth login
  form in-frame.

### ⛔ This iframe pattern does NOT work in production

**It only works here because every origin is `localhost`.** Cookies are keyed by host
(they ignore port), so `localhost:3000`, `:3001`, and `:9011` are all the *same site* →
every cookie is first-party. Change any of them to a real, different domain and it breaks.

In a real deployment (`app1.com` framing `app2.com`, IdP at `auth.example.com`),
everything the iframe depends on becomes a **third-party cookie**:

1. **Silent SSO breaks.** The iframe's `prompt=none` request to FusionAuth needs
   FusionAuth's session cookie. Cross-site iframe → that cookie is third-party →
   blocked/partitioned → FusionAuth sees no session → returns its login page →
   `X-Frame-Options: DENY` → blank frame.
2. **The embedded app can't even keep its own session.** A `SameSite=Lax` cookie (this
   PoC) is *not sent at all* on a cross-site embedded request. You'd need
   `SameSite=None; Secure` — precisely the third-party cookie browsers are removing.

**Browser status:** Safari (ITP) already blocks third-party cookies; Firefox partitions
them; Chrome is phasing them out. So cross-domain iframe SSO degrades from flaky to dead.

### Alternatives (what to actually use)

The fix is to make the IdP request run **top-level / first-party** instead of embedded:

| Approach | How | Works cross-domain? |
| --- | --- | --- |
| **Separate tab / window** | Open App 2 in its own tab (`target="_blank"` or `window.open`). It's a top-level context, so its cookies to FusionAuth are first-party. | ✅ Yes |
| **Full-page redirect** | Standard OIDC: navigate the whole page to `/authorize`, come back to the callback. | ✅ Yes (the default flow) |
| **Popup + `postMessage`** | Open the IdP in a popup, popup posts the result back to the opener. Login "without leaving the page". | ✅ Yes |
| **Storage Access API** | Iframe calls `document.requestStorageAccess()` to use its own cookies — needs a prior user gesture. | ⚠️ Partial / clunky |
| **CHIPS (partitioned cookies)** | `Partitioned` cookie attribute. | ❌ Not for SSO — the session is partitioned *per top site*, so it isn't shared across apps |
| **Same registrable domain** | Put both apps on subdomains of one domain (`a.corp.com`, `b.corp.com`) or behind one reverse proxy, with `SameSite=None`. | ✅ Yes, but requires you to own/control the domain layout |

> **Does opening another tab help? Yes.** A new tab (like a full-page redirect or a
> popup) is a *top-level* browsing context. When it hits FusionAuth, FusionAuth's
> session cookie is first-party to the IdP's own domain, so it's always sent — no
> third-party-cookie problem. This is exactly why every real SSO flow navigates the page
> (or opens a popup) to the IdP and **never** uses an iframe for the login step.

**Rule of thumb:** an iframe is fine for embedding an app the user is *already* signed
into on the *same site*. It is the wrong tool for cross-domain SSO.

#### Try both in the PoC: `EMBED_MODE`

App 1 has an `EMBED_MODE` toggle (`app1.env`):

- `EMBED_MODE=iframe` (default) — App 2 rendered in an `<iframe>`.
- `EMBED_MODE=tab` — App 2 shown as an **"Open App 2 in a new tab"** button
  (`target="_blank"`), the top-level / first-party pattern.

> **Important:** on `localhost` **both modes behave identically** — silent SSO works
> either way, because every origin is same-site so cookies are first-party regardless.
> This toggle exists to show the two *code patterns* side by side. To actually *observe*
> the iframe breaking while the tab keeps working, you need real, different domains over
> HTTPS with `SameSite=None` cookies — which this localhost PoC deliberately doesn't set
> up. The `tab` mode is what you'd ship; the `iframe` mode is the teaching artifact.

### ⚠️ Logout is not propagated (single-logout gap)

Logging out of App 1 ends the *FusionAuth SSO session* and App 1's own session, but **App
2's local session survives** — App 2 keeps showing "signed in" until its own session
expires or it re-checks FusionAuth. This PoC implements no logout propagation. Real
single-logout needs **OIDC Back-Channel Logout** (FusionAuth POSTs a logout token to each
app, which kills the matching local session) or Front-Channel Logout (subject to the same
framing/cookie caveats above).

## Config reference

| App   | Port | Client ID                              | Redirect URI                        |
| ----- | ---- | -------------------------------------- | ----------------------------------- |
| App 1 | 3000 | `11111111-1111-1111-1111-111111111111` | `http://localhost:3000/oauth-callback` |
| App 2 | 3001 | `22222222-2222-2222-2222-222222222222` | `http://localhost:3001/oauth-callback` |

## Reset

```bash
docker compose down -v   # wipes DB volume; next `up` re-runs kickstart
```

## ⚠️ PoC only

Hardcoded secrets, in-memory session store, plaintext DB creds, `development`
runtime mode, DB search engine. Do **not** ship any of this to production.

> **Note:** both apps run on `localhost`, and cookies ignore port — so each app uses a
> distinct session cookie name (`sso_sid_<port>`) to avoid clobbering the other's
> session (which would sign you out on refresh).
