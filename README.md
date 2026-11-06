# Mobilise Diwali Utsav 2026 🪔

Voting web app for the office Diwali competitions:

| Competition | Who is scored | Who votes |
|---|---|---|
| **Best Desk** | the 10 teams | every team scores every *other* team (1–10) |
| **Best Dress (Male)** | male employees (names only) | every team (1–10) |
| **Best Dress (Female)** | female employees (names only) | every team (1–10) |

The app works on phones and desktops. It opens with an animated intro: the diya is lit, "शुभ दीपावली" appears, a firework assembles the Mobilise logo, and then comes a greeting from Ashish Sharma.

---

## 1. Run it

Needs **Node.js 18+**. There is nothing to install: no `npm install`, no database.

```bash
cd deepawali-app
node server.js
```

On Windows you can also double-click **`start-windows.bat`**. It asks for an organiser password first.

The server prints:

- the app link: `http://localhost:3000`
- the office Wi-Fi link: `http://192.168.x.x:3000`, which works for phones on the same network
- the organiser console: `http://localhost:3000/admin`
- the PIN of every team

### Settings (environment variables)

| Variable | Default | |
|---|---|---|
| `ADMIN_PASSWORD` | `diwali2026` | **Change this** before sharing the link |
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` | Where votes are saved (`db.json`). Keep it on a disk that persists |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | not set | Save the data in a free Upstash Redis database instead of `db.json`. Needed on hosts that wipe their disk (Render free) |

PowerShell example:

```powershell
$env:ADMIN_PASSWORD = "your-secret"; node server.js
```

## 2. Host it online for free (Render + Upstash)

**Why two services?** Render's free plan runs the app, but it wipes its disk on every restart. It also goes to sleep after 15 minutes without visitors. Upstash's free Redis keeps the votes, teams, PINs and photo safe through all of that. Neither service asks for a card.

**A. The code is on GitHub:** [github.com/avinashmobilise/mobilise-deepawali](https://github.com/avinashmobilise/mobilise-deepawali). `render.yaml` sits at the repo root.

**B. Create the free database:** go to [console.upstash.com](https://console.upstash.com), sign in with Google or GitHub, then **Create Database → Redis**.
- Choose a region in India, or the one nearest to it.
- Open the database and copy **`UPSTASH_REDIS_REST_URL`** and **`UPSTASH_REDIS_REST_TOKEN`** from the *REST API* section.

**C. Deploy the app:** go to [dashboard.render.com](https://dashboard.render.com), sign in with GitHub, then **New → Blueprint** and pick the repo. Render reads `render.yaml` and asks for 3 values:
- `ADMIN_PASSWORD`: your organiser password
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`: from step B

Click **Apply**. After about 2 minutes you get a link like `https://mobilise-diwali-utsav.onrender.com`. That is the link to share.

Instead of a Blueprint you can create a **Web Service** by hand: Runtime *Node*, Build `npm install`, Start `npm start`, Instance *Free*, and add the 3 environment variables.

**D. Finish in the app:**
1. Open `https://<your-app>.onrender.com/admin` and go to **Setup**.
2. Paste the link into **"Public link of this app"** so the invite links use it.
3. Check the console: it shows a red warning if the Upstash settings are missing.

**Before the event:** open the link about 5 minutes early. If nobody has visited for 15 minutes, the free service is asleep and the first visit takes about a minute to wake it. During voting it stays awake.

### Other options

- **The laptop stays on during voting (no accounts needed):** run a free Cloudflare quick tunnel next to the server.
  ```powershell
  winget install --id Cloudflare.cloudflared
  cloudflared tunnel --url http://localhost:3000
  ```
  It prints an `https://….trycloudflare.com` link. The link changes every time the tunnel restarts.
- **Office network only:** share the `http://192.168.x.x:3000` address that the server prints.
- **Any other Node host** (Azure App Service, a VM, Railway…): run `npm start`. Either point `DATA_DIR` at persistent storage or set the Upstash variables.

## 3. Event-day checklist (organiser console, `/admin`)

1. **Setup**
   - Paste the **male** and **female** names, one per line, and click Save.
   - Check the owner greeting (name, title and message) and **upload Ashish Sharma's photo**. Without a photo the intro shows "AS" initials.
   - Click **Preview intro** to watch the whole intro.
2. **Teams & PINs**
   - Rename "Team 1…10" to the real team names and click **Save teams**.
   - Click the copy icon next to each team and send that **personal invite link** to the team lead on WhatsApp. The link opens the app already logged in as that team.
   - Anyone can also open the general link, pick a team and enter its PIN.
   - If you don't want PINs, turn off *"Teams need their PIN to vote"* in Setup.
3. **Live results**
   - Watch votes arrive. Each team chip turns gold when that team has voted.
   - Use **Open / Closed** per competition to control when voting is allowed.
   - If a team made a mistake, click its gold chip to delete that ballot so the team can vote again.
4. **Winner reveal (projector):** click **Reveal on screen**, then press Space to reveal 3rd → 2nd → 1st, with a drumroll and fireworks.
5. Turn on **"Show winners in the app"** so everyone sees the podium on their phone.
6. **Exports:** download Results / Every ballot as CSV for your records.

## How the scoring works

- Each team gives every entry a score from 1 to 10, and must score everyone before submitting. Once submitted, the scores are locked.
- In Best Desk, a team never sees or scores its own desk.
- Ranking uses the **average score received**, so it stays fair even if a team doesn't vote. Ties are broken by the number of votes. Entries with the same average and the same number of votes share a rank ("Joint 2nd").
- Only the top 3 are ever shown publicly, and only after the organiser publishes. Full standings stay in the console.

## Files

```
server.js            zero-dependency Node server + JSON API (data in data/db.json or Upstash Redis)
render.yaml          one-click Render blueprint (free plan)
public/index.html    voting app
public/admin.html    organiser console
public/js/intro.js   animated intro (diya → Shubh Deepawali → Mobilise → Ashish Sharma)
public/js/fx.js      fireworks, sounds (synthesised, no audio files), diya / rangoli / garland art
public/js/app.js     voting screens
public/js/admin.js   organiser console + winner reveal
public/css/styles.css
```

Brand colours and the logo come from mobilise.co.in (navy `#002A64`, cyan `#00AACC`, font Plus Jakarta Sans).
