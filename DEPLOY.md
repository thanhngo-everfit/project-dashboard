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

---

## Step 4 — Jira "Design ETA" sync (admin only)

The **Jira Sync** button (top bar, visible only to `thanhngo@everfit.io`) pulls the
**Design ETA** field from Jira into each linked project's **design work end date**.

For each project that has a **Jira link** set, the app extracts the issue key
(`/browse/KEY-123`, `?selectedIssue=KEY-123`, or a bare `KEY-123`), asks the backend for
that issue's **Design ETA**, and sets it as the End date of the project's design work
(creating the design work if none exists). A "Last Jira sync" timestamp is stored and shown.

### One-time setup (Vercel env vars)
1. Create an Atlassian API token: <https://id.atlassian.com/manage-profile/security/api-tokens>.
2. In the **Vercel dashboard** → project → **Settings → Environment Variables**, add:
   - `JIRA_BASE_URL` — e.g. `https://everfit.atlassian.net`
   - `JIRA_EMAIL` — the Atlassian account email that owns the token
   - `JIRA_API_TOKEN` — the API token from step 1
   - `JIRA_DESIGN_ETA_FIELD` *(optional)* — the Design ETA field id (design work **end**),
     e.g. `customfield_10666`. If omitted, the field **named "Design ETA"** is auto-detected.
   - `JIRA_DESIGN_START_FIELD` *(optional)* — the Design Start field id (design work **start**),
     e.g. `customfield_12752`. If omitted, the field **named "Design Start"** is auto-detected.
3. **Redeploy** so the function picks up the env vars.

### Linked delivery assignees
For each JPD idea (PLAN item), the sync reads its **delivery links** ("Polaris work item link" —
the delivery panel) to find the linked **Epics**, then collects the assignees of the **work inside
those Epics** — the child tasks/bugs and their sub-tasks (via `parent in (...)`), **not** the Epic's
own assignee. Their avatars show (deduped) under the project name on the timeline.

The **People** view (👤 tab) is driven by **worklog authors** — the person who actually *logged* each
hour, not the ticket assignee (often a lead/placeholder). It lists everyone who logged time, the
projects they worked on, and hours per project. No config needed.

To stay within the serverless function timeout while returning **complete** data, the sync is split:
`action:'sync'` fetches design fields per idea and returns each idea's delivery-epic keys; the client
then calls `action:'people'` in **small batches of epics** (bounded per call) and aggregates the
assignees + worklog-author hours across all batches. No single request does enough work to time out.

### Project detail panel & delivery progress
Clicking an **existing** project (timeline bar or Marketing row) opens a **right-side detail panel**
(Jira-style slide-over) instead of the edit modal. It shows the project's details, design status,
people, links, and a **Delivery progress** section: an on-demand call to `POST /api/jira {action:'delivery',
key}` resolves the JPD item's delivery epics and returns every child task/bug + sub-task with its status
category (To Do / In Progress / Done), rendered as an overall progress bar plus a per-epic breakdown.
In the panel you **edit inline** — click any editable field (name, status, timeline, priority, team,
size, promotion, open scale, tags, Jira link, note) to edit it in place; changes save on commit.
Creating a new project, and the timeline row's **✎ Edit** action, still use the center modal.

Each sync also stores a **delivery completion %** per project — computed by **story points** across the
child tasks/sub-tasks in its linked epics (done+in-QA vs total points), falling back to **card count**
when the tickets have no points. The timeline shows a **NN% badge + green (Done) / amber (In QA) line** on
the project bar. Story-point field is auto-detected by name; override with `JIRA_STORY_POINTS_FIELD`
(e.g. `customfield_10016`) in Vercel env vars if auto-detect picks the wrong one.

### Auto-sync
The dashboard also **auto-syncs from Jira every 15 minutes** for anyone who has it open
(on load, then on a timer). The cadence is coordinated across all viewers via a shared
`lastJiraSync` timestamp, so it fires ~once per interval regardless of how many people are
watching. Auto-sync applies changes silently (no review popup); the manual **Jira Sync**
button (admin only) still opens the tick-to-apply review.

### Notes
- Auth is enforced server-side: `action:"sync"` needs a valid Google token for **any**
  verified `@everfit.io` account (so auto-sync works for everyone). The debug helpers
  (`action:"fields"` / `action:"raw"`) remain **admin-only**; everyone else gets `403`.
- To find the field id (if auto-detect fails), the endpoint supports
  `POST /api/jira {"action":"fields","query":"eta"}` which lists matching Jira fields.
- Local `npx serve` does not run `/api`; test on the deployed URL or with `vercel dev`.

---

## App sections (Home hub)

After login you land on a **Home hub** with three workspaces (top nav switches between them, click the
title to return home):
- **Roadmap** — the delivery timeline + Jira sync (unchanged).
- **Organization** — the squad org chart + **Manage people** (moved out of the Roadmap).
- **Onboarding** — onboard new hires with **stackable role-based templates** (Product/General + Function
  templates like QA, BA, Backend…). Each template is a checklist; a hire's list is the union of their
  assigned templates, tracked with checkboxes and a completion %. Admin (`thanhngo@everfit.io`) manages
  templates and hires; everyone can view. Stored in `state.onboarding` and saved via a targeted
  `patchOnboarding` merge.

## Admin · Permissions (delegated access)

The **Home hub** shows an **🔐 Admin** card to the super-admin (`thanhngo@everfit.io`) only.
It opens a permissions page where the super-admin can grant teammates access to specific areas:

- **Onboarding** — manage templates, hires and schedules.
- **People** — edit the people directory & squads.
- **Evaluations** — view & edit performance evaluations.
- **Jira sync** — run Jira sync and import data.

Grants are stored in `state.access = { "<email>": ["onboarding", ...] }` and saved via a targeted
`patchAccess` action (super-admin only). Access is **enforced server-side**: `patchPeople`, `patchEvals`
and `patchOnboarding` accept the super-admin *or* anyone holding the matching grant (`api/state.js`
`allowArea`). Tribe/squad **structure changes** and **version history/restore** remain super-admin-only
and are **not** delegatable. In the client, `can('<area>')` gates each feature; `isAdmin()` still means
the super-admin.

## Step 5 — Organization view & AI performance evaluation (admin only)

The **🏛️ Organization** tab shows an org chart (Squad Leads → their squads → members, from the
People directory). Click any member to open their **detail & performance** modal:

- **Working history** — Jira worklog hours, projects, and a per-day calendar, filtered by review period.
- **Performance score + per-criterion insights** — role-based criteria, scored 1–5 with an insight and
  your comment each, plus an overall score and summary. Reviewed **by period** (quarters).
- **AI insights** — the **✨ Generate AI insights** button sends the member's worklog history, Slack
  activity, your notes, and their self-evaluation to OpenAI and fills in scores + insights, which you
  then edit before saving.
- **Slack activity** — **💬 Pull Slack** pulls the member's recent message activity as AI evidence.
- **CSV import** — import **your evaluation** and the member's **self-evaluation** from CSV.

Everything here is **admin-only** (`thanhngo@everfit.io`); non-admins see working history only.
Evaluations are stored in the shared record under `state.evals[accountId][period]` and saved via a
targeted `patchEvals` merge (never clobbers project/people data).

### One-time setup (Vercel env vars)

**OpenAI (for AI insights):**
- `OPENAI_API_KEY` — your OpenAI API key (`sk-...`).
- `OPENAI_MODEL` *(optional)* — chat model id; defaults to `gpt-4o`.
- `OPENAI_BASE_URL` *(optional)* — override base URL (Azure/proxy).

**Slack (for activity signals):**
- `SLACK_USER_TOKEN` — a **user** OAuth token (`xoxp-...`) with scopes `search:read`, `users:read`,
  `users:read.email`. `search.messages` **requires a user token** — a bot token cannot search.
- `SLACK_BOT_TOKEN` *(optional)* — fallback used only for user lookup if no user token is set.

Redeploy after adding env vars. For reliable Slack matching, set each member's **email** in their
detail modal (it's saved to the directory and used for `users.lookupByEmail`).

### CSV format
Header row with columns `criterion,score,comment` (one row per criterion). Optional `member` (or
`name`) column lets one file cover several people — rows are matched to the member by name. An optional
`summary` column/row fills the overall summary. Use **Import my eval** for your scores and **Import
self-eval** for the member's self-assessment.
