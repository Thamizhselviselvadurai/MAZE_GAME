const socket = io();

// UI Elements
const lobbyScreen = document.getElementById('lobby-screen');
const waitingScreen = document.getElementById('waiting-screen');
const gameScreen = document.getElementById('game-screen');
const boardsContainer = document.getElementById('game-boards-container');

// Forms & Inputs
const nameInput = document.getElementById('player-name');
const roomCodeInput = document.getElementById('room-code-input');
const maxPlayersInput = document.getElementById('max-players');
const roundsInput = document.getElementById('total-rounds');

// Game State
let currentState = {
    roomCode: null,
    me: null,       // my socket id
    players: [],    // list of players
    maze: null,     // maze grid (2d array)
    round: 1,
    maxRounds: 3,
    startTime: 0,
    timerInterval: null,
    waitingForNext: false,
    isGrandWinner: false
};

// Canvas Contexts Map: { 'socketId': ctx }
const playerContexts = {};

// --- SOCKET EVENTS ---

socket.on('connect', () => {
    currentState.me = socket.id;
    console.log('Connected as', socket.id);
});

socket.on('roomCreated', (data) => {
    currentState.roomCode = data.roomCode;
    showScreen('waiting-screen');
    updateWaitingUI(data.roomCode, data.room.players, data.room.maxPlayers);
});

socket.on('playerJoined', (data) => {
    // Only switch screens if we are in lobby or waiting
    // If the game has already started for us, don't jump back
    const isLobby = document.getElementById('lobby-screen').style.display !== 'none';
    const isWaiting = document.getElementById('waiting-screen').style.display !== 'none';

    if (isLobby || isWaiting) {
        currentState.roomCode = data.roomCode;
        showScreen('waiting-screen');
        updateWaitingUI(data.roomCode, data.players, data.maxPlayers);
    }
});

socket.on('gameStart', (data) => {
    currentState.maze = data.maze;
    currentState.players = data.players;
    currentState.round = data.round;
    currentState.startTime = data.startTime;

    // Setup UI
    currentState.roomCode = data.roomCode;
    document.getElementById('current-round').innerText = data.round;
    document.getElementById('game-room-code').innerText = data.roomCode;

    // Reset timer display
    document.getElementById('game-timer').innerText = "00.0s";

    // Innit Layout
    initGameLayout(data.players);

    showScreen('game-screen');

    // Start Countdown
    startCountdown(() => {
        // Clear previous winner message
        const winnerDisplay = document.getElementById('winner-announcement');
        if (winnerDisplay) winnerDisplay.innerText = "";

        window.addEventListener('keydown', handleInput);
        startTimer();
        drawAllBoards(); // Initial Draw
    });
});

socket.on('playerFinished', (data) => {
    // data: { playerId, finishTime, players }
    currentState.players = data.players;

    // Update the specific player's state
    const player = currentState.players.find(p => p.id === data.playerId);
    if (player) {
        player.finished = true;
        player.finishTime = data.finishTime;
    }

    // If I am the one who finished, show Congrats immediately
    if (data.playerId === currentState.me) {
        window.removeEventListener('keydown', handleInput);

        const overlay = document.getElementById('result-overlay');
        const title = document.getElementById('result-title');
        const stat = document.getElementById('round-stat');

        if (overlay) {
            overlay.style.display = 'flex';
            if (title) {
                title.innerText = "Congrats! You Finished!";
                title.style.color = "var(--accent)";
                title.style.fontSize = "3.5rem";
            }
            if (stat) {
                stat.innerHTML = `<span style="font-size: 3rem; color: #fff;">${data.finishTime.toFixed(2)}s</span><br>
                                  <span style="opacity: 0.8;">Waiting for others to finish...</span>`;
            }
            const nextBtn = document.getElementById('next-round-btn');
            if (nextBtn) nextBtn.style.display = 'none'; // Hide button while waiting
        }
    }

    updateBoardHeaders();
    drawAllBoards();
});

socket.on('playerMoved', (data) => {
    // data: { id, position: {x, y} }
    const player = currentState.players.find(p => p.id === data.id);
    if (player) {
        player.x = data.position.x;
        player.y = data.position.y;

        // Redraw all boards so everyone sees this player move
        drawAllBoards();
    }
});

socket.on('roundResult', (data) => {
    stopTimer();
    window.removeEventListener('keydown', handleInput);
    currentState.players = data.players;
    currentState.waitingForNext = true;
    currentState.isGrandWinner = data.isGrandWinner;
    updateBoardHeaders();

    // SHOW THE LARGE OVERLAY as requested
    const overlay = document.getElementById('result-overlay');
    const title = document.getElementById('result-title');
    const stat = document.getElementById('round-stat');
    const nextBtn = document.getElementById('next-round-btn');

    if (overlay) {
        overlay.style.display = 'flex';
        if (title) {
            const isMe = data.winner.id === currentState.me;
            title.innerText = `Congratulations! ${isMe ? "You" : data.winner.name} won this round!`;
            title.style.color = data.winner.color;
            title.style.fontSize = "3rem"; // Adjusted for longer text
        }
        if (stat) {
            const timeTaken = data.winner.lastFinishTime ? data.winner.lastFinishTime.toFixed(2) : "??";
            stat.innerHTML = `<span style="font-size: 2.5rem; color: #fff;">Speed: ${timeTaken}s</span><br>
                              <span style="opacity: 0.7;">Round ${data.currentRound} of ${data.totalRounds}</span><br>
                              <div style="margin-top: 10px; color: var(--accent); font-weight: bold; font-size: 1.1rem;">Press SPACE to continue</div>`;
        }
        if (nextBtn) {
            nextBtn.style.display = 'inline-block';
            nextBtn.innerText = data.isGrandWinner ? "See Match Results" : "Start Next Round";
            nextBtn.onclick = () => {
                overlay.style.display = 'none';
                if (data.isGrandWinner) {
                    showGameOver(data.players);
                } else {
                    socket.emit('requestNextRound', { roomCode: currentState.roomCode });
                }
            };
        }
    }

    // Small backup in top bar
    const winnerDisplay = document.getElementById('winner-announcement');
    if (winnerDisplay) {
        winnerDisplay.innerText = `${data.winner.name} Wins!`;
        winnerDisplay.style.color = data.winner.color;
    }

    console.log("Round Over. Press SPACE or ENTER to proceed.");

    // Add a temporary listener for the next round trigger
    const nextRoundHandler = (e) => {
        if (e.code === 'Space' || e.code === 'Enter') {
            window.removeEventListener('keydown', nextRoundHandler);
            currentState.waitingForNext = false;

            if (overlay) overlay.style.display = 'none';

            if (currentState.isGrandWinner) {
                showGameOver(currentState.players);
            } else {
                socket.emit('requestNextRound', { roomCode: currentState.roomCode });
            }
        }
    };
    window.addEventListener('keydown', nextRoundHandler);
});

function showGameOver(players) {
    document.getElementById('result-overlay').style.display = 'none';
    if (boardsContainer) boardsContainer.style.display = 'none'; // Hide completely on game over
    showScreen('game-over-screen');

    const sorted = [...players].sort((a, b) => b.score - a.score);
    const winner = sorted[0];

    const grandWinnerName = document.getElementById('grand-winner-name');
    const gameOverTitle = document.getElementById('game-over-title');

    if (gameOverTitle) {
        gameOverTitle.innerText = `Match Over! ${winner.name} is the Grand Champion!`;
    }

    if (grandWinnerName) {
        grandWinnerName.innerText = "🏆"; // Clear name since it's in the title now
        grandWinnerName.style.color = winner.color;
    }

    const list = document.getElementById('final-results-list');
    if (list) {
        list.innerHTML = '';
        sorted.forEach((p, i) => {
            const li = document.createElement('li');
            li.innerHTML = `
                <span>#${i + 1} ${p.name}</span>
                <span style="color: ${p.color}">${p.score} Wins</span>
            `;
            list.appendChild(li);
        });
    }
}

document.getElementById('play-again-btn').onclick = () => {
    socket.emit('requestPlayAgain', { roomCode: currentState.roomCode });
};

socket.on('resetToLobby', (data) => {
    // Reset local state if needed
    currentState.round = 1;
    showScreen('waiting-screen');
    updateWaitingUI(currentState.roomCode, data.players, document.getElementById('required-count-display').innerText);
});

socket.on('error', (msg) => {
    console.error('Socket Error:', msg);
    alert(msg);
});


// --- USER ACTIONS ---

document.getElementById('create-btn').addEventListener('click', () => {
    const name = nameInput.value.trim() || 'Player 1';
    const limit = maxPlayersInput.value;
    const rounds = roundsInput.value;

    // Total rounds state
    currentState.maxRounds = parseInt(rounds);
    document.getElementById('max-rounds').innerText = rounds;

    socket.emit('createRoom', { playerName: name, maxPlayers: limit, totalRounds: rounds });
});

document.getElementById('join-btn').addEventListener('click', () => {
    const name = nameInput.value.trim() || 'Player 2';
    const code = roomCodeInput.value.toUpperCase().trim();

    if (!code) return alert('Enter a room code!');
    console.log('Attempting to join room:', code);
    currentState.roomCode = code; // Optimistic set
    socket.emit('joinRoom', { playerName: name, roomCode: code });
});


// --- FUNCTIONS ---

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => {
        s.classList.remove('active');
        s.style.display = 'none'; // Ensure hidden
    });

    const active = document.getElementById(id);
    active.style.display = 'flex'; // Use flex for layout
    setTimeout(() => active.classList.add('active'), 10);
}

function updateWaitingUI(code, players, max) {
    document.getElementById('display-room-code').innerText = code;
    document.getElementById('required-count-display').innerText = max; // Update this

    const list = document.getElementById('player-list');
    list.innerHTML = '';

    players.forEach(p => {
        const badge = document.createElement('div');
        badge.className = 'player-badge';
        badge.innerHTML = `
            <div class="color-dot" style="color: ${p.color}; background: ${p.color}"></div>
            <span>${p.name}</span>
        `;
        list.appendChild(badge);
    });
}

function initGameLayout(players) {
    boardsContainer.innerHTML = '';
    // Reset contexts
    for (let key in playerContexts) delete playerContexts[key];

    // Create Main Area (70%)
    const mainArea = document.createElement('div');
    mainArea.className = 'main-board-area';

    // Create Sidebar Area (30%)
    const sidebarArea = document.createElement('div');
    sidebarArea.className = 'others-board-area';

    boardsContainer.appendChild(mainArea);
    boardsContainer.appendChild(sidebarArea);

    // 1. Identify ME (Local Player) - Local Focus
    const me = players.find(p => p.id === currentState.me);
    if (me) {
        createBoardElement(me, mainArea, true);
    }

    // 2. Identify OTHERS (Participants) - Small thumbnails
    const others = players.filter(p => p.id !== currentState.me);
    others.forEach(p => {
        createBoardElement(p, sidebarArea, false);
    });
}

function createBoardElement(player, container, isMain = false) {
    const wrapper = document.createElement('div');
    wrapper.className = 'board-wrapper';

    wrapper.innerHTML = `
        <div class="board-header">
            <span style="color: ${player.color}">${player.name}</span>
            <span>Score: ${player.score}</span>
        </div>
        <div class="canvas-container">
            <canvas id="canvas-${player.id}"></canvas>
        </div>
    `;

    container.appendChild(wrapper);

    // Initialize Canvas
    const canvas = wrapper.querySelector('canvas');
    const ctx = canvas.getContext('2d');

    // Make canvas resolution much higher so it fills the board outline
    // We'll use a standard high-res base and let CSS handle the responsive fit
    canvas.width = 1000;
    canvas.height = 1000;

    playerContexts[player.id] = ctx;
}

function drawAllBoards() {
    currentState.players.forEach(p => {
        drawBoardForPlayer(p.id);
    });
}

function drawBoardForPlayer(playerId) {
    const ctx = playerContexts[playerId];
    if (!ctx) return;

    const maze = currentState.maze;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const cols = maze[0].length;
    const rows = maze.length;
    const cellSize = w / cols;

    // Clear
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    // Draw Maze
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            if (maze[y][x] === 1) {
                ctx.fillStyle = '#151621'; // Wall
                ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
                ctx.strokeStyle = '#222';
                ctx.lineWidth = 1;
                ctx.strokeRect(x * cellSize, y * cellSize, cellSize, cellSize);
            }
        }
    }

    // Draw Finish
    ctx.fillStyle = '#FFD700'; // Gold
    ctx.fillRect((cols - 2) * cellSize, (rows - 2) * cellSize, cellSize, cellSize);

    // Draw EVERYONE on this board
    currentState.players.forEach(p => {
        const isOwner = p.id === playerId;
        drawPlayerDot(ctx, p, cellSize, isOwner);
    });
}

function drawPlayerDot(ctx, player, size, isOwner) {
    const x = player.x * size + size / 2;
    const y = player.y * size + size / 2;

    // Outer Selection Ring for the Owner
    if (isOwner) {
        ctx.beginPath();
        ctx.arc(x, y, size / 2.1, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();

        // "YOU" Label
        ctx.fillStyle = "#fff";
        ctx.font = "bold 10px Outfit";
        ctx.textAlign = "center";
        ctx.fillText("YOU", x, y - size / 1.5);
    }

    ctx.beginPath();
    ctx.arc(x, y, isOwner ? size / 2.8 : size / 3.8, 0, Math.PI * 2);
    ctx.fillStyle = player.color;

    if (!isOwner) {
        ctx.globalAlpha = 0.5; // Others are ghostly
    }

    // Glow Effect
    ctx.shadowBlur = isOwner ? 20 : 5;
    ctx.shadowColor = player.color;
    ctx.fill();

    // Reset shadow, alpha and alignment
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1.0;
    ctx.textAlign = "start";
}

function startTimer() {
    stopTimer();
    currentState.timerInterval = setInterval(() => {
        const elapsed = (Date.now() - currentState.startTime) / 1000;
        document.getElementById('game-timer').innerText = elapsed.toFixed(1) + "s";
    }, 100);
}

function stopTimer() {
    if (currentState.timerInterval) clearInterval(currentState.timerInterval);
}

function updateBoardHeaders() {
    currentState.players.forEach(p => {
        const header = document.querySelector(`#canvas-${p.id}`)?.closest('.board-wrapper').querySelector('.board-header');
        if (header) {
            const timeStr = p.finishTime ? ` [${p.finishTime.toFixed(1)}s]` : '';
            header.innerHTML = `
                <span style="color: ${p.color}">${p.name}${timeStr}</span>
                <span>Wins: ${p.score}</span>
            `;
        }
    });
}

function startCountdown(cb) {
    const overlay = document.getElementById('countdown-overlay');
    const text = document.getElementById('countdown-text');
    overlay.style.display = 'flex';

    let count = 3;
    text.innerText = count;

    const int = setInterval(() => {
        count--;
        if (count > 0) text.innerText = count;
        else if (count === 0) text.innerText = 'GO!';
        else {
            clearInterval(int);
            overlay.style.display = 'none';
            cb();
        }
    }, 1000);
}

function handleInput(e) {
    const me = currentState.players.find(p => p.id === currentState.me);
    if (!me) return;

    let nextX = me.x;
    let nextY = me.y;

    if (e.key === 'ArrowUp') nextY--;
    if (e.key === 'ArrowDown') nextY++;
    if (e.key === 'ArrowLeft') nextX--;
    if (e.key === 'ArrowRight') nextX++;
    const maze = currentState.maze;

    // Check bounds and walls (0 = path, 1 = wall)
    if (nextY >= 0 && nextY < maze.length && nextX >= 0 && nextX < maze[0].length) {
        if (maze[nextY][nextX] === 0) {
            me.x = nextX;
            me.y = nextY;

            // INSTANT EMIT: Send move immediately on keystroke
            socket.emit('playerMove', { roomCode: currentState.roomCode, position: { x: nextX, y: nextY } });

            // INSTANT DRAW: Optimistic Client Update for smooth feel
            drawBoardForPlayer(me.id);

            // Check Win
            if (nextY === maze.length - 2 && nextX === maze[0].length - 2) {
                // Check if already finished to avoid duplicate emits
                if (!me.finished) {
                    me.finished = true;

                    // STOP TIMER IMMEDIATELY on finish line touch
                    stopTimer();
                    const finalTime = (Date.now() - currentState.startTime) / 1000;
                    document.getElementById('game-timer').innerText = finalTime.toFixed(1) + "s";

                    socket.emit('playerWon', { roomCode: currentState.roomCode });

                    // Immediately disable movement for this player
                    window.removeEventListener('keydown', handleInput);
                }
            }
        }
    }
}
