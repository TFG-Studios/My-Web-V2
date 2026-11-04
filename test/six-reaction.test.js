'use strict';
// End-to-end check of the "6 reaction" rule through real socket connections:
//  • everyone taps  → the LAST tapper draws 2
//  • somebody never taps → they (and only they) draw 2
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.PORT = '0';
process.env.UNO_SIX_FAILSAFE_MS = '1200'; // shorten the hidden safety net for the test
let client;
try { client = require('socket.io-client'); } catch { client = null; }
const { server, rooms } = require('../server');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const once = (socket, event) => new Promise(resolve => socket.once(event, resolve));

async function setup(playerCount) {
  const port = server.address().port;
  const sockets = [];
  for (let i = 0; i < playerCount; i += 1) {
    const socket = client(`http://localhost:${port}`, { forceNew: true, transports: ['websocket'] });
    await once(socket, 'connect');
    sockets.push(socket);
  }
  sockets[0].emit('createRoom', { name: 'Host' });
  const joined = await once(sockets[0], 'roomJoined');
  for (let i = 1; i < playerCount; i += 1) { sockets[i].emit('joinRoom', { name: `P${i}`, code: joined.code }); await once(sockets[i], 'roomJoined'); }
  sockets[0].emit('updateSettings', { sixReaction: true });
  await wait(50);
  sockets[0].emit('startGame');
  await wait(100);
  const room = rooms.get(joined.code);
  const game = room.game;
  // Put a playable 6 in the current player's hand and play it.
  const turn = game.turn;
  game.hands[turn].push({ id: 'test-six', color: game.color, value: '6' });
  sockets[turn].emit('playCard', { cardId: 'test-six' });
  await wait(100);
  assert.ok(game.sixReaction?.active, 'reaction started');
  return { sockets, room, game };
}

const counts = game => game.hands.map(hand => hand.length);

test('6 reaction: everyone taps → the last tapper draws 2', { skip: !client }, async () => {
  if (!server.listening) await new Promise(resolve => server.listen(0, resolve));
  const { sockets, room, game } = await setup(3);
  const before = counts(game);
  await wait(2400); // wait for the GO moment
  const order = [2, 0, 1]; // player 1 taps last
  for (const i of order) { sockets[i].emit('pressSix', game.sixReaction.id); await wait(40); }
  await wait(150);
  const after = counts(game);
  assert.equal(game.sixReaction, null, 'reaction finished once everyone tapped');
  assert.deepEqual(game.lastSixResult.loserIds, [room.players[1].id]);
  assert.equal(after[1], before[1] + 2, 'last tapper drew 2');
  assert.equal(after[0], before[0]); assert.equal(after[2], before[2]);
  sockets.forEach(s => s.close());
});

test('6 reaction: a player who never taps draws 2', { skip: !client }, async () => {
  if (!server.listening) await new Promise(resolve => server.listen(0, resolve));
  const { sockets, room, game } = await setup(3);
  const before = counts(game);
  await wait(2400);
  sockets[0].emit('pressSix', game.sixReaction.id);
  sockets[2].emit('pressSix', game.sixReaction.id);
  await wait(1600); // the hidden safety net expires
  const after = counts(game);
  assert.deepEqual(game.lastSixResult.loserIds, [room.players[1].id]);
  assert.equal(game.lastSixResult.reason, 'missed');
  assert.equal(after[1], before[1] + 2);
  sockets.forEach(s => s.close());
});

test('6 reaction: taps before GO are ignored', { skip: !client }, async () => {
  if (!server.listening) await new Promise(resolve => server.listen(0, resolve));
  const { sockets, game } = await setup(2);
  sockets[0].emit('pressSix', game.sixReaction.id);
  await wait(60);
  assert.equal(game.sixReaction.pressed.length, 0, 'false start ignored');
  sockets.forEach(s => s.close());
  await wait(100);
});

test.after(() => { server.close(); setTimeout(() => process.exit(0), 50).unref(); });
