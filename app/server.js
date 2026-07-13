import crypto from "node:crypto";
import express from "express";
import session from "express-session";

const {
  PORT = 3000,
  APP_NAME = "SSO Demo App",
  CLIENT_ID,
  CLIENT_SECRET,
  FUSIONAUTH_URL = "http://localhost:9011",
  SESSION_SECRET = "change-me",
  EMBED_APP_URL = "",
} = process.env;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("CLIENT_ID and CLIENT_SECRET are required (see app1.env / app2.env)");
  process.exit(1);
}

const REDIRECT_URI = `http://localhost:${PORT}/oauth-callback`;
const AUTHORIZE_URL = `${FUSIONAUTH_URL}/oauth2/authorize`;
const TOKEN_URL = `${FUSIONAUTH_URL}/oauth2/token`;
const USERINFO_URL = `${FUSIONAUTH_URL}/oauth2/userinfo`;
const LOGOUT_URL = `${FUSIONAUTH_URL}/oauth2/logout`;

const app = express();
app.use(
  session({
    // Distinct cookie name per app. Cookies ignore port, so both apps live on the
    // `localhost` domain — sharing the default `connect.sid` name would let each app
    // clobber the other's session cookie, logging you out on refresh.
    name: `sso_sid_${PORT}`,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax" },
  })
);

const base64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const page = (title, body) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:640px;margin:3rem auto;padding:0 1rem;line-height:1.5}
  .card{border:1px solid #ddd;border-radius:12px;padding:1.5rem;box-shadow:0 1px 4px rgba(0,0,0,.05)}
  h1{margin-top:0}
  a.btn{display:inline-block;background:#ff5722;color:#fff;padding:.6rem 1.2rem;border-radius:8px;text-decoration:none;margin-right:.5rem}
  a.btn.alt{background:#455a64}
  pre{background:#f5f5f5;padding:1rem;border-radius:8px;overflow:auto}
  code{background:#f5f5f5;padding:.1rem .3rem;border-radius:4px}
  .embed{margin-top:2rem;border-top:1px solid #eee;padding-top:1rem}
  .embed iframe{width:100%;height:420px;border:1px solid #ccc;border-radius:8px}
  .embed .hint{font-size:.85rem;color:#666}
</style></head><body><div class="card">${body}</div></body></html>`;

// Optional embedded second app (SSO-in-iframe demo). App 1 sets EMBED_APP_URL.
const embedSection = () =>
  EMBED_APP_URL
    ? `<div class="embed">
         <h3>Embedded app (iframe) — SSO behavior</h3>
         <p class="hint">Below is <code>${EMBED_APP_URL}</code> rendered in an iframe.
            If FusionAuth already has a session, the embedded app logs in silently.
            If it needs the hosted login page, the browser blocks it from framing
            (<code>X-Frame-Options</code> / <code>frame-ancestors</code>) — that's the
            key iframe-SSO caveat. Open devtools console to see the framing error.</p>
         <iframe src="${EMBED_APP_URL}" title="Embedded app"></iframe>
       </div>`
    : "";

// Home: show login state
app.get("/", (req, res) => {
  const other = PORT == 3000 ? "http://localhost:3001" : "http://localhost:3000";
  if (req.session.user) {
    res.send(
      page(
        APP_NAME,
        `<h1>${APP_NAME}</h1>
         <p>✅ Signed in as <strong>${req.session.user.email}</strong></p>
         <p>Now open <a href="${other}">the other app</a> — you'll be logged in automatically (SSO).</p>
         <h3>ID token claims</h3>
         <pre>${JSON.stringify(req.session.user, null, 2)}</pre>
         <a class="btn alt" href="/logout">Log out</a>
         ${embedSection()}`
      )
    );
  } else {
    res.send(
      page(
        APP_NAME,
        `<h1>${APP_NAME}</h1>
         <p>🔒 Not signed in.</p>
         <a class="btn" href="/login">Log in with FusionAuth</a>
         <p style="margin-top:1rem">Other app: <a href="${other}">${other}</a></p>
         ${embedSection()}`
      )
    );
  }
});

// Start Authorization Code + PKCE flow
app.get("/login", (req, res) => {
  const state = base64url(crypto.randomBytes(16));
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(
    crypto.createHash("sha256").update(codeVerifier).digest()
  );
  req.session.state = state;
  req.session.codeVerifier = codeVerifier;

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email offline_access",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  res.redirect(`${AUTHORIZE_URL}?${params}`);
});

// OAuth callback: exchange code for tokens
app.get("/oauth-callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || state !== req.session.state) {
    return res.status(400).send(page("Error", "<h1>Invalid state or missing code</h1>"));
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: req.session.codeVerifier,
  });

  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) {
      return res
        .status(500)
        .send(page("Token error", `<h1>Token exchange failed</h1><pre>${JSON.stringify(tokens, null, 2)}</pre>`));
    }

    const userRes = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const claims = await userRes.json();

    req.session.user = claims;
    req.session.idToken = tokens.id_token;
    delete req.session.state;
    delete req.session.codeVerifier;
    res.redirect("/");
  } catch (err) {
    res.status(500).send(page("Error", `<h1>Callback failed</h1><pre>${err}</pre>`));
  }
});

// Local logout + FusionAuth SSO logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    // FusionAuth redirects to this app's configured `logoutURL` (see kickstart).
    // We pass only client_id — sending post_logout_redirect_uri would require it
    // to be pre-registered in the app's authorized redirect URLs.
    const params = new URLSearchParams({ client_id: CLIENT_ID });
    res.redirect(`${LOGOUT_URL}?${params}`);
  });
});

app.listen(PORT, () => {
  console.log(`${APP_NAME} listening on http://localhost:${PORT}`);
});
