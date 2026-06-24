# Roadmap Dashboard — Google Login + Vercel Deploy

This app is a single static file (`index.html`) gated behind Google Sign-In,
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
4. Open `index.html`, find this line near the top of the `<script>`:
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

---

## Step 3 — Shared team data (Vercel KV)

The app now stores the roadmap in a **shared backend** (`/api/state`) so everyone on the team sees
the same data. You must connect a free Redis store once:

1. In the **Vercel dashboard** → your `project-dashboard` project → **Storage** tab → **Create Database**.
2. Choose **KV** (Upstash Redis). Pick the free plan, a region near you, and **Connect** it to this project
   (all environments). This automatically adds the `KV_REST_API_URL` / `KV_REST_API_TOKEN` env vars.
3. **Redeploy** (Deployments → ⋯ → Redeploy, or just `git push`) so the functions pick up the new env vars.

That's it — no code changes needed. The serverless function reads those env vars automatically.

### How it works
- `GET /api/state` returns the shared roadmap; `POST /api/state` saves it.
- Every request must carry a valid Google ID token; the function verifies the signature, audience,
  and that the email is a verified `@everfit.io` account — so the domain restriction is now
  **enforced server-side**, not just in the browser.
- The app loads the shared copy on sign-in, auto-saves edits, and polls every ~12s to pick up
  teammates' changes. A small status (Saving… / Saved / Updated by …) shows in the top bar.

### Concurrency model
**Last-write-wins.** Good for a small team making occasional edits. The app only adopts a teammate's
remote version when you have no unsaved local edits, but two people editing *at the same time* can
still overwrite each other (whoever saves last wins). True real-time co-editing is a larger project.

> Local testing note: `npx serve` does NOT run the `/api` functions, so shared save won't work
> locally — it falls back to localStorage. Test the shared backend on the deployed Vercel URL,
> or run `vercel dev` (which serves the functions locally).

## How the @everfit.io restriction is enforced
- Client gate: Google button uses `hd: "everfit.io"`; the app rejects non-`everfit.io` tokens.
- Server enforcement: `/api/state` re-verifies the Google token on every read/write (Step 3).
- Using **Internal** OAuth consent (Step 1.2) makes Google enforce the Workspace boundary too.
