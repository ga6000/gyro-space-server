const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

const server = new WebSocket.Server({
    port: PORT
});

console.log(`WebSocket server running on port ${PORT}`);


// Store connected players
const players = new Map();


// When a player connects
server.on("connection", socket => {

    const id = Math.random()
        .toString(36)
        .substring(2, 10);


    const player = {
        id: id,
        x: 0,
        y: 0,
        angle: 0
    };


    players.set(id, {
        socket,
        player
    });


    console.log(`Player connected: ${id}`);


    // Tell the new player their ID
    socket.send(JSON.stringify({
        type: "welcome",
        id: id
    }));


    // Send existing players to the new player (excluding themselves)
socket.send(JSON.stringify({
    type: "players",
    players: Array.from(players.values())
        .filter(p => p.player.id !== id)  // ✅ Exclude yourself
        .map(p => p.player)
}));

    // Tell everyone else a new player joined
    broadcast({
        type:"join",
        player:player
    }, socket);



    // Receive updates from player
    socket.on("message", message => {

        try {

            const data = JSON.parse(message);


            if(data.type === "update"){

                const current =
                    players.get(id);


                if(current){

                    current.player.x = data.x;
                    current.player.y = data.y;
                    current.player.angle = data.angle;

                }


                broadcast({
                    type:"update",
                    player:{
                        id:id,
                        x:data.x,
                        y:data.y,
                        angle:data.angle,
                        shot:data.shot  // ✅ ADD THIS LINE to broadcast shots
                    }
                }, socket);

            }


        } catch(error){

            console.error(
                "Invalid message:",
                error
            );

        }

    });



    // Player disconnects
    socket.on("close",()=>{

        players.delete(id);

        console.log(`Player left: ${id}`);


        broadcast({
            type:"leave",
            id:id
        });

    });


});



// Send message to all connected players
function broadcast(message, exclude=null){

    const text =
        JSON.stringify(message);


    for(const client of players.values()){

        if(
            client.socket !== exclude &&
            client.socket.readyState === WebSocket.OPEN
        ){

            client.socket.send(text);

        }

    }

}
