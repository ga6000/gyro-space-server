const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

const server = new WebSocket.Server({
    port: PORT
});

console.log(`WebSocket server running on port ${PORT}`);


// rooms: Map<roomCode, Map<playerId, { socket, player }>>
// A room is created the first time someone joins it, and deleted when empty.
const rooms = new Map();

// Global default room. Any client that never sends "join-room" ends up
// here — this preserves old behavior (everyone in one world) for any
// game file that hasn't been updated yet, so nothing breaks silently.
const DEFAULT_ROOM = "public";

function getOrCreateRoom(code) {
    if (!rooms.has(code)) {
        rooms.set(code, new Map());
        console.log(`Room created: ${code}`);
    }
    return rooms.get(code);
}

function deleteRoomIfEmpty(code) {
    const room = rooms.get(code);
    if (room && room.size === 0) {
        rooms.delete(code);
        console.log(`Room closed (empty): ${code}`);
    }
}


// When a player connects
server.on("connection", socket => {

    const id = Math.random()
        .toString(36)
        .substring(2, 10);

    // Not in a room yet. Every other message type is ignored until
    // "join-room" arrives — this is what makes the room boundary real
    // instead of advisory.
    let roomCode = null;

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
                roomCode = (data.room && String(data.room).trim()) || DEFAULT_ROOM;
                player.name = (data.name && String(data.name).slice(0, 20)) || "";
                if (data.color) player.color = data.color;

                const room = getOrCreateRoom(roomCode);
                room.set(id, { socket, player });

                console.log(`Player ${id} (${player.name || "unnamed"}) joined room: ${roomCode}`);

                // Send the new player everyone already in the room
                // (excluding themselves)
                socket.send(JSON.stringify({
                    type: "players",
                    room: roomCode,
                    players: Array.from(room.values())
                        .filter(p => p.player.id !== id)
                        .map(p => p.player)
                }));

                // Tell everyone else in the room a new player joined
                broadcastToRoom(roomCode, {
                    type: "join",
                    player: player
                }, socket);

                return;
            }


            // Every message below this line requires an active room.
            if (!roomCode) return;


            if (data.type === "update") {

                const room = rooms.get(roomCode);
                const current = room && room.get(id);

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


                broadcastToRoom(roomCode, {
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
                broadcastToRoom(roomCode, {
                    type: "score-update",
                    id: id,
                    name: player.name,
                    score: data.score,
                    detail: data.detail || null
                }, socket);

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

        if (roomCode) {

            const room = rooms.get(roomCode);
            if (room) {
                room.delete(id);
                deleteRoomIfEmpty(roomCode);
            }

            console.log(`Player left: ${id} (room: ${roomCode})`);

            broadcastToRoom(roomCode, {
                type: "leave",
                id: id
            });

        } else {
            console.log(`Player left before joining a room: ${id}`);
        }

    });


});



// Send message to everyone in a specific room
function broadcastToRoom(roomCode, message, exclude = null) {

    const room = rooms.get(roomCode);
    if (!room) return;

    const text = JSON.stringify(message);

    for (const client of room.values()) {

        if (
            client.socket !== exclude &&
            client.socket.readyState === WebSocket.OPEN
        ) {

            client.socket.send(text);

        }

    }

}
