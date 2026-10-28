'use strict';

const { randomUUID } = require('node:crypto');

const COLORS = Object.freeze(['red', 'yellow', 'green', 'blue']);
const ACTIONS = Object.freeze(['Skip', 'Reverse', 'Draw2']);
const DEFAULT_SETTINGS = Object.freeze({
  stacking: false,
  zeroSeven: false,
  drawUntilPlayable: false,
  sixReaction: false,
});

function createCard(color, value) {
  return { id: randomUUID(), color, value };
}

function shuffle(items, random = Math.random) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function createDeck(random = Math.random) {
  const deck = [];
  for (const color of COLORS) {
    deck.push(createCard(color, '0'));
    for (let n = 1; n <= 9; n += 1) {
      deck.push(createCard(color, String(n)));
      deck.push(createCard(color, String(n)));
    }
    for (const value of ACTIONS) {
      deck.push(createCard(color, value));
      deck.push(createCard(color, value));
    }
  }
  for (let i = 0; i < 4; i += 1) {
    deck.push(createCard('wild', 'Wild'));
    deck.push(createCard('wild', 'Wild4'));
  }
  return shuffle(deck, random);
}

function refillDeck(game, random = Math.random) {
  if (game.deck.length) return;
  if (game.discard.length <= 1) return;
  const top = game.discard.pop();
  game.deck = shuffle(game.discard.splice(0), random);
  game.discard = [top];
}

function drawOne(game, random = Math.random) {
  refillDeck(game, random);
  return game.deck.pop() || null;
}

function createGame(playerCount, settings = {}, random = Math.random) {
  if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > 5) {
    throw new RangeError('UNO games require 2–5 players.');
  }
  const deck = createDeck(random);
  const hands = Array.from({ length: playerCount }, () => []);
  for (let round = 0; round < 7; round += 1) {
    for (let player = 0; player < playerCount; player += 1) {
      hands[player].push(deck.pop());
    }
  }
  // Use a number card as the opening discard so round start is deterministic
  // and does not require a special-action resolution step.
  let openingIndex = deck.findIndex(card => card.color !== 'wild' && /^\d$/.test(card.value));
  if (openingIndex < 0) openingIndex = 0;
  const [opening] = deck.splice(openingIndex, 1);
  return {
    deck,
    discard: [opening],
    hands,
    turn: 0,
    direction: 1,
    color: opening.color,
    pendingDraw: 0,
    pendingType: null,
    winnerId: null,
    lastAction: null,
    lastPlayerId: null,
    lastCardId: null,
    drawnPlayableCardId: null,
    armedUnoPlayerId: null,
    unoChallenge: null,
    unoAnnouncement: null,
    awaitingSwapPlayerId: null,
    pendingWild4: null,
    sixReaction: null,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    roundId: randomUUID(),
  };
}

function hasColor(hand, color, exceptCardId = null) {
  return hand.some(card => card.id !== exceptCardId && card.color === color);
}

function canCounterPenalty(game, card) {
  if (!game || !card || game.pendingDraw <= 0) return false;
  if (game.pendingType === 'Draw2' && card.value === 'Draw2') return true;
  if (game.pendingType === 'Wild4' && card.value === 'Wild4') return true;
  if (!game.settings.stacking) return false;
  if (game.pendingType === 'Draw2' && card.value === 'Wild4') return true;
  return (card.value === 'Skip' || card.value === 'Reverse') &&
    (card.color === game.color || card.value === game.pendingType);
}

function canPlay(game, hand, card) {
  if (!game || !card || game.winnerId) return false;
  if (game.awaitingSwapPlayerId) return false;
  if (game.sixReaction?.active) return false;
  if (game.pendingWild4) return false;
  if (game.drawnPlayableCardId && card.id !== game.drawnPlayableCardId) return false;
  if (game.pendingDraw > 0) return canCounterPenalty(game, card);
  if (card.value === 'Wild') return true;
  if (card.value === 'Wild4') {
    // Allow the move so the target can challenge it; the server records
    // whether the player held a matching colour and resolves the challenge.
    return true;
  }
  const top = game.discard[game.discard.length - 1];
  return card.color === game.color || card.value === top.value;
}

function nextTurn(game, steps = 1, playerCount = game.hands.length) {
  if (playerCount <= 0) return;
  game.turn = (game.turn + game.direction * steps) % playerCount;
  if (game.turn < 0) game.turn += playerCount;
  game.drawnPlayableCardId = null;
  game.armedUnoPlayerId = null;
}

module.exports = {
  COLORS,
  DEFAULT_SETTINGS,
  ACTIONS,
  createCard,
  shuffle,
  createDeck,
  createGame,
  drawOne,
  canPlay,
  canCounterPenalty,
  hasColor,
  nextTurn,
};
