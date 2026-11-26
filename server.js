'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 15000,
  pingTimeout: 25000,
});

// Serve static client files from ./public
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint for Render
app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime() });
});

// Fallback to index.html
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== CONSTANTS ====================
const COLORS = ['black', 'red', 'blue', 'orange'];
const COLOR_ORDER = { black: 0, red: 1, blue: 2, orange: 3 };
const GRID_COLS = 22;
const GRID_ROWS = 8;
const TURN_SECONDS = 40;
const AI_NAMES = ['Congo', 'Daphne', 'Vera'];
const MAX_CHAT_HISTORY = 60;
const ENDED_ROOM_TTL_MS = 10 * 60 * 1000;

// ==================== GLOBAL STATE ====================
// Map<roomCode, Room>
const rooms = new Map();
// Map<sessionId, { sessionId, name, socketIds: Set<string> }>
const lobbyUsers = new Map();
// Array<{ type, senderName?, sessionId?, text, roomCode?, timestamp }>
const lobbyMessages = [];

// ==================== DECK & BOARD HELPERS ====================
function createDeck() {
  const tiles = [];
  let id = 1;
  for (let copy = 0; copy < 2; copy++) {
    for (const color of COLORS) {
      for (let num = 1; num <= 13; num++) {
        tiles.push({ id: id++, color, num, isJoker: false });
      }
    }
  }
  tiles.push({ id: id++, color: 'red', num: 0, isJoker: true });
  tiles.push({ id: id++, color: 'black', num: 0, isJoker: true });

  // Fisher-Yates shuffle
  for (let i = tiles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }
  return tiles;
}

function createEmptyBoard() {
  return Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(null));
}

function cloneBoard(board) {
  return board.map((row) => row.map((t) => (t ? { ...t } : null)));
}

function cloneRack(rack) {
  return rack.map((t) => (t ? { ...t } : null));
}

function getRackTiles(player) {
  return (player.rack || []).filter(Boolean);
}

function ensureRackCapacity(player) {
  if (!Array.isArray(player.rack)) player.rack = Array(20).fill(null);
  const count = getRackTiles(player).length;
  const neededPerRow = Math.max(10, Math.ceil(count / 2) + 2);
  const targetLen = Math.max(20, neededPerRow * 2);
  while (player.rack.length < targetLen) player.rack.push(null);
  if (player.rack.length % 2 !== 0) player.rack.push(null);
}

function addTileToRack(player, tile) {
  ensureRackCapacity(player);
  const emptyIdx = player.rack.indexOf(null);
  if (emptyIdx !== -1) player.rack[emptyIdx] = tile;
  else player.rack.push(tile);
}

function drawTileFromPool(room, player) {
  if (room.pool.length === 0) return null;
  const tile = room.pool.pop();
  addTileToRack(player, tile);
  if (room.pool.length === 0 && room.finalRoundTurnsLeft === null && !room.finalRoundJustTriggered) {
    room.finalRoundJustTriggered = true;
    room.finalRoundTriggerName = player.name;
  }
  return tile;
}

function generateRoomCode() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  return String(Date.now()).slice(-4);
}

function sanitizeName(raw) {
  const clean = String(raw || '').trim().slice(0, 14);
  return clean || '플레이어';
}

function sanitizeChatText(raw) {
  return String(raw || '').trim().slice(0, 200);
}

// ==================== RUMMIKUB VALIDATION ====================
function validateSet(tiles) {
  if (!tiles || tiles.length < 3) return { valid: false, type: null, points: 0 };
  const nonJokers = tiles.filter((t) => !t.isJoker);
  if (nonJokers.length === 0) return { valid: false, type: null, points: 0 };

  // Group: 3~4 tiles of the same number and distinct colors
  if (tiles.length <= 4) {
    const num = nonJokers[0].num;
    const allSameNum = nonJokers.every((t) => t.num === num);
    const colorSet = new Set(nonJokers.map((t) => t.color));
    if (allSameNum && colorSet.size === nonJokers.length) {
      return { valid: true, type: 'group', points: num * tiles.length };
    }
  }

  // Run: 3~13 tiles of the same color in strict ascending order
  if (tiles.length <= 13) {
    const color = nonJokers[0].color;
    if (nonJokers.every((t) => t.color === color)) {
      const firstIdx = tiles.findIndex((t) => !t.isJoker);
      const startNum = tiles[firstIdx].num - firstIdx;
      if (startNum >= 1 && startNum + tiles.length - 1 <= 13) {
        let ok = true;
        let pts = 0;
        for (let i = 0; i < tiles.length; i++) {
          const expected = startNum + i;
          if (!tiles[i].isJoker && tiles[i].num !== expected) {
            ok = false;
            break;
          }
          pts += expected;
        }
        if (ok) return { valid: true, type: 'run', points: pts };
      }
    }
  }

  return { valid: false, type: null, points: 0 };
}

function getBoardGroups(board) {
  const groups = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    const rowArr = board[r];
    if (!rowArr) continue;
    let c = 0;
    while (c < GRID_COLS) {
      if (rowArr[c]) {
        const startCol = c;
        const tiles = [];
        while (c < GRID_COLS && rowArr[c]) {
          tiles.push(rowArr[c]);
          c++;
        }
        const check = validateSet(tiles);
        groups.push({ row: r, startCol, endCol: c - 1, tiles, ...check });
      } else {
        c++;
      }
    }
  }
  return groups;
}

function hasBoardChangedFromSnapshot(room) {
  if (!room.turnSnapshot) return false;
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const a = room.board[r][c];
      const b = room.turnSnapshot.board[r][c];
      if ((a ? a.id : null) !== (b ? b.id : null)) return true;
    }
  }
  return false;
}

function evaluateTurnState(room) {
  const player = room.players[room.currentPlayerIndex];
  if (!player || !room.turnSnapshot) {
    return { canConfirm: false, playedCount: 0, allValid: true, meldPoints: 0, reason: '' };
  }

  const currentBoardIds = new Set();
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (room.board[r][c]) currentBoardIds.add(room.board[r][c].id);
    }
  }

  let playedCount = 0;
  for (const id of room.playedFromRackIds) {
    if (currentBoardIds.has(id)) playedCount++;
  }

  const snapBoardIds = new Set();
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (room.turnSnapshot.board[r][c]) snapBoardIds.add(room.turnSnapshot.board[r][c].id);
    }
  }
  for (const id of snapBoardIds) {
    if (!currentBoardIds.has(id)) {
      return { canConfirm: false, playedCount, allValid: false, meldPoints: 0, reason: '바닥 타일이 누락되었습니다.' };
    }
  }

  const groups = getBoardGroups(room.board);
  const allValid = groups.every((g) => g.valid);

  // Player has not played any rack tile yet: if board sets are all valid, allow drawing (+) keeping moved tiles
  if (playedCount === 0) {
    return {
      canConfirm: false,
      playedCount: 0,
      allValid,
      meldPoints: 0,
      reason: allValid ? '내 패를 내려놓거나 우측 + 로 뽑으세요.' : '빨간 테두리 세트를 수정하세요.',
    };
  }

  if (!player.hasMelded) {
    let meldPoints = 0;
    let touchedOldBoard = false;

    const snapGroups = getBoardGroups(room.turnSnapshot.board);
    const currentOldSigs = new Set(
      groups
        .filter((g) => g.tiles.every((t) => snapBoardIds.has(t.id)))
        .map((g) => g.tiles.map((t) => t.id).sort((a, b) => a - b).join(','))
    );
    for (const sg of snapGroups) {
      const sig = sg.tiles.map((t) => t.id).sort((a, b) => a - b).join(',');
      if (!currentOldSigs.has(sig)) {
        touchedOldBoard = true;
        break;
      }
    }

    for (const g of groups) {
      const hasNew = g.tiles.some((t) => room.playedFromRackIds.has(t.id));
      const hasOld = g.tiles.some((t) => snapBoardIds.has(t.id));
      if (hasNew && hasOld) touchedOldBoard = true;
      if (hasNew && !hasOld && g.valid) meldPoints += g.points;
    }

    if (touchedOldBoard) {
      return { canConfirm: false, playedCount, allValid, meldPoints, reason: '첫 등록 전에는 기존 바닥 패를 조합할 수 없습니다.' };
    }
    if (!allValid) {
      return { canConfirm: false, playedCount, allValid: false, meldPoints, reason: '유효하지 않은 세트가 있습니다.' };
    }
    if (meldPoints < 30) {
      return { canConfirm: false, playedCount, allValid: true, meldPoints, reason: `첫 등록 30점 이상 필요 (현재 ${meldPoints}점)` };
    }
    return { canConfirm: true, playedCount, allValid: true, meldPoints, reason: `첫 등록 가능 (${meldPoints}점)!` };
  }

  if (!allValid) {
    return { canConfirm: false, playedCount, allValid: false, meldPoints: 0, reason: '빨간 테두리 세트를 수정하세요.' };
  }
  return { canConfirm: true, playedCount, allValid: true, meldPoints: 0, reason: '유효한 배치입니다! ✓ 를 누르세요.' };
}

function calcRackPenalty(player) {
  return getRackTiles(player).reduce((acc, t) => acc + (t.isJoker ? 30 : t.num), 0);
}

// ==================== INITIAL RACK SORT FOR NEW GAME ====================
function compareByRun(a, b) {
  if (a.isJoker !== b.isJoker) return a.isJoker ? 1 : -1;
  if (a.color !== b.color) return COLOR_ORDER[a.color] - COLOR_ORDER[b.color];
  if (a.num !== b.num) return a.num - b.num;
  return a.id - b.id;
}

function sortPlayerRackInitial(player) {
  const tiles = getRackTiles(player).sort(compareByRun);
  const rack = Array(20).fill(null);
  for (let i = 0; i < tiles.length; i++) rack[i] = tiles[i];
  player.rack = rack;
}

// ==================== LOBBY & ROOM BROADCASTING ====================
function getLobbyUsersSnapshot() {
  return Array.from(lobbyUsers.values()).map((u) => ({
    sessionId: u.sessionId,
    name: u.name,
  }));
}

function getLobbyRoomsSnapshot() {
  const list = [];
  for (const room of rooms.values()) {
    const host = room.players.find((p) => p.sessionId === room.hostSessionId) || room.players[0];
    list.push({
      code: room.code,
      hostName: host ? host.name : room.hostName || '방장',
      phase: room.phase,
      maxPlayers: room.maxPlayers,
      playerCount: room.players.length,
      spectatorCount: room.spectators.length,
      createdAt: room.createdAt,
    });
  }
  const rank = { waiting: 0, playing: 1, gameover: 2, ended: 3 };
  list.sort((a, b) => {
    const ra = rank[a.phase] ?? 9;
    const rb = rank[b.phase] ?? 9;
    if (ra !== rb) return ra - rb;
    return b.createdAt - a.createdAt;
  });
  return list;
}

function broadcastLobbyUpdate() {
  io.emit('lobby:update', {
    users: getLobbyUsersSnapshot(),
    rooms: getLobbyRoomsSnapshot(),
  });
}

function pushLobbyMessage(entry) {
  lobbyMessages.push(entry);
  if (lobbyMessages.length > MAX_CHAT_HISTORY) lobbyMessages.shift();
  io.emit('lobby:chatMessage', entry);
}

function pushRoomMessage(room, entry) {
  room.chatMessages.push(entry);
  if (room.chatMessages.length > MAX_CHAT_HISTORY) room.chatMessages.shift();
  io.to(room.code).emit('room:chatMessage', entry);
}

function buildPersonalizedRoomState(room, recipientSessionId) {
  const myPlayerIndex = room.players.findIndex((p) => !p.isAI && p.sessionId === recipientSessionId);
  const isSpectator = myPlayerIndex === -1;
  const me = myPlayerIndex >= 0 ? room.players[myPlayerIndex] : null;
  const evalState = room.phase === 'playing' ? evaluateTurnState(room) : null;

  const boardIds = new Set();
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (room.board[r][c]) boardIds.add(room.board[r][c].id);
    }
  }

  const isCurrTurnRecipient = myPlayerIndex >= 0 && myPlayerIndex === room.currentPlayerIndex;
  const visiblePlayedIds = isCurrTurnRecipient
    ? [...room.playedFromRackIds]
    : [...room.playedFromRackIds].filter((id) => boardIds.has(id));

  return {
    code: room.code,
    phase: room.phase,
    maxPlayers: room.maxPlayers,
    hostSessionId: room.hostSessionId,
    isSpectator,
    spectators: room.spectators.map((s) => ({ sessionId: s.sessionId, name: s.name })),
    players: room.players.map((p) => {
      const base = {
        name: p.name,
        isAI: p.isAI,
        isHost: p.sessionId === room.hostSessionId,
        connected: p.isAI ? true : p.connected,
        hasMelded: p.hasMelded,
        tileCount: getRackTiles(p).length,
      };
      // Spectators can see every player's hand in real time
      if (isSpectator) {
        base.rack = getRackTiles(p);
      }
      return base;
    }),
    myPlayerIndex,
    currentPlayerIndex: room.currentPlayerIndex,
    poolCount: room.pool.length,
    timeLeft: room.timeLeft,
    finalRoundTurnsLeft: room.finalRoundTurnsLeft,
    finalRoundTriggerName: room.finalRoundTriggerName,
    board: room.board,
    myRack: me ? me.rack : [],
    playedFromRackIds: visiblePlayedIds,
    recentAITileIds: [...room.recentAITileIds],
    hasBoardChanged: hasBoardChangedFromSnapshot(room),
    evalState,
    chatMessages: room.chatMessages,
    gameOverData: room.gameOverData,
  };
}

function broadcastRoom(room) {
  if (!room || room.phase === 'ended') return;
  for (const p of room.players) {
    if (!p.isAI && p.socketId) {
      const sock = io.sockets.sockets.get(p.socketId);
      if (sock) sock.emit('room:state', buildPersonalizedRoomState(room, p.sessionId));
    }
  }
  for (const s of room.spectators) {
    if (s.socketId) {
      const sock = io.sockets.sockets.get(s.socketId);
      if (sock) sock.emit('room:state', buildPersonalizedRoomState(room, s.sessionId));
    }
  }
}

// ==================== TURN & TIMER MANAGEMENT (FREEZE-PROOF) ====================
function clearRoomTimers(room) {
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
  if (room.aiTimeout) {
    clearTimeout(room.aiTimeout);
    room.aiTimeout = null;
  }
}

function startGameInRoom(room) {
  clearRoomTimers(room);
  room.pool = createDeck();
  room.board = createEmptyBoard();
  room.phase = 'playing';
  room.currentPlayerIndex = 0;
  room.consecutivePasses = 0;
  room.finalRoundJustTriggered = false;
  room.finalRoundTurnsLeft = null;
  room.finalRoundTriggerName = null;
  room.recentAITileIds = new Set();
  room.gameOverData = null;
  room.turnProcessing = false;

  for (const p of room.players) {
    p.hasMelded = false;
    p.rack = Array(20).fill(null);
    for (let i = 0; i < 14; i++) {
      if (room.pool.length > 0) p.rack[i] = room.pool.pop();
    }
    sortPlayerRackInitial(p);
  }

  startTurn(room);
}

function startTurn(room) {
  clearRoomTimers(room);
  if (room.phase !== 'playing') return;

  room.turnProcessing = false;
  const player = room.players[room.currentPlayerIndex];
  if (!player) return;

  room.turnSnapshot = {
    board: cloneBoard(room.board),
    rack: cloneRack(player.rack),
  };
  room.playedFromRackIds = new Set(getRackTiles(player).map((t) => t.id));
  room.timeLeft = TURN_SECONDS;
  room.turnDeadline = Date.now() + TURN_SECONDS * 1000;

  broadcastRoom(room);
  io.to(room.code).emit('game:timer', {
    timeLeft: room.timeLeft,
    currentPlayerIndex: room.currentPlayerIndex,
  });

  if (player.isAI) {
    startTimerCountdown(room);
    room.aiTimeout = setTimeout(() => {
      try {
        executeAITurn(room);
      } catch (err) {
        console.error('[AI Turn Error]', err);
        if (room.phase === 'playing') {
          if (room.pool.length > 0) drawTileFromPool(room, player);
          advanceToNextPlayer(room, { msg: `${player.name}이(가) 턴을 넘겼습니다.`, tone: 'info' });
        }
      }
    }, 950);
  } else {
    if (player.socketId) {
      const sock = io.sockets.sockets.get(player.socketId);
      if (sock) sock.emit('game:yourTurn');
    }
    startTimerCountdown(room);
  }
}

function startTimerCountdown(room) {
  if (room.timerInterval) clearInterval(room.timerInterval);
  room.timerInterval = setInterval(() => {
    try {
      if (room.phase !== 'playing') {
        clearRoomTimers(room);
        return;
      }
      const remaining = Math.max(0, Math.ceil((room.turnDeadline - Date.now()) / 1000));
      room.timeLeft = remaining;
      io.to(room.code).emit('game:timer', {
        timeLeft: remaining,
        currentPlayerIndex: room.currentPlayerIndex,
      });

      if (remaining <= 0 && !room.turnProcessing) {
        handleTurnTimeout(room);
      }
    } catch (err) {
      console.error('[Timer Tick Error]', err);
    }
  }, 1000);
}

function handleTurnTimeout(room) {
  if (room.turnProcessing || room.phase !== 'playing') return;
  room.turnProcessing = true;
  clearRoomTimers(room);

  try {
    const player = room.players[room.currentPlayerIndex];
    if (!player) return;

    if (player.isAI) {
      if (room.pool.length > 0) drawTileFromPool(room, player);
      room.consecutivePasses++;
      advanceToNextPlayer(room, { msg: `${player.name}이(가) 타일 1장을 뽑았습니다.`, tone: 'info' });
      return;
    }

    const evalRes = evaluateTurnState(room);
    if (evalRes.canConfirm) {
      io.to(room.code).emit('room:toast', { msg: `${player.name}님 시간 종료 — 유효 배치가 자동 확정되었습니다.`, tone: 'success' });
      confirmTurnSuccess(room);
      return;
    }

    const groups = getBoardGroups(room.board);
    const hasInvalidGroup = groups.some((g) => !g.valid);
    let hasUnresolvableOldBreak = false;

    if (hasInvalidGroup) {
      for (const g of groups) {
        if (!g.valid) {
          if (g.tiles.every((t) => room.playedFromRackIds.has(t.id))) {
            for (let c = g.startCol; c <= g.endCol; c++) {
              const t = room.board[g.row][c];
              if (t) {
                room.board[g.row][c] = null;
                addTileToRack(player, t);
              }
            }
          } else {
            hasUnresolvableOldBreak = true;
          }
        }
      }
      if (hasUnresolvableOldBreak) {
        room.board = cloneBoard(room.turnSnapshot.board);
        player.rack = cloneRack(room.turnSnapshot.rack);
      }
    }

    const penalty = hasInvalidGroup ? 3 : 1;
    let drawn = 0;
    for (let i = 0; i < penalty && room.pool.length > 0; i++) {
      if (drawTileFromPool(room, player)) drawn++;
    }

    const msg = hasInvalidGroup
      ? `${player.name}님 시간 초과! 미완성 패를 회수하고 페널티 ${drawn}장을 받았습니다.`
      : `${player.name}님 시간 초과! 타일 ${drawn}장을 뽑았습니다.`;
    room.consecutivePasses++;
    advanceToNextPlayer(room, { msg, tone: 'error' });
  } catch (err) {
    console.error('[Timeout Handler Error]', err);
    room.turnProcessing = false;
    advanceToNextPlayer(room, null);
  }
}

function confirmTurnSuccess(room) {
  clearRoomTimers(room);
  const player = room.players[room.currentPlayerIndex];
  if (!player) return;
  if (!player.hasMelded) player.hasMelded = true;
  room.consecutivePasses = 0;
  room.recentAITileIds = new Set();

  if (getRackTiles(player).length === 0) {
    triggerGameOver(room, player, '모든 타일을 가장 먼저 내려놓았습니다!');
    return;
  }

  advanceToNextPlayer(room, null);
}

function advanceToNextPlayer(room, toast = null) {
  clearRoomTimers(room);
  if (room.phase !== 'playing') return;

  if (room.finalRoundJustTriggered) {
    room.finalRoundJustTriggered = false;
    room.finalRoundTurnsLeft = room.players.length;
    toast = {
      msg: `더미 소진! 마지막 패를 뽑은 ${room.finalRoundTriggerName}님 차례까지 1바퀴 더 진행 후 점수로 승부합니다!`,
      tone: 'info',
    };
  } else if (room.finalRoundTurnsLeft !== null) {
    room.finalRoundTurnsLeft--;
    if (room.finalRoundTurnsLeft <= 0) {
      finishGameByScore(room);
      return;
    }
  }

  room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
  if (toast) {
    io.to(room.code).emit('room:toast', toast);
  }
  startTurn(room);
}

function computeFinalScores(room, forcedWinnerSessionId = null) {
  const entries = room.players.map((p) => ({
    player: p,
    rawSum: calcRackPenalty(p),
    leftCount: getRackTiles(p).length,
  }));

  let winnerEntry;
  if (forcedWinnerSessionId) {
    winnerEntry = entries.find((e) => e.player.sessionId === forcedWinnerSessionId) || entries[0];
  } else {
    const sorted = [...entries].sort((a, b) => (a.rawSum !== b.rawSum ? a.rawSum - b.rawSum : a.leftCount - b.leftCount));
    winnerEntry = sorted[0];
  }

  const minSum = winnerEntry.rawSum;
  let totalWinnerGain = 0;

  const rows = entries.map((e) => {
    const isWinner = e.player.sessionId === winnerEntry.player.sessionId;
    if (isWinner) {
      return {
        name: e.player.name,
        isAI: e.player.isAI,
        isWinner: true,
        rawSum: e.rawSum,
        penalty: 0,
        adjustedScore: 0,
        leftCount: e.leftCount,
      };
    }
    const adjustedLoss = Math.max(0, e.rawSum - minSum);
    totalWinnerGain += adjustedLoss;
    return {
      name: e.player.name,
      isAI: e.player.isAI,
      isWinner: false,
      rawSum: e.rawSum,
      penalty: adjustedLoss,
      adjustedScore: -adjustedLoss,
      leftCount: e.leftCount,
    };
  });

  const winnerRow = rows.find((r) => r.isWinner);
  if (winnerRow) winnerRow.adjustedScore = totalWinnerGain;

  rows.sort((a, b) => (a.isWinner !== b.isWinner ? (a.isWinner ? -1 : 1) : b.adjustedScore - a.adjustedScore));

  return {
    winner: winnerEntry.player,
    minSum,
    totalLoserPenalty: totalWinnerGain,
    rows,
  };
}

function finishGameByScore(room) {
  const result = computeFinalScores(room, null);
  const subtitle = result.minSum > 0
    ? `파이널 라운드 종료! 최저 합계 ${result.minSum}점을 0점으로 보정(+${result.minSum})하여 정산했습니다.`
    : '파이널 라운드 종료! 남은 패 합계가 가장 적은 플레이어가 승리했습니다.';
  triggerGameOver(room, result.winner, subtitle, result);
}

function triggerGameOver(room, winner, subtitle, precomputed = null) {
  clearRoomTimers(room);
  room.phase = 'gameover';
  room.finalRoundJustTriggered = false;
  room.finalRoundTurnsLeft = null;

  const result = precomputed || computeFinalScores(room, winner.sessionId);

  room.gameOverData = {
    winnerSessionId: result.winner.sessionId,
    winnerName: result.winner.name,
    subtitle,
    minSum: result.minSum,
    totalLoserPenalty: result.totalLoserPenalty,
    rows: result.rows,
  };

  broadcastRoom(room);
  broadcastLobbyUpdate();
}

// ==================== PRO AI ENGINE (RECOMBINATION + JOKER SUPPORT) ====================
function isAreaFreeOnBoard(board, row, col, len) {
  if (row < 0 || row >= GRID_ROWS || col < 0 || col + len > GRID_COLS) return false;
  for (let i = 0; i < len; i++) {
    if (board[row][col + i]) return false;
  }
  return true;
}

function findNearestEmptySpotForAI(board, prefRow, prefCol, len) {
  let bestWithGap = null;
  let bestGapDist = Infinity;
  let bestAny = null;
  let bestAnyDist = Infinity;

  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c <= GRID_COLS - len; c++) {
      if (!isAreaFreeOnBoard(board, r, c, len)) continue;
      const dist = Math.hypot(c - prefCol, (r - prefRow) * 2.2);
      const leftClear = c === 0 || !board[r][c - 1];
      const rightClear = c + len >= GRID_COLS || !board[r][c + len];
      if (leftClear && rightClear && dist < bestGapDist) {
        bestGapDist = dist;
        bestWithGap = { row: r, col: c };
      }
      if (dist < bestAnyDist) {
        bestAnyDist = dist;
        bestAny = { row: r, col: c };
      }
    }
  }
  return bestWithGap || bestAny;
}

function packSetsOntoBoard(existingBoard, untouchedGroups, newSets) {
  const board = createEmptyBoard();
  for (const g of untouchedGroups) {
    for (let i = 0; i < g.tiles.length; i++) {
      board[g.row][g.startCol + i] = g.tiles[i];
    }
  }

  const sortedNew = [...newSets].sort((a, b) => b.length - a.length);
  const centerR = Math.floor(GRID_ROWS / 2);

  for (const setTiles of sortedNew) {
    const prefC = Math.max(0, Math.floor((GRID_COLS - setTiles.length) / 2));
    const spot = findNearestEmptySpotForAI(board, centerR, prefC, setTiles.length);
    if (!spot) {
      const allSets = [...untouchedGroups.map((g) => g.tiles), ...sortedNew].sort((a, b) => b.length - a.length);
      const fresh = createEmptyBoard();
      for (const s of allSets) {
        const sp = findNearestEmptySpotForAI(fresh, 1, 1, s.length);
        if (!sp) return null;
        for (let i = 0; i < s.length; i++) fresh[sp.row][sp.col + i] = s[i];
      }
      return fresh;
    }
    for (let i = 0; i < setTiles.length; i++) {
      board[spot.row][spot.col + i] = setTiles[i];
    }
  }
  return board;
}

function generateValidSetsFromPool(tiles, maxJokersPerSet = 1) {
  const sets = [];
  const jokers = tiles.filter((t) => t.isJoker);
  const normals = tiles.filter((t) => !t.isJoker);

  const byColorNum = new Map();
  for (const t of normals) {
    const key = `${t.color}:${t.num}`;
    if (!byColorNum.has(key)) byColorNum.set(key, []);
    byColorNum.get(key).push(t);
  }

  // 1. Groups (3 or 4 same number, distinct colors)
  for (let num = 1; num <= 13; num++) {
    const availableByColor = [];
    for (const c of COLORS) {
      const list = byColorNum.get(`${c}:${num}`);
      if (list && list.length > 0) availableByColor.push(list[0]);
    }
    const n = availableByColor.length;
    if (n >= 3) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          for (let k = j + 1; k < n; k++) {
            const arr = [availableByColor[i], availableByColor[j], availableByColor[k]];
            sets.push({ tiles: arr, points: num * 3, jokersUsed: 0 });
          }
        }
      }
      if (n === 4) {
        sets.push({ tiles: [...availableByColor], points: num * 4, jokersUsed: 0 });
      }
    }
    if (n >= 2 && jokers.length >= 1 && maxJokersPerSet >= 1) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          sets.push({ tiles: [availableByColor[i], availableByColor[j], jokers[0]], points: num * 3, jokersUsed: 1 });
        }
      }
    }
  }

  // 2. Runs (same color, length 3..13)
  for (const color of COLORS) {
    const atNum = Array(14).fill(null);
    for (let num = 1; num <= 13; num++) {
      const list = byColorNum.get(`${color}:${num}`);
      if (list && list.length > 0) atNum[num] = list[0];
    }

    for (let start = 1; start <= 11; start++) {
      for (let len = 3; len <= 13 - start + 1; len++) {
        const missingPositions = [];
        for (let offset = 0; offset < len; offset++) {
          if (!atNum[start + offset]) missingPositions.push(offset);
        }
        if (missingPositions.length === 0) {
          const arr = [];
          let pts = 0;
          for (let offset = 0; offset < len; offset++) {
            arr.push(atNum[start + offset]);
            pts += start + offset;
          }
          sets.push({ tiles: arr, points: pts, jokersUsed: 0 });
        } else if (missingPositions.length === 1 && len <= 5 && jokers.length >= 1 && maxJokersPerSet >= 1) {
          const arr = [];
          let pts = 0;
          for (let offset = 0; offset < len; offset++) {
            arr.push(atNum[start + offset] || jokers[0]);
            pts += start + offset;
          }
          sets.push({ tiles: arr, points: pts, jokersUsed: 1 });
        }
      }
    }
  }

  return sets;
}

function solveInitialMeldPro(rackTiles, deadlineMs) {
  const candidates = generateValidSetsFromPool(rackTiles, 1);
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.jokersUsed !== b.jokersUsed) return a.jokersUsed - b.jokersUsed;
    return b.points - a.points;
  });

  let best = null;
  let bestScore = -1;
  const usedIds = new Set();
  const chosen = [];

  function dfs(idx, totalPts, totalTiles, totalJokers) {
    if (Date.now() > deadlineMs) return;

    if (totalPts >= 30) {
      const winBonus = totalTiles === rackTiles.length ? 100000 : 0;
      const score = winBonus + totalTiles * 100 + totalPts - totalJokers * 140;
      if (score > bestScore) {
        bestScore = score;
        best = {
          sets: chosen.map((c) => c.tiles),
          points: totalPts,
          tilesCount: totalTiles,
        };
      }
    }

    if (idx >= candidates.length) return;

    for (let i = idx; i < candidates.length; i++) {
      if (Date.now() > deadlineMs) return;
      const c = candidates[i];
      let conflict = false;
      for (const t of c.tiles) {
        if (usedIds.has(t.id)) {
          conflict = true;
          break;
        }
      }
      if (conflict) continue;

      for (const t of c.tiles) usedIds.add(t.id);
      chosen.push(c);
      dfs(i + 1, totalPts + c.points, totalTiles + c.tiles.length, totalJokers + c.jokersUsed);
      chosen.pop();
      for (const t of c.tiles) usedIds.delete(t.id);
    }
  }

  dfs(0, 0, 0, 0);
  return best;
}

function solveRecombinationPro(board, rackTiles, budgetMs = 80) {
  const deadlineMs = Date.now() + budgetMs;
  const boardGroups = getBoardGroups(board);
  const rackIds = new Set(rackTiles.map((t) => t.id));

  const relevantIndices = new Set();
  for (let gi = 0; gi < boardGroups.length; gi++) {
    const g = boardGroups[gi];
    const hasJoker = g.tiles.some((t) => t.isJoker);
    let touchesRack = hasJoker || g.tiles.length >= 4;

    if (!touchesRack) {
      for (const rt of rackTiles) {
        if (rt.isJoker) {
          touchesRack = true;
          break;
        }
        for (const bt of g.tiles) {
          if (bt.isJoker) {
            touchesRack = true;
            break;
          }
          if (bt.num === rt.num || (bt.color === rt.color && Math.abs(bt.num - rt.num) <= 2)) {
            touchesRack = true;
            break;
          }
        }
        if (touchesRack) break;
      }
    }
    if (touchesRack) relevantIndices.add(gi);
  }

  const relevantList = [...relevantIndices].slice(0, 6);
  const relevantSet = new Set(relevantList);
  const untouchedGroups = boardGroups.filter((_g, idx) => !relevantSet.has(idx));
  const poolBoardTiles = [];
  for (const idx of relevantList) {
    poolBoardTiles.push(...boardGroups[idx].tiles);
  }

  const requiredBoardIds = new Set(poolBoardTiles.map((t) => t.id));
  const combinedPool = [...poolBoardTiles, ...rackTiles];
  const candidates = generateValidSetsFromPool(combinedPool, 1);

  const byTileId = new Map();
  for (let ci = 0; ci < candidates.length; ci++) {
    const c = candidates[ci];
    c.rackCount = c.tiles.filter((t) => rackIds.has(t.id)).length;
    c.boardCount = c.tiles.length - c.rackCount;
    for (const t of c.tiles) {
      if (!byTileId.has(t.id)) byTileId.set(t.id, []);
      byTileId.get(t.id).push(ci);
    }
  }

  let bestSolution = null;
  let bestScore = 0;
  const usedTileIds = new Set();
  const chosenSets = [];

  const rackOnlyCandidates = candidates
    .filter((c) => c.boardCount === 0 && c.rackCount >= 3)
    .sort((a, b) => b.rackCount - a.rackCount || b.points - a.points);

  function addBestRackOnlySets(baseSets, baseRackPlayed, basePts) {
    const extraUsed = new Set(usedTileIds);
    const finalSets = [...baseSets];
    let rackPlayed = baseRackPlayed;
    let pts = basePts;

    for (const c of rackOnlyCandidates) {
      if (c.tiles.some((t) => extraUsed.has(t.id))) continue;
      c.tiles.forEach((t) => extraUsed.add(t.id));
      finalSets.push(c.tiles);
      rackPlayed += c.rackCount;
      pts += c.points;
    }

    if (rackPlayed > 0) {
      const winBonus = rackPlayed === rackTiles.length ? 100000 : 0;
      const score = winBonus + rackPlayed * 120 + pts;
      if (score > bestScore) {
        bestScore = score;
        bestSolution = {
          sets: finalSets,
          rackPlayed,
          points: pts,
        };
      }
    }
  }

  function coverBoardTiles(rackPlayedSoFar, ptsSoFar) {
    if (Date.now() > deadlineMs) return;

    let pickId = null;
    let pickOptions = null;
    for (const reqId of requiredBoardIds) {
      if (usedTileIds.has(reqId)) continue;
      const opts = byTileId.get(reqId) || [];
      let validCount = 0;
      const avail = [];
      for (const ci of opts) {
        const c = candidates[ci];
        let conflict = false;
        for (const t of c.tiles) {
          if (usedTileIds.has(t.id)) {
            conflict = true;
            break;
          }
        }
        if (!conflict) {
          validCount++;
          avail.push(c);
        }
      }
      if (validCount === 0) return;
      if (pickOptions === null || validCount < pickOptions.length) {
        pickId = reqId;
        pickOptions = avail;
        if (validCount === 1) break;
      }
    }

    if (pickId === null) {
      addBestRackOnlySets(chosenSets.map((c) => c.tiles), rackPlayedSoFar, ptsSoFar);
      return;
    }

    pickOptions.sort((a, b) => b.rackCount - a.rackCount || b.points - a.points);
    const branchCap = Math.min(pickOptions.length, 10);

    for (let i = 0; i < branchCap; i++) {
      if (Date.now() > deadlineMs) return;
      const c = pickOptions[i];
      for (const t of c.tiles) usedTileIds.add(t.id);
      chosenSets.push(c);
      coverBoardTiles(rackPlayedSoFar + c.rackCount, ptsSoFar + c.points);
      chosenSets.pop();
      for (const t of c.tiles) usedTileIds.delete(t.id);
    }
  }

  coverBoardTiles(0, 0);

  if (!bestSolution) return null;

  const nextBoard = packSetsOntoBoard(board, untouchedGroups, bestSolution.sets);
  if (!nextBoard) return null;

  const nextGroups = getBoardGroups(nextBoard);
  if (!nextGroups.every((g) => g.valid)) return null;

  const nextBoardIds = new Set();
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (nextBoard[r][c]) nextBoardIds.add(nextBoard[r][c].id);
    }
  }
  for (const bg of boardGroups) {
    for (const t of bg.tiles) {
      if (!nextBoardIds.has(t.id)) return null;
    }
  }

  const placedIds = new Set();
  for (const rt of rackTiles) {
    if (nextBoardIds.has(rt.id)) placedIds.add(rt.id);
  }
  if (placedIds.size === 0) return null;

  return { board: nextBoard, placedIds };
}

function executeAITurn(room) {
  const ai = room.players[room.currentPlayerIndex];
  if (!ai || !ai.isAI || room.phase !== 'playing') return;

  const rackTiles = getRackTiles(ai);

  if (!ai.hasMelded) {
    const meldPlan = solveInitialMeldPro(rackTiles, Date.now() + 75);
    if (meldPlan && meldPlan.points >= 30 && meldPlan.sets.length > 0) {
      const existingGroups = getBoardGroups(room.board);
      const nextBoard = packSetsOntoBoard(room.board, existingGroups, meldPlan.sets);
      if (nextBoard && getBoardGroups(nextBoard).every((g) => g.valid)) {
        const placedIds = new Set();
        meldPlan.sets.forEach((s) => s.forEach((t) => placedIds.add(t.id)));
        room.board = nextBoard;
        ai.rack = ai.rack.map((t) => (t && placedIds.has(t.id) ? null : t));
        ai.hasMelded = true;
        room.recentAITileIds = placedIds;
        room.consecutivePasses = 0;
        if (getRackTiles(ai).length === 0) {
          triggerGameOver(room, ai, `${ai.name}님이 모든 타일을 먼저 내려놓았습니다!`);
          return;
        }
        advanceToNextPlayer(room, {
          msg: `${ai.name}이(가) ${meldPlan.points}점으로 첫 등록했습니다!`,
          tone: 'success',
        });
        return;
      }
    }
  } else {
    const proMove = solveRecombinationPro(room.board, rackTiles, 80);
    if (proMove && proMove.placedIds.size > 0) {
      room.board = proMove.board;
      ai.rack = ai.rack.map((t) => (t && proMove.placedIds.has(t.id) ? null : t));
      room.recentAITileIds = proMove.placedIds;
      room.consecutivePasses = 0;
      if (getRackTiles(ai).length === 0) {
        triggerGameOver(room, ai, `${ai.name}님이 모든 타일을 먼저 내려놓았습니다!`);
        return;
      }
      advanceToNextPlayer(room, {
        msg: `${ai.name}이(가) 타일 ${proMove.placedIds.size}개를 내려놓았습니다.`,
        tone: 'info',
      });
      return;
    }
  }

  if (room.pool.length > 0) {
    drawTileFromPool(room, ai);
    room.recentAITileIds = new Set();
    room.consecutivePasses++;
    advanceToNextPlayer(room, { msg: `${ai.name}이(가) 타일 1장을 뽑았습니다.`, tone: 'info' });
  } else {
    room.recentAITileIds = new Set();
    room.consecutivePasses++;
    advanceToNextPlayer(room, { msg: `${ai.name}이(가) 패스했습니다.`, tone: 'info' });
  }
}

// ==================== ROOM LIFECYCLE HELPERS ====================
function closeRoomByHost(room, hostName) {
  clearRoomTimers(room);
  room.phase = 'ended';
  room.endedAt = Date.now();

  const reason = `${hostName}님(방장)이 게임을 종료했습니다. 대화방으로 돌아갑니다.`;
  io.to(room.code).emit('room:closed', { reason });

  const roomSockets = io.sockets.adapter.rooms.get(room.code);
  if (roomSockets) {
    for (const sid of [...roomSockets]) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) {
        sock.leave(room.code);
        if (sock.data && sock.data.roomCode === room.code) {
          sock.data.roomCode = null;
        }
      }
    }
  }

  pushLobbyMessage({
    type: 'system',
    text: `방 ${room.code} (${hostName}님의 방)이 종료되었습니다.`,
    timestamp: Date.now(),
  });

  broadcastLobbyUpdate();

  setTimeout(() => {
    const cur = rooms.get(room.code);
    if (cur && cur.phase === 'ended') {
      rooms.delete(room.code);
      broadcastLobbyUpdate();
    }
  }, ENDED_ROOM_TTL_MS);
}

function detachSocketFromCurrentRoom(socket, isDisconnect = false) {
  const code = socket.data?.roomCode;
  const sessionId = socket.data?.sessionId;
  if (!code) return;

  const room = rooms.get(code);
  socket.leave(code);
  socket.data.roomCode = null;
  if (!room || room.phase === 'ended') return;

  const specIdx = room.spectators.findIndex((s) => s.sessionId === sessionId || s.socketId === socket.id);
  if (specIdx !== -1) {
    const [removed] = room.spectators.splice(specIdx, 1);
    io.to(room.code).emit('room:toast', { msg: `👁️ ${removed.name}님이 관전을 종료했습니다.`, tone: 'info' });
    pushRoomMessage(room, {
      type: 'system',
      text: `👁️ ${removed.name}님이 관전을 종료했습니다.`,
      timestamp: Date.now(),
    });
    broadcastRoom(room);
    broadcastLobbyUpdate();
    return;
  }

  const pIdx = room.players.findIndex((p) => !p.isAI && (p.sessionId === sessionId || p.socketId === socket.id));
  if (pIdx === -1) return;
  const player = room.players[pIdx];

  if (room.phase === 'waiting' && !isDisconnect) {
    room.players.splice(pIdx, 1);
    if (room.players.length === 0) {
      clearRoomTimers(room);
      room.phase = 'ended';
      room.endedAt = Date.now();
      broadcastLobbyUpdate();
      setTimeout(() => {
        const cur = rooms.get(room.code);
        if (cur && cur.phase === 'ended') {
          rooms.delete(room.code);
          broadcastLobbyUpdate();
        }
      }, ENDED_ROOM_TTL_MS);
      return;
    }
    if (room.hostSessionId === player.sessionId) {
      room.hostSessionId = room.players[0].sessionId;
      room.hostName = room.players[0].name;
    }
    io.to(room.code).emit('room:toast', { msg: `${player.name}님이 대기실을 나갔습니다.`, tone: 'info' });
    broadcastRoom(room);
    broadcastLobbyUpdate();
  } else {
    player.connected = false;
    player.socketId = null;
    broadcastRoom(room);
  }
}

// ==================== SOCKET.IO HANDLERS ====================
io.on('connection', (socket) => {
  socket.data = { sessionId: null, name: '플레이어', roomCode: null };

  // 1. Enter Rummikub Club Lobby
  socket.on('lobby:enter', ({ name, sessionId } = {}, cb) => {
    try {
      const cleanName = sanitizeName(name);
      const sid = String(sessionId || socket.id);
      socket.data.sessionId = sid;
      socket.data.name = cleanName;

      const existing = lobbyUsers.get(sid);
      const isFirstJoin = !existing;
      if (existing) {
        existing.name = cleanName;
        existing.socketIds.add(socket.id);
      } else {
        lobbyUsers.set(sid, { sessionId: sid, name: cleanName, socketIds: new Set([socket.id]) });
      }

      if (isFirstJoin) {
        pushLobbyMessage({
          type: 'system',
          text: `${cleanName}님이 루미큐브 클럽에 입장했습니다.`,
          timestamp: Date.now(),
        });
      }

      broadcastLobbyUpdate();
      if (typeof cb === 'function') {
        cb({
          ok: true,
          messages: lobbyMessages,
          users: getLobbyUsersSnapshot(),
          rooms: getLobbyRoomsSnapshot(),
        });
      }
    } catch (err) {
      console.error('[lobby:enter error]', err);
      if (typeof cb === 'function') cb({ error: '클럽 입장 중 오류가 발생했습니다.' });
    }
  });

  // 2. Refresh Open Rooms List
  socket.on('lobby:getRooms', (_payload, cb) => {
    if (typeof cb === 'function') {
      cb({
        ok: true,
        users: getLobbyUsersSnapshot(),
        rooms: getLobbyRoomsSnapshot(),
      });
    }
  });

  // 3. Club Chat Message
  socket.on('lobby:chat', ({ text } = {}, cb) => {
    const cleanText = sanitizeChatText(text);
    if (!cleanText) return;
    pushLobbyMessage({
      type: 'chat',
      senderName: socket.data.name || '플레이어',
      sessionId: socket.data.sessionId || socket.id,
      text: cleanText,
      timestamp: Date.now(),
    });
    if (typeof cb === 'function') cb({ ok: true });
  });

  // 4. Create Room
  socket.on('room:create', ({ name, maxPlayers, sessionId } = {}, cb) => {
    try {
      detachSocketFromCurrentRoom(socket, false);

      const cleanName = sanitizeName(name || socket.data.name);
      const sid = String(sessionId || socket.data.sessionId || socket.id);
      const cap = Math.max(2, Math.min(4, parseInt(maxPlayers, 10) || 4));
      const code = generateRoomCode();

      socket.data.sessionId = sid;
      socket.data.name = cleanName;
      socket.data.roomCode = code;

      const room = {
        code,
        phase: 'waiting',
        maxPlayers: cap,
        hostSessionId: sid,
        hostName: cleanName,
        players: [
          {
            sessionId: sid,
            socketId: socket.id,
            name: cleanName,
            isAI: false,
            connected: true,
            rack: Array(20).fill(null),
            hasMelded: false,
          },
        ],
        spectators: [],
        pool: [],
        board: createEmptyBoard(),
        currentPlayerIndex: 0,
        timeLeft: TURN_SECONDS,
        turnDeadline: null,
        turnSnapshot: null,
        playedFromRackIds: new Set(),
        recentAITileIds: new Set(),
        consecutivePasses: 0,
        finalRoundJustTriggered: false,
        finalRoundTurnsLeft: null,
        finalRoundTriggerName: null,
        gameOverData: null,
        chatMessages: [
          {
            type: 'system',
            text: `${cleanName}님이 ${cap}인 게임방을 생성했습니다.`,
            timestamp: Date.now(),
          },
        ],
        timerInterval: null,
        aiTimeout: null,
        turnProcessing: false,
        createdAt: Date.now(),
        endedAt: null,
      };

      rooms.set(code, room);
      socket.join(code);

      pushLobbyMessage({
        type: 'system',
        text: `🎮 ${cleanName}님이 ${cap}인 게임방을 열었습니다!`,
        roomCode: code,
        timestamp: Date.now(),
      });

      broadcastRoom(room);
      broadcastLobbyUpdate();

      if (typeof cb === 'function') cb({ ok: true, code });
    } catch (err) {
      console.error('[room:create error]', err);
      // 5. Join Room (Player in waiting room, or Spectator in ongoing/full room)
  socket.on('room:join', ({ code, name, sessionId } = {}, cb) => {
    try {
      const cleanCode = String(code || '').replace(/\D/g, '').slice(0, 4);
      const room = rooms.get(cleanCode);
      if (!room) {
        if (typeof cb === 'function') cb({ error: '존재하지 않는 방 코드입니다.' });
        return;
      }
      if (room.phase === 'ended' || room.phase === 'gameover') {
        if (typeof cb === 'function') cb({ error: '이미 종료된 방입니다.' });
        return;
      }

      const cleanName = sanitizeName(name || socket.data.name);
      const sid = String(sessionId || socket.data.sessionId || socket.id);

      if (socket.data.roomCode && socket.data.roomCode !== cleanCode) {
        detachSocketFromCurrentRoom(socket, false);
      }

      socket.data.sessionId = sid;
      socket.data.name = cleanName;
      socket.data.roomCode = cleanCode;
      socket.join(cleanCode);

      // Rejoin as existing player
      const existingPlayer = room.players.find((p) => !p.isAI && p.sessionId === sid);
      if (existingPlayer) {
        existingPlayer.socketId = socket.id;
        existingPlayer.connected = true;
        existingPlayer.name = cleanName;
        broadcastRoom(room);
        if (typeof cb === 'function') cb({ ok: true, code: cleanCode, spectator: false });
        return;
      }

      // Rejoin as existing spectator
      const existingSpec = room.spectators.find((s) => s.sessionId === sid);
      if (existingSpec) {
        existingSpec.socketId = socket.id;
        existingSpec.name = cleanName;
        broadcastRoom(room);
        if (typeof cb === 'function') cb({ ok: true, code: cleanCode, spectator: true });
        return;
      }

      // Join as player if waiting room has open seat
      if (room.phase === 'waiting' && room.players.length < room.maxPlayers) {
        room.players.push({
          sessionId: sid,
          socketId: socket.id,
          name: cleanName,
          isAI: false,
          connected: true,
          rack: Array(20).fill(null),
          hasMelded: false,
        });
        io.to(cleanCode).emit('room:toast', { msg: `${cleanName}님이 방에 입장했습니다.`, tone: 'success' });
        pushRoomMessage(room, {
          type: 'system',
          text: `${cleanName}님이 입장했습니다.`,
          timestamp: Date.now(),
        });
        broadcastRoom(room);
        broadcastLobbyUpdate();
        if (typeof cb === 'function') cb({ ok: true, code: cleanCode, spectator: false });
        return;
      }

      // Otherwise enter as live spectator (ongoing game or full waiting room)
      room.spectators.push({
        sessionId: sid,
        socketId: socket.id,
        name: cleanName,
      });
      io.to(cleanCode).emit('room:toast', {
        msg: `👁️ ${cleanName}님이 관전자로 입장했습니다.`,
        tone: 'info',
      });
      pushRoomMessage(room, {
        type: 'system',
        text: `👁️ ${cleanName}님이 관전자로 입장했습니다.`,
        timestamp: Date.now(),
      });
      broadcastRoom(room);
      broadcastLobbyUpdate();
      if (typeof cb === 'function') cb({ ok: true, code: cleanCode, spectator: true });
    } catch (err) {
      console.error('[room:join error]', err);
      if (typeof cb === 'function') cb({ error: '방 참여 중 오류가 발생했습니다.' });
    }
  });

  // 6. Resync after reconnect / mobile tab return
  socket.on('room:resync', ({ code, sessionId } = {}) => {
    const cleanCode = String(code || socket.data.roomCode || '');
    const room = rooms.get(cleanCode);
    if (!room || room.phase === 'ended') return;

    const sid = String(sessionId || socket.data.sessionId || '');
    const player = room.players.find((p) => !p.isAI && p.sessionId === sid);
    const spec = room.spectators.find((s) => s.sessionId === sid);
    if (!player && !spec) return;

    socket.data.sessionId = sid;
    socket.data.roomCode = cleanCode;
    socket.join(cleanCode);

    if (player) {
      player.socketId = socket.id;
      player.connected = true;
    } else if (spec) {
      spec.socketId = socket.id;
    }

    if (room.phase === 'playing' && room.turnDeadline) {
      room.timeLeft = Math.max(0, Math.ceil((room.turnDeadline - Date.now()) / 1000));
    }

    socket.emit('room:state', buildPersonalizedRoomState(room, sid));
    socket.emit('game:timer', {
      timeLeft: room.timeLeft,
      currentPlayerIndex: room.currentPlayerIndex,
    });
  });

  // 7. Start Game (Host only)
  socket.on('room:start', ({ fillWithAI } = {}, cb) => {
    try {
      const room = rooms.get(socket.data.roomCode);
      if (!room || room.phase !== 'waiting') {
        if (typeof cb === 'function') cb({ error: '대기실 상태가 아닙니다.' });
        return;
      }
      if (room.hostSessionId !== socket.data.sessionId) {
        if (typeof cb === 'function') cb({ error: '방장만 게임을 시작할 수 있습니다.' });
        return;
      }

      if (fillWithAI) {
        let aiIdx = 0;
        while (room.players.length < room.maxPlayers) {
          const baseName = AI_NAMES[aiIdx % AI_NAMES.length];
          aiIdx++;
          room.players.push({
            sessionId: `ai-${room.code}-${aiIdx}`,
            socketId: null,
            name: baseName,
            isAI: true,
            connected: true,
            rack: Array(20).fill(null),
            hasMelded: false,
          });
        }
      }

      if (room.players.length < 2) {
        if (typeof cb === 'function') cb({ error: '최소 2명 이상 필요합니다. (AI로 채우기를 이용해 보세요)' });
        return;
      }

      startGameInRoom(room);
      broadcastLobbyUpdate();
      if (typeof cb === 'function') cb({ ok: true });
    } catch (err) {
      console.error('[room:start error]', err);
      if (typeof cb === 'function') cb({ error: '게임 시작 중 오류가 발생했습니다.' });
    }
  });

  // 8. Leave Room
  socket.on('room:leave', () => {
    detachSocketFromCurrentRoom(socket, false);
  });

  // 9. Close Room (Host can end game anytime)
  socket.on('room:close', (_payload, cb) => {
    try {
      const room = rooms.get(socket.data.roomCode);
      if (!room || room.phase === 'ended') {
        if (typeof cb === 'function') cb({ error: '종료할 방이 없습니다.' });
        return;
      }
      if (room.hostSessionId !== socket.data.sessionId) {
        if (typeof cb === 'function') cb({ error: '방장만 게임을 종료할 수 있습니다.' });
        return;
      }
      const host = room.players.find((p) => p.sessionId === room.hostSessionId);
      closeRoomByHost(room, host ? host.name : socket.data.name || '방장');
      if (typeof cb === 'function') cb({ ok: true });
    } catch (err) {
      console.error('[room:close error]', err);
      if (typeof cb === 'function') cb({ error: '게임 종료 처리 중 오류가 발생했습니다.' });
    }
  });

  // 10. In-Room Chat
  socket.on('room:chat', ({ text } = {}, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase === 'ended') return;
    const cleanText = sanitizeChatText(text);
    if (!cleanText) return;
    const isSpectator = room.spectators.some((s) => s.sessionId === socket.data.sessionId);
    pushRoomMessage(room, {
      type: 'chat',
      senderName: socket.data.name || '플레이어',
      sessionId: socket.data.sessionId || socket.id,
      isSpectator,
      text: cleanText,
      timestamp: Date.now(),
    });
    if (typeof cb === 'function') cb({ ok: true });
  });

  // 11. Sync Rack Order
  socket.on('game:syncRack', ({ rack } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'playing' || !Array.isArray(rack)) return;
    const player = room.players.find((p) => !p.isAI && p.sessionId === socket.data.sessionId);
    if (!player) return;

    const oldIds = getRackTiles(player).map((t) => t.id).sort((a, b) => a - b);
    const newTiles = rack.filter(Boolean);
    const newIds = newTiles.map((t) => t.id).sort((a, b) => a - b);
    if (oldIds.length !== newIds.length) return;
    for (let i = 0; i < oldIds.length; i++) {
      if (oldIds[i] !== newIds[i]) return;
    }

    const tileMap = new Map(getRackTiles(player).map((t) => [t.id, t]));
    player.rack = rack.map((t) => (t ? tileMap.get(t.id) || null : null));
  });

  // 12. Sync Board + Rack Move
  socket.on('game:syncMove', ({ board, rack } = {}, cb) => {
    try {
      const room = rooms.get(socket.data.roomCode);
      if (!room || room.phase !== 'playing') {
        if (typeof cb === 'function') cb({ error: '게임 진행 중이 아닙니다.' });
        return;
      }
      const curr = room.players[room.currentPlayerIndex];
      if (!curr || curr.isAI || curr.sessionId !== socket.data.sessionId) {
        if (typeof cb === 'function') cb({ error: '내 차례가 아닙니다.' });
        return;
      }
      if (!Array.isArray(board) || board.length !== GRID_ROWS || !Array.isArray(rack)) {
        if (typeof cb === 'function') cb({ error: '잘못된 보드 데이터입니다.' });
        return;
      }

      const authTileMap = new Map();
      for (let r = 0; r < GRID_ROWS; r++) {
        for (let c = 0; c < GRID_COLS; c++) {
          if (room.board[r][c]) authTileMap.set(room.board[r][c].id, room.board[r][c]);
        }
      }
      for (const t of getRackTiles(curr)) authTileMap.set(t.id, t);

      const seenIds = new Set();
      const sanitizedBoard = createEmptyBoard();
      for (let r = 0; r < GRID_ROWS; r++) {
        if (!Array.isArray(board[r]) || board[r].length !== GRID_COLS) {
          if (typeof cb === 'function') cb({ error: '보드 행 크기가 올바르지 않습니다.' });
          return;
        }
        for (let c = 0; c < GRID_COLS; c++) {
          const t = board[r][c];
          if (t) {
            const auth = authTileMap.get(t.id);
            if (!auth || seenIds.has(auth.id)) {
              if (typeof cb === 'function') cb({ error: '타일 무결성 검증에 실패했습니다.' });
              broadcastRoom(room);
              return;
            }
            seenIds.add(auth.id);
            sanitizedBoard[r][c] = auth;
          }
        }
      }

      const sanitizedRack = [];
      for (let i = 0; i < rack.length; i++) {
        const t = rack[i];
        if (!t) {
          sanitizedRack.push(null);
          continue;
        }
        const auth = authTileMap.get(t.id);
        if (!auth || seenIds.has(auth.id)) {
          if (typeof cb === 'function') cb({ error: '타일 무결성 검증에 실패했습니다.' });
          broadcastRoom(room);
          return;
        }
        if (!room.playedFromRackIds.has(auth.id)) {
          if (typeof cb === 'function') cb({ error: '바닥에 원래 있던 타일은 내 패로 가져올 수 없습니다.' });
          broadcastRoom(room);
          return;
        }
        seenIds.add(auth.id);
        sanitizedRack.push(auth);
      }

      if (seenIds.size !== authTileMap.size) {
        if (typeof cb === 'function') cb({ error: '누락된 타일이 감지되어 복구했습니다.' });
        broadcastRoom(room);
        return;
      }

      room.board = sanitizedBoard;
      curr.rack = sanitizedRack;
      broadcastRoom(room);
      if (typeof cb === 'function') cb({ ok: true });
    } catch (err) {
      console.error('[game:syncMove error]', err);
      if (typeof cb === 'function') cb({ error: '이동 처리 중 오류가 발생했습니다.' });
    }
  });

  // 13. Remote Drag Preview
  socket.on('game:dragPreview', (payload = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'playing') return;
    const curr = room.players[room.currentPlayerIndex];
    if (!curr || curr.isAI || curr.sessionId !== socket.data.sessionId) return;
    socket.to(room.code).emit('game:remoteDrag', payload);
  });

  // 14. End Turn
  socket.on('game:endTurn', (_payload, cb) => {
    try {
      const room = rooms.get(socket.data.roomCode);
      if (!room || room.phase !== 'playing') {
        if (typeof cb === 'function') cb({ error: '게임 진행 중이 아닙니다.' });
        return;
      }
      const curr = room.players[room.currentPlayerIndex];
      if (!curr || curr.isAI || curr.sessionId !== socket.data.sessionId) {
        if (typeof cb === 'function') cb({ error: '내 차례가 아닙니다.' });
        return;
      }

      const evalRes = evaluateTurnState(room);

      if (evalRes.playedCount === 0 && evalRes.allValid) {
        if (room.pool.length > 0) {
          drawTileFromPool(room, curr);
          room.consecutivePasses++;
          if (typeof cb === 'function') cb({ ok: true, action: 'draw' });
          advanceToNextPlayer(room, { msg: `${curr.name}님이 타일 1장을 뽑았습니다.`, tone: 'info' });
        } else {
          room.consecutivePasses++;
          if (typeof cb === 'function') cb({ ok: true, action: 'pass' });
          advanceToNextPlayer(room, { msg: `${curr.name}님이 패스했습니다.`, tone: 'info' });
        }
        return;
      }

      if (evalRes.canConfirm) {
        if (typeof cb === 'function') cb({ ok: true, action: 'confirm' });
        confirmTurnSuccess(room);
        return;
      }

      if (typeof cb === 'function') cb({ error: evalRes.reason || '유효하지 않은 배치입니다.' });
    } catch (err) {
      console.error('[game:endTurn error]', err);
      if (typeof cb === 'function') cb({ error: '턴 종료 처리 중 오류가 발생했습니다.' });
    }
  });

  // 15. Play Again (Host only)
  socket.on('game:playAgain', (_payload, cb) => {
    try {
      const room = rooms.get(socket.data.roomCode);
      if (!room || room.phase !== 'gameover') {
        if (typeof cb === 'function') cb({ error: '게임 종료 상태가 아닙니다.' });
        return;
      }
      if (room.hostSessionId !== socket.data.sessionId) {
        if (typeof cb === 'function') cb({ error: '방장만 다시 시작할 수 있습니다.' });
        return;
      }
      startGameInRoom(room);
      broadcastLobbyUpdate();
      if (typeof cb === 'function') cb({ ok: true });
    } catch (err) {
      console.error('[game:playAgain error]', err);
      if (typeof cb === 'function') cb({ error: '재시작 중 오류가 발생했습니다.' });
    }
  });

  // 16. Disconnect Cleanup
  socket.on('disconnect', () => {
    try {
      detachSocketFromCurrentRoom(socket, true);
      const sid = socket.data?.sessionId;
      if (sid && lobbyUsers.has(sid)) {
        const entry = lobbyUsers.get(sid);
        entry.socketIds.delete(socket.id);
        if (entry.socketIds.size === 0) {
          lobbyUsers.delete(sid);
          broadcastLobbyUpdate();
        }
      }
    } catch (err) {
      console.error('[disconnect error]', err);
    }
  });
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`The Original Rummikub Multiplayer Server listening on port ${PORT}`);
});
