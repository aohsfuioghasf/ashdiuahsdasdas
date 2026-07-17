# S2F Duel Render Deploy

This is the clean Render folder.

## What is inside

- `server.js` - Node/Express host dashboard server.
- `duel.js` - Starblast mod source. This is not obfuscated.
- `public/index.html` - dashboard page.
- `public/styles.css` - dashboard styling.
- `public/app.protected.js` - obfuscated dashboard browser JavaScript.
- `public/assets/space-bg.jpg` - dashboard background.

Readable dashboard source `public/app.js` is intentionally not included here.

## Render settings

Create a Render **Web Service**, not a Static Site.

```text
Runtime: Node
Build Command: npm install
Start Command: npm start
```

Do not set `PORT`. Render provides it automatically.

## Environment variables

Set these in Render:

```ini
NODE_ENV=production
STARBLAST_REGION=Europe
STARBLAST_ECP_KEY=your-real-ecp-key
DASHBOARD_USERS=Omega:your-omega-password,Pasha:your-pasha-password
SESSION_TTL_HOURS=12
```

Keep `.env` private. Do not upload real secrets to GitHub.

## Local test

```powershell
npm install
npm start
```

Open:

```text
http://localhost:8787
```

## Notes

- Use an always-on Render instance for real hosting. Free services can sleep and stop the game host.
- To change dashboard code later, edit the main project `public/app.js`, regenerate the protected file, then remake/copy this folder again.
