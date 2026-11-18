# Turn on the fast server (about 5 minutes, free)

School Wi-Fi blocks direct links and our Cloudflare server, and it slows down the backup relays. The fix is to send game messages through Google Firebase instead, since schools rarely block Google. The game already has all the code. It just needs your own Firebase project.

You can do every step from an iPad or phone. Use your **personal** Google account, because school accounts often can't create projects.

## 1. Make the project
1. Go to **console.firebase.google.com** and sign in.
2. Tap **Create a project**. Name it something like `buckets-game`.
3. When it asks about Google Analytics, turn it **off**. Then tap **Create project**.

## 2. Turn on the Realtime Database
1. In the left menu, open **Build → Realtime Database** (it might be under "All products").
2. Tap **Create Database**.
3. For location, pick **United States (us-central1)**.
4. Pick **Start in locked mode**, then tap **Enable**.
5. Open the **Rules** tab, delete everything there, and paste this:

```json
{
  "rules": {
    ".read": false,
    ".write": false,
    "rooms": {
      "$room": {
        ".read": true,
        ".write": true
      }
    }
  }
}
```

6. Tap **Publish**.

## 3. Get the config
1. Tap the **gear icon → Project settings**.
2. Scroll to **Your apps** and tap the **`</>`** (Web) button.
3. Give it a nickname like `buckets`. Leave "Firebase Hosting" **unchecked**, then tap **Register app**.
4. You'll see a code block that starts with `const firebaseConfig = {`. Copy that whole block.

The config isn't a password. It's meant to be public, so it's fine in the repo.

## 4. Paste it into the game
Either:
- Send it to Claude in chat, or
- Do it yourself on github.com:
  1. Open **github.com/buckets19/buckets** and tap the file **`firebase-config.txt`**.
  2. Tap the ✏️ pencil to edit it.
  3. Paste the config under the comment lines.
  4. Tap **Commit changes**.

Wait about a minute, then open the game. On the home screen, tap **📶 Test connection**. The row **⚡ Fast server (Google)** should show ✅.

## What you get
- **Joining:** room codes and joins run through Google. Direct links still get used when the Wi-Fi allows them, and the public relays stay as a backup.
- **Ranked:** the 1v1 queue, 2v2 queue and 2v2 duo search all find real players through Google, even when the school blocks the PeerJS server.
- **Wi-Fi drops:** a short drop doesn't kick anyone. The game waits up to 15 seconds and then carries on.

## Free plan limits (be aware)
- **100 players connected at the same time** (across every game).
- **10 GB of data per month.** The game sends about 12 MB per joiner per hour of play. That works out to roughly **800 player-hours a month**.
- **If a limit is hit:** nothing breaks. The game automatically goes back to the backup relays (slower) until the next month.
- **If the game gets big:** you can switch the project to the **Blaze (pay as you go)** plan. Data costs about $1 per GB beyond the free 10 GB. Set a **budget alert** (for example $5) in Google Cloud billing if you do.

## Other option: your own domain (what Three Pins does)
Three Pins runs its live games on a Cloudflare server at its own domain, `live.threepins.golf`. Our Buckets server is the same kind of server, but it lives on `workers.dev`, and school filters block that whole address range.

If you buy a cheap domain (about $10 a year, in your Cloudflare dashboard under **Domain Registration**), Claude can point the Buckets server at it and switch it on (in place of Firebase, or as a backup to it).
