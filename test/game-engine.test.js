'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../lib/game-engine');

function sampleGame(settings = {}) {
  return {
    deck: [],
    discard: [{ id: 'top', color: 'red', value: '5' }],
    hands: [],
    turn: 0,
    direction: 1,
    color: 'red',
    pendingDraw: 0,
    pendingType: null,
    winnerId: null,
    drawnPlayableCardId: null,
    armedUnoPlayerId: null,
    awaitingSwapPlayerId: null,
    pendingWild4: null,
    sixReaction: null,
    settings: { ...engine.DEFAULT_SETTINGS, ...settings },
  };
}

test('classic deck has 108 unique card IDs', () => {
  const deck = engine.createDeck(() => 0.42);
  assert.equal(deck.length, 108);
  assert.equal(new Set(deck.map(card => card.id)).size, 108);
});

test('classic deck contains one zero and two of each 1–9/action per colour', () => {
  const deck = engine.createDeck(() => 0.17);
  for (const color of engine.COLORS) {
    assert.equal(deck.filter(card => card.color === color && card.value === '0').length, 1);
    for (let n = 1; n <= 9; n += 1) {
      assert.equal(deck.filter(card => card.color === color && card.value === String(n)).length, 2);
    }
    for (const value of ['Skip', 'Reverse', 'Draw2']) {
      assert.equal(deck.filter(card => card.color === color && card.value === value).length, 2);
    }
  }
  assert.equal(deck.filter(card => card.value === 'Wild').length, 4);
  assert.equal(deck.filter(card => card.value === 'Wild4').length, 4);
});

test('game setup gives every player seven cards and a non-wild number discard', () => {
  const game = engine.createGame(4, {}, () => 0.29);
  assert.equal(game.hands.length, 4);
  assert.ok(game.hands.every(hand => hand.length === 7));
  assert.equal(game.discard.length, 1);
  assert.notEqual(game.discard[0].color, 'wild');
  assert.match(game.discard[0].value, /^\d$/);
  const remaining = game.hands.reduce((sum, hand) => sum + hand.length, 0) + game.deck.length + game.discard.length;
  assert.equal(remaining, 108);
});

test('playability matches colour, value, and wild rules', () => {
  const game = sampleGame();
  const hand = [];
  assert.equal(engine.canPlay(game, hand, { id: 'a', color: 'red', value: '2' }), true);
  assert.equal(engine.canPlay(game, hand, { id: 'b', color: 'blue', value: '5' }), true);
  assert.equal(engine.canPlay(game, hand, { id: 'c', color: 'blue', value: '2' }), false);
  assert.equal(engine.canPlay(game, hand, { id: 'd', color: 'wild', value: 'Wild' }), true);
  assert.equal(engine.canPlay(game, hand, { id: 'e', color: 'wild', value: 'Wild4' }), true);
});

test('Wild Draw Four can be challenged even when a matching colour is held', () => {
  const game = sampleGame();
  const hand = [{ id: 'same-color', color: 'red', value: '3' }, { id: 'wild-four', color: 'wild', value: 'Wild4' }];
  assert.equal(engine.canPlay(game, hand, hand[1]), true);
  assert.equal(engine.hasColor(hand, 'red', 'wild-four'), true);
});

test('matching draw penalties can stack in their own type without the modifier', () => {
  const game = sampleGame();
  game.pendingDraw = 2;
  game.pendingType = 'Draw2';
  assert.equal(engine.canCounterPenalty(game, { color: 'blue', value: 'Draw2' }), true);
  assert.equal(engine.canCounterPenalty(game, { color: 'red', value: 'Wild4' }), false);
  game.pendingDraw = 4;
  game.pendingType = 'Wild4';
  assert.equal(engine.canCounterPenalty(game, { color: 'wild', value: 'Wild4' }), true);
  assert.equal(engine.canCounterPenalty(game, { color: 'red', value: 'Draw2' }), false);
});

test('stacking modifier enables extra counters', () => {
  const game = sampleGame({ stacking: true });
  game.pendingDraw = 2;
  game.pendingType = 'Draw2';
  assert.equal(engine.canCounterPenalty(game, { color: 'wild', value: 'Wild4' }), true);
  assert.equal(engine.canCounterPenalty(game, { color: 'red', value: 'Skip' }), true);
  game.pendingType = 'Wild4';
  game.color = 'blue';
  assert.equal(engine.canCounterPenalty(game, { color: 'blue', value: 'Reverse' }), true);
});

test('nextTurn wraps correctly in clockwise and counter-clockwise directions', () => {
  const game = sampleGame();
  game.turn = 3;
  engine.nextTurn(game, 1, 4);
  assert.equal(game.turn, 0);
  game.direction = -1;
  engine.nextTurn(game, 1, 4);
  assert.equal(game.turn, 3);
});

test('drawing from an empty draw pile reshuffles all but the top discard', () => {
  const game = sampleGame();
  game.deck = [];
  game.discard = [
    { id: 'discard-1', color: 'red', value: '1' },
    { id: 'discard-2', color: 'blue', value: '2' },
    { id: 'top', color: 'green', value: '7' },
  ];
  const drawn = engine.drawOne(game, () => 0.3);
  assert.ok(drawn);
  assert.equal(game.discard.length, 1);
  assert.equal(game.discard[0].id, 'top');
  assert.equal(game.deck.length, 1);
});
