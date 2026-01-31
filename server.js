const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.static(path.join(__dirname, 'public')));

// Game State
const rooms = {};

// Helper to generate unique room code
function generateRoomCode() {
    const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 4; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    // Ensure uniqueness
    if (rooms[result]) return generateRoomCode();
    return result;
}

// Basic Maze Generator (Recursive Backtracker)
function generateMaze(width, height) {
    const maze = Array.from({ length: height }, () => Array(width).fill(1)); // 1 = Wall, 0 = Path
    const stack = [];
    const startX = 1;
    const startY = 1;

    maze[startY][startX] = 0;
    stack.push({ x: startX, y: startY });

    const directions = [
        { x: 0, y: -2 }, // Up
        { x: 0, y: 2 },  // Down
        { x: -2, y: 0 }, // Left
        { x: 2, y: 0 }   // Right
    ];

    while (stack.length > 0) {
        const current = stack[stack.length - 1];
        const validNeighbors = [];

        // Shuffle directions
        directions.sort(() => Math.random() - 0.5);

        for (const dir of directions) {
            const nx = current.x + dir.x;
            const ny = current.y + dir.y;

            if (nx > 0 && nx < width - 1 && ny > 0 && ny < height - 1 && maze[ny][nx] === 1) {
                validNeighbors.push({ nx, ny, dx: dir.x / 2, dy: dir.y / 2 });
            }
        }

        if (validNeighbors.length > 0) {
            const next = validNeighbors[0]; // Pick first randomized neighbor
            maze[next.ny][next.nx] = 0;
            maze[current.y + next.dy][current.x + next.dx] = 0;
            stack.push({ x: next.nx, y: next.ny });
        } else {
            stack.pop();
        }
    }

    // Ensure end point is reachable (bottom-right)
    maze[height - 2][width - 2] = 0;

    return maze;
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('createRoom', ({ playerName, maxPlayers, totalRounds }) => {
        const roomCode = generateRoomCode();

        rooms[roomCode] = {
            id: roomCode,
            players: [{
                id: socket.id,
                name: playerName,
                score: 0,
                color: '#FF4136' // Default P1 color
            }],
            maxPlayers: parseInt(maxPlayers),
            totalRounds: parseInt(totalRounds),
            currentRound: 1,
            status: 'waiting',
            maze: null
        };

        socket.join(roomCode);
        console.log(`Room created: ${roomCode} by ${playerName}`);
        socket.emit('roomCreated', { roomCode, isHost: true, room: rooms[roomCode] });
    });

    socket.on('joinRoom', ({ playerName, roomCode }) => {
        const room = rooms[roomCode];

        if (!room) {
            socket.emit('error', 'Room not found');
            return;
        }

        if (room.status !== 'waiting') {
            socket.emit('error', 'Game already in progress');
            return;
        }

        if (room.players.length >= room.maxPlayers) {
            socket.emit('error', 'Room is full');
            return;
        }

        const colors = ['#FF4136', '#2ECC40', '#0074D9', '#FFDC00', '#B10DC9', '#FF851B', '#39CCCC', '#F012BE', '#01FF70', '#AAAAAA'];
        const playerColor = colors[room.players.length % colors.length];

        const newPlayer = {
            id: socket.id,
            name: playerName,
            score: 0,
            color: playerColor
        };

        room.players.push(newPlayer);
        socket.join(roomCode);
        console.log(`Player ${playerName} joined room: ${roomCode}`);

        // Notify everyone in the room
        io.to(roomCode).emit('playerJoined', {
            players: room.players,
            roomCode: roomCode,
            maxPlayers: room.maxPlayers
        });

        console.log(`Player ${playerName} joined room: ${roomCode}. Total: ${room.players.length}/${room.maxPlayers}`);

        // Check Auto-Start Condition
        if (room.players.length === room.maxPlayers) {
            console.log(`Room ${roomCode} full, starting game...`);
            startRound(roomCode);
        }
    });

    socket.on('playerMove', ({ roomCode, position }) => {
        const room = rooms[roomCode];
        if (!room || room.status !== 'playing') return;

        // Update server-side player position for immediate consistency
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.x = position.x;
            player.y = position.y;
        }

        // Broadcast move to ALL other players in the room immediately
        socket.to(roomCode).emit('playerMoved', { id: socket.id, position });
    });

    socket.on('playerWon', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.status !== 'playing') return;

        const player = room.players.find(p => p.id === socket.id);
        if (player && !player.finished) {
            const finishTime = (Date.now() - room.startTime) / 1000;
            player.finished = true;
            player.lastFinishTime = finishTime;

            console.log(`Player ${player.name} finished in ${finishTime}s`);

            // Check if everyone has finished
            const allFinished = room.players.every(p => p.finished);

            if (allFinished) {
                room.status = 'round_over';

                // Sort by time to find the real winner of the round
                const roundWinner = [...room.players].sort((a, b) => a.lastFinishTime - b.lastFinishTime)[0];
                roundWinner.score += 1;

                const winsNeeded = Math.ceil(room.totalRounds / 2);
                const isGrandWinner = roundWinner.score >= winsNeeded || (room.currentRound === room.totalRounds);

                io.to(roomCode).emit('roundResult', {
                    winner: roundWinner,
                    players: room.players,
                    currentRound: room.currentRound,
                    totalRounds: room.totalRounds,
                    isGrandWinner: isGrandWinner
                });

                if (isGrandWinner) {
                    room.status = 'game_over';
                }
            } else {
                // Inform others that this player finished
                io.to(roomCode).emit('playerFinished', {
                    playerId: player.id,
                    finishTime: finishTime,
                    players: room.players
                });
            }
        }
    });

    socket.on('requestNextRound', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.status !== 'round_over') return;

        if (room.currentRound < room.totalRounds) {
            room.currentRound++;
            startRound(roomCode);
        }
    });

    socket.on('requestPlayAgain', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return;

        // Reset Room Stats
        room.currentRound = 1;
        room.players.forEach(p => p.score = 0);
        room.status = 'waiting';

        io.to(roomCode).emit('resetToLobby', { players: room.players });
    });

    socket.on('disconnect', () => {
        // Handle disconnect logic (remove player, delete room if empty, etc.)
        for (const code in rooms) {
            const room = rooms[code];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1);
                io.to(code).emit('playerLeft', { players: room.players });
                if (room.players.length === 0) {
                    delete rooms[code];
                }
                break;
            }
        }
    });
});

function startRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.status = 'playing';
    // Generate new maze for the round (21x21 is standard odd size for mazes)
    room.maze = generateMaze(21, 21);
    room.startTime = Date.now(); // Track start time for leaderboard

    // Reset players to start position
    room.players.forEach(p => {
        p.x = 1;
        p.y = 1;
        p.finished = false;
        p.finishTime = 0;
    });

    io.to(roomCode).emit('gameStart', {
        maze: room.maze,
        round: room.currentRound,
        players: room.players,
        startTime: room.startTime,
        roomCode: roomCode
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
