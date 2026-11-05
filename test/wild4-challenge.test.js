'use strict';
// +4 challenge must be available on every fresh +4 — with and without the stacking house rule.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.PORT = '0';
let client;
try { client = require('socket.io-client'); } catch { client = null; }
const { server, rooms } = require('../server');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const once = (socket, event) => new Promise(resolve => socket.once(event, resolve));

async function setup(stacking, illegal) {
  if (!server.listening) await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const sockets = [];
  for (let i = 0; i < 2; i += 1) { const s = client(`http://localhost:${port}`, { forceNew: true, transports: ['websocket'] }); await once(s, 'connect'); sockets.push(s); }
  sockets[0].emit('createRoom', { name: 'Host' });
  const joined = await once(sockets[0], 'roomJoined');
  sockets[1].emit('joinRoom', { name: 'P1', code: joined.code }); await once(sockets[1], 'roomJoined');
  sockets[0].emit('updateSettings', { stacking });
  await wait(50); sockets[0].emit('startGame'); await wait(100);
  const game = rooms.get(joined.code).game;
  const turn = game.turn;
  const hand = game.hands[turn];
  // Make the +4 legal or illegal: illegal = holder also has a card of the current colour.
  hand.length = 0;
  hand.push({ id: 'w4', color: 'wild', value: 'Wild4' });
  if (illegal) hand.push({ id: 'keep', color: game.color, value: '5' });
  else hand.push({ id: 'keep', color: game.color === 'red' ? 'blue' : 'red', value: '5' });
  sockets[turn].emit('playCard', { cardId: 'w4', color: 'green' });
  await wait(120);
  return { sockets, game, turn, other: 1 - turn };
}

for (const stacking of [false, true]) {
  test(`+4 can be challenged (stacking ${stacking ? 'on' : 'off'}) — illegal +4: offender draws 4`, { skip: !client }, async () => {
    const { sockets, game, turn, other } = await setup(stacking, true);
    assert.ok(game.pendingWild4, 'challenge pending');
    const before = game.hands[turn].length;
    sockets[other].emit('challengeWild4'); await wait(120);
    assert.equal(game.hands[turn].length, before + 4);
    assert.equal(game.pendingWild4, null);
    sockets.forEach(s => s.close());
  });
  test(`+4 can be challenged (stacking ${stacking ? 'on' : 'off'}) — legal +4: challenger draws 6`, { skip: !client }, async () => {
    const { sockets, game, other } = await setup(stacking, false);
    const before = game.hands[other].length;
    sockets[other].emit('challengeWild4'); await wait(120);
    assert.equal(game.hands[other].length, before + 6);
    sockets.forEach(s => s.close());
  });
}
test('+4 decline draws 4', { skip: !client }, async () => {
  const { sockets, game, other } = await setup(true, true);
  const before = game.hands[other].length;
  sockets[other].emit('drawCard'); await wait(120);
  assert.equal(game.hands[other].length, before + 4);
  sockets.forEach(s => s.close());
});
test.after(() => { server.close(); setTimeout(() => process.exit(0), 50).unref(); });
