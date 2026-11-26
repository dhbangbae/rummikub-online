'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 20000,
  pingTimeout: 25000,
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

// ==================== CONSTANTS ====================
const COLORS = ['black', 'red', 'blue', 'orange'];
const COLOR_ORDER = { black: 0, red: 1, blue: 2, orange: 3 };
const GRID_COLS = 22;
const GRID_ROWS = 8;
const TURN_SECONDS = 40;
const AI_NAMES = ['Congo', 'Daphne', 'Vera'];

const rooms = new Map(); // code -> room
const lobbyUsers = new Map(); // socket.id -> { sessionId, name, socketId }
const lobbyMessages = []; // recent chat & system messages (max 60)
const MAX_LOBBY_MESSAGES = 60;

// ==================== LOBBY CHAT & ROOM LIST HELPERS ====================
function getLobbyUsersList() {
  const bySid = new Map();
  for (const u of lobbyUsers.values()) {
    bySid.set(u.sessionId, { sessionId: u.sessionId, name: u.name });
  }
  return Array.from(bySid.values());
}

function getPublicRoomsList() {
  const list = [];
  for (const room of rooms.values()) {
    const host = room.players.find((p) => p.sessionId === room.hostSessionId) || room.players[0];
    list.push({
      code: room.code,
      phase: room.phase,
      hostName: host ? host.name : '방장',
      playerCount: room.players.length,
      maxPlayers: room.maxPlayers,
      spectatorCount: (room.spectators || []).length,
      createdAt: room.createdAt || 0,
    });
  }
  list.sort((a, b) => {
    if (a.phase === 'waiting' && b.phase !== 'waiting') return -1;
    if (a.phase !== 'waiting' && b.phase === 'waiting') return 1;
    return b.createdAt - a.createdAt;
  });
  return list;
}

function broadcastLobbyUpdate() {
  io.to('lobby').emit('lobby:update', {
    users: getLobbyUsersList(),
    rooms: getPublicRoomsList(),
  });
}

function pushLobbyMessage(entry) {
  lobbyMessages.push(entry);
  if (lobbyMessages.length > MAX_LOBBY_MESSAGES) {
    lobbyMessages.splice(0, lobbyMessages.length - MAX_LOBBY_MESSAGES);
  }
  io.to('lobby').emit('lobby:chatMessage', entry);
}

function pushLobbySystemMessage(text, roomCode = null) {
  pushLobbyMessage({
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'system',
    senderName: '시스템',
    sessionId: null,
    text,
    roomCode,
    timestamp: Date.now(),
  });
}

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

  for (let i = tiles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }
  return tiles;
}

function createEmptyBoard() {
  return Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(null));
}

function cloneBoard(b) {
  return b.map((row) => row.map((t) => (t ? { ...t } : null)));
}

function cloneRack(r) {
  return r.map((t) => (t ? { ...t } : null));
}

function getRackTiles(player) {
  return player.rack.filter(Boolean);
}

function ensureRackCapacity(player) {
  const minSlots = 20;
  const count = getRackTiles(player).length;
  const neededPerRow = Math.max(10, Math.ceil(count / 2) + 2);
  const targetLen = Math.max(minSlots, neededPerRow * 2);
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
    room.finalRoundTriggerSessionId = player.sessionId;
  }
  return tile;
}

function generateRoomCode() {
  for (let tries = 0; tries < 200; tries++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  return String(Math.floor(1000 + Math.random() * 9000));
}

// ==================== RUMMIKUB VALIDATION ====================
function validateSet(tiles) {
  if (!tiles || tiles.length < 3) return { valid: false, type: null, points: 0 };
  const nonJokers = tiles.filter((t) => !t.isJoker);
  if (nonJokers.length === 0) return { valid: false, type: null, points: 0 };

  if (tiles.length <= 4) {
    const num = nonJokers[0].num;
    const allSameNum = nonJokers.every((t) => t.num === num);
    const colorSet = new Set(nonJokers.map((t) => t.color));
    if (allSameNum && colorSet.size === nonJokers.length) {
      return { valid: true, type: 'group', points: num * tiles.length };
    }
  }

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

// ==================== INITIAL RACK SORT ====================
function sortInitialRack(player) {
  const tiles = getRackTiles(player);
  tiles.sort((a, b) => {
    if (a.isJoker !== b.isJoker) return a.isJoker ? 1 : -1;
    if (a.color !== b.color) return COLOR_ORDER[a.color] - COLOR_ORDER[b.color];
    if (a.num !== b.num) return a.num - b.num;
    return a.id - b.id;
  });
  const rack = Array(20).fill(null);
  tiles.forEach((t, idx) => {
    rack[idx] = t;
  });
  player.rack = rack;
}

// ==================== STATE BROADCASTING ====================
function buildRoomPayloadFor(room, targetSessionId) {
  const meIdx = room.players.findIndex((p) => p.sessionId === targetSessionId);
  const me = meIdx >= 0 ? room.players[meIdx] : null;
  const isSpectator = meIdx === -1 && (room.spectators || []).some((s) => s.sessionId === targetSessionId);
  const evalRes = room.phase === 'playing' ? evaluateTurnState(room) : null;

  return {
    code: room.code,
    phase: room.phase,
    maxPlayers: room.maxPlayers,
    aiDifficulty: room.aiDifficulty || 'pro',
    hostSessionId: room.hostSessionId,
    currentPlayerIndex: room.currentPlayerIndex,
    poolCount: room.pool.length,
    timeLeft: room.timeLeft,
    finalRoundTurnsLeft: room.finalRoundTurnsLeft,
    finalRoundTriggerName: room.finalRoundTriggerName,
    board: room.board,
    isSpectator,
    spectators: (room.spectators || []).map((s) => ({
      sessionId: s.sessionId,
      name: s.name,
    })),
    myPlayerIndex: meIdx,
    myRack: me ? me.rack : [],
    playedFromRackIds: Array.from(room.playedFromRackIds),
    recentAITileIds: Array.from(room.recentAITileIds),
    hasBoardChanged: hasBoardChangedFromSnapshot(room),
    evalState: evalRes,
    players: room.players.map((p, idx) => ({
      index: idx,
      sessionId: p.sessionId,
      name: p.name,
      isAI: p.isAI,
      connected: p.connected,
      hasMelded: p.hasMelded,
      tileCount: getRackTiles(p).length,
      isHost: p.sessionId === room.hostSessionId,
      rack: isSpectator ? getRackTiles(p) : undefined,
    })),
    chatMessages: room.messages || [],
    gameOverData: room.gameOverData || null,
  };
}

function broadcastRoom(room, toast = null) {
  for (const p of room.players) {
    if (!p.isAI && p.socketId) {
      const sock = io.sockets.sockets.get(p.socketId);
      if (sock) {
        sock.emit('room:state', buildRoomPayloadFor(room, p.sessionId));
        if (toast) sock.emit('room:toast', toast);
      }
    }
  }
  for (const s of room.spectators || []) {
    if (s.socketId) {
      const sock = io.sockets.sockets.get(s.socketId);
      if (sock) {
        sock.emit('room:state', buildRoomPayloadFor(room, s.sessionId));
        if (toast) sock.emit('room:toast', toast);
      }
    }
  }
}

function pushRoomSystemMessage(room, text) {
  const entry = {
    id: `rsys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'system',
    senderName: '시스템',
    sessionId: null,
    text,
    timestamp: Date.now(),
  };
  if (!Array.isArray(room.messages)) room.messages = [];
  room.messages.push(entry);
  if (room.messages.length > 60) {
    room.messages.splice(0, room.messages.length - 60);
  }
  io.to(room.code).emit('room:chatMessage', entry);
}

function broadcastTimer(room) {
  io.to(room.code).emit('game:timer', {
    timeLeft: room.timeLeft,
    currentPlayerIndex: room.currentPlayerIndex,
  });
}

// ==================== TURN & TIMER ENGINE ====================
function clearRoomTimers(room) {
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
  if (room.aiTimeout) {
    clearTimeout(room.aiTimeout);
    room.aiTimeout = null;
  }
  if (Array.isArray(room.aiStepTimeouts)) {
    room.aiStepTimeouts.forEach((t) => clearTimeout(t));
    room.aiStepTimeouts = [];
  }
}

function startGameInRoom(room, fillWithAI = false) {
  clearRoomTimers(room);

  room.aiDifficulty = 'pro';
  room.players = room.players.filter((p) => !p.isAI);

  if (fillWithAI) {
    let aiIdx = 0;
    while (room.players.length < room.maxPlayers) {
      room.players.push({
        sessionId: `ai-${Date.now()}-${aiIdx}`,
        socketId: null,
        name: AI_NAMES[aiIdx % AI_NAMES.length],
        isAI: true,
        connected: true,
        hasMelded: false,
        rack: [],
      });
      aiIdx++;
    }
  }

  if (room.players.length < 2) {
    return { error: '최소 2명 이상이 필요합니다. 친구를 초대하거나 AI를 채워 시작하세요.' };
  }

  room.phase = 'playing';
  room.pool = createDeck();
  room.board = createEmptyBoard();
  room.currentPlayerIndex = 0;
  room.consecutivePasses = 0;
  room.finalRoundJustTriggered = false;
  room.finalRoundTurnsLeft = null;
  room.finalRoundTriggerName = null;
  room.finalRoundTriggerSessionId = null;
  room.recentAITileIds = new Set();
  room.gameOverData = null;

  for (const p of room.players) {
    p.hasMelded = false;
    p.rack = Array(20).fill(null);
    for (let i = 0; i < 14; i++) {
      p.rack[i] = room.pool.pop();
    }
    sortInitialRack(p);
  }

  startTurn(room);
  return { ok: true };
}

function startTurn(room) {
  clearRoomTimers(room);
  const player = room.players[room.currentPlayerIndex];
  if (!player) return;

  room.turnSnapshot = {
    board: cloneBoard(room.board),
    rack: cloneRack(player.rack),
  };
  room.playedFromRackIds = new Set(getRackTiles(player).map((t) => t.id));
  room.timeLeft = TURN_SECONDS;
  room.turnDeadline = Date.now() + TURN_SECONDS * 1000;
  room.handlingTimeout = false;

  io.to(room.code).emit('game:remoteDrag', { active: false });
  broadcastRoom(room);

  if (room.finalRoundTurnsLeft === 1 && player.sessionId === room.finalRoundTriggerSessionId) {
    io.to(room.code).emit('room:toast', {
      msg: `🔥 마지막 카드를 뽑은 ${player.name}님의 마지막 차례입니다! 턴 종료 시 점수로 등수를 계산합니다.`,
      tone: 'info',
    });
  }

  if (!player.isAI && player.socketId) {
    io.to(player.socketId).emit('game:yourTurn', { timeLeft: TURN_SECONDS });
  }

  room.timerInterval = setInterval(() => {
    try {
      if (room.phase !== 'playing') {
        clearRoomTimers(room);
        return;
      }
      const remaining = Math.max(0, Math.ceil((room.turnDeadline - Date.now()) / 1000));
      room.timeLeft = remaining;
      broadcastTimer(room);
      if (remaining <= 0) {
        handleTurnTimeout(room);
      }
    } catch (err) {
      console.error('[TimerError]', err);
    }
  }, 1000);

  if (player.isAI) {
    room.aiTimeout = setTimeout(() => {
      try {
        executeAITurn(room);
      } catch (err) {
        console.error('[AIError]', err);
        if (room.phase === 'playing') {
          if (room.pool.length > 0) drawTileFromPool(room, player);
          advanceToNextPlayer(room);
        }
      }
    }, 1050);
  }
}

function handleTurnTimeout(room) {
  if (room.handlingTimeout) return;
  room.handlingTimeout = true;
  try {
    clearRoomTimers(room);
    const player = room.players[room.currentPlayerIndex];
    if (!player || room.phase !== 'playing') return;

    const evalRes = evaluateTurnState(room);
    if (evalRes.canConfirm) {
      confirmTurnSuccess(room, { msg: `${player.name} 시간 종료 — 유효한 배치가 자동 확정되었습니다.`, tone: 'success' });
      return;
    }

    if (!player.hasMelded) {
      const hadChanges = hasBoardChangedFromSnapshot(room) || evalRes.playedCount > 0;
      if (hadChanges && room.turnSnapshot) {
        room.board = cloneBoard(room.turnSnapshot.board);
        player.rack = cloneRack(room.turnSnapshot.rack);
      }

      const drawn = room.pool.length > 0 && drawTileFromPool(room, player) ? 1 : 0;
      const msg = hadChanges
        ? `${player.name} 시간 초과! 첫 등록 미완성/30점 미만 패를 자동 회수하고 ${drawn}장을 받았습니다.`
        : `${player.name} 시간 초과! 강제로 타일 ${drawn}장을 받았습니다.`;

      room.consecutivePasses++;
      advanceToNextPlayer(room, { msg, tone: 'error' });
      return;
    }

    const groups = getBoardGroups(room.board);
    const hasInvalidGroup = groups.some((g) => !g.valid);
    let keptMadeOnBoard = false;
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
      } else {
        keptMadeOnBoard = hasBoardChangedFromSnapshot(room);
      }
    } else {
      keptMadeOnBoard = hasBoardChangedFromSnapshot(room);
    }

    const penalty = hasInvalidGroup ? 3 : 1;
    let drawn = 0;
    for (let i = 0; i < penalty && room.pool.length > 0; i++) {
      if (drawTileFromPool(room, player)) drawn++;
    }

    const msg = hasInvalidGroup
      ? `${player.name} 시간 초과! 미완성 패를 회수하고 페널티 ${drawn}장을 받았습니다.`
      : keptMadeOnBoard
        ? `${player.name} 시간 초과! 메이드 패는 유지되고 강제로 ${drawn}장을 받았습니다.`
        : `${player.name} 시간 초과! 강제로 타일 ${drawn}장을 받았습니다.`;

    room.consecutivePasses++;
    advanceToNextPlayer(room, { msg, tone: 'error' });
  } catch (err) {
    console.error('[TimeoutError]', err);
    if (room.phase === 'playing') {
      advanceToNextPlayer(room);
    }
  } finally {
    room.handlingTimeout = false;
  }
}

function confirmTurnSuccess(room, toast = null) {
  clearRoomTimers(room);
  const player = room.players[room.currentPlayerIndex];
  if (!player) return;

  if (!player.hasMelded) player.hasMelded = true;
  room.consecutivePasses = 0;
  room.recentAITileIds = new Set();

  if (getRackTiles(player).length === 0) {
    triggerGameOver(room, player, `${player.name}님이 모든 타일을 가장 먼저 내려놓았습니다!`);
    return;
  }

  advanceToNextPlayer(room, toast || { msg: `${player.name}님이 턴을 완료했습니다.`, tone: 'success' });
}

function advanceToNextPlayer(room, toast = null) {
  clearRoomTimers(room);

  if (room.finalRoundJustTriggered) {
    room.finalRoundJustTriggered = false;
    room.finalRoundTurnsLeft = room.players.length;
    toast = {
      msg: `더미 소진! 다음 사람부터 한 바퀴 돌아 마지막 카드를 뽑은 ${room.finalRoundTriggerName}님 차례가 끝나면 점수로 등수를 계산합니다.`,
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

  let currentRank = 1;
  rows.forEach((r, idx) => {
    if (idx > 0 && r.adjustedScore < rows[idx - 1].adjustedScore) {
      currentRank = idx + 1;
    }
    r.rank = currentRank;
  });

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
    winnerName: result.winner.name,
    winnerSessionId: result.winner.sessionId,
    subtitle,
    minSum: result.minSum,
    totalLoserPenalty: result.totalLoserPenalty,
    rows: result.rows,
  };

  broadcastRoom(room);
}

// ==================== PRO AI ENGINE (SOLVER + RECOMBINATION + JOKER SWAP) ====================
const JOKER_TYPE = 52;

function tileToType(tile) {
  if (tile.isJoker) return JOKER_TYPE;
  return COLOR_ORDER[tile.color] * 13 + (tile.num - 1);
}

function isAreaFreeOnBoard(board, row, col, len) {
  if (row < 0 || row >= GRID_ROWS || col < 0 || col + len > GRID_COLS) return false;
  for (let i = 0; i < len; i++) {
    if (board[row][col + i]) return false;
  }
  return true;
}

function findEmptySpotOnBoard(board, len) {
  const prefRow = Math.floor(GRID_ROWS / 2);
  const prefCol = Math.floor((GRID_COLS - len) / 2);
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

function packGroupsCleanlyOnBoard(groupsTilesList) {
  const board = createEmptyBoard();
  const sorted = [...groupsTilesList].sort((a, b) => b.length - a.length);
  let r = 0;
  let c = 0;
  for (const g of sorted) {
    if (c > 0 && c + g.length > GRID_COLS) {
      r++;
      c = 0;
    }
    if (r >= GRID_ROWS || c + g.length > GRID_COLS) {
      const spot = findEmptySpotOnBoard(board, g.length);
      if (!spot) return null;
      for (let i = 0; i < g.length; i++) board[spot.row][spot.col + i] = g[i];
      continue;
    }
    for (let i = 0; i < g.length; i++) board[r][c + i] = g[i];
    c += g.length + 1;
    if (c >= GRID_COLS) {
      r++;
      c = 0;
    }
  }
  return board;
}

function layoutRecombinedBoard(untouchedGroups, newSets) {
  const board = createEmptyBoard();
  for (const g of untouchedGroups) {
    for (let i = 0; i < g.tiles.length; i++) {
      board[g.row][g.startCol + i] = g.tiles[i];
    }
  }
  let allFit = true;
  for (const tiles of newSets) {
    const spot = findEmptySpotOnBoard(board, tiles.length);
    if (!spot) {
      allFit = false;
      break;
    }
    for (let i = 0; i < tiles.length; i++) {
      board[spot.row][spot.col + i] = tiles[i];
    }
  }
  if (allFit) return board;
  const allGroups = [...untouchedGroups.map((g) => g.tiles), ...newSets];
  return packGroupsCleanlyOnBoard(allGroups);
}

function generateSetsContainingType(t, avail) {
  const results = [];
  const colorIdx = Math.floor(t / 13);
  const num = (t % 13) + 1;
  const availJokers = avail[JOKER_TYPE];

  const otherColors = [];
  for (let c = 0; c < 4; c++) {
    if (c !== colorIdx) otherColors.push(c * 13 + (num - 1));
  }

  {
    const slots = [t, ...otherColors];
    const types = [];
    let jokersNeeded = 0;
    for (const s of slots) {
      if (avail[s] > 0) types.push(s);
      else {
        jokersNeeded++;
        types.push(JOKER_TYPE);
      }
    }
    if (jokersNeeded <= availJokers && jokersNeeded <= 2) {
      results.push({ kind: 'group', num, types, points: num * 4, jokers: jokersNeeded });
    }
  }

  const pairs = [
    [otherColors[0], otherColors[1]],
    [otherColors[0], otherColors[2]],
    [otherColors[1], otherColors[2]],
  ];
  const seenGroup3 = new Set();
  for (const [cA, cB] of pairs) {
    const slots = [t, cA, cB];
    const types = [];
    let jokersNeeded = 0;
    for (const s of slots) {
      if (avail[s] > 0) types.push(s);
      else {
        jokersNeeded++;
        types.push(JOKER_TYPE);
      }
