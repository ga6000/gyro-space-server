const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

const server = new WebSocket.Server({
    port: PORT
});

console.log(`WebSocket server running on port ${PORT}`);


// ===================================================
//   MULTI-GAME ROOM SERVER
// ===================================================
// Originally written for Gyro Space alone; now backs every multiplayer
// game in My-Games plus the hub's own presence/voting panel. The repo
// name is a leftover -- don't rename the Render service, its URL is
// hardcoded in the deployed hub and in space-tracer.html.
//
// Rooms are keyed by GAME + CODE, not code alone, so room "ASDF" in
// Zombie and room "ASDF" in boids are different rooms. Clients that
// send no "game" field land in the legacy namespace, which is what the
// currently-deployed hub and space-tracer.html do -- they keep sharing
// one namespace exactly as before, so nothing live breaks.
const LEGACY_GAME = "_legacy";
const DEFAULT_ROOM = "public";

// The hub gets its own namespace instead of riding the legacy one.
// It used to send no "game" field, which put it in "_legacy" -- the
// same namespace space-tracer.html still uses. That was harmless while
// the hub only showed a roster, but the lobby's ready-check requires
// EVERY player in the room to click Continue, and a friend already
// flying around in Space Tracer can't click anything on the hub. They
// would have deadlocked every launch. Separate namespace, so the
// ready-check population is exactly "people looking at the hub."
const HUB_GAME = "_hub";

// rooms: Map<roomKey, {
//   game, code, seed, hostId,
//   players: Map<playerId, {socket, player}>,
//   votes:   Map<voterName, gameId>
// }>
const rooms = new Map();

function roomKeyFor(game, code) {
    return `${game}:${code}`;
}


// ===================================================
//   IDENTITY (server-authoritative)
// ===================================================
// CLAUDE.md's hard constraint says color/identity is server-side and
// name-hash based so it survives reconnects and matches across screens.
// Until now that was aspirational -- the hash actually lived in two
// client files (index.html and space-tracer.html) and the server just
// trusted whatever color it was handed. It's computed here now.
//
// The palette and hash below are byte-for-byte the same djb2-style
// scheme those clients already use, so this produces the SAME color
// they were computing themselves. Existing deployed clients therefore
// see no change in behavior -- they just stop being the source of truth.
const COLOR_PALETTE = [
    "hsl(0, 85%, 60%)", "hsl(30, 90%, 55%)", "hsl(50, 95%, 55%)",
    "hsl(120, 70%, 45%)", "hsl(180, 75%, 45%)", "hsl(210, 85%, 55%)",
    "hsl(260, 75%, 60%)", "hsl(300, 70%, 55%)", "hsl(330, 80%, 55%)",
    "hsl(45, 100%, 60%)"
];

function hashStringToIndex(str, modulo) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % modulo;
}

function getColorFromName(name) {
    const key = (name && name.trim()) || "Anonymous";
    return COLOR_PALETTE[hashStringToIndex(key, COLOR_PALETTE.length)];
}


function getOrCreateRoom(game, code) {
    const key = roomKeyFor(game, code);

    if (!rooms.has(key)) {
        rooms.set(key, {
            game: game,
            code: code,
            // One seed per room, fixed for the room's lifetime. Every
            // client generates its world from this, which is the whole
            // reason players see the SAME level instead of each
            // generating their own from an unseeded Math.random().
            // Regenerates when an empty room is recreated -- a fresh
            // room is a fresh match, which is the behavior we want.
            seed: (Math.random() * 0x7fffffff) | 0,
            hostId: null,
            players: new Map(),
            votes: new Map(),

            // Hub lobby state. Only the hub ("_hub" namespace) ever
            // touches this; games have their own start flow and never
            // send ready-update. Kept on the room rather than in a
            // separate map so it dies with the room automatically.
            //   leader    -- gameId with strictly the most votes, or null
            //   ready     -- voterNames who have clicked Continue FOR that leader
            //   timer     -- in-flight launch countdown, null when not launching
            lobby: {
                leader: null,
                ready: new Set(),
                timer: null
            }
        });
        console.log(`Room created: ${key}`);
    }

    return rooms.get(key);
}

function deleteRoomIfEmpty(key) {
    const room = rooms.get(key);
    if (room && room.players.size === 0) {
        // Kill any pending launch countdown with the room. Otherwise a
        // room recreated under the same key within the countdown window
        // would have the previous room's timer wipe its ready state.
        if (room.lobby && room.lobby.timer) clearTimeout(room.lobby.timer);

        rooms.delete(key);
        console.log(`Room closed (empty): ${key}`);
    }
}


// Exactly one client per room is the host. Games use this to decide who
// simulates shared world state (zombie AI, a boid flock, the RD field)
// without needing a truly authoritative server. First to join wins; if
// they leave, the next player in insertion order takes over.
function assignHostIfNeeded(room, key) {
    if (room.hostId && room.players.has(room.hostId)) return false;

    const next = room.players.keys().next();
    room.hostId = next.done ? null : next.value;

    if (room.hostId) {
        console.log(`Host for ${key} is now ${room.hostId}`);
    }
    return true;
}


// ===================================================
//   HUB LOBBY: LEADER, READY-CHECK, LAUNCH COUNTDOWN
// ===================================================
// Only the hub (the "_hub" namespace) uses any of this -- games have
// their own start flow and never send "ready-update". It lives here
// rather than in the hub client for one reason: a player who opens the
// hub after everyone else has already voted and readied needs to be
// told the current state, and only the server can tell them. The same
// argument that made the vote snapshot server-side applies unchanged.
//
// The countdown is broadcast as a DURATION, not a wall-clock deadline.
// Friends' machines don't agree on the current time, so an absolute
// timestamp would drift by whatever their clocks differ by; a duration
// only drifts by one network hop.
const LAUNCH_DELAY_MS = 3000;

// Votes are already keyed by name (see the vote-update handler), so
// ready is too -- otherwise a player who reconnects mid-lobby would be
// counted as a second, permanently-un-ready person and deadlock the
// launch. Two players choosing the same name collide; that's
// pre-existing in votes and fine for a 3-10 person friend group.
function playerKey(p) {
    return p.name || p.id;
}

function roomPlayerKeys(room) {
    const keys = new Set();
    for (const entry of room.players.values()) {
        keys.add(playerKey(entry.player));
    }
    return keys;
}

// Strict plurality: the one gameId with MORE votes than any other.
// A tie returns null, which is what makes the hub's Continue button
// disappear rather than picking an arbitrary winner for the group.
// Computed here and only here so no two clients can disagree about
// whether a given vote spread is a tie.
function computeLeader(room) {
    const tally = new Map();

    for (const gameId of room.votes.values()) {
        tally.set(gameId, (tally.get(gameId) || 0) + 1);
    }

    let leader = null;
    let best = 0;
    let tied = false;

    for (const [gameId, count] of tally) {
        if (count > best) {
            leader = gameId;
            best = count;
            tied = false;
        } else if (count === best) {
            tied = true;
        }
    }

    return tied ? null : leader;
}

function lobbyMessage(room) {
    return {
        type: "lobby",
        leaderGameId: room.lobby.leader,
        ready: Array.from(room.lobby.ready),
        launching: room.lobby.timer !== null
    };
}

function cancelLaunch(roomKey, reason) {
    const room = rooms.get(roomKey);
    if (!room || !room.lobby.timer) return; // Not counting down -- nothing to cancel, and broadcasting a cancel nobody asked for would flicker the button

    clearTimeout(room.lobby.timer);
    room.lobby.timer = null;

    console.log(`Launch cancelled in ${roomKey}: ${reason}`);

    broadcastToRoom(roomKey, {
        type: "launch-cancel",
        reason: reason
    });
}

// Starts the countdown once EVERY player currently in the room is
// ready. Deliberately strict: nobody gets left behind on the hub while
// their friends load into a game.
function evaluateLaunch(roomKey) {
    const room = rooms.get(roomKey);
    if (!room) return;

    if (!room.lobby.leader) return;
    if (room.lobby.timer) return;      // Already counting down
    if (room.players.size === 0) return;

    for (const name of roomPlayerKeys(room)) {
        if (!room.lobby.ready.has(name)) return;
    }

    room.lobby.timer = setTimeout(() => {
        const current = rooms.get(roomKey);
        if (!current) return;

        current.lobby.timer = null;

        // Everyone has navigated into the game by now. Clearing means a
        // player who bounces straight back to the hub doesn't walk into
        // a stale all-ready state that immediately fires again.
        current.lobby.ready.clear();
    }, LAUNCH_DELAY_MS);

    console.log(`Launching ${room.lobby.leader} in ${roomKey} (${room.players.size} players)`);

    broadcastToRoom(roomKey, {
        type: "launch",
        gameId: room.lobby.leader,
        delayMs: LAUNCH_DELAY_MS
    });
}

// ===================================================
//   CROSS-GAME PRESENCE
// ===================================================
// Rooms are namespaced by game, so the hub's room ("_hub:ASDF") can't
// see the people in "zombie:ASDF" -- which is correct for the
// ready-check (someone mid-game can't click Continue, and counting them
// would deadlock every launch) but wrong for the roster, where "who's
// around" should include the friend who wandered into Zombie.
//
// So: presence is computed ACROSS namespaces for one room code and sent
// to the hub only. It is deliberately separate from the "players"
// roster the hub already tracks -- these people are visible, not
// countable.
function presenceFor(code) {
    const list = [];

    for (const room of rooms.values()) {
        if (room.code !== code) continue;
        if (room.game === HUB_GAME) continue;   // Already in the hub's own roster

        for (const entry of room.players.values()) {
            list.push({
                name: entry.player.name || entry.player.id,
                color: entry.player.color,
                game: room.game
            });
        }
    }

    return list;
}

function broadcastPresence(code) {
    const hubKey = roomKeyFor(HUB_GAME, code);
    if (!rooms.has(hubKey)) return;   // Nobody on the hub for this code -- nothing to tell

    broadcastToRoom(hubKey, {
        type: "presence",
        players: presenceFor(code)
    });
}


// Single funnel for everything that can change the lobby: a vote, a
// ready click, a join, a leave. Recomputes the leader, discards ready
// state that no longer applies, broadcasts, then re-checks the launch
// condition. Every caller goes through here so there is exactly one
// place that decides what the lobby looks like.
function refreshLobby(roomKey) {
    const room = rooms.get(roomKey);
    if (!room) return;

    // Game rooms never see any of this. Keeps their traffic byte-for-
    // byte what it is today, so none of the working multiplayer games
    // are touched by a hub-only feature.
    if (room.game !== HUB_GAME) return;

    const nextLeader = computeLeader(room);

    if (nextLeader !== room.lobby.leader) {
        // A ready click means "I'm ready to play THIS game" -- if the
        // group's choice moved, that consent doesn't carry over.
        room.lobby.leader = nextLeader;
        room.lobby.ready.clear();
        cancelLaunch(roomKey, "selection changed");
    }

    // Drop ready entries from players who have left, so their dot
    // doesn't sit on the Continue button after they're gone.
    const present = roomPlayerKeys(room);
    for (const name of room.lobby.ready) {
        if (!present.has(name)) room.lobby.ready.delete(name);
    }

    broadcastToRoom(roomKey, lobbyMessage(room));
    evaluateLaunch(roomKey);
}


// When a player connects
server.on("connection", socket => {

    const id = Math.random()
        .toString(36)
        .substring(2, 10);

    // Not in a room yet. Every other message type is ignored until
    // "join-room" arrives — this is what makes the room boundary real
    // instead of advisory.
    let roomKey = null;

    const player = {
        id: id,
        x: 0,
        y: 0,
        angle: 0,
        name: "",
        color: null
    };

    console.log(`Player connected: ${id}`);

    // Tell the new player their ID right away. They still need to
    // join-room before they show up to anyone or receive updates.
    socket.send(JSON.stringify({
        type: "welcome",
        id: id
    }));


    socket.on("message", message => {

        try {

            const data = JSON.parse(message);


            if (data.type === "join-room") {

                // Room code is caller-supplied (e.g. a 4-char code the
                // player typed or generated). Falls back to the shared
                // public room if omitted, so old clients still work.
                const code = (data.room && String(data.room).trim()) || DEFAULT_ROOM;

                // No "game" field means a pre-multi-game client (the
                // currently-deployed hub and space-tracer.html). They
                // all share the legacy namespace, preserving exactly
                // the behavior they have today.
                const game = (data.game && String(data.game).trim()) || LEGACY_GAME;

                roomKey = roomKeyFor(game, code);

                player.name = (data.name && String(data.name).slice(0, 20)) || "";

                // Server-authoritative, per the hard constraint. Only
                // falls back to a client-supplied color for an unnamed
                // player, where there's no name to hash.
                player.color = player.name
                    ? getColorFromName(player.name)
                    : (data.color || getColorFromName(""));

                const room = getOrCreateRoom(game, code);
                room.players.set(id, { socket, player });
                assignHostIfNeeded(room, roomKey);

                console.log(`Player ${id} (${player.name || "unnamed"}) joined room: ${roomKey}`);

                // Send the new player everyone already in the room
                // (excluding themselves), plus the room-scoped facts
                // they need before they can simulate anything: the
                // world seed and who the host is.
                socket.send(JSON.stringify({
                    type: "players",
                    room: code,
                    game: game,
                    seed: room.seed,
                    hostId: room.hostId,
                    you: player,
                    players: Array.from(room.players.values())
                        .filter(p => p.player.id !== id)
                        .map(p => p.player)
                }));

                // Vote snapshot -- votes cast before this player
                // arrived. Without this a newly-joined player sees an
                // empty ballot until someone happens to change a vote.
                socket.send(JSON.stringify({
                    type: "votes",
                    votes: Array.from(room.votes.entries()).map(([voterName, gameId]) => ({
                        voterName,
                        gameId
                    }))
                }));

                // Tell everyone else in the room a new player joined
                broadcastToRoom(roomKey, {
                    type: "join",
                    player: player
                }, socket);

                // Host may have just been assigned (first player in).
                // Broadcast so every client agrees on who it is.
                broadcastToRoom(roomKey, {
                    type: "host",
                    hostId: room.hostId
                });

                // Somebody arriving mid-countdown cancels it -- they
                // haven't agreed to anything yet, and launching out from
                // under a friend who just walked in is exactly the
                // behaviour the strict rule exists to prevent. The
                // refresh that follows also gives the new player their
                // lobby snapshot, which is the reason this state lives
                // on the server at all.
                cancelLaunch(roomKey, "a player joined");
                refreshLobby(roomKey);

                // Every join anywhere changes the cross-game picture for
                // whoever is on the hub -- and since the joiner is
                // already in the room by this point, this doubles as the
                // arrival snapshot for a hub client. No separate direct
                // send: that would deliver the same thing twice.
                broadcastPresence(code);

                return;
            }


            // Every message below this line requires an active room.
            if (!roomKey) return;

            const room = rooms.get(roomKey);
            if (!room) return;


            // ===================================================
            //   GENERIC RELAY  (new games use ONLY this)
            // ===================================================
            // Forwards an arbitrary payload to the rest of the room,
            // tagged with the sender. This is what keeps the server from
            // becoming a junk drawer of per-game message types: a new
            // game defines its own payload shape and needs no server
            // change at all. Zombie's zombie-state broadcasts, Glass
            // City's collectible claims, boids' flock sync -- all ride
            // this one message type.
            if (data.type === "relay") {

                broadcastToRoom(roomKey, {
                    type: "relay",
                    from: id,
                    name: player.name,
                    payload: data.payload
                }, data.echo ? null : socket); // echo:true when the sender also wants it back

                return;
            }


            // ===================================================
            //   HUB PRESENCE: VOTES + CURSORS
            // ===================================================
            // index.html has sent these two message types since the
            // group-play panel was added, but the server never handled
            // them -- so the vote checkmarks and live cursors have been
            // inert in production. Handled properly now.
            if (data.type === "vote-update") {

                const voterName = player.name || id;

                if (data.voted && data.gameId) {
                    // One active vote per person: setting a new one
                    // implicitly replaces any previous choice.
                    room.votes.set(voterName, data.gameId);
                } else {
                    // Un-vote, but only if this is still this voter's
                    // CURRENT choice -- guards against a stale in-flight
                    // clear wiping out a newer vote they just cast.
                    if (room.votes.get(voterName) === data.gameId) {
                        room.votes.delete(voterName);
                    }
                }

                // Broadcast to EVERYONE including the sender, so a
                // player's own checkmark is drawn from the same
                // server-confirmed state as everyone else's rather than
                // from optimistic local guessing.
                broadcastToRoom(roomKey, {
                    type: "vote-update",
                    voterName: voterName,
                    voterColor: player.color,
                    gameId: room.votes.get(voterName) || null
                });

                // A vote can move which game is winning, which retires
                // everyone's ready state and kills any countdown.
                refreshLobby(roomKey);

                return;
            }


            // Ready-check on the hub's Continue button. The gameId must
            // match what the server currently considers the winner --
            // otherwise a click that was in flight while the leader
            // changed would register as consent for a game the player
            // never actually saw on the button. Same stale-message
            // guard as the un-vote path above.
            if (data.type === "ready-update") {

                if (room.game !== HUB_GAME) return;

                const readyName = playerKey(player);

                if (data.ready) {
                    if (!room.lobby.leader || data.gameId !== room.lobby.leader) return;
                    room.lobby.ready.add(readyName);
                } else {
                    room.lobby.ready.delete(readyName);
                    cancelLaunch(roomKey, "a player is no longer ready");
                }

                refreshLobby(roomKey);

                return;
            }


            if (data.type === "cursor-update") {

                broadcastToRoom(roomKey, {
                    type: "cursor-update",
                    name: player.name,
                    color: player.color,
                    x: data.x,
                    y: data.y,
                    // What the sender is pointing AT, plus where inside
                    // it. Raw viewport percentages alone stopped being
                    // meaningful once the hub paginated its games --
                    // page 2 on their screen is page 1 on yours. The
                    // receiver resolves the anchor against its own
                    // layout and falls back to x/y when it can't.
                    anchor: data.anchor || null,
                    ax: data.ax,
                    ay: data.ay
                }, socket);

                return;
            }


            // ===================================================
            //   LEGACY GYRO SPACE MESSAGES
            // ===================================================
            // Kept as-is so the deployed space-tracer.html keeps working
            // untouched. New games should use "relay" instead of adding
            // anything here.
            if (data.type === "update") {

                const current = room.players.get(id);

                if (current) {

                    // Only broadcast if position/angle changed or shot fired
                    const positionChanged = current.player.x !== data.x ||
                                           current.player.y !== data.y ||
                                           current.player.angle !== data.angle;
                    const shotFired = data.shot;
                    const aliveStateChanged = current.player.isAlive !== data.isAlive;

                    if (!positionChanged && !shotFired && !aliveStateChanged) {
                        return; // Skip broadcast if nothing changed
                    }

                    current.player.x = data.x;
                    current.player.y = data.y;
                    current.player.angle = data.angle;
                    current.player.isAlive = data.isAlive;

                }


                broadcastToRoom(roomKey, {
                    type: "update",
                    player: {
                        id: id,
                        x: data.x,
                        y: data.y,
                        angle: data.angle,
                        shot: data.shot,
                        isAlive: data.isAlive
                    }
                }, socket);

                return;
            }


            if (data.type === "score-update") {

                // Live score sync during a session (kills, distance, time —
                // whatever the game defines). This is NOT persistence;
                // it's just so players see each other's live score.
                // Final scores get written to Firestore by the client
                // separately, once, at game-end.
                broadcastToRoom(roomKey, {
                    type: "score-update",
                    id: id,
                    name: player.name,
                    score: data.score,
                    detail: data.detail || null
                }, socket);

                return;
            }


            if (data.type === "kill-credit") {

                // Sent by the VICTIM's client the moment it detects it was
                // hit by another player's bullet (that detection only ever
                // happens locally, on the victim's own collision check --
                // the shooter's client has no way to know its bullet
                // connected). This message tells the server "player X
                // killed me," and the server relays it to player X only,
                // so X's client can credit its own multiplier/score.
                //
                // This is inherently victim-reported and therefore
                // trivially spoofable by a modified client claiming kills
                // that never happened. For a 3-10 person friend group
                // that's an acceptable tradeoff -- closing it properly
                // would mean the server itself simulating bullet
                // collisions, which is a much bigger architectural change
                // (server-authoritative physics) than this project needs
                // right now.
                const shooterEntry = room.players.get(data.shooterId);

                if (shooterEntry && shooterEntry.socket.readyState === WebSocket.OPEN) {
                    shooterEntry.socket.send(JSON.stringify({
                        type: "kill-credit",
                        victimId: id,
                        victimName: player.name,
                        killType: "player"
                    }));
                }
                // If the shooter has already disconnected or isn't in this
                // room (e.g. they left right as the shot landed), this
                // silently does nothing -- there's no one left to credit.

                return;
            }


        } catch (error) {

            console.error(
                "Invalid message:",
                error
            );

        }

    });



    // Player disconnects
    socket.on("close", () => {

        if (roomKey) {

            const room = rooms.get(roomKey);

            if (room) {
                room.players.delete(id);

                // Drop their vote too -- a checkmark from someone no
                // longer in the room reads as wrong either way.
                if (player.name) room.votes.delete(player.name);

                const hostChanged = assignHostIfNeeded(room, roomKey);

                console.log(`Player left: ${id} (room: ${roomKey})`);

                // NOTE: "name" here is load-bearing, not decorative --
                // index.html's leave handler removes the player from the
                // roster BY NAME and ignores the message without it. It
                // was missing until now, which is why departed players
                // lingered in the hub roster.
                broadcastToRoom(roomKey, {
                    type: "leave",
                    id: id,
                    name: player.name
                });

                if (hostChanged && room.players.size > 0) {
                    broadcastToRoom(roomKey, {
                        type: "host",
                        hostId: room.hostId
                    });
                }

                // A leave RE-EVALUATES rather than cancelling: if the
                // one person who hadn't clicked Continue closes their
                // tab, everyone still here should launch, not stall
                // waiting on someone who's gone.
                if (room.lobby) {
                    room.lobby.ready.delete(playerKey(player));
                    refreshLobby(roomKey);
                }

                deleteRoomIfEmpty(roomKey);

                // After the cleanup, so a room that just emptied isn't
                // still counted in the snapshot.
                broadcastPresence(room.code);
            }

        } else {
            console.log(`Player left before joining a room: ${id}`);
        }

    });


});



// Send message to everyone in a specific room
function broadcastToRoom(roomKey, message, exclude = null) {

    const room = rooms.get(roomKey);
    if (!room) return;

    const text = JSON.stringify(message);

    for (const client of room.players.values()) {

        if (
            client.socket !== exclude &&
            client.socket.readyState === WebSocket.OPEN
        ) {

            client.socket.send(text);

        }

    }

}
