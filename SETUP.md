# Setup (about 30 minutes, once)

Do these steps on a computer, signed in to the Google account that will own the app. The calendars listed in `Config.gs` must already show in that account's Google Calendar.

## 1. Turn on the website (GitHub Pages)

1. In this repository on GitHub, open **Settings → Pages**.
2. Under **Build and deployment**, pick **Deploy from a branch**, branch `main`, folder `/docs`, and click **Save**.
3. After a minute the site is at `https://<github-user>.github.io/hudson-planner/`. It shows "Setup is not finished" until step 4.

## 2. Create the Google sign-in client

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project named **Hudson Planner**.
2. Open **APIs & Services → OAuth consent screen** (also called **Google Auth Platform**). Choose **External**, app name **Hudson's Planner**, and your email for the contact fields. Add no extra scopes. On the **Audience** page, click **Publish app**. Sign-in only asks for name and email, so Google doesn't need to review it.
3. Open **Credentials → Create credentials → OAuth client ID**. Pick **Web application**.
4. Under **Authorized JavaScript origins**, add `https://<github-user>.github.io` (no path, no trailing slash).
5. Click **Create** and copy the **Client ID**. It ends in `.apps.googleusercontent.com`.

## 3. Install the back office (Google Apps Script)

1. Go to [script.google.com](https://script.google.com) and click **New project**. Rename it **Hudson Planner**.
2. Replace the contents of `Code.gs` with `apps-script/Code.gs` from this repository.
3. Click **+ → Script**, name it `Config`, and paste the filled-in config (start from `apps-script/Config.example.gs`). Put the Client ID from step 2 in `CLIENT_ID`. **Never commit this file**: the repository is public.
4. Open **Project Settings** (gear icon), tick **Show "appsscript.json" manifest file in editor**, then replace that file's contents with `apps-script/appsscript.json`.
5. Back in the editor, pick the `setup` function in the toolbar and click **Run**. Approve the permissions. Google warns that the app isn't verified: click **Advanced → Go to Hudson Planner**. It's your own script.
6. Open **Execution log**. Every calendar should say `OK`. A `MISSING` line means the name in `Config` doesn't match Google Calendar exactly.
7. Click **Deploy → New deployment → gear → Web app**. Set **Execute as: Me** and **Who has access: Anyone**, then click **Deploy**. Copy the **Web app URL** (ends in `/exec`).

"Anyone" only lets the website reach the script. The script still checks every request against the email addresses in `Config`.

## 4. Connect the website to the back office

Edit `docs/config.js` in this repository and fill in both values:

```js
window.HP_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/…/exec',
  CLIENT_ID: '….apps.googleusercontent.com',
};
```

## 5. Share the calendars with the student

1. In Google Calendar on the owner's computer, open **Settings** for **Hudson's Plan** and **Hudson's Reminders**.
2. Under **Share with specific people**, add the student's Google account with **See all event details**.
3. On the student's iPhone, accept both in Google Calendar. Then open **Settings → Hudson's Reminders** and set its notification to **At time of event**. Turn notifications **off** for **Hudson's Plan** so the daily cap of two holds.
4. Add the Google Calendar widget to the lock screen if wanted.

## 6. Install on the devices

- **iPhone:** open the site in Safari, tap **Share → Add to Home Screen**, then open it from the home screen and sign in.
- **Chromebook:** open the site in Chrome and click the install icon in the address bar.
- **Parents:** open the same site and sign in. Parent accounts get the parent view.

## Updating the back office later

Paste the new `Code.gs` into the Apps Script editor, then **Deploy → Manage deployments → edit (pencil) → Version: New version → Deploy**. The URL stays the same.

## How it behaves

- The script checks the calendars every hour. **Check calendars now** in the app runs it right away.
- At most two reminders a day go to **Hudson's Reminders**: a morning one (only when there is paper to pack or a teacher visit) and the after-school plan.
- Parents get an email at 8 pm only when something needs attention.
- Everything is in the **Hudson Planner Data** Google Sheet in the owner's Drive: one tab each for tasks, points, the daily study check-offs, and pasted grades.
