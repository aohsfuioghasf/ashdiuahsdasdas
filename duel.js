(function() {
    var sanitizeS2FShaderSource = function(source) {
        if (typeof source !== "string") return source;
        return source
            .replace(/6\.666666666666667\.0/g, "6.6666666666666670")
            .replace(/(\d+\.\d+)\.(\d+)/g, function(_match, left, right) { return left + right; })
            .replace(/(\d+\.\d+)\.(?=[^0-9]|$)/g, "$1")
            .replace(/\.\.+/g, ".");
    };

    var patchShaderSource = function(proto) {
        if (!proto || proto.__s2fShaderSourcePatched || typeof proto.shaderSource !== "function") return;
        var originalShaderSource = proto.shaderSource;
        proto.shaderSource = function(shader, source) {
            return originalShaderSource.call(this, shader, sanitizeS2FShaderSource(source));
        };
        proto.__s2fShaderSourcePatched = true;
    };

    var patchThree = function() {
        if (typeof WebGLRenderingContext !== "undefined") patchShaderSource(WebGLRenderingContext.prototype);
        if (typeof WebGL2RenderingContext !== "undefined") patchShaderSource(WebGL2RenderingContext.prototype);

        if (typeof THREE !== "undefined" && THREE.WebGLShader && !THREE.__s2fShaderPatched) {
            var originalWebGLShader = THREE.WebGLShader;
            THREE.WebGLShader = function(gl, type, source) {
                return originalWebGLShader.call(this, gl, type, sanitizeS2FShaderSource(source));
            };
            THREE.WebGLShader.prototype = originalWebGLShader.prototype;
            THREE.__s2fShaderPatched = true;
        }
    };

    patchThree();
    var checkInterval = setInterval(patchThree, 16);
    setTimeout(function() { clearInterval(checkInterval); }, 10000);
})();

// ============================================================
//  ADMIN PANEL
// ============================================================

let adminSettings = {
    PUBLISH_TO_SERVERLIST: false,
};

let sessionMemory = {
    admins: [],
    banned: [],
    bruteforceBanned: [],
    forcedSpectators: [],
    frozenPlayers: [],
    kickQueue: [],
    bannedShipIds: [],
    globalMatchHistory: [],
    adminLog: [],
};

let adminRuntime = {
    closeCountdownToken: 0,
    closeCountdownEndsAt: -1,
    closeCountdownMessage: "",
    endCeremonyToken: 0,
    endCeremonyEndsAt: -1,
    endCeremonyTitle: "FINAL RESULTS",
    endCeremonyStopDelay: 30,
    endCeremonyRunning: false,
    gamePaused: false,
    trainingAlienCount: 4,   // aliens per training player
    trainingAlienCap: 80,
    trainingSpawnInterval: 90,
    trainingBoundaryInterval: 30,
    rematchOfferSeconds: 18,
    announcementPauseUntil: -1,
    announcementPauseToken: 0,
};

const statusMessage = (status, message) => {
    const timeString = new Date().toLocaleTimeString('en-GB', { hour12: false, timeZoneName: 'short' });
    try {
        let str = "";
        switch (status) {
            case "err": case "error":   str += "[[b;#FF0000;][ERROR] ";   break;
            case "suc": case "success": str += "[[b;#00FF00;][SUCCESS] "; break;
            case "warn":                str += "[[b;#FFFF00;][WARN] ";    break;
            default:                    str += "[[b;#007bff;][INFO] ";    break;
        }
        game.modding.terminal.echo(" ");
        game.modding.terminal.echo(str + "(" + timeString + "):  [[;#FFFFFF;]" + message);
        game.modding.terminal.echo(" ");
    } catch (ex) { console.warn(ex); }
};

const shipByID  = (id) => game.ships.find(obj => obj.id == id);
const fetchShip = (id) => game.ships.findIndex(el => el.id === id);
const removeFromArray      = (arr, target) => arr.filter(item => item !== target);
const removeIndexFromArray = (arr, index)  => arr.filter((_, ind) => ind !== index);
const isForcedSpectator = (ship) => !!ship && sessionMemory.forcedSpectators.includes(ship.id);
const isQueuedForKick = (ship) => !!ship && sessionMemory.kickQueue.includes(ship.id);
const isSessionBanned = (ship) => !!ship && (sessionMemory.banned.includes(ship.name) || sessionMemory.bannedShipIds.includes(ship.id));
const isFrozenPlayer = (ship) => !!ship && sessionMemory.frozenPlayers.includes(ship.id);
const isAdminPlayer = (ship) => !!ship && sessionMemory.admins.includes(ship.id);
const isAnnouncementPauseActive = () => adminRuntime.announcementPauseUntil >= game.step;
const isGameplayPaused = () => !!adminRuntime.gamePaused || isAnnouncementPauseActive();
const hasAdminPanelDOM = () => typeof document !== "undefined" && !!document && typeof document.getElementById === "function";
const normalizePanelText = (value) => String(value || "").replace(/\s+/g, " ").trim();
const wrapPanelText = (message, maxLineLength = 28, maxLines = 3) => {
    let words = normalizePanelText(message).split(" ").filter(Boolean);
    if (words.length === 0) return [""];
    let lines = [];
    let currentLine = "";
    while (words.length > 0 && lines.length < maxLines) {
        let word = words.shift();
        let candidate = currentLine ? `${currentLine} ${word}` : word;
        if (candidate.length <= maxLineLength || currentLine.length === 0) {
            currentLine = candidate;
        } else {
            lines.push(currentLine);
            currentLine = word;
        }
    }
    if (currentLine && lines.length < maxLines) lines.push(currentLine);
    if (words.length > 0 && lines.length > 0) lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, Math.max(maxLineLength - 3, 1))}...`;
    return lines;
};

const panelEscapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const clampPanelNumber = (value, min, max, fallback) => {
    value = Number(value);
    if (!Number.isFinite(value)) value = fallback;
    return Math.max(min, Math.min(max, value));
};

const getPlayerLabel = (ship) => ship ? `${ship.name} [${ship.id}]` : "System";

const addAdminLog = (action, target = "System", details = "", severity = "info") => {
    const entry = {
        action: normalizePanelText(action) || "Action",
        target: normalizePanelText(target) || "System",
        details: normalizePanelText(details),
        severity: ["info", "success", "warn", "danger"].includes(severity) ? severity : "info",
        step: (typeof game !== "undefined" && game?.step) ? game.step : 0,
        time: new Date().toLocaleTimeString('en-GB', { hour12: false })
    };
    sessionMemory.adminLog.unshift(entry);
    if (sessionMemory.adminLog.length > 300) sessionMemory.adminLog = sessionMemory.adminLog.slice(0, 300);
    renderAdminLog();
    updatePanelStats();
};

renderAdminLog = () => {
    if (!hasAdminPanelDOM()) return;
    const container = document.getElementById('s2f-admin-log-view');
    if (!container) return;
    const entries = sessionMemory.adminLog || [];
    if (entries.length === 0) {
        container.innerHTML = '<div class="s2f-empty">No admin actions recorded yet.</div>';
        return;
    }
    container.innerHTML = entries.map(entry => `
        <div class="s2f-logitem ${panelEscapeHtml(entry.severity)}">
            <div class="s2f-logtop">
                <strong>${panelEscapeHtml(entry.action)}</strong>
                <span>${panelEscapeHtml(entry.time)}</span>
            </div>
            <div class="s2f-logtarget">${panelEscapeHtml(entry.target)}</div>
            ${entry.details ? `<div class="s2f-logdetail">${panelEscapeHtml(entry.details)}</div>` : ""}
        </div>
    `).join('');
};

clearAdminLog = () => {
    sessionMemory.adminLog = [];
    renderAdminLog();
    updatePanelStats();
    statusMessage("success", "Admin log cleared");
};

exportAdminLogTxt = () => {
    if (!hasAdminPanelDOM()) return statusMessage("error", "Admin log export is available in the web dashboard.");
    const rows = (sessionMemory.adminLog || []).slice().reverse();
    const text = rows.length
        ? rows.map(entry => `[${entry.time}] ${entry.action} | ${entry.target}${entry.details ? " | " + entry.details : ""}`).join("\n")
        : "No admin log entries.";
    const blob = new Blob([text], { type: "text/plain" });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = "s2f-admin-log.txt";
    link.click();
    URL.revokeObjectURL(link.href);
};

const getEndCeremonySecondsLeft = () => {
    if (adminRuntime.endCeremonyEndsAt < 0 || typeof game === "undefined") return -1;
    return Math.max(0, Math.ceil((adminRuntime.endCeremonyEndsAt - game.step) / 60));
};

renderEndCeremonyStatus = () => {
    if (!hasAdminPanelDOM()) return;
    const status = document.getElementById('s2f-end-status');
    if (!status) return;
    if (adminRuntime.endCeremonyRunning) {
        status.textContent = `Podium is showing. Mod stops in ${getEndCeremonySecondsLeft()}s.`;
    } else if (adminRuntime.endCeremonyEndsAt >= 0) {
        status.textContent = `End ceremony starts in ${getEndCeremonySecondsLeft()}s.`;
    } else {
        status.textContent = "No end ceremony timer active.";
    }
};

const getPodiumRows = () => {
    return getLeaderboardRows().map(row => ({
        ...row,
        score: Math.max(0, row.wins * 3 - row.losses)
    })).sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.wins !== a.wins) return b.wins - a.wins;
        if (a.losses !== b.losses) return a.losses - b.losses;
        if (b.best !== a.best) return b.best - a.best;
        return a.name.localeCompare(b.name);
    }).slice(0, 3);
};

const hideGameplayControls = (ship) => {
    if (!ship?.custom?.joined) return;
    [
        "btn_ready", "btn_training", "btn_spectate", "btn_invite", "btn_history", "btn_rematch", "btn_admin_ship",
        "chooser", "shipview", "map", "mapview", "invite_screen", "invprev", "invnext",
        "spprev", "spnext", "history_panel", "hist_global", "hist_personal",
        "duel_center_message", "countdown_container", "duel_opponent_banner", "timed_message"
    ].forEach(id => sendUI(ship, { id, visible: false }));
    let shipButtons = (typeof max_ship_items === "number" ? max_ship_items : 8);
    for (let i = 0; i < shipButtons; i++) sendUI(ship, { id: "s" + i, visible: false });
    let nodeButtons = (typeof nW === "number" && typeof nH === "number") ? nW * nH : 15;
    for (let i = 0; i < nodeButtons; i++) sendUI(ship, { id: "n" + i, visible: false });
    let maxID = game?.custom?.maxID || 0;
    for (let id = 0; id <= maxID; id++) {
        for (let prefix of ["invite", "accept", "decline"]) sendUI(ship, { id: prefix + id, visible: false });
    }
};

const pushPodiumSlot = (components, row, place, x, y, w, h, color, title) => {
    let headerH = place === 1 ? 13 : 11;
    let nameSize = row?.name?.length > 18 ? 4.2 : row?.name?.length > 12 ? 5.1 : 6.4;
    components.push({ type: 'box', position: [x, y, w, h], fill: "hsla(210,55%,8%,0.88)", stroke: color, width: place === 1 ? 4 : 3 });
    components.push({ type: 'box', position: [x, y, w, headerH], fill: place === 1 ? "hsla(194,80%,18%,0.82)" : "hsla(212,70%,15%,0.82)" });
    components.push({ type: 'box', position: [x, y, w, 1.2], fill: color });
    components.push({ type: 'text', position: [x, y + 2.4, w, 8], value: title, color, align: "center", size: place === 1 ? 6.4 : 5.2, bold: true });
    if (row) {
        components.push({ type: 'text', position: [x + 3, y + headerH + 6, w - 6, 9], value: row.name, color: C.text_hi, align: "center", size: nameSize, bold: true });
        components.push({ type: 'box', position: [x + 5, y + h - 19, w - 10, 13], fill: "hsla(202,64%,9%,0.76)", stroke: "hsla(188,90%,58%,0.35)", width: 1 });
        components.push({ type: 'text', position: [x + 5, y + h - 15.5, w - 10, 5], value: `K ${row.wins}    D ${row.losses}    BEST ${row.best || 0}`, color: C.text_mid, align: "center", size: place === 1 ? 4.0 : 3.5, bold: true });
    } else {
        components.push({ type: 'text', position: [x + 3, y + 20, w - 6, 8], value: "No player", color: C.text_lo, align: "center", size: 5 });
    }
};

const showEndCeremonyBanner = (secondsLeft, title = "FINAL RESULTS") => {
    let podium = getPodiumRows();
    let components = [
        { type: 'box', position: [0, 0, 100, 100], fill: "hsla(214,62%,5%,0.985)", stroke: C.accent_glow, width: 5 },
        { type: 'box', position: [0, 0, 100, 17], fill: "hsla(210,64%,12%,0.96)" },
        { type: 'box', position: [0, 17, 100, 1.1], fill: C.accent_glow },
        { type: 'box', position: [4, 19.2, 92, 0.4], fill: "hsla(188,90%,58%,0.45)" },
        { type: 'round', position: [-5, -5, 10, 10], fill: C.accent_glow },
        { type: 'round', position: [95, -5, 10, 10], fill: C.accent_glow },
        { type: 'round', position: [95, 95, 10, 10], fill: C.accent },
        { type: 'round', position: [-5, 95, 10, 10], fill: C.accent },
        { type: 'text', position: [0, 2.3, 100, 8], value: title, color: C.accent_glow, align: "center", size: 7.2, bold: true },
        { type: 'text', position: [0, 11.3, 100, 4.5], value: `Closing in ${Math.max(0, secondsLeft)} seconds`, color: C.text_mid, align: "center", size: 3.8, bold: true }
    ];
    pushPodiumSlot(components, podium[1], 2, 4, 40, 28, 42, "hsla(190,100%,55%,1)", "2ND PLACE");
    pushPodiumSlot(components, podium[0], 1, 32, 23, 36, 55, "hsla(188,100%,72%,1)", "1ST PLACE");
    pushPodiumSlot(components, podium[2], 3, 68, 43, 28, 39, "hsla(205,100%,62%,1)", "3RD PLACE");
    components.push({ type: 'text', position: [0, 88, 100, 4], value: "K = kills/wins    D = deaths/losses", color: C.text_lo, align: "center", size: 3.0 });

    for (let ship of game.ships) {
        if (!ship?.custom?.joined) continue;
        hideGameplayControls(ship);
        sendUI(ship, {
            id: "end_ceremony_banner",
            position: [0, 0, 100, 100],
            visible: true,
            clickable: false,
            components
        });
    }
};

const hideEndCeremonyBanner = () => {
    for (let ship of game.ships) {
        if (ship?.custom?.joined) sendUI(ship, { id: "end_ceremony_banner", visible: false });
    }
};

showEndCeremonyNow = (stopDelay = 30, title = "FINAL RESULTS") => {
    stopDelay = Math.max(5, Math.min(120, Number(stopDelay) || 30));
    title = normalizePanelText(title) || "FINAL RESULTS";
    let token = ++adminRuntime.endCeremonyToken;
    adminRuntime.endCeremonyRunning = true;
    adminRuntime.endCeremonyEndsAt = game.step + stopDelay * 60;
    adminRuntime.endCeremonyStopDelay = stopDelay;
    adminRuntime.endCeremonyTitle = title;
    cancelCloseModCountdown();
    teleportEveryoneToLobby();
    addAdminLog("End Ceremony", "Final podium", `Showing top 3, stopping in ${stopDelay}s`, "danger");
    const podiumTick = (secondsLeft) => {
        if (token !== adminRuntime.endCeremonyToken) return;
        showEndCeremonyBanner(secondsLeft, title);
        renderEndCeremonyStatus();
        if (secondsLeft <= 0) {
            hideEndCeremonyBanner();
            adminRuntime.endCeremonyRunning = false;
            adminRuntime.endCeremonyEndsAt = -1;
            renderEndCeremonyStatus();
            game.modding.commands.stop();
            return;
        }
        modUtils.setTimeout(() => podiumTick(secondsLeft - 1), 60);
    };
    podiumTick(stopDelay);
};

startEndCeremonyTimer = (minutes = 10, stopDelay = 30, title = "FINAL RESULTS") => {
    minutes = Number(minutes);
    stopDelay = Math.max(5, Math.min(120, Number(stopDelay) || 30));
    title = normalizePanelText(title) || "FINAL RESULTS";
    if (!Number.isFinite(minutes) || minutes <= 0) return statusMessage("error", "End timer must be more than 0 minutes");
    let seconds = Math.ceil(minutes * 60);
    let token = ++adminRuntime.endCeremonyToken;
    adminRuntime.endCeremonyRunning = false;
    adminRuntime.endCeremonyEndsAt = game.step + seconds * 60;
    adminRuntime.endCeremonyStopDelay = stopDelay;
    adminRuntime.endCeremonyTitle = title;
    addAdminLog("End Timer", "Final podium", `Starts in ${seconds}s, then stops ${stopDelay}s after podium`, "warn");
    statusMessage("warn", `End ceremony starts in ${seconds} seconds`);
    const timerTick = () => {
        if (token !== adminRuntime.endCeremonyToken || adminRuntime.endCeremonyEndsAt < 0) return;
        let secondsLeft = getEndCeremonySecondsLeft();
        renderEndCeremonyStatus();
        if (secondsLeft <= 10 && secondsLeft > 0) {
            for (let ship of game.ships) showCloseBanner(ship, "Final results", secondsLeft);
        }
        if (secondsLeft <= 0) {
            for (let ship of game.ships) hideCloseBanner(ship);
            showEndCeremonyNow(stopDelay, title);
            return;
        }
        modUtils.setTimeout(timerTick, 60);
    };
    renderEndCeremonyStatus();
    timerTick();
};

cancelEndCeremonyTimer = () => {
    adminRuntime.endCeremonyToken++;
    adminRuntime.endCeremonyEndsAt = -1;
    adminRuntime.endCeremonyRunning = false;
    for (let ship of game.ships) hideCloseBanner(ship);
    hideEndCeremonyBanner();
    renderEndCeremonyStatus();
    addAdminLog("End Timer", "Final podium", "Cancelled", "info");
    statusMessage("info", "End ceremony cancelled");
};

saveRematchSettings = () => {
    const seconds = document.getElementById('S2F_rematchSeconds');
    adminRuntime.rematchOfferSeconds = Math.round(clampPanelNumber(seconds?.value, 5, 90, adminRuntime.rematchOfferSeconds));
    if (seconds) seconds.value = String(adminRuntime.rematchOfferSeconds);
    addAdminLog("Rematch Settings", "System", `Offer window set to ${adminRuntime.rematchOfferSeconds}s`, "info");
    statusMessage("success", "Rematch settings updated");
};

const newLine      = () => game.modding.terminal.echo(" ");
const centeredEcho = (msg, color = "") => {
    const ECHO_SPAN = 105;
    game.modding.terminal.echo(`${" ".repeat(~~((ECHO_SPAN / 2) - Array.from(msg).length / 2))}${color}${msg}`);
};
const anchoredEcho = (msgLeft, msgRight, color = "", anchor) =>
    game.modding.terminal.echo(color + `${" ".repeat(~~((105 / 2) - (anchor.length / 2)) - Array.from(msgLeft).length)}${msgLeft}${anchor}${msgRight}`, " ");

const forceShipGameover = (ship, reason = "Removed by moderator") => {
    if (!ship?.custom || ship.custom.gameoverQueued) return false;
    ship.custom.gameoverQueued = true;
    ship.custom.exited = true;
    modUtils.setTimeout(() => {
        try {
            ship.gameover({
                "Reason": reason,
                "Wins": getStat(ship, "wins"),
                "Draws": getStat(ship, "draws"),
                "Losses": getStat(ship, "losses"),
                "Best Streak": getStat(ship, "maxStreak"),
                "Rank": +ship.custom.rank || "Unranked"
            });
        } catch (err) {
            console.warn(err);
        }
    }, 3);
    return true;
};

const kickPlayer = (ship, reason = "", logMessage = "", keepLockedUntilLeave = true) => {
    if (!ship) return false;
    if (ship.custom?.adminKickPending) return false;
    if (ship.custom) ship.custom.adminKickPending = true;
    if (keepLockedUntilLeave && !sessionMemory.kickQueue.includes(ship.id)) sessionMemory.kickQueue.push(ship.id);
    if (ship.custom) {
        ship.custom.kickReason = reason || "You were kicked by a moderator";
        ship.custom.gameoverQueued = false;
    }
    if (logMessage) statusMessage("success", logMessage);
    forceShipGameover(ship, reason || "You were kicked by a moderator");
    ship.set({ kill: true });
    addAdminLog("Kick", getPlayerLabel(ship), reason || "Player removed by moderator", "warn");
    return true;
};

const enforceRemovalLock = (ship) => {
    if (!ship?.custom) return false;
    if (isSessionBanned(ship)) {
        if (!sessionMemory.bannedShipIds.includes(ship.id)) sessionMemory.bannedShipIds.push(ship.id);
        if (!sessionMemory.kickQueue.includes(ship.id)) sessionMemory.kickQueue.push(ship.id);
        ship.custom.kickReason = "You have been banned";
        ship.custom.adminKickPending = true;
        forceShipGameover(ship, "You have been banned");
        return true;
    }
    if (isQueuedForKick(ship)) {
        ship.custom.kickReason = ship.custom.kickReason || "You were kicked by a moderator";
        ship.custom.adminKickPending = true;
        forceShipGameover(ship, ship.custom.kickReason);
        return true;
    }
    return false;
};

kick = (id, shouldReport = true) => {
    let ship = shipByID(id);
    if (!ship) return statusMessage("error", "No ship with the specified ID");
    kickPlayer(ship, "", shouldReport ? `${ship.name} has been kicked` : "");
};

ban = (id, reason) => {
    let ship = shipByID(id);
    if (!ship) return statusMessage("error", "No ship with the specified ID");
    if (sessionMemory.banned.includes(ship.name))
        return statusMessage("info", `${ship.name} is already banned`);
    sessionMemory.banned.push(ship.name);
    if (!sessionMemory.bannedShipIds.includes(ship.id)) sessionMemory.bannedShipIds.push(ship.id);
    kickPlayer(ship, reason || "You have been banned", `${ship.name} has been banned`, true);
    addAdminLog("Ban", getPlayerLabel(ship), reason || "No reason supplied", "danger");
    updateBannedDropdown();
    updatePanelStats();
};

unban = (ind) => {
    ind = Number(ind);
    if (isNaN(ind) || ind < 0 || ind >= sessionMemory.banned.length)
        return statusMessage("error", "Invalid index. Use bannedList() to find indexes.");
    const unbannedName = sessionMemory.banned[ind];
    statusMessage("success", `${unbannedName} is no longer banned`);
    sessionMemory.bannedShipIds = sessionMemory.bannedShipIds.filter(id => {
        let target = shipByID(id);
        return target && target.name !== unbannedName;
    });
    sessionMemory.banned = removeIndexFromArray(sessionMemory.banned, ind);
    addAdminLog("Unban", unbannedName, "Removed from session ban list", "success");
    updateBannedDropdown();
    updatePanelStats();
};

bannedList = () => {
    newLine();
    centeredEcho("Banned list:", "[[ub;#FF4f4f;]");
    anchoredEcho("Player name ", " Index", "[[b;#5FFFFF;]", "|");
    sessionMemory.banned.forEach((name, i) => anchoredEcho(`${name} `, ` ${i}`, "[[;#FFFFFF;]", "|"));
    newLine();
};

showIDs = () => {
    newLine();
    centeredEcho("Player list:", "[[ub;#FF4f4f;]");
    anchoredEcho("Player name ", " Player ID", "[[b;#5FFFFF;]", "|");
    for (let ship of game.ships)
        anchoredEcho(`${ship.name} `, ` ${ship.id}`, "[[;#FFFFFF;]", "|");
    newLine();
};

adminList = () => {
    newLine();
    centeredEcho("Admin list:", "[[ub;#FF4f4f;]");
    anchoredEcho("Player name ", " Player ID", "[[b;#5FFFFF;]", "|");
    for (let id of sessionMemory.admins) {
        let idx = fetchShip(id);
        if (idx !== -1) anchoredEcho(`${game.ships[idx].name} `, ` ${id}`, "[[;#FFFFFF;]", "|");
    }
    newLine();
};

giveAdmin = (id) => {
    for (let ship of game.ships) {
        if (ship.id === id) {
            if (!sessionMemory.admins.includes(id)) {
                sessionMemory.admins.push(id);
                sendAdminShipButton(ship, true);
                addAdminLog("Admin Role", getPlayerLabel(ship), "Granted admin privileges", "success");
                return statusMessage("success", `${ship.name} (ID: ${id}) has been granted admin privileges`);
            } else {
                return statusMessage("info", `Player is already admin. Do removeAdmin(${id}) to remove`);
            }
        }
    }
    return statusMessage("error", `Player with the id of ${id} doesn't exist`);
};

removeAdmin = (id) => {
    if (!sessionMemory.admins.includes(id))
        return statusMessage("error", `There is no admin with the id of ${id}`);
    sessionMemory.admins = removeFromArray(sessionMemory.admins, id);
    let idx = fetchShip(id);
    if (idx !== -1) {
        game.ships[idx].custom.adminShipActive = false;
        max(game.ships[idx], game.ships[idx].custom.prevShipCode || game.ships[idx].custom.type || game.ships[idx].type);
        sendAdminShipButton(game.ships[idx], false);
        addAdminLog("Admin Role", getPlayerLabel(game.ships[idx]), "Removed admin privileges", "warn");
        statusMessage("success", `${game.ships[idx].name} (ID: ${id}) no longer has admin privileges`);
    }
};

const updatePanelStats = () => {
    if (!hasAdminPanelDOM()) return;
    let online = document.getElementById('s2f-stat-online');
    let banned = document.getElementById('s2f-stat-banned');
    let forced = document.getElementById('s2f-stat-forced');
    let matches = document.getElementById('s2f-stat-matches');
    let frozen = document.getElementById('s2f-stat-frozen');
    let paused = document.getElementById('s2f-stat-paused');
    let alienCountEl = document.getElementById('s2f-stat-aliens');
    let logs = document.getElementById('s2f-stat-logs');
    if (online) online.textContent = String(game.ships.length);
    if (banned) banned.textContent = String(sessionMemory.banned.length);
    if (forced) forced.textContent = String(sessionMemory.forcedSpectators.length);
    if (matches) matches.textContent = String(sessionMemory.globalMatchHistory.length);
    if (frozen) frozen.textContent = String(sessionMemory.frozenPlayers.length);
    if (paused) paused.textContent = isGameplayPaused() ? "YES" : "NO";
    if (alienCountEl) alienCountEl.textContent = `${adminRuntime.trainingAlienCount}/P`;
    if (logs) logs.textContent = String(sessionMemory.adminLog.length);
    if (typeof renderEndCeremonyStatus === "function") renderEndCeremonyStatus();
};

// FIX: Removed 'const' so these are globally accessible from DOM onclick handlers

clearPlayerHistoryReferences = (playerName) => {
    if (!playerName) return;
    sessionMemory.globalMatchHistory = sessionMemory.globalMatchHistory.filter(entry =>
        entry.leftPlayer !== playerName &&
        entry.rightPlayer !== playerName &&
        entry.winnerName !== playerName
    );
    for (let ship of game.ships) {
        if (!Array.isArray(ship?.custom?.duelHistory)) continue;
        ship.custom.duelHistory = ship.custom.duelHistory.filter(entry => entry.opponent !== playerName);
    }
};

refreshOpenHistoryPanels = () => {
    for (let ship of game.ships) {
        if (ship?.custom?.joined && ship.custom.history_shown) showHistoryPanel(ship);
    }
};

refreshLeaderboardAndHistoryViews = () => {
    if (typeof updatescoreboard === "function") updatescoreboard(game);
    renderPanelLeaderboard();
    renderPanelHistory();
    updatePanelStats();
    refreshOpenHistoryPanels();
};

resetShipStats = (ship) => {
    if (!ship?.custom) return;
    ship.custom.wins = 0;
    ship.custom.losses = 0;
    ship.custom.draws = 0;
    ship.custom.streak = 0;
    ship.custom.maxStreak = 0;
    ship.custom.rank = 0;
    ship.custom.isLastLost = false;
    ship.custom.lastMatchStep = -1;
    ship.custom.duelHistory = [];
    ship.custom.justWin = false;
    ship.custom.justLose = false;
    ship.custom.justDraw = false;
    ship.custom.killFeed = [];
    ship.custom.endgameText = "";
    ship.set({ score: 0 });
};

resetPlayerLeaderboard = (id) => {
    return clearPlayerHistory(id);
};

clearPlayerHistory = (id) => {
    let ship = shipByID(Number(id));
    if (!ship) return statusMessage("error", "No ship with the specified ID");
    ship.custom.duelHistory = [];
    clearPlayerHistoryReferences(ship.name);
    refreshLeaderboardAndHistoryViews();
    addAdminLog("Clear History", getPlayerLabel(ship), "Player history cleared", "warn");
    statusMessage("success", `${ship.name}'s history was cleared`);
};

refreshAdminPanel = (shouldReport = true) => {
    updatePlayerDropdown();
    updateBannedDropdown();
    refreshLeaderboardAndHistoryViews();
    if (shouldReport) statusMessage("info", "Admin panel refreshed");
};

sendPlayerToLobby = (id, shouldReport = true) => {
    let ship = shipByID(Number(id));
    if (!ship?.custom?.joined) return statusMessage("error", "No ship with the specified ID");
    if (ship.custom.arena && !ship.custom.arena.lobby && ship.custom.arena.started) {
        clearDuelCountdown(ship.custom.arena);
    }
    ship.custom.ready = false;
    ship.custom.spectate = false;
    ship.custom.shipped = false;
    ship.custom.mapped = false;
    ship.custom.invite_shown = false;
    ship.custom.history_shown = false;
    ship.custom.pendingTp = -1;
    ship.custom.paired = null;
    ship.custom.inTraining = false;
    hideHistoryPanel(ship);
    max(ship, ship.custom.prevShipCode || ship.custom.type || ship.type);
    ArenaManager.set(ship, lobby, true);
    ship.set({ idle: false, invulnerable: 600, vx: 0, vy: 0 });
    addAdminLog("Lobby Teleport", getPlayerLabel(ship), "Sent selected player to lobby", "info");
    if (shouldReport) statusMessage("success", `${ship.name} was sent to the lobby`);
};

// FIX: Release All Forced Spectators - removed 'const', properly clears spectate state
// and resets ship to lobby so UI is fully refreshed on next tick
releaseAllForcedSpectators = () => {
    let released = 0;
    let toRelease = [...sessionMemory.forcedSpectators];
    sessionMemory.forcedSpectators = [];
    for (let id of toRelease) {
        let ship = shipByID(id);
        if (!ship || !ship.custom) continue;
        ship.custom.spectate = false;
        ship.custom.ready = false;
        ship.custom.shipped = false;
        ship.custom.mapped = false;
        ship.custom.invite_shown = false;
        ship.custom.history_shown = false;
        ship.custom.pendingTp = -1;
        ship.custom.inTraining = false;
        ship.custom.arena = ArenaManager.lobby || ship.custom.arena;
        max(ship, ship.custom.prevShipCode || ship.custom.type || ship.type);
        ArenaManager.set(ship, lobby, true);
        ship.set({ idle: false, invulnerable: 600, vx: 0, vy: 0 });
        showAdminAnnouncement(ship, "MODERATOR ACTION", "You can play again.", 4);
        released++;
    }
    updatePanelStats();
    addAdminLog("Spectate Release", "All forced spectators", `Released ${released} player${released === 1 ? "" : "s"}`, "success");
    statusMessage("success", `Released ${released} forced spectator${released === 1 ? "" : "s"}`);
};

kickAllBannedPlayers = () => {
    let kicked = 0;
    for (let ship of game.ships) {
        if (!isSessionBanned(ship)) continue;
        if (kickPlayer(ship, "You have been banned", "", true)) kicked++;
    }
    addAdminLog("Kick Banned", "Ban list", `Removed ${kicked} banned player${kicked === 1 ? "" : "s"}`, "warn");
    statusMessage("warn", `Removed ${kicked} banned player${kicked === 1 ? "" : "s"}`);
};

resetAllLeaderboardStats = () => {
    for (let ship of game.ships) resetShipStats(ship);
    sessionMemory.globalMatchHistory = [];
    refreshLeaderboardAndHistoryViews();
    addAdminLog("Reset Stats", "All players", "Leaderboard stats and match history reset", "danger");
    statusMessage("success", "All leaderboard stats and match history were reset");
};

clearGlobalHistory = () => {
    sessionMemory.globalMatchHistory = [];
    refreshLeaderboardAndHistoryViews();
    addAdminLog("Clear History", "Global match history", "All global match entries cleared", "warn");
    statusMessage("success", "Global match history was cleared");
};

const addGlobalMatchHistory = (leftPlayer, rightPlayer, resultLabel, winnerName = "", details = "") => {
    sessionMemory.globalMatchHistory.push({
        leftPlayer,
        rightPlayer,
        resultLabel,
        winnerName,
        details,
        time: new Date().toLocaleTimeString('en-GB', { hour12: false })
    });
    if (sessionMemory.globalMatchHistory.length > 250) {
        sessionMemory.globalMatchHistory = sessionMemory.globalMatchHistory.slice(-250);
    }
    renderPanelHistory();
    updatePanelStats();
};

const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const getPlayerGlobalSummary = (ship) => {
    let playerName = ship?.name || "";
    let entries = sessionMemory.globalMatchHistory.filter(entry =>
        entry.leftPlayer === playerName || entry.rightPlayer === playerName
    );
    return {
        matches: entries.length,
        wins: entries.filter(entry => entry.winnerName === playerName).length,
        draws: entries.filter(entry => entry.resultLabel === "Draw").length
    };
};

const getLeaderboardRows = () => {
    return game.ships.map(ship => ({
        id: ship.id,
        name: ship.name,
        wins: getStat(ship, "wins"),
        losses: getStat(ship, "losses"),
        draws: getStat(ship, "draws"),
        streak: getStat(ship, "streak"),
        best: getStat(ship, "maxStreak"),
        rank: +ship.custom.rank || 0
    })).sort((a, b) => {
        if ((a.rank || Infinity) !== (b.rank || Infinity)) return (a.rank || Infinity) - (b.rank || Infinity);
        if (b.wins !== a.wins) return b.wins - a.wins;
        if (a.losses !== b.losses) return a.losses - b.losses;
        return a.name.localeCompare(b.name);
    });
};

renderPanelLeaderboard = () => {
    if (!hasAdminPanelDOM()) return;
    const container = document.getElementById('s2f-leaderboard-view');
    if (!container) return;
    const rows = getLeaderboardRows();
    if (rows.length === 0) {
        container.innerHTML = '<div class="s2f-empty">No players online.</div>';
        return;
    }
    container.innerHTML = `
        <table class="s2f-table">
            <thead>
                <tr>
                    <th>#</th>
                    <th>Player</th>
                    <th>W</th>
                    <th>L</th>
                    <th>D</th>
                    <th>Streak</th>
                    <th>Best</th>
                </tr>
            </thead>
            <tbody>
                ${rows.map((row, index) => `
                    <tr>
                        <td>${escapeHtml(row.rank || index + 1)}</td>
                        <td>${escapeHtml(row.name)}</td>
                        <td style="color:#4ade80">${row.wins}</td>
                        <td style="color:#f87171">${row.losses}</td>
                        <td style="color:#fbbf24">${row.draws}</td>
                        <td>${row.streak > 0 ? row.streak : '-'}</td>
                        <td>${row.best}</td>
                    </tr>
                `).join("")}
            </tbody>
        </table>
    `;
};

renderPanelHistory = () => {
    if (!hasAdminPanelDOM()) return;
    const container = document.getElementById('s2f-history-view');
    if (!container) return;
    const entries = sessionMemory.globalMatchHistory.slice().reverse();
    if (entries.length === 0) {
        container.innerHTML = '<div class="s2f-empty">No matches recorded yet.</div>';
        return;
    }
    const totalDraws = entries.filter(entry => entry.resultLabel === "Draw").length;
    const totalWins = entries.length - totalDraws;
    let histHTML = entries.map(entry => `
        <div class="s2f-history-item">
            <div class="s2f-history-top">
                <strong>${escapeHtml(entry.leftPlayer)} vs ${escapeHtml(entry.rightPlayer)}</strong>
                <span>${escapeHtml(entry.time)}</span>
            </div>
            <div class="s2f-history-bottom">
                <span class="s2f-history-badge ${entry.resultLabel === "Draw" ? "draw" : "win"}">${escapeHtml(entry.resultLabel)}</span>
                ${entry.winnerName ? `<span>Winner: <strong>${escapeHtml(entry.winnerName)}</strong></span>` : `<span>${escapeHtml(entry.details || "Draw")}</span>`}
            </div>
        </div>
    `).join("");
    container.innerHTML = `
        <div class="s2f-history-summary">
            <div class="s2f-history-pill"><span>Total</span><strong>${entries.length}</strong></div>
            <div class="s2f-history-pill"><span>Wins</span><strong>${totalWins}</strong></div>
            <div class="s2f-history-pill"><span>Draws</span><strong>${totalDraws}</strong></div>
        </div>
        ${histHTML}
    `;
};

exportLeaderboardTxt = () => {
    if (!hasAdminPanelDOM()) return statusMessage("error", "Leaderboard export is available in the web dashboard.");
    const rows = getLeaderboardRows();
    const lines = [
        "S2F Leaderboard Export",
        `Generated: ${new Date().toLocaleString('en-GB', { hour12: false })}`,
        "",
        "Rank | Player | Wins | Losses | Draws | Streak | Best"
    ];
    rows.forEach((row, index) => {
        lines.push(`${row.rank || index + 1} | ${row.name} | ${row.wins} | ${row.losses} | ${row.draws} | ${row.streak} | ${row.best}`);
    });
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "s2f-leaderboard.txt";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
    statusMessage("success", "Leaderboard exported as TXT");
};

const showAdminAnnouncement = (ship, title, message, duration = 6) => {
    if (!ship?.custom?.joined) return;
    let token = (ship.custom.adminAnnouncementToken || 0) + 1;
    ship.custom.adminAnnouncementToken = token;
    let lines = wrapPanelText(message, 28, 3);
    sendUI(ship, {
        id: "admin_announcement",
        position: [17, 31, 66, 18],
        visible: true,
        clickable: false,
        components: [
            { type: 'box', position: [0, 0, 100, 100], fill: "hsla(205, 42%, 9%, 0.96)", stroke: C.accent_glow, width: 5 },
            { type: 'box', position: [0, 0, 100, 18], fill: "hsla(186, 90%, 28%, 0.95)" },
            { type: 'box', position: [0, 18, 100, 1.5], fill: C.gold },
            { type: 'round', position: [-7, -7, 14, 14], fill: C.accent },
            { type: 'round', position: [93, -7, 14, 14], fill: C.accent },
            { type: 'round', position: [-7, 93, 14, 14], fill: C.gold },
            { type: 'round', position: [93, 93, 14, 14], fill: C.gold },
            { type: 'text', position: [0, 4, 100, 10], value: title, color: C.text_hi, align: "center", size: 5, bold: true },
            ...lines.map((line, index) => ({
                type: 'text',
                position: [6, 30 + index * 16, 88, 12],
                value: line,
                color: index === 0 ? C.accent_glow : C.text_hi,
                align: "center",
                size: index === 0 ? 7 : 6,
                bold: true
            }))
        ]
    });
    modUtils.setTimeout(() => {
        if (ship.custom?.adminAnnouncementToken === token) sendUI(ship, { id: "admin_announcement", visible: false });
    }, Math.max(1, Number(duration) || 6) * 60);
};

privateMessage = (id, message, duration = 6, title = "PRIVATE MESSAGE") => {
    let ship = shipByID(Number(id));
    message = normalizePanelText(message);
    duration = Number(duration);
    if (!ship) return statusMessage("error", "No ship with the specified ID");
    if (!message) return statusMessage("error", "Private message text is empty");
    if (!Number.isFinite(duration) || duration <= 0) duration = 6;
    showAdminAnnouncement(ship, title, message, duration);
    addAdminLog("Private Message", getPlayerLabel(ship), message, "info");
    statusMessage("success", `Private message sent to ${ship.name}`);
};

pm = privateMessage;

const showCloseBanner = (ship, message, secondsLeft) => {
    if (!ship?.custom?.joined) return;
    sendUI(ship, {
        id: "admin_close_banner",
        position: [1, 87, 18, 11],
        visible: true,
        clickable: false,
        components: [
            { type: 'box', position: [0, 0, 100, 100], fill: "hsla(208, 45%, 10%, 0.94)", stroke: C.gold, width: 4 },
            { type: 'box', position: [0, 0, 100, 30], fill: "hsla(203, 90%, 30%, 0.96)" },
            { type: 'round', position: [-6, -6, 12, 12], fill: C.accent },
            { type: 'round', position: [94, -6, 12, 12], fill: C.accent },
            { type: 'round', position: [-6, 94, 12, 12], fill: C.gold },
            { type: 'round', position: [94, 94, 12, 12], fill: C.gold },
            { type: 'text', position: [3, 3, 94, 24], value: "SERVER", color: C.text_hi, align: "center", size: 4, bold: true },
            { type: 'text', position: [3, 32, 94, 28], value: message.slice(0, 15), color: C.text_mid, align: "center", size: 3 },
            { type: 'text', position: [3, 58, 94, 36], value: `${secondsLeft}s`, color: C.gold, align: "center", size: 8, bold: true }
        ]
    });
};

const hideCloseBanner = (ship) => {
    if (ship?.custom?.joined) sendUI(ship, { id: "admin_close_banner", visible: false });
};

const enforceAnnouncementPause = () => {
    if (!isAnnouncementPauseActive()) return;
    for (let ship of game.ships) {
        if (!ship?.custom?.joined || !ship.alive) continue;
        ship.set({ vx: 0, vy: 0 });
        ship.emptyWeapons();
    }
};

const beginAnnouncementPause = (duration) => {
    let pauseTicks = Math.max(1, Math.ceil((Number(duration) || 6) * 60));
    let pauseUntil = game.step + pauseTicks;
    if (pauseUntil <= adminRuntime.announcementPauseUntil) return;
    let token = ++adminRuntime.announcementPauseToken;
    adminRuntime.announcementPauseUntil = pauseUntil;
    updatePanelStats();
    modUtils.setTimeout(() => {
        if (adminRuntime.announcementPauseToken !== token) return;
        adminRuntime.announcementPauseUntil = -1;
        updatePanelStats();
    }, pauseTicks);
};

announceAll = (message, duration = 6) => {
    message = normalizePanelText(message);
    duration = Number(duration);
    if (!message) return statusMessage("error", "Announcement text is empty");
    if (!Number.isFinite(duration) || duration <= 0) duration = 6;
    beginAnnouncementPause(duration);
    let sent = 0;
    for (let ship of game.ships) {
        if (!ship?.custom?.joined) continue;
        showAdminAnnouncement(ship, "SERVER ANNOUNCEMENT", message, duration);
        sent++;
    }
    addAdminLog("Announcement", "All players", message, "info");
    statusMessage("success", `Announcement sent to ${sent} player${sent === 1 ? "" : "s"}`);
};

const applyForcedSpectatorState = (ship, notifyPlayer = true) => {
    if (!ship?.custom?.joined) return false;
    if (ship.custom.arena && !ship.custom.arena.lobby && ship.custom.arena.started) {
        ship.custom.arena.endDuel(false, ship);
    }
    ship.custom.ready = false;
    ship.custom.spectate = true;
    ship.custom.shipped = false;
    ship.custom.mapped = false;
    ship.custom.invite_shown = false;
    ship.custom.history_shown = false;
    ship.custom.pendingTp = -1;
    ship.custom.paired = null;
    ship.custom.inTraining = false;
    clearRematchOffersWithPlayer(ship.id, "Rematch cancelled: opponent is spectating.");
    clearRematchOffer(ship);
    ship.custom.prevShipCode = ship.custom.prevShipCode || ship.custom.type || ship.type;
    hideHistoryPanel(ship);
    max(ship, ship.custom.prevShipCode || ship.custom.type || ship.type);
    ship.custom.arena = ArenaManager.lobby || ship.custom.arena;
    ArenaManager.set(ship, lobby, true);
    ship.set({ idle: false, invulnerable: 600, vx: 0, vy: 0 });
    if (notifyPlayer) showAdminAnnouncement(ship, "MODERATOR ACTION", "You are now forced to spectate.", 4);
    return true;
};

forceSpectate = (id) => {
    let ship = shipByID(Number(id));
    if (!ship) return statusMessage("error", "No ship with the specified ID");
    if (isForcedSpectator(ship)) return statusMessage("info", `${ship.name} is already forced to spectate`);
    sessionMemory.forcedSpectators.push(ship.id);
    applyForcedSpectatorState(ship, true);
    updatePanelStats();
    addAdminLog("Force Spectate", getPlayerLabel(ship), "Locked into spectator mode", "warn");
    statusMessage("success", `${ship.name} is now forced to spectate`);
};

releaseForcedSpectate = (id) => {
    let ship = shipByID(Number(id));
    if (!ship) return statusMessage("error", "No ship with the specified ID");
    if (!isForcedSpectator(ship)) return statusMessage("info", `${ship.name} is not force spectating`);
    sessionMemory.forcedSpectators = removeFromArray(sessionMemory.forcedSpectators, ship.id);
    ship.custom.spectate = false;
    ship.custom.ready = false;
    ship.custom.shipped = false;
    ship.custom.mapped = false;
    ship.custom.invite_shown = false;
    ship.custom.history_shown = false;
    ship.custom.pendingTp = -1;
    max(ship, ship.custom.prevShipCode || ship.custom.type || ship.type);
    ArenaManager.set(ship, lobby, true);
    ship.set({ idle: false, invulnerable: 600, vx: 0, vy: 0 });
    showAdminAnnouncement(ship, "MODERATOR ACTION", "You can play again.", 4);
    updatePanelStats();
    addAdminLog("Spectate Release", getPlayerLabel(ship), "Released from forced spectator mode", "success");
    statusMessage("success", `${ship.name} can play again`);
};

freezePlayer = (id) => {
    let ship = shipByID(Number(id));
    if (!ship) return statusMessage("error", "No ship with the specified ID");
    if (isFrozenPlayer(ship)) return statusMessage("info", `${ship.name} is already frozen`);
    sessionMemory.frozenPlayers.push(ship.id);
    ship.set({ vx: 0, vy: 0 });
    showAdminAnnouncement(ship, "MODERATOR ACTION", "You have been frozen.", 4);
    updatePanelStats();
    addAdminLog("Freeze", getPlayerLabel(ship), "Player movement frozen", "warn");
    statusMessage("success", `${ship.name} is now frozen`);
};

unfreezePlayer = (id) => {
    let ship = shipByID(Number(id));
    if (!ship) return statusMessage("error", "No ship with the specified ID");
    if (!isFrozenPlayer(ship)) return statusMessage("info", `${ship.name} is not frozen`);
    sessionMemory.frozenPlayers = removeFromArray(sessionMemory.frozenPlayers, ship.id);
    showAdminAnnouncement(ship, "MODERATOR ACTION", "You are no longer frozen.", 4);
    updatePanelStats();
    addAdminLog("Unfreeze", getPlayerLabel(ship), "Player movement restored", "success");
    statusMessage("success", `${ship.name} is unfrozen`);
};

unfreezeAll = () => {
    let count = sessionMemory.frozenPlayers.length;
    for (let id of sessionMemory.frozenPlayers) {
        let ship = shipByID(id);
        if (ship) showAdminAnnouncement(ship, "MODERATOR ACTION", "You are no longer frozen.", 3);
    }
    sessionMemory.frozenPlayers = [];
    updatePanelStats();
    addAdminLog("Unfreeze", "All players", `Released ${count} frozen player${count === 1 ? "" : "s"}`, "success");
    statusMessage("success", `Unfroze ${count} player${count === 1 ? "" : "s"}`);
};

forceEveryoneSpectate = () => {
    let count = 0;
    for (let ship of game.ships) {
        if (!ship?.custom?.joined) continue;
        if (!isForcedSpectator(ship)) {
            sessionMemory.forcedSpectators.push(ship.id);
        }
        applyForcedSpectatorState(ship, true);
        count++;
    }
    updatePanelStats();
    addAdminLog("Force Spectate", "All players", `Locked ${count} player${count === 1 ? "" : "s"} into spectator mode`, "warn");
    statusMessage("success", `Forced ${count} player${count === 1 ? "" : "s"} to spectate`);
};

pauseGame = () => {
    adminRuntime.gamePaused = true;
    for (let ship of game.ships) {
        if (!ship?.custom?.joined) continue;
        if (!sessionMemory.frozenPlayers.includes(ship.id)) {
            sessionMemory.frozenPlayers.push(ship.id);
        }
        ship.set({ vx: 0, vy: 0 });
        showAdminAnnouncement(ship, "GAME PAUSED", "The game has been paused.", 4);
    }
    updatePanelStats();
    addAdminLog("Pause", "All players", "Game paused and all players frozen", "warn");
    statusMessage("warn", "Game paused - all players frozen");
};

resumeGame = () => {
    adminRuntime.gamePaused = false;
    for (let ship of game.ships) {
        if (!ship?.custom?.joined) continue;
        sessionMemory.frozenPlayers = removeFromArray(sessionMemory.frozenPlayers, ship.id);
        showAdminAnnouncement(ship, "GAME RESUMED", "The game has resumed.", 3);
    }
    updatePanelStats();
    addAdminLog("Resume", "All players", "Game resumed and players unfrozen", "success");
    statusMessage("success", "Game resumed");
};

teleportEveryoneToLobby = () => {
    let handledArenas = new Set();
    for (let ship of game.ships) {
        if (!ship?.custom?.joined) continue;
        let arena = ship.custom.arena;
        if (arena && !arena.lobby && arena.started && !handledArenas.has(arena.originalIndex)) {
            handledArenas.add(arena.originalIndex);
            let members = Array.isArray(arena.members) ? [...arena.members] : [];
            members.forEach(member => member && resetShip(member, false));
            clearDuelCountdown(arena);
            arena.duration = 0;
            arena.countdown = 0;
            arena.reset();
        }
        if (isForcedSpectator(ship)) applyForcedSpectatorState(ship, false);
        else {
            ship.custom.ready = false;
            ship.custom.spectate = false;
            ship.custom.shipped = false;
            ship.custom.mapped = false;
            ship.custom.invite_shown = false;
            ship.custom.history_shown = false;
            ship.custom.pendingTp = -1;
            ship.custom.inTraining = false;
            hideHistoryPanel(ship);
            max(ship, ship.custom.prevShipCode || ship.custom.type || ship.type);
            ArenaManager.set(ship, lobby, true);
            ship.set({ idle: false, invulnerable: 600, vx: 0, vy: 0 });
        }
    }
    addAdminLog("Lobby Teleport", "All players", "Moved every joined player to lobby", "info");
    statusMessage("success", "Everyone was teleported back to the lobby");
};

closeModWithCountdown = (seconds = 15, message = "Closing mod") => {
    seconds = Number(seconds);
    message = normalizePanelText(message) || "Closing mod";
    if (!Number.isFinite(seconds) || seconds < 1) return statusMessage("error", "Countdown must be at least 1 second");
    let token = ++adminRuntime.closeCountdownToken;
    adminRuntime.closeCountdownEndsAt = game.step + Math.ceil(seconds) * 60;
    adminRuntime.closeCountdownMessage = message;
    addAdminLog("Close Countdown", "Server", `${seconds}s - ${message}`, "danger");
    const countdownTick = (secondsLeft) => {
        if (token !== adminRuntime.closeCountdownToken) return;
        for (let ship of game.ships) showCloseBanner(ship, message, secondsLeft);
        if (secondsLeft <= 0) {
            for (let ship of game.ships) hideCloseBanner(ship);
            adminRuntime.closeCountdownEndsAt = -1;
            adminRuntime.closeCountdownMessage = "";
            statusMessage("warn", `${message} now`);
            game.modding.commands.stop();
            return;
        }
        modUtils.setTimeout(() => countdownTick(secondsLeft - 1), 60);
    };
    statusMessage("warn", `${message} in ${seconds} seconds`);
    countdownTick(seconds);
};

cancelCloseModCountdown = () => {
    adminRuntime.closeCountdownToken++;
    adminRuntime.closeCountdownEndsAt = -1;
    adminRuntime.closeCountdownMessage = "";
    for (let ship of game.ships) hideCloseBanner(ship);
    addAdminLog("Close Countdown", "Server", "Countdown cancelled", "info");
    statusMessage("info", "Close countdown cancelled");
};

// ---- Set training alien count from admin panel ----
setTrainingAliens = (count) => {
    count = Math.max(1, Math.min(50, Number(count) || 4));
    adminRuntime.trainingAlienCount = count;
    let inp = document.getElementById('S2F_trainingAliens');
    if (inp) inp.value = count;
    let live = document.getElementById('s2f-alien-live');
    if (live) live.textContent = String(count);
    updatePanelStats();
    addAdminLog("Training", "Aliens per player", `Set to ${count} per training player`, "info");
    statusMessage("success", `Training aliens set to ${count} per player`);
};

setTrainingAlienCap = (count) => {
    count = Math.max(4, Math.min(200, Number(count) || 80));
    adminRuntime.trainingAlienCap = count;
    let inp = document.getElementById('S2F_trainingAlienCap');
    if (inp) inp.value = count;
    trimTrainingAliensToTarget();
    updatePanelStats();
    addAdminLog("Training", "Alien performance cap", `Set to ${count} total aliens`, "info");
    statusMessage("success", `Training alien cap set to ${count}`);
};

clearTrainingAliens = () => {
    let removed = trimTrainingAliensToTarget(0, true);
    addAdminLog("Training", "Training aliens", `Cleared ${removed} alien${removed === 1 ? "" : "s"}`, "warn");
    statusMessage("success", `Cleared ${removed} training alien${removed === 1 ? "" : "s"}`);
};

help = () => {
    newLine();
    centeredEcho("S2F Admin Command list:", "[[ub;#FF4f4f;]");
    game.modding.terminal.echo("[[b;#5FFFFF;]Command                      Description");
    game.modding.terminal.echo("[[;#FFFFFF;]showIDs()                    List all player IDs and names");
    game.modding.terminal.echo("[[;#FFFFFF;]kick(id)                     Kick a player by ID");
    game.modding.terminal.echo("[[;#FFFFFF;]ban(id)                      Ban a player by ID");
    game.modding.terminal.echo("[[;#FFFFFF;]unban(index)                 Unban by index");
    game.modding.terminal.echo("[[;#FFFFFF;]forceSpectate(id)            Lock a player into spectator");
    game.modding.terminal.echo("[[;#FFFFFF;]releaseForcedSpectate(id)    Release a forced spectator");
    game.modding.terminal.echo("[[;#FFFFFF;]releaseAllForcedSpectators() Release all forced spectators");
    game.modding.terminal.echo("[[;#FFFFFF;]forceEveryoneSpectate()      Force ALL players to spectate");
    game.modding.terminal.echo("[[;#FFFFFF;]freezePlayer(id)             Freeze a player in place");
    game.modding.terminal.echo("[[;#FFFFFF;]unfreezePlayer(id)           Unfreeze a player");
    game.modding.terminal.echo("[[;#FFFFFF;]unfreezeAll()                Unfreeze all players");
    game.modding.terminal.echo("[[;#FFFFFF;]pauseGame()                  Freeze everyone (pause)");
    game.modding.terminal.echo("[[;#FFFFFF;]resumeGame()                 Unfreeze everyone (resume)");
    game.modding.terminal.echo("[[;#FFFFFF;]sendPlayerToLobby(id)        Return one player to lobby");
    game.modding.terminal.echo("[[;#FFFFFF;]teleportEveryoneToLobby()    Return everyone to lobby");
    game.modding.terminal.echo("[[;#FFFFFF;]announceAll(msg, sec)        Show announcement to everyone");
    game.modding.terminal.echo("[[;#FFFFFF;]closeModWithCountdown(sec)   Countdown then stop the mod");
    game.modding.terminal.echo("[[;#FFFFFF;]startEndCeremonyTimer(min)   Timer, podium, then stop mod");
    game.modding.terminal.echo("[[;#FFFFFF;]showEndCeremonyNow(sec)      Show top-3 podium now");
    game.modding.terminal.echo("[[;#FFFFFF;]cancelEndCeremonyTimer()     Cancel podium/end timer");
    game.modding.terminal.echo("[[;#FFFFFF;]privateMessage(id,msg,sec)   Send popup to one player");
    game.modding.terminal.echo("[[;#FFFFFF;]clearPlayerHistory(id)       Clear one player's history");
    game.modding.terminal.echo("[[;#FFFFFF;]resetAllLeaderboardStats()   Reset all stats + history");
    game.modding.terminal.echo("[[;#FFFFFF;]setTrainingAliens(count)     Set aliens per training player");
    game.modding.terminal.echo("[[;#FFFFFF;]setTrainingAlienCap(count)   Set max training aliens");
    game.modding.terminal.echo("[[;#FFFFFF;]clearTrainingAliens()        Remove current training aliens");
    newLine();
};

// ============================================================
//  DOM ADMIN PANEL - REDESIGNED
// ============================================================

const updatePlayerDropdown = () => {
    if (!hasAdminPanelDOM()) return;
    const selects = ["S2F_playerID", "S2F_forceLeftID", "S2F_forceRightID"]
        .map(id => document.getElementById(id))
        .filter(Boolean);
    if (selects.length === 0) return;
    for (let select of selects) {
        select.innerHTML = '<option value="" disabled selected>- Select a player -</option>';
        for (let ship of game.ships) {
            const option = document.createElement('option');
            option.value = ship.id;
            option.textContent = `[${ship.id}] ${ship.name}`;
            select.appendChild(option);
        }
    }
    updatePanelStats();
};

const updateBannedDropdown = () => {
    if (!hasAdminPanelDOM()) return;
    const bannedSelect = document.getElementById('S2F_bannedPlayerID');
    if (!bannedSelect) return;
    bannedSelect.innerHTML = '<option value="" disabled selected>- Select banned player -</option>';
    sessionMemory.banned.forEach((name, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = name;
        bannedSelect.appendChild(option);
    });
    updatePanelStats();
};

;(function initS2FAdminPanel() {
    if (!hasAdminPanelDOM() || typeof window === "undefined") return;
    const saveAdminSettings = () => {
        try { localStorage.setItem('s2fAdminPanelSettings', JSON.stringify(adminSettings)); } catch(e) {}
    };

    const injectStyles = () => {
        if (document.getElementById('s2f-admin-styles')) return;
        const style = document.createElement('style');
        style.id = 's2f-admin-styles';
        style.textContent = `
            :root {
                --s2f-bg: #08090d;
                --s2f-surface: #11151d;
                --s2f-surface2: #171b24;
                --s2f-border: rgba(116,226,255,0.16);
                --s2f-accent: #40d8ff;
                --s2f-accent2: #4d8dff;
                --s2f-gold: #ffaa00;
                --s2f-green: #00e676;
                --s2f-red: #ff4444;
                --s2f-purple: #a855f7;
                --s2f-orange: #ff7700;
                --s2f-text: #e9f4ff;
                --s2f-text-dim: #89a0b8;
                --s2f-glow: 0 0 18px rgba(64,216,255,0.18);
            }
            #S2F_ADMIN_PANEL {
                z-index: 6;
                font-family: 'Segoe UI', 'Trebuchet MS', sans-serif;
                position: absolute;
                bottom: 0; left: 0;
                width: 100%; height: 100%;
                background: linear-gradient(135deg, #08090d 0%, #101117 48%, #0b1014 100%);
                padding: 0;
                color: var(--s2f-text);
                overflow: hidden;
                display: flex;
                flex-direction: column;
                box-sizing: border-box;
            }
            /* ---- TOP HEADER BAR ---- */
            #s2f-header {
                display: flex;
                align-items: center;
                gap: 18px;
                padding: 16px 24px 12px;
                background: linear-gradient(90deg, rgba(10,13,18,0.99), rgba(16,20,28,0.99));
                border-bottom: 1px solid var(--s2f-border);
                box-shadow: 0 12px 28px rgba(0,0,0,0.22);
                flex-shrink: 0;
                flex-wrap: wrap;
            }
            #s2f-header .s2f-logo {
                font-size: 20px;
                font-weight: 900;
                letter-spacing: 3px;
                text-transform: uppercase;
                background: linear-gradient(90deg, var(--s2f-accent), var(--s2f-gold));
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                background-clip: text;
            }
            #s2f-header .s2f-version {
                font-size: 10px;
                color: var(--s2f-text-dim);
                letter-spacing: 1px;
            }
            #s2f-statbar {
                display: flex;
                gap: 8px;
                flex-wrap: wrap;
                margin-left: auto;
            }
            .s2f-statbadge {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 6px 12px;
                border-radius: 7px;
                background: rgba(255,255,255,0.035);
                border: 1px solid var(--s2f-border);
                font-size: 11px;
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.035);
            }
            .s2f-statbadge span { color: var(--s2f-text-dim); }
            .s2f-statbadge strong { color: #fff; font-size: 13px; }
            /* ---- TAB NAV ---- */
            #s2f-tabs {
                display: flex;
                gap: 6px;
                padding: 10px 16px;
                background: #0d1118;
                border-bottom: 1px solid var(--s2f-border);
                flex-shrink: 0;
                flex-wrap: wrap;
            }
            .s2f-tab {
                padding: 8px 14px;
                border-radius: 7px;
                cursor: pointer;
                font-size: 11px;
                font-weight: 700;
                letter-spacing: 0.8px;
                text-transform: uppercase;
                color: var(--s2f-text-dim);
                border: 1px solid transparent;
                transition: all 0.15s;
                background: rgba(255,255,255,0.025);
                user-select: none;
            }
            .s2f-tab:hover { color: var(--s2f-accent); border-color: rgba(64,216,255,0.16); }
            .s2f-tab.active {
                color: var(--s2f-accent);
                background: rgba(64,216,255,0.09);
                border-color: var(--s2f-border);
            }
            /* ---- CONTENT AREA ---- */
            #s2f-content {
                flex: 1;
                overflow-y: auto;
                padding: 18px 20px 24px;
                scrollbar-width: thin;
                scrollbar-color: rgba(0,200,255,0.2) transparent;
            }
            #s2f-content::-webkit-scrollbar { width: 5px; }
            #s2f-content::-webkit-scrollbar-thumb { background: rgba(0,200,255,0.2); border-radius: 4px; }
            .s2f-tabpanel { display: none; }
            .s2f-tabpanel.active { display: block; }
            /* ---- GRID ---- */
            .s2f-grid { display: grid; grid-template-columns: 1fr; gap: 14px; }
            @media(min-width: 900px) { .s2f-grid { grid-template-columns: repeat(2, 1fr); } }
            @media(min-width: 1300px) { .s2f-grid { grid-template-columns: repeat(3, 1fr); } }
            .s2f-span-2 { grid-column: span 2; }
            .s2f-span-3 { grid-column: 1 / -1; }
            /* ---- CARD ---- */
            .s2f-card {
                background: linear-gradient(180deg, rgba(23,28,38,0.98), rgba(13,17,24,0.98));
                border: 1px solid var(--s2f-border);
                border-radius: 8px;
                padding: 16px;
                position: relative;
                overflow: hidden;
                box-shadow: 0 10px 28px rgba(0,0,0,0.24), inset 0 1px 0 rgba(255,255,255,0.035);
            }
            .s2f-card::before {
                content: '';
                position: absolute;
                top: 0; left: 0; right: 0;
                height: 3px;
                background: linear-gradient(90deg, var(--s2f-accent), rgba(255,255,255,0.15), transparent);
                opacity: 0.72;
            }
            .s2f-card.danger::before { background: linear-gradient(90deg, var(--s2f-red), transparent); }
            .s2f-card.gold::before { background: linear-gradient(90deg, var(--s2f-gold), transparent); }
            .s2f-card.green::before { background: linear-gradient(90deg, var(--s2f-green), transparent); }
            .s2f-card.purple::before { background: linear-gradient(90deg, var(--s2f-purple), transparent); }
            .s2f-card h3 {
                font-size: 11.5px;
                font-weight: 800;
                text-transform: uppercase;
                letter-spacing: 1.5px;
                color: var(--s2f-accent);
                margin: 0 0 12px;
                padding-bottom: 8px;
                border-bottom: 1px solid rgba(116,226,255,0.11);
            }
            .s2f-card.danger h3 { color: var(--s2f-red); }
            .s2f-card.gold h3 { color: var(--s2f-gold); }
            .s2f-card.green h3 { color: var(--s2f-green); }
            .s2f-card.purple h3 { color: var(--s2f-purple); }
            .s2f-card p {
                font-size: 11.5px;
                color: var(--s2f-text-dim);
                line-height: 1.5;
                margin: 0 0 10px;
            }
            /* ---- INPUTS ---- */
            #S2F_ADMIN_PANEL select,
            #S2F_ADMIN_PANEL input[type=text],
            #S2F_ADMIN_PANEL input[type=number],
            #S2F_ADMIN_PANEL textarea {
                font-family: 'Segoe UI', sans-serif;
                width: 100%;
                box-sizing: border-box;
                padding: 9px 12px;
                background: rgba(0,0,0,0.42);
                color: #e0f4ff;
                border: 1px solid var(--s2f-border);
                border-radius: 7px;
                font-size: 12px;
                outline: none;
                transition: border-color 0.15s, box-shadow 0.15s;
            }
            #S2F_ADMIN_PANEL select:focus,
            #S2F_ADMIN_PANEL input:focus,
            #S2F_ADMIN_PANEL textarea:focus {
                border-color: rgba(0,200,255,0.5);
                box-shadow: 0 0 0 2px rgba(0,200,255,0.08);
            }
            #S2F_ADMIN_PANEL textarea { min-height: 72px; resize: vertical; }
            #S2F_ADMIN_PANEL input[type=number] { -moz-appearance: textfield; }
            #S2F_ADMIN_PANEL input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
            /* ---- FORM ROWS ---- */
            .s2f-row { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 10px; }
            .s2f-row:last-child { margin-bottom: 0; }
            .s2f-row > * { flex: 1; min-width: 80px; }
            .s2f-row > button { flex: 0 0 auto; }
            .s2f-label { display: block; font-size: 10px; color: var(--s2f-text-dim); letter-spacing: 0.5px; margin-bottom: 5px; text-transform: uppercase; }
            .s2f-inline { display: flex; gap: 6px; }
            /* ---- BUTTONS ---- */
            #S2F_ADMIN_PANEL button {
                font-family: 'Segoe UI', sans-serif;
                border: none;
                border-radius: 7px;
                cursor: pointer;
                font-size: 11.5px;
                font-weight: 700;
                letter-spacing: 0.3px;
                padding: 9px 14px;
                white-space: nowrap;
                transition: all 0.15s;
                color: #fff;
                box-shadow: 0 6px 14px rgba(0,0,0,0.24), inset 0 1px 0 rgba(255,255,255,0.08);
            }
            #S2F_ADMIN_PANEL button:hover { opacity: 0.88; transform: translateY(-1px); }
            #S2F_ADMIN_PANEL button:active { transform: translateY(0); opacity: 1; }
            .btn-primary  { background: linear-gradient(135deg, #0077ff, #00aaff); }
            .btn-success  { background: linear-gradient(135deg, #00b44a, #00e676); }
            .btn-danger   { background: linear-gradient(135deg, #cc2200, #ff4444); }
            .btn-warn     { background: linear-gradient(135deg, #cc7700, #ffaa00); color: #000 !important; }
            .btn-neutral  { background: linear-gradient(135deg, #1a2a3a, #1e3040); border: 1px solid var(--s2f-border); }
            .btn-purple   { background: linear-gradient(135deg, #6600cc, #a855f7); }
            .btn-ice      { background: linear-gradient(135deg, #005577, #00aacc); }
            .btn-green2   { background: linear-gradient(135deg, #006622, #009933); }
            .btn-red2     { background: linear-gradient(135deg, #880022, #cc1133); }
            .btn-full     { width: 100%; }
            .btn-sm       { padding: 7px 10px; font-size: 10.5px; }
            /* ---- BUTTON GROUP ---- */
            .s2f-btngroup { display: flex; gap: 6px; flex-wrap: wrap; }
            .s2f-btngroup button { flex: 1; }
            /* ---- DIVIDER ---- */
            .s2f-divider { height: 1px; background: var(--s2f-border); margin: 12px 0; }
            /* ---- TABLES ---- */
            .s2f-panelbox { max-height: 260px; overflow: auto; border-radius: 7px; border: 1px solid var(--s2f-border); background: rgba(0,0,0,0.30); box-shadow: inset 0 1px 0 rgba(255,255,255,0.025); }
            .s2f-table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
            .s2f-table th, .s2f-table td { padding: 7px 10px; border-bottom: 1px solid rgba(0,200,255,0.05); text-align: left; }
            .s2f-table th { position: sticky; top: 0; background: rgba(0,30,55,0.98); color: var(--s2f-accent); font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; z-index:1; }
            .s2f-table tr:hover td { background: rgba(0,200,255,0.03); }
            /* ---- HISTORY ---- */
            .s2f-history-summary { display: flex; gap: 8px; flex-wrap: wrap; padding: 10px; border-bottom: 1px solid var(--s2f-border); }
            .s2f-history-pill { min-width: 70px; padding: 7px 10px; border-radius: 8px; background: rgba(0,0,0,0.28); border: 1px solid var(--s2f-border); }
            .s2f-history-pill span { display: block; color: var(--s2f-text-dim); font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; }
            .s2f-history-pill strong { display: block; margin-top: 3px; color: #fff; font-size: 15px; }
            .s2f-history-item { padding: 8px 12px; border-bottom: 1px solid rgba(0,200,255,0.05); }
            .s2f-history-top { display: flex; justify-content: space-between; color: #fff; margin-bottom: 3px; font-size: 12px; flex-wrap: wrap; gap: 6px; }
            .s2f-history-bottom { display: flex; gap: 8px; align-items: center; font-size: 11px; color: var(--s2f-text-dim); }
            .s2f-history-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 800; text-transform: uppercase; background: rgba(0,180,80,0.2); color: #00e676; }
            .s2f-history-badge.draw { background: rgba(255,170,0,0.15); color: #ffaa00; }
            .s2f-empty { padding: 18px; color: var(--s2f-text-dim); font-size: 12px; text-align: center; }
            /* ---- ADMIN LOG ---- */
            .s2f-logitem { padding: 10px 12px; border-bottom: 1px solid rgba(116,226,255,0.08); border-left: 3px solid var(--s2f-accent); background: rgba(0,0,0,0.18); }
            .s2f-logitem.success { border-left-color: var(--s2f-green); }
            .s2f-logitem.warn { border-left-color: var(--s2f-gold); }
            .s2f-logitem.danger { border-left-color: var(--s2f-red); }
            .s2f-logtop { display:flex; justify-content:space-between; gap:10px; align-items:center; color:#fff; font-size:12px; }
            .s2f-logtop span { color: var(--s2f-text-dim); font-size: 10px; }
            .s2f-logtarget { margin-top: 4px; color: var(--s2f-accent); font-size: 11px; font-weight: 700; }
            .s2f-logdetail { margin-top: 3px; color: var(--s2f-text-dim); font-size: 11px; line-height: 1.35; }
            /* ---- TOGGLE ---- */
            .s2f-toggle-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; font-size: 12px; }
            .s2f-toggle { width: 42px; height: 24px; position: relative; display: inline-block; flex-shrink: 0; }
            .s2f-toggle input { opacity:0; width:0; height:0; }
            .s2f-slider { position: absolute; cursor: pointer; top:0; left:0; right:0; bottom:0; background: rgba(0,200,255,0.12); border: 1px solid var(--s2f-border); border-radius: 24px; transition: .25s; }
            .s2f-slider:before { content:""; position:absolute; height:18px; width:18px; left:2px; bottom:2px; background: var(--s2f-text-dim); border-radius: 50%; transition: .25s; }
            .s2f-toggle input:checked + .s2f-slider { background: rgba(0,200,255,0.25); border-color: rgba(0,200,255,0.5); }
            .s2f-toggle input:checked + .s2f-slider:before { transform: translateX(18px); background: var(--s2f-accent); }
            /* ---- NOTICE ---- */
            .s2f-notice { padding: 8px 12px; border-radius: 7px; background: rgba(0,200,255,0.07); border-left: 3px solid var(--s2f-accent); font-size: 11px; color: var(--s2f-text-dim); margin-bottom: 10px; }
            .s2f-notice.warn { border-color: var(--s2f-gold); background: rgba(255,170,0,0.06); }
            .s2f-notice.danger { border-color: var(--s2f-red); background: rgba(255,60,60,0.06); }
            /* ---- ALIEN COUNTER ---- */
            .s2f-alien-counter { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
            .s2f-alien-counter button { flex-shrink: 0; width: 36px; height: 36px; border-radius: 8px; padding: 0; font-size: 18px; display: flex; align-items: center; justify-content: center; }
            .s2f-alien-count-display { flex: 1; text-align: center; font-size: 26px; font-weight: 900; color: var(--s2f-green); background: rgba(0,0,0,0.3); border-radius: 8px; padding: 4px 0; border: 1px solid var(--s2f-border); }
        `;
        document.head.appendChild(style);
    };

    const TABS = [
        { id: 'players',     label: 'Players' },
        { id: 'moderation',  label: 'Moderation' },
        { id: 'match',       label: 'Match Control' },
        { id: 'training',    label: 'Training' },
        { id: 'leaderboard', label: 'Leaderboard' },
        { id: 'logs',        label: 'Admin Log' },
        { id: 'settings',    label: 'Settings' },
    ];

    const initPanel = (code) => {
        if (document.getElementById('S2F_ADMIN_PANEL')) return;

        let tabsHTML = TABS.map((t, i) => `<div class="s2f-tab${i===0?' active':''}" data-tab="${t.id}">${t.label}</div>`).join('');

        let panelsHTML = `
        <!-- PLAYERS TAB -->
        <div class="s2f-tabpanel active" id="tab-players">
            <div class="s2f-grid">
                <div class="s2f-card">
                    <h3>Target Player</h3>
                    <div class="s2f-row">
                        <div>
                            <label class="s2f-label">Select Player</label>
                            <select id="S2F_playerID">
                                <option value="" disabled selected>- Select a player -</option>
                            </select>
                        </div>
                        <button class="btn-neutral btn-sm" style="flex:0 0 auto;" onclick="updatePlayerDropdown()">Refresh</button>
                    </div>
                </div>
                <div class="s2f-card danger">
                    <h3>Kick / Ban</h3>
                    <div class="s2f-btngroup" style="margin-bottom:8px">
                        <button class="btn-warn" onclick="kick(document.getElementById('S2F_playerID').value)">Kick</button>
                        <button class="btn-danger" onclick="ban(document.getElementById('S2F_playerID').value)">Ban</button>
                    </div>
                    <div class="s2f-divider"></div>
                    <label class="s2f-label">Banned Players</label>
                    <div class="s2f-row">
                        <select id="S2F_bannedPlayerID"><option value="" disabled selected>- Select banned player -</option></select>
                        <button class="btn-success btn-sm" style="flex:0 0 auto;" onclick="unban(document.getElementById('S2F_bannedPlayerID').value)">Unban</button>
                    </div>
                    <button class="btn-neutral btn-sm btn-full" onclick="kickAllBannedPlayers()">Kick All Banned Now</button>
                </div>
                <div class="s2f-card">
                    <h3>Private Message</h3>
                    <label class="s2f-label">Message</label>
                    <textarea id="S2F_privateMessageText" placeholder="Type private message..." style="margin-bottom:8px"></textarea>
                    <div class="s2f-row">
                        <div>
                            <label class="s2f-label">Duration (sec)</label>
                            <input id="S2F_privateMessageDuration" type="number" min="1" max="30" value="6">
                        </div>
                        <button class="btn-primary" onclick="privateMessage(document.getElementById('S2F_playerID').value, document.getElementById('S2F_privateMessageText').value, document.getElementById('S2F_privateMessageDuration').value)">Send PM</button>
                    </div>
                </div>
                <div class="s2f-card">
                    <h3>Announce to All</h3>
                    <label class="s2f-label">Message</label>
                    <textarea id="S2F_announcementText" placeholder="Announcement for everyone..." style="margin-bottom:8px"></textarea>
                    <div class="s2f-row">
                        <div>
                            <label class="s2f-label">Duration (sec)</label>
                            <input id="S2F_announcementDuration" type="number" min="1" max="30" value="6">
                        </div>
                        <button class="btn-primary" onclick="announceAll(document.getElementById('S2F_announcementText').value, document.getElementById('S2F_announcementDuration').value)">Announce</button>
                    </div>
                </div>
                <div class="s2f-card">
                    <h3>Admin Roles</h3>
                    <div class="s2f-btngroup">
                        <button class="btn-warn" onclick="giveAdmin(Number(document.getElementById('S2F_playerID').value))">Give Admin</button>
                        <button class="btn-danger" onclick="removeAdmin(Number(document.getElementById('S2F_playerID').value))">Remove Admin</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- MODERATION TAB -->
        <div class="s2f-tabpanel" id="tab-moderation">
            <div class="s2f-grid">
                <div class="s2f-card">
                    <h3>Spectate Lock</h3>
                    <p>Force a player into spectator mode so they cannot duel.</p>
                    <div class="s2f-btngroup" style="margin-bottom:8px">
                        <button class="btn-ice" onclick="forceSpectate(document.getElementById('S2F_playerID').value)">Force Spectate</button>
                        <button class="btn-success" onclick="releaseForcedSpectate(document.getElementById('S2F_playerID').value)">Release Player</button>
                    </div>
                    <div class="s2f-divider"></div>
                    <div class="s2f-btngroup">
                        <button class="btn-purple" onclick="forceEveryoneSpectate()">Everyone Spectate</button>
                        <button class="btn-success" onclick="releaseAllForcedSpectators()">Release All</button>
                    </div>
                </div>
                <div class="s2f-card">
                    <h3>Freeze Player</h3>
                    <p>Freeze stops movement. Players can still fire but cannot move.</p>
                    <div class="s2f-btngroup" style="margin-bottom:8px">
                        <button class="btn-ice" onclick="freezePlayer(document.getElementById('S2F_playerID').value)">Freeze</button>
                        <button class="btn-success" onclick="unfreezePlayer(document.getElementById('S2F_playerID').value)">Unfreeze</button>
                    </div>
                    <button class="btn-neutral btn-full" onclick="unfreezeAll()">Unfreeze All Players</button>
                </div>
                <div class="s2f-card gold">
                    <h3>Game Pause</h3>
                    <p>Pause freezes every player simultaneously. Resume to let everyone move again.</p>
                    <div class="s2f-btngroup">
                        <button class="btn-warn" onclick="pauseGame()">Pause Game</button>
                        <button class="btn-success" onclick="resumeGame()">Resume Game</button>
                    </div>
                </div>
                <div class="s2f-card">
                    <h3>Teleport</h3>
                    <div class="s2f-btngroup" style="margin-bottom:8px">
                        <button class="btn-primary" onclick="sendPlayerToLobby(document.getElementById('S2F_playerID').value)">Selected -> Lobby</button>
                    </div>
                    <button class="btn-neutral btn-full" onclick="teleportEveryoneToLobby()">Everyone -> Lobby</button>
                </div>
            </div>
        </div>

        <!-- MATCH CONTROL TAB -->
        <div class="s2f-tabpanel" id="tab-match">
            <div class="s2f-grid">
                <div class="s2f-card danger">
                    <h3>Close Countdown</h3>
                    <div class="s2f-row">
                        <div>
                            <label class="s2f-label">Seconds</label>
                            <input id="S2F_closeSeconds" type="number" min="1" max="300" value="15">
                        </div>
                        <div style="flex:2">
                            <label class="s2f-label">Message</label>
                            <input id="S2F_closeText" type="text" value="Closing mod">
                        </div>
                    </div>
                    <div class="s2f-btngroup">
                        <button class="btn-danger" onclick="closeModWithCountdown(document.getElementById('S2F_closeSeconds').value, document.getElementById('S2F_closeText').value)">Start Countdown</button>
                        <button class="btn-neutral" onclick="cancelCloseModCountdown()">Cancel</button>
                    </div>
                </div>
                <div class="s2f-card green s2f-span-2">
                    <h3>Force Duel</h3>
                    <p>Select both sides and the number of automatic rounds. Players are pulled out of queue/invites and assigned to a free arena.</p>
                    <div class="s2f-row">
                        <div>
                            <label class="s2f-label">Side A</label>
                            <select id="S2F_forceLeftID"><option value="" disabled selected>- Select player A -</option></select>
                        </div>
                        <div>
                            <label class="s2f-label">Side B</label>
                            <select id="S2F_forceRightID"><option value="" disabled selected>- Select player B -</option></select>
                        </div>
                        <div>
                            <label class="s2f-label">Rounds</label>
                            <input id="S2F_forceRounds" type="number" min="1" max="25" value="1">
                        </div>
                    </div>
                    <div class="s2f-btngroup">
                        <button class="btn-success" onclick="forceDuel(document.getElementById('S2F_forceLeftID').value, document.getElementById('S2F_forceRightID').value, document.getElementById('S2F_forceRounds').value)">Start Forced Duel</button>
                        <button class="btn-neutral" onclick="updatePlayerDropdown()">Refresh Players</button>
                    </div>
                </div>
                <div class="s2f-card gold s2f-span-2">
                    <h3>End Ceremony Timer</h3>
                    <p>Set when the session ends. When time is up, all duels stop, a big top-3 winners banner is shown, then the mod stops after the podium countdown.</p>
                    <div class="s2f-row">
                        <div>
                            <label class="s2f-label">End after (minutes)</label>
                            <input id="S2F_endMinutes" type="number" min="0.1" max="240" step="0.1" value="10">
                        </div>
                        <div>
                            <label class="s2f-label">Podium before stop (sec)</label>
                            <input id="S2F_endStopDelay" type="number" min="5" max="120" value="30">
                        </div>
                        <div style="flex:2">
                            <label class="s2f-label">Banner title</label>
                            <input id="S2F_endTitle" type="text" value="FINAL RESULTS">
                        </div>
                    </div>
                    <div class="s2f-btngroup" style="margin-bottom:10px">
                        <button class="btn-warn" onclick="startEndCeremonyTimer(document.getElementById('S2F_endMinutes').value, document.getElementById('S2F_endStopDelay').value, document.getElementById('S2F_endTitle').value)">Start End Timer</button>
                        <button class="btn-success" onclick="showEndCeremonyNow(document.getElementById('S2F_endStopDelay').value, document.getElementById('S2F_endTitle').value)">Show Podium Now</button>
                        <button class="btn-neutral" onclick="cancelEndCeremonyTimer()">Cancel</button>
                    </div>
                    <div class="s2f-notice warn" id="s2f-end-status">No end ceremony timer active.</div>
                </div>
                <div class="s2f-card danger">
                    <h3>Stop Mod</h3>
                    <p>Immediately stops the mod. All players will be disconnected.</p>
                    <button class="btn-danger btn-full" onclick="if(confirm('Stop the mod now?')) game.modding.commands.stop()">Stop Mod NOW</button>
                </div>
                <div class="s2f-card">
                    <h3>Stats & History</h3>
                    <div class="s2f-btngroup" style="margin-bottom:8px">
                        <button class="btn-neutral" onclick="clearPlayerHistory(document.getElementById('S2F_playerID').value)">Clear Selected</button>
                        <button class="btn-neutral" onclick="clearGlobalHistory()">Clear Global</button>
                    </div>
                    <div class="s2f-btngroup">
                        <button class="btn-danger" onclick="if(confirm('Reset ALL stats?')) resetAllLeaderboardStats()">Reset All Stats</button>
                        <button class="btn-success" onclick="exportLeaderboardTxt()">Export TXT</button>
                    </div>
                </div>
                <div class="s2f-card">
                    <h3>Quick Actions</h3>
                    <div class="s2f-btngroup" style="margin-bottom:8px">
                        <button class="btn-primary" onclick="refreshAdminPanel()">Refresh Panel</button>
                        <button class="btn-neutral" onclick="updatePlayerDropdown()">Refresh Players</button>
                    </div>
                </div>
                <div class="s2f-card green">
                    <h3>Rematch Flow</h3>
                    <p>After a duel, both players can press P to rematch. If an arena is free, they start immediately; otherwise they are queued together.</p>
                    <div class="s2f-row">
                        <div>
                            <label class="s2f-label">Vote window (sec)</label>
                            <input id="S2F_rematchSeconds" type="number" min="5" max="90" value="18">
                        </div>
                        <button class="btn-success" onclick="saveRematchSettings()">Apply</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- TRAINING TAB -->
        <div class="s2f-tabpanel" id="tab-training">
            <div class="s2f-grid">
                <div class="s2f-card green" style="grid-column: 1/-1">
                    <h3>Training Arena Aliens</h3>
                    <p>Controls aliens per training player. Example: 1 player = 4 aliens, 2 players = 8, 3 players = 12. The total cap protects ping and FPS.</p>
                    <div class="s2f-alien-counter">
                        <button class="btn-danger" onclick="setTrainingAliens(adminRuntime.trainingAlienCount-2)">-2</button>
                        <button class="btn-neutral" onclick="setTrainingAliens(adminRuntime.trainingAlienCount-1)">-1</button>
                        <div class="s2f-alien-count-display" id="s2f-alien-live">4</div>
                        <button class="btn-success" onclick="setTrainingAliens(adminRuntime.trainingAlienCount+1)">+1</button>
                        <button class="btn-success" onclick="setTrainingAliens(adminRuntime.trainingAlienCount+2)">+2</button>
                    </div>
                    <div class="s2f-row">
                        <div>
                            <label class="s2f-label">Aliens per player</label>
                            <input id="S2F_trainingAliens" type="number" min="1" max="50" value="4">
                        </div>
                        <button class="btn-success" onclick="setTrainingAliens(document.getElementById('S2F_trainingAliens').value)">Apply</button>
                    </div>
                    <div class="s2f-row">
                        <div>
                            <label class="s2f-label">Total safety cap</label>
                            <input id="S2F_trainingAlienCap" type="number" min="4" max="200" value="80">
                        </div>
                        <button class="btn-primary" onclick="setTrainingAlienCap(document.getElementById('S2F_trainingAlienCap').value)">Apply Cap</button>
                        <button class="btn-danger" onclick="clearTrainingAliens()">Clear Aliens</button>
                    </div>
                    <div class="s2f-notice">
                        Arena ${TRAINING_ARENA_INDEX} is the Training Zone. Players press [Z] to enter. Aliens spawn gradually and extra aliens are trimmed to avoid lag.
                    </div>
                </div>
            </div>
        </div>

        <!-- LEADERBOARD TAB -->
        <div class="s2f-tabpanel" id="tab-leaderboard">
            <div class="s2f-grid">
                <div class="s2f-card s2f-span-3">
                    <h3>Live Leaderboard</h3>
                    <div id="s2f-leaderboard-view" class="s2f-panelbox"></div>
                </div>
                <div class="s2f-card s2f-span-3">
                    <div style="display:flex;gap:8px;margin-bottom:10px">
                        <h3 style="margin:0;flex:1">Global Match History</h3>
                        <button class="btn-neutral btn-sm" onclick="renderPanelHistory()">Refresh</button>
                        <button class="btn-danger btn-sm" onclick="clearGlobalHistory()">Clear</button>
                    </div>
                    <div id="s2f-history-view" class="s2f-panelbox"></div>
                </div>
            </div>
        </div>

        <!-- ADMIN LOG TAB -->
        <div class="s2f-tabpanel" id="tab-logs">
            <div class="s2f-grid">
                <div class="s2f-card s2f-span-3">
                    <div style="display:flex;gap:8px;margin-bottom:10px;align-items:center">
                        <h3 style="margin:0;flex:1">Admin Action Log</h3>
                        <button class="btn-neutral btn-sm" onclick="renderAdminLog()">Refresh</button>
                        <button class="btn-success btn-sm" onclick="exportAdminLogTxt()">Export TXT</button>
                        <button class="btn-danger btn-sm" onclick="if(confirm('Clear admin log?')) clearAdminLog()">Clear</button>
                    </div>
                    <div id="s2f-admin-log-view" class="s2f-panelbox" style="max-height:460px"></div>
                </div>
            </div>
        </div>

        <!-- SETTINGS TAB -->
        <div class="s2f-tabpanel" id="tab-settings">
            <div class="s2f-grid">
                <div class="s2f-card">
                    <h3>Server Settings</h3>
                    <div class="s2f-toggle-row">
                        <label class="s2f-toggle">
                            <input type="checkbox" id="s2f-publishToggle">
                            <span class="s2f-slider"></span>
                        </label>
                        <span>Publish to Server List</span>
                    </div>
                    <button class="btn-primary btn-sm" id="s2f-saveSettings">Save Settings</button>
                </div>
                <div class="s2f-card">
                    <h3>About</h3>
                    <p>S2F Dueling Mod v1.7<br>Features: polished final podium, cleaner invite panel, duel-only scoreboard, admin log, rematch voting, improved history UI, per-player training aliens, performance cap, freeze/pause, and full panel controls.<br>Grid: 5x3 with lobby center and training corner.</p>
                </div>
            </div>
        </div>
        `;

        code.insertAdjacentHTML('beforeend', `
            <div id="S2F_ADMIN_PANEL">
                <div id="s2f-header">
                    <div>
                        <div class="s2f-logo">S2F Admin</div>
                        <div class="s2f-version">S2F Dueling v1.7 - Control Center</div>
                    </div>
                    <div id="s2f-statbar">
                        <div class="s2f-statbadge"><span>Online</span><strong id="s2f-stat-online">0</strong></div>
                        <div class="s2f-statbadge"><span>Banned</span><strong id="s2f-stat-banned">0</strong></div>
                        <div class="s2f-statbadge"><span>Spec</span><strong id="s2f-stat-forced">0</strong></div>
                        <div class="s2f-statbadge"><span>Frozen</span><strong id="s2f-stat-frozen">0</strong></div>
                        <div class="s2f-statbadge"><span>Matches</span><strong id="s2f-stat-matches">0</strong></div>
                        <div class="s2f-statbadge"><span>Paused</span><strong id="s2f-stat-paused">NO</strong></div>
                        <div class="s2f-statbadge"><span>Aliens/P</span><strong id="s2f-stat-aliens">4/P</strong></div>
                        <div class="s2f-statbadge"><span>Logs</span><strong id="s2f-stat-logs">0</strong></div>
                    </div>
                </div>
                <div id="s2f-tabs">${tabsHTML}</div>
                <div id="s2f-content">${panelsHTML}</div>
            </div>
        `);

        // Tab switching
        document.querySelectorAll('.s2f-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.s2f-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.s2f-tabpanel').forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
                if (tab.dataset.tab === 'leaderboard') {
                    renderPanelLeaderboard();
                    renderPanelHistory();
                }
                if (tab.dataset.tab === 'logs') {
                    renderAdminLog();
                }
                if (tab.dataset.tab === 'match') {
                    renderEndCeremonyStatus();
                }
            });
        });

        // Settings save
        document.getElementById('s2f-saveSettings').addEventListener('click', () => {
            adminSettings.PUBLISH_TO_SERVERLIST = document.getElementById('s2f-publishToggle').checked;
            saveAdminSettings();
            statusMessage("success", "Settings saved");
        });

        // Load stored settings
        try {
            const stored = localStorage.getItem('s2fAdminPanelSettings');
            if (stored) {
                const parsed = JSON.parse(stored);
                adminSettings = { ...adminSettings, ...parsed };
                document.getElementById('s2f-publishToggle').checked = !!adminSettings.PUBLISH_TO_SERVERLIST;
            }
        } catch(e) {}

        // Set alien display
        document.getElementById('s2f-alien-live').textContent = adminRuntime.trainingAlienCount;
        const alienInput = document.getElementById('S2F_trainingAliens');
        const alienCapInput = document.getElementById('S2F_trainingAlienCap');
        if (alienInput) alienInput.value = String(adminRuntime.trainingAlienCount);
        if (alienCapInput) alienCapInput.value = String(adminRuntime.trainingAlienCap);
        const rematchSeconds = document.getElementById('S2F_rematchSeconds');
        if (rematchSeconds) rematchSeconds.value = String(adminRuntime.rematchOfferSeconds);

        updatePlayerDropdown();
        updateBannedDropdown();
        updatePanelStats();
        renderPanelLeaderboard();
        renderPanelHistory();
        renderAdminLog();
        renderEndCeremonyStatus();
    };

    const runPanel = () => {
        const code = document.querySelector(".insideeditorpanel");
        const canvas = document.getElementById('fieldview');
        if (!code || !canvas) return;
        injectStyles();
        initPanel(code);
        updatePanelStats();
        const panel = document.getElementById('S2F_ADMIN_PANEL');
        if (panel) panel.style.display = (canvas.offsetWidth === 0 || canvas.offsetHeight === 0) ? "none" : "flex";
    };

    setInterval(runPanel, 1000);
    window.addEventListener('resize', () => setTimeout(runPanel, 100));
})();

// ============================================================
//  WEB DASHBOARD BRIDGE
// ============================================================

webAdminGetState = () => {
    let players = (game.ships || []).map(ship => {
        let custom = ship.custom || {};
        let arena = custom.arena || {};
        return {
            id: ship.id,
            name: ship.name || ("Player " + ship.id),
            joined: !!custom.joined,
            exited: !!custom.exited,
            admin: isAdminPlayer(ship),
            adminShip: !!custom.adminShipActive,
            forcedSpectator: isForcedSpectator(ship),
            frozen: isFrozenPlayer(ship),
            spectate: !!custom.spectate,
            ready: !!custom.ready,
            inMatch: !!(custom.inMatch && custom.inMatch()),
            arena: arena.lobby ? "Lobby" : (arena.index != null ? "Arena " + arena.index : "-"),
            wins: getStat(ship, "wins"),
            losses: getStat(ship, "losses"),
            draws: getStat(ship, "draws"),
            streak: getStat(ship, "streak"),
            best: getStat(ship, "maxStreak"),
            rank: custom.rank || 0
        };
    });

    return JSON.stringify({
        players,
        banned: sessionMemory.banned || [],
        logs: sessionMemory.adminLog || [],
        history: sessionMemory.globalMatchHistory || [],
        leaderboard: getLeaderboardRows(),
        stats: {
            online: players.length,
            banned: (sessionMemory.banned || []).length,
            forced: (sessionMemory.forcedSpectators || []).length,
            frozen: (sessionMemory.frozenPlayers || []).length,
            matches: (sessionMemory.globalMatchHistory || []).length,
            logs: (sessionMemory.adminLog || []).length,
            paused: isGameplayPaused(),
            trainingAliens: adminRuntime.trainingAlienCount,
            trainingCap: adminRuntime.trainingAlienCap,
            rematchSeconds: adminRuntime.rematchOfferSeconds
        }
    });
};

webAdminToggleAdminShip = (id) => {
    let ship = shipByID(Number(id));
    if (!ship) return statusMessage("error", "No ship with that ID");
    if (!sessionMemory.admins.includes(ship.id)) giveAdmin(ship.id);
    toggleAdminShip(ship);
};

webAdminSetPause = (paused) => {
    adminRuntime.gamePaused = !!paused;
    if (adminRuntime.gamePaused) {
        for (let ship of game.ships) {
            if (!ship?.custom?.joined) continue;
            ship.set({ vx: 0, vy: 0 });
            ship.emptyWeapons();
        }
    }
    statusMessage("info", adminRuntime.gamePaused ? "Gameplay paused from web panel" : "Gameplay resumed from web panel");
};

webAdminSetRematchSeconds = (seconds) => {
    seconds = Math.round(Number(seconds) || adminRuntime.rematchOfferSeconds);
    adminRuntime.rematchOfferSeconds = Math.max(5, Math.min(90, seconds));
    statusMessage("success", `Rematch window set to ${adminRuntime.rematchOfferSeconds}s`);
};

// ============================================================
//  S2F DUELING MOD CORE
// ============================================================

let gem_ratio = 1;
let fixed_gems = false;
let arena_radius = 15;
let min_radius_ratio = false;
let fixed_min_radius = 5;
let allow_full_cargo_pickup = true;
let max_item_per_ship_selection_screen = 5;
let shrink_start_time = 1.5;
let max_players = 30;
let shrink_end_time = 0.5;
let shrink_interval = 10;
let edge_dps = 50;
let dps_increase = 25;
let duel_countdown = 3;
let duel_duration = 5;
let game_duration = 9999999;
let nodes_count_per_width = 5;   // 5x3 grid
let nodes_count_per_height = 3;  // explicitly 3 rows
let TpDelay = 2;
let queueWaitingTime = 3;
let InvitationTimeOut = 10;
let pendingTpDelay = 5;
let messageHoist = 8;
let max_warns_per_chunk = 5;
let instructor_duration = 2.5;
let buttonsDelay = 0.1;
let welcome_message_duration = 3;
let fight_message_duration = 3;

let invite_columns = 2;
let invite_rows = 8;

// Grid: 5 columns x 3 rows = 15 cells
// Lobby = center = index 7 (row1, col2 in 0-based = 1*5+2 = 7)
// Training = bottom-right-ish = index 12 (row2, col2 = 2*5+2=12)
let TRAINING_ARENA_INDEX = 12;

let InviteScreen = {
    offsetX: 18,
    offsetY: 14,
    width: 64,
    height: 80,
    margin: { left: 2, right: 2, top: 13, bottom: 13 }
};

InviteScreen.position = [InviteScreen.offsetX, InviteScreen.offsetY, InviteScreen.width, InviteScreen.height];
InviteScreen.actualWidthPercentage = 100 - InviteScreen.margin.left - InviteScreen.margin.right;
InviteScreen.actualHeightPercentage = 100 - InviteScreen.margin.top - InviteScreen.margin.bottom;

let introductory_paragraph = [];

let A_Speedster_601 = '{"name":"A-Speedster","designer":"Neuronality","level":6,"model":1,"size":1.5,"specs":{"shield":{"capacity":[200,300],"reload":[6,8]},"generator":{"capacity":[80,140],"reload":[30,45]},"ship":{"mass":175,"speed":[90,115],"rotation":[60,80],"acceleration":[90,140]}},"bodies":{"main":{"section_segments":8,"offset":{"x":0,"y":0,"z":0},"position":{"x":[0,0,0,0,0,0],"y":[-100,-95,0,0,70,65],"z":[0,0,0,0,0,0]},"width":[0,10,40,20,20,0],"height":[0,5,30,30,15,0],"texture":[6,11,5,63,12],"propeller":true,"laser":{"damage":[38,84],"rate":1,"type":2,"speed":[175,230],"recoil":50,"number":1,"error":0}},"cockpit":{"section_segments":8,"offset":{"x":0,"y":-60,"z":15},"position":{"x":[0,0,0,0,0,0,0],"y":[-20,0,20,40,50],"z":[-7,-5,0,0,0]},"width":[0,10,10,10,0],"height":[0,10,15,12,0],"texture":[9]},"side_propulsors":{"section_segments":10,"offset":{"x":50,"y":25,"z":0},"position":{"x":[0,0,0,0,0,0,0,0,0,0],"y":[-20,-15,0,10,20,25,30,40,80,70],"z":[0,0,0,0,0,0,0,0,0,0]},"width":[0,15,20,20,20,15,15,20,10,0],"height":[0,15,20,20,20,15,15,20,10,0],"propeller":true,"texture":[4,4,2,2,5,63,5,4,12]},"cannons":{"section_segments":12,"offset":{"x":30,"y":40,"z":45},"position":{"x":[0,0,0,0,0,0,0],"y":[-50,-45,-20,0,20,30,40],"z":[0,0,0,0,0,0,0]},"width":[0,5,7,10,3,5,0],"height":[0,5,7,8,3,5,0],"angle":-10,"laser":{"damage":[8,12],"rate":2,"type":1,"speed":[100,130],"number":1,"angle":-10,"error":0},"propeller":false,"texture":[6,4,10,4,63,4]}},"wings":{"join":{"offset":{"x":0,"y":0,"z":10},"length":[40,0],"width":[10,20],"angle":[-1],"position":[0,30],"texture":[63],"bump":{"position":0,"size":25}},"winglets":{"offset":{"x":0,"y":-40,"z":10},"doubleside":true,"length":[45,10],"width":[5,20,30],"angle":[50,-10],"position":[90,80,50],"texture":[4],"bump":{"position":10,"size":30}}},"typespec":{"name":"A-Speedster","level":6,"model":1,"code":601,"specs":{"shield":{"capacity":[200,300],"reload":[6,8]},"generator":{"capacity":[80,140],"reload":[30,45]},"ship":{"mass":175,"speed":[90,115],"rotation":[60,80],"acceleration":[90,140]}},"shape":[3,2.914,2.408,1.952,1.675,1.49,1.349,1.263,1.198,1.163,1.146,1.254,1.286,1.689,2.06,2.227,2.362,2.472,2.832,3.082,3.436,3.621,3.481,2.48,2.138,2.104,2.138,2.48,3.481,3.621,3.436,3.082,2.832,2.472,2.362,2.227,2.06,1.689,1.286,1.254,1.146,1.163,1.198,1.263,1.349,1.49,1.675,1.952,2.408,2.914],"lasers":[{"x":0,"y":-3,"z":0,"angle":0,"damage":[38,84],"rate":1,"type":2,"speed":[175,230],"number":1,"spread":0,"error":0,"recoil":50},{"x":1.16,"y":-0.277,"z":1.35,"angle":-10,"damage":[8,12],"rate":2,"type":1,"speed":[100,130],"number":1,"spread":-10,"error":0,"recoil":0},{"x":-1.16,"y":-0.277,"z":1.35,"angle":10,"damage":[8,12],"rate":2,"type":1,"speed":[100,130],"number":1,"spread":-10,"error":0,"recoil":0}],"radius":3.621}}';

let Spectator_101 = '{"name":"Spectator","level":1,"model":1,"size":0.025,"zoom":0.075,"specs":{"shield":{"capacity":[1e-30,1e-30],"reload":[1000,1000]},"generator":{"capacity":[1e-30,1e-30],"reload":[1,1]},"ship":{"mass":1,"speed":[200,200],"rotation":[1000,1000],"acceleration":[1000,1000]}},"bodies":{"face":{"section_segments":100,"angle":0,"offset":{"x":0,"y":0,"z":0},"position":{"x":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],"y":[-2,-2,2,2],"z":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]},"width":[0,1,1,0],"height":[0,1,1,0],"vertical":true,"texture":[6]}},"typespec":{"name":"Spectator","level":1,"model":1,"code":101,"specs":{"shield":{"capacity":[1e-30,1e-30],"reload":[1000,1000]},"generator":{"capacity":[1e-30,1e-30],"reload":[1,1]},"ship":{"mass":1,"speed":[200,200],"rotation":[1000,1000],"acceleration":[1000,1000]}},"shape":[0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001,0.001],"lasers":[],"radius":0.001}}';
let AdminToolPrecision_192 = '{"name":"AdminToolPrecision","level":1.9,"model":2,"size":1,"zoom":0.5,"specs":{"shield":{"capacity":[1e+300,1e+300],"reload":[1e+300,1e+300]},"generator":{"capacity":[1e+300,1e+300],"reload":[1e+300,1e+300]},"ship":{"mass":1e+300,"speed":[450,450],"rotation":[1000,1000],"acceleration":[350,350]}},"bodies":{"object0":{"section_segments":[45,135,225,315],"offset":{"x":0,"y":0,"z":0},"position":{"x":[0,0,0,0],"y":[-40,-40,0,0],"z":[0,0,0,0]},"width":[0,5,5,0],"height":[0,5,5,0],"texture":[17,4],"angle":0,"laser":{"damage":[1055,1055],"rate":-1,"speed":[400,400],"number":1,"angle":0}}},"typespec":{"name":"AdminToolPrecision","level":1.9,"model":2,"code":192,"specs":{"shield":{"capacity":[1e+300,1e+300],"reload":[1e+300,1e+300]},"generator":{"capacity":[1e+300,1e+300],"reload":[1e+300,1e+300]},"ship":{"mass":1e+300,"speed":[450,450],"rotation":[1000,1000],"acceleration":[350,350]}},"shape":[0.802,0.803,0.375,0.227,0.16,0.126,0.107,0.095,0.085,0.078,0.075,0.072,0.071,0.071,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0.071,0.072,0.075,0.078,0.085,0.095,0.107,0.126,0.16,0.227,0.375,0.803],"lasers":[{"x":0,"y":-0.8,"z":0,"angle":0,"damage":[1055,1055],"rate":-1,"speed":[400,400],"number":1,"spread":0,"error":0,"recoil":0}],"radius":0.803}}';
const ADMIN_SHIP_CODE = 192;

let modShip = function(ship, handler) {
    typeof handler == "function" && [[], ["typespec"]].forEach(i => {
        let param = ship;
        i.forEach(j => (param = param[j]));
        handler(param);
    });
};

let ships = [];
ships.push(A_Speedster_601);

let ships_count = ships.length;
let zeroes = [1e-30, 1e-30];

if (!game.custom.ship_infos) {
    let ship_infos = ships.map(i => {
        let t = JSON.parse(i), clone = JSON.parse(i);
        modShip(clone, function(ship) {
            ship.specs.generator = { capacity: zeroes, reload: zeroes };
            Object.assign(ship.specs.ship, { speed: zeroes, rotation: zeroes, acceleration: zeroes });
            ship.model += ships_count;
            delete ship.specs.ship.dash;
        });
        clone.typespec.code = clone.level * 100 + clone.model;
        ["bodies", "wings"].map(i => Object.values(clone[i] || {})).flat().filter(i => i).forEach(body => { delete body.laser; });
        clone.typespec.lasers = [];
        ships.push(JSON.stringify(clone));
        return { name: t.name, designer: t.designer || "", code: t.level * 100 + t.model };
    });
    let codes = ship_infos.map(info => info.code);
    let maxNamelength = Math.max(...ship_infos.map(info => info.name.length));
    let maxDesignerlength = Math.max(...ship_infos.map(info => info.designer.length));
    let max_ship_items = Math.max(1, max_item_per_ship_selection_screen) || 1;
    let temp = [];
    while (ship_infos.length > 0) temp.push(ship_infos.splice(0, max_ship_items));
    ship_infos = temp;
    Object.assign(game.custom, { ship_infos, codes, maxNamelength, maxDesignerlength, max_ship_items });
}

let { ship_infos, codes, maxNamelength, maxDesignerlength, max_ship_items } = game.custom;
let ship_infos_flattened = ship_infos.flat();

let getShipsPage = function(ship) {
    let custom = ship?.custom || {};
    let ship_info = ship_infos[custom.ships_page];
    if (Array.isArray(ship_info)) return { index: +custom.ships_page, list: ship_info };
    custom.ships_page = 0;
    return { index: 0, list: ship_infos[0] };
};

ships.push(Spectator_101);
ships.push(AdminToolPrecision_192);

let map_size = 200;
let rand = function(num) { return Math.floor(Math.random() * num); };
let soundtracks = ["argon", "crystals"];
// 5 wide x 3 tall
let nW = 5;
let nH = 3;
let n = nW; // keep n for compatibility (used in some UI calculations)
let vocabulary = [
    { text: "Duel", icon: "\u00be", key: "D" }, { text: "Me", icon: "\u004f", key: "E" },
    { text: "Cheater", icon: "\u{1f92c}", key: "F" }, { text: "GoodGame", icon: "\u00a3", key: "G" },
    { text: "Hello", icon: "\u0046", key: "H" }, { text: "Lag", icon: "\u{231B}", key: "I" },
    { text: "Leader", icon: "\u002e", key: "L" }, { text: "No", icon: "\u004d", key: "N" },
    { text: "You", icon: "\u004e", key: "O" }, { text: "How?!", icon: "\u004b", key: "Q" },
    { text: "Sorry", icon: "\u00a1", key: "S" }, { text: "Wait", icon: "\u0048", key: "T" },
    { text: "Lose", icon: "\u{1F948}", key: "U" }, { text: "Thanks", icon: "\u0041", key: "X" },
    { text: "Yes", icon: "\u004c", key: "Y" }, { text: "Win", icon: "\u{1F947}", key: "W" }
];

while (codes.length > 5) codes.splice(rand(codes.length), 1);

this.options = {
    map_size: map_size, custom_map: "", starting_ship: 801, ships: ships, reset_tree: true,
    max_players: (nW * nH - 1) * 4,
    radar_zoom: map_size / arena_radius / 2,
    weapons_store: false, max_level: 1, speed_mod: 1.2, choose_ship: codes,
    asteroids_strength: 1e6, crystal_value: 0, vocabulary: vocabulary,
    soundtrack: soundtracks[rand(soundtracks.length)] + ".mp3",
    mines_self_destroy: true, mines_destroy_delay: 0, projectile_speed: Number.MAX_VALUE
};

let modUtils = {
    setTimeout: function(f, time) { this.jobs.push({ f: f, time: game.step + time }); },
    jobs: [],
    tick: function() {
        let t = game.step;
        for (let i = this.jobs.length - 1; i >= 0; i--) {
            let job = this.jobs[i];
            if (t >= job.time) {
                try { job.f(); } catch (err) {}
                this.jobs.splice(i, 1);
            }
        }
    }
};

let spectator = 101;

const C = {
    bg_deep:    "hsla(196, 78%, 18%, 0.44)",
    bg_card:    "hsla(214, 38%, 10%, 0.96)",
    bg_row_a:   "hsla(208, 34%, 13%, 0.92)",
    bg_row_b:   "hsla(212, 34%, 10%, 0.92)",
    bg_header:  "hsla(203, 46%, 16%, 1)",
    accent:     "hsla(188, 100%, 56%, 1)",
    accent_dim: "hsla(188, 72%, 42%, 0.55)",
    accent_glow:"hsla(188, 100%, 72%, 1)",
    gold:       "hsla(38, 100%, 62%, 1)",
    gold_dim:   "hsla(38,  80%,  42%, 0.6)",
    green:      "hsla(145, 88%, 58%, 1)",
    green_dim:  "hsla(145, 56%,  35%, 0.55)",
    red:        "hsla(0,   92%,  64%, 1)",
    red_dim:    "hsla(0,   60%,  35%, 0.55)",
    orange:     "hsla(25,  100%, 62%, 1)",
    silver:     "hsla(205, 18%,  76%, 1)",
    text_hi:    "hsla(210, 100%, 98%, 1)",
    text_mid:   "hsla(196, 58%,  76%, 1)",
    text_lo:    "hsla(205, 20%,  58%, 1)",
    border:     "hsla(188, 100%, 55%, 0.24)",
    border_hi:  "hsla(188, 100%, 68%, 0.86)",
    stroke_w:   5,
    r:          12
};

let button_opacity = 0.28;
let black = "hsla(0, 0%, 0%, 1)";

let Radar = {
    UI: { id: "radar_background", components: [] },
    update: function(game, needsUpdate) {
        this.UI.components = [];
        ArenaManager.list.forEach(p => {
            let rsize = 10 / map_size * p.radius;
            let x = (function(x, p) { let o = x + map_size * 5, zoom = 10 / map_size; return Math.max(o * zoom - p, 0) || 0; })(p.x, rsize);
            let y = (function(x, p) { let o = -x + map_size * 5, zoom = 10 / map_size; return Math.max(o * zoom - p, 0) || 0; })(p.y, rsize);
            let size = rsize * 2;
            let isTraining = p.originalIndex === TRAINING_ARENA_INDEX;
            this.UI.components.push({
                type: "box",
                position: [x, y, size, size],
                width: 2,
                stroke: p.lobby ? C.gold : isTraining ? "hsla(120, 100%, 65%, 0.9)" : "hsla(210, 100%, 65%, 0.9)",
                fill: p.lobby ? "hsla(210, 100%, 55%, 0.12)" : isTraining ? "hsla(120, 100%, 55%, 0.08)" : "hsla(210, 100%, 55%, 0.08)",
                radius: size * 0.17
            });
        });
        if (needsUpdate) this.set(game);
        return needsUpdate;
    },
    set: function(ship) { return sendUI(ship, this.UI); }
};

let sendUI = function(ship, UI) {
    return ship != null && ship.setUIComponent(parseUI(UI));
};

let parseUI = function(UI) {
    try { UI = new Object(JSON.parse(JSON.stringify(UI))); } catch (e) { UI = {}; }
    let id;
    try { id = String(UI.id); } catch (e) { id = ''; }
    let parsedUI = { id: id, position: UI.position, visible: UI.visible, clickable: UI.clickable, shortcut: UI.shortcut, components: UI.components };
    if (parsedUI.visible || parsedUI.visible == null) {
        delete parsedUI.visible;
        let position = parsedUI.position, count = 0;
        for (let i = 0; i < 4; i++) { let pos = (position || {})[i]; if (pos == null || pos == 100) count++; }
        if (count == 4) delete parsedUI.position;
    } else {
        parsedUI.position = [0, 0, 0, 0];
        parsedUI.visible = false;
        delete parsedUI.components;
    }
    if (!parsedUI.clickable) { delete parsedUI.clickable; delete parsedUI.shortcut; }
    return parsedUI;
};

let toTick = min => min * 3600 + 60;
let r = arena_radius * 10;
// Build 5x3 grid positions
let d_w = 2000 / nW - 2 * r;
let d_h = 2000 / nH - 2 * r;
let pos_w = function(x) { return (r + d_w / 2) * (2 * x + 1); };
let pos_h = function(y) { return (r + d_h / 2) * (2 * y + 1); };
// grids: row-major, 5 cols x 3 rows = 15 cells
let grids = [];
for (let row = 0; row < nH; row++) {
    for (let col = 0; col < nW; col++) {
        grids.push([-map_size * 5 + pos_w(col), map_size * 5 - pos_h(row)]);
    }
}
// Lobby = center = index 7 (row=1, col=2 -> 1*5+2=7)
let lobby = 7;
let leaderboard = [];

let getStat = function(ship, stateName) { return +((ship || {}).custom || {})[stateName] || 0; };
let dist = function(x1, y1, x2, y2) { return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2); };

let setBackgroundCard = function(id, src, x, y, scalex, scaley) {
    game.setObject({
        id: id,
        type: {
            id: id,
            obj: "https://starblast.data.neuronality.com/mods/objects/plane.obj",
            emissive: src,
            diffuse: src,
            emissiveColor: 0xFFFFFF,
            shininess: 0,
            transparent: true
        },
        position: { x: x, y: y, z: 0 },
        rotation: { x: Math.PI, y: 0, z: 0 },
        scale: { x: scalex, y: scaley, z: scalex }
    });
};

let rekt = function(ship, num) {
    if (ship.shield < num) {
        let val = ship.crystals + ship.shield;
        if (val < num) ship.set({ kill: true });
        else ship.set({ crystals: val - num, shield: 0 });
    } else ship.set({ shield: ship.shield - num });
};

let max = function(ship, type) {
    if (ship != null) {
        if (ship.custom.spectate) ship.set({ type: spectator });
        else {
            if (type != null || (ship.custom.type == spectator && !ship.custom.spectator)) {
                type = type || ship.custom.prevShipCode || ship.custom.type;
                ship.custom.prevShipCode = null;
                ship.custom.type = (ship_infos_flattened.find(info => info.code === type) || ship_infos_flattened[0]).code;
                ship.set({ type: ship.custom.type });
            }
        }
        ship.set({ stats: 88888888, crystals: 0, shield: 1e5 });
    }
};

let addWarn = function(ship, message, permanent, customY, allowDuplicates) {
    let t = (Array.isArray(ship.custom.warn) ? ship.custom.warn : []).filter(Array.isArray);
    if (!allowDuplicates) {
        let ti;
        while ((ti = t.findIndex(u => u[0] == message)) != -1) t.splice(ti, 1);
    }
    let rt = [message, permanent ? -1 : game.step];
    if (typeof customY == "number" && customY >= 0 && customY <= 100) rt.push(customY);
    t.push(rt);
    ship.custom.warn = t.slice(-max_warns_per_chunk);
};

let removeWarn = function(ship, message, globalSearch) {
    let t = (Array.isArray(ship.custom.warn) ? ship.custom.warn : []).filter(Array.isArray), ti;
    while ((ti = t.findIndex(u => u[0] == message)) != -1) {
        t.splice(ti, 1);
        if (!globalSearch) break;
    }
    ship.custom.warn = t.slice(-max_warns_per_chunk);
};

let warn = function(ship) {
    let war = (Array.isArray(ship.custom.warn) ? ship.custom.warn : []).filter(Array.isArray);
    let wh = 100 / max_warns_per_chunk;
    let idx = 0;
    sendUI(ship, {
        id: "warn", position: [25, 3, 50, 97], visible: true, clickable: false,
        components: war.map(msg => ({
            type: "text",
            position: [0, (msg[2] != null) ? msg[2] : (wh * idx++), 100, wh],
            value: msg[0],
            color: C.accent_glow,
            size: 5,
            bold: true
        }))
    });
};

let setStates = function(ship, ...states) {
    let r = ["Win", "Lose", "Draw"];
    for (let i = 0; i < states.length; i++) ship.custom["just" + r[i]] = states[i];
};

let clearInds = function(ship) {
    setStates(ship, false, false, false);
    ship.custom.ready = false;
    ship.custom.wait = false;
    ship.custom.warn = [];
    ship.custom.pendingTp = -1;
    ship.custom.killFeed = [];
    ship.custom.fightMessageShown = false;
    ship.custom.duelBannerShown = false;
};

let setStats = function(ship, ...stats) {
    return;
};

let announce = function(ship, ...data) {
    sendUI(ship, {
        id: "message",
        position: [25, 15, 50, 50],
        visible: !!ship.custom.instructorHidden,
        components: data.map((j, i) => {
            let text, color;
            if (Array.isArray(j)) { text = j[0]; color = "hsla(" + j[1] + ",100%,62%,1)"; }
            else { text = j; color = C.text_hi; }
            return { type: "text", position: [0, 9 * i, 100, 9], value: text, color: color, size: 6 };
        })
    });
};

let showTimedMessage = function(ship, message, color, duration) {
    sendUI(ship, {
        id: "timed_message",
        position: [28, 38, 44, 22],
        visible: true,
        clickable: false,
        components: [
            { type: 'box', position: [0, 0, 100, 100], fill: C.bg_deep, stroke: C.border_hi, width: 5 },
            { type: 'box', position: [0, 0, 100, 18], fill: C.bg_header },
            { type: 'round', position: [-8, -8, 16, 16], fill: C.border_hi },
            { type: 'round', position: [92, -8, 16, 16], fill: C.border_hi },
            { type: 'round', position: [92, 92, 16, 16], fill: C.border_hi },
            { type: 'round', position: [-8, 92, 16, 16], fill: C.border_hi },
            { type: "text", position: [0, 28, 100, 44], value: message, color: color, align: "center", size: 9, bold: true }
        ]
    });
    modUtils.setTimeout(() => sendUI(ship, { id: "timed_message", visible: false }), duration * 60);
};

let renderCornerTimer = function(ship) {
    sendUI(ship, { id: "corner_timer", visible: false });
};

let showDuelCountdown = function(arena) {
    if (!arena || !arena.members || arena.members.length < 2) return;
    let countdownTime = Math.ceil(arena.countdown / 60);
    if (countdownTime <= 0 || countdownTime > duel_countdown) return;
    arena.members.forEach(ship => {
        if (!ship || !ship.alive) return;
        let opponents = arena.members.filter(m => m !== ship);

        if (opponents.length > 0 && !ship.custom.duelBannerShown) {
            ship.custom.duelBannerShown = true;
            let bannerTitle = "DUEL";
            let bannerBody = opponents[0].name.toUpperCase();

            let bannerComps = [
                { type: 'box', position: [0, 0, 100, 100], fill: C.bg_deep, stroke: C.border_hi, width: 5 },
                { type: 'box', position: [0, 0, 100, 42], fill: C.bg_header },
                { type: 'round', position: [-8, -8, 16, 16], fill: C.accent },
                { type: 'round', position: [92, -8, 16, 16], fill: C.accent },
                { type: 'round', position: [92, 92, 16, 16], fill: C.accent },
                { type: 'round', position: [-8, 92, 16, 16], fill: C.accent },
                { type: "text", position: [0, 5, 100, 32], value: bannerTitle, color: C.gold, align: "center", size: 5, bold: true },
                { type: "text", position: [0, 44, 100, 32], value: bannerBody, color: C.text_hi, align: "center", size: 11, bold: true }
            ];

            sendUI(ship, {
                id: "duel_opponent_banner",
                position: [24, 4, 52, 14],
                visible: true,
                clickable: false,
                components: bannerComps
            });
            modUtils.setTimeout(() => {
                sendUI(ship, { id: "duel_opponent_banner", visible: false });
                ship.custom.duelBannerShown = false;
            }, (duel_duration + 1) * 60);
        }
        sendUI(ship, {
            id: "countdown_container",
            position: [39, 28, 22, 24],
            visible: true,
            clickable: false,
            components: [
                { type: 'box', position: [0, 0, 100, 100], fill: C.bg_deep, stroke: C.accent_dim, width: 5 },
                { type: 'box', position: [0, 0, 100, 35], fill: C.bg_header },
                { type: 'round', position: [-8, -8, 16, 16], fill: C.accent },
                { type: 'round', position: [92, -8, 16, 16], fill: C.accent },
                { type: 'round', position: [92, 92, 16, 16], fill: C.accent },
                { type: 'round', position: [-8, 92, 16, 16], fill: C.accent },
                { type: "text", position: [0, 6, 100, 25], value: "DUEL STARTS", color: C.text_mid, align: "center", size: 4 },
                { type: "text", position: [0, 35, 100, 52], value: countdownTime.toString(), color: C.accent_glow, align: "center", size: 22, bold: true }
            ]
        });
    });
};

let clearDuelCountdown = function(arena) {
    if (!arena || !arena.members) return;
    arena.members.forEach(ship => {
        if (ship) {
            sendUI(ship, { id: "countdown_container", visible: false });
            if (ship.custom.duelBannerShown) ship.custom.duelBannerShown = false;
        }
    });
};

let resetShip = function(ship, resetOpponent) {
    Object.assign(ship.custom, {
        ready: false, spectate: false, shipped: false, mapped: false, pendingTp: game.step,
        lastMatchStep: game.step, arena: ArenaManager.lobby, invite_shown: false,
        fightMessageShown: false, duelBannerShown: false, inTraining: false
    });
    let pair = game.findShip(ship.custom.paired);
    if (pair) {
        if (resetOpponent) resetShip(pair, !resetOpponent);
        ship.custom.inviters.delete(pair.id);
        ship.custom.inviting.delete(pair.id);
    }
    max(ship, ship.custom.type);
    ship.custom.paired = null;
    removeWarn(ship, "Warning: Arena shrinking!", true);
    sendUI(ship, { id: "countdown_container", visible: false });
    sendUI(ship, { id: "duel_opponent_banner", visible: false });
};

const getRematchKey = (shipA, shipB) => [shipA?.id, shipB?.id].sort((a, b) => a - b).join(":");

const hasActiveRematchOffer = (ship) => {
    let offer = ship?.custom?.rematchOffer;
    if (!offer) return false;
    if (offer.expiresAt <= game.step) {
        ship.custom.rematchOffer = null;
        sendUI(ship, { id: "btn_rematch", visible: false });
        return false;
    }
    let opponent = game.findShip(offer.opponentId);
    return !!(opponent?.custom?.joined && !opponent.custom.exited);
};

const clearRematchOffer = (ship) => {
    if (!ship?.custom) return;
    ship.custom.rematchOffer = null;
    sendUI(ship, { id: "btn_rematch", visible: false });
};

const clearRematchOffersWithPlayer = (playerId, notice = "") => {
    for (let other of game.ships) {
        if (other?.custom?.rematchOffer?.opponentId === playerId) {
            clearRematchOffer(other);
            if (notice) addWarn(other, notice);
        }
    }
};

const canInviteTarget = (ship, target) => {
    if (!ship?.custom?.joined || !target?.custom?.joined || target === ship) return false;
    if (target.custom.exited || target.custom.spectate || target.custom.inTraining || isForcedSpectator(target)) return false;
    if (target.custom.paired || target.custom.inMatch?.()) return false;
    return !!target.alive;
};

const offerRematch = (shipA, shipB) => {
    if (!shipA?.custom?.joined || !shipB?.custom?.joined) return;
    let expiresAt = game.step + Math.max(5, adminRuntime.rematchOfferSeconds) * 60;
    let key = getRematchKey(shipA, shipB);
    for (let [ship, opponent] of [[shipA, shipB], [shipB, shipA]]) {
        ship.custom.rematchOffer = {
            opponentId: opponent.id,
            opponentName: opponent.name,
            pairKey: key,
            expiresAt,
            voted: false
        };
        addWarn(ship, `Rematch offered vs ${opponent.name}. Press P to vote.`, false, null, true);
        showTimedMessage(ship, "REMATCH?", C.gold, 2.5);
        sendUI(ship, {
            id: "duel_center_message",
            position: [28, 38, 44, 18],
            visible: true,
            clickable: true,
            shortcut: "P",
            components: [
                { type: 'box', position: [0, 0, 100, 100], fill: "hsla(210,58%,8%,0.92)", stroke: C.accent_glow, width: 5 },
                { type: 'box', position: [0, 0, 100, 30], fill: "hsla(197,72%,18%,0.82)" },
                { type: 'box', position: [0, 30, 100, 1.2], fill: C.accent_glow },
                { type: "text", position: [0, 5, 100, 15], value: "REMATCH", color: C.accent_glow, align: "center", size: 5.6, bold: true },
                { type: "text", position: [0, 38, 100, 18], value: "PRESS P", color: C.text_hi, align: "center", size: 7.2, bold: true },
                { type: "text", position: [5, 66, 90, 12], value: `VS ${opponent.name}`, color: C.text_mid, align: "center", size: opponent.name.length > 14 ? 3.2 : 4.2, bold: true }
            ]
        });
        modUtils.setTimeout(() => {
            if (ship.custom?.rematchOffer?.pairKey === key) sendUI(ship, { id: "duel_center_message", visible: false });
        }, Math.min(5, Math.max(2.5, adminRuntime.rematchOfferSeconds)) * 60);
    }
};

const queueRematchPair = (shipA, shipB) => {
    for (let ship of [shipA, shipB]) {
        ship.custom.ready = false;
        ship.custom.spectate = false;
        ship.custom.shipped = false;
        ship.custom.mapped = false;
        ship.custom.invite_shown = false;
        ship.custom.history_shown = false;
        ship.custom.inTraining = false;
        hideHistoryPanel(ship);
        max(ship, ship.custom.prevShipCode || ship.custom.type || ship.type);
        ArenaManager.set(ship, lobby, true);
    }
    shipA.custom.paired = shipB.id;
    shipB.custom.paired = shipA.id;
    clearRematchOffer(shipA);
    clearRematchOffer(shipB);
    let arenaSlot = ArenaManager.findAvailable();
    if (arenaSlot) arenaSlot.assign(shipA, shipB);
    else ArenaManager.invites.push([shipA, shipB]);
    addAdminLog("Rematch", `${shipA.name} vs ${shipB.name}`, arenaSlot ? `Assigned to Arena ${arenaSlot.index}` : "Queued for next open arena", "success");
    statusMessage("success", `Rematch ready: ${shipA.name} vs ${shipB.name}`);
};

const clearArenaWithoutScore = (arena) => {
    if (!arena || arena.lobby) return;
    let members = Array.isArray(arena.members) ? [...arena.members] : [];
    clearDuelCountdown(arena);
    arena.adminSeries = null;
    members.forEach(member => member && resetShip(member, false));
    arena.countdown = 0;
    arena.duration = 0;
    arena.reset();
};

const prepareForcedDuelPlayer = (ship) => {
    ship.custom.ready = false;
    ship.custom.spectate = false;
    ship.custom.shipped = false;
    ship.custom.mapped = false;
    ship.custom.invite_shown = false;
    ship.custom.history_shown = false;
    ship.custom.inTraining = false;
    ship.custom.paired = null;
    ship.custom.adminShipActive = false;
    clearRematchOffer(ship);
    clearRematchOffersWithPlayer(ship.id);
    hideHistoryPanel(ship);
    for (let other of game.ships) {
        other.custom?.inviters?.delete(ship.id);
        other.custom?.inviting?.delete(ship.id);
    }
    ship.custom.inviters?.clear?.();
    ship.custom.inviting?.clear?.();
    max(ship, ship.custom.prevShipCode || ship.custom.type || ship.type);
    ArenaManager.set(ship, lobby, true);
};

forceDuel = (leftId, rightId, rounds = 1) => {
    let left = shipByID(Number(leftId));
    let right = shipByID(Number(rightId));
    rounds = Math.max(1, Math.min(25, Math.round(Number(rounds) || 1)));
    if (!left || !right) return statusMessage("error", "Select two valid players");
    if (left === right) return statusMessage("error", "Pick two different players");
    if (!left.custom?.joined || !right.custom?.joined || left.custom.exited || right.custom.exited) return statusMessage("error", "Both players must be joined");
    if (isForcedSpectator(left) || isForcedSpectator(right)) return statusMessage("error", "Forced spectators cannot be assigned");

    let touchedArenas = new Set([left.custom.arena, right.custom.arena].filter(arena => arena && !arena.lobby));
    touchedArenas.forEach(clearArenaWithoutScore);
    ArenaManager.invites = ArenaManager.invites.filter(pair => pair.indexOf(left) === -1 && pair.indexOf(right) === -1);
    prepareForcedDuelPlayer(left);
    prepareForcedDuelPlayer(right);

    let arenaSlot = ArenaManager.findAvailable();
    if (!arenaSlot) return statusMessage("error", "No free arena available for forced duel");
    arenaSlot.assign(left, right);
    arenaSlot.adminSeries = {
        total: rounds,
        remaining: rounds,
        leftId: left.id,
        rightId: right.id,
        leftWins: 0,
        rightWins: 0,
        draws: 0
    };
    addAdminLog("Force Duel", `${left.name} vs ${right.name}`, `${rounds} round${rounds === 1 ? "" : "s"} in Arena ${arenaSlot.index}`, "warn");
    showAdminAnnouncement(left, "ADMIN MATCH", `You were matched against ${right.name}.`, 3);
    showAdminAnnouncement(right, "ADMIN MATCH", `You were matched against ${left.name}.`, 3);
    statusMessage("success", `Forced duel started: ${left.name} vs ${right.name} (${rounds} round${rounds === 1 ? "" : "s"})`);
};

voteRematch = (ship) => {
    if (!hasActiveRematchOffer(ship)) return addWarn(ship, "No active rematch offer.");
    let offer = ship.custom.rematchOffer;
    let opponent = game.findShip(offer.opponentId);
    if (!opponent?.custom?.joined) {
        clearRematchOffer(ship);
        return addWarn(ship, "Rematch cancelled: opponent left.");
    }
    if (ship.custom.inMatch() || opponent.custom.inMatch() || isForcedSpectator(ship) || isForcedSpectator(opponent)) {
        clearRematchOffer(ship);
        clearRematchOffer(opponent);
        return addWarn(ship, "Rematch unavailable right now.");
    }
    offer.voted = true;
    addWarn(ship, `Rematch vote sent to ${opponent.name}.`, false, null, true);
    if (opponent.custom.rematchOffer?.pairKey === offer.pairKey && opponent.custom.rematchOffer.voted) {
        queueRematchPair(ship, opponent);
    } else {
        addWarn(opponent, `${ship.name} wants a rematch. Press P to accept.`, false, null, true);
    }
};

let gameover = function(ship, wait) {
    if (ship != null) {
        ship.custom.exited = true;
        modUtils.setTimeout(() => {
            ship.gameover({
                "Wins": getStat(ship, "wins"),
                "Draws": getStat(ship, "draws"),
                "Losses": getStat(ship, "losses"),
                "Best Streak": getStat(ship, "maxStreak"),
                "Rank": +ship.custom.rank || "Unranked"
            });
        }, wait ? 300 : 0);
    }
};

let max_history = 10;

let addDuelHistory = function(ship, opponentName, result) {
    if (!Array.isArray(ship.custom.duelHistory)) ship.custom.duelHistory = [];
    ship.custom.duelHistory.push({
        opponent: opponentName,
        result: result,
        time: new Date().toLocaleTimeString('en-GB', { hour12: false })
    });
    if (ship.custom.duelHistory.length > max_history) {
        ship.custom.duelHistory = ship.custom.duelHistory.slice(-max_history);
    }
};

let getShipHistoryMode = function(ship) {
    return ship?.custom?.historyMode === "player" ? "player" : "global";
};

let trimHistoryText = function(value, maxLength = 28) {
    value = String(value || "");
    return value.length > maxLength ? value.slice(0, Math.max(maxLength - 3, 1)) + "..." : value;
};

let pushHistoryStatCard = function(components, x, label, value, color, width = 28) {
    let valueText = String(value);
    let valueSize = valueText.length > 6 ? 3.0 : valueText.length > 4 ? 3.6 : 4.5;
    components.push({ type: 'box', position: [x, 10.2, width, 10.5], fill: "hsla(216,42%,13%,0.96)", stroke: "hsla(200,80%,45%,0.18)", width: 1 });
    components.push({ type: 'box', position: [x, 10.2, width, 0.6], fill: color });
    components.push({ type: 'text', position: [x, 11.4, width, 3.1], value: label, color: C.text_lo, align: "center", size: 2.4, bold: true });
    components.push({ type: 'text', position: [x, 14.2, width, 5.2], value: valueText, color, align: "center", size: valueSize, bold: true });
};

let showHistoryPanel = function(ship) {
    let mode = getShipHistoryMode(ship);
    let personalHistory = Array.isArray(ship.custom.duelHistory) ? ship.custom.duelHistory.slice().reverse() : [];
    let globalHistory = sessionMemory.globalMatchHistory.slice().reverse();
    let history = mode === "player" ? personalHistory : globalHistory;
    let personalWins = personalHistory.filter(entry => entry.result === "Win").length;
    let personalLosses = personalHistory.filter(entry => entry.result === "Loss").length;
    let personalDraws = personalHistory.filter(entry => entry.result === "Draw").length;
    let globalSummary = getPlayerGlobalSummary(ship);
    let rowH = 8.7;
    let headerH = 29;
    let colH = 5.8;
    let title = mode === "player" ? "MY MATCH HISTORY" : "GLOBAL MATCH FEED";
    let subtitle = mode === "player"
        ? `W ${personalWins} / L ${personalLosses} / D ${personalDraws}`
        : `${globalHistory.length} matches tracked`;
    let winRate = personalHistory.length ? Math.round((personalWins / personalHistory.length) * 100) + "%" : "0%";
    let recentForm = personalHistory.slice(0, 5).map(entry => entry.result === "Win" ? "W" : entry.result === "Loss" ? "L" : "D").join(" ");

    let components = [
        { type: 'box', position: [0, 0, 100, 100], fill: "hsla(220,50%,7%,0.98)", stroke: C.border_hi, width: 4 },
        { type: 'box', position: [0, 0, 100, headerH], fill: "hsla(220,55%,13%,1)" },
        { type: 'box', position: [0, 0, 100, 0.8], fill: C.accent },
        { type: 'box', position: [0, headerH - 0.5, 100, 0.5], fill: C.border },
        { type: 'round', position: [-6, -6, 12, 12], fill: C.accent },
        { type: 'round', position: [94, -6, 12, 12], fill: C.accent },
        { type: 'round', position: [94, 94, 12, 12], fill: C.accent_dim },
        { type: 'round', position: [-6, 94, 12, 12], fill: C.accent_dim },
        { type: 'text', position: [0, 2.7, 100, 5.5], value: title, color: C.accent_glow, align: "center", size: 4.2, bold: true },
        { type: 'text', position: [4, 22.4, 45, 4.2], value: subtitle, color: C.text_mid, align: "left", size: 2.7, bold: true },
        { type: 'text', position: [52, 22.4, 44, 4.2], value: "J close / G global / H mine", color: C.text_lo, align: "right", size: 2.5 }
    ];

    if (mode === "player") {
        pushHistoryStatCard(components, 4, "MATCHES", personalHistory.length, C.text_hi, 21);
        pushHistoryStatCard(components, 27, "WIN RATE", winRate, C.green, 21);
        pushHistoryStatCard(components, 50, "BEST", getStat(ship, "maxStreak"), C.gold, 21);
        pushHistoryStatCard(components, 73, "FORM", recentForm || "-", C.accent_glow, 23);
    } else {
        pushHistoryStatCard(components, 4, "FEED", globalHistory.length, C.text_hi, 28);
        pushHistoryStatCard(components, 36, "YOUR WINS", globalSummary.wins, C.green, 28);
        pushHistoryStatCard(components, 68, "DRAWS", globalSummary.draws, C.gold, 28);
    }

    let hY = headerH + 0.5;
    components.push({ type: 'box', position: [0, hY, 100, colH], fill: "hsla(215,50%,15%,1)" });
    components.push({ type: 'box', position: [0, hY + colH, 100, 0.5], fill: C.border });
    components.push({ type: 'text', position: [4, hY + 1.1, 52, 4.6], value: mode === "player" ? "OPPONENT" : "MATCH", color: C.text_mid, size: 2.8, bold: true });
    components.push({ type: 'text', position: [60, hY + 1.1, 18, 4.6], value: "RESULT", color: C.text_mid, size: 2.8, bold: true, align: "center" });
    components.push({ type: 'text', position: [80, hY + 1.1, 17, 4.6], value: "TIME", color: C.text_mid, size: 2.8, bold: true, align: "center" });

    let listStartY = hY + colH + 0.5;
    if (history.length === 0) {
        components.push({ type: 'box', position: [7, 50, 86, 17], fill: "hsla(218,35%,12%,0.92)", stroke: C.border, width: 2 });
        components.push({ type: "text", position: [0, 55, 100, 8], value: mode === "player" ? "No personal matches saved yet." : "No global matches recorded yet.", color: C.text_lo, align: "center", size: 4 });
    } else {
        history.slice(0, 7).forEach((entry, i) => {
            let yBase = listStartY + i * rowH;
            if (yBase + rowH > 100) return;
            let fill = i % 2 === 0 ? "hsla(218,38%,13%,0.95)" : "hsla(218,38%,10%,0.95)";
            let resultValue = mode === "player" ? entry.result : entry.resultLabel;
            let resultColor = resultValue === "Win" ? C.green : resultValue === "Loss" ? C.red : C.gold;
            let resultIcon = resultValue === "Win" ? "WIN" : resultValue === "Loss" ? "LOSS" : "DRAW";
            let stripeColor = resultValue === "Win" ? "hsla(140,80%,40%,0.7)" : resultValue === "Loss" ? "hsla(0,80%,50%,0.7)" : "hsla(44,80%,50%,0.6)";
            let badgeFill = resultValue === "Win" ? "hsla(140,55%,15%,0.92)" : resultValue === "Loss" ? "hsla(0,55%,14%,0.92)" : "hsla(44,70%,14%,0.92)";

            components.push({ type: 'box', position: [0, yBase, 100, rowH - 0.3], fill: fill });
            components.push({ type: 'box', position: [0, yBase, 1.5, rowH - 0.3], fill: stripeColor });
            components.push({ type: 'box', position: [60.5, yBase + 1.5, 17, 5.5], fill: badgeFill, stroke: stripeColor, width: 1 });

            if (mode === "player") {
                components.push({ type: 'text', position: [4, yBase + 1.0, 54, 3.9], value: trimHistoryText(entry.opponent || "???", 22), color: C.text_hi, size: 3.1, bold: true });
                components.push({ type: 'text', position: [4, yBase + 4.8, 54, 3.2], value: resultValue === "Win" ? "Victory" : resultValue === "Loss" ? "Defeat" : "Draw", color: C.text_lo, size: 2.4 });
            } else {
                let matchLine = trimHistoryText(`${entry.leftPlayer || "?"} vs ${entry.rightPlayer || "?"}`, 27);
                let detail = entry.winnerName ? `Winner: ${entry.winnerName}` : (entry.details || "Draw");
                components.push({ type: 'text', position: [4, yBase + 1.0, 54, 3.9], value: matchLine, color: C.text_hi, size: 3.0, bold: true });
                components.push({ type: 'text', position: [4, yBase + 4.8, 54, 3.2], value: trimHistoryText(detail, 26), color: C.text_lo, size: 2.4 });
            }

            components.push({ type: 'text', position: [60.5, yBase + 2.2, 17, 3.9], value: resultIcon, color: resultColor, size: 2.8, bold: true, align: "center" });
            components.push({ type: 'text', position: [80, yBase + 2.2, 17, 3.9], value: entry.time || "", color: C.text_lo, size: 2.4, align: "center" });
        });
    }

    sendUI(ship, {
        id: "history_panel",
        position: [18, 14, 64, 80],
        visible: true,
        clickable: false,
        components
    });
};

let hideHistoryPanel = function(ship) {
    sendUI(ship, { id: "history_panel", visible: false });
};

let sendHistoryModeButtons = function(ship, visible) {
    let mode = getShipHistoryMode(ship);
    buttonCustomUI(ship, "hist_global", [23, 88.5, 16, 6], visible, visible, "G", [
        { type: 'text', position: [0, 22, 100, 38], value: "GLOBAL", size: 4.2, bold: true }
    ], mode === "global" ? 188 : 210, 82, mode === "global" ? 58 : 42, 0.8);
    buttonCustomUI(ship, "hist_personal", [41.5, 88.5, 16, 6], visible, visible, "H", [
        { type: 'text', position: [0, 22, 100, 38], value: "MINE", size: 4.2, bold: true }
    ], mode === "player" ? 145 : 210, 82, mode === "player" ? 54 : 42, 0.8);
};

let sendDuelLeaderboard = function(ship) {
    let arena = ship.custom.arena;
    let opponent = arena?.members?.find(member => member && member !== ship);
    if (!opponent) return false;

    let nameSize = name => name.length > 22 ? 3.4 : name.length > 16 ? 4.0 : 4.8;
    let pushDuelRow = (components, data, shipObj, y, color, label) => {
        let statY = y + 13.6;
        let statBox = (x, labelText, value, statColor = C.text_mid) => {
            components.push({ type: 'box', position: [x, statY, 22, 6.8], fill: "hsla(211,58%,7%,0.72)", stroke: "hsla(188,90%,58%,0.28)", width: 1 });
            components.push({ type: 'text', position: [x + 1, statY + 1.6, 10, 4], value: labelText, color: C.text_lo, align: "left", size: 2.55, bold: true });
            components.push({ type: 'text', position: [x + 11, statY + 1.4, 9, 4], value: String(value), color: statColor, align: "right", size: 3.1, bold: true });
        };
        components.push({ type: 'box', position: [7, y, 86, 24], fill: "hsla(207,58%,10%,0.72)", stroke: color, width: 3 });
        components.push({ type: 'box', position: [7, y, 86, 24], fill: "hsla(190,65%,22%,0.14)" });
        components.push({ type: 'box', position: [7, y, 1.5, 24], fill: color });
        components.push({ type: 'box', position: [7, y, 86, 1], fill: color });
        components.push({ type: 'box', position: [10, y + 2.4, 13, 7.6], fill: "hsla(190,70%,12%,0.70)", stroke: color, width: 1 });
        components.push({ type: 'text', position: [10, y + 4.2, 13, 4], value: label, color, align: "center", size: 2.9, bold: true });
        components.push({ type: 'text', position: [26, y + 2.8, 62, 8], value: shipObj.name, color: C.text_hi, align: "left", size: nameSize(shipObj.name), bold: true });
        statBox(12, "KILLS", data.wins, data.wins > 0 ? C.green : C.text_mid);
        statBox(39, "DEATHS", data.losses, data.losses > 0 ? C.red : C.text_mid);
        statBox(66, "STREAK", data.streak || 0, data.streak > 0 ? C.accent_glow : C.text_mid);
    };

    let left = {
        id: ship.id,
        wins: getStat(ship, "wins"),
        losses: getStat(ship, "losses"),
        streak: getStat(ship, "streak")
    };
    let right = {
        id: opponent.id,
        wins: getStat(opponent, "wins"),
        losses: getStat(opponent, "losses"),
        streak: getStat(opponent, "streak")
    };
    let statusText = arena.inCountdown ? "STARTING" : arena.inMatch ? "IN DUEL" : "DUEL";

    let components = [
        { type: 'box', position: [0, 0, 100, 100], fill: "hsla(214,58%,6%,0.96)", stroke: C.accent_glow, width: 4 },
        { type: 'box', position: [0, 0, 100, 12], fill: "hsla(208,64%,13%,0.94)" },
        { type: 'box', position: [0, 12, 100, 0.6], fill: C.accent_glow },
        { type: 'text', position: [0, 2.2, 100, 5], value: "DUEL SCOREBOARD", color: C.text_hi, align: "center", size: 4.2, bold: true },
        { type: 'text', position: [0, 7.1, 100, 4], value: statusText, color: C.accent_glow, align: "center", size: 2.8, bold: true },
        { type: 'box', position: [43, 42.7, 14, 7], fill: "hsla(188,70%,10%,0.62)", stroke: "hsla(188,100%,65%,0.35)", width: 1 },
        { type: 'text', position: [43, 44.2, 14, 4], value: "VS", color: C.accent_glow, align: "center", size: 3.8, bold: true },
        { type: 'text', position: [0, 83, 100, 4], value: `Arena ${arena.index}`, color: C.text_lo, align: "center", size: 2.8 }
    ];
    pushDuelRow(components, left, ship, 16, C.accent_glow, "YOU");
    pushDuelRow(components, right, opponent, 55, "hsla(203,100%,62%,1)", "RIVAL");
    sendUI(ship, { id: "scoreboard", visible: true, position: [0, 0, 100, 100], components });
    return true;
};

let updatescoreboard = function(game) {
    leaderboard = game.ships.map(ship => ({
        id: ship.id,
        wins: getStat(ship, "wins"),
        losses: getStat(ship, "losses"),
        streak: getStat(ship, "streak") || 0,
        maxStreak: getStat(ship, "maxStreak") || 0,
        isLastLost: !!ship.custom.isLastLost,
        lastMatchStep: +ship.custom.lastMatchStep || -1
    })).sort((a, b) => {
        if (b.wins !== a.wins) return b.wins - a.wins;
        if (b.streak !== a.streak) return b.streak - a.streak;
        if (a.losses !== b.losses) return a.losses - b.losses;
        if (b.maxStreak !== a.maxStreak) return b.maxStreak - a.maxStreak;
        return a.id - b.id;
    });

    leaderboard.forEach((data, index) => {
        let ship = game.findShip(data.id);
        if (ship) {
            ship.custom.rank = index + 1;
            ship.set({ score: leaderboard.length - ship.custom.rank });
        }
    });

    let duelMap = {};
    ArenaManager.list.forEach(arena => {
        if (!arena.lobby && arena.started && arena.members.length >= 2 && (arena.inMatch || arena.inCountdown)) {
            let [p1, p2] = arena.members;
            if (p1 && p2) {
                duelMap[p1.id] = p2.name;
                duelMap[p2.id] = p1.name;
            }
        }
    });

    let col = {
        name:   { x: 4,  w: 60 },
        wins:   { x: 66, w: 9 },
        losses: { x: 77, w: 9 },
        streak: { x: 88, w: 9 }
    };
    let headers = [
        { label: "PLAYER",  ...col.name,   align: "left"   },
        { label: "W",       ...col.wins,   align: "center" },
        { label: "L",       ...col.losses, align: "center" },
        { label: "STR",     ...col.streak, align: "center" }
    ];

    let maxRows   = 7;
    let rowH      = 9.7;
    let headerRowH = 10;
    let textH     = 6.2;
    let rowOffset = (rowH - textH) / 2;

    for (let ship of game.ships) {
        if (ship.custom?.inMatch?.() && sendDuelLeaderboard(ship)) continue;

        let components = [];

        components.push({ type: 'box', position: [0, 0, 100, 100], fill: "hsla(214,58%,6%,0.82)", stroke: C.accent_glow, width: 2 });
        components.push({ type: 'box', position: [0, 0, 100, headerRowH], fill: "hsla(204,68%,13%,0.94)" });
        components.push({ type: 'box', position: [0, 0, 100, 0.7], fill: C.accent_glow });
        components.push({ type: 'box', position: [0, headerRowH - 0.4, 100, 0.4], fill: "hsla(188,90%,58%,0.38)" });
        components.push({ type: 'text', position: [0, 1.7, 100, 6], value: "LEADERBOARD", color: C.accent_glow, align: "center", size: 4.2, bold: true });

        let colHY = headerRowH;
        components.push({ type: 'box', position: [0, colHY, 100, 7], fill: "hsla(207,55%,12%,0.88)" });
        components.push({ type: 'box', position: [0, colHY + 6.5, 100, 0.4], fill: C.accent_dim });
        headers.forEach(h => {
            components.push({ type: "text", position: [h.x, colHY + 1.2, h.w, 4.5], value: h.label, color: C.text_mid, align: h.align, size: 2.9, bold: true });
        });

        let listStartY = colHY + 7;

        leaderboard.slice(0, maxRows).forEach((info, i) => {
            let y = listStartY + i * rowH;
            let rowFill = i % 2 === 0 ? "hsla(209,48%,13%,0.78)" : "hsla(212,48%,9%,0.78)";
            components.push({ type: 'box', position: [1.5, y, 97, rowH - 0.5], fill: rowFill, stroke: "hsla(188,90%,58%,0.12)", width: 1 });

            let rankPrefix = `${i + 1}.`;
            let shipObj    = game.findShip(info.id);
            let inDuel     = !!(duelMap[info.id]);
            let nameColor  = inDuel ? C.accent_glow : (shipObj?.custom?.isReady?.()) ? C.green : C.text_hi;

            let stripeCol = inDuel ? "hsla(188,100%,62%,0.9)"
                : i === 0 ? "hsla(190,100%,70%,0.95)"
                : i === 1 ? "hsla(205,100%,62%,0.8)"
                : i === 2 ? "hsla(220,80%,62%,0.72)"
                : "hsla(210,100%,55%,0.3)";
            components.push({ type: 'box', position: [1.5, y, 1.5, rowH - 0.5], fill: stripeCol });
            components.push({ type: "text", position: [3.3, y + rowOffset, 8, textH], value: rankPrefix, color: i < 3 ? C.accent_glow : C.text_lo, align: "center", size: 3.1, bold: i < 3 });

            if (inDuel && shipObj) {
                let myName  = shipObj.name;
                let oppName = duelMap[info.id];
                let vsStr   = `${myName} vs ${oppName}`;
                let vsSize = vsStr.length > 20 ? 2.5 : 3.0;
                components.push({ type: "text", position: [col.name.x + 8, y + rowOffset, col.name.w - 9, textH], value: vsStr, color: C.accent_glow, align: "left", size: vsSize, bold: true });
            } else {
                components.push({ type: "player", position: [col.name.x + 8, y + rowOffset, col.name.w - 9, textH], id: info.id, color: nameColor, align: "left" });
            }

            components.push({ type: "text", position: [col.wins.x, y + rowOffset, col.wins.w, textH], value: String(info.wins), color: info.wins > 0 ? C.green : C.text_lo, align: "center", size: 3.4, bold: info.wins > 0 });
            components.push({ type: "text", position: [col.losses.x, y + rowOffset, col.losses.w, textH], value: String(info.losses), color: info.losses > 0 ? C.red : C.text_lo, align: "center", size: 3.4 });

            let streakVal   = info.streak;
            let streakLabel = streakVal >= 3 ? `${streakVal}` : streakVal > 0 ? `${streakVal}` : "-";
            let streakColor = streakVal >= 5 ? C.orange : streakVal >= 3 ? C.accent_glow : streakVal > 0 ? C.text_mid : C.text_lo;
            components.push({ type: "text", position: [col.streak.x, y + rowOffset, col.streak.w, textH], value: streakLabel, color: streakColor, align: "center", size: 3.4, bold: streakVal >= 3 });
        });

        let myIndex = leaderboard.findIndex(d => d.id === ship.id);
        if (myIndex >= maxRows) {
            let info = leaderboard[myIndex];
            let myY  = listStartY + maxRows * rowH;
            components.push({ type: 'box', position: [1.5, myY, 97, 0.5], fill: C.accent_glow });
            components.push({ type: 'box', position: [1.5, myY + 0.5, 97, rowH - 0.5], fill: "hsla(190,60%,12%,0.86)", stroke: "hsla(188,90%,58%,0.35)", width: 1 });
            components.push({ type: 'box', position: [1.5, myY + 0.5, 1.5, rowH - 0.5], fill: C.accent_glow });
            components.push({ type: "text", position: [3.3, myY + 0.5 + rowOffset, 8, textH], value: `${myIndex + 1}.`, color: C.accent_glow, align: "center", size: 3 });
            components.push({ type: "player", position: [col.name.x + 8, myY + 0.5 + rowOffset, col.name.w - 9, textH], id: ship.id, color: C.accent_glow, align: "left" });
            components.push({ type: "text", position: [col.wins.x,   myY + 0.5 + rowOffset, col.wins.w,   textH], value: String(info.wins),   color: C.accent_glow, align: "center", size: 3.4 });
            components.push({ type: "text", position: [col.losses.x, myY + 0.5 + rowOffset, col.losses.w, textH], value: String(info.losses), color: C.accent_glow, align: "center", size: 3.4 });
            let sv = info.streak;
            components.push({ type: "text", position: [col.streak.x, myY + 0.5 + rowOffset, col.streak.w, textH], value: sv > 0 ? `${sv}` : "-", color: C.accent_glow, align: "center", size: 3.4 });
        }

        sendUI(ship, { id: "scoreboard", visible: true, position: [0, 0, 100, 100], components });
    }
};

let showKillMessage = function(killer, victim, game) {
    let killText = `${killer.name} > ${victim.name}`;
    if (killer.custom.streak > 1) killText += ` [${killer.custom.streak} streak]`;
    for (let ship of game.ships) {
        if (ship && ship.alive) {
            if (!ship.custom.killFeed) ship.custom.killFeed = [];
            ship.custom.killFeed.push({ text: killText, color: C.red, time: game.step });
            if (ship.custom.killFeed.length > 5) ship.custom.killFeed.shift();
        }
    }
};

let Arena = class {
    constructor(x, y, index) {
        this.x = x; this.y = y; this.members = []; this.originalIndex = index;
        this.reset(true);
        if (index == lobby) this.lobby = true;
        else if (index < lobby) this.index = index + 1;
        else this.index = index;
        let src, title;
        if (this.lobby) { src = ""; title = "credits"; }
        else {
            title = "logo" + this.originalIndex;
            if (index === TRAINING_ARENA_INDEX) {
                src = "";
            } else {
                src = "https://raw.githubusercontent.com/ajodnadjknadkand/duel/refs/heads/main/s2fmain.png";
            }
        }
        setBackgroundCard(title, src, this.x, this.y, 30, 30);
    }
    getRadius() { return arena_radius; }

    assign(ship1, ship2) {
        this.members.splice(0);
        this.members.push(ship1, ship2);
        this.members.forEach((ship, nodeInd) => {
            ship.custom.arena = this;
            ship.custom.spectate = false;
            ship.custom.ready = false;
            ArenaManager.set(ship, this.originalIndex, true, !!nodeInd);
            ship.custom.type = ship.custom.type || ship.type;
            ship.set({ idle: true, type: ship.custom.type + ships_count, stats: 88888888, vx: 0, vy: 0 });
            ship.custom.duelBannerShown = false;
        });
        this.started = true;
        clearDuelCountdown(this);
    }

    shrink(game, ignoreRadarUpdate = false) {
        let prad = this.radius, grad = this.getRadius() * 10;
        if (prad != grad) {
            this.radius = grad;
            let ar = 23.5 * arena_radius;
            setBackgroundCard(
                "safeZoneMarker" + this.originalIndex,
                "https://raw.githubusercontent.com/ajodnadjknadkand/duel/refs/heads/main/arenas2f.png",
                this.x, this.y, ar, ar
            );
            Radar.update(game, !ignoreRadarUpdate);
        }
    }

    distTo(ship) { return dist(this.x, this.y, ship.x, ship.y); }

    reset(init) {
        this.members.splice(0);
        this.duration = this.game_time;
        this.countdown = this.dc_time;
        this.shrink(game, init);
        this.angle = 2 * Math.PI * Math.random();
        this.started = false;
        this.adminSeries = null;
    }

    endDuel(timesUp, ship) {
        let matchNum = game.step;
        let rematchMembers = this.members.filter(member => member?.custom?.joined && !member.custom.exited);
        let series = this.adminSeries || null;
        let seriesWinnerId = null;
        if (timesUp) {
            this.members.forEach(tship => {
                setStates(tship, false, false, true);
                tship.custom.draws = (tship.custom.draws || 0) + 1;
                tship.custom.streak = 0;
                let opponent = this.members.find(m => m !== tship);
                if (opponent) addDuelHistory(tship, opponent.name, "Draw");
            });
            if (this.members[0] && this.members[1]) {
                addGlobalMatchHistory(this.members[0].name, this.members[1].name, "Draw", "", "Time limit reached");
            }
        } else {
            let killer;
            if (this.members.indexOf(ship) !== -1 && (killer = this.members.find(sus => sus !== ship))) {
                killer.custom.wins = getStat(killer, 'wins') + 1;
                let oldStreak = killer.custom.streak || 0;
                killer.custom.streak = oldStreak + 1;
                if (killer.custom.streak > (killer.custom.maxStreak || 0)) killer.custom.maxStreak = killer.custom.streak;
                setStates(killer, true, false, false);
                killer.custom.isLastLost = false;
                ship.custom.losses = getStat(ship, 'losses') + 1;
                ship.custom.streak = 0;
                setStates(ship, false, true, false);
                ship.custom.isLastLost = true;
                if (killer.custom.streak >= 5 && killer.custom.streak % 5 === 0) {
                    for (let s of game.ships) addWarn(s, `${killer.name} is on a ${killer.custom.streak} win streak!`);
                }
                seriesWinnerId = killer.id;
                showKillMessage(killer, ship, game);
                addDuelHistory(killer, ship.name, "Win");
                addDuelHistory(ship, killer.name, "Loss");
                addGlobalMatchHistory(killer.name, ship.name, "Win", killer.name, `${killer.name} defeated ${ship.name}`);
            }
        }
        if (series) {
            if (seriesWinnerId === series.leftId) series.leftWins++;
            else if (seriesWinnerId === series.rightId) series.rightWins++;
            else series.draws++;
            series.remaining--;
        }
        clearDuelCountdown(this);
        if (!series && rematchMembers.length === 2) offerRematch(rematchMembers[0], rematchMembers[1]);
        this.members.forEach(aship => resetShip(aship, true));
        this.countdown = this.duration = 0;
        modUtils.setTimeout(this.reset.bind(this), pendingTpDelay * 60);
        if (series && series.remaining > 0 && rematchMembers.length === 2) {
            let [left, right] = [game.findShip(series.leftId), game.findShip(series.rightId)];
            if (left?.custom?.joined && right?.custom?.joined && !left.custom.exited && !right.custom.exited) {
                for (let target of [left, right]) {
                    showAdminAnnouncement(target, "NEXT ROUND", `Round ${series.total - series.remaining + 1} of ${series.total}`, 3);
                }
                modUtils.setTimeout(() => {
                    if (!left.custom?.joined || !right.custom?.joined || left.custom.exited || right.custom.exited) return;
                    let arenaSlot = ArenaManager.findAvailable() || this;
                    prepareForcedDuelPlayer(left);
                    prepareForcedDuelPlayer(right);
                    arenaSlot.assign(left, right);
                    arenaSlot.adminSeries = series;
                }, pendingTpDelay * 60 + 8);
            }
        } else if (series) {
            let left = game.findShip(series.leftId), right = game.findShip(series.rightId);
            let summary = `${series.leftWins}-${series.rightWins}${series.draws ? `, ${series.draws} draw${series.draws === 1 ? "" : "s"}` : ""}`;
            for (let target of [left, right]) {
                if (target?.custom?.joined) showAdminAnnouncement(target, "SERIES COMPLETE", `Final score: ${summary}`, 5);
            }
            addAdminLog("Force Duel Complete", `${left?.name || series.leftId} vs ${right?.name || series.rightId}`, `Final score ${summary}`, "success");
        }
    }

    tick(game) {
        if (this.inCountdown) {
            this.countdown--;
            showDuelCountdown(this);
            if (this.inMatch) this.members.forEach(ship => {
                max(ship, ship.custom.type);
                ship.set({
                    idle: false, generator: 1e5, invulnerable: 0,
                    crystals: (gem_ratio === false) ? fixed_gems : 20 * (Math.trunc(ship.custom.type / 100) ** 2) * gem_ratio
                });
            });
        } else if (this.inMatch) {
            this.duration--;
            if (this.ended) this.endDuel(true);
        }
    }

    get inCountdown() { return this.started && this.countdown > 0; }
    get inMatch()     { return this.started && this.countdown <= 0 && this.duration > 0; }
    get isAvailable() { return !(this.lobby || this.isTrainingArena || this.started || this.ended); }
    get ended()       { return this.started && !this.inCountdown && !this.inMatch; }
    get dc_time()     { return toTick(duel_countdown / 60); }
    get game_time()   { return toTick(duel_duration); }
    get isTrainingArena() { return this.originalIndex === TRAINING_ARENA_INDEX; }
};


if (!game.custom.ArenaManager) game.custom.ArenaManager = {
    findAvailable: function() { return this.list.find(v => v.isAvailable); },
    waiting_count: 0, list: [], invites: [], lobby: {}, waiting_time: -1,

    checkPlayers: function(game) {
        let waiting_list = game.ships.filter(ship => ship.custom.isReady());
        if (this.isOpen(game)) {
            let arenaSlot;
            while ((arenaSlot = this.findAvailable()) && this.invites.length > 0)
                arenaSlot.assign(...this.invites.splice(0, 1)[0]);

            if (this.findAvailable() && waiting_list.length > 1) {
                if (this.waiting_time < 0) this.waiting_time = queueWaitingTime * 60 + 45;
                else --this.waiting_time;
                if (this.waiting_time < 0) {
                    while ((arenaSlot = this.findAvailable()) && waiting_list.length > 1)
                        arenaSlot.assign(...Array(2).fill(0).map(p => waiting_list.splice(rand(waiting_list.length), 1)[0]));
                }
            } else this.waiting_time = -1;
        } else this.waiting_time = -1;

        this.waiting_count = waiting_list.length + this.invites.length * 2;
        this.list.forEach(arena => !arena.isAvailable && !arena.isTrainingArena && arena.tick(game));
    },
    isOpen: function(game) { return game.step <= toTick(this.game_duration); },
    isRunning: function(game) { return true; },
    set: function(ship, node, forced, reversed) {
        let nodpos = this.list[node] || this.lobby;
        if (ship != null) {
            if (!ship.custom.spectate) { ship.custom.arena = nodpos; ship.custom.TpTimestamp = game.step; }
            if (ship.custom.pendingTp === -1 || forced) {
                ship.custom.pendingTp = -1;
                let angle = 0, distance = 0, noded = !nodpos.lobby && !ship.custom.spectate;
                if (noded) { angle = nodpos.angle || 0; if (reversed) angle += Math.PI; distance = 2 / 3 * r; }
                let { x, y } = nodpos, setup = { x: x + distance * Math.cos(angle), y: y + distance * Math.sin(angle) };
                if (noded) setup.angle = 180 * ((1 + angle / Math.PI) % 2);
                ship.set(setup);
            }
        }
    },
    findNearest: function(ship) {
        let t = this.list.map(i => i.distTo(ship)), min = Math.min(...t);
        return this.list[t.indexOf(min)];
    }
};

let ArenaManager = game.custom.ArenaManager;
Object.assign(ArenaManager, { Arena, game_duration });

// ---- Training arena alien spawner ----
let trainingAlienSpawnTimer = 0;
let trainingAlienBoundaryTimer = 0;
const TRAINING_ALIEN_TYPES = [
    {code:10, level:1, points:10, crystal_drop:10},

];

// FIX: Training arena boundary radius for alien confinement
// Aliens are culled if they drift beyond this multiple of arena_radius*10
const TRAINING_ALIEN_MAX_RADIUS_FACTOR = 1.1; // slightly inside the visual boundary

const getTrainingArena = () => ArenaManager.list ? ArenaManager.list.find(a => a.isTrainingArena) : null;

const getTrainingPlayers = () => game.ships.filter(s => s?.custom?.inTraining && s.alive);

const getTrainingAlienTargetCount = () => {
    let players = getTrainingPlayers().length;
    if (players <= 0) return 0;
    return Math.min(adminRuntime.trainingAlienCap, players * adminRuntime.trainingAlienCount);
};

const getTrainingAliens = (trainingArena) => {
    if (!trainingArena) return [];
    try {
        let aliens = game.aliens || [];
        let maxDist = arena_radius * 10 * TRAINING_ALIEN_MAX_RADIUS_FACTOR;
        return aliens.filter(alien => dist(alien.x, alien.y, trainingArena.x, trainingArena.y) < maxDist);
    } catch(e) { return []; }
};

const countTrainingAliens = (trainingArena) => {
    return getTrainingAliens(trainingArena).length;
};

const killAlienSafe = (alien) => {
    try { alien.set({ kill: true }); return true; } catch(e) { return false; }
};

const trimTrainingAliensToTarget = (targetCount = getTrainingAlienTargetCount(), removeAll = false) => {
    let trainingArena = getTrainingArena();
    if (!trainingArena) return 0;
    let aliens = getTrainingAliens(trainingArena);
    let keep = removeAll ? 0 : Math.max(0, targetCount);
    if (aliens.length <= keep) return 0;
    let removed = 0;
    for (let alien of aliens.slice(keep)) if (killAlienSafe(alien)) removed++;
    return removed;
};

const spawnTrainingAliens = () => {
    let trainingArena = getTrainingArena();
    if (!trainingArena) return;

    let targetCount = getTrainingAlienTargetCount();
    if (targetCount <= 0) {
        trimTrainingAliensToTarget(0, true);
        return;
    }

    let currentCount = countTrainingAliens(trainingArena);
    if (currentCount > targetCount) {
        trimTrainingAliensToTarget(targetCount);
        return;
    }
    if (currentCount >= targetCount) return;

    // Spawn gradually to keep ping/FPS stable when several players enter training.
    let toSpawn = Math.min(Math.max(1, getTrainingPlayers().length), 4, targetCount - currentCount);
    // FIX: Clamp spawn radius so aliens always start well inside the boundary
    let maxSpawnRadius = arena_radius * 10 * 0.75;
    let minSpawnRadius = arena_radius * 10 * 0.15;
    for (let s = 0; s < toSpawn; s++) {
        let angle = Math.random() * Math.PI * 2;
        let spawnDist = minSpawnRadius + Math.random() * (maxSpawnRadius - minSpawnRadius);
        let alienType = TRAINING_ALIEN_TYPES[Math.floor(Math.random() * TRAINING_ALIEN_TYPES.length)];
        try {
            game.addAlien({
                ...alienType,
                x: trainingArena.x + Math.cos(angle) * spawnDist,
                y: trainingArena.y + Math.sin(angle) * spawnDist
            });
        } catch(e) {}
    }
};

// FIX: Kill any training aliens that have drifted outside the arena boundary
// Called every tick from check() to enforce confinement
const enforceTrainingAlienBoundary = () => {
    let trainingArena = getTrainingArena();
    if (!trainingArena) return;
    try {
        let aliens = game.aliens || [];
        let maxDist = arena_radius * 10 * TRAINING_ALIEN_MAX_RADIUS_FACTOR;
        for (let alien of aliens) {
            if (dist(alien.x, alien.y, trainingArena.x, trainingArena.y) > maxDist) {
                try { alien.set({ kill: true }); } catch(e) {}
            }
        }
        trimTrainingAliensToTarget();
    } catch(e) {}
};

const showTrainingBanner = (ship) => {
    sendUI(ship, {
        id: "training_banner",
        position: [38, 1, 24, 7],
        visible: true,
        clickable: false,
        components: [
            { type: 'box', position: [0, 0, 100, 100], fill: "hsla(130, 60%, 10%, 0.92)", stroke: "hsla(120,100%,60%,0.8)", width: 4 },
            { type: 'round', position: [-6, -6, 12, 12], fill: "hsla(120,100%,55%,1)" },
            { type: 'round', position: [94, -6, 12, 12], fill: "hsla(120,100%,55%,1)" },
            { type: 'round', position: [-6, 94, 12, 12], fill: "hsla(120,100%,55%,1)" },
            { type: 'round', position: [94, 94, 12, 12], fill: "hsla(120,100%,55%,1)" },
            { type: 'text', position: [0, 8, 100, 40], value: "TRAINING", color: "hsla(120,100%,72%,1)", align: "center", size: 5, bold: true },
            { type: 'text', position: [0, 52, 100, 36], value: "Press Z to return", color: C.text_mid, align: "center", size: 3.5 }
        ]
    });
};

const hideTrainingBanner = (ship) => {
    sendUI(ship, { id: "training_banner", visible: false });
};

const teleportToTraining = (ship) => {
    if (!ship?.custom?.joined) return;
    if (isForcedSpectator(ship)) {
        addWarn(ship, "You cannot enter training while force-spectating.");
        return;
    }
    let trainingArena = ArenaManager.list.find(a => a.isTrainingArena);
    if (!trainingArena) return;

    if (ship.custom.arena && !ship.custom.arena.lobby && ship.custom.arena.started) {
        ship.custom.arena.endDuel(false, ship);
    }

    ship.custom.ready = false;
    ship.custom.spectate = false;
    ship.custom.shipped = false;
    ship.custom.invite_shown = false;
    ship.custom.history_shown = false;
    ship.custom.paired = null;
    ship.custom.inTraining = true;
    ship.custom.arena = trainingArena;
    ship.custom.TpTimestamp = game.step;

    let angle = Math.random() * Math.PI * 2;
    // FIX: Spawn player inside training arena boundary
    let dx = Math.cos(angle) * (arena_radius * 10 * 0.4);
    let dy = Math.sin(angle) * (arena_radius * 10 * 0.4);
    max(ship, ship.custom.type);
    ship.set({
        x: trainingArena.x + dx,
        y: trainingArena.y + dy,
        idle: false,
        invulnerable: 180,
        vx: 0, vy: 0,
        shield: 1e5
    });

    // Trigger immediate alien spawn
    trainingAlienSpawnTimer = 999;

    showTrainingBanner(ship);
    showTimedMessage(ship, "TRAINING", "hsla(120,100%,72%,1)", 2);
};

const returnFromTraining = (ship) => {
    if (!ship?.custom?.joined || !ship.custom.inTraining) return;
    ship.custom.inTraining = false;
    ship.custom.ready = false;
    ship.custom.spectate = false;
    ship.custom.shipped = false;
    ship.custom.arena = ArenaManager.lobby;
    hideTrainingBanner(ship);
    max(ship, ship.custom.prevShipCode || ship.custom.type || ship.type);
    ArenaManager.set(ship, lobby, true);
    ship.set({ idle: false, invulnerable: 600, vx: 0, vy: 0 });
    showTimedMessage(ship, "LOBBY", C.accent_glow, 1.5);
};


let insideRoundCornerCustomLayout = function(h, s, l, custom = [], scale = 1) {
    let fill = `hsla(${h},${s}%,${l}%, 1)`;
    for (let cp of custom) {
        if (!cp.forceCustomColor && (cp.type == "text" || cp.type == "player")) cp.color = fill;
        if (!cp.forceCustomFill) delete cp.fill;
        if (!cp.forceCustomStroke) delete cp.stroke;
        delete cp.forceCustomColor;
        delete cp.forceCustomFill;
        delete cp.forceCustomStroke;
    }
    let radius = C.r * scale, diameter = 2 * radius;
    return [
        { type: 'box', position: [0, 0, 100, 100], stroke: fill, fill: `hsla(${h}, ${s}%, ${Math.max(l - 32, 5)}%, ${button_opacity})`, width: C.stroke_w * scale },
        { type: 'round', position: [-radius, -radius, diameter, diameter], fill: fill },
        { type: 'round', position: [100 - radius, -radius, diameter, diameter], fill: fill },
        { type: 'round', position: [100 - radius, 100 - radius, diameter, diameter], fill: fill },
        { type: 'round', position: [-radius, 100 - radius, diameter, diameter], fill: fill },
        ...custom
    ];
};

let buttonCustomUI = function(ship, id, position, visible, clickable, shortcut, custom = [], h, s = 90, l = 60, scale = 1) {
    sendUI(ship, { id, position, visible, clickable: clickable ?? visible, shortcut, components: insideRoundCornerCustomLayout(h, s, l, custom, scale) });
};

let buttonBasicUI = function(ship, id, position, visible, clickable, shortcut, text, h, s = 90, l = 60, scale = 1) {
    buttonCustomUI(ship, id, position, visible, clickable, shortcut, [
        { type: 'text', position: [0, 18, 100, 36], value: text, size: 6, bold: true },
        { type: 'text', position: [0, 56, 100, 28], value: `[${shortcut}]`, size: 4 }
    ], h, s, l, scale);
};

let makeTopBtn = function(label, shortcut, hue, isActive, extra = {}) {
    let sat = extra.sat || 85, lit = extra.lit || 55;
    let isOn = !!extra.on;
    let fillAlpha = isOn ? 0.25 : 0.15;
    let borderAlpha = isOn ? 1.0 : 0.7;
    return [
        { type: 'box', position: [0, 0, 100, 100], fill: `hsla(${hue},${sat}%,${Math.max(lit - 30, 5)}%,${fillAlpha})`, stroke: `hsla(${hue},${sat}%,${lit}%,${borderAlpha})`, width: 3 },
        { type: 'round', position: [-7, -7, 14, 14], fill: `hsla(${hue},${sat}%,${lit}%,1)` },
        { type: 'round', position: [93, -7, 14, 14], fill: `hsla(${hue},${sat}%,${lit}%,1)` },
        { type: 'round', position: [93, 93, 14, 14], fill: `hsla(${hue},${sat}%,${lit}%,1)` },
        { type: 'round', position: [-7, 93, 14, 14], fill: `hsla(${hue},${sat}%,${lit}%,1)` },
        { type: "text", position: [0, 12, 100, 44], value: label, color: `hsla(${hue},${sat}%,${Math.min(lit + 30, 98)}%,1)`, align: "center", size: 5, bold: true },
        { type: "text", position: [0, 58, 100, 28], value: `[${shortcut}]`, color: `hsla(${hue},${Math.max(sat - 30, 20)}%,${lit}%,0.8)`, align: "center", size: 3 }
    ];
};

let sendAdminShipButton = function(ship, visible) {
    let canUse = !!visible && ship?.custom?.joined && isAdminPlayer(ship) && ship.alive;
    sendUI(ship, {
        id: "btn_admin_ship",
        position: [1, 1, 14, 6.5],
        visible: canUse,
        clickable: canUse,
        shortcut: "L",
        components: makeTopBtn(ship.custom?.adminShipActive ? "ADMIN ON" : "ADMIN SHIP", "L", 188, canUse, {
            sat: 90,
            lit: ship.custom?.adminShipActive ? 62 : 52,
            on: !!ship.custom?.adminShipActive
        })
    });
};

let toggleAdminShip = function(ship) {
    if (!ship?.custom?.joined || !isAdminPlayer(ship)) return addWarn(ship, "Admin ship is admin-only.");
    if (isForcedSpectator(ship)) return addWarn(ship, "Admin ship unavailable while force spectating.");
    if (ship.custom.inMatch?.()) return addWarn(ship, "Admin ship unavailable during a duel.");
    if (!ship.custom.adminShipActive) {
        ship.custom.prevShipCode = ship.custom.prevShipCode || ship.custom.type || ship.type;
        ship.custom.adminShipActive = true;
        ship.custom.ready = false;
        ship.custom.spectate = false;
        ship.custom.shipped = false;
        ship.custom.mapped = false;
        ship.custom.invite_shown = false;
        ship.custom.history_shown = false;
        ship.set({ type: ADMIN_SHIP_CODE, stats: 88888888, crystals: 0, shield: 1e5, invulnerable: 600 });
        addWarn(ship, "Admin ship enabled.", false, null, true);
    } else {
        ship.custom.adminShipActive = false;
        max(ship, ship.custom.prevShipCode || ship.custom.type || ship.type);
        addWarn(ship, "Admin ship disabled.", false, null, true);
    }
    sendAdminShipButton(ship, true);
};

let sendTopBar = function(ship, isActive) {
    let bool = !!ship.custom.spectate;
    let ready = ship.custom.isReady();
    let invite_shown = !!ship.custom.invite_shown;
    let history_shown = !!ship.custom.history_shown;
    let inTraining = !!ship.custom.inTraining;
    let historyLabel = history_shown ? "CLOSE FEED" : (getShipHistoryMode(ship) === "player" ? "MY HISTORY" : "MATCH FEED");

    let queueCount = ArenaManager.waiting_count || 0;
    let readyLabel = ready ? "READY" : (queueCount > 0 ? `QUEUE ${queueCount}` : "NOT READY");
    sendAdminShipButton(ship, isActive && isAdminPlayer(ship));

    sendUI(ship, {
        id: "btn_ready",
        position: [29, 1, 14, 6.5],
        visible: isActive && !inTraining,
        clickable: isActive && !inTraining,
        shortcut: "A",
        components: makeTopBtn(readyLabel, "A", ready ? 130 : 0, isActive, { sat: 85, lit: ready ? 55 : 58, on: ready })
    });

    if (inTraining) {
        sendUI(ship, {
            id: "btn_training",
            position: [29, 8.5, 14, 6.5],
            visible: isActive,
            clickable: isActive,
            shortcut: "Z",
            components: makeTopBtn("LOBBY", "Z", 120, isActive, { sat: 80, lit: 50, on: true })
        });
        sendUI(ship, { id: "btn_ready", visible: false });
    } else {
        sendUI(ship, {
            id: "btn_training",
            position: [29, 8.5, 14, 6.5],
            visible: isActive && !bool,
            clickable: isActive && !bool,
            shortcut: "Z",
            components: makeTopBtn("TRAIN", "Z", 120, isActive && !bool, { sat: 75, lit: 45, on: false })
        });
    }

    sendUI(ship, {
        id: "btn_spectate",
        position: [43, 1, 14, 6.5],
        visible: isActive && !inTraining,
        clickable: isActive && !inTraining,
        shortcut: "K",
        components: makeTopBtn("SPECTATE", "K", bool ? 50 : 210, isActive, { sat: 85, lit: 55, on: bool })
    });

    let inviters = [...ship.custom.inviters.keys()].filter(id => {
        let s = game.findShip(id);
        return s && s != ship && !s.custom.isReady() && !s.custom.inMatch();
    }).length;
    let invLabel = invite_shown ? "CLOSE" : ("INVITE" + (inviters > 0 ? ` (${inviters})` : ""));

    sendUI(ship, {
        id: "btn_invite",
        position: [57, 1, 14, 6.5],
        visible: isActive && !bool && !inTraining,
        clickable: isActive && !bool && !inTraining,
        shortcut: "V",
        components: makeTopBtn(invLabel, "V", invite_shown ? 35 : (inviters > 0 ? 44 : 210), isActive && !bool, { sat: 85, lit: 55, on: invite_shown || inviters > 0 })
    });

    if (bool || inTraining) sendUI(ship, { id: "btn_invite", visible: false });

    sendUI(ship, {
        id: "btn_history",
        position: [43, 8.5, 14, 6.5],
        visible: isActive && !inTraining,
        clickable: isActive && !inTraining,
        shortcut: "J",
        components: makeTopBtn(historyLabel, "J", history_shown ? 35 : 210, isActive && !bool, { sat: 80, lit: 52, on: history_shown })
    });

    if (bool || inTraining) sendUI(ship, { id: "btn_history", visible: false });

    let rematchVisible = hasActiveRematchOffer(ship) && !bool && !inTraining && isActive;
    let rematchLabel = ship.custom.rematchOffer?.voted ? "VOTED" : "REMATCH";
    sendUI(ship, {
        id: "btn_rematch",
        position: [57, 8.5, 14, 6.5],
        visible: rematchVisible,
        clickable: rematchVisible,
        shortcut: "P",
        components: makeTopBtn(rematchLabel, "P", ship.custom.rematchOffer?.voted ? 145 : 188, isActive, { sat: 85, lit: 55, on: ship.custom.rematchOffer?.voted })
    });
};

let setPicker = function(ship, isActive) {
    if (adminRuntime.endCeremonyRunning) {
        hideGameplayControls(ship);
        return;
    }
    isActive = ship.alive && !!isActive;
    let bool = !!ship.custom.spectate;
    let inTraining = !!ship.custom.inTraining;
    sendTopBar(ship, isActive);

    if (!isActive) {
        if (ship.custom.history_shown) { ship.custom.history_shown = false; hideHistoryPanel(ship); }
    }

    let w = 50 / nW;
    let wh = 50 / nH;
    let nearest = ArenaManager.findNearest(ship);

    ArenaManager.list.forEach(arena => {
        let isArenaTraining = arena.isTrainingArena;
        let text = arena.lobby ? "LOBBY" : isArenaTraining ? "TRAINING" : ("ARENA " + arena.index);
        let i = arena.originalIndex;
        let duelerNames = "";
        if (!arena.lobby && !isArenaTraining && arena.started && arena.members.length > 0)
            duelerNames = arena.members.map(s => s.name).join(" vs ");

        let statusText = "", statusColor = C.text_mid;
        if (arena === nearest) { statusText = "YOU ARE HERE"; statusColor = C.accent_glow; }
        if (isArenaTraining) { statusText = "TRAINING ZONE"; statusColor = "hsla(120,100%,65%,1)"; }
        else if (!arena.isAvailable && !arena.lobby) {
            if (arena.inCountdown) { statusText = "STARTING..."; statusColor = C.gold; }
            else if (arena.inMatch) { statusText = "FIGHTING"; statusColor = C.red; }
            else { statusText = "FINISHED"; statusColor = C.text_lo; }
        }

        let compo = [
            { type: "text", position: [20, 2, 60, 40], value: text, size: 6, bold: true, color: isArenaTraining ? "hsla(120,100%,72%,1)" : C.text_hi },
        ];
        if (duelerNames) compo.push({ type: "text", position: [20, 42, 60, 28], value: duelerNames, color: C.gold, size: 3 });
        if (statusText)  compo.push({ type: "text", position: [20, 68, 60, 28], value: statusText, color: statusColor, size: 3 });

        let hue = isArenaTraining ? 120 : arena.inMatch ? 0 : arena.inCountdown ? 44 : arena === nearest ? 210 : 220;
        let col_i = i % nW;
        let row_i = Math.trunc(i / nW);
        buttonCustomUI(ship, "n" + i, [25 + col_i * w, 35 + row_i * wh, w, wh], bool && isActive && ship.custom.mapped, null, null, compo, hue, 80, 55);
    });

    let ship_info = getShipsPage(ship).list, wt = Math.PI * 2 / ship_info.length, br = 21.5;

    ship_info.forEach((info, i) => {
        let nspace = new Array(maxNamelength - info.name.length).fill(" ").join("");
        let dspace = new Array(maxDesignerlength - info.designer.length).fill(" ").join("");
        let selected = ship.type === info.code;

        let compo = [
            { type: "text", position: [10, 8, 80, 42], value: nspace + info.name + nspace, size: 6, bold: selected, color: selected ? C.gold : C.text_hi },
        ];
        if (selected) compo.push({ type: "text", position: [10, 50, 80, 26], value: "SELECTED", size: 4, color: C.green });
        if (info.designer) compo.push({ type: "text", position: [10, selected ? 78 : 58, 80, 26], value: dspace + "by " + info.designer + dspace, size: 3, color: C.text_lo });

        buttonCustomUI(ship, "s" + i, [50 + br * Math.cos(wt * i - Math.PI / 2) - 5, 50 + br * Math.sin(wt * i - Math.PI / 2) - 3.5, 10, 9],
            !bool && isActive && ship.custom.shipped, null, null, compo,
            selected ? 140 : (210 / ship_info.length * (2 * i + 1)), 85, selected ? 55 : 50);
    });

    if (ship_info.length < max_ship_items)
        for (let i = ship_info.length; i < max_ship_items; i++) sendUI(ship, { id: "s" + i, visible: false });

    let multipleShipsPages = ship_infos_flattened.length > max_item_per_ship_selection_screen;

    sendUI(ship, {
        id: "shipview",
        visible: !bool && isActive && ship.custom.shipped,
        clickable: false,
        position: [35, 35, 30, 60],
        components: [
            { type: 'box', position: [0, 0, 100, 100], fill: C.bg_card, stroke: C.border, width: 3 },
            { type: 'round', position: [0, 0, 100, 52], fill: "hsla(0,0%,0%,0)", stroke: C.border_hi, width: 2 },
            { type: "text", position: [0, 64, 100, 10], value: "7 / 8 : CHANGE SHIP", color: C.text_lo, size: 4, align: "center" },
            ...(multipleShipsPages ? [{ type: "text", position: [0, 78, 100, 10], value: `PAGE ${ship.custom.ships_page + 1}/${ship_infos.length}`, color: C.text_mid, size: 4, align: "center" }] : [])
        ]
    });

    if (multipleShipsPages) {
        buttonBasicUI(ship, "spprev", [25, 85, 10, 8], !bool && isActive && ship.custom.shipped, null, "B", "< PREV", 210);
        buttonBasicUI(ship, "spnext", [65, 85, 10, 8], !bool && isActive && ship.custom.shipped, null, "M", "NEXT >", 210);
    }

    sendUI(ship, {
        id: "map",
        position: [10, 42, 10, 9],
        visible: bool && isActive,
        clickable: bool && isActive,
        shortcut: "M",
        components: [
            { type: 'box', position: [0, 0, 100, 100], fill: C.bg_card, stroke: C.border_hi, width: 4 },
            { type: 'round', position: [-9, -9, 18, 18], fill: C.accent },
            { type: 'round', position: [91, -9, 18, 18], fill: C.accent },
            { type: 'round', position: [91, 91, 18, 18], fill: C.accent },
            { type: 'round', position: [-9, 91, 18, 18], fill: C.accent },
            { type: "text", position: [0, 15, 100, 44], value: ship.custom.mapped ? "HIDE MAP" : "SHOW MAP", color: C.text_hi, align: "center", size: 5, bold: true },
            { type: "text", position: [0, 60, 100, 28], value: "[M]", color: C.text_lo, align: "center", size: 4 }
        ]
    });

    sendUI(ship, {
        id: "mapview",
        visible: bool && isActive && ship.custom.mapped,
        clickable: false,
        position: [30, 85, 40, 10],
        components: [
            { type: 'box', position: [0, 0, 100, 100], fill: C.bg_card, stroke: C.border, width: 3 },
            { type: "text", position: [0, 15, 100, 70], value: "9 / 0 : NAVIGATE ARENAS", color: C.text_mid, size: 4, align: "center", bold: true }
        ]
    });

    if (ship_infos_flattened.length > 1) {
        sendUI(ship, {
            id: "chooser",
            position: [0, 33, 10, 9],
            visible: isActive && !inTraining,
            clickable: isActive && !inTraining,
            shortcut: "C",
            components: makeTopBtn(ship.custom.shipped ? "CLOSE" : "CHANGE SHIP", "C", 210, isActive, { sat: 80, lit: 55, on: ship.custom.shipped })
        });
    }

    if (ship.custom.history_shown && isActive && !inTraining) {
        showHistoryPanel(ship);
    } else {
        hideHistoryPanel(ship);
    }
    sendHistoryModeButtons(ship, !!ship.custom.history_shown && isActive && !inTraining);

    let ships_list = [];
    for (let id = 0; id <= game.custom.maxID; ++id) {
        let s;
        if (ship.custom.invite_shown && isActive && !bool && !inTraining && (s = game.findShip(id)) != null && canInviteTarget(ship, s)) {
            let isInvited = !!ship.custom.inviters.get(id);
            let hasInvite = isInvited || !!ship.custom.inviting.get(id);
            let UIList = JSON.parse(JSON.stringify(InviteButtons));
            UIList[0].visible = !hasInvite;
            UIList[1].visible = hasInvite;
            UIList[2].visible = isInvited;
            ships_list.push({
                id,
                UIList
            });
        } else for (let jid of ["invite", "accept", "decline"]) sendUI(ship, { id: jid + id, visible: false });
    }

    let total_invite_pages = Math.ceil(ships_list.length / total_invites_per_page);
    let multipleInvitePages = total_invite_pages > 1;
    ship.custom.invite_page = Math.trunc(Math.max(Math.min(ship.custom.invite_page, total_invite_pages), -1)) || 0;
    let ui_list = [];

    if (ship.custom.invite_page == total_invite_pages) ship.custom.invite_page = 0;
    else if (ship.custom.invite_page < 0) ship.custom.invite_page = total_invite_pages - 1;

    let inviteButtonQueue = [];

    ships_list.forEach(({ id, UIList }, idx) => {
        if (ship.custom.invite_page * total_invites_per_page <= idx && idx < (ship.custom.invite_page + 1) * total_invites_per_page) {
            let index = idx % total_invites_per_page;
            let row = Math.trunc(index / invite_columns), column = (index % invite_columns);
            let offsetYPos = InviteScreen.offsetY + (row * pHeight + 10) * InviteScreen.height / 100;
            let visibleButtons = UIList.filter(ui => ui.visible);
            let buttonSize = actual_height * 0.68;
            let buttonGap = 0.55;
            let buttonBlockW = visibleButtons.length * buttonSize + Math.max(visibleButtons.length - 1, 0) * buttonGap;
            let buttonStartX = InviteScreen.offsetX + column * actual_width + actual_width - buttonBlockW - 1.8;

            visibleButtons.forEach((ui, buttonIndex) => {
                inviteButtonQueue.push({
                    id,
                    ui,
                    position: [buttonStartX + buttonIndex * (buttonSize + buttonGap), offsetYPos + 2.9, buttonSize, buttonSize]
                });
            });

            let reservedButtonW = (buttonBlockW / InviteScreen.width * 100) + 8;
            let rowH = pHeight * 0.68;
            let rowY = InviteScreen.margin.top + row * pHeight + 0.95;
            let actual_position = [
                InviteScreen.margin.left + column * pWidth,
                rowY,
                pWidth - reservedButtonW + 4,
                rowH
            ];

            let rowFill = (row + column) % 2 === 0 ? "hsla(215,45%,17%,0.48)" : "hsla(220,45%,14%,0.42)";
            ui_list.push({ type: 'box', position: actual_position, fill: rowFill, stroke: "hsla(200,70%,38%,0.32)", width: 1, forceCustomFill: true, forceCustomStroke: true });
            ui_list.push({ type: 'box', position: [actual_position[0], actual_position[1], 1.5, actual_position[3]], fill: "hsla(188,100%,60%,0.76)", forceCustomFill: true });
            let target = game.findShip(id);
            let displayName = target?.name || `Player ${id}`;
            let nameRoom = Math.max(actual_position[2] - 10, 10);
            let nameSize = Math.max(2.4, Math.min(4.1, nameRoom / Math.max(displayName.length, 1) * 1.55));
            ui_list.push({ type: "text", position: [actual_position[0] + 4, actual_position[1] + 1.15, actual_position[2] - 6, actual_position[3] - 2], value: displayName, color: C.text_hi, forceCustomColor: true, align: "left", size: nameSize, bold: true });
        } else for (let jid of ["invite", "accept", "decline"]) sendUI(ship, { id: jid + id, visible: false });
    });

    sendUI(ship, {
        id: "invprev",
        position: [25, 85, 10, 8],
        visible: !!ship.custom.invite_shown && isActive && !bool && multipleInvitePages,
        clickable: !!ship.custom.invite_shown && isActive && !bool && multipleInvitePages,
        shortcut: "B",
        components: [
            { type: 'box', position: [0, 0, 100, 100], fill: C.bg_card, stroke: C.border_hi, width: 4 },
            { type: 'round', position: [-9, -9, 18, 18], fill: C.accent },
            { type: 'round', position: [91, -9, 18, 18], fill: C.accent },
            { type: 'round', position: [91, 91, 18, 18], fill: C.accent },
            { type: 'round', position: [-9, 91, 18, 18], fill: C.accent },
            { type: 'text', position: [0, 18, 100, 62], value: "< PREV", color: C.text_hi, size: 5, align: 'center', bold: true }
        ]
    });

    sendUI(ship, {
        id: "invnext",
        position: [65, 85, 10, 8],
        visible: !!ship.custom.invite_shown && isActive && !bool && multipleInvitePages,
        clickable: !!ship.custom.invite_shown && isActive && !bool && multipleInvitePages,
        shortcut: "M",
        components: [
            { type: 'box', position: [0, 0, 100, 100], fill: C.bg_card, stroke: C.border_hi, width: 4 },
            { type: 'round', position: [-9, -9, 18, 18], fill: C.accent },
            { type: 'round', position: [91, -9, 18, 18], fill: C.accent },
            { type: 'round', position: [91, 91, 18, 18], fill: C.accent },
            { type: 'round', position: [-9, 91, 18, 18], fill: C.accent },
            { type: 'text', position: [0, 18, 100, 62], value: "NEXT >", color: C.text_hi, size: 5, align: 'center', bold: true }
        ]
    });

    sendUI(ship, {
        id: "invite_screen",
        position: InviteScreen.position,
        visible: !!ship.custom.invite_shown && isActive && !bool && !inTraining,
        clickable: false,
        components: [
            { type: 'box', position: [0, 0, 100, 100], fill: "hsla(220,52%,7%,0.68)", stroke: C.border_hi, width: 4 },
            { type: 'box', position: [0, 0, 100, InviteScreen.margin.top], fill: "hsla(216,56%,13%,0.82)" },
            { type: 'box', position: [0, 1.4, 100, 1], fill: C.accent },
            { type: 'box', position: [0, InviteScreen.margin.top - 0.5, 100, 0.5], fill: C.border },
            { type: 'round', position: [-7, -7, 14, 14], fill: C.accent },
            { type: 'round', position: [93, -7, 14, 14], fill: C.accent },
            { type: 'text', position: [InviteScreen.margin.left, 2.1, InviteScreen.actualWidthPercentage, InviteScreen.margin.top - 4], value: "INVITE PLAYERS", color: C.accent_glow, size: 6.3, align: 'center', bold: true },
            { type: 'text', position: [3, 7.3, 35, 4], value: `AVAILABLE ${ships_list.length}`, color: C.text_mid, size: 2.7, align: 'left', bold: true },
            { type: 'text', position: [62, 7.3, 35, 4], value: `PAGE ${multipleInvitePages ? `${ship.custom.invite_page + 1}/${total_invite_pages}` : "1/1"}`, color: C.text_mid, size: 2.7, align: 'right', bold: true },
            ...ui_list
        ]
    });

    sendUI(ship, {
        id: "invprev",
        position: [25, 85, 10, 8],
        visible: !!ship.custom.invite_shown && isActive && !bool && multipleInvitePages,
        clickable: !!ship.custom.invite_shown && isActive && !bool && multipleInvitePages,
        shortcut: "B",
        components: [
            { type: 'box', position: [0, 0, 100, 100], fill: C.bg_card, stroke: C.border_hi, width: 4 },
            { type: 'round', position: [-9, -9, 18, 18], fill: C.accent },
            { type: 'round', position: [91, -9, 18, 18], fill: C.accent },
            { type: 'round', position: [91, 91, 18, 18], fill: C.accent },
            { type: 'round', position: [-9, 91, 18, 18], fill: C.accent },
            { type: 'text', position: [0, 18, 100, 62], value: "< PREV", color: C.text_hi, size: 5, align: 'center', bold: true }
        ]
    });

    sendUI(ship, {
        id: "invnext",
        position: [65, 85, 10, 8],
        visible: !!ship.custom.invite_shown && isActive && !bool && multipleInvitePages,
        clickable: !!ship.custom.invite_shown && isActive && !bool && multipleInvitePages,
        shortcut: "M",
        components: [
            { type: 'box', position: [0, 0, 100, 100], fill: C.bg_card, stroke: C.border_hi, width: 4 },
            { type: 'round', position: [-9, -9, 18, 18], fill: C.accent },
            { type: 'round', position: [91, -9, 18, 18], fill: C.accent },
            { type: 'round', position: [91, 91, 18, 18], fill: C.accent },
            { type: 'round', position: [-9, 91, 18, 18], fill: C.accent },
            { type: 'text', position: [0, 18, 100, 62], value: "NEXT >", color: C.text_hi, size: 5, align: 'center', bold: true }
        ]
    });

    for (let { id, ui, position } of inviteButtonQueue) {
        let btnFill   = `hsla(${ui.fillH},${ui.fillS}%,${ui.fillL}%,0.98)`;
        let btnStroke = `hsla(${ui.hue},${ui.sat}%,${ui.lit}%,1)`;
        let btnGlow   = `hsla(${ui.hue},${ui.sat}%,${Math.min(ui.lit + 24, 96)}%,1)`;

        buttonCustomUI(ship, ui.name + id,
            position,
            ui.visible, null, null,
            [
                { type: 'box', position: [0, 0, 100, 100], fill: btnFill, stroke: btnStroke, width: 6, forceCustomFill: true, forceCustomStroke: true },
                { type: 'round', position: [-7, -7, 14, 14], fill: btnStroke, forceCustomFill: true },
                { type: 'round', position: [93, -7, 14, 14], fill: btnStroke, forceCustomFill: true },
                { type: 'round', position: [93, 93, 14, 14], fill: btnStroke, forceCustomFill: true },
                { type: 'round', position: [-7, 93, 14, 14], fill: btnStroke, forceCustomFill: true },
                { type: "text", position: [0, 5, 100, 90], value: ui.symbol, color: btnGlow, size: 14.5, bold: true, align: "center", forceCustomColor: true }
            ], ui.hue, ui.sat, ui.lit);
    }
};

let InviteButtons = [
    { name: "invite",  symbol: "+", hue: 210, sat: 100, lit: 62, fillH: 220, fillS: 80, fillL: 18 },
    { name: "decline", symbol: "X", hue: 0,   sat: 100, lit: 58, fillH: 0,   fillS: 80, fillL: 18 },
    { name: "accept",  symbol: "V", hue: 140,  sat: 100, lit: 48, fillH: 140, fillS: 70, fillL: 14 }
];
let total_invites_per_page = invite_columns * invite_rows;
let pWidth = InviteScreen.actualWidthPercentage / invite_columns;
let pHeight = InviteScreen.actualHeightPercentage / invite_rows;
let actual_height = pHeight * InviteScreen.height / 100;
let actual_width  = pWidth  * InviteScreen.width  / 100;
let UIScale = InviteScreen.height / InviteScreen.width;
let textHeight = 7;
let playerTextHeight = pHeight * textHeight / 10;

let makeCenterPanel = function(titleText, titleColor, bodyText, bodyColor, borderColor) {
    return [
        { type: 'box', position: [0, 0, 100, 100], fill: C.bg_deep, stroke: borderColor || C.border_hi, width: 5 },
        { type: 'box', position: [0, 0, 100, 38], fill: C.bg_header },
        { type: 'box', position: [0, 0, 100, 2], fill: borderColor || C.accent },
        { type: 'round', position: [-9, -9, 18, 18], fill: borderColor || C.accent },
        { type: 'round', position: [91, -9, 18, 18], fill: borderColor || C.accent },
        { type: 'round', position: [91, 91, 18, 18], fill: borderColor || C.accent },
        { type: 'round', position: [-9, 91, 18, 18], fill: borderColor || C.accent },
        { type: "text", position: [0, 8, 100, 26], value: titleText, color: titleColor, align: "center", size: 7, bold: true },
        { type: "text", position: [0, 50, 100, 36], value: bodyText, color: bodyColor || C.text_hi, align: "center", size: 5 }
    ];
};

let check = function(game, forced, isGameOver) {
    modUtils.tick();

    // ---- Enforce freeze for frozen players ----
    for (let id of sessionMemory.frozenPlayers) {
        let ship = shipByID(id);
        if (ship && ship.alive) {
            ship.set({ vx: 0, vy: 0 });
        }
    }
    enforceAnnouncementPause();

    // Low-lag alien maintenance: boundary and surplus checks run on a small interval.
    trainingAlienBoundaryTimer++;
    if (trainingAlienBoundaryTimer >= adminRuntime.trainingBoundaryInterval) {
        trainingAlienBoundaryTimer = 0;
        enforceTrainingAlienBoundary();
    }

    // ---- Training alien spawner - gradual spawn to avoid ping spikes ----
    trainingAlienSpawnTimer++;
    if (trainingAlienSpawnTimer >= adminRuntime.trainingSpawnInterval) {
        trainingAlienSpawnTimer = 0;
        spawnTrainingAliens();
    }

    for (let ship of game.ships) {
        if (ship.custom.joined && isSessionBanned(ship)) {
            kickPlayer(ship, "You have been banned", `Kicking ${ship.name} (You have been banned)`, true);
            continue;
        }
        if (ship.custom.joined && isQueuedForKick(ship)) {
            enforceRemovalLock(ship);
            continue;
        }
        if (ship.custom.joined && isForcedSpectator(ship) && !ship.custom.spectate) {
            applyForcedSpectatorState(ship, false);
        }

        if (!ship.custom.joined) {
            Radar.set(ship);
            sendUI(ship, { id: "block", visible: false });
            sendUI(ship, { id: "block2", clickable: true, shortcut: String.fromCharCode(187), position: [65, 0, 10, 10] });
            sendUI(ship, { id: "steam_exit_block", position: [0, 95, 20, 5], clickable: true });
            sendUI(ship, { id: "sprev", visible: false, clickable: true, shortcut: "7" });
            sendUI(ship, { id: "snext", visible: false, clickable: true, shortcut: "8" });
            sendUI(ship, { id: "nprev", visible: false, clickable: true, shortcut: "9" });
            sendUI(ship, { id: "nnext", visible: false, clickable: true, shortcut: "0" });
            ship.custom.streak = 0;
            ship.custom.maxStreak = 0;
            ship.custom.duelBannerShown = false;
            clearInds(ship);
            introductory_paragraph.forEach((sentence, i) =>
                modUtils.setTimeout(() => ship.instructorSays(sentence, "Zoltar"), i * instructor_duration * 60)
            );
            showTimedMessage(ship, "S2F DUELING MODE", C.accent_glow, welcome_message_duration);
            modUtils.setTimeout(() => {
                ship.hideInstructor();
                ship.custom.instructorHidden = true;
            }, introductory_paragraph.length * instructor_duration * 60);
            ship.custom = {
                ship: ship, TpTimestamp: -1, pendingTp: -1, shipped: false, joined: true, isLastLost: false, arena: ArenaManager.lobby,
                isReady: function() { return (this.ready || this.paired) && !this.spectate && this.ship.alive && this.arena.lobby && !this.inTraining; },
                inMatch: function() { return (!this.arena.lobby && !this.inTraining && (this.arena.inMatch || this.arena.inCountdown)); },
                ships_page: 0, inviters: new Map(), inviting: new Map(), invite_timeout: new Map(),
                streak: 0, maxStreak: 0, duelBannerShown: false,
                duelHistory: [],
                historyMode: "global",
                history_shown: false,
                adminKickPending: false,
                adminAnnouncementToken: 0,
                gameoverQueued: false,
                kickReason: "",
                inTraining: false,
                rematchOffer: null,
                adminShipActive: false,
            };
            game.custom.maxID = Math.max(game.custom.maxID, ship.id) || 0;
            updatePlayerDropdown();
            updatePanelStats();
            if (isGameOver) gameover(ship);
        } else if (isGameOver && !ship.custom.exited) gameover(ship, true);
    }

    if (game.step % 30 === 0 || forced) {
        for (let ship of game.ships) {
            let t = ship.custom.arena, tp = ship.custom.TpTimestamp, ptp = ship.custom.pendingTp;
            if (!(t instanceof Arena)) t = ArenaManager.lobby;
            if (typeof tp != "number") { tp = -1; t = ArenaManager.lobby; }
            if (typeof ptp != "number") ptp = -1;

            // Training arena: special handling
            if (ship.custom.inTraining) {
                let trainingArena = ArenaManager.list.find(a => a.isTrainingArena);
                if (trainingArena) {
                    ship.set({ invulnerable: 0, collider: true });
                    showTrainingBanner(ship);
                    ship.emptyWeapons();
                    setPicker(ship, true);
                }
                ship.custom.TpTimestamp = tp;
                ship.custom.pendingTp = ptp;
                warn(ship);
                renderCornerTimer(ship);
                continue;
            }

            let grad = t.radius, distance = t.distTo(ship) - (t.lobby ? r : grad), text = "OUT OF SAFE ZONE!";
            if (!isGameplayPaused() && distance > 0 && (tp == -1 || t.lobby) && ptp == -1 && !ship.custom.spectate) {
                if (t.lobby) ArenaManager.set(ship, lobby, true);
                else { setPicker(ship, false); addWarn(ship, text, true); if (game.step % 60 === 0) rekt(ship, edge_dps + dps_increase * (distance / 10)); }
            } else {
                removeWarn(ship, text, true);
                if (t.lobby || ship.custom.spectate) { setPicker(ship, true); ship.set({ invulnerable: 600, idle: false }); max(ship); }
                else setPicker(ship, false);
            }
            let isSpectate = !!ship.custom.spectate;
            if (!isSpectate) { if (!t.lobby) isSpectate = false; else isSpectate = t.distTo(ship) > r; }
            ship.set({ collider: !isSpectate });
            ship.emptyWeapons();
            ship.custom.arena = t;
            waitnextround(ship);

            let tw = (Array.isArray(ship.custom.warn) ? ship.custom.warn : []).filter(Array.isArray).slice(-max_warns_per_chunk);
            let i = 0;
            while (i < tw.length) {
                let wt = tw[i];
                if (typeof wt[1] == "number" && wt[1] !== -1 && game.step - wt[1] > messageHoist * 60) tw.splice(i, 1);
                else i++;
            }
            ship.custom.warn = tw;
            warn(ship);

            if (game.step - ptp > pendingTpDelay * 60 && ptp !== -1) { ptp = -1; tp = game.step; }
            if (game.step - tp > TpDelay * 60 && tp !== -1) tp = -1;
            ship.custom.TpTimestamp = tp;
            ship.custom.pendingTp   = ptp;

            let arenaStatus = ship.custom.arena, announceText = [];
            if (!ArenaManager.isRunning(game)) {
                announceText = ['GAME FINISHED!', '', ship.custom.endgameText || ""];
            } else if (arenaStatus.lobby) {
                if (!ship.custom.invite_shown && !ship.custom.history_shown) {
                    announceText = ["", [(""), ship.custom.isReady() ? 140 : 0]];
                    let header = [""], nearest = ArenaManager.findNearest(ship);
                    if (ship.custom.spectate && nearest !== ArenaManager.lobby) {
                        header = ["SPECTATING ARENA " + nearest.index];
                        if (!nearest.isAvailable && nearest.members.length > 0) {
                            let duelers = nearest.members.map(s => s.name).join(" vs ");
                            if (nearest.inCountdown) header.push(`${duelers} - STARTING`);
                            else if (nearest.inMatch) header.push(`${duelers} - FIGHTING!`);
                        } else if (!nearest.isAvailable) {
                            if (nearest.inCountdown) header.push('DUEL STARTING');
                            else if (nearest.inMatch) header.push('DUEL IN PROGRESS');
                            else header.push('DUEL FINISHED');
                        } else header.push('NO ACTIVE DUELS');
                    } else header.push("");
                    announceText.unshift(...header);
                }
            } else if (arenaStatus.inCountdown) {
                announceText = [""];
                showDuelCountdown(arenaStatus);
            } else if (arenaStatus.inMatch) {
                announceText = [""];
                if (!ship.custom.fightMessageShown) {
                    ship.custom.fightMessageShown = true;
                    showTimedMessage(ship, "FIGHT!", C.red, fight_message_duration);
                    clearDuelCountdown(arenaStatus);
                }
            }
            announce.call(this, ship, ...announceText);

            let smallText = [];
            if (arenaStatus.lobby) { smallText = ["IN QUEUE: " + ArenaManager.waiting_count]; ship.custom.fightMessageShown = false; }
            else if (arenaStatus.inCountdown) smallText = ["PREPARING..."];
            else if (arenaStatus.inMatch) smallText = ["BATTLE!"];
            if (!ship.custom.arena.lobby) smallText.push("ARENA " + arenaStatus.index);
            setStats(ship, ...smallText);
            renderCornerTimer(ship);
        }
        updatescoreboard(game);
    }

    if (allow_full_cargo_pickup)
        for (let ship of game.ships) {
            if (ship.custom.inMatch()) {
                let maxgems = Math.pow(Math.trunc(ship.custom.type / 100), 2) * 20;
                if (ship.crystals == maxgems) ship.set({ crystals: maxgems - 1 });
            }
        }
};

let waitnextround = function(ship) {};

let initialization = function(game) {
    setBackgroundCard("infoCard", "https://raw.githubusercontent.com/ajodnadjknadkand/duel/refs/heads/main/mainpng.png", 0, -30, 42 * 1.5, 25 * 1.5);
    ArenaManager.list = grids.map((v, i) => new ArenaManager.Arena(v[0], v[1], i));
    ArenaManager.lobby = ArenaManager.list.find(arena => arena.lobby);

    // Verify training arena
    let trainingArenaCandidate = ArenaManager.list[TRAINING_ARENA_INDEX];
    if (!trainingArenaCandidate || trainingArenaCandidate.lobby) {
        let nonLobbyArenas = ArenaManager.list.filter(a => !a.lobby);
        trainingArenaCandidate = nonLobbyArenas[nonLobbyArenas.length - 1];
        TRAINING_ARENA_INDEX = trainingArenaCandidate.originalIndex;
    }

    Radar.update(game, true);
    this.tick = main_game;
    try { help(); } catch(e) {}
};

let main_game = function(game) {
    check(game);
    if (isGameplayPaused()) {
        enforceAnnouncementPause();
    } else if (ArenaManager.isRunning(game)) {
        ArenaManager.checkPlayers(game);
    } else {
        game.setOpen(false);
        check(game, true);
        updatescoreboard(game);
        game.ships.forEach(clearInds);
        let lastStand = false;
        leaderboard.forEach((i, j) => {
            let ship = game.findShip(i.id);
            if (ship != null) {
                let text = "";
                if (lastStand || Math.max(i.wins, i.losses, 0) == 0) lastStand = true;
                else {
                    let rank = ship.custom.rank;
                    if (!isNaN(rank)) {
                        text = "YOU ";
                        if (rank == 1) text += "WIN!";
                        else {
                            text += "RANKED " + rank;
                            let suffix = "th";
                            if (rank % 10 == 1 && rank % 100 != 11) suffix = "st";
                            else if (rank % 10 == 2 && rank % 100 != 12) suffix = "nd";
                            else if (rank % 10 == 3 && rank % 100 != 13) suffix = "rd";
                            text += suffix + "!";
                        }
                        if (i.maxStreak > 0) text += ` (BEST: ${i.maxStreak})`;
                    }
                }
                ship.custom.endgameText = text;
            }
        });
        this.tick = forceEndgame;
    }
};

let forceEndgame = function(game) { check(game, null, true); };

this.tick = initialization;

this.event = function(event, game) {
    let ship = event.ship, killer = event.killer;
    if (ship != null) switch (event.name) {
        case "ship_destroyed":
            if (ship.custom.inTraining) {
                break;
            }
            if (!ship.custom.arena.lobby && ship.custom.arena.started) {
                ship.custom.arena.endDuel(false, ship);
            } else resetShip(ship);
            break;

        case "ship_spawned":
            ship.custom.pendingTp = -1;
            ship.custom.adminKickPending = false;
            ship.custom.gameoverQueued = false;
            ship.custom.inTraining = false;
            ArenaManager.set(ship, lobby, true);
            updatePlayerDropdown();
            updatePanelStats();
            if (isForcedSpectator(ship)) modUtils.setTimeout(() => applyForcedSpectatorState(ship, false), 2);
            if (isQueuedForKick(ship) || isSessionBanned(ship)) {
                setTimeout(() => enforceRemovalLock(ship), 50);
                break;
            }
            break;

        case "ship_left":
            sessionMemory.forcedSpectators = removeFromArray(sessionMemory.forcedSpectators, ship.id);
            sessionMemory.kickQueue = removeFromArray(sessionMemory.kickQueue, ship.id);
            sessionMemory.bannedShipIds = removeFromArray(sessionMemory.bannedShipIds, ship.id);
            sessionMemory.frozenPlayers = removeFromArray(sessionMemory.frozenPlayers, ship.id);
            clearRematchOffersWithPlayer(ship.id, "Rematch cancelled: opponent left.");
            updatePlayerDropdown();
            updatePanelStats();
            break;

        case "ui_component_clicked":
            let id = event.id;
            if (id === "btn_rematch" || (id === "duel_center_message" && hasActiveRematchOffer(ship))) {
                voteRematch(ship);
                break;
            }
            if (id === "btn_admin_ship") {
                toggleAdminShip(ship);
                break;
            }
            if (ship.custom.arena.lobby || ship.custom.inTraining) {
                if (["block2", "steam_exit_block"].indexOf(id) == -1 && (!ship.custom.lastButtonClick || game.step - ship.custom.lastButtonClick > (buttonsDelay * 60))) {
                    ship.custom.lastButtonClick = game.step;
                    ship.custom.buttons_warned  = false;

                    if (id === "btn_training") {
                        if (ship.custom.inTraining) {
                            returnFromTraining(ship);
                        } else {
                            teleportToTraining(ship);
                        }
                        break;
                    }

                    if (ship.custom.inTraining) {
                        break;
                    }

                    if (isForcedSpectator(ship) && ["chooser", "btn_ready", "ready", "btn_spectate", "spectate", "btn_invite", "invite", "snext", "sprev", "spnext", "spprev"].includes(id)) {
                        applyForcedSpectatorState(ship, false);
                        addWarn(ship, "Moderator locked you in spectator mode.");
                        break;
                    }
                    switch (id) {
                        case "chooser":
                            if (!ship.custom.spectate) {
                                ship.custom.shipped = !ship.custom.shipped;
                                if (ship.custom.shipped) { ship.custom.invite_shown = false; ship.custom.history_shown = false; }
                            } else addWarn(ship, "Can't change ships while spectating!");
                            break;

                        case "btn_ready": case "ready":
                            if (ship.custom.spectate) { addWarn(ship, "Can't ready while spectating!"); ship.custom.ready = false; }
                            else {
                                ship.custom.ready = !ship.custom.ready;
                                ship.custom.spectate = false;
                                max(ship, ship.custom.prevShipCode || ship.custom.type || ship.type);
                            }
                            ship.custom.invite_shown  = false;
                            ship.custom.history_shown = false;
                            break;

                        case "btn_spectate": case "spectate":
                            if (ship.custom.isReady()) { addWarn(ship, "Can't spectate while ready!"); ship.custom.spectate = false; }
                            else {
                                ship.custom.ready = false; ship.custom.mapped = false; ship.custom.shipped = false;
                                ship.custom.invite_shown = false; ship.custom.history_shown = false;
                                ship.custom.spectate = !ship.custom.spectate;
                                if (ship.custom.spectate) ship.custom.prevShipCode = ship.custom.type || ship.type;
                                max(ship, ship.custom.prevShipCode || ship.custom.type || ship.type);
                            }
                            break;

                        case "map":
                            if (!ship.custom.isReady() && ship.custom.spectate) ship.custom.mapped = !ship.custom.mapped;
                            ship.custom.shipped = false;
                            break;

                        case "btn_invite": case "invite":
                            if (ship.custom.isReady()) { addWarn(ship, "Can't invite while ready!"); ship.custom.invite_shown = false; }
                            else {
                                ship.custom.invite_shown  = !ship.custom.invite_shown;
                                if (ship.custom.invite_shown) { ship.custom.shipped = false; ship.custom.history_shown = false; }
                            }
                            break;

                        case "btn_history":
                            ship.custom.history_shown = !ship.custom.history_shown;
                            if (ship.custom.history_shown) { ship.custom.shipped = false; ship.custom.invite_shown = false; }
                            break;

                        case "hist_global":
                            ship.custom.historyMode = "global";
                            ship.custom.history_shown = true;
                            ship.custom.shipped = false;
                            ship.custom.invite_shown = false;
                            break;

                        case "hist_personal":
                            ship.custom.historyMode = "player";
                            ship.custom.history_shown = true;
                            ship.custom.shipped = false;
                            ship.custom.invite_shown = false;
                            break;

                        case "snext":
                            if (ship.custom.shipped && !ship.custom.spectate) {
                                let ship_info = getShipsPage(ship).list;
                                max(ship, (ship_info[ship_info.findIndex(t => t.code === ship.custom.type) + 1] || ship_info[0]).code);
                            } break;
                        case "sprev":
                            if (ship.custom.shipped && !ship.custom.spectate) {
                                let ship_info = getShipsPage(ship).list;
                                max(ship, (ship_info[ship_info.findIndex(t => t.code === ship.custom.type) - 1] || ship_info[ship_info.length - 1]).code);
                            } break;
                        case "invnext": if (!ship.custom.isReady() && !ship.custom.spectate && ship.custom.invite_shown) ++ship.custom.invite_page; break;
                        case "invprev": if (!ship.custom.isReady() && !ship.custom.spectate && ship.custom.invite_shown) --ship.custom.invite_page; break;
                        case "spnext":
                            if (ship.custom.shipped && !ship.custom.spectate) {
                                let page = ++ship.custom.ships_page;
                                if (page >= ship_infos.length) page = 0;
                                ship.custom.ships_page = page;
                            } break;
                        case "spprev":
                            if (ship.custom.shipped && !ship.custom.spectate) {
                                let page = --ship.custom.ships_page;
                                if (page < 0) page = ship_infos.length - 1;
                                ship.custom.ships_page = page;
                            } break;
                        case "nprev":
                            if (ship.custom.mapped && ship.custom.spectate && !ship.custom.isReady()) {
                                let node = ArenaManager.findNearest(ship).originalIndex;
                                ArenaManager.set(ship, (node > 0 ? node : ArenaManager.list.length) - 1, true);
                            } break;
                        case "nnext":
                            if (ship.custom.mapped && ship.custom.spectate && !ship.custom.isReady()) {
                                let node = ArenaManager.findNearest(ship).originalIndex;
                                ArenaManager.set(ship, (node < (ArenaManager.list.length - 1) ? node : -1) + 1, true);
                            } break;

                        default:
                            if (isForcedSpectator(ship) && (id.match(/^s\d+$/) || id.match(/^invite\d+$/) || id.match(/^accept\d+$/) || id.match(/^decline\d+$/))) {
                                applyForcedSpectatorState(ship, false);
                                addWarn(ship, "Moderator locked you in spectator mode.");
                                break;
                            }
                            if (id.match(/^n\d+$/) && ship.custom.spectate && !ship.custom.isReady() && ship.custom.mapped) {
                                ArenaManager.set(ship, +id.slice(1), true);
                            }
                            else if (id.match(/^s\d+$/) && !ship.custom.spectate && ship.custom.shipped) {
                                let shipCode = +id.slice(1), page = getShipsPage(ship).list;
                                max(ship, (page[shipCode] || page[0]).code);
                            }
                            else if (id.match(/^invite\d+$/) && !ship.custom.isReady()) {
                                let Iship = game.findShip(+id.match(/\d+/)[0]);
                                if (!Iship || Iship === ship) addWarn(ship, "Player not found!");
                                else if (!canInviteTarget(ship, Iship) || ship.custom.inMatch()) addWarn(ship, "Player not available.");
                                else {
                                    let invite_waiting = Math.ceil((InvitationTimeOut * 60 - (game.step - (ship.custom.invite_timeout.get(Iship.id) || 0))) / 60);
                                    if (invite_waiting > 0) addWarn(ship, `Wait ${invite_waiting}s before inviting ${Iship.name}`);
                                    else if (!ship.custom.inviters.get(Iship.id)) {
                                        ship.custom.ready = false;
                                        Iship.custom.ready = false;
                                        Iship.custom.inviters.set(ship.id, game.step);
                                        ship.custom.inviting.set(Iship.id, game.step);
                                        Iship.custom.invite_timeout.delete(ship.id);
                                        ship.custom.invite_timeout.delete(Iship.id);
                                        sendUI(ship, {
                                            id: "duel_center_message", position: [29, 39, 42, 14], visible: true, clickable: false,
                                            components: makeCenterPanel("INVITATION SENT", C.accent_glow, `To: ${Iship.name}`, C.text_mid, C.accent)
                                        });
                                        modUtils.setTimeout(() => sendUI(ship, { id: "duel_center_message", visible: false }), 180);
                                    }
                                }
                            }
                            else if (id.match(/^accept\d+$/) && !ship.custom.isReady()) {
                                let Iship = game.findShip(+id.match(/\d+/)[0]);
                                if (!Iship || Iship === ship) addWarn(ship, "Player not found!");
                                else if (!canInviteTarget(ship, Iship) || ship.custom.inMatch()) addWarn(ship, "Player not available.");
                                else if (ship.custom.inviters.get(Iship.id)) {
                                    ship.custom.ready = false;
                                    Iship.custom.ready = false;
                                    Iship.custom.paired = ship.id;
                                    ship.custom.paired  = Iship.id;
                                    ArenaManager.invites.push([ship, Iship]);
                                    modUtils.setTimeout(() => {
                                        sendUI(ship,  { id: "duel_center_message", visible: false });
                                        sendUI(Iship, { id: "duel_center_message", visible: false });
                                    }, 180);
                                    addWarn(Iship, `${ship.name} accepted your invite!`);
                                }
                            }
                            else if (id.match(/^decline\d+$/) && !ship.custom.isReady()) {
                                let Iship = game.findShip(+id.match(/\d+/)[0]);
                                if (!Iship || Iship === ship) addWarn(ship, "Player not found!");
                                else {
                                    let isInviter  = !!ship.custom.inviters.get(Iship.id);
                                    let isInviting = !!ship.custom.inviting.get(Iship.id);
                                    if (isInviter) {
                                        ship.custom.inviters.delete(Iship.id);
                                        Iship.custom.inviting.delete(ship.id);
                                        Iship.custom.invite_timeout.set(ship.id, game.step);
                                        ship.custom.invite_timeout.delete(Iship.id);
                                        sendUI(ship, {
                                            id: "duel_center_message", position: [29, 39, 42, 14], visible: true, clickable: false,
                                            components: makeCenterPanel("DUEL DECLINED", C.red, `From: ${Iship.name}`, C.text_hi, C.red)
                                        });
                                        sendUI(Iship, {
                                            id: "duel_center_message", position: [29, 39, 42, 14], visible: true, clickable: false,
                                            components: makeCenterPanel("INVITATION DECLINED", C.red, `By: ${ship.name}`, C.text_hi, C.red)
                                        });
                                        modUtils.setTimeout(() => {
                                            sendUI(ship,  { id: "duel_center_message", visible: false });
                                            sendUI(Iship, { id: "duel_center_message", visible: false });
                                        }, 180);
                                        addWarn(ship,  `Declined invite from ${Iship.name}`);
                                        addWarn(Iship, `${ship.name} declined your invite!`);
                                    } else if (isInviting) {
                                        ship.custom.inviting.delete(Iship.id);
                                        ship.custom.invite_timeout.set(Iship.id, game.step);
                                        Iship.custom.inviters.delete(ship.id);
                                        addWarn(ship,  `Removed invitation to ${Iship.name}`);
                                        addWarn(Iship, `${ship.name} withdrew invite`);
                                    }
                                    let foundIndex;
                                    if ((isInviter || isInviting) && (foundIndex = ArenaManager.invites.findIndex(pairs => pairs.indexOf(ship) != -1)) != -1) {
                                        let [p1, p2] = ArenaManager.invites.splice(foundIndex, 1)[0];
                                        p1.custom.paired = null;
                                        p2.custom.paired = null;
                                        p1.custom.invite_timeout.set(p2.id, game.step);
                                        p2.custom.invite_timeout.set(p1.id, game.step);
                                    }
                                }
                            }
                            break;
                    }
                } else if (!ship.custom.buttons_warned) {
                    ship.custom.buttons_warned = true;
                    addWarn(ship, "Clicking too fast! Slow down.");
                }
            }
            break;
        default: break;
    }
};


