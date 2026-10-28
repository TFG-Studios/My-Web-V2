'use strict';

const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { Server } = require('socket.io');
const engine = require('./lib/game-engine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
const PORT = Number(process.env.PORT) || 3000;
const rooms = new Map();
const ROOM_CAPACITY = 5;
const DISCONNECT_GRACE_MS = 60_000;
const UNO_CATCH_MS = 6_000;
const REACTION_MS = 4_000;
const AUTO_SKIP_MS = 10_000;
const VALID_SETTINGS = Object.keys(engine.DEFAULT_SETTINGS);

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: '1h' }));
app.get('/healthz', (_req, res) => res.json({ ok: true, version: '2.0.0', rooms: rooms.size }));

function cleanName(value) {
  return String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 16);
}

function cleanSettings(input) {
  const settings = { ...engine.DEFAULT_SETTINGS };
  if (!input || typeof input !== 'object') return settings;
  for (const key of VALID_SETTINGS) {
    if (typeof input[key] === 'boolean') settings[key] = input[key];
  }
  return settings;
}

function makeRoomCode() {
  let code;
  do {
    code = randomBytes(3).toString('hex').toUpperCase();
  } while (rooms.has(code));
  return code;
}

function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.some(player => player.id === socketId)) return room;
  }
  return null;
}

function playerIndex(room, socketId) {
  return room.players.findIndex(player => player.id === socketId);
}

function getPlayer(room, socketId) {
  return room.players.find(player => player.id === socketId) || null;
}

function clearTimer(room, name) {
  if (room.timers[name]) clearTimeout(room.timers[name]);
  room.timers[name] = null;
}

function notice(room, text, kind = 'info') {
  io.to(room.code).emit('notice', { text, kind, id: randomUUID() });
}

function playerName(room, id) {
  return room.players.find(player => player.id === id)?.name || 'A player';
}

function publicState(room, viewerId) {
  const game = room.game;
  const viewerIndex = playerIndex(room, viewerId);
  const viewerHand = game && viewerIndex >= 0 ? game.hands[viewerIndex] : [];
  return {
    code: room.code,
    hostId: room.hostId,
    settings: { ...room.settings },
    started: Boolean(game),
    meId: viewerId,
    players: room.players.map((player, index) => ({
      id: player.id,
      name: player.name,
      count: game ? (game.hands[index]?.length ?? 0) : 0,
      connected: player.connected !== false,
      isTurn: Boolean(game && game.turn === index),
      calledUno: Boolean(game?.unoAnnouncement?.playerId === player.id && game.unoAnnouncement.kind === 'call'),
    })),
    game: game ? {
      roundId: game.roundId,
      turn: game.turn,
      currentPlayerId: room.players[game.turn]?.id || null,
      direction: game.direction,
      top: game.discard[game.discard.length - 1],
      color: game.color,
      drawCount: game.deck.length,
      discardCount: game.discard.length,
      pendingDraw: game.pendingDraw,
      pendingType: game.pendingType,
      winnerId: game.winnerId,
      winnerName: game.winnerId ? playerName(room, game.winnerId) : null,
      hand: viewerHand,
      lastAction: game.lastAction,
      lastPlayerId: game.lastPlayerId,
      lastCardId: game.lastCardId,
      drawnPlayableCardId: viewerIndex === game.turn ? game.drawnPlayableCardId : null,
      armedUno: game.armedUnoPlayerId === viewerId,
      unoChallenge: game.unoChallenge ? {
        targetId: game.unoChallenge.targetId,
        targetName: playerName(room, game.unoChallenge.targetId),
        deadline: game.unoChallenge.deadline,
      } : null,
      unoAnnouncement: game.unoAnnouncement,
      awaitingSwapPlayerId: game.awaitingSwapPlayerId,
      pendingWild4: game.pendingWild4 ? {
        targetId: game.pendingWild4.targetId,
        offenderId: game.pendingWild4.offenderId,
        offenderName: playerName(room, game.pendingWild4.offenderId),
        canChallenge: game.pendingWild4.targetId === viewerId,
      } : null,
      sixReaction: game.sixReaction ? {
        id: game.sixReaction.id,
        active: game.sixReaction.active,
        deadline: game.sixReaction.deadline,
        pressed: [...game.sixReaction.pressed],
        playerIds: [...game.sixReaction.playerIds],
      } : null,
    } : null,
  };
}

function sendState(room) {
  for (const player of room.players) {
    io.to(player.id).emit('state', publicState(room, player.id));
  }
}

function endUnoChallenge(room) {
  clearTimer(room, 'unoCatch');
  if (room.game) room.game.unoChallenge = null;
}

function cancelReaction(room) {
  clearTimer(room, 'reaction');
  if (room.game) room.game.sixReaction = null;
}

function drawIntoHand(game, index, count) {
  let drawn = 0;
  for (let i = 0; i < count; i += 1) {
    const card = engine.drawOne(game);
    if (!card) break;
    game.hands[index].push(card);
    drawn += 1;
  }
  return drawn;
}

function addWinner(room, playerId) {
  const game = room.game;
  if (!game) return;
  game.winnerId = playerId;
  game.armedUnoPlayerId = null;
  game.unoChallenge = null;
  game.pendingWild4 = null;
  game.pendingDraw = 0;
  game.pendingType = null;
  game.awaitingSwapPlayerId = null;
  cancelReaction(room);
  clearTimer(room, 'unoCatch');
  clearTimer(room, 'autoSkip');
  notice(room, `${playerName(room, playerId)} wins the round!`, 'win');
}

function advance(room, steps = 1) {
  const game = room.game;
  if (!game) return;
  engine.nextTurn(game, steps, room.players.length);
  if (game.turn >= room.players.length) game.turn = 0;
}

function hasLegalPenaltyCounter(game, hand) {
  return hand.some(card => engine.canCounterPenalty(game, card));
}

function resolvePenaltyIfUncounterable(room) {
  const game = room.game;
  if (!game || game.pendingDraw <= 0 || game.pendingWild4) return;
  const hand = game.hands[game.turn] || [];
  if (hasLegalPenaltyCounter(game, hand)) return;
  const amount = game.pendingDraw;
  const who = playerName(room, room.players[game.turn]?.id);
  drawIntoHand(game, game.turn, amount);
  game.pendingDraw = 0;
  game.pendingType = null;
  game.drawnPlayableCardId = null;
  notice(room, `${who} draws ${amount} cards.`, 'penalty');
  advance(room);
}

function startUnoChallenge(room, targetId) {
  const game = room.game;
  if (!game || game.winnerId) return;
  clearTimer(room, 'unoCatch');
  const challengeId = randomUUID();
  game.unoChallenge = { id: challengeId, targetId, deadline: Date.now() + UNO_CATCH_MS };
  sendState(room);
  notice(room, `${playerName(room, targetId)} has one card — catch them if they forgot UNO!`, 'warning');
  room.timers.unoCatch = setTimeout(() => {
    if (!room.game?.unoChallenge || room.game.unoChallenge.id !== challengeId) return;
    room.game.unoChallenge = null;
    sendState(room);
  }, UNO_CATCH_MS);
}

function startSixReaction(room) {
  const game = room.game;
  if (!game || !game.settings.sixReaction || game.winnerId) return;
  clearTimer(room, 'reaction');
  const id = randomUUID();
  game.sixReaction = {
    id,
    active: true,
    playerIds: room.players.map(player => player.id),
    pressed: [],
    deadline: Date.now() + REACTION_MS,
  };
  notice(room, '6 REACTION! Tap your button before the timer runs out!', 'reaction');
  sendState(room);
  room.timers.reaction = setTimeout(() => {
    if (!room.game?.sixReaction || room.game.sixReaction.id !== id) return;
    finishSixReaction(room);
  }, REACTION_MS);
}

function finishSixReaction(room) {
  const game = room.game;
  if (!game?.sixReaction) return;
  const missed = game.sixReaction.playerIds.filter(id => !game.sixReaction.pressed.includes(id));
  const names = [];
  for (const id of missed) {
    const index = playerIndex(room, id);
    if (index >= 0 && !game.winnerId) {
      drawIntoHand(game, index, 2);
      names.push(room.players[index].name);
    }
  }
  cancelReaction(room);
  if (names.length) notice(room, `${names.join(', ')} missed the 6 reaction and draw 2 cards.`, 'penalty');
  else notice(room, 'Perfect timing — everyone was safe!', 'success');
  sendState(room);
}

function beginTurnAction(room) {
  const game = room.game;
  if (game?.unoChallenge) {
    endUnoChallenge(room);
    sendState(room);
  }
}

function playCard(room, socket, payload = {}) {
  const game = room.game;
  if (!game || game.winnerId) return;
  if (game.sixReaction?.active) return socket.emit('toast', { text: 'Wait for the reaction to finish.', kind: 'warning' });
  if (game.awaitingSwapPlayerId) return socket.emit('toast', { text: 'Choose a player to swap hands with first.', kind: 'warning' });
  if (game.pendingWild4) return socket.emit('toast', { text: 'Accept the +4 or challenge it before playing.', kind: 'warning' });

  const index = playerIndex(room, socket.id);
  if (index < 0 || index !== game.turn) return socket.emit('toast', { text: 'It is not your turn.', kind: 'warning' });
  const hand = game.hands[index];
  const card = hand.find(item => item.id === payload.cardId);
  if (!card) return socket.emit('toast', { text: 'That card is no longer in your hand.', kind: 'warning' });
  if (!engine.canPlay(game, hand, card)) return socket.emit('toast', { text: 'That card cannot be played right now.', kind: 'warning' });
  const chosenColor = payload.color;
  if (card.color === 'wild' && !engine.COLORS.includes(chosenColor)) {
    return socket.emit('toast', { text: 'Choose a valid colour for your Wild card.', kind: 'warning' });
  }
  beginTurnAction(room);

  const previousColor = game.color;
  const handBefore = [...hand];
  const declaredUno = game.armedUnoPlayerId === socket.id;
  const previousUnoAnnouncement = game.unoAnnouncement;
  const wasStackingPenalty = game.pendingDraw > 0;
  const hadMatchingColor = engine.hasColor(handBefore, previousColor, card.id);
  hand.splice(hand.findIndex(item => item.id === card.id), 1);
  game.discard.push(card);
  game.color = card.color === 'wild' ? chosenColor : card.color;
  game.lastAction = card.value;
  game.lastPlayerId = socket.id;
  game.lastCardId = card.id;
  game.drawnPlayableCardId = null;
  game.armedUnoPlayerId = null;
  // Preserve the call announcement from the button press; do not replay the
  // large UNO splash when the player subsequently plays the card.
  game.unoAnnouncement = declaredUno && hand.length === 1 && previousUnoAnnouncement?.playerId === socket.id
    ? previousUnoAnnouncement
    : null;

  // A played last card ends the hand immediately, including action cards.
  if (hand.length === 0) {
    addWinner(room, socket.id);
    sendState(room);
    return;
  }

  let skipReaction = false;

  if (wasStackingPenalty) {
    if (card.value === 'Draw2') {
      game.pendingDraw += 2;
      game.pendingType = 'Draw2';
      advance(room);
      resolvePenaltyIfUncounterable(room);
    } else if (card.value === 'Wild4') {
      game.pendingDraw += 4;
      game.pendingType = 'Wild4';
      advance(room);
      // A +4 placed on an existing penalty is a stack, not a new challenge.
      game.pendingWild4 = null;
      resolvePenaltyIfUncounterable(room);
    } else if (card.value === 'Skip') {
      advance(room, 2);
    } else if (card.value === 'Reverse') {
      if (room.players.length > 2) game.direction *= -1;
      advance(room);
    } else {
      // A rare custom counter does not erase the pending penalty.
      advance(room);
      resolvePenaltyIfUncounterable(room);
    }
  } else {
    switch (card.value) {
      case 'Skip':
        advance(room, 2);
        break;
      case 'Reverse':
        if (room.players.length === 2) {
          advance(room, 2);
        } else {
          game.direction *= -1;
          advance(room);
        }
        break;
      case 'Draw2':
        game.pendingDraw = 2;
        game.pendingType = 'Draw2';
        advance(room);
        resolvePenaltyIfUncounterable(room);
        break;
      case 'Wild4':
        game.pendingDraw = 4;
        game.pendingType = 'Wild4';
        advance(room);
        if (!game.settings.stacking) {
          game.pendingWild4 = {
            offenderId: socket.id,
            targetId: room.players[game.turn]?.id,
            previousColor,
            wasIllegal: hadMatchingColor,
          };
        }
        break;
      case '7':
        if (game.settings.zeroSeven) {
          game.awaitingSwapPlayerId = socket.id;
          game.turn = index;
          skipReaction = true;
        } else advance(room);
        break;
      case '0':
        if (game.settings.zeroSeven) {
          if (game.direction === 1) game.hands.unshift(game.hands.pop());
          else game.hands.push(game.hands.shift());
          // Hands rotate, player seats do not. Hand counts update on the next state.
        }
        advance(room);
        break;
      default:
        advance(room);
        break;
    }
  }

  if (hand.length === 1 && !declaredUno) startUnoChallenge(room, socket.id);
  else if (hand.length === 1 && declaredUno) notice(room, `${playerName(room, socket.id)} called UNO!`, 'success');

  sendState(room);
  if (!skipReaction && card.value === '6' && game.settings.sixReaction && !game.winnerId) startSixReaction(room);
}

function drawCard(room, socket) {
  const game = room.game;
  if (!game || game.winnerId) return;
  if (game.sixReaction?.active) return socket.emit('toast', { text: 'Wait for the reaction to finish.', kind: 'warning' });
  if (game.awaitingSwapPlayerId) return socket.emit('toast', { text: 'Choose a player to swap hands with first.', kind: 'warning' });
  const index = playerIndex(room, socket.id);
  if (index < 0 || index !== game.turn) return socket.emit('toast', { text: 'It is not your turn.', kind: 'warning' });
  beginTurnAction(room);

  if (game.pendingWild4) {
    const amount = 4;
    drawIntoHand(game, index, amount);
    game.pendingWild4 = null;
    game.pendingDraw = 0;
    game.pendingType = null;
    game.drawnPlayableCardId = null;
    notice(room, `${playerName(room, socket.id)} accepts +4 and draws ${amount}.`, 'penalty');
    advance(room);
    resolvePenaltyIfUncounterable(room);
    sendState(room);
    return;
  }

  if (game.pendingDraw > 0) {
    const amount = game.pendingDraw;
    drawIntoHand(game, index, amount);
    game.pendingDraw = 0;
    game.pendingType = null;
    game.drawnPlayableCardId = null;
    game.armedUnoPlayerId = null;
    notice(room, `${playerName(room, socket.id)} draws ${amount} cards.`, 'penalty');
    advance(room);
    resolvePenaltyIfUncounterable(room);
    sendState(room);
    return;
  }

  game.armedUnoPlayerId = null;
  game.drawnPlayableCardId = null;
  if (game.settings.drawUntilPlayable) {
    let found = null;
    let safety = 0;
    while (!found && safety < 120) {
      safety += 1;
      const card = engine.drawOne(game);
      if (!card) break;
      game.hands[index].push(card);
      if (engine.canPlay(game, game.hands[index], card)) found = card;
    }
    if (found) {
      game.drawnPlayableCardId = found.id;
      notice(room, `${playerName(room, socket.id)} found a playable card. Play that card to continue.`, 'success');
    } else {
      notice(room, `${playerName(room, socket.id)} drew until the pile ran out.`, 'info');
      advance(room);
    }
    sendState(room);
    return;
  }

  const card = engine.drawOne(game);
  if (!card) {
    notice(room, 'The draw pile is empty.', 'info');
    advance(room);
    sendState(room);
    return;
  }
  game.hands[index].push(card);
  if (engine.canPlay(game, game.hands[index], card)) {
    game.drawnPlayableCardId = card.id;
    notice(room, 'You drew a playable card. Play it now or pass.', 'success');
  } else {
    notice(room, `${playerName(room, socket.id)} draws a card.`, 'info');
    advance(room);
  }
  sendState(room);
}

function drawPenalty(room, socket) {
  const game = room.game;
  if (!game || game.winnerId || game.pendingWild4) return drawCard(room, socket);
  const index = playerIndex(room, socket.id);
  if (index < 0 || index !== game.turn || game.pendingDraw <= 0) return;
  beginTurnAction(room);
  const amount = game.pendingDraw;
  drawIntoHand(game, index, amount);
  game.pendingDraw = 0;
  game.pendingType = null;
  game.drawnPlayableCardId = null;
  game.armedUnoPlayerId = null;
  notice(room, `${playerName(room, socket.id)} draws ${amount} cards.`, 'penalty');
  advance(room);
  resolvePenaltyIfUncounterable(room);
  sendState(room);
}

function challengeWild4(room, socket) {
  const game = room.game;
  const pending = game?.pendingWild4;
  if (!game || !pending || pending.targetId !== socket.id || game.turn !== playerIndex(room, socket.id)) return;
  if (pending.wasIllegal) {
    const offenderIndex = playerIndex(room, pending.offenderId);
    if (offenderIndex >= 0) drawIntoHand(game, offenderIndex, 4);
    game.pendingDraw = 0;
    game.pendingType = null;
    game.pendingWild4 = null;
    game.drawnPlayableCardId = null;
    notice(room, `${playerName(room, socket.id)} wins the challenge! ${playerName(room, pending.offenderId)} draws 4.`, 'success');
  } else {
    drawIntoHand(game, playerIndex(room, socket.id), 6);
    game.pendingDraw = 0;
    game.pendingType = null;
    game.pendingWild4 = null;
    notice(room, `${playerName(room, socket.id)}'s challenge failed — draw 6.`, 'penalty');
    advance(room);
  }
  sendState(room);
}

function swapHands(room, socket, targetId) {
  const game = room.game;
  if (!game || game.winnerId || game.awaitingSwapPlayerId !== socket.id || !game.settings.zeroSeven) return;
  const from = playerIndex(room, socket.id);
  const to = playerIndex(room, targetId);
  if (from < 0 || to < 0 || from === to) return socket.emit('toast', { text: 'Choose another player.', kind: 'warning' });
  [game.hands[from], game.hands[to]] = [game.hands[to], game.hands[from]];
  game.awaitingSwapPlayerId = null;
  notice(room, `${playerName(room, socket.id)} swapped hands with ${playerName(room, targetId)}.`, 'info');
  advance(room);
  sendState(room);
}

function removePlayer(room, index, reason = 'left') {
  const player = room.players[index];
  if (!player) return;
  if (player.graceTimer) clearTimeout(player.graceTimer);
  let cancelledSwap = false;
  if (room.game) {
    const game = room.game;
    if (game.unoChallenge?.targetId === player.id) endUnoChallenge(room);
    if (game.armedUnoPlayerId === player.id) game.armedUnoPlayerId = null;
    if (game.awaitingSwapPlayerId === player.id) {
      game.awaitingSwapPlayerId = null;
      cancelledSwap = true;
    }
    if (game.pendingWild4?.targetId === player.id || game.pendingWild4?.offenderId === player.id) {
      game.pendingWild4 = null;
      game.pendingDraw = 0;
      game.pendingType = null;
    }
    if (game.sixReaction) {
      game.sixReaction.playerIds = game.sixReaction.playerIds.filter(id => id !== player.id);
      game.sixReaction.pressed = game.sixReaction.pressed.filter(id => id !== player.id);
    }
    game.hands.splice(index, 1);
    if (game.turn > index) game.turn -= 1;
    else if (game.turn === index) game.turn = game.turn % Math.max(1, room.players.length - 1);
  }
  room.players.splice(index, 1);
  if (room.hostId === player.id) room.hostId = room.players[0]?.id || null;
  if (room.players.length === 0) {
    for (const timer of Object.keys(room.timers)) clearTimer(room, timer);
    rooms.delete(room.code);
    return;
  }
  if (room.game && room.players.length === 1 && !room.game.winnerId) {
    room.game.winnerId = room.players[0].id;
    cancelReaction(room);
  }
  notice(room, `${player.name} ${reason}.`, 'info');
  if (cancelledSwap && room.players.length > 0) notice(room, 'The hand swap was cancelled because its player left.', 'warning');
  sendState(room);
}

function scheduleDisconnectedTurn(room, player) {
  clearTimer(room, 'autoSkip');
  if (!room.game || room.game.winnerId) return;
  const current = room.players[room.game.turn];
  if (!current || current.id !== player.id) return;
  room.timers.autoSkip = setTimeout(() => {
    if (!room.game || room.game.winnerId) return;
    const active = room.players[room.game.turn];
    if (!active || active.id !== player.id || active.connected) return;
    if (room.game.pendingWild4) {
      drawIntoHand(room.game, room.game.turn, 4);
      room.game.pendingWild4 = null;
      room.game.pendingDraw = 0;
      room.game.pendingType = null;
    } else if (room.game.pendingDraw > 0) {
      const amount = room.game.pendingDraw;
      drawIntoHand(room.game, room.game.turn, amount);
      room.game.pendingDraw = 0;
      room.game.pendingType = null;
    } else {
      drawIntoHand(room.game, room.game.turn, 1);
    }
    notice(room, `${active.name} was disconnected; their turn was skipped.`, 'warning');
    advance(room);
    sendState(room);
  }, AUTO_SKIP_MS);
}

function resumePlayer(socket, token) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 100) return false;
  for (const room of rooms.values()) {
    const player = room.players.find(item => item.token === token);
    if (!player) continue;
    const oldId = player.id;
    player.id = socket.id;
    player.connected = true;
    if (player.graceTimer) clearTimeout(player.graceTimer);
    player.graceTimer = null;
    if (room.game && room.players[room.game.turn]?.id === socket.id) clearTimer(room, 'autoSkip');
    if (room.hostId === oldId) room.hostId = socket.id;
    if (room.game) {
      if (room.game.armedUnoPlayerId === oldId) room.game.armedUnoPlayerId = socket.id;
      if (room.game.winnerId === oldId) room.game.winnerId = socket.id;
      if (room.game.lastPlayerId === oldId) room.game.lastPlayerId = socket.id;
      if (room.game.unoAnnouncement?.playerId === oldId) room.game.unoAnnouncement.playerId = socket.id;
      if (room.game.unoChallenge?.targetId === oldId) room.game.unoChallenge.targetId = socket.id;
      if (room.game.pendingWild4?.targetId === oldId) room.game.pendingWild4.targetId = socket.id;
      if (room.game.pendingWild4?.offenderId === oldId) room.game.pendingWild4.offenderId = socket.id;
      if (room.game.awaitingSwapPlayerId === oldId) room.game.awaitingSwapPlayerId = socket.id;
      if (room.game.sixReaction) {
        room.game.sixReaction.playerIds = room.game.sixReaction.playerIds.map(id => id === oldId ? socket.id : id);
        room.game.sixReaction.pressed = room.game.sixReaction.pressed.map(id => id === oldId ? socket.id : id);
      }
    }
    socket.join(room.code);
    socket.emit('roomJoined', { code: room.code, resumed: true });
    notice(room, `${player.name} reconnected.`, 'success');
    sendState(room);
    return true;
  }
  return false;
}

io.on('connection', socket => {
  socket.emit('connected', { id: socket.id, version: '2.0.0' });

  socket.on('resumeSession', token => {
    if (!resumePlayer(socket, token)) socket.emit('resumeFailed');
  });

  socket.on('createRoom', payload => {
    if (findRoomBySocket(socket.id)) return socket.emit('toast', { text: 'You are already in a room.', kind: 'warning' });
    const name = cleanName(payload?.name);
    if (!name) return socket.emit('toast', { text: 'Enter a nickname first.', kind: 'warning' });
    const token = typeof payload?.token === 'string' ? payload.token.slice(0, 100) : randomUUID();
    const code = makeRoomCode();
    const room = {
      code,
      hostId: socket.id,
      settings: cleanSettings(payload?.settings),
      players: [{ id: socket.id, token, name, connected: true, graceTimer: null }],
      game: null,
      timers: { unoCatch: null, reaction: null, autoSkip: null },
    };
    rooms.set(code, room);
    socket.join(code);
    socket.emit('roomJoined', { code, token });
    sendState(room);
  });

  socket.on('joinRoom', payload => {
    if (findRoomBySocket(socket.id)) return socket.emit('toast', { text: 'Leave your current room before joining another.', kind: 'warning' });
    const code = String(payload?.code || '').trim().toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 6);
    const name = cleanName(payload?.name);
    const room = rooms.get(code);
    if (!name) return socket.emit('toast', { text: 'Enter a nickname first.', kind: 'warning' });
    if (!room) return socket.emit('toast', { text: 'Room code not found. Check it and try again.', kind: 'warning' });
    if (room.game) return socket.emit('toast', { text: 'That game has already started.', kind: 'warning' });
    if (room.players.length >= ROOM_CAPACITY) return socket.emit('toast', { text: 'This room is full (5 players maximum).', kind: 'warning' });
    const token = typeof payload?.token === 'string' ? payload.token.slice(0, 100) : randomUUID();
    const player = { id: socket.id, token, name, connected: true, graceTimer: null };
    room.players.push(player);
    socket.join(code);
    socket.emit('roomJoined', { code, token });
    notice(room, `${name} joined the room.`, 'success');
    sendState(room);
  });

  socket.on('updateSettings', incoming => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('toast', { text: 'Only the host can change house rules.', kind: 'warning' });
    if (room.game) return socket.emit('toast', { text: 'House rules are locked after the game starts.', kind: 'warning' });
    room.settings = cleanSettings(incoming);
    sendState(room);
  });

  socket.on('startGame', () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('toast', { text: 'Only the host can start the game.', kind: 'warning' });
    if (room.players.length < 2) return socket.emit('toast', { text: 'Invite at least one more player first.', kind: 'warning' });
    if (room.game) return;
    room.game = engine.createGame(room.players.length, room.settings);
    notice(room, 'Cards dealt — good luck!', 'success');
    sendState(room);
  });

  socket.on('playCard', payload => {
    const room = findRoomBySocket(socket.id);
    if (room) playCard(room, socket, payload);
  });

  socket.on('drawCard', () => {
    const room = findRoomBySocket(socket.id);
    if (room) drawCard(room, socket);
  });

  socket.on('drawPenalty', () => {
    const room = findRoomBySocket(socket.id);
    if (room) drawPenalty(room, socket);
  });

  socket.on('passTurn', () => {
    const room = findRoomBySocket(socket.id);
    const game = room?.game;
    if (!room || !game || game.winnerId) return;
    const index = playerIndex(room, socket.id);
    if (index !== game.turn || !game.drawnPlayableCardId) return;
    beginTurnAction(room);
    game.drawnPlayableCardId = null;
    game.armedUnoPlayerId = null;
    notice(room, `${playerName(room, socket.id)} passes after drawing.`, 'info');
    advance(room);
    sendState(room);
  });

  socket.on('callUno', () => {
    const room = findRoomBySocket(socket.id);
    const game = room?.game;
    if (!room || !game || game.winnerId) return;
    const index = playerIndex(room, socket.id);
    if (index !== game.turn || game.hands[index]?.length !== 2) {
      return socket.emit('toast', { text: 'Call UNO when you have two cards, before playing one.', kind: 'warning' });
    }
    game.armedUnoPlayerId = socket.id;
    game.unoAnnouncement = { id: randomUUID(), playerId: socket.id, kind: 'call', at: Date.now() };
    notice(room, `${playerName(room, socket.id)} calls UNO!`, 'uno');
    sendState(room);
  });

  socket.on('catchUno', targetId => {
    const room = findRoomBySocket(socket.id);
    const game = room?.game;
    const challenge = game?.unoChallenge;
    if (!room || !game || !challenge || Date.now() > challenge.deadline) return;
    if (socket.id === challenge.targetId || socket.id === targetId) return;
    if (targetId && targetId !== challenge.targetId) return;
    const offenderIndex = playerIndex(room, challenge.targetId);
    if (offenderIndex < 0) return;
    endUnoChallenge(room);
    drawIntoHand(game, offenderIndex, 2);
    notice(room, `${playerName(room, challenge.targetId)} was caught! Draw 2 cards.`, 'penalty');
    sendState(room);
  });

  socket.on('challengeWild4', () => {
    const room = findRoomBySocket(socket.id);
    if (room) challengeWild4(room, socket);
  });

  socket.on('swapHands', targetId => {
    const room = findRoomBySocket(socket.id);
    if (room) swapHands(room, socket, targetId);
  });

  socket.on('pressSix', reactionId => {
    const room = findRoomBySocket(socket.id);
    const reaction = room?.game?.sixReaction;
    if (!room || !reaction || !reaction.active || reaction.id !== reactionId) return;
    if (!reaction.playerIds.includes(socket.id) || reaction.pressed.includes(socket.id)) return;
    reaction.pressed.push(socket.id);
    if (reaction.pressed.length === reaction.playerIds.length) finishSixReaction(room);
    else sendState(room);
  });

  socket.on('leaveRoom', () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const index = playerIndex(room, socket.id);
    socket.leave(room.code);
    removePlayer(room, index, 'left the room');
    socket.emit('roomLeft');
  });

  socket.on('disconnect', () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const index = playerIndex(room, socket.id);
    const player = room.players[index];
    if (!room.game) {
      removePlayer(room, index, 'disconnected');
      return;
    }
    player.connected = false;
    player.graceTimer = setTimeout(() => {
      const currentIndex = playerIndex(room, player.id);
      if (currentIndex >= 0 && !room.players[currentIndex].connected) removePlayer(room, currentIndex, 'was removed after disconnecting');
    }, DISCONNECT_GRACE_MS);
    scheduleDisconnectedTurn(room, player);
    notice(room, `${player.name} disconnected. They can reconnect for 60 seconds.`, 'warning');
    sendState(room);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`My-Web UNO V2 listening on http://localhost:${PORT}`);
});

module.exports = { app, server, rooms };
