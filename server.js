const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

require("dotenv").config();

const express = require("express");
const { BrowserClient } = require("starblast-modding");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const RUNTIME_DIR = path.join(ROOT, ".runtime");
const MOD_PATH = path.join(ROOT, "duel.js");
const PORT = Number(process.env.PORT || 8787);
const LOG_LIMIT = 600;
const URL_RE = /https:\/\/starblast\.io\/#[A-Za-z0-9@:/?=&._-]+/g;
const AUTH_SALT = "s2f-duel-dashboard-v1";
const SESSION_COOKIE = "s2f_session";
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 12) * 60 * 60 * 1000;
const DEV_AUTH_USERS = {
  omega: { username: "Omega", hash: "96c1946d6f86403ae7ba137acc2642db5f1b8a9ba0d39526874b199ff658eeb4" },
  pasha: { username: "Pasha", hash: "fc48cd46d8e1c9eeecec20f323974910e40655f3efe378d3be5e788f0e393da4" },
};

const app = express();
app.set("trust proxy", 1);

let hostClient = null;
let startedAt = null;
let lastRegion = process.env.STARBLAST_REGION || "Europe";
let gameLink = "";
let logs = [];
let sessions = new Map();
let hostedBy = "";
let lastControlBy = "";

app.use(express.json({ limit: "2mb" }));
app.use((error, req, res, next) => {
  if (!error) {
    next();
    return;
  }

  if (req.path.startsWith("/api/")) {
    res.status(400).json({ error: "Invalid JSON request." });
    return;
  }

  next(error);
});
app.use(express.static(PUBLIC_DIR));

function hashPassword(username, password) {
  return crypto
    .createHash("sha256")
    .update(`${username}:${password}:${AUTH_SALT}`)
    .digest("hex");
}

function parseAuthUsers() {
  const hashEnv = String(process.env.DASHBOARD_USER_HASHES || "").trim();
  const plainEnv = String(process.env.DASHBOARD_USERS || "").trim();

  if (hashEnv) {
    const users = Object.fromEntries(
      hashEnv
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const [username, hash] = part.split(":");
          const displayName = String(username || "").trim();
          return [
            displayName.toLowerCase(),
            {
              username: displayName,
              hash: String(hash || "").trim(),
            },
          ];
        })
        .filter(([, user]) => user.username && /^[a-f0-9]{64}$/i.test(user.hash))
    );
    if (Object.keys(users).length) return users;
  }

  if (plainEnv) {
    const users = Object.fromEntries(
      plainEnv
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const divider = part.indexOf(":");
          if (divider === -1) return null;
          const username = part.slice(0, divider).trim();
          const password = part.slice(divider + 1).trim();
          return username
            ? [
                username.toLowerCase(),
                {
                  username,
                  hash: hashPassword(username, password),
                },
              ]
            : null;
        })
        .filter(Boolean)
    );
    if (Object.keys(users).length) return users;
  }

  if (process.env.NODE_ENV === "production") return {};
  return DEV_AUTH_USERS;
}

const authUsers = parseAuthUsers();

function safeEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const divider = part.indexOf("=");
        if (divider === -1) return [part, ""];
        return [part.slice(0, divider), decodeURIComponent(part.slice(divider + 1))];
      })
  );
}

function cleanupSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (!session || session.expiresAt <= now) sessions.delete(token);
  }
}

function activeUsernames() {
  cleanupSessions();
  return [...new Set([...sessions.values()].map((session) => session.username))];
}

function getSession(req) {
  cleanupSessions();
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function setSessionCookie(res, token, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: "Login required." });
    return;
  }
  req.user = session.username;
  next();
}

function addLog(source, text) {
  const clean = String(text || "")
    .replaceAll(process.env.STARBLAST_ECP_KEY || "__NO_ECP__", "[ECP KEY]")
    .replace(/\r/g, "")
    .trimEnd();

  if (!clean) return;

  for (const line of clean.split("\n")) {
    logs.push({
      at: new Date().toISOString(),
      source,
      text: line,
    });
  }

  logs = logs.slice(-LOG_LIMIT);

  const matches = clean.match(URL_RE);
  if (matches && matches.length) {
    const parsedLink = matches[matches.length - 1];
    if (parsedLink.includes("@") || !gameLink) gameLink = parsedLink;
  }
}

function status() {
  const node = hostClient ? hostClient.getNode() : null;
  const link = (node && node.link) || gameLink || "";

  return {
    running: Boolean(node && node.processStarted),
    pid: null,
    startedAt,
    region: lastRegion,
    gameLink: link,
    logs: logs.slice(-160),
    modFile: "duel.js",
    ecpConfigured: Boolean(process.env.STARBLAST_ECP_KEY),
    hostedBy,
    lastControlBy,
    activeUsers: activeUsernames(),
  };
}

function requireLiveHost() {
  const node = hostClient ? hostClient.getNode() : null;
  if (!hostClient || !node || !node.processStarted) {
    throw new Error("Start the Starblast host before using the admin panel.");
  }
}

function numberArg(value, name, min = -Infinity, max = Infinity) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a number.`);
  return Math.max(min, Math.min(max, Math.round(number)));
}

async function runModScript(script, timeout = 2500) {
  requireLiveHost();
  const result = await hostClient.execute(script, {
    allowEval: true,
    captureOutput: true,
    executionTimeout: timeout,
  });

  if (!result.success) {
    const output = result.output;
    throw output instanceof Error ? output : new Error(String(output || "Mod command failed."));
  }

  return result.output;
}

async function getLivePlayers() {
  const output = await runModScript(`
    JSON.stringify(JSON.parse(webAdminGetState()).players || [])
  `);

  return JSON.parse(String(output || "[]"));
}

async function getAdminState() {
  const output = await runModScript(`
    webAdminGetState()
  `);

  return JSON.parse(String(output || "{}"));
}

function makeAdminScript(action, body) {
  switch (action) {
    case "forceDuel": {
      const left = numberArg(body.leftId, "Left player");
      const right = numberArg(body.rightId, "Right player");
      const rounds = numberArg(body.rounds || 1, "Rounds", 1, 25);
      return `forceDuel(${left}, ${right}, ${rounds}); "Forced duel command sent";`;
    }
    case "grantAdmin": {
      const id = numberArg(body.playerId, "Player");
      return `giveAdmin(${id}); "Admin granted";`;
    }
    case "removeAdmin": {
      const id = numberArg(body.playerId, "Player");
      return `removeAdmin(${id}); "Admin removed";`;
    }
    case "toggleAdminShip": {
      const id = numberArg(body.playerId, "Player");
      return `webAdminToggleAdminShip(${id}); "Admin ship command sent";`;
    }
    case "announcement": {
      const message = String(body.message || "").trim().slice(0, 220);
      const duration = numberArg(body.duration || 6, "Duration", 2, 30);
      if (!message) throw new Error("Announcement text is empty.");
      return `announceAll(${JSON.stringify(message)}, ${duration}); "Announcement sent";`;
    }
    case "privateMessage": {
      const id = numberArg(body.playerId, "Player");
      const message = String(body.message || "").trim().slice(0, 220);
      const duration = numberArg(body.duration || 6, "Duration", 1, 30);
      if (!message) throw new Error("Private message text is empty.");
      return `privateMessage(${id}, ${JSON.stringify(message)}, ${duration}); "Private message sent";`;
    }
    case "ban": {
      const id = numberArg(body.playerId, "Player");
      const reason = String(body.reason || "Banned from web panel").trim().slice(0, 140);
      return `ban(${id}, ${JSON.stringify(reason)}); "Ban command sent";`;
    }
    case "unban": {
      const index = numberArg(body.banIndex, "Banned player");
      return `unban(${index}); "Unban command sent";`;
    }
    case "kickAllBanned":
      return `kickAllBannedPlayers(); "Banned players removed";`;
    case "pause": {
      const paused = Boolean(body.paused);
      return `webAdminSetPause(${paused ? "true" : "false"}); ${JSON.stringify(paused ? "Gameplay paused" : "Gameplay resumed")};`;
    }
    case "forceSpectate": {
      const id = numberArg(body.playerId, "Player");
      return `forceSpectate(${id}); "Force spectate command sent";`;
    }
    case "releaseSpectate": {
      const id = numberArg(body.playerId, "Player");
      return `releaseForcedSpectate(${id}); "Released from forced spectate";`;
    }
    case "forceEveryoneSpectate":
      return `forceEveryoneSpectate(); "Everyone forced to spectate";`;
    case "releaseAllSpectate":
      return `releaseAllForcedSpectators(); "All spectators released";`;
    case "freeze": {
      const id = numberArg(body.playerId, "Player");
      return `freezePlayer(${id}); "Freeze command sent";`;
    }
    case "unfreeze": {
      const id = numberArg(body.playerId, "Player");
      return `unfreezePlayer(${id}); "Unfreeze command sent";`;
    }
    case "sendLobby": {
      const id = numberArg(body.playerId, "Player");
      return `sendPlayerToLobby(${id}); "Sent to lobby";`;
    }
    case "teleportEveryoneLobby":
      return `teleportEveryoneToLobby(); "Everyone sent to lobby";`;
    case "kick": {
      const id = numberArg(body.playerId, "Player");
      return `kick(${id}, true); "Kick command sent";`;
    }
    case "resetStats":
      return `resetAllLeaderboardStats(); "Stats reset";`;
    case "clearPlayerHistory": {
      const id = numberArg(body.playerId, "Player");
      return `clearPlayerHistory(${id}); "Player history cleared";`;
    }
    case "clearGlobalHistory":
      return `clearGlobalHistory(); "Global history cleared";`;
    case "closeCountdown": {
      const seconds = numberArg(body.seconds || 15, "Seconds", 1, 300);
      const message = String(body.message || "Closing mod").trim().slice(0, 120);
      return `closeModWithCountdown(${seconds}, ${JSON.stringify(message)}); "Close countdown started";`;
    }
    case "cancelCloseCountdown":
      return `cancelCloseModCountdown(); "Close countdown cancelled";`;
    case "endTimer": {
      const minutes = Number(body.minutes || 10);
      if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("Minutes must be greater than 0.");
      const stopDelay = numberArg(body.stopDelay || 30, "Stop delay", 5, 120);
      const title = String(body.title || "FINAL RESULTS").trim().slice(0, 50);
      return `startEndCeremonyTimer(${minutes}, ${stopDelay}, ${JSON.stringify(title)}); "End timer started";`;
    }
    case "showPodium": {
      const stopDelay = numberArg(body.stopDelay || 30, "Stop delay", 5, 120);
      const title = String(body.title || "FINAL RESULTS").trim().slice(0, 50);
      return `showEndCeremonyNow(${stopDelay}, ${JSON.stringify(title)}); "Podium shown";`;
    }
    case "cancelEndTimer":
      return `cancelEndCeremonyTimer(); "End timer cancelled";`;
    case "setTrainingAliens": {
      const count = numberArg(body.count || 4, "Alien count", 1, 50);
      return `setTrainingAliens(${count}); "Training alien count updated";`;
    }
    case "setTrainingCap": {
      const cap = numberArg(body.cap || 80, "Alien cap", 4, 200);
      return `setTrainingAlienCap(${cap}); "Training alien cap updated";`;
    }
    case "clearTrainingAliens":
      return `clearTrainingAliens(); "Training aliens cleared";`;
    case "setRematchSeconds": {
      const seconds = numberArg(body.seconds || 18, "Rematch seconds", 5, 90);
      return `webAdminSetRematchSeconds(${seconds}); "Rematch setting updated";`;
    }
    case "clearAdminLog":
      return `clearAdminLog(); "Admin log cleared";`;
    case "refreshPanel":
      return `refreshAdminPanel(false); "In-game admin panel refreshed";`;
    default:
      throw new Error("Unknown admin action.");
  }
}

function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function writeHostConfig(region, ecpKey) {
  ensureRuntimeDir();

  const config = {
    key: ecpKey,
    region,
    sourcemode: "local",
    sourcepath: "./duel.js",
    watch: true,
    interval: 5000,
    timeout: 8000,
    compression: false,
    strict: false,
    silent: false,
    extended: true,
  };

  const configPath = path.join(RUNTIME_DIR, "starblast-host.config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return configPath;
}

async function stopHostProcess() {
  if (!hostClient) return false;

  const client = hostClient;
  hostClient = null;
  startedAt = null;

  try {
    await client.stop();
  } catch (error) {
    addLog("system", `Stop warning: ${error.message}`);
  }

  return true;
}

function createHostClient(region, ecpKey) {
  const client = new BrowserClient({
    cacheECPKey: true,
    cacheOptions: true,
    extendedMode: true,
    crashOnException: false,
    logExceptions: true,
    logMessages: true,
    compressWSMessages: false,
  });

  const node = client.getNode();

  client.pollMessages((message) => {
    addLog(message.type === "error" ? "error" : "host", message.content || message.raw || "");
  });

  node.on("start", (link) => {
    gameLink = link;
    addLog("system", `Mod started: ${link}`);
  });

  node.on("log", (...args) => {
    addLog("host", args.map((item) => String(item)).join(" "));
  });

  node.on("error", (error) => {
    addLog("error", error && error.stack ? error.stack : error.message || error);
  });

  node.on("stop", () => {
    addLog("system", "Mod hosting finished.");
    hostClient = null;
    startedAt = null;
    hostedBy = "";
  });

  client.setECPKey(ecpKey).setRegion(region);
  return client;
}

function waitForGameLink(client, timeoutMs = 30000) {
  const node = client.getNode();

  if (node.link) return Promise.resolve(node.link);

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      node.off("start", onStart);
      node.off("error", onError);
    };

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };

    const onStart = (link) => finish(resolve, link || node.link);
    const onError = (error) => finish(reject, error instanceof Error ? error : new Error(String(error)));

    const timer = setTimeout(() => {
      if (node.link) finish(resolve, node.link);
      else finish(reject, new Error("Starblast host did not return a room link within 30 seconds."));
    }, timeoutMs);

    node.once("start", onStart);
    node.once("error", onError);
  });
}

app.get("/api/session", (req, res) => {
  const session = getSession(req);
  res.json({
    authenticated: Boolean(session),
    user: session ? session.username : null,
  });
});

app.post("/api/login", (req, res) => {
  const loginName = String(req.body.username || "").trim();
  const user = authUsers[loginName.toLowerCase()];
  const password = String(req.body.password || "").trim();

  if (!user || !safeEqualHex(hashPassword(user.username, password), user.hash)) {
    res.status(401).json({ error: "Wrong username or password." });
    return;
  }

  const token = crypto.randomBytes(32).toString("hex");
  const maxAgeSeconds = Math.max(60, Math.round(SESSION_TTL_MS / 1000));
  sessions.set(token, {
    username: user.username,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  setSessionCookie(res, token, maxAgeSeconds);
  res.json({ authenticated: true, user: user.username });
});

app.post("/api/logout", (req, res) => {
  const session = getSession(req);
  if (session) sessions.delete(session.token);
  clearSessionCookie(res);
  res.json({ authenticated: false });
});

app.use("/api", requireAuth);

app.get("/api/status", (_req, res) => {
  res.json(status());
});

app.get("/api/players", async (_req, res) => {
  try {
    const state = await getAdminState();
    res.json({ players: state.players || [], state });
  } catch (error) {
    res.json({ players: [], error: error.message });
  }
});

app.get("/api/admin/state", async (_req, res) => {
  try {
    res.json({ state: await getAdminState() });
  } catch (error) {
    res.json({ state: null, error: error.message });
  }
});

app.get("/api/mod", (_req, res) => {
  try {
    const stat = fs.statSync(MOD_PATH);
    res.json({
      path: MOD_PATH,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      source: fs.readFileSync(MOD_PATH, "utf8"),
    });
  } catch (error) {
    res.status(500).json({ error: `Could not read duel.js: ${error.message}` });
  }
});

app.post("/api/start", async (req, res) => {
  if (hostClient) {
    lastControlBy = req.user || lastControlBy;
    res.json(status());
    return;
  }

  const region = String(req.body.region || process.env.STARBLAST_REGION || "Europe").trim();
  const ecpKey = String(req.body.ecpKey || process.env.STARBLAST_ECP_KEY || "").trim();

  if (!fs.existsSync(MOD_PATH)) {
    res.status(400).json({ error: "duel.js was not found beside server.js." });
    return;
  }

  if (!ecpKey || ecpKey === "put-your-ecp-key-here") {
    res.status(400).json({
      error: "Add STARBLAST_ECP_KEY to .env or paste an ECP key in the dashboard before starting.",
    });
    return;
  }

  try {
    writeHostConfig(region, ecpKey);

    logs = [];
    gameLink = "";
    lastRegion = region;
    startedAt = new Date().toISOString();
    hostedBy = req.user || "";
    lastControlBy = req.user || "";
    addLog("system", `${hostedBy || "Dashboard"} started Starblast host in ${region} with BrowserClient and local duel.js`);

    hostClient = createHostClient(region, ecpKey);
    await hostClient.loadCodeFromLocal(MOD_PATH, {
      watchChanges: true,
      watchInterval: 5000,
      executionTimeout: 8000,
    });
    const linkPromise = waitForGameLink(hostClient);
    await Promise.all([hostClient.start(), linkPromise]);

    res.json(status());
  } catch (error) {
    if (hostClient) {
      try {
        await hostClient.stop();
      } catch (_stopError) {}
    }
    hostClient = null;
    startedAt = null;
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/stop", async (_req, res) => {
  lastControlBy = _req.user || lastControlBy;
  const stopped = await stopHostProcess();
  if (stopped) addLog("system", `${_req.user || "Dashboard"} stopped Starblast host.`);
  res.json(status());
});

app.post("/api/admin/action", async (req, res) => {
  try {
    const action = String(req.body.action || "");
    const script = makeAdminScript(action, req.body || {});
    const output = await runModScript(script);
    lastControlBy = req.user || lastControlBy;
    addLog("system", `${req.user || "Dashboard"} admin action ${action}: ${String(output || "done")}`);
    const state = await getAdminState();
    res.json({ ok: true, message: String(output || "Command sent"), status: status(), players: state.players || [], state });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message, status: status() });
  }
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found." });
});

app.use((error, req, res, next) => {
  if (req.path.startsWith("/api/")) {
    res.status(500).json({ error: error.message || "Server error." });
    return;
  }
  next(error);
});

const server = app.listen(PORT, () => {
  ensureRuntimeDir();
  addLog("system", `Dashboard ready at http://localhost:${PORT}`);
  console.log(`S2F Duel Web Host ready at http://localhost:${PORT}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Close the old dashboard server or run with another port, for example:`);
    console.error(`$env:PORT=8788; npm run dev`);
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});
