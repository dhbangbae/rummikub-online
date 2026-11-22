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

const rooms = new Map();

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
    return { canConfirm: false, playedCount: 0, allValid, meldPoints: 0, reason: '내 패를 내려놓거나 우측 + 로 뽑으세요.' };
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
    hostSessionId: room.hostSessionId,
    currentPlayerIndex: room.currentPlayerIndex,
    poolCount: room.pool.length,
    timeLeft: room.timeLeft,
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
}

function startGameInRoom(room, fillWithAI = false) {
  clearRoomTimers(room);

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

  broadcastRoom(room);

  if (!player.isAI && player.socketId) {
    io.to(player.socketId).emit('game:yourTurn', { timeLeft: TURN_SECONDS });
  }

  room.timerInterval = setInterval(() => {
    if (room.phase !== 'playing') {
      clearRoomTimers(room);
      return;
    }
    room.timeLeft--;
    broadcastTimer(room);
    if (room.timeLeft <= 0) {
      handleTurnTimeout(room);
    }
  }, 1000);

  if (player.isAI) {
    room.aiTimeout = setTimeout(() => executeAITurn(room), 1100);
  }
}

function handleTurnTimeout(room) {
  clearRoomTimers(room);
  const player = room.players[room.currentPlayerIndex];
  if (!player || room.phase !== 'playing') return;

  const evalRes = evaluateTurnState(room);
  if (evalRes.canConfirm) {
    confirmTurnSuccess(room, { msg: `${player.name} 시간 종료 — 유효한 배치가 자동 확정되었습니다.`, tone: 'success' });
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
    addTileToRack(player, room.pool.pop());
    drawn++;
  }

  const msg = hasInvalidGroup
    ? `${player.name} 시간 초과! 미완성 패를 회수하고 페널티 ${drawn}장을 받았습니다.`
    : keptMadeOnBoard
      ? `${player.name} 시간 초과! 메이드 패는 유지되고 강제로 ${drawn}장을 받았습니다.`
      : `${player.name} 시간 초과! 강제로 타일 ${drawn}장을 받았습니다.`;

  room.consecutivePasses++;
  advanceToNextPlayer(room, { msg, tone: 'error' });
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

  if (room.pool.length === 0 && room.consecutivePasses >= room.players.length) {
    let bestPlayer = room.players[0];
    let bestScore = Infinity;
    for (const p of room.players) {
      const sum = calcRackPenalty(p);
      if (sum < bestScore) {
        bestScore = sum;
        bestPlayer = p;
      }
    }
    triggerGameOver(room, bestPlayer, '더미 소진! 남은 패 점수가 가장 낮은 플레이어가 승리했습니다.');
    return;
  }

  room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
  if (toast) {
    io.to(room.code).emit('room:toast', toast);
  }
  startTurn(room);
}

function triggerGameOver(room, winner, subtitle) {
  clearRoomTimers(room);
  room.phase = 'gameover';

  let totalLoserPenalty = 0;
  const rows = room.players.map((p) => {
    const penalty = p.sessionId === winner.sessionId ? 0 : calcRackPenalty(p);
    totalLoserPenalty += penalty;
    return {
      name: p.name,
      isAI: p.isAI,
      isWinner: p.sessionId === winner.sessionId,
      penalty,
      leftCount: getRackTiles(p).length,
    };
  });

  room.gameOverData = {
    winnerName: winner.name,
    subtitle,
    totalLoserPenalty,
    rows,
  };

  broadcastRoom(room);
}

// ==================== AI LOGIC ====================
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

function findCandidateSetsFromRack(rackTiles) {
  const candidates = [];
  const byNum = new Map();
  for (const t of rackTiles) {
    if (t.isJoker) continue;
    if (!byNum.has(t.num)) byNum.set(t.num, []);
    byNum.get(t.num).push(t);
  }
  for (const [num, list] of byNum.entries()) {
    const uniq = [];
    const seen = new Set();
    for (const t of list) {
      if (!seen.has(t.color)) {
        seen.add(t.color);
        uniq.push(t);
      }
    }
    if (uniq.length >= 3) candidates.push({ tiles: uniq, points: num * uniq.length });
  }

  for (const color of COLORS) {
    const byN = new Map();
    for (const t of rackTiles) {
      if (!t.isJoker && t.color === color && !byN.has(t.num)) byN.set(t.num, t);
    }
    let n = 1;
    while (n <= 13) {
      if (byN.has(n)) {
        const run = [];
        let pts = 0;
        while (n <= 13 && byN.has(n)) {
          run.push(byN.get(n));
          pts += n;
          n++;
        }
        if (run.length >= 3) candidates.push({ tiles: run, points: pts });
      } else {
        n++;
      }
    }
  }
  candidates.sort((a, b) => b.points - a.points);
  return candidates;
}

function executeAITurn(room) {
  const ai = room.players[room.currentPlayerIndex];
  if (!ai || !ai.isAI || room.phase !== 'playing') return;

  const rackTiles = getRackTiles(ai);
  const placedIds = new Set();
  const candidates = findCandidateSetsFromRack(rackTiles);
  const chosenSets = [];
  const usedIds = new Set();
  let totalPts = 0;

  for (const c of candidates) {
    if (c.tiles.some((t) => usedIds.has(t.id))) continue;
    chosenSets.push(c);
    c.tiles.forEach((t) => usedIds.add(t.id));
    totalPts += c.points;
  }

  if (!ai.hasMelded) {
    if (totalPts >= 30) {
      let ok = true;
      for (const s of chosenSets) {
        const spot = findEmptySpotOnBoard(room.board, s.tiles.length);
        if (!spot) {
          ok = false;
          break;
        }
        for (let i = 0; i < s.tiles.length; i++) {
          room.board[spot.row][spot.col + i] = s.tiles[i];
          placedIds.add(s.tiles[i].id);
        }
      }
      if (ok && placedIds.size > 0) {
        ai.rack = ai.rack.map((t) => (t && placedIds.has(t.id) ? null : t));
        ai.hasMelded = true;
        room.recentAITileIds = placedIds;
        room.consecutivePasses = 0;
        if (getRackTiles(ai).length === 0) {
          triggerGameOver(room, ai, `${ai.name} 승리!`);
          return;
        }
        advanceToNextPlayer(room, { msg: `${ai.name}이(가) ${totalPts}점으로 첫 등록했습니다!`, tone: 'success' });
        return;
      } else {
        room.board = cloneBoard(room.turnSnapshot.board);
        placedIds.clear();
      }
    }
  } else {
    for (const s of chosenSets) {
      const spot = findEmptySpotOnBoard(room.board, s.tiles.length);
      if (spot) {
        for (let i = 0; i < s.tiles.length; i++) {
          room.board[spot.row][spot.col + i] = s.tiles[i];
          placedIds.add(s.tiles[i].id);
        }
      }
    }
    let progress = true;
    while (progress) {
      progress = false;
      const remaining = getRackTiles(ai).filter((t) => !placedIds.has(t.id));
      const groups = getBoardGroups(room.board);
      for (const tile of remaining) {
        if (tile.isJoker) continue;
        let attached = false;
        for (const g of groups) {
          if (g.endCol + 1 < GRID_COLS && !room.board[g.row][g.endCol + 1]) {
            const rightEmpty = g.endCol + 2 >= GRID_COLS || !room.board[g.row][g.endCol + 2];
            if (rightEmpty && validateSet([...g.tiles, tile]).valid) {
              room.board[g.row][g.endCol + 1] = tile;
              placedIds.add(tile.id);
              attached = true;
              progress = true;
              break;
            }
          }
          if (g.startCol - 1 >= 0 && !room.board[g.row][g.startCol - 1]) {
            const leftEmpty = g.startCol - 2 < 0 || !room.board[g.row][g.startCol - 2];
            if (leftEmpty && validateSet([tile, ...g.tiles]).valid) {
              room.board[g.row][g.startCol - 1] = tile;
              placedIds.add(tile.id);
              attached = true;
              progress = true;
              break;
            }
          }
        }
        if (attached) break;
      }
    }

    if (placedIds.size > 0) {
      ai.rack = ai.rack.map((t) => (t && placedIds.has(t.id) ? null : t));
      room.recentAITileIds = placedIds;
      room.consecutivePasses = 0;
      if (getRackTiles(ai).length === 0) {
        triggerGameOver(room, ai, `${ai.name} 승리!`);
        return;
      }
      advanceToNextPlayer(room, { msg: `${ai.name}이(가) 타일 ${placedIds.size}개를 내려놓았습니다.`, tone: 'info' });
      return;
    }
  }

  if (room.pool.length > 0) {
    addTileToRack(ai, room.pool.pop());
  }
  room.recentAITileIds = new Set();
  room.consecutivePasses++;
  advanceToNextPlayer(room, { msg: `${ai.name}이(가) 타일 1장을 뽑았습니다.`, tone: 'info' });
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
      }
    }, 1000 * 60 * 10);
  }
}

io.on('connection', (socket) => {
  socket.on('room:create', ({ name, maxPlayers, sessionId }, cb = () => {}) => {
    const cleanName = String(name || '플레이어').trim().slice(0, 14) || '플레이어';
    const maxP = Math.max(2, Math.min(4, parseInt(maxPlayers, 10) || 4));
    const sid = String(sessionId || socket.id);
    const code = generateRoomCode();

    const room = {
      code,
      phase: 'waiting',
      maxPlayers: maxP,
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
      timeLeft: TURN_SECONDS,
      timerInterval: null,
      aiTimeout: null,
      cleanupTimeout: null,
      gameOverData: null,
    };

    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.data.sessionId = sid;
    socket.join(code);

    cb({ ok: true, code });
    broadcastRoom(room);
  });

  socket.on('room:join', ({ code, name, sessionId }, cb = () => {}) => {
    const cleanCode = String(code || '').replace(/\D/g, '').slice(0, 4);
    const room = rooms.get(cleanCode);
    if (!room) return cb({ error: '존재하지 않는 4자리 방 코드입니다.' });

    const cleanName = String(name || '플레이어').trim().slice(0, 14) || '플레이어';
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
    socket.join(cleanCode);

    cb({ ok: true, code: cleanCode });
    broadcastRoom(room, { msg: `${cleanName}님이 입장했습니다!`, tone: 'success' });
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
    broadcastRoom(room);
  });

  socket.on('game:endTurn', (_payload, cb = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'playing') return cb({ error: '게임 진행 중이 아닙니다.' });

    const curr = room.players[room.currentPlayerIndex];
    if (!curr || curr.sessionId !== socket.data.sessionId) {
      return cb({ error: '내 차례가 아닙니다.' });
    }

    const evalRes = evaluateTurnState(room);
    if (evalRes.playedCount === 0 && !hasBoardChangedFromSnapshot(room)) {
      if (room.pool.length > 0) {
        addTileToRack(curr, room.pool.pop());
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
        return;
      }
      if (room.hostSessionId === sid) {
        room.hostSessionId = room.players[0].sessionId;
      }
      broadcastRoom(room);
    } else {
      const p = room.players.find((x) => x.sessionId === sid);
      if (p) {
        p.connected = false;
        p.socketId = null;
        broadcastRoom(room, { msg: `${p.name}님의 연결이 끊어졌습니다.`, tone: 'error' });
      }
      cleanupRoomIfEmpty(code);
    }
  });

  socket.on('disconnect', () => {
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
          return;
        }
        if (room.hostSessionId === sid) {
          room.hostSessionId = room.players[0].sessionId;
        }
      }
      broadcastRoom(room);
      cleanupRoomIfEmpty(code);
    }
  });
});

server.listen(PORT, () => {
  console.log(`The Original Rummikub Multiplayer Server listening on port ${PORT}`);
});
