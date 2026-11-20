'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

app.use(express.static(path.join(__dirname, 'public')));

// ==================== CONSTANTS ====================
const COLORS = ['black', 'red', 'blue', 'orange'];
const GRID_COLS = 22;
const GRID_ROWS = 8;
const TURN_SECONDS = 40;

const rooms = new Map(); // roomCode -> Room

// ==================== DECK & RULE VALIDATION ====================
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
  return b.map(row => row.map(t => (t ? { ...t } : null)));
}

function cloneRack(r) {
  return r.map(t => (t ? { ...t } : null));
}

function getRackTiles(player) {
  return player.rack.filter(Boolean);
}

function addTileToRack(player, tile) {
  while (player.rack.length < 28) player.rack.push(null);
  const idx = player.rack.indexOf(null);
  if (idx !== -1) player.rack[idx] = tile;
  else player.rack.push(tile);
}

function validateSet(tiles) {
  if (!tiles || tiles.length < 3) return { valid: false, type: null, points: 0 };
  const nonJokers = tiles.filter(t => !t.isJoker);
  if (nonJokers.length === 0) return { valid: false, type: null, points: 0 };

  // Group (3~4 same number, distinct colors)
  if (tiles.length <= 4) {
    const num = nonJokers[0].num;
    const allSame = nonJokers.every(t => t.num === num);
    const colorSet = new Set(nonJokers.map(t => t.color));
    if (allSame && colorSet.size === nonJokers.length) {
      return { valid: true, type: 'group', points: num * tiles.length };
    }
  }

  // Run (3~13 same color, consecutive 1..13)
  if (tiles.length <= 13) {
    const color = nonJokers[0].color;
    if (nonJokers.every(t => t.color === color)) {
      const firstIdx = tiles.findIndex(t => !t.isJoker);
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
    let c = 0;
    while (c < GRID_COLS) {
      if (board[r][c]) {
        const startCol = c;
        const tiles = [];
        while (c < GRID_COLS && board[r][c]) {
          tiles.push(board[r][c]);
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

function calcRackPenalty(player) {
  return getRackTiles(player).reduce((acc, t) => acc + (t.isJoker ? 30 : t.num), 0);
}

function hasBoardChanged(boardA, boardB) {
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const a = boardA[r][c];
      const b = boardB[r][c];
      if ((a ? a.id : null) !== (b ? b.id : null)) return true;
    }
  }
  return false;
}

function evaluateRoomTurn(room) {
  const player = room.players[room.currentPlayerIndex];
  if (!player || !room.turnSnapshot) {
    return { canConfirm: false, playedCount: 0, meldPoints: 0, reason: '' };
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
      return { canConfirm: false, playedCount, meldPoints: 0, reason: '바닥 타일이 누락되었습니다.' };
    }
  }

  const groups = getBoardGroups(room.board);
  const allValid = groups.every(g => g.valid);

  if (playedCount === 0) {
    return { canConfirm: false, playedCount: 0, meldPoints: 0, reason: '내 패를 1개 이상 내려놓거나 타일을 뽑으세요.' };
  }

  if (!player.hasMelded) {
    let meldPoints = 0;
    let touchedOldBoard = false;

    const snapGroups = getBoardGroups(room.turnSnapshot.board);
    const currentOldSigs = new Set(
      groups
        .filter(g => g.tiles.every(t => snapBoardIds.has(t.id)))
        .map(g => g.tiles.map(t => t.id).sort((a, b) => a - b).join(','))
    );
    for (const sg of snapGroups) {
      const sig = sg.tiles.map(t => t.id).sort((a, b) => a - b).join(',');
      if (!currentOldSigs.has(sig)) {
        touchedOldBoard = true;
        break;
      }
    }

    for (const g of groups) {
      const hasNew = g.tiles.some(t => room.playedFromRackIds.has(t.id));
      const hasOld = g.tiles.some(t => snapBoardIds.has(t.id));
      if (hasNew && hasOld) touchedOldBoard = true;
      if (hasNew && !hasOld && g.valid) meldPoints += g.points;
    }

    if (touchedOldBoard) {
      return { canConfirm: false, playedCount, meldPoints, reason: '첫 등록 전에는 바닥에 있던 기존 타일을 조합할 수 없습니다.' };
    }
    if (!allValid) {
      return { canConfirm: false, playedCount, meldPoints, reason: '유효하지 않은 세트가 있습니다.' };
    }
    if (meldPoints < 30) {
      return { canConfirm: false, playedCount, meldPoints, reason: `첫 등록은 합계 30점 이상이어야 합니다. (현재 ${meldPoints}점)` };
    }
    return { canConfirm: true, playedCount, meldPoints, reason: `첫 등록 완료 가능 (${meldPoints}점)!` };
  }

  if (!allValid) {
    return { canConfirm: false, playedCount, meldPoints: 0, reason: '빨간 테두리의 잘못된 세트를 수정하세요.' };
  }
  return { canConfirm: true, playedCount, meldPoints: 0, reason: '유효한 배치입니다!' };
}

// ==================== ROOM HELPERS ====================
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

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

function broadcastRoomState(room, toastMsg = null, toastTone = 'info') {
  const publicPlayers = room.players.map((p, idx) => ({
    id: p.id,
    sessionId: p.sessionId,
    name: p.name,
    isAI: p.isAI,
    connected: p.connected,
    hasMelded: p.hasMelded,
    rackCount: getRackTiles(p).length,
    isHost: idx === 0,
  }));

  for (const p of room.players) {
    if (p.isAI || !p.socketId) continue;
    const sock = io.sockets.sockets.get(p.socketId);
    if (!sock) continue;

    // Send ONLY this player's own rack (anti-cheat!)
    sock.emit('room:state', {
      code: room.code,
      phase: room.phase,
      maxPlayers: room.maxPlayers,
      players: publicPlayers,
      myPlayerId: p.id,
      myRack: p.rack,
      currentPlayerIndex: room.currentPlayerIndex,
      board: room.board,
      poolCount: room.pool.length,
      timeLeft: room.timeLeft,
      playedFromRackIds: Array.from(room.playedFromRackIds),
      recentHighlightIds: Array.from(room.recentHighlightIds),
      winnerInfo: room.winnerInfo || null,
      toast: toastMsg ? { msg: toastMsg, tone: toastTone } : null,
    });
  }
}

function startRoomTurn(room) {
  clearRoomTimers(room);
  const player = room.players[room.currentPlayerIndex];
  if (!player) return;

  room.turnSnapshot = {
    board: cloneBoard(room.board),
    rack: cloneRack(player.rack),
  };
  room.playedFromRackIds = new Set(getRackTiles(player).map(t => t.id));
  room.timeLeft = TURN_SECONDS;

  broadcastRoomState(room);

  room.timerInterval = setInterval(() => {
    if (room.phase !== 'playing') return;
    room.timeLeft--;
    io.to(room.code).emit('room:timer', { timeLeft: room.timeLeft });
    if (room.timeLeft <= 0) {
      handleServerTimeout(room);
    }
  }, 1000);

  if (player.isAI) {
    room.aiTimeout = setTimeout(() => executeServerAITurn(room), 1100);
  }
}

function handleServerTimeout(room) {
  clearRoomTimers(room);
  const player = room.players[room.currentPlayerIndex];
  if (!player || player.isAI) return;

  const evalRes = evaluateRoomTurn(room);
  if (evalRes.canConfirm) {
    confirmServerTurn(room, `${player.name} 시간 종료 — 유효한 배치가 자동 확정되었습니다.`);
    return;
  }

  const modified = hasBoardChanged(room.board, room.turnSnapshot.board);
  room.board = cloneBoard(room.turnSnapshot.board);
  player.rack = cloneRack(room.turnSnapshot.rack);

  const penalty = modified ? 3 : 1;
  let drawn = 0;
  for (let i = 0; i < penalty && room.pool.length > 0; i++) {
    addTileToRack(player, room.pool.pop());
    drawn++;
  }
  room.consecutivePasses++;
  advanceRoomTurn(
    room,
    modified
      ? `${player.name} 시간 초과! 원복 후 페널티 ${drawn}장을 받았습니다.`
      : `${player.name} 시간 초과! 타일 ${drawn}장을 뽑았습니다.`,
    'error'
  );
}

function confirmServerTurn(room, customMsg = null) {
  clearRoomTimers(room);
  const player = room.players[room.currentPlayerIndex];
  if (!player.hasMelded) player.hasMelded = true;
  room.consecutivePasses = 0;
  room.recentHighlightIds = new Set();

  if (getRackTiles(player).length === 0) {
    finishRoomGame(room, player, `${player.name}님이 모든 타일을 가장 먼저 내려놓았습니다!`);
    return;
  }

  advanceRoomTurn(room, customMsg || `${player.name}님이 턴을 완료했습니다.`, 'success');
}

function advanceRoomTurn(room, toastMsg = null, toastTone = 'info') {
  clearRoomTimers(room);

  if (room.pool.length === 0 && room.consecutivePasses >= room.players.length) {
    let bestPlayer = room.players[0];
    let bestScore = Infinity;
    for (const p of room.players) {
      const s = calcRackPenalty(p);
      if (s < bestScore) {
        bestScore = s;
        bestPlayer = p;
      }
    }
    finishRoomGame(room, bestPlayer, '더미가 소진되어 남은 패 점수가 가장 낮은 플레이어가 승리했습니다!');
    return;
  }

  room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
  startRoomTurn(room);
  if (toastMsg) {
    io.to(room.code).emit('room:toast', { msg: toastMsg, tone: toastTone });
  }
}

function finishRoomGame(room, winner, subtitle) {
  clearRoomTimers(room);
  room.phase = 'gameover';

  let totalPenalty = 0;
  const scores = room.players.map(p => {
    const penalty = p.id === winner.id ? 0 : calcRackPenalty(p);
    totalPenalty += penalty;
    return {
      id: p.id,
      name: p.name,
      isAI: p.isAI,
      leftCount: getRackTiles(p).length,
      penalty,
      isWinner: p.id === winner.id,
    };
  });

  room.winnerInfo = {
    winnerId: winner.id,
    winnerName: winner.name,
    subtitle,
    totalPenalty,
    scores,
  };
  broadcastRoomState(room, `🏆 ${winner.name} 승리!`, 'success');
}

// ==================== SERVER AI BOT ====================
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
      if (!seen.has(t.color)) { seen.add(t.color); uniq.push(t); }
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
        while (n <= 13 && byN.has(n)) { run.push(byN.get(n)); pts += n; n++; }
        if (run.length >= 3) candidates.push({ tiles: run, points: pts });
      } else n++;
    }
  }
  candidates.sort((a, b) => b.points - a.points);
  return candidates;
}

function findEmptySpotOnBoard(board, len) {
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c <= GRID_COLS - len; c++) {
      const leftClear = c === 0 || !board[r][c - 1];
      const rightClear = c + len === GRID_COLS || !board[r][c + len];
      if (!leftClear || !rightClear) continue;
      let ok = true;
      for (let i = 0; i < len; i++) {
        if (board[r][c + i]) { ok = false; break; }
      }
      if (ok) return { row: r, col: c };
    }
  }
  return null;
}

function executeServerAITurn(room) {
  const ai = room.players[room.currentPlayerIndex];
  if (!ai || !ai.isAI || room.phase !== 'playing') return;

  const rackTiles = getRackTiles(ai);
  const placedIds = new Set();
  const candidates = findCandidateSetsFromRack(rackTiles);
  const chosenSets = [];
  const usedIds = new Set();
  let totalPts = 0;

  for (const c of candidates) {
    if (c.tiles.some(t => usedIds.has(t.id))) continue;
    chosenSets.push(c);
    c.tiles.forEach(t => usedIds.add(t.id));
    totalPts += c.points;
  }

  if (!ai.hasMelded) {
    if (totalPts >= 30) {
      let ok = true;
      for (const s of chosenSets) {
        const spot = findEmptySpotOnBoard(room.board, s.tiles.length);
        if (!spot) { ok = false; break; }
        for (let i = 0; i < s.tiles.length; i++) {
          room.board[spot.row][spot.col + i] = s.tiles[i];
          placedIds.add(s.tiles[i].id);
        }
      }
      if (ok && placedIds.size > 0) {
        ai.rack = ai.rack.map(t => (t && placedIds.has(t.id) ? null : t));
        ai.hasMelded = true;
        room.recentHighlightIds = placedIds;
        room.consecutivePasses = 0;
        if (getRackTiles(ai).length === 0) {
          finishRoomGame(room, ai, `${ai.name}이(가) 모든 타일을 내려놓았습니다!`);
          return;
        }
        advanceRoomTurn(room, `${ai.name}이(가) ${totalPts}점으로 첫 등록했습니다!`, 'success');
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
      const remaining = getRackTiles(ai).filter(t => !placedIds.has(t.id));
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
      ai.rack = ai.rack.map(t => (t && placedIds.has(t.id) ? null : t));
      room.recentHighlightIds = placedIds;
      room.consecutivePasses = 0;
      if (getRackTiles(ai).length === 0) {
        finishRoomGame(room, ai, `${ai.name}이(가) 모든 타일을 내려놓았습니다!`);
        return;
      }
      advanceRoomTurn(room, `${ai.name}이(가) 타일 ${placedIds.size}개를 내려놓았습니다.`);
      return;
    }
  }

  if (room.pool.length > 0) addTileToRack(ai, room.pool.pop());
  room.recentHighlightIds = new Set();
  room.consecutivePasses++;
  advanceRoomTurn(room, `${ai.name}이(가) 타일 1장을 뽑았습니다.`);
}

// ==================== SOCKET.IO EVENTS ====================
io.on('connection', (socket) => {
  socket.on('room:create', ({ name, maxPlayers, sessionId }, cb) => {
    const cleanName = (name || '플레이어 1').trim().slice(0, 14) || '플레이어 1';
    const cap = Math.max(2, Math.min(4, parseInt(maxPlayers, 10) || 4));
    const code = generateRoomCode();
    const room = {
      code,
      maxPlayers: cap,
      phase: 'waiting', // waiting | playing | gameover
      players: [
        {
          id: 1,
          sessionId: sessionId || socket.id,
          socketId: socket.id,
          name: cleanName,
          isAI: false,
          connected: true,
          rack: [],
          hasMelded: false,
        },
      ],
      nextPlayerId: 2,
      pool: [],
      board: createEmptyBoard(),
      currentPlayerIndex: 0,
      turnSnapshot: null,
      playedFromRackIds: new Set(),
      recentHighlightIds: new Set(),
      consecutivePasses: 0,
      timeLeft: TURN_SECONDS,
      timerInterval: null,
      aiTimeout: null,
      winnerInfo: null,
    };

    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = 1;

    if (cb) cb({ ok: true, code });
    broadcastRoomState(room, `방 [${code}]이 생성되었습니다.`);
  });

  socket.on('room:join', ({ code, name, sessionId }, cb) => {
    const upperCode = (code || '').trim().toUpperCase();
    const room = rooms.get(upperCode);
    if (!room) return cb && cb({ ok: false, error: '존재하지 않는 방 코드입니다.' });

    // Reconnect check by sessionId
    const existing = room.players.find(p => !p.isAI && p.sessionId === sessionId);
    if (existing) {
      existing.socketId = socket.id;
      existing.connected = true;
      socket.join(upperCode);
      socket.data.roomCode = upperCode;
      socket.data.playerId = existing.id;
      if (cb) cb({ ok: true, code: upperCode });
      broadcastRoomState(room, `${existing.name}님이 재접속했습니다.`);
      return;
    }

    if (room.phase !== 'waiting') {
      return cb && cb({ ok: false, error: '이미 게임이 진행 중인 방입니다.' });
    }
    if (room.players.length >= room.maxPlayers) {
      return cb && cb({ ok: false, error: '방 인원이 가득 찼습니다.' });
    }

    const cleanName = (name || `플레이어 ${room.players.length + 1}`).trim().slice(0, 14);
    const newPlayer = {
      id: room.nextPlayerId++,
      sessionId: sessionId || socket.id,
      socketId: socket.id,
      name: cleanName,
      isAI: false,
      connected: true,
      rack: [],
      hasMelded: false,
    };
    room.players.push(newPlayer);
    socket.join(upperCode);
    socket.data.roomCode = upperCode;
    socket.data.playerId = newPlayer.id;

    if (cb) cb({ ok: true, code: upperCode });
    broadcastRoomState(room, `${cleanName}님이 입장했습니다.`);
  });

  socket.on('room:add-ai', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'waiting') return;
    if (room.players[0].socketId !== socket.id) return;
    if (room.players.length >= room.maxPlayers) return;

    const aiNum = room.players.filter(p => p.isAI).length + 1;
    room.players.push({
      id: room.nextPlayerId++,
      sessionId: `ai-${Date.now()}-${aiNum}`,
      socketId: null,
      name: `AI 봇 ${aiNum}`,
      isAI: true,
      connected: true,
      rack: [],
      hasMelded: false,
    });
    broadcastRoomState(room, `AI 봇 ${aiNum}이 추가되었습니다.`);
  });

  socket.on('room:start', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || (room.phase !== 'waiting' && room.phase !== 'gameover')) return;
    if (room.players[0].socketId !== socket.id) return;
    if (room.players.length < 2) {
      socket.emit('room:toast', { msg: '최소 2명 이상 모여야 시작할 수 있습니다.', tone: 'error' });
      return;
    }

    clearRoomTimers(room);
    room.pool = createDeck();
    room.board = createEmptyBoard();
    room.currentPlayerIndex = 0;
    room.consecutivePasses = 0;
    room.recentHighlightIds = new Set();
    room.winnerInfo = null;

    for (const p of room.players) {
      p.hasMelded = false;
      p.rack = Array(28).fill(null);
      for (let i = 0; i < 14; i++) p.rack[i] = room.pool.pop();
    }

    room.phase = 'playing';
    startRoomTurn(room);
    io.to(room.code).emit('room:toast', { msg: '게임이 시작되었습니다!', tone: 'success' });
  });

  // Live sync while active player moves tiles on board/rack
  socket.on('turn:sync', ({ board, rack }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'playing') return;
    const curr = room.players[room.currentPlayerIndex];
    if (!curr || curr.socketId !== socket.id) return;

    // Verify tile conservation (no fabricated or lost tiles)
    const allowedIds = new Set();
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        if (room.turnSnapshot.board[r][c]) allowedIds.add(room.turnSnapshot.board[r][c].id);
      }
    }
    for (const t of room.turnSnapshot.rack) {
      if (t) allowedIds.add(t.id);
    }

    const incomingIds = new Set();
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const t = board?.[r]?.[c];
        if (t) {
          if (!allowedIds.has(t.id) || incomingIds.has(t.id)) return;
          incomingIds.add(t.id);
        }
      }
    }
    for (const t of rack || []) {
      if (t) {
        if (!allowedIds.has(t.id) || incomingIds.has(t.id)) return;
        incomingIds.add(t.id);
      }
    }
    if (incomingIds.size !== allowedIds.size) return;

    room.board = board;
    curr.rack = rack;

    // Broadcast live board update to other players in the room
    socket.to(room.code).emit('room:board-live', {
      board: room.board,
      activeRackCount: getRackTiles(curr).length,
    });
  });

  // Allow any player to save their sorted rack order even on opponents' turns
  socket.on('rack:sort-sync', ({ rack }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'playing') return;
    const me = room.players.find(p => p.socketId === socket.id);
    if (!me) return;

    const myIds = new Set(getRackTiles(me).map(t => t.id));
    const incoming = (rack || []).filter(Boolean);
    if (incoming.length !== myIds.size) return;
    if (!incoming.every(t => myIds.has(t.id))) return;

    me.rack = rack;
  });

  socket.on('turn:reset', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'playing') return;
    const curr = room.players[room.currentPlayerIndex];
    if (!curr || curr.socketId !== socket.id || !room.turnSnapshot) return;

    room.board = cloneBoard(room.turnSnapshot.board);
    curr.rack = cloneRack(room.turnSnapshot.rack);
    broadcastRoomState(room, `${curr.name}님이 배치를 원위치했습니다.`);
  });

  socket.on('turn:end', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'playing') return;
    const curr = room.players[room.currentPlayerIndex];
    if (!curr || curr.socketId !== socket.id) return;

    const evalRes = evaluateRoomTurn(room);
    if (evalRes.playedCount === 0 && !hasBoardChanged(room.board, room.turnSnapshot.board)) {
      if (room.pool.length > 0) {
        addTileToRack(curr, room.pool.pop());
        room.consecutivePasses++;
        advanceRoomTurn(room, `${curr.name}님이 타일 1장을 뽑았습니다.`);
      } else {
        room.consecutivePasses++;
        advanceRoomTurn(room, `${curr.name}님이 패스했습니다.`);
      }
      return;
    }

    if (evalRes.canConfirm) {
      confirmServerTurn(room);
    } else {
      socket.emit('room:toast', { msg: evalRes.reason, tone: 'error' });
    }
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const p = room.players.find(x => x.socketId === socket.id);
    if (p) {
      p.connected = false;
      broadcastRoomState(room, `${p.name}님의 연결이 일시 끊어졌습니다.`);
    }
    // Cleanup empty rooms
    const anyOnline = room.players.some(x => !x.isAI && x.connected);
    if (!anyOnline) {
      clearRoomTimers(room);
      setTimeout(() => {
        const r = rooms.get(code);
        if (r && !r.players.some(x => !x.isAI && x.connected)) {
          rooms.delete(code);
        }
      }, 120000);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Rummikub Online Server running on http://localhost:${PORT}`);
});
