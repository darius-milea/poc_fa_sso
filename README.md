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
4. Open <http://localhost:3001> → click **Log in** — FusionAuth recognizes the existing
   session and redirects you straight back, **already logged in**. That's SSO.
5. **Log out** from either app hits FusionAuth's OIDC logout, ending the shared session.

## Seeded credentials

| Purpose        | Email               | Password   |
| -------------- | ------------------- | ---------- |
| Admin console  | `admin@example.com` | `password` |
| SSO test user  | `user@example.com`  | `password` |

## 4. Iframe SSO behavior

App 1's home page embeds App 2 in an `<iframe>` (driven by `EMBED_APP_URL` in
`app1.env`). This surfaces the classic embedded-SSO trade-offs:

- **App 2's own pages frame fine** — the Express app sets no `X-Frame-Options`.
- **Silent SSO works inside the iframe.** If FusionAuth already has a session, the
  embedded app's `/login` → `/oauth2/authorize` returns a code with **no login page to
  render**, so the iframe logs in with zero user interaction. All three origins are
  `localhost` (cookies ignore port), so they're the *same site* — the FusionAuth
  session cookie is sent into the frame. Observed: App 2 shows "Signed in as
  user@example.com" inside the iframe while App 1 (top window) is still logged out.
- **Interactive login inside the iframe is blocked.** FusionAuth's hosted login page
  returns `X-Frame-Options: DENY`. When no session exists, the browser refuses to
  render the login page in the frame (and FusionAuth's page busts out to the top
  window). So an embedded app can *only* SSO silently — it can never show the
  FusionAuth login form in-frame.

**Takeaways for real deployments:**

- Cross-*site* embedding (different registrable domains, e.g. `app1.com` framing
  `auth.example.com`) makes the FusionAuth session cookie *third-party* — modern
  browsers block/partition it, so even silent SSO fails. This PoC only works because
  everything is `localhost`.
- To support real interactive login from an embedded context, use a **redirect/popup**
  flow that breaks out of the frame, not an in-frame login page.

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
