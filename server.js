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

    // 첫 등록 전(!player.hasMelded): 메이드가 안 된 패나 총합 30점 미만 패를 내려놓은 경우 즉시 자동 회수하고 1장 받기
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
  // 긴 세트부터 배치하면 공간 효율이 훨씬 높음
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

// 타입 t(0..51)를 포함하는 모든 유효한 세트(그룹 3~4장, 런 3~5장) 생성
function generateSetsContainingType(t, avail) {
  const results = [];
  const colorIdx = Math.floor(t / 13);
  const num = (t % 13) + 1;
  const availJokers = avail[JOKER_TYPE];

  // 1) 같은 숫자 다른 색 그룹 (3장, 4장)
  const otherColors = [];
  for (let c = 0; c < 4; c++) {
    if (c !== colorIdx) otherColors.push(c * 13 + (num - 1));
  }

  // 4장 그룹 (4색 모두)
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

  // 3장 그룹 (다른 색 2개 조합)
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
    }
    if (jokersNeeded <= availJokers && jokersNeeded <= 1) {
      const key = [...types].sort((a, b) => a - b).join(',');
      if (!seenGroup3.has(key)) {
        seenGroup3.add(key);
        results.push({ kind: 'group', num, types, points: num * 3, jokers: jokersNeeded });
      }
    }
  }

  // 2) 같은 색 연속 런 (길이 3, 4, 5 — 6장 이상은 3+3 등으로 자동 분할 가능)
  for (let len = 3; len <= 5; len++) {
    const minStart = Math.max(1, num - len + 1);
    const maxStart = Math.min(13 - len + 1, num);
    for (let start = minStart; start <= maxStart; start++) {
      const types = [];
      let jokersNeeded = 0;
      let pts = 0;
      let nonJokers = 0;
      for (let k = 0; k < len; k++) {
        const nVal = start + k;
        const tp = colorIdx * 13 + (nVal - 1);
        pts += nVal;
        if (tp === t || avail[tp] > 0) {
          types.push(tp);
          nonJokers++;
        } else {
          jokersNeeded++;
          types.push(JOKER_TYPE);
        }
      }
      if (nonJokers >= 2 && jokersNeeded <= availJokers && jokersNeeded <= 2) {
        results.push({ kind: 'run', colorIdx, start, len, types, points: pts, jokers: jokersNeeded });
      }
    }
  }

  // 조커를 적게 쓰고 점수가 높은 세트를 먼저 탐색
  results.sort((a, b) => {
    if (a.jokers !== b.jokers) return a.jokers - b.jokers;
    if (a.types.length !== b.types.length) return b.types.length - a.types.length;
    return b.points - a.points;
  });

  return results;
}

// 랙 타일만으로 30점 이상 첫 등록 최적 조합 탐색 (조커 포함)
function solveInitialMeldPro(rackTiles, timeBudgetMs = 55) {
  const opt = new Int8Array(53);
  for (const t of rackTiles) opt[tileToType(t)]++;

  // 후보 세트 목록 생성 (중복 제거)
  const candMap = new Map();
  for (let tp = 0; tp < 52; tp++) {
    if (opt[tp] === 0) continue;
    const sets = generateSetsContainingType(tp, opt);
    for (const s of sets) {
      const key = s.kind === 'run'
        ? `R:${s.colorIdx}:${s.start}:${s.types.join(',')}`
        : `G:${s.num}:${[...s.types].sort((a, b) => a - b).join(',')}`;
      if (!candMap.has(key)) candMap.set(key, s);
    }
  }

  const candidates = Array.from(candMap.values());
  candidates.sort((a, b) => {
    if (a.jokers !== b.jokers) return a.jokers - b.jokers;
    return b.points - a.points;
  });

  const deadline = Date.now() + timeBudgetMs;
  const totalRack = rackTiles.length;
  let best = null;
  let bestScore = -Infinity;
  const chosen = [];

  function canUse(set) {
    // 같은 타입 중복 사용 체크 (그룹/런은 같은 정상 타입을 두 번 쓰지 않지만 조커는 최대 2장 가능)
    let jNeed = 0;
    for (const tp of set.types) {
      if (tp === JOKER_TYPE) jNeed++;
      else if (opt[tp] <= 0) return false;
    }
    return opt[JOKER_TYPE] >= jNeed;
  }

  function applySet(set, delta) {
    for (const tp of set.types) opt[tp] += delta;
  }

  function dfs(idx, curPoints, curTiles, curJokers) {
    if (curPoints >= 30) {
      const winBonus = curTiles === totalRack ? 100000 : 0;
      const score = winBonus + curTiles * 100 + curPoints * 2 - curJokers * 28;
      if (score > bestScore) {
        bestScore = score;
        best = {
          sets: chosen.map((s) => s),
          points: curPoints,
          tilesUsed: curTiles,
        };
      }
      if (curTiles === totalRack) return;
    }
    if (idx >= candidates.length || Date.now() > deadline) return;

    for (let i = idx; i < candidates.length; i++) {
      if (Date.now() > deadline) return;
      const s = candidates[i];
      if (!canUse(s)) continue;
      applySet(s, -1);
      chosen.push(s);
      dfs(i, curPoints + s.points, curTiles + s.types.length, curJokers + s.jokers);
      chosen.pop();
      applySet(s, 1);
      if (best && best.tilesUsed === totalRack) return;
    }
  }

  dfs(0, 0, 0, 0);
  if (!best) return null;

  // 추상 세트를 실제 랙 타일 객체로 매핑
  const pools = Array.from({ length: 53 }, () => []);
  for (const t of rackTiles) pools[tileToType(t)].push(t);

  const concreteSets = [];
  for (const s of best.sets) {
    const tiles = [];
    for (const tp of s.types) {
      const obj = pools[tp].pop();
      if (!obj) return null;
      tiles.push(obj);
    }
    if (!validateSet(tiles).valid) return null;
    concreteSets.push(tiles);
  }

  return { sets: concreteSets, points: best.points, tilesUsed: best.tilesUsed };
}

// 바닥 패(필수) + 내 패(선택)를 재조합하여 최대한 많은 내 패를 내려놓는 고수 솔버
function solveRecombinationPro(boardGroups, rackTiles, timeBudgetMs = 80) {
  const rackColors = new Set(rackTiles.filter((t) => !t.isJoker).map((t) => t.color));
  const rackNums = new Set(rackTiles.filter((t) => !t.isJoker).map((t) => t.num));
  const hasRackJoker = rackTiles.some((t) => t.isJoker);

  // 내 패와 연관이 있는 바닥 그룹만 추려서 탐색 공간 최소화
  const scoredGroups = boardGroups.map((g, idx) => {
    let relevance = 0;
    const hasBoardJoker = g.tiles.some((t) => t.isJoker);
    if (hasBoardJoker) relevance += 50;
    if (g.tiles.length >= 4) relevance += 15;
    for (const t of g.tiles) {
      if (t.isJoker) continue;
      if (rackNums.has(t.num)) relevance += 12;
      if (rackColors.has(t.color)) relevance += 4;
    }
    if (hasRackJoker) relevance += 5;
    return { g, idx, relevance };
  });

  scoredGroups.sort((a, b) => b.relevance - a.relevance);
  const maxActiveGroups = 9;
  const activeSet = new Set();
  for (const item of scoredGroups) {
    if (item.relevance > 0 && activeSet.size < maxActiveGroups) {
      activeSet.add(item.idx);
    }
  }

  const activeGroups = [];
  const untouchedGroups = [];
  boardGroups.forEach((g, idx) => {
    if (activeSet.has(idx)) activeGroups.push(g);
    else untouchedGroups.push(g);
  });

  const activeBoardTiles = activeGroups.flatMap((g) => g.tiles);
  const req = new Int8Array(53);
  const opt = new Int8Array(53);
  const avail = new Int8Array(53);

  for (const t of activeBoardTiles) {
    const tp = tileToType(t);
    req[tp]++;
    avail[tp]++;
  }
  for (const t of rackTiles) {
    const tp = tileToType(t);
    opt[tp]++;
    avail[tp]++;
  }

  const totalRack = rackTiles.length;
  const deadline = Date.now() + timeBudgetMs;
  let best = null;
  let bestScore = -Infinity;
  const currentSets = [];

  // 남은 순수 랙 타일들로 추가 세트 및 기존 세트 확장(탐욕적 마무리)
  function tryGreedilyAddRemainingRack(setsCopy, remOpt) {
    const extraSets = [...setsCopy];
    const usedOptCount = { count: 0, pts: 0, jokers: 0 };

    // 1) 이미 만들어진 세트에 남은 랙 타일 붙이기 (런 양끝 연장 / 3장 그룹 4장화)
    let extended = true;
    while (extended) {
      extended = false;
      for (let i = 0; i < extraSets.length; i++) {
        const s = extraSets[i];
        if (s.kind === 'group' && s.types.length === 3) {
          for (let c = 0; c < 4; c++) {
            const tp = c * 13 + (s.num - 1);
            if (remOpt[tp] > 0 && !s.types.includes(tp)) {
              remOpt[tp]--;
              extraSets[i] = { ...s, types: [...s.types, tp], points: s.points + s.num };
              usedOptCount.count++;
              usedOptCount.pts += s.num;
              extended = true;
              break;
            }
          }
        } else if (s.kind === 'run' && s.types.length < 13) {
          if (s.start + s.len <= 13) {
            const rightTp = s.colorIdx * 13 + (s.start + s.len - 1);
            if (remOpt[rightTp] > 0) {
              remOpt[rightTp]--;
              const nVal = s.start + s.len;
              extraSets[i] = { ...s, len: s.len + 1, types: [...s.types, rightTp], points: s.points + nVal };
              usedOptCount.count++;
              usedOptCount.pts += nVal;
              extended = true;
              continue;
            }
          }
          if (s.start > 1) {
            const leftTp = s.colorIdx * 13 + (s.start - 2);
            if (remOpt[leftTp] > 0) {
              remOpt[leftTp]--;
              const nVal = s.start - 1;
              extraSets[i] = { ...s, start: nVal, len: s.len + 1, types: [leftTp, ...s.types], points: s.points + nVal };
              usedOptCount.count++;
              usedOptCount.pts += nVal;
              extended = true;
              continue;
            }
          }
        }
      }
    }

    // 2) 남은 랙 타일만으로 만들 수 있는 새 세트 추가
    let addedNew = true;
    while (addedNew) {
      addedNew = false;
      let bestPure = null;
      for (let tp = 0; tp < 52; tp++) {
        if (remOpt[tp] <= 0) continue;
        const cands = generateSetsContainingType(tp, remOpt);
        for (const c of cands) {
          if (!bestPure || (c.jokers < bestPure.jokers) || (c.jokers === bestPure.jokers && c.types.length > bestPure.types.length)) {
            bestPure = c;
          }
        }
      }
      if (bestPure) {
        for (const tp of bestPure.types) remOpt[tp]--;
        extraSets.push(bestPure);
        usedOptCount.count += bestPure.types.length;
        usedOptCount.pts += bestPure.points;
        usedOptCount.jokers += bestPure.jokers;
        addedNew = true;
      }
    }

    // 3) 남은 랙 조커가 있고, 승리할 수 있다면(남은 랙이 조커뿐) 기존 세트에 붙여 승리!
    let remTotal = 0;
    for (let i = 0; i < 53; i++) remTotal += remOpt[i];
    if (remOpt[JOKER_TYPE] > 0 && remTotal === remOpt[JOKER_TYPE]) {
      for (let i = 0; i < extraSets.length && remOpt[JOKER_TYPE] > 0; i++) {
        const s = extraSets[i];
        if (s.kind === 'group' && s.types.length < 4) {
          remOpt[JOKER_TYPE]--;
          extraSets[i] = { ...s, types: [...s.types, JOKER_TYPE], points: s.points + s.num, jokers: s.jokers + 1 };
          usedOptCount.count++;
          usedOptCount.pts += s.num;
          usedOptCount.jokers++;
        } else if (s.kind === 'run' && s.start + s.len <= 13) {
          remOpt[JOKER_TYPE]--;
          const nVal = s.start + s.len;
          extraSets[i] = { ...s, len: s.len + 1, types: [...s.types, JOKER_TYPE], points: s.points + nVal, jokers: s.jokers + 1 };
          usedOptCount.count++;
          usedOptCount.pts += nVal;
          usedOptCount.jokers++;
        } else if (s.kind === 'run' && s.start > 1) {
          remOpt[JOKER_TYPE]--;
          const nVal = s.start - 1;
          extraSets[i] = { ...s, start: nVal, len: s.len + 1, types: [JOKER_TYPE, ...s.types], points: s.points + nVal, jokers: s.jokers + 1 };
          usedOptCount.count++;
          usedOptCount.pts += nVal;
          usedOptCount.jokers++;
        }
      }
    }

    return { sets: extraSets, extraCount: usedOptCount.count, extraPts: usedOptCount.pts, extraJokers: usedOptCount.jokers };
  }

  function evaluateSolution(usedRackCount, usedRackPts, usedRackJokers) {
    const remOpt = new Int8Array(opt);
    const finalized = tryGreedilyAddRemainingRack(currentSets, remOpt);
    const totalUsed = usedRackCount + finalized.extraCount;
    if (totalUsed <= 0) return;

    const totalPts = usedRackPts + finalized.extraPts;
    const totalJokers = usedRackJokers + finalized.extraJokers;
    const isWin = totalUsed === totalRack;
    const score = (isWin ? 100000 : 0) + totalUsed * 120 + totalPts * 2 - totalJokers * 20;

    if (score > bestScore) {
      bestScore = score;
      best = {
        sets: finalized.sets,
        rackTilesUsed: totalUsed,
        isWin,
      };
    }
  }

  function dfs(usedRackCount, usedRackPts, usedRackJokers) {
    if (Date.now() > deadline) return;
    if (best && best.isWin) return;

    // 아직 배치되지 않은 필수(바닥) 정상 타일 찾기
    let targetType = -1;
    for (let i = 0; i < 52; i++) {
      if (req[i] > 0) {
        targetType = i;
        break;
      }
    }

    if (targetType === -1) {
      // 모든 바닥 정상 타일이 배치됨! 바닥 조커가 남아있다면 기존 세트에 부착하거나 랙과 조합
      if (req[JOKER_TYPE] > 0) {
        const jRem = req[JOKER_TYPE];
        // 바닥 조커를 현재 세트 중 하나에 끼워 넣기 시도
        let attached = 0;
        const backups = [];
        for (let i = 0; i < currentSets.length && attached < jRem; i++) {
          const s = currentSets[i];
          if (s.kind === 'group' && s.types.length < 4) {
            backups.push({ idx: i, prev: s });
            currentSets[i] = { ...s, types: [...s.types, JOKER_TYPE], points: s.points + s.num, jokers: s.jokers + 1 };
            attached++;
          } else if (s.kind === 'run' && s.start + s.len <= 13) {
            backups.push({ idx: i, prev: s });
            const nVal = s.start + s.len;
            currentSets[i] = { ...s, len: s.len + 1, types: [...s.types, JOKER_TYPE], points: s.points + nVal, jokers: s.jokers + 1 };
            attached++;
          } else if (s.kind === 'run' && s.start > 1) {
            backups.push({ idx: i, prev: s });
            const nVal = s.start - 1;
            currentSets[i] = { ...s, start: nVal, len: s.len + 1, types: [JOKER_TYPE, ...s.types], points: s.points + nVal, jokers: s.jokers + 1 };
            attached++;
          }
        }
        if (attached === jRem) {
          evaluateSolution(usedRackCount, usedRackPts, usedRackJokers);
        }
        for (const b of backups) currentSets[b.idx] = b.prev;
        return;
      }

      evaluateSolution(usedRackCount, usedRackPts, usedRackJokers);
      return;
    }

    const candidates = generateSetsContainingType(targetType, avail);
    for (const s of candidates) {
      if (Date.now() > deadline) return;

      // 적용 시 req 우선 소진, 부족한 만큼 opt(랙) 소진
      let jNeeded = 0;
      let ok = true;
      for (const tp of s.types) {
        if (tp === JOKER_TYPE) jNeeded++;
        else if (avail[tp] <= 0) { ok = false; break; }
      }
      if (!ok || avail[JOKER_TYPE] < jNeeded) continue;

      const deltaReq = [];
      const deltaOpt = [];
      let addRackCnt = 0;
      let addRackPts = 0;
      let addRackJokers = 0;

      for (const tp of s.types) {
        avail[tp]--;
        if (req[tp] > 0) {
          req[tp]--;
          deltaReq.push(tp);
        } else {
          opt[tp]--;
          deltaOpt.push(tp);
          addRackCnt++;
          if (tp === JOKER_TYPE) {
            addRackJokers++;
          } else {
            addRackPts += (tp % 13) + 1;
          }
        }
      }

      currentSets.push(s);
      dfs(usedRackCount + addRackCnt, usedRackPts + addRackPts, usedRackJokers + addRackJokers);
      currentSets.pop();

      for (const tp of deltaReq) { req[tp]++; avail[tp]++; }
      for (const tp of deltaOpt) { opt[tp]++; avail[tp]++; }

      if (best && best.isWin) return;
    }
  }

  dfs(0, 0, 0);

  // 만약 activeGroups 재조합에서 좋은 해를 못 찾았더라도, 순수 랙 세트만 내려놓는 경우도 확인
  if (!best) {
    const remOpt = new Int8Array(opt);
    const pureRes = tryGreedilyAddRemainingRack([], remOpt);
    if (pureRes.extraCount > 0) {
      best = {
        sets: [...activeGroups.map((g) => ({ existingTiles: g.tiles })), ...pureRes.sets],
        rackTilesUsed: pureRes.extraCount,
        isWin: pureRes.extraCount === totalRack,
      };
    }
  }

  if (!best) return null;

  // 추상 세트를 실제 타일 객체로 매핑 (바닥 타일 우선 배정 -> 100% 바닥 타일 보존)
  const boardPools = Array.from({ length: 53 }, () => []);
  const rackPools = Array.from({ length: 53 }, () => []);
  for (const t of activeBoardTiles) boardPools[tileToType(t)].push(t);
  for (const t of rackTiles) rackPools[tileToType(t)].push(t);

  const concreteSets = [];
  const usedRackIds = new Set();

  for (const s of best.sets) {
    if (s.existingTiles) {
      concreteSets.push(s.existingTiles);
      continue;
    }
    const tiles = [];
    for (const tp of s.types) {
      let obj = boardPools[tp].pop();
      if (!obj) {
        obj = rackPools[tp].pop();
        if (!obj) return null;
        usedRackIds.add(obj.id);
      }
      tiles.push(obj);
    }
    if (!validateSet(tiles).valid) return null;
    concreteSets.push(tiles);
  }

  // 안전 검증: 모든 activeBoardTiles가 빠짐없이 쓰였는지 확인
  for (let i = 0; i < 53; i++) {
    if (boardPools[i].length > 0) return null;
  }
  if (usedRackIds.size === 0) return null;

  const nextBoard = layoutRecombinedBoard(untouchedGroups, concreteSets);
  if (!nextBoard) return null;

  const finalGroups = getBoardGroups(nextBoard);
  if (!finalGroups.every((g) => g.valid)) return null;

  return {
    nextBoard,
    usedRackIds,
    recombined: activeGroups.length > 0,
  };
}

function executeAITurn(room) {
  const ai = room.players[room.currentPlayerIndex];
  if (!ai || !ai.isAI || room.phase !== 'playing') return;

  const rackTiles = getRackTiles(ai);

  // ==================== 고수(PRO) AI 실행 ====================
  if (!ai.hasMelded) {
    const meld = solveInitialMeldPro(rackTiles, 55);
    if (meld && meld.sets.length > 0) {
      const simBoard = cloneBoard(room.board);
      const steps = [];
      const placedIds = new Set();
      let ok = true;

      for (const tiles of meld.sets) {
        const spot = findEmptySpotOnBoard(simBoard, tiles.length);
        if (!spot) {
          ok = false;
          break;
        }
        for (let i = 0; i < tiles.length; i++) {
          simBoard[spot.row][spot.col + i] = tiles[i];
          placedIds.add(tiles[i].id);
        }
        steps.push({ row: spot.row, col: spot.col, tiles });
      }

      if (ok && steps.length > 0) {
        room.aiStepTimeouts = [];
        steps.forEach((step, idx) => {
          const tId = setTimeout(() => {
            if (room.phase !== 'playing' || room.players[room.currentPlayerIndex] !== ai) return;
            const stepIds = new Set();
            for (let i = 0; i < step.tiles.length; i++) {
              room.board[step.row][step.col + i] = step.tiles[i];
              stepIds.add(step.tiles[i].id);
            }
            ai.rack = ai.rack.map((t) => (t && stepIds.has(t.id) ? null : t));
            room.recentAITileIds = stepIds;
            broadcastRoom(room);
          }, idx * 550);
          room.aiStepTimeouts.push(tId);
        });

        const finishId = setTimeout(() => {
          if (room.phase !== 'playing' || room.players[room.currentPlayerIndex] !== ai) return;
          ai.hasMelded = true;
          room.consecutivePasses = 0;
          if (getRackTiles(ai).length === 0) {
            triggerGameOver(room, ai, `${ai.name} 승리!`);
            return;
          }
          advanceToNextPlayer(room, { msg: `${ai.name}님이 ${meld.points}점으로 첫 등록했습니다! 🧠`, tone: 'success' });
        }, steps.length * 550 + 250);
        room.aiStepTimeouts.push(finishId);
        return;
      }
    }
  } else {
    const boardGroups = getBoardGroups(room.board);
    const solved = solveRecombinationPro(boardGroups, rackTiles, 80);
    if (solved && solved.usedRackIds.size > 0) {
      const nextRack = ai.rack.map((t) => (t && solved.usedRackIds.has(t.id) ? null : t));
      const verified = verifyBoardAndRackMove(room, ai, solved.nextBoard, nextRack);
      if (verified) {
        room.board = verified.board;
        ai.rack = verified.rack;
        room.recentAITileIds = new Set(solved.usedRackIds);
        room.consecutivePasses = 0;
        broadcastRoom(room);

        const count = solved.usedRackIds.size;
        const finishId = setTimeout(() => {
          if (room.phase !== 'playing' || room.players[room.currentPlayerIndex] !== ai) return;
          if (getRackTiles(ai).length === 0) {
            triggerGameOver(room, ai, `${ai.name} 승리!`);
            return;
          }
          const msg = solved.recombined
            ? `${ai.name}님이 바닥 패를 재조합해 타일 ${count}개를 내려놓았습니다! 🧠`
            : `${ai.name}님이 타일 ${count}개를 내려놓았습니다.`;
          advanceToNextPlayer(room, { msg, tone: 'info' });
        }, 600);
        room.aiStepTimeouts = [finishId];
        return;
      }
    }
  }

  if (room.pool.length > 0) {
    drawTileFromPool(room, ai);
  }
  room.recentAITileIds = new Set();
  room.consecutivePasses++;
  advanceToNextPlayer(room, { msg: `${ai.name}님이 타일 1장을 뽑았습니다.`, tone: 'info' });
}

// ==================== ANTI-CHEAT CONSERVATION CHECKS ====================
function verifyRackOrderOnly(oldRack, newRack) {
  if (!Array.isArray(newRack) || newRack.length < 20 || newRack.length > 120) return null;
  const oldMap = new Map();
  for (const t of oldRack) {
    if (t) oldMap.set(t.id, t);
  }
  const seen = new Set();
  const sanitized = newRack.map((t) => {
    if (!t) return null;
    if (!oldMap.has(t.id) || seen.has(t.id)) return undefined;
    seen.add(t.id);
    return oldMap.get(t.id);
  });
  if (sanitized.includes(undefined) || seen.size !== oldMap.size) return null;
  return sanitized;
}

function verifyBoardAndRackMove(room, player, newBoard, newRack) {
  if (!Array.isArray(newBoard) || newBoard.length !== GRID_ROWS) return null;
  if (!Array.isArray(newRack) || newRack.length < 20 || newRack.length > 120) return null;

  const allowedMap = new Map();
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (room.board[r][c]) allowedMap.set(room.board[r][c].id, room.board[r][c]);
    }
  }
  for (const t of player.rack) {
    if (t) allowedMap.set(t.id, t);
  }

  const seen = new Set();
  const cleanBoard = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    if (!Array.isArray(newBoard[r]) || newBoard[r].length !== GRID_COLS) return null;
    const row = [];
    for (let c = 0; c < GRID_COLS; c++) {
      const cell = newBoard[r][c];
      if (!cell) {
        row.push(null);
      } else {
        if (!allowedMap.has(cell.id) || seen.has(cell.id)) return null;
        seen.add(cell.id);
        row.push(allowedMap.get(cell.id));
      }
    }
    cleanBoard.push(row);
  }

  const cleanRack = [];
  for (const cell of newRack) {
    if (!cell) {
      cleanRack.push(null);
    } else {
      if (!allowedMap.has(cell.id) || seen.has(cell.id)) return null;
      if (!room.playedFromRackIds.has(cell.id)) return null;
      seen.add(cell.id);
      cleanRack.push(allowedMap.get(cell.id));
    }
  }

  if (seen.size !== allowedMap.size) return null;
  return { board: cleanBoard, rack: cleanRack };
}

// ==================== SOCKET.IO HANDLERS ====================
function cleanupRoomIfEmpty(code) {
  const room = rooms.get(code);
  if (!room) return;
  const anyHumanConnected = room.players.some((p) => !p.isAI && p.connected);
  if (!anyHumanConnected) {
    if (room.cleanupTimeout) clearTimeout(room.cleanupTimeout);
    room.cleanupTimeout = setTimeout(() => {
      const r = rooms.get(code);
      if (r && !r.players.some((p) => !p.isAI && p.connected)) {
        clearRoomTimers(r);
        rooms.delete(code);
        broadcastLobbyUpdate();
      }
    }, 1000 * 60 * 10);
  }
}

io.on('connection', (socket) => {
  socket.on('lobby:enter', ({ name, sessionId } = {}, cb = () => {}) => {
    const cleanName = String(name || '플레이어').trim().slice(0, 14) || '플레이어';
    const sid = String(sessionId || socket.id);
    const prev = lobbyUsers.get(socket.id);

    socket.data.playerName = cleanName;
    socket.data.sessionId = sid;
    socket.join('lobby');
    lobbyUsers.set(socket.id, { sessionId: sid, name: cleanName, socketId: socket.id });

    if (!prev) {
      pushLobbySystemMessage(`${cleanName}님이 루미큐브 클럽에 입장했습니다.`);
    } else if (prev.name !== cleanName) {
      pushLobbySystemMessage(`${prev.name}님이 닉네임을 ${cleanName}(으)로 변경했습니다.`);
    }

    cb({
      ok: true,
      name: cleanName,
      messages: lobbyMessages,
      users: getLobbyUsersList(),
      rooms: getPublicRoomsList(),
    });
    broadcastLobbyUpdate();
  });

  socket.on('lobby:chat', ({ text } = {}, cb = () => {}) => {
    const cleanText = String(text || '').trim().slice(0, 200);
    if (!cleanText) return cb({ error: '메시지를 입력하세요.' });

    const senderName = socket.data.playerName || '플레이어';
    const sid = socket.data.sessionId || socket.id;
    pushLobbyMessage({
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'chat',
      senderName,
      sessionId: sid,
      text: cleanText,
      roomCode: null,
      timestamp: Date.now(),
    });
    cb({ ok: true });
  });

  socket.on('lobby:getRooms', (_payload, cb = () => {}) => {
    cb({
      ok: true,
      users: getLobbyUsersList(),
      rooms: getPublicRoomsList(),
    });
  });

  socket.on('room:create', ({ name, maxPlayers, sessionId }, cb = () => {}) => {
    const cleanName = String(name || socket.data.playerName || '플레이어').trim().slice(0, 14) || '플레이어';
    const maxP = Math.max(2, Math.min(4, parseInt(maxPlayers, 10) || 4));
    const sid = String(sessionId || socket.id);
    const code = generateRoomCode();

    const room = {
      code,
      createdAt: Date.now(),
      phase: 'waiting',
      maxPlayers: maxP,
      aiDifficulty: 'pro',
      hostSessionId: sid,
      players: [
        {
          sessionId: sid,
          socketId: socket.id,
          name: cleanName,
          isAI: false,
          connected: true,
          hasMelded: false,
          rack: [],
        },
      ],
      pool: [],
      board: createEmptyBoard(),
      currentPlayerIndex: 0,
      turnSnapshot: null,
      playedFromRackIds: new Set(),
      recentAITileIds: new Set(),
      consecutivePasses: 0,
      finalRoundJustTriggered: false,
      finalRoundTurnsLeft: null,
      finalRoundTriggerName: null,
      finalRoundTriggerSessionId: null,
      timeLeft: TURN_SECONDS,
      timerInterval: null,
      aiTimeout: null,
      aiStepTimeouts: [],
      cleanupTimeout: null,
      messages: [],
      gameOverData: null,
    };

    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.data.sessionId = sid;
    socket.data.playerName = cleanName;
    socket.join(code);

    cb({ ok: true, code });
    broadcastRoom(room);
    pushLobbySystemMessage(`${cleanName}님이 새 게임방 [${code}] (${maxP}인)을 만들었습니다!`, code);
    broadcastLobbyUpdate();
  });

  socket.on('room:join', ({ code, name, sessionId }, cb = () => {}) => {
    const cleanCode = String(code || '').replace(/\D/g, '').slice(0, 4);
    const room = rooms.get(cleanCode);
    if (!room) return cb({ error: '존재하지 않는 4자리 방 코드입니다.' });

    const cleanName = String(name || socket.data.playerName || '플레이어').trim().slice(0, 14) || '플레이어';
    const sid = String(sessionId || socket.id);

    const existing = room.players.find((p) => p.sessionId === sid);
    if (existing) {
      existing.socketId = socket.id;
      existing.connected = true;
      if (cleanName) existing.name = cleanName;
      if (room.cleanupTimeout) {
        clearTimeout(room.cleanupTimeout);
        room.cleanupTimeout = null;
      }
      socket.data.roomCode = cleanCode;
      socket.data.sessionId = sid;
      socket.join(cleanCode);
      cb({ ok: true, code: cleanCode, reconnected: true });
      broadcastRoom(room, { msg: `${existing.name}님이 다시 접속했습니다.`, tone: 'info' });
      return;
    }

    if (room.phase !== 'waiting') {
      return cb({ error: '이미 게임이 진행 중인 방입니다.' });
    }
    if (room.players.length >= room.maxPlayers) {
      return cb({ error: '방 정원이 가득 찼습니다.' });
    }

    room.players.push({
      sessionId: sid,
      socketId: socket.id,
      name: cleanName,
      isAI: false,
      connected: true,
      hasMelded: false,
      rack: [],
    });

    if (room.cleanupTimeout) {
      clearTimeout(room.cleanupTimeout);
      room.cleanupTimeout = null;
    }
    socket.data.roomCode = cleanCode;
    socket.data.sessionId = sid;
    socket.data.playerName = cleanName;
    socket.join(cleanCode);

    cb({ ok: true, code: cleanCode });
    broadcastRoom(room, { msg: `${cleanName}님이 입장했습니다!`, tone: 'success' });
    broadcastLobbyUpdate();
  });

  socket.on('room:start', ({ fillWithAI = false } = {}, cb = () => {}) => {
    const code = socket.data.roomCode;
    const sid = socket.data.sessionId;
    const room = rooms.get(code);
    if (!room) return cb({ error: '방을 찾을 수 없습니다.' });
    if (room.hostSessionId !== sid) return cb({ error: '방장만 게임을 시작할 수 있습니다.' });

    const res = startGameInRoom(room, Boolean(fillWithAI));
    if (res.error) return cb(res);
    cb({ ok: true });
    broadcastLobbyUpdate();
  });

  socket.on('room:resync', ({ code, sessionId } = {}, cb = () => {}) => {
    const targetCode = String(code || socket.data.roomCode || '').replace(/\D/g, '').slice(0, 4);
    const sid = String(sessionId || socket.data.sessionId || '');
    const room = rooms.get(targetCode);
    if (!room) return cb({ error: '방을 찾을 수 없습니다.' });

    const player = room.players.find((p) => p.sessionId === sid);
    if (!player) return cb({ error: '방 참가자가 아닙니다.' });

    player.socketId = socket.id;
    player.connected = true;
    socket.data.roomCode = targetCode;
    socket.data.sessionId = sid;
    socket.join(targetCode);

    if (room.cleanupTimeout) {
      clearTimeout(room.cleanupTimeout);
      room.cleanupTimeout = null;
    }

    if (room.phase === 'playing' && !room.timerInterval) {
      startTurn(room);
    } else if (room.phase === 'playing' && room.turnDeadline) {
      room.timeLeft = Math.max(0, Math.ceil((room.turnDeadline - Date.now()) / 1000));
    }

    socket.emit('room:state', buildRoomPayloadFor(room, sid));
    socket.emit('game:timer', {
      timeLeft: room.timeLeft,
      currentPlayerIndex: room.currentPlayerIndex,
    });
    cb({ ok: true });
  });

  socket.on('game:syncRack', ({ rack }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'playing') return;
    const player = room.players.find((p) => p.sessionId === socket.data.sessionId);
    if (!player) return;

    const verified = verifyRackOrderOnly(player.rack, rack);
    if (verified) {
      player.rack = verified;
    }
  });

  socket.on('game:syncMove', ({ board, rack }, cb = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'playing') return cb({ error: '게임 진행 중이 아닙니다.' });

    const curr = room.players[room.currentPlayerIndex];
    if (!curr || curr.sessionId !== socket.data.sessionId) {
      return cb({ error: '내 차례가 아닙니다.' });
    }

    const verified = verifyBoardAndRackMove(room, curr, board, rack);
    if (!verified) {
      socket.emit('room:state', buildRoomPayloadFor(room, curr.sessionId));
      return cb({ error: '유효하지 않은 이동입니다.' });
    }

    room.board = verified.board;
    curr.rack = verified.rack;
    cb({ ok: true });
    io.to(room.code).emit('game:remoteDrag', { active: false });
    broadcastRoom(room);
  });

  socket.on('game:dragPreview', (payload = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'playing') return;
    const curr = room.players[room.currentPlayerIndex];
    if (!curr || curr.sessionId !== socket.data.sessionId) return;

    if (!payload.active) {
      socket.to(room.code).emit('game:remoteDrag', { active: false });
      return;
    }

    const row = Number(payload.row);
    const col = Number(payload.col);
    if (!Number.isFinite(row) || !Number.isFinite(col)) return;
    const tiles = Array.isArray(payload.tiles) ? payload.tiles.slice(0, 13) : [];
    if (tiles.length === 0) return;

    socket.to(room.code).emit('game:remoteDrag', {
      active: true,
      playerName: curr.name,
      row: Math.max(0, Math.min(GRID_ROWS - 1, Math.round(row))),
      col: Math.max(0, Math.min(GRID_COLS - 1, Math.round(col))),
      tiles,
    });
  });

  socket.on('room:chat', ({ text } = {}, cb = () => {}) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return cb({ error: '참여 중인 방이 없습니다.' });

    const cleanText = String(text || '').trim().slice(0, 200);
    if (!cleanText) return cb({ error: '메시지를 입력하세요.' });

    const sid = socket.data.sessionId || socket.id;
    const player = room.players.find((p) => p.sessionId === sid);
    const senderName = (player && player.name) || socket.data.playerName || '플레이어';

    const entry = {
      id: `rmsg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      senderName,
      sessionId: sid,
      text: cleanText,
      timestamp: Date.now(),
    };

    if (!Array.isArray(room.messages)) room.messages = [];
    room.messages.push(entry);
    if (room.messages.length > 60) {
      room.messages.splice(0, room.messages.length - 60);
    }

    io.to(room.code).emit('room:chatMessage', entry);
    cb({ ok: true });
  });

  socket.on('game:endTurn', (_payload, cb = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'playing') return cb({ error: '게임 진행 중이 아닙니다.' });

    const curr = room.players[room.currentPlayerIndex];
    if (!curr || curr.sessionId !== socket.data.sessionId) {
      return cb({ error: '내 차례가 아닙니다.' });
    }

    const evalRes = evaluateTurnState(room);
    if (evalRes.playedCount === 0) {
      if (!evalRes.allValid) {
        cb({ error: '바닥에 미완성 세트가 있습니다. 유효하게 맞춘 뒤 뽑아주세요.' });
        return;
      }
      if (room.pool.length > 0) {
        drawTileFromPool(room, curr);
        room.consecutivePasses++;
        cb({ ok: true, action: 'draw' });
        advanceToNextPlayer(room, { msg: `${curr.name}님이 타일 1장을 뽑았습니다.`, tone: 'info' });
      } else {
        room.consecutivePasses++;
        cb({ ok: true, action: 'pass' });
        advanceToNextPlayer(room, { msg: `${curr.name}님이 패스했습니다.`, tone: 'info' });
      }
      return;
    }

    if (evalRes.canConfirm) {
      cb({ ok: true, action: 'confirm' });
      confirmTurnSuccess(room);
      return;
    }

    cb({ error: evalRes.reason });
  });

  socket.on('game:playAgain', (_payload, cb = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb({ error: '방을 찾을 수 없습니다.' });
    if (room.hostSessionId !== socket.data.sessionId) return cb({ error: '방장만 다시 시작할 수 있습니다.' });

    const hadAI = room.players.some((p) => p.isAI);
    const res = startGameInRoom(room, hadAI);
    if (res.error) return cb(res);
    cb({ ok: true });
  });

  socket.on('room:leave', () => {
    const code = socket.data.roomCode;
    const sid = socket.data.sessionId;
    if (!code) return;
    socket.leave(code);
    socket.data.roomCode = null;

    const room = rooms.get(code);
    if (!room) return;

    if (room.phase === 'waiting') {
      room.players = room.players.filter((p) => p.sessionId !== sid);
      if (room.players.length === 0) {
        clearRoomTimers(room);
        rooms.delete(code);
        broadcastLobbyUpdate();
        return;
      }
      if (room.hostSessionId === sid) {
        room.hostSessionId = room.players[0].sessionId;
      }
      broadcastRoom(room);
      broadcastLobbyUpdate();
    } else {
      const p = room.players.find((x) => x.sessionId === sid);
      if (p) {
        p.connected = false;
        p.socketId = null;
        broadcastRoom(room, { msg: `${p.name}님의 연결이 끊어졌습니다.`, tone: 'error' });
      }
      cleanupRoomIfEmpty(code);
      broadcastLobbyUpdate();
    }
  });

  socket.on('disconnect', () => {
    const wasInLobby = lobbyUsers.delete(socket.id);
    if (wasInLobby) broadcastLobbyUpdate();

    const code = socket.data.roomCode;
    const sid = socket.data.sessionId;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    const p = room.players.find((x) => x.sessionId === sid);
    if (p) {
      p.connected = false;
      p.socketId = null;
      if (room.phase === 'waiting') {
        room.players = room.players.filter((x) => x.sessionId !== sid);
        if (room.players.length === 0) {
          clearRoomTimers(room);
          rooms.delete(code);
          broadcastLobbyUpdate();
          return;
        }
        if (room.hostSessionId === sid) {
          room.hostSessionId = room.players[0].sessionId;
        }
      }
      io.to(room.code).emit('game:remoteDrag', { active: false });
      broadcastRoom(room);
      broadcastLobbyUpdate();
      cleanupRoomIfEmpty(code);
    }
  });
});

server.listen(PORT, () => {
  console.log(`The Original Rummikub Multiplayer Server listening on port ${PORT}`);
});
