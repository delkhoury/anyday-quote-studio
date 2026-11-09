# Putting Anyday Quote Studio on quotes.anyday.inc

About 30 minutes of clicking. Nothing needs to be installed on your computer.

You will end up with:
* the app running on **Render** (1 CPU, 2 GB, $25/month, plus $0.25/month for a 1 GB disk),
* sign-in limited to **@anyday.inc Google accounts**,
* the address **https://quotes.anyday.inc**, set up in **Cloudflare** (where anyday.inc's DNS already lives).

---

## Step 1. GitHub: create the repository (2 minutes)

1. Go to github.com, open the Anyday organization (or your own account) and click **New repository**.
2. Name: `anyday-quote-studio`. Visibility: **Private**. Leave everything else empty (no README, no .gitignore).
3. Click **Create repository** and send Claude the repository name, i.e. `anyday/anyday-quote-studio`.

Claude pushes the code. Every later change Claude makes is pushed the same way, and Render redeploys automatically.

## Step 2. Google: create the sign-in key (10 minutes)

1. Go to **console.cloud.google.com** signed in as danny@anyday.inc.
2. Top bar → project picker → **New project**. Name: `Anyday Quote Studio`. Create, then select it.
3. Menu → **APIs & Services → OAuth consent screen** (Google now calls this area **Google Auth Platform**).
   * App name: `Anyday Quote Studio`. User support email: your address.
   * Audience: **Internal**. This limits sign-in to your Google Workspace (anyday.inc) at Google's end as well.
   * Contact email: your address. Save.
4. Go to **Clients** (or **Credentials → Create credentials → OAuth client ID**).
   * Application type: **Web application**. Name: `Quote Studio`.
   * **Authorized redirect URIs** → Add URI: `https://quotes.anyday.inc/auth/callback`
   * Create.
5. Copy the **Client ID** and the **Client secret**. Keep this tab open for Step 3.

## Step 3. Render: deploy (10 minutes)

1. Go to **render.com** and sign up with **GitHub**. Allow Render to see the `anyday-quote-studio` repository.
2. Add a payment method (Account → Billing). The 2 GB plan is a paid plan.
3. Click **New → Blueprint**, choose the `anyday-quote-studio` repository.
4. Render reads `render.yaml` and shows one service, `anyday-quote-studio`, with a disk. It asks for two values:
   * `GOOGLE_CLIENT_ID`: paste the Client ID from Step 2.
   * `GOOGLE_CLIENT_SECRET`: paste the Client secret from Step 2.
5. Click **Apply**. The first build takes 5 to 10 minutes.
6. When it shows **Live**, open the service → **Settings → Custom Domains**. `quotes.anyday.inc` is listed with a target address ending in `.onrender.com`. Copy that address.

## Step 4. Cloudflare: point quotes.anyday.inc at Render (5 minutes)

1. Go to **dash.cloudflare.com** → **anyday.inc** → **DNS → Records → Add record**.
   * Type: **CNAME**
   * Name: `quotes`
   * Target: the `.onrender.com` address from Step 3.6
   * Proxy status: **DNS only** (grey cloud). Render provides the HTTPS certificate.
   * Save.
2. Back in Render's **Custom Domains**, click **Verify**. The certificate is issued within a few minutes, occasionally up to an hour.

## Step 5. Sign in

Open **https://quotes.anyday.inc**, click **Sign in with Google**, and choose your anyday.inc account.

Your three LF example quotes, the Pricing Library and the AAIF foundation are already loaded.

---

## Good to know

* **Who can sign in:** anyone with an anyday.inc Google account. To let in someone outside, add their address to `ALLOWED_EMAILS` (comma separated) in Render → Environment.
* **Who changed what:** each quote records who created and last saved it.
* **Your data** lives on the Render disk at `/data`. Render takes daily snapshots of disks. A nightly copy to Google Drive is a sensible next addition.
* **Updates:** Claude pushes changes to GitHub, Render rebuilds and redeploys by itself, and your quotes stay on the disk.
* **If the site is down:** Render → the service → **Logs** shows why. The health check is `https://quotes.anyday.inc/api/health`.
* **Safety net:** the app refuses to start on a public address unless Google sign-in is configured, so it can never be exposed by accident.

## Connecting Clockify and turning on margins (2 minutes)

In Render → the service → **Environment → Add environment variable**:

* `CLOCKIFY_API_KEY`: a key from Clockify → Profile settings → API.
* `ADMIN_EMAILS`: the accounts that may see cost rates and margins, comma separated.

Save. Render redeploys by itself. Then use **Team → Sync from Clockify** and **Pricing Library → Hours from Clockify**.
