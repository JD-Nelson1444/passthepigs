// ============================================================
// Firebase Setup
// ============================================================
// 1. Go to https://console.firebase.google.com, create a project (free).
// 2. Add a "Web App" to that project (the </> icon on the project overview page).
// 3. Firebase will show you a config object - paste your real values below.
// 4. In the Firebase Console, go to Firestore Database -> Create database
//    (start in "production mode" is fine - see SETUP.md for the security rules to paste in).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
    getFirestore,
    doc,
    getDoc,
    setDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyDDun5WNqsKMJCTHf_qKn4o4VKbZux2lRo",
    authDomain: "passthepigs-3ee68.firebaseapp.com",
    projectId: "passthepigs-3ee68",
    storageBucket: "passthepigs-3ee68.firebasestorage.app",
    messagingSenderId: "2845899616",
    appId: "1:2845899616:web:6f8a167ba708b146997c05",
    measurementId: "G-GJ258EXWDR"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// ============================================================
// Group Management
// ============================================================
// Every group's game (players, scores, winner history) lives in its own
// Firestore document at groups/{groupId}. The group name a person types in
// is turned into that document's ID, so anyone who types the same name is
// automatically looking at the same game.
const GROUP_ID_STORAGE_KEY = 'passThePigsGroupId';
const GROUP_NAME_STORAGE_KEY = 'passThePigsGroupName';

let currentGroupId = null;
let currentGroupName = null;
let saveTimeout = null;

// In-memory cache of all-time winner counts for the current group.
// Kept separate from gameState because it persists across "Reset Game"
// (only "Clear Winner Records" wipes it).
let winnersCache = {};

// Turn a free-typed group name into a safe, consistent Firestore document ID.
function sanitizeGroupId(rawName) {
    const cleaned = rawName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return cleaned || ('group-' + Date.now());
}

function groupDocRef(groupId) {
    return doc(db, 'groups', groupId);
}

// Show/hide the full-screen loading overlay used while talking to Firestore.
function setLoadingState(isLoading, message) {
    if (isLoading) {
        loadingMessage.textContent = message || 'Loading...';
        loadingOverlay.classList.add('show');
    } else {
        loadingOverlay.classList.remove('show');
    }
}

function updateGroupBadge() {
    groupBadgeLabel.textContent = 'Group: ' + currentGroupName;
}

// Ask the person for a group name via the styled popup (no page-blocking
// window.prompt, and no way to dismiss without entering something).
function promptForGroupName() {
    return new Promise((resolve) => {
        groupNameError.textContent = '';
        groupNameInput.value = '';
        groupModal.classList.add('show');
        setTimeout(() => groupNameInput.focus(), 100);

        const trySubmit = () => {
            const raw = groupNameInput.value.trim();
            if (!raw) {
                groupNameError.textContent = 'Please enter a group name.';
                return;
            }
            groupModal.classList.remove('show');
            groupModalOkBtn.removeEventListener('click', trySubmit);
            groupNameInput.removeEventListener('keypress', onKeypress);
            resolve(raw);
        };
        const onKeypress = (e) => {
            if (e.key === 'Enter') trySubmit();
        };

        groupModalOkBtn.addEventListener('click', trySubmit);
        groupNameInput.addEventListener('keypress', onKeypress);
    });
}

// Make sure gameState.currentPlayerIndex actually points at a player who
// can take a turn. Falls back to the first eligible player if the saved
// index is out of range (e.g. a player was removed elsewhere) or if the
// saved current player is already marked "out" - without this, no card
// would end up marked "current" and there'd be no "My Turn" button to
// click, effectively stalling the game for whoever loads it next.
function resolveCurrentPlayerIndex() {
    if (gameState.players.length === 0) return false;

    const originalIndex = gameState.currentPlayerIndex;

    if (gameState.currentPlayerIndex < 0 || gameState.currentPlayerIndex >= gameState.players.length) {
        gameState.currentPlayerIndex = 0;
    }

    if (gameState.players[gameState.currentPlayerIndex].isOut) {
        const startIndex = gameState.currentPlayerIndex;
        let idx = startIndex;
        let steps = 0;
        do {
            idx = (idx + 1) % gameState.players.length;
            steps++;
        } while (gameState.players[idx].isOut && idx !== startIndex && steps <= gameState.players.length);
        gameState.currentPlayerIndex = idx;
    }

    return gameState.currentPlayerIndex !== originalIndex;
}

// Load (or create) the current group's data from Firestore and hydrate
// gameState / winnersCache from it. Runs once on page load.
async function initGroup() {    let storedGroupId = localStorage.getItem(GROUP_ID_STORAGE_KEY);
    let storedGroupName = localStorage.getItem(GROUP_NAME_STORAGE_KEY);

    // Snapshot of the group we end up joining, fetched during the
    // "does this name already exist?" check below - reused afterward so we
    // don't have to read the same document from Firestore twice.
    let confirmedSnapshot = null;

    if (!storedGroupId) {
        // Keep prompting until the person either types a brand-new name,
        // or explicitly confirms they want to join an existing group.
        while (!storedGroupId) {
            const enteredName = await promptForGroupName();
            const candidateId = sanitizeGroupId(enteredName);

            setLoadingState(true, 'Checking group name...');
            let snapshot = null;
            try {
                snapshot = await getDoc(groupDocRef(candidateId));
            } catch (err) {
                // Can't reach Firestore to check - don't block the person
                // over it, just let them proceed and the normal load/save
                // error handling further down will surface any real problem.
                console.error('Could not check group name:', err);
            }
            setLoadingState(false);

            if (snapshot && snapshot.exists()) {
                const data = snapshot.data();
                const playerNames = (data.players || []).map(p => p.name);
                const playerList = playerNames.length
                    ? 'Current players: ' + playerNames.join(', ')
                    : 'It has no players yet.';
                const isTheirs = await showGameConfirm(
                    'A group called "' + enteredName + '" already exists.\n' +
                    playerList + '\n\n' +
                    'Is this your group? Choose "Cancel" to pick a different name.'
                );

                if (!isTheirs) {
                    continue; // back to the prompt for a different name
                }
                confirmedSnapshot = snapshot;
            }

            storedGroupName = enteredName;
            storedGroupId = candidateId;
        }

        localStorage.setItem(GROUP_ID_STORAGE_KEY, storedGroupId);
        localStorage.setItem(GROUP_NAME_STORAGE_KEY, storedGroupName);
    }

    currentGroupId = storedGroupId;
    currentGroupName = storedGroupName;
    updateGroupBadge();

    setLoadingState(true, 'Loading ' + currentGroupName + '\u2019s game...');

    try {
        // Reuse the snapshot from the name-check above when we have one,
        // instead of fetching the same document again.
        const snapshot = confirmedSnapshot || await getDoc(groupDocRef(currentGroupId));

        if (snapshot.exists()) {
            const data = snapshot.data();
            gameState.players = data.players || [];
            gameState.currentPlayerIndex = data.currentPlayerIndex || 0;
            gameState.gameOver = data.gameOver || false;
            winnersCache = data.winners || {};
            if (resolveCurrentPlayerIndex()) {
                queueSave();
            }
        } else {
            // Brand new group - create its document right away.
            winnersCache = {};
            await saveGroupState();
        }
    } catch (err) {
        console.error('Could not load group data from Firebase:', err);
        await showGameAlert("Couldn't connect to the game server, so scores won't be saved online right now. Check your internet connection and reload the page to try again.");
    }

    setLoadingState(false);
    updateUI();
}

// Write the full current game state for this group to Firestore.
function saveGroupState() {
    if (!currentGroupId) return Promise.resolve();

    return setDoc(groupDocRef(currentGroupId), {
        groupName: currentGroupName,
        players: gameState.players,
        currentPlayerIndex: gameState.currentPlayerIndex,
        gameOver: gameState.gameOver,
        winners: winnersCache,
        updatedAt: serverTimestamp()
    }).catch(err => {
        console.error('Could not save game data to Firebase:', err);
    });
}

// Debounced save - call this after any state change instead of calling
// saveGroupState() directly, so rapid clicks don't fire a write per click.
function queueSave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveGroupState, 400);
}

// Forget the saved group on this device and reload so the group prompt
// appears again, letting the person switch to (or create) a different group.
function switchGroup() {
    localStorage.removeItem(GROUP_ID_STORAGE_KEY);
    localStorage.removeItem(GROUP_NAME_STORAGE_KEY);
    window.location.reload();
}

// Sound System
const audioContext = new (window.AudioContext || window.webkitAudioContext)();

function playSound(frequency = 800, duration = 0.1, type = 'sine') {
    try {
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        oscillator.frequency.value = frequency;
        oscillator.type = type;
        
        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + duration);
        
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + duration);
    } catch (e) {
        console.log('Audio not available');
    }
}

function playScoreSound() {
    playSound(800, 0.1, 'sine');
}

function playPenaltySound() {
    playSound(400, 0.15, 'sine');
}

function playWinSound() {
    playSound(1000, 0.1, 'sine');
    setTimeout(() => playSound(1200, 0.1, 'sine'), 150);
    setTimeout(() => playSound(1400, 0.2, 'sine'), 300);
}

// Winner songs array
const winnerSongs = [
    'Audio/Winner/delon_boomkin-winner-sting-hollywood-476528.mp3',
    'Audio/Winner/tunetank-winner-awards-logo-484335.mp3'
];

function playRandomWinnerSong() {
    const randomIndex = Math.floor(Math.random() * winnerSongs.length);
    const winnerSong = new Audio(winnerSongs[randomIndex]);
    winnerSong.volume = 0.7;
    winnerSong.play().catch(err => {
        console.log('Could not play winner song:', err);
    });
}

// Pig Out sounds array
const pigOutSounds = [
    'Audio/PigOut/floraphonic-buzzer-15-187758.mp3',
    'Audio/PigOut/floraphonic-buzzer-18-203421.mp3',
    'Audio/PigOut/floraphonic-violin-lose-5-185126.mp3',
    'Audio/PigOut/freesound_community-072656_pig-86579.mp3',
    'Audio/PigOut/freesound_community-080190_pig-86603 (1).mp3',
    'Audio/PigOut/freesound_community-082614_pig-86580.mp3',
    'Audio/PigOut/freesound_community-085735_pig-86586.mp3',
    'Audio/PigOut/freesound_community-failure-2-89169.mp3',
    'Audio/PigOut/freesound_community-oink-40664.mp3',
    'Audio/PigOut/freesound_community-pig-oink-47167.mp3',
    'Audio/PigOut/magiaz-pig-426575.mp3',
    'Audio/PigOut/magiaz-porco1-326305.mp3',
    'Audio/PigOut/stu9-boinger-357066.mp3',
    'Audio/PigOut/stu9-longbong-357099.mp3',
    'Audio/PigOut/stu9-metal-drip-357117.mp3',
    'Audio/PigOut/stu9-quack-3-352831.mp3'
];

function playRandomPigOutSound() {
    const randomIndex = Math.floor(Math.random() * pigOutSounds.length);
    const pigOutSound = new Audio(pigOutSounds[randomIndex]);
    pigOutSound.volume = 0.6;
    pigOutSound.play().catch(err => {
        console.log('Could not play pig out sound:', err);
    });
}

// Points sounds array
const pointsSounds = [
    'Audio/Points/Points1.mp3',
    'Audio/Points/Points2.mp3',
    'Audio/Points/Points3.mp3',
    'Audio/Points/Points4.mp3',
    'Audio/Points/Points5.mp3',
    'Audio/Points/Points6.mp3',
    'Audio/Points/Points7.mp3',
    'Audio/Points/Points8.mp3',
    'Audio/Points/Points9.mp3',
    'Audio/Points/Points10.mp3',
    'Audio/Points/Points11.mp3',
    'Audio/Points/Points12.mp3',
    'Audio/Points/Points13.mp3'
];

function playRandomPointsSound() {
    const randomIndex = Math.floor(Math.random() * pointsSounds.length);
    const pointsSound = new Audio(pointsSounds[randomIndex]);
    pointsSound.volume = 0.6;
    pointsSound.play().catch(err => {
        console.log('Could not play points sound:', err);
    });
}

// Add Player sounds array
const addPlayerSounds = [
    'Audio/AddPlayer/AddPlayer1.mp3',
    'Audio/AddPlayer/AddPlayer2.mp3',
    'Audio/AddPlayer/AddPlayer3.mp3',
    'Audio/AddPlayer/AddPlayer4.mp3',
    'Audio/AddPlayer/AddPlayer5.mp3',
    'Audio/AddPlayer/AddPlayer6.mp3',
    'Audio/AddPlayer/AddPlayer7.mp3',
    'Audio/AddPlayer/AddPlayer8.mp3',
    'Audio/AddPlayer/AddPlayer9.mp3',
    'Audio/AddPlayer/AddPlayer10.mp3',
    'Audio/AddPlayer/AddPlayer11.mp3',
    'Audio/AddPlayer/AddPlayer12.mp3',
    'Audio/AddPlayer/AddPlayer13.mp3'

];

// Tracks which Add Player sounds are still available to play, so the same
// clip won't repeat for another player until every other clip has had a turn.
let availableAddPlayerSounds = [];

function playRandomAddPlayerSound() {
    // Refill the pool whenever it's empty (first time, or once every sound
    // has already been used once).
    if (availableAddPlayerSounds.length === 0) {
        availableAddPlayerSounds = [...addPlayerSounds];
    }

    const randomIndex = Math.floor(Math.random() * availableAddPlayerSounds.length);
    const chosenSound = availableAddPlayerSounds[randomIndex];

    // Take it out of the pool so it can't be picked again until refilled.
    availableAddPlayerSounds.splice(randomIndex, 1);

    const addPlayerSound = new Audio(chosenSound);
    addPlayerSound.volume = 0.6;
    addPlayerSound.play().catch(err => {
        console.log('Could not play add player sound:', err);
    });
    return chosenSound;
}

// Play up to a 5-second clip of a player's assigned sound (used for the "My Turn" button),
// fading the volume out over the final second so it doesn't cut off abruptly
function playPlayerSoundClip(soundSrc) {
    if (!soundSrc) return;

    const CLIP_DURATION_MS = 5000;
    const FADE_DURATION_MS = 1000;
    const FADE_STEPS = 20;
    const baseVolume = 0.6;

    const clip = new Audio(soundSrc);
    clip.volume = baseVolume;

    let fadeInterval;

    const stopClip = () => {
        clearInterval(fadeInterval);
        clip.pause();
        clip.currentTime = 0;
    };

    const startFadeOut = () => {
        const stepTime = FADE_DURATION_MS / FADE_STEPS;
        const volumeStep = baseVolume / FADE_STEPS;
        let stepsRemaining = FADE_STEPS;

        fadeInterval = setInterval(() => {
            stepsRemaining--;
            clip.volume = Math.max(0, volumeStep * stepsRemaining);
            if (stepsRemaining <= 0) {
                clearInterval(fadeInterval);
                stopClip();
            }
        }, stepTime);
    };

    const fadeTimer = setTimeout(startFadeOut, CLIP_DURATION_MS - FADE_DURATION_MS);

    // Clean up timers if the clip ends naturally before the fade would start
    clip.addEventListener('ended', () => {
        clearTimeout(fadeTimer);
        clearInterval(fadeInterval);
    });

    clip.play().catch(err => {
        console.log('Could not play player sound clip:', err);
    });
}

// Pastel colors for player cards (cycles if there are more players than colors)
const pastelCardColors = [
    '#FFD6E0', // pastel pink
    '#D6F5E3', // pastel mint
    '#FFF3C4', // pastel yellow
    '#D6E4FF', // pastel blue
    '#E8D6FF', // pastel lavender
    '#FFE0C2', // pastel peach
    '#D6FFF6', // pastel aqua
    '#F7D6FF', // pastel magenta
    '#E2FFD6', // pastel lime
    '#FFD9D9'  // pastel coral
];

// Game state
const gameState = {
    players: [],
    currentPlayerIndex: 0,
    gameOver: false
};

// Winner tracking system
// Backed by winnersCache (in-memory, synced to this group's Firestore
// document) instead of localStorage, so winner history is shared by
// everyone in the group rather than stuck on one device.
const winnerTracker = {
    recordWin(playerName) {
        winnersCache[playerName] = (winnersCache[playerName] || 0) + 1;
    },
    getWinCount(playerName) {
        return winnersCache[playerName] || 0;
    },
    getTotalWins() {
        return Object.values(winnersCache).reduce((sum, count) => sum + count, 0);
    },
    getAllWinners() {
        return winnersCache;
    },
    clearWinners() {
        winnersCache = {};
        queueSave();
    }
};

// Scoring definitions
const scores = {
    'Sider': 1,
    'Trotter': 5,
    'Razorback': 5,
    'Snouter': 10,
    'Leaning Jowler': 15,
    'Mixed Combo': 15,
    'Double Trotter': 20,
    'Double Razorback': 20,
    'Double Snouter': 40,
    'Double Leaning Jowler': 60
};

const penalties = {
    'Pig Out': 'pigOut',
    'Oinker': 'oinker',
    'Piggy Back': 'piggyBack'
};


// DOM Elements
const playerNameInput = document.getElementById('playerNameInput');
const addPlayerBtn = document.getElementById('addPlayerBtn');
const playersGrid = document.getElementById('playersGrid');
const gameOverBackdrop = document.getElementById('gameOverBackdrop');
const gameOverMessage = document.getElementById('gameOverMessage');
const winnerMessage = document.getElementById('winnerMessage');
const winnerLeaderboard = document.getElementById('winnerLeaderboard');
const resetGameBtn = document.getElementById('resetGameBtn');
const resetGameSamePlayersBtn = document.getElementById('resetGameSamePlayersBtn');
const clearWinnersBtn = document.getElementById('clearWinnersBtn');
const modal = document.getElementById('imageModal');
const openBtn = document.getElementById('openModalBtn');
const closeBtn = document.getElementById('closeModalBtn');
const turnModal = document.getElementById('turnModal');
const turnModalContent = document.getElementById('turnModalContent');
const closeTurnModalBtn = document.getElementById('closeTurnModalBtn');
const scoresModal = document.getElementById('scoresModal');
const scoresModalList = document.getElementById('scoresModalList');
const viewScoresBtn = document.getElementById('viewScoresBtn');
const closeScoresModalBtn = document.getElementById('closeScoresModalBtn');
const confirmModal = document.getElementById('confirmModal');
const confirmModalMessage = document.getElementById('confirmModalMessage');
const confirmModalButtons = document.getElementById('confirmModalButtons');
const confirmModalOkBtn = document.getElementById('confirmModalOkBtn');
const confirmModalCancelBtn = document.getElementById('confirmModalCancelBtn');
const groupModal = document.getElementById('groupModal');
const groupNameInput = document.getElementById('groupNameInput');
const groupNameError = document.getElementById('groupNameError');
const groupModalOkBtn = document.getElementById('groupModalOkBtn');
const groupBadgeLabel = document.getElementById('groupBadgeLabel');
const switchGroupBtn = document.getElementById('switchGroupBtn');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingMessage = document.getElementById('loadingMessage');


// Event Listeners
// Function to open the modal
openBtn.addEventListener('click', () => {
    modal.classList.add('show');
});

// Function to close the modal via X button
closeBtn.addEventListener('click', () => {
    modal.classList.remove('show');
});

// Optional: Close the modal if the user clicks anywhere on the dark overlay background
modal.addEventListener('click', (event) => {
    if (event.target === modal) {
        modal.classList.remove('show');
   }
});

closeTurnModalBtn.addEventListener('click', closeTurnModal);

viewScoresBtn.addEventListener('click', openScoresModal);
closeScoresModalBtn.addEventListener('click', closeScoresModal);

// Styled replacements for the browser's native confirm()/alert() dialogs,
// so popups match the game's look and feel. Behavior is identical to
// window.confirm/window.alert - just returned as a Promise.
function showGameConfirm(message) {
    return new Promise((resolve) => {
        confirmModalMessage.textContent = message;
        confirmModalButtons.classList.remove('alert-mode');
        confirmModalCancelBtn.style.display = '';
        confirmModalOkBtn.textContent = 'OK';

        const cleanup = (result) => {
            confirmModal.classList.remove('show');
            confirmModalOkBtn.removeEventListener('click', onOk);
            confirmModalCancelBtn.removeEventListener('click', onCancel);
            confirmModal.removeEventListener('click', onOverlayClick);
            resolve(result);
        };
        const onOk = () => cleanup(true);
        const onCancel = () => cleanup(false);
        const onOverlayClick = (event) => {
            if (event.target === confirmModal) cleanup(false);
        };

        confirmModalOkBtn.addEventListener('click', onOk);
        confirmModalCancelBtn.addEventListener('click', onCancel);
        confirmModal.addEventListener('click', onOverlayClick);

        confirmModal.classList.add('show');
    });
}

function showGameAlert(message) {
    return new Promise((resolve) => {
        confirmModalMessage.textContent = message;
        confirmModalButtons.classList.add('alert-mode');
        confirmModalCancelBtn.style.display = 'none';
        confirmModalOkBtn.textContent = 'Got it';

        const cleanup = () => {
            confirmModal.classList.remove('show');
            confirmModalOkBtn.removeEventListener('click', onOk);
            confirmModal.removeEventListener('click', onOverlayClick);
            resolve();
        };
        const onOk = () => cleanup();
        const onOverlayClick = (event) => {
            if (event.target === confirmModal) cleanup();
        };

        confirmModalOkBtn.addEventListener('click', onOk);
        confirmModal.addEventListener('click', onOverlayClick);

        confirmModal.classList.add('show');
    });
}

addPlayerBtn.addEventListener('click', addPlayer);
playerNameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addPlayer();
});
resetGameBtn.addEventListener('click', resetGame);
resetGameSamePlayersBtn.addEventListener('click', resetGameSamePlayers);
clearWinnersBtn.addEventListener('click', async () => {
    const confirmed = await showGameConfirm('Are you sure you want to clear all winner records? This cannot be undone.');
    if (confirmed) {
        winnerTracker.clearWinners();
        await showGameAlert('Winner records have been cleared!');
    }
});

switchGroupBtn.addEventListener('click', async () => {
    const confirmed = await showGameConfirm('Switch to a different group? This device will forget "' + currentGroupName + '" and ask for a new group name.');
    if (confirmed) {
        switchGroup();
    }
});

// Play intro song when page loads
function playIntroSong() {
    const introAudio = new Audio('Audio/IntroSong.mp3');
    introAudio.volume = 0.5;
    
    const playPromise = introAudio.play();
    if (playPromise !== undefined) {
        playPromise
            .then(() => {
                console.log('Intro song playing');
            })
            .catch(err => {
                console.log('Autoplay blocked - user interaction needed:', err);
                // Set up autoplay on first user interaction
                enableAudioOnInteraction();
            });
    }
}

// Enable audio playback on first user interaction
function enableAudioOnInteraction() {
    const handleInteraction = () => {
        // Resume audio context if needed
        if (audioContext && audioContext.state === 'suspended') {
            audioContext.resume();
        }
        // Try playing intro song again
        const introAudio = new Audio('Audio/IntroSong.mp3');
        introAudio.volume = 0.5;
        introAudio.play().catch(err => {
            console.log('Could not play intro song on interaction:', err);
        });
        // Remove listeners after first interaction
        document.removeEventListener('click', handleInteraction);
        document.removeEventListener('keypress', handleInteraction);
    };
    
    // Add listeners for first interaction
    document.addEventListener('click', handleInteraction, { once: true });
    document.addEventListener('keypress', handleInteraction, { once: true });
}

window.addEventListener('load', playIntroSong);

// Add a player to the game
async function addPlayer() {
    const name = playerNameInput.value.trim();
    
    if (!name) {
        await showGameAlert('Please enter a player name');
        return;
    }
    
    if (gameState.players.length >= 10) {
        await showGameAlert('Maximum 10 players allowed');
        return;
    }
    
    if (gameState.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
        await showGameAlert('Player already exists');
        return;
    }
    
    // Special event: Play intro song if player name is Jones, otherwise play a random add player sound.
    // Whichever file plays gets remembered on the player so "My Turn" can replay the same clip.
    let assignedSound;
    if (name.toLowerCase() === 'jones') {
        assignedSound = 'Audio/IntroSong.mp3';
        playIntroSong();
    } else {
        assignedSound = playRandomAddPlayerSound();
    }
    
    gameState.players.push({
        name: name,
        totalScore: 0,
        turnScore: 0,
        history: [],
        isOut: false,
        addSound: assignedSound
    });
    
    playerNameInput.value = '';
    
    updateUI();
    queueSave();
    
    // Automatically pop open the turn window once the first player joins
    // if (gameState.players.length === 1) {
    //    openTurnModal();
    //} 
}

// Remove a player from the game
function removePlayer(index) {
    if (gameState.players.length <= 1) {
        alert('At least 1 player is required');
        return;
    }
    
    gameState.players.splice(index, 1);
    
    if (gameState.currentPlayerIndex >= gameState.players.length) {
        gameState.currentPlayerIndex = 0;
    }
    
    updateUI();
    queueSave();
}

// Record a score for the current player
function recordScore(playerIndex, scoreType, points) {
    if (gameState.gameOver) return;
    
    // Check if it's this player's turn
    if (playerIndex !== gameState.currentPlayerIndex) {
        alert("It's not " + gameState.players[playerIndex].name + "'s turn yet! It's " + gameState.players[gameState.currentPlayerIndex].name + "'s turn. Please wait for your turn.");
        return;
    }
    
    const currentPlayer = gameState.players[gameState.currentPlayerIndex];
    
    if (currentPlayer.isOut) {
        alert(currentPlayer.name + ' is out of the game');
        return;
    }
    
    // Handle penalties
    if (scoreType === 'Pig Out') {
        // Lose turn score only
        playPenaltySound();
        playRandomPigOutSound();
        currentPlayer.history.push({
            type: 'Pig Out',
            points: -currentPlayer.turnScore,
            turnScore: currentPlayer.turnScore,
            action: 'Pig Out'
        });
        currentPlayer.turnScore = 0;
        endTurn();
    } else if (scoreType === 'Oinker') {
        // Lose all points (back to 0)
        playPenaltySound();
        playRandomPigOutSound();
        currentPlayer.history.push({
            type: 'Oinker',
            points: -currentPlayer.totalScore,
            totalScore: currentPlayer.totalScore,
            action: 'Oinker'
        });
        currentPlayer.totalScore = 0;
        currentPlayer.turnScore = 0;
        endTurn();
    } else if (scoreType === 'Piggy Back') {
        // Lose all points and kicked out
        playPenaltySound();
        playRandomPigOutSound();
        currentPlayer.history.push({
            type: 'Piggy Back',
            points: -currentPlayer.totalScore,
            totalScore: currentPlayer.totalScore,
            action: 'Piggy Back - Out of Game'
        });
        currentPlayer.totalScore = 0;
        currentPlayer.turnScore = 0;
        currentPlayer.isOut = true;
        
        // End turn immediately after Piggy Back
        endTurn();
        return;
    } else {
        // Regular scoring
        playRandomPointsSound();
        currentPlayer.history.push({
            type: scoreType,
            points: points,
            action: scoreType
        });
        currentPlayer.turnScore += points;
    }
    
    updateUI();
    queueSave();
}

// End the current turn and move to next player
function endTurn() {
    if (gameState.gameOver) return;
    
    const currentPlayer = gameState.players[gameState.currentPlayerIndex];
    
    if (currentPlayer.turnScore === 0 && !currentPlayer.history.length) {
        alert('Record a score before ending turn');
        return;
    }
    
    // Close this player's turn popup - their turn is over
    closeTurnModal();
    
    // Add turn score to total score
    currentPlayer.totalScore += currentPlayer.turnScore;
    currentPlayer.turnScore = 0;
    currentPlayer.history = [];
    
    // Check if player has won
    if (currentPlayer.totalScore >= 100) {
        openScoresModal();
        endGame(currentPlayer.name);
        return;
    }
    
    // Move to next active player
    let nextPlayerIndex = gameState.currentPlayerIndex;
    do {
        nextPlayerIndex = (nextPlayerIndex + 1) % gameState.players.length;
    } while (gameState.players[nextPlayerIndex].isOut && nextPlayerIndex !== gameState.currentPlayerIndex);
    
    gameState.currentPlayerIndex = nextPlayerIndex;
    updateUI();
    queueSave();
    
    // Play the new current player's sound clip now that End Turn has advanced to them
    playPlayerSoundClip(gameState.players[nextPlayerIndex].addSound);
    
    // Automatically open the next player's turn popup after the close animation
    setTimeout(() => {
        openTurnModal();
    }, 350);
}

// Undo the last action
function undoLastAction() {
    if (gameState.gameOver) return;
    
    const currentPlayer = gameState.players[gameState.currentPlayerIndex];
    
    if (currentPlayer.history.length === 0) {
        return;
    }
    
    const lastAction = currentPlayer.history.pop();
    
    if (lastAction.type === 'Pig Out') {
        // Undo turn score loss
        currentPlayer.turnScore = lastAction.turnScore;
    } else if (lastAction.type === 'Oinker') {
        // Undo total score loss
        currentPlayer.totalScore = lastAction.totalScore;
    } else if (lastAction.type === 'Piggy Back') {
        // Undo being out of the game
        currentPlayer.isOut = false;
        currentPlayer.totalScore = lastAction.totalScore;
    } else {
        // Undo regular scoring
        currentPlayer.turnScore -= lastAction.points;
    }
    
    updateUI();
    queueSave();
}

// End the game
function endGame(winnerName) {
    // Close the turn popup - the game is over
    closeTurnModal();
    
    // Record the win in the tracker
    winnerTracker.recordWin(winnerName);
    const winCount = winnerTracker.getWinCount(winnerName);
    
    gameState.gameOver = true;
    gameOverBackdrop.classList.remove('hidden');
    gameOverMessage.classList.remove('hidden');
    const winnerPoints = gameState.players.find(p => p.name === winnerName).totalScore;
    
    // Display winner message with win count
    winnerMessage.innerHTML = `<strong>${winnerName}</strong> wins with <strong>${winnerPoints}</strong> points!<br><br>
<span class="win-stats">${winnerName} has won <strong>${winCount}</strong> ${winCount === 1 ? 'game' : 'games'}</span>`;
    
    // Generate and display winner leaderboard
    generateWinnerLeaderboard();
    
    playWinSound();
    playRandomWinnerSong();
    queueSave();
}

// Generate and display the winner leaderboard
function generateWinnerLeaderboard() {
    const allWinners = winnerTracker.getAllWinners();
    
    if (Object.keys(allWinners).length === 0) {
        winnerLeaderboard.innerHTML = '';
        return;
    }
    
    // Sort winners by win count (descending)
    const sortedWinners = Object.entries(allWinners)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10); // Show top 10 winners
    
    let leaderboardHTML = '<h3>📊 All-Time Winners</h3>';
    
    sortedWinners.forEach((entry, index) => {
        const [playerName, winCount] = entry;
        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '';
        leaderboardHTML += `
            <div class="winner-item">
                <span class="winner-rank">${medal || index + 1}.</span>
                <span class="winner-name">${playerName}</span>
                <span class="winner-count">${winCount}</span>
            </div>
        `;
    });
    
    winnerLeaderboard.innerHTML = leaderboardHTML;
}

// Reset the game
function resetGame() {
    gameState.players = [];
    gameState.currentPlayerIndex = 0;
    gameState.gameOver = false;
    gameOverBackdrop.classList.add('hidden');
    gameOverMessage.classList.add('hidden');
    winnerLeaderboard.innerHTML = '';
    playerNameInput.value = '';
    closeTurnModal();
    availableAddPlayerSounds = []; // start a fresh sound pool for the new game
    updateUI();
    queueSave();
}

// Reset game scores but keep the same players
function resetGameSamePlayers() {
    // Reset scores for all players but keep them in the game
    gameState.players.forEach(player => {
        player.totalScore = 0;
        player.turnScore = 0;
        player.history = [];
        player.isOut = false;
    });
    
    gameState.currentPlayerIndex = 0;
    gameState.gameOver = false;
    gameOverBackdrop.classList.add('hidden');
    gameOverMessage.classList.add('hidden');
    winnerLeaderboard.innerHTML = '';
    updateUI();
    queueSave();
    
    // Automatically open the first player's turn popup
    if (gameState.players.length > 0) {
        playPlayerSoundClip(gameState.players[0].addSound);
        openTurnModal();
    }
}

// Update the UI
function updateUI() {
    // Update add player button state
    playerNameInput.disabled = gameState.gameOver;
    addPlayerBtn.disabled = gameState.gameOver || gameState.players.length >= 10;
    
    // Clear and rebuild the compact players grid (roster/summary view)
    playersGrid.innerHTML = '';
    
    gameState.players.forEach((player, index) => {
        const summaryCard = createPlayerSummaryCard(player, index);
        playersGrid.appendChild(summaryCard);
    });
    
    // Keep the turn popup content in sync if it's currently open
    if (turnModal.classList.contains('show')) {
        updateTurnModalContent();
    }
    
    // Keep the all-scores popup in sync if it's currently open
    if (scoresModal.classList.contains('show')) {
        updateScoresModalContent();
    }
}

// Create a compact summary card for the players grid (roster view)
function createPlayerSummaryCard(player, index) {
    const isCurrent = index === gameState.currentPlayerIndex && !gameState.gameOver;
    
    const card = document.createElement('div');
    card.className = 'player-summary-card' + (player.isOut ? ' out' : '') + (isCurrent ? ' active' : '');
    card.style.backgroundColor = pastelCardColors[index % pastelCardColors.length];
    
    // Player header with name and remove button
    const header = document.createElement('div');
    header.className = 'player-header';
    header.innerHTML = `
        <div class="player-name">${player.name}${isCurrent ? ' (Current)' : ''}</div>
        <button class="remove-player-btn" data-index="${index}">×</button>
    `;
    header.querySelector('.remove-player-btn').addEventListener('click', () => removePlayer(index));
    
    // Score display
    const scoreDisplay = document.createElement('div');
    scoreDisplay.className = 'score-display';
    scoreDisplay.innerHTML = `
        <div class="turn-score">${player.isOut ? 'OUT OF GAME' : (isCurrent ? 'Turn: ' + player.turnScore : 'Waiting for turn')}</div>
    `;
    
    card.appendChild(header);
    card.appendChild(scoreDisplay);
    
    // Button to (re)open the turn popup, in case it was manually closed
    if (isCurrent) {
        const viewTurnBtn = document.createElement('button');
        viewTurnBtn.className = 'btn btn-primary view-turn-btn';
        viewTurnBtn.textContent = 'My Turn';
        viewTurnBtn.addEventListener('click', () => {
            // Only the very first player's turn is kicked off by clicking "My Turn".
            // Every player after that has their clip played when End Turn advances to them (see endTurn()).
            if (index === 0) {
                playPlayerSoundClip(player.addSound);
            }
            openTurnModal();
        });
        card.appendChild(viewTurnBtn);
    }
    
    // Out message
    if (player.isOut) {
        const outMessage = document.createElement('div');
        outMessage.className = 'out-message';
        outMessage.textContent = 'OUT OF GAME (Piggy Back)';
        card.appendChild(outMessage);
    }
    
    return card;
}

// Build the full interactive scoring card for whichever player's turn it is
function createPlayerTurnCard(player, index) {
    const card = document.createElement('div');
    card.className = 'player-card active';
    card.style.backgroundColor = pastelCardColors[index % pastelCardColors.length];
    
    // Header with player name
    const header = document.createElement('div');
    header.className = 'player-header';
    header.innerHTML = `<div class="player-name">${player.name}'s Turn</div>`;
    
    // Score display
    const scoreDisplay = document.createElement('div');
    scoreDisplay.className = 'score-display';
    scoreDisplay.innerHTML = `
        <div class="turn-score">Turn: ${player.turnScore}</div>
        <div class="combined-score">Turn + Total: ${player.turnScore + player.totalScore}</div>
    `;
    
    // Scoring buttons
    const scoringButtons = document.createElement('div');
    scoringButtons.className = 'scoring-buttons';
    
    // Regular scoring buttons
    Object.entries(scores).forEach(([scoreType, points]) => {
        const btn = document.createElement('button');
        btn.className = 'score-btn';
        btn.textContent = `${scoreType}\n+${points}`;
        btn.addEventListener('click', () => recordScore(index, scoreType, points));
        scoringButtons.appendChild(btn);
    });
    
    // Penalty buttons - clicking any of these ends the turn and auto-advances
    const pigOutBtn = document.createElement('button');
    pigOutBtn.className = 'score-btn penalty';
    pigOutBtn.textContent = 'Pig Out\n(−Turn)';
    pigOutBtn.addEventListener('click', () => recordScore(index, 'Pig Out', 0));
    scoringButtons.appendChild(pigOutBtn);
    
    const oinkerBtn = document.createElement('button');
    oinkerBtn.className = 'score-btn penalty';
    oinkerBtn.textContent = 'Oinker\n(−All)';
    oinkerBtn.addEventListener('click', () => recordScore(index, 'Oinker', 0));
    scoringButtons.appendChild(oinkerBtn);
    
    const piggyBackBtn = document.createElement('button');
    piggyBackBtn.className = 'score-btn penalty';
    piggyBackBtn.textContent = 'Piggy Back\n(Out)';
    piggyBackBtn.addEventListener('click', () => recordScore(index, 'Piggy Back', 0));
    scoringButtons.appendChild(piggyBackBtn);
    
    // Action buttons
    const actionButtons = document.createElement('div');
    actionButtons.className = 'action-buttons';
    
    const endTurnBtn = document.createElement('button');
    endTurnBtn.className = 'end-turn-btn';
    endTurnBtn.textContent = 'End Turn';
    endTurnBtn.disabled = player.turnScore === 0 && player.history.length === 0;
    endTurnBtn.addEventListener('click', endTurn);
    
    const undoBtn = document.createElement('button');
    undoBtn.className = 'undo-btn';
    undoBtn.textContent = '↶ Undo';
    undoBtn.disabled = player.history.length === 0;
    undoBtn.addEventListener('click', undoLastAction);
    
    actionButtons.appendChild(endTurnBtn);
    actionButtons.appendChild(undoBtn);
    
    // Assemble card
    card.appendChild(header);
    card.appendChild(scoreDisplay);
    card.appendChild(scoringButtons);
    card.appendChild(actionButtons);
    
    return card;
}

// Fill the turn popup with the current player's interactive scoring card
function updateTurnModalContent() {
    turnModalContent.innerHTML = '';
    
    if (gameState.players.length === 0 || gameState.gameOver) {
        return;
    }
    
    const index = gameState.currentPlayerIndex;
    const player = gameState.players[index];
    
    if (player.isOut) {
        return;
    }
    
    const card = createPlayerTurnCard(player, index);
    turnModalContent.appendChild(card);
}

// Fill the all-scores popup with every player's name and current score
function updateScoresModalContent() {
    scoresModalList.innerHTML = '';
    
    if (gameState.players.length === 0) {
        scoresModalList.innerHTML = '<p style="text-align:center; color:#888;">No players yet</p>';
        return;
    }
    
    gameState.players.forEach((player, index) => {
        const isCurrent = index === gameState.currentPlayerIndex && !gameState.gameOver;
        
        const row = document.createElement('div');
        row.className = 'scores-list-item' + (isCurrent ? ' active' : '') + (player.isOut ? ' out' : '');
        row.style.backgroundColor = pastelCardColors[index % pastelCardColors.length];
        
        row.innerHTML = `
            <span class="scores-list-name">${player.name}${isCurrent ? ' <span class="current-badge">Current</span>' : ''}${player.isOut ? ' <span class="current-badge">Out</span>' : ''}</span>
            <span class="scores-list-score">${player.totalScore}</span>
        `;
        
        scoresModalList.appendChild(row);
    });
}

// Open the popup showing every player's name and score
function openScoresModal() {
    updateScoresModalContent();
    scoresModal.classList.add('show');
}

// Close the all-scores popup
function closeScoresModal() {
    scoresModal.classList.remove('show');
}

// Open the popup showing the current player's turn
function openTurnModal() {
    if (gameState.gameOver || gameState.players.length === 0) return;
    updateTurnModalContent();
    turnModal.classList.add('show');
    
    // The All Scores panel is always shown alongside the Turn popup
    openScoresModal();
}

// Close the turn popup
function closeTurnModal() {
    turnModal.classList.remove('show');
}

// Initialize the app: figure out which group this device belongs to,
// load that group's data from Firebase, then render the UI.
initGroup();