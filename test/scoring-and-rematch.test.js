'use strict';
// Round-end scoring (classic UNO: winner collects the point value of every card left in
// everyone else's hand) and the host's "play again" rematch, which must keep room.scores.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.PORT = '0';
let client;
try { client = require('socket.io-client'); } catch { client = null; }
const { server, rooms } = require('../server');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const once = (socket, event) => new Promise(resolve => socket.once(event, resolve));

async function setup() {
  if (!server.listening) await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const sockets = [];
  for (let i = 0; i < 2; i += 1) { const s = client(`http://localhost:${port}`, { forceNew: true, transports: ['websocket'] }); await once(s, 'connect'); sockets.push(s); }
  sockets[0].emit('createRoom', { name: 'Host' });
  const joined = await once(sockets[0], 'roomJoined');
  sockets[1].emit('joinRoom', { name: 'P1', code: joined.code }); await once(sockets[1], 'roomJoined');
  await wait(30); sockets[0].emit('startGame'); await wait(80);
  const room = rooms.get(joined.code);
  return { sockets, room };
}

test('round end: winner is credited the loser\'s remaining card points; hands are revealed', { skip: !client }, async () => {
  const { sockets, room } = await setup();
  const game = room.game;
  const turn = game.turn, other = 1 - turn;
  // Stack the loser's hand with known values so the expected total is exact: 7 + Skip(20) + Wild(50) = 77.
  game.hands[other].length = 0;
  game.hands[other].push({ id: 'k1', color: 'red', value: '7' }, { id: 'k2', color: 'red', value: 'Skip' }, { id: 'k3', color: 'wild', value: 'Wild' });
  // Give the current player a single legal final card.
  game.hands[turn].length = 0;
  game.hands[turn].push({ id: 'last', color: game.color, value: '5' });
  sockets[turn].emit('playCard', { cardId: 'last' });
  await wait(120);
  const winnerId = room.players[turn].id, loserId = room.players[other].id;
  assert.equal(game.winnerId, winnerId);
  assert.equal(game.roundPoints, 77);
  assert.equal(room.scores[winnerId], 77);
  assert.ok(!room.scores[loserId]);
  assert.deepEqual(new Set(game.handsReveal[loserId].map(c => c.id)), new Set(['k1', 'k2', 'k3']));
  sockets.forEach(s => s.close());
});

test('play again: only the host may start the next round, and scores carry over', { skip: !client }, async () => {
  const { sockets, room } = await setup();
  const game = room.game;
  const turn = game.turn, other = 1 - turn;
  game.hands[other].length = 0; game.hands[other].push({ id: 'x', color: 'red', value: '9' });
  game.hands[turn].length = 0; game.hands[turn].push({ id: 'last2', color: game.color, value: '3' });
  sockets[turn].emit('playCard', { cardId: 'last2' });
  await wait(120);
  const winnerId = room.players[turn].id;
  const before = { ...room.scores };
  // Non-host cannot start the next round.
  sockets[1 - (turn === 0 ? 0 : 1)]; // no-op, keep lint calm about unused
  const nonHost = room.hostId === sockets[0].id ? sockets[1] : sockets[0];
  nonHost.emit('playAgain'); await wait(80);
  assert.ok(room.game.winnerId, 'round did not restart for a non-host request');
  const host = room.hostId === sockets[0].id ? sockets[0] : sockets[1];
  host.emit('playAgain'); await wait(80);
  assert.equal(room.game.winnerId, null, 'new round started');
  assert.equal(room.scores[winnerId], before[winnerId], 'scores carried over into the new round');
  sockets.forEach(s => s.close());
});

test.after(() => { server.close(); setTimeout(() => process.exit(0), 50).unref(); });
