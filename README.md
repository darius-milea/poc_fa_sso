# FusionAuth SSO PoC

Proof of concept for Single Sign-On with [FusionAuth](https://fusionauth.io/) as the
identity provider. Two independent web apps share one FusionAuth session: log in to
**App 1**, then open **App 2** and you're already authenticated — no second login.

The apps and the IdP run on **three genuinely different domains** (not just different
ports on `localhost`), so this demonstrates *real cross-domain SSO*, not a same-site
shortcut.

## Architecture

```
                    ┌──────────────────────────────┐
   browser ───────► │  FusionAuth (the IdP)        │ ◄── OIDC Authorization Code + PKCE
                    │  auth.lacolhost.com:9011      │
                    │  + PostgreSQL                 │
                    └──────────────────────────────┘
                         ▲                    ▲
       top-level login   │                    │  top-level login (new tab)
              ┌──────────┴─────────┐  ┌───────┴──────────────┐
              │ App 1              │  │ App 2                │
              │ app1.localtest.me  │  │ app2.lvh.me          │
              │ :3000              │  │ :3001                │
              └────────────────────┘  └──────────────────────┘
            (registrable domain      (registrable domain
             localtest.me)            lvh.me → cross-site!)
```

- **FusionAuth + Postgres** run in Docker Compose.
- **Kickstart** (`kickstart/kickstart.json`) auto-provisions two applications, an API
  key, an admin, and a test user on first boot — zero manual clicking.
- **Both apps** are the *same* Express server (`app/server.js`) launched twice with
  different env files. Each runs the OIDC Authorization Code flow with PKCE by hand
  (no client lib) so the mechanics are visible.
- **App 1 → App 2 is a new-tab link, not an iframe.** A new tab is a *top-level*
  browsing context, so its requests to FusionAuth are first-party — which is what makes
  cross-domain SSO work. (See "iframe vs new tab" below for why the iframe doesn't.)

## Hosts (zero setup)

The three hostnames are public wildcard-DNS names that all resolve to `127.0.0.1`, on
**three different registrable domains** so they are genuinely cross-site:

| Role | Host | Registrable domain |
| --- | --- | --- |
| App 1 | `app1.localtest.me:3000` | `localtest.me` |
| App 2 | `app2.lvh.me:3001` | `lvh.me` |
| FusionAuth (IdP) | `auth.lacolhost.com:9011` | `lacolhost.com` |

No `/etc/hosts` edits needed — they resolve out of the box (needs internet for DNS). If
you're offline, add them to `/etc/hosts` pointing at `127.0.0.1` instead.

Plain HTTP is fine here: every cross-domain hop is a **top-level navigation**, so
`SameSite=Lax` cookies are sent and no HTTPS / `SameSite=None` is required.

## Prerequisites

- Docker + Docker Compose
- Node.js 20+ (for `--env-file` support and global `fetch`)
- Internet access (for the wildcard-DNS hostnames to resolve to `127.0.0.1`)

## 1. Start FusionAuth

```bash
docker compose up -d
```

First boot takes ~30–60s (DB migration + kickstart). Watch readiness:

```bash
docker compose logs -f fusionauth
```

Admin console: <http://auth.lacolhost.com:9011>  ·  login `admin@example.com` / `password`

## 2. Start the two demo apps

```bash
cd app
npm install
npm run app1   # http://app1.localtest.me:3000
```

In a second terminal:

```bash
cd app
npm run app2   # http://app2.lvh.me:3001
```

## 3. Try SSO

1. Open <http://app1.localtest.me:3000> → click **Log in with FusionAuth**.
2. Sign in as `user@example.com` / `password` (on `auth.lacolhost.com`).
3. You land back on App 1, authenticated (ID-token claims shown).
4. Click **Open App 2 in a new tab ↗**. App 2 (`app2.lvh.me`, a *different* domain)
   signs you in **automatically — no button, no login screen**. That's real cross-domain
   SSO: one login, both apps.
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

## 4. iframe vs new tab (the whole point)

App 1 shows App 2 via an **`EMBED_MODE`** toggle (`app1.env`):

- `EMBED_MODE=tab` (**default**) — an **"Open App 2 in a new tab ↗"** button
  (`target="_blank"`). A new tab is a *top-level, first-party* context.
- `EMBED_MODE=iframe` — App 2 embedded in an `<iframe>`, a *third-party* context.

Because the apps are on **different registrable domains**, the two modes now behave
**differently** (unlike a same-`localhost` setup, where both would "work"):

### ✅ New tab — works cross-domain

The new tab navigates top-level to App 2 → App 2 does `prompt=none` → top-level redirect
to FusionAuth. FusionAuth's session cookie is **first-party** to `auth.lacolhost.com`, so
it's sent; FusionAuth returns a code with no UI; App 2 logs in silently. **Verified:**
logged into App 1 on `app1.localtest.me`, opened App 2 on `app2.lvh.me`, signed in with
no button and the same `sub`.

### ⛔ iframe — breaks cross-domain

Set `EMBED_MODE=iframe` and restart App 1 to see it. Now everything the iframe needs is a
**third-party cookie**:

1. **Silent SSO breaks.** The iframe's `prompt=none` request to FusionAuth needs
   FusionAuth's session cookie. In a cross-site iframe that cookie is third-party →
   blocked/partitioned → FusionAuth sees no session → returns its login page →
   `X-Frame-Options: DENY` → blank frame.
2. **App 2 can't keep its own session.** App 2's `SameSite=Lax` cookie isn't sent on a
   cross-site *embedded* request (Lax only rides top-level navigations). You'd need
   `SameSite=None; Secure` — exactly the third-party cookie browsers are killing.

**Browser status:** Safari (ITP) blocks third-party cookies; Firefox partitions them;
Chrome is phasing them out. So cross-domain iframe SSO ranges from flaky to dead — which
is why the **default is `tab`**.

### Alternatives (all make the IdP request top-level / first-party)

| Approach | How | Works cross-domain? |
| --- | --- | --- |
| **Separate tab / window** (this PoC's default) | `target="_blank"` / `window.open`. Top-level, so cookies to FusionAuth are first-party. | ✅ Yes |
| **Full-page redirect** | Standard OIDC: navigate the whole page to `/authorize`, back to the callback. | ✅ Yes (the default flow) |
| **Popup + `postMessage`** | Open the IdP in a popup, popup posts the result back to the opener. Login "without leaving the page". | ✅ Yes |
| **Storage Access API** | Iframe calls `document.requestStorageAccess()` to use its cookies — needs a prior user gesture. | ⚠️ Partial / clunky |
| **CHIPS (partitioned cookies)** | `Partitioned` cookie attribute. | ❌ Not for SSO — session partitioned *per top site*, so it isn't shared across apps |
| **Same registrable domain** | Put both apps on subdomains of one domain + `SameSite=None`. | ✅ Yes, but requires you to control the domain layout |

**Rule of thumb:** an iframe is fine for embedding an app the user is *already* signed
into on the *same site*. It is the wrong tool for cross-domain SSO — use a tab, redirect,
or popup so the login runs top-level.

### ⚠️ Logout is not propagated (single-logout gap)

Logging out of App 1 ends the *FusionAuth SSO session* and App 1's own session, but **App
2's local session survives** — App 2 keeps showing "signed in" until its own session
expires or it re-checks FusionAuth. This PoC implements no logout propagation. Real
single-logout needs **OIDC Back-Channel Logout** (FusionAuth POSTs a logout token to each
app, which kills the matching local session) or Front-Channel Logout (subject to the same
framing/cookie caveats above).

## Config reference

| App   | Host | Client ID                              | Redirect URI                        |
| ----- | ---- | -------------------------------------- | ----------------------------------- |
| App 1 | `app1.localtest.me:3000` | `11111111-1111-1111-1111-111111111111` | `http://app1.localtest.me:3000/oauth-callback` |
| App 2 | `app2.lvh.me:3001` | `22222222-2222-2222-2222-222222222222` | `http://app2.lvh.me:3001/oauth-callback` |

Each app's host/redirect is set via `BASE_URL` (and `OTHER_APP_URL`) in its env file;
FusionAuth's URL via `FUSIONAUTH_URL`. Change these + the kickstart
`authorizedRedirectURLs`/`logoutURL` to point at your own domains.

## Reset

```bash
docker compose down -v   # wipes DB volume; next `up` re-runs kickstart
```

## ⚠️ PoC only

Hardcoded secrets, in-memory session store, plaintext DB creds, `development`
runtime mode, DB search engine. Do **not** ship any of this to production.

> **Note:** each app uses a distinct session cookie name (`sso_sid_<port>`). This
> mattered on the old same-`localhost` setup (cookies ignore port, so a shared name got
> clobbered); on separate domains they're isolated anyway, but the distinct names are
> kept so the localhost fallback still behaves.
