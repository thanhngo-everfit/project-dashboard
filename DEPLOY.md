# Roadmap Dashboard — Google Login + Vercel Deploy

This app is a single static file (`roadmap-dashboard.html`) gated behind Google Sign-In,
restricted to **@everfit.io** accounts. Below are the two setup steps.

---

## Step 1 — Create a Google OAuth Client ID (~5 min)

1. Go to <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → OAuth consent screen**
   - User type: **Internal** (best — only your Google Workspace `everfit.io` users can sign in,
     enforced by Google itself). If "Internal" is greyed out, pick **External** and add test users.
   - Fill app name + support email and save.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - **Authorized JavaScript origins** — add the origins you'll use:
     - `http://localhost:3000`  ← local testing
     - `https://YOUR-APP.vercel.app`  ← add this after Step 2 gives you the URL
   - (Leave "Authorized redirect URIs" empty — Google Identity Services doesn't need it.)
   - Click **Create** and copy the **Client ID** (looks like `1234-abc.apps.googleusercontent.com`).
4. Open `roadmap-dashboard.html`, find this line near the top of the `<script>`:
   ```js
   const GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';
   ```
   Replace it with your real Client ID.

> ⚠️ `file://` does NOT work with Google login. To test locally, run a server:
> ```bash
> npx serve -l 3000 .      # then open http://localhost:3000
> ```
> Make sure `http://localhost:3000` is in the Authorized JavaScript origins.

---

## Step 2 — Deploy to Vercel (free)

### Option A — Vercel CLI (fastest)
```bash
npm i -g vercel
cd "Project Planning"
vercel            # first run: log in + accept defaults → gives a preview URL
vercel --prod     # promotes to your production *.vercel.app URL
```

### Option B — Git + Vercel dashboard
1. Push this folder to a GitHub repo.
2. At <https://vercel.com/new>, import the repo. No build settings needed (static).
3. Deploy → you get `https://YOUR-APP.vercel.app`.

### After first deploy
Go back to **Step 1.3** and add your real `https://YOUR-APP.vercel.app` origin to the
Google OAuth "Authorized JavaScript origins", then redeploy/refresh. Login will now work in production.

The root URL `/` serves the dashboard (via `vercel.json` rewrite).

---

## How the @everfit.io restriction works
- The Google button is configured with `hd: "everfit.io"` (filters the account chooser).
- On sign-in, the app checks the token's `email_verified` flag and that the email ends with
  `@everfit.io`; anything else is rejected.
- Using **Internal** OAuth consent (Step 1.2) makes Google enforce the Workspace boundary too.

### Security note (read this)
Roadmap data is stored in each browser's `localStorage` — it is **per-device, not shared**, and
there is no backend. This login is an **access gate**, not a hard security boundary: the HTML/JS is
publicly downloadable on any static host. For *enforced* access control or *shared team data*, you'd
add a backend (e.g. Vercel Serverless Functions verifying the Google token server-side + a database
like Vercel KV/Postgres). Ask if you want that upgrade.
