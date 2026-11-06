# Mobilise Diwali Utsav 2026 🪔

Voting web app for the office Diwali competitions. **Every employee votes individually.** They log in with their office email and a 6-digit code (OTP) that is sent to that email.

| Competition | Entries | Who votes |
|---|---|---|
| **Best Desk** | the teams | every employee, 1–10 for every team except their own |
| **Best Dress (Male)** | male employees (names only) | every employee, 1–10 for everyone except themselves |
| **Best Dress (Female)** | female employees (names only) | every employee, 1–10 for everyone except themselves |

The app works on phones and desktops. It opens with an animated intro: the diya is lit, "शुभ दीपावली" appears, a firework assembles the Mobilise logo, and then comes a greeting from Ashish Sharma.

Live: https://mobilise-diwali-utsav.onrender.com · Organiser console: `/admin`

---

## 1. Run it locally

You need **Node.js 18+**.

```bash
cd deepawali-app
npm install        # one dependency: nodemailer (sends the login codes)
node server.js
```

On Windows you can also double-click **`start-windows.bat`**.

The app runs at `http://localhost:3000` and the organiser console at `http://localhost:3000/admin`.

| Variable | Default | |
|---|---|---|
| `ADMIN_PASSWORD` | `diwali2026` | **Change this** before sharing the link |
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` | Where data is saved (`db.json`) when Upstash is not used |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | not set | Store everything in a free Upstash Redis database. Needed on Render free, whose disk is wiped on every restart |

## 2. Email for the login codes

### Option A (recommended): your own mail API over HTTPS

The app can send each login code to an HTTPS endpoint on your own server, which then sends it with your normal mail account. This works on Render's free plan, because it does not use SMTP ports.

1. Copy `diwali_utsav_mail.php` next to `Global/Communication/send_email.php` on your server.
   - It is kept outside this repo because it contains the key.
   - It calls `global_send_email([... 'instant' => true])`.
   - It needs a secret key in the `X-Utsav-Key` header, accepts exactly one recipient per call, and caps the number of mails per minute.
2. In **/admin → Setup → "your mail API"**, enter the endpoint URL and the same key, click **Save mail API**, then use **Send test email**.
3. The email channel must be ON in your system (LeavePolicy → Settings). Otherwise the API answers "Email channel is disabled".
4. Delete the PHP file after the event.

### Option B: SMTP

Enter the SMTP settings in **/admin → Setup → Email for login codes · SMTP**, then use **Send test email** to check them. If the mail API is filled in, it takes priority over SMTP.

> ⚠️ **Render's free plan blocks outbound SMTP on ports 25, 465 and 587** (since September 2025). Office mail servers such as Gmail / Google Workspace, Microsoft 365 or Zoho use exactly those ports, so they will not work from Render free. Choose one of these instead:
> - Use an email provider that offers **port 2525**: Brevo (free tier), SendGrid, Mailgun or SMTP2GO. Use security *STARTTLS*, port `2525`, and that provider's SMTP login. Set the *From* address to an address you have verified with the provider.
> - Or upgrade the Render service to a paid instance. Ports 465 and 587 then work.

## 3. Hosting (Render + Upstash, both free)

The code is on GitHub at [github.com/avinashmobilise/mobilise-deepawali](https://github.com/avinashmobilise/mobilise-deepawali). Render deploys it with `render.yaml` using these settings:
- `ADMIN_PASSWORD`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

The Render service is **not connected to GitHub**, so it does not deploy new code on its own. After pushing new code, open Render → the service → **Manual Deploy → Deploy latest commit**.

The free service goes to sleep after 15 minutes without visitors. The first visit after that takes about a minute. Open the link a couple of minutes before voting starts.

## 4. Event-day checklist (`/admin`)

1. **Setup → Email for login codes:** fill in the SMTP settings, then click Save and Send test email.
2. **Setup → Employees:** paste the employee list from Excel or Google Sheets, or upload a CSV.
   - Columns: `Name, Email, Team, Gender`, for example `Rahul Verma, rahul@mobilise.co.in, Alpha, M`.
   - The header row is optional.
   - Gender `M`/`F` decides the Best Dress (Male)/(Female) lists. Team decides which desk a person cannot score.
   - Leave *"Replace the Best Desk team list"* ticked so that the teams come from the sheet.
3. **Setup:** check the owner greeting and upload Ashish Sharma's photo.
4. Share **one link** with everyone. Each person enters their office email and then the code from their inbox.
5. **Live results:**
   - Watch the progress ("X of N people voted") and the Voters list.
   - Use *Open / Closed* per competition.
   - Click a ✓ in the Voters list to delete a mistaken ballot.
6. **Winner reveal (projector):** click **Reveal on screen** and press Space for 3rd → 2nd → 1st. Then turn on **Show winners in the app**.
7. **Exports:** Results / Every ballot as CSV. The ballots file includes each voter's name and email.

## How the scoring works

- Each person scores every entry from 1 to 10 and must score everyone before submitting. After that the ballot is locked.
- Nobody scores their own team's desk or their own outfit.
- Ranking uses the **average score received**, so bigger teams don't get an advantage. Ties are broken by the number of votes. Entries with the same average and the same votes share a rank ("Joint 2nd").
- Only the top 3 are shown publicly, and only after the organiser publishes them.

## Security notes

- Login codes are valid for 10 minutes and work only once. After 5 wrong tries the code stops working. Each email can request a new code at most every 45 seconds.
- The SMTP password is stored with the app data and is never sent back to the browser.

## Files

```
server.js            Node server + JSON API (data in data/db.json or Upstash Redis; email via nodemailer)
render.yaml          Render blueprint (free plan, Singapore)
public/index.html    voting app            public/js/app.js     voting screens + email login
public/admin.html    organiser console     public/js/admin.js   console + winner reveal
public/js/intro.js   animated intro        public/js/fx.js      fireworks, sounds, diya/rangoli art
public/css/          styles.css (shared), voter.css, admin-extra.css
```
