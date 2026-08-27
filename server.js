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
            votes: new Map()
        });
        console.log(`Room created: ${key}`);
    }

    return rooms.get(key);
}

function deleteRoomIfEmpty(key) {
    const room = rooms.get(key);
    if (room && room.players.size === 0) {
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

                return;
            }


            if (data.type === "cursor-update") {

                broadcastToRoom(roomKey, {
                    type: "cursor-update",
                    name: player.name,
                    color: player.color,
                    x: data.x,
                    y: data.y
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

                deleteRoomIfEmpty(roomKey);
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
