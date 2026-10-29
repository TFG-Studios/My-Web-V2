'use strict';

(() => {
  const socket = io();
  const $ = id => document.getElementById(id);
  const COLORS = ['red', 'yellow', 'green', 'blue'];
  const COLOR_LABELS = { red: 'RED', yellow: 'YELLOW', green: 'GREEN', blue: 'BLUE' };
  const COLOR_HEX = { red: '#f3293f', yellow: '#ffd92f', green: '#22aa66', blue: '#147bd1' };
  const LETTERS = { red: 'R', yellow: 'Y', green: 'G', blue: 'B' };
  const DEFAULT_PREFS = { musicEnabled: true, musicVolume: 25, sfxEnabled: true, sfxVolume: 65, reduceMotion: false };
  const STORAGE_KEY = 'myweb-uno-v2-preferences';
  const TOKEN_KEY = 'myweb-uno-v2-session';

  let state = null;
  let roomCode = '';
  let setupMode = 'create';
  let pendingWildCardId = null;
  let lastUnoAnimationId = null;
  let lastWinnerShown = null;
  let lastAnimatedCardId = null;
  let lastDiscardVisualId = null;
  let unoChallengeTicker = null;
  let lastNoticeId = null;
  let reactionTicker = null;
  let musicTicker = null;
  let musicStep = 0;
  let audioContext = null;
  let lastGameSnapshot = null;
  let prefs = loadPrefs();

  function makeToken() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `player-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }
  let sessionToken = localStorage.getItem(TOKEN_KEY) || makeToken();
  localStorage.setItem(TOKEN_KEY, sessionToken);

  function loadPrefs() {
    try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }; }
    catch { return { ...DEFAULT_PREFS }; }
  }
  function savePrefs() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    document.documentElement.classList.toggle('reduce-motion', Boolean(prefs.reduceMotion));
    updateAudioControls();
  }

  function showScreen(id) {
    ['splashScreen', 'mainMenu', 'lobbyScreen', 'gameScreen'].forEach(screenId => {
      $(screenId).classList.toggle('is-hidden', screenId !== id);
    });
    document.body.dataset.screen = id;
  }
  function openModal(id) { $(id)?.classList.remove('is-hidden'); }
  function closeModal(id) { $(id)?.classList.add('is-hidden'); }
  function hideAllModals() {
    ['roomSetupModal', 'settingsModal', 'howToPlayModal', 'wildPicker'].forEach(closeModal);
  }

  function toast(text, kind = 'info') {
    if (!text) return;
    const item = document.createElement('div');
    item.className = `toast toast-${kind}`;
    item.innerHTML = `<span class="toast-mark">${kind === 'warning' || kind === 'penalty' ? '!' : kind === 'success' || kind === 'win' ? '✓' : '✦'}</span><span></span><button type="button" aria-label="Dismiss">×</button>`;
    item.querySelector('span:nth-child(2)').textContent = text;
    item.querySelector('button').addEventListener('click', () => item.remove());
    $('toastStack').appendChild(item);
    requestAnimationFrame(() => item.classList.add('toast-in'));
    window.setTimeout(() => {
      item.classList.remove('toast-in');
      window.setTimeout(() => item.remove(), 250);
    }, kind === 'warning' || kind === 'penalty' ? 5200 : 3400);
    $('globalLiveRegion').textContent = text;
  }

  function initAudio() {
    if (!audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) audioContext = new AudioContextClass();
    }
    if (audioContext?.state === 'suspended') audioContext.resume().catch(() => {});
  }
  function tone(frequency, duration = 0.11, wave = 'sine', volume = 0.08, delay = 0) {
    if (!audioContext || !prefs.sfxEnabled || prefs.sfxVolume <= 0) return;
    const now = audioContext.currentTime + delay;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume * prefs.sfxVolume / 100), now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }
  function playSfx(type) {
    initAudio();
    const clips = {
      card: [[660, .07, 'triangle', .07], [890, .08, 'sine', .045, .035]],
      draw: [[440, .09, 'triangle', .055], [350, .12, 'sine', .035, .045]],
      action: [[220, .16, 'sawtooth', .045], [330, .18, 'triangle', .04, .07]],
      uno: [[523, .14, 'triangle', .07], [784, .16, 'triangle', .07, .10], [1046, .22, 'sine', .055, .22]],
      error: [[190, .13, 'square', .035], [155, .16, 'square', .03, .1]],
      win: [[523, .17, 'triangle', .065], [659, .18, 'triangle', .065, .12], [784, .22, 'triangle', .07, .24], [1046, .3, 'sine', .06, .38]],
      reaction: [[880, .08, 'square', .035], [660, .08, 'square', .035, .1]],
      click: [[580, .045, 'sine', .035]],
    };
    (clips[type] || clips.click).forEach(([freq, duration, wave, volume, delay = 0]) => tone(freq, duration, wave, volume, delay));
  }
  function startMusic() {
    initAudio();
    if (!prefs.musicEnabled || prefs.musicVolume <= 0 || !audioContext || musicTicker) return;
    const notes = [196, 246.94, 293.66, 246.94, 220, 261.63, 329.63, 261.63];
    musicTicker = window.setInterval(() => {
      if (!prefs.musicEnabled || prefs.musicVolume <= 0 || !audioContext) return;
      const now = audioContext.currentTime;
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = notes[musicStep % notes.length];
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.014 * prefs.musicVolume / 25, now + .12);
      gain.gain.exponentialRampToValueAtTime(.0001, now + .62);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(now);
      oscillator.stop(now + .65);
      musicStep += 1;
    }, 620);
  }
  function stopMusic() {
    if (musicTicker) window.clearInterval(musicTicker);
    musicTicker = null;
  }
  function updateAudioControls() {
    $('musicEnabled').checked = Boolean(prefs.musicEnabled);
    $('sfxEnabled').checked = Boolean(prefs.sfxEnabled);
    $('musicVolume').value = String(prefs.musicVolume);
    $('sfxVolume').value = String(prefs.sfxVolume);
    $('reduceMotion').checked = Boolean(prefs.reduceMotion);
    $('musicVolumeValue').value = `${prefs.musicVolume}%`;
    $('musicVolumeValue').textContent = `${prefs.musicVolume}%`;
    $('sfxVolumeValue').value = `${prefs.sfxVolume}%`;
    $('sfxVolumeValue').textContent = `${prefs.sfxVolume}%`;
    if (!prefs.musicEnabled || prefs.musicVolume === 0) stopMusic();
    else if (audioContext && !musicTicker) startMusic();
  }

  function cardFile(card) {
    if (!card) return null;
    if (card.color === 'wild') return card.value === 'Wild4' ? 'W4.png' : 'WC.png';
    const prefix = LETTERS[card.color];
    if (!prefix) return null;
    const value = card.value === 'Skip' ? 'S' : card.value === 'Reverse' ? 'R' : card.value === 'Draw2' ? 'A2' : card.value;
    return `${prefix}${value}.png`;
  }
  function cardSymbol(value) {
    if (value === 'Skip') return '⊘';
    if (value === 'Reverse') return '↻';
    if (value === 'Draw2') return '+2';
    if (value === 'Wild4') return '+4';
    if (value === 'Wild') return '✦';
    return value;
  }
  function cardLabel(card) {
    if (!card) return '';
    if (card.value === 'Wild4') return 'Wild Draw Four';
    if (card.value === 'Wild') return 'Wild';
    if (card.value === 'Draw2') return `${card.color} Draw Two`;
    return `${card.color || 'Wild'} ${card.value}`;
  }
  function createCardElement(card, options = {}) {
    const button = document.createElement(options.interactive ? 'button' : 'div');
    button.className = `playing-card card-${card.color}${options.small ? ' card-small' : ''}${options.compact ? ' card-compact' : ''}`;
    button.dataset.cardId = card.id || '';
    button.setAttribute('aria-label', cardLabel(card));
    if (options.interactive) {
      button.type = 'button';
      button.title = cardLabel(card);
      button.addEventListener('click', () => onCardChosen(card, button));
    }
    const filename = cardFile(card);
    if (filename) {
      const image = document.createElement('img');
      image.className = 'card-face-image';
      image.src = `/cards/${filename}`;
      image.alt = cardLabel(card);
      image.draggable = false;
      image.addEventListener('error', () => {
        image.remove();
        if (!button.querySelector('.card-face-fallback')) {
          button.appendChild(makeFallbackFace(card));
        }
      }, { once: true });
      button.appendChild(image);
    } else button.appendChild(makeFallbackFace(card));
    return button;
  }
  function makeFallbackFace(card) {
    const face = document.createElement('span');
    face.className = 'card-face-fallback';
    const corner = document.createElement('span');
    corner.className = 'card-corner card-corner-top';
    corner.textContent = cardSymbol(card.value);
    const oval = document.createElement('span');
    oval.className = 'card-oval';
    const center = document.createElement('strong');
    center.textContent = cardSymbol(card.value);
    const bottom = document.createElement('span');
    bottom.className = 'card-corner card-corner-bottom';
    bottom.textContent = cardSymbol(card.value);
    face.append(corner, oval, center, bottom);
    if (card.color === 'wild') face.classList.add('fallback-wild');
    return face;
  }
  function makeCardBack() {
    const back = document.createElement('div');
    back.className = 'playing-card card-back';
    const img = document.createElement('img');
    img.src = '/cards/BACK.png';
    img.alt = 'Face-down UNO card';
    img.draggable = false;
    img.addEventListener('error', () => { img.src = '/assets/card-back.svg'; }, { once: true });
    back.appendChild(img);
    return back;
  }

  function activateTextureCardBack() {
    const probe = new Image();
    probe.onload = () => {
      const deckImage = $('drawPile')?.querySelector('img');
      if (deckImage) deckImage.src = '/cards/BACK.png';
      document.documentElement.classList.add('has-atlas-card-back');
    };
    probe.src = '/cards/BACK.png';
  }

  function localCanPlay(card, game, hand) {
    if (!state || !game || game.winnerId || game.sixReaction?.active || game.awaitingSwapPlayerId || game.pendingWild4) return false;
    if (game.pendingDraw > 0) {
      if (game.pendingType === 'Draw2' && card.value === 'Draw2') return true;
      if (game.pendingType === 'Wild4' && card.value === 'Wild4') return true;
      if (!state.settings.stacking) return false;
      if (game.pendingType === 'Draw2' && card.value === 'Wild4') return true;
      return (card.value === 'Skip' || card.value === 'Reverse') && (card.color === game.color || card.value === game.pendingType);
    }
    if (game.drawnPlayableCardId && card.id !== game.drawnPlayableCardId) return false;
    if (card.color === 'wild') return true;
    const top = game.top;
    return card.color === game.color || card.value === top?.value;
  }

  function animateCardToDiscard(element) {
    const target = $('discardPile');
    if (!element || !target || prefs.reduceMotion || !element.isConnected) return;
    const from = element.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    const clone = element.cloneNode(true);
    clone.classList.add('flying-card');
    clone.style.left = `${from.left}px`;
    clone.style.top = `${from.top}px`;
    clone.style.width = `${from.width}px`;
    clone.style.height = `${from.height}px`;
    $('cardFlightLayer').appendChild(clone);
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    clone.animate([
      { transform: 'translate(0, 0) rotate(0deg) skew(0deg, 0deg) scale(1)', opacity: 1 },
      { transform: `translate(${dx * .28}px, ${dy * .28 - 35}px) rotate(-12deg) skew(-4deg, 0deg) scale(1.08)`, opacity: 1, offset: .28 },
      { transform: `translate(${dx}px, ${dy}px) rotate(16deg) skew(2deg, 0deg) scale(.82)`, opacity: .15 },
    ], { duration: 470, easing: 'cubic-bezier(.2,.85,.24,1)', fill: 'forwards' }).onfinish = () => clone.remove();
  }

  function onCardChosen(card, element) {
    if (!state?.game || state.game.winnerId) return;
    const me = state.players.find(player => player.id === socket.id);
    if (!me?.isTurn) return toast('Wait for your turn.', 'warning');
    if (!localCanPlay(card, state.game, state.game.hand || [])) {
      if (element && !prefs.reduceMotion) {
        element.classList.remove('card-rejected');
        void element.offsetWidth;
        element.classList.add('card-rejected');
        window.setTimeout(() => element.classList.remove('card-rejected'), 420);
      }
      playSfx('error');
      return toast('That card cannot be played right now.', 'warning');
    }
    if (card.color === 'wild') {
      pendingWildCardId = card.id;
      $('wildPicker').classList.remove('is-hidden');
      playSfx('click');
      return;
    }
    if (element) {
      element.classList.add('card-selected');
      element.animate([
        { transform: 'translateY(-10px) rotate(-1deg) skew(-1deg, 0deg) scale(1.03)' },
        { transform: 'translateY(-4px) rotate(1.2deg) skew(1deg, 0deg) scale(1.02)' },
      ], { duration: 130, easing: 'ease-out' });
    }
    playSfx(card.value === 'Draw2' || card.value === 'Wild4' || card.value === 'Skip' || card.value === 'Reverse' ? 'action' : 'card');
    socket.emit('playCard', { cardId: card.id });
  }

  function renderLobby(next) {
    $('roomCodeDisplay').textContent = next.code || '------';
    $('playerCount').textContent = `${next.players.length}/5`;
    const isHost = socket.id === next.hostId;
    $('hostBadge').classList.toggle('is-hidden', !isHost);
    $('rulesLockLabel').textContent = isHost ? 'HOST ONLY' : 'VIEW ONLY';
    $('lobbyPlayers').replaceChildren();
    const palette = ['red', 'blue', 'yellow', 'green', 'purple'];
    next.players.forEach((player, index) => {
      const row = document.createElement('div');
      row.className = `lobby-player-row${player.id === next.hostId ? ' player-is-host' : ''}${!player.connected ? ' player-offline' : ''}`;
      const avatar = document.createElement('span');
      avatar.className = `avatar avatar-${palette[index % palette.length]}`;
      avatar.textContent = player.name.slice(0, 1).toUpperCase();
      const identity = document.createElement('div');
      identity.className = 'lobby-player-identity';
      const name = document.createElement('b');
      name.textContent = player.name + (player.id === socket.id ? ' (you)' : '');
      const status = document.createElement('small');
      status.textContent = !player.connected ? 'Reconnecting…' : player.id === next.hostId ? 'HOST · DEALER' : 'READY TO PLAY';
      identity.append(name, status);
      const right = document.createElement('span');
      right.className = 'player-status-icon';
      right.textContent = !player.connected ? '…' : player.id === next.hostId ? '★' : '✓';
      row.append(avatar, identity, right);
      $('lobbyPlayers').appendChild(row);
    });
    const canStart = isHost && next.players.length >= 2;
    $('startGame').disabled = !canStart;
    $('startGame').classList.toggle('btn-disabled', !canStart);
    $('lobbyHint').textContent = !isHost ? 'Waiting for the host to deal the cards…' : next.players.length < 2 ? 'Waiting for one more player…' : 'Everyone is here. Deal whenever you are ready.';
    const settingsIds = {
      stacking: 'ruleStacking', zeroSeven: 'ruleZeroSeven',
      drawUntilPlayable: 'ruleDrawUntil', sixReaction: 'ruleSixReaction',
    };
    for (const [key, id] of Object.entries(settingsIds)) {
      $(id).checked = Boolean(next.settings[key]);
      $(id).disabled = !isHost || next.started;
    }
  }

  function renderOpponents(next) {
    const game = next.game;
    const meIndex = next.players.findIndex(player => player.id === socket.id);
    const others = next.players.filter(player => player.id !== socket.id);
    const n = others.length;
    const seatMaps = {
      1: ['seat-top'],
      2: ['seat-top-left', 'seat-top-right'],
      3: ['seat-left', 'seat-top', 'seat-right'],
      4: ['seat-left', 'seat-top-left', 'seat-top-right', 'seat-right'],
    };
    const seats = seatMaps[n] || seatMaps[4];
    $('opponents').replaceChildren();
    others.forEach((player, index) => {
      const seat = document.createElement('div');
      seat.className = `opponent-seat ${seats[index] || 'seat-top'}${player.isTurn ? ' opponent-active' : ''}${!player.connected ? ' opponent-offline' : ''}`;
      seat.dataset.playerId = player.id;
      const badge = document.createElement('button');
      badge.className = 'opponent-badge';
      badge.type = 'button';
      badge.disabled = true;
      const avatar = document.createElement('span');
      avatar.className = 'avatar avatar-opponent';
      avatar.textContent = player.name.slice(0, 1).toUpperCase();
      const label = document.createElement('span');
      label.className = 'opponent-name';
      label.textContent = player.name;
      const count = document.createElement('span');
      count.className = 'opponent-count';
      count.textContent = String(player.count);
      const stack = document.createElement('span');
      stack.className = 'opponent-mini-hand';
      const visibleCards = Math.min(player.count, 7);
      for (let i = 0; i < visibleCards; i += 1) {
        const mini = document.createElement('span');
        const center = (visibleCards - 1) / 2;
        const angle = (i - center) * Math.min(5, 22 / Math.max(visibleCards, 1));
        mini.style.setProperty('--mini-index', i);
        mini.style.setProperty('--mini-angle', `${angle}deg`);
        mini.style.setProperty('--mini-yaw', `${(i - center) * 2.2}deg`);
        stack.appendChild(mini);
      }
      stack.setAttribute('aria-label', `${player.count} face-down cards`);
      badge.append(avatar, label, count);
      seat.append(badge, stack);
      if (player.isTurn) {
        const turn = document.createElement('span'); turn.className = 'opponent-turn-tag'; turn.textContent = 'PLAYING'; seat.appendChild(turn);
      }
      if (next.game?.awaitingSwapPlayerId === socket.id && game?.awaitingSwapPlayerId !== player.id) {
        seat.classList.add('swap-target');
        seat.tabIndex = 0;
        seat.setAttribute('role', 'button');
        seat.setAttribute('aria-label', `Swap hands with ${player.name}`);
        seat.addEventListener('click', () => socket.emit('swapHands', player.id));
        seat.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') socket.emit('swapHands', player.id); });
      }
      if (game?.unoChallenge?.targetId === player.id) seat.classList.add('missed-uno-target');
      $('opponents').appendChild(seat);
    });
  }

  function renderHand(next) {
    const game = next.game;
    const hand = game.hand || [];
    const container = $('myHand');
    const me = next.players.find(player => player.id === socket.id);
    const oldElements = new Map([...container.querySelectorAll('[data-card-id]')].map(el => [el.dataset.cardId, el]));
    const newIds = new Set(hand.map(card => card.id));
    if (game.lastCardId && game.lastCardId !== lastAnimatedCardId && !newIds.has(game.lastCardId)) {
      const oldPlayed = oldElements.get(game.lastCardId);
      if (oldPlayed) animateCardToDiscard(oldPlayed);
      lastAnimatedCardId = game.lastCardId;
    }
    for (const [id, element] of oldElements) {
      if (!newIds.has(id)) element.remove();
    }
    const isMyTurn = Boolean(me?.isTurn && !game.winnerId);
    const playableCount = hand.filter(card => localCanPlay(card, game, hand)).length;
    const handWidth = Math.max(240, container.clientWidth || window.innerWidth);
    const handHeight = Math.max(88, container.clientHeight || 150);
    const maxCardHeight = Math.min(154, Math.max(78, handHeight - 13));
    const cardHeight = Math.min(maxCardHeight, handWidth < 430 ? 113 : handWidth < 760 ? 132 : 154);
    const cardWidth = Math.round(cardHeight * 0.667);
    const step = hand.length > 1
      ? Math.min(cardWidth * 0.59, Math.max(10, (handWidth - cardWidth - 8) / (hand.length - 1)))
      : cardWidth;
    const overlap = Math.max(0, cardWidth - step);
    const angleStep = Math.min(2.5, 26 / Math.max(hand.length, 1));
    hand.forEach((card, index) => {
      let element = oldElements.get(card.id);
      const isNew = !element;
      if (!element) {
        element = createCardElement(card, { interactive: true });
        element.classList.add('card-entering');
        window.setTimeout(() => element.classList.remove('card-entering'), 430);
      }
      const playable = isMyTurn && localCanPlay(card, game, hand);
      element.classList.toggle('is-playable', playable);
      element.classList.toggle('is-unplayable', isMyTurn && !playable);
      element.classList.toggle('card-drawn', game.drawnPlayableCardId === card.id);
      element.style.setProperty('--hand-index', index);
      element.style.setProperty('--hand-count', hand.length);
      element.style.setProperty('--card-width', `${cardWidth}px`);
      element.style.setProperty('--card-height', `${cardHeight}px`);
      element.style.setProperty('--card-overlap', `${overlap}px`);
      const centerOffset = index - (hand.length - 1) / 2;
      const fanAngle = centerOffset * angleStep;
      const fanY = Math.abs(centerOffset) * Math.min(2.4, hand.length > 7 ? 1.1 : 1.7);
      const fanYaw = centerOffset * Math.min(1.8, 14 / Math.max(hand.length, 1));
      element.style.setProperty('--hand-angle', `${fanAngle}deg`);
      element.style.setProperty('--fan-y', `${fanY}px`);
      element.style.setProperty('--hand-yaw', `${fanYaw}deg`);
      element.style.zIndex = String(index + 1);
      element.disabled = !isMyTurn;
      element.setAttribute('aria-disabled', String(!isMyTurn));
      if (isNew) element.dataset.newlyDealt = 'true';
      else delete element.dataset.newlyDealt;
      container.appendChild(element);
    });
    $('myHandCount').textContent = `${hand.length} ${hand.length === 1 ? 'CARD' : 'CARDS'}`;
    $('myAvatar').textContent = (me?.name || 'Y').slice(0, 1).toUpperCase();
    $('myNameLabel').textContent = (me?.name || 'YOU').toUpperCase();
    $('myTurnChip').classList.toggle('is-hidden', !isMyTurn);
    $('handHint').textContent = game.winnerId ? 'Round complete' : isMyTurn ? (game.drawnPlayableCardId ? 'You drew a playable card · play it or pass' : playableCount ? 'Your turn · choose a glowing card' : 'No playable card · draw from the pile') : 'Waiting for your turn…';
    $('handSortLabel').textContent = isMyTurn && playableCount ? `${playableCount} PLAYABLE` : 'PLAYABLE CARDS GLOW';
    const canCallUno = isMyTurn && hand.length === 2 && playableCount > 0 && game.pendingDraw === 0 && !game.pendingWild4 && !game.drawnPlayableCardId;
    $('unoButton').classList.toggle('is-hidden', !canCallUno && !game.armedUno);
    $('unoButton').disabled = !canCallUno || Boolean(game.armedUno);
    $('unoButton').classList.toggle('uno-ready', canCallUno && !game.armedUno);
    $('unoButton').classList.toggle('uno-called', Boolean(game.armedUno));
    $('passTurn').classList.toggle('is-hidden', !(isMyTurn && game.drawnPlayableCardId));
    const drawButton = $('drawPile');
    drawButton.disabled = !isMyTurn || Boolean(game.winnerId) || Boolean(game.awaitingSwapPlayerId) || Boolean(game.sixReaction?.active) || Boolean(game.drawnPlayableCardId);
    drawButton.classList.toggle('draw-ready', isMyTurn && !playableCount && !game.pendingWild4 && !game.drawnPlayableCardId);
    drawButton.classList.toggle('draw-penalty', isMyTurn && game.pendingDraw > 0);
    $('penaltyBanner').classList.toggle('is-hidden', !(isMyTurn && game.pendingDraw > 0 && !game.pendingWild4));
    if (game.pendingDraw > 0) {
      $('penaltyText').textContent = `DRAW ${game.pendingDraw}`;
      $('takePenalty').textContent = `Take ${game.pendingDraw}`;
    }
    $('wildFourBanner').classList.toggle('is-hidden', !(isMyTurn && game.pendingWild4?.targetId === socket.id));
    $('challengeWildFour').disabled = !(isMyTurn && game.pendingWild4?.targetId === socket.id);
    const canCatchUno = Boolean(game.unoChallenge && game.unoChallenge.targetId !== socket.id && Date.now() <= game.unoChallenge.deadline);
    $('unoCatchBanner').classList.toggle('is-hidden', !canCatchUno);
    if (unoChallengeTicker) { clearTimeout(unoChallengeTicker); unoChallengeTicker = null; }
    if (canCatchUno) {
      $('unoCatchText').textContent = `${game.unoChallenge.targetName} has one card. Catch them!`;
      unoChallengeTicker = window.setTimeout(() => {
        if (state?.game?.unoChallenge?.targetId === game.unoChallenge.targetId) $('unoCatchBanner').classList.add('is-hidden');
      }, Math.max(0, game.unoChallenge.deadline - Date.now() + 15));
    }
    $('swapBanner').classList.toggle('is-hidden', game.awaitingSwapPlayerId !== socket.id);
    if (game.awaitingSwapPlayerId === socket.id) $('handHint').textContent = 'Choose an opponent above to swap hands.';
  }

  function animateOpponentCardToDiscard(playerId, card) {
    const seat = document.querySelector(`.opponent-seat[data-player-id="${CSS.escape(playerId)}"] .opponent-mini-hand span:last-child`);
    const target = $('discardPile');
    if (!seat || !target || !card || prefs.reduceMotion) return;
    const from = seat.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    const flying = createCardElement(card, { small: true });
    flying.classList.add('flying-card', 'remote-flying-card');
    flying.style.left = `${from.left}px`;
    flying.style.top = `${from.top}px`;
    flying.style.width = `${Math.max(14, from.width)}px`;
    flying.style.height = `${Math.max(20, from.height)}px`;
    flying.style.borderWidth = '1px';
    $('cardFlightLayer').appendChild(flying);
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const scale = Math.min(7, Math.max(3.6, to.width / Math.max(from.width, 1)));
    flying.animate([
      { transform: 'translate(0,0) rotate(0deg) skew(0deg,0deg) scale(1)', opacity: .85 },
      { transform: `translate(${dx * .34}px,${dy * .34 - 18}px) rotate(-18deg) skew(-5deg,0deg) scale(${Math.max(1.4,scale * .55)})`, opacity: 1, offset: .34 },
      { transform: `translate(${dx}px,${dy}px) rotate(14deg) skew(2deg,0deg) scale(${scale})`, opacity: .2 },
    ], { duration: 510, easing: 'cubic-bezier(.18,.82,.2,1)', fill: 'forwards' }).onfinish = () => flying.remove();
  }

  function renderGame(next) {
    const game = next.game;
    if (lastGameSnapshot && game.lastCardId && game.lastCardId !== lastGameSnapshot.lastCardId && game.lastPlayerId && game.lastPlayerId !== socket.id) {
      animateOpponentCardToDiscard(game.lastPlayerId, game.top);
    }
    $('gameRoomCode').textContent = next.code;
    renderOpponents(next);
    renderHand(next);
    $('turnLabel').textContent = game.winnerId ? `${game.winnerName} wins!` : `${next.players[game.turn]?.name || 'Someone'}'s turn`;
    $('turnLabel').classList.toggle('turn-label-active', next.players[game.turn]?.id === socket.id && !game.winnerId);
    $('directionIndicator').textContent = game.direction === 1 ? '↻' : '↺';
    $('directionIndicator').classList.toggle('direction-reverse', game.direction === -1);
    $('deckCount').textContent = `${game.drawCount} ${game.drawCount === 1 ? 'card' : 'cards'}`;
    const discardPile = $('discardPile');
    discardPile.replaceChildren();
    const top = game.top;
    const isNewDiscard = Boolean(top && game.lastCardId && game.lastCardId !== lastDiscardVisualId);
    if (top) {
      const topCard = createCardElement(top, { small: true });
      topCard.classList.add('discard-top-card');
      if (!isNewDiscard || prefs.reduceMotion) topCard.style.animation = 'none';
      if (top.color === 'wild') {
        topCard.dataset.activeColor = game.color || 'red';
        topCard.style.setProperty('--active-color', COLOR_HEX[game.color] || COLOR_HEX.red);
      }
      discardPile.appendChild(topCard);
      if (isNewDiscard) lastDiscardVisualId = game.lastCardId;
    }
    const ring = document.querySelector('.direction-ring');
    ring?.classList.toggle('direction-reverse', game.direction === -1);
    const currentColor = game.color || 'red';
    $('currentColorBadge').style.setProperty('--current-color', COLOR_HEX[currentColor] || COLOR_HEX.red);
    $('currentColorBadge').querySelector('i').style.background = COLOR_HEX[currentColor] || COLOR_HEX.red;
    $('currentColorBadge').querySelector('span').textContent = COLOR_LABELS[currentColor] || 'RED';
    $('tableMessage').classList.toggle('is-active', Boolean(game.pendingDraw || game.pendingWild4 || game.unoChallenge || game.awaitingSwapPlayerId));
    if (game.pendingWild4?.targetId === socket.id) $('tableMessage').textContent = 'Accept or challenge the Wild Draw Four.';
    else if (game.pendingDraw > 0 && game.turn === next.players.findIndex(p => p.id === socket.id)) $('tableMessage').textContent = `${game.pendingDraw} cards are waiting. Stack or take the penalty.`;
    else if (game.awaitingSwapPlayerId === socket.id) $('tableMessage').textContent = 'Choose an opponent to swap hands.';
    else if (game.unoChallenge) $('tableMessage').textContent = `${game.unoChallenge.targetName} forgot to call UNO!`;
    else $('tableMessage').textContent = '';

    const reaction = game.sixReaction;
    $('reactionOverlay').classList.toggle('is-hidden', !reaction?.active);
    if (reaction?.active) {
      const pressed = reaction.pressed.length;
      const total = reaction.playerIds.length;
      $('reactionStatus').textContent = reaction.pressed.includes(socket.id) ? `You're safe · ${pressed}/${total}` : `${pressed}/${total} safe`;
      $('pressSix').disabled = reaction.pressed.includes(socket.id);
      $('pressSix').classList.toggle('already-pressed', reaction.pressed.includes(socket.id));
      if (!reactionTicker) {
        reactionTicker = window.setInterval(() => {
          const current = state?.game?.sixReaction;
          if (!current?.active) { clearInterval(reactionTicker); reactionTicker = null; return; }
          $('reactionCountdown').textContent = String(Math.max(0, Math.ceil((current.deadline - Date.now()) / 1000)));
        }, 120);
      }
    } else if (reactionTicker) { clearInterval(reactionTicker); reactionTicker = null; }

    if (game.unoAnnouncement && game.unoAnnouncement.id !== lastUnoAnimationId) {
      lastUnoAnimationId = game.unoAnnouncement.id;
      showUnoSplash(game.unoAnnouncement.playerId === socket.id ? 'UNO! YOU CALLED IT!' : `${next.players.find(p => p.id === game.unoAnnouncement.playerId)?.name || 'PLAYER'} CALLED UNO!`);
      playSfx('uno');
    }
    if (game.winnerId && lastWinnerShown !== `${game.roundId}:${game.winnerId}`) {
      lastWinnerShown = `${game.roundId}:${game.winnerId}`;
      showWinner(game.winnerId === socket.id, game.winnerName);
    }
    if (lastGameSnapshot && game.lastCardId && game.lastCardId !== lastGameSnapshot.lastCardId) {
      const value = game.lastAction;
      if (value === 'Skip' || value === 'Reverse' || value === 'Draw2' || value === 'Wild4') playSfx('action');
      else playSfx('card');
    }
    lastGameSnapshot = { lastCardId: game.lastCardId, lastAction: game.lastAction };
  }

  function showUnoSplash(caption) {
    $('unoSplashCaption').textContent = caption;
    const splash = $('unoSplash');
    splash.classList.remove('is-hidden');
    splash.classList.remove('uno-splash-in');
    void splash.offsetWidth;
    splash.classList.add('uno-splash-in');
    window.setTimeout(() => splash.classList.add('is-hidden'), prefs.reduceMotion ? 700 : 1650);
  }

  function showWinner(isMe, name) {
    $('winnerTitle').textContent = isMe ? 'UNO! YOU WIN!' : `${name || 'A RIVAL'} WINS!`;
    $('winnerDescription').textContent = isMe ? 'Beautifully played. Ready for the rematch?' : 'The table remembers. Shuffle up for a rematch.';
    $('winOverlay').classList.remove('is-hidden');
    playSfx('win');
  }

  function applyState(next) {
    const wasStarted = Boolean(state?.started);
    state = next;
    roomCode = next.code || roomCode;
    if (next.started && next.game) {
      closeModal('roomSetupModal');
      showScreen('gameScreen');
      renderGame(next);
    } else {
      $('winOverlay').classList.add('is-hidden');
      lastWinnerShown = null;
      lastGameSnapshot = null;
      renderLobby(next);
      showScreen('lobbyScreen');
      if (wasStarted) playSfx('click');
    }
  }

  function updateHouseRules() {
    if (!state || state.hostId !== socket.id || state.started) return;
    socket.emit('updateSettings', {
      stacking: $('ruleStacking').checked,
      zeroSeven: $('ruleZeroSeven').checked,
      drawUntilPlayable: $('ruleDrawUntil').checked,
      sixReaction: $('ruleSixReaction').checked,
    });
  }
  function openRoomSetup(mode) {
    setupMode = mode;
    $('setupTitle').textContent = mode === 'create' ? 'Create a room' : 'Join your crew';
    $('setupEyebrow').textContent = mode === 'create' ? 'MAKE IT A PRIVATE TABLE' : 'YOU HAVE AN INVITATION';
    $('setupDescription').textContent = mode === 'create' ? "Pick your nickname and we'll set up a table for your crew." : "Enter your friend's room code and we'll pull up a seat.";
    $('confirmRoomAction').querySelector('span').textContent = mode === 'create' ? 'Create private room' : 'Join the table';
    $('joinCodeField').classList.toggle('is-hidden', mode !== 'join');
    $('roomCodeInput').value = '';
    openModal('roomSetupModal');
    window.setTimeout(() => $('playerNameInput').focus(), 100);
  }
  function submitRoomAction() {
    const name = $('playerNameInput').value.trim();
    if (!name) { toast('Enter a nickname first.', 'warning'); $('playerNameInput').focus(); return; }
    if (name.length > 16) { toast('Your nickname can be up to 16 characters.', 'warning'); return; }
    localStorage.setItem('myweb-uno-name', name);
    initAudio();
    if (prefs.musicEnabled) startMusic();
    if (setupMode === 'create') {
      socket.emit('createRoom', { name, token: sessionToken });
    } else {
      const code = $('roomCodeInput').value.trim().toUpperCase();
      if (!code) { toast('Enter the six-character room code.', 'warning'); return; }
      socket.emit('joinRoom', { name, code, token: sessionToken });
    }
  }

  // Screen and menu events.
  function startExperience() {
    initAudio();
    if (prefs.musicEnabled) startMusic();
    showScreen('mainMenu');
    playSfx('click');
  }
  $('splashScreen').addEventListener('click', startExperience);
  window.addEventListener('resize', () => {
    if (state?.started && state.game) renderHand(state);
  }, { passive: true });
  $('splashScreen').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') startExperience(); });
  $('pressStart').addEventListener('click', event => { event.stopPropagation(); startExperience(); });
  $('createRoomOpen').addEventListener('click', () => { playSfx('click'); openRoomSetup('create'); });
  $('joinRoomOpen').addEventListener('click', () => { playSfx('click'); openRoomSetup('join'); });
  $('confirmRoomAction').addEventListener('click', submitRoomAction);
  $('playerNameInput').value = localStorage.getItem('myweb-uno-name') || '';
  $('roomCodeInput').addEventListener('input', () => { $('roomCodeInput').value = $('roomCodeInput').value.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 6); });
  $('playerNameInput').addEventListener('keydown', event => { if (event.key === 'Enter') submitRoomAction(); });
  $('roomCodeInput').addEventListener('keydown', event => { if (event.key === 'Enter') submitRoomAction(); });
  $('openSettings').addEventListener('click', () => openModal('settingsModal'));
  $('lobbySettings').addEventListener('click', () => openModal('settingsModal'));
  $('gameSettings').addEventListener('click', () => openModal('settingsModal'));
  $('howToPlayOpen').addEventListener('click', () => openModal('howToPlayModal'));
  $('closeSettings').addEventListener('click', () => closeModal('settingsModal'));
  $('closeHowToPlay').addEventListener('click', () => closeModal('howToPlayModal'));
  $('backToMenu').addEventListener('click', () => {
    if (state?.code) socket.emit('leaveRoom');
    state = null; roomCode = ''; showScreen('mainMenu');
  });
  document.querySelectorAll('[data-close-modal]').forEach(button => button.addEventListener('click', () => closeModal(button.dataset.closeModal)));
  document.querySelectorAll('.modal-backdrop').forEach(backdrop => backdrop.addEventListener('click', event => { if (event.target === backdrop && backdrop.id !== 'wildPicker') closeModal(backdrop.id); }));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hideAllModals(); });

  $('musicEnabled').addEventListener('change', event => { prefs.musicEnabled = event.target.checked; savePrefs(); if (prefs.musicEnabled) startMusic(); else stopMusic(); });
  $('sfxEnabled').addEventListener('change', event => { prefs.sfxEnabled = event.target.checked; savePrefs(); if (prefs.sfxEnabled) playSfx('click'); });
  $('musicVolume').addEventListener('input', event => { prefs.musicVolume = Number(event.target.value); savePrefs(); });
  $('sfxVolume').addEventListener('input', event => { prefs.sfxVolume = Number(event.target.value); savePrefs(); });
  $('reduceMotion').addEventListener('change', event => { prefs.reduceMotion = event.target.checked; savePrefs(); });

  for (const id of ['ruleStacking', 'ruleZeroSeven', 'ruleDrawUntil', 'ruleSixReaction']) $(id).addEventListener('change', updateHouseRules);
  $('startGame').addEventListener('click', () => { if (!state || state.hostId !== socket.id) return; socket.emit('startGame'); playSfx('click'); });
  $('copyRoomCode').addEventListener('click', async () => {
    const code = state?.code || roomCode;
    try { await navigator.clipboard.writeText(code); toast('Room code copied. Send it to your friends!', 'success'); }
    catch { window.prompt('Copy this room code:', code); }
  });
  $('leaveGame').addEventListener('click', () => {
    if (!window.confirm('Leave this table? Your seat will be removed from the game.')) return;
    socket.emit('leaveRoom');
    $('winOverlay').classList.add('is-hidden');
    state = null; roomCode = ''; lastGameSnapshot = null;
    showScreen('mainMenu');
  });
  $('drawPile').addEventListener('click', () => {
    if (!state?.game) return;
    if (state.game.pendingDraw > 0) socket.emit('drawPenalty');
    else socket.emit('drawCard');
    playSfx('draw');
  });
  $('passTurn').addEventListener('click', () => socket.emit('passTurn'));
  $('takePenalty').addEventListener('click', () => socket.emit('drawPenalty'));
  $('unoButton').addEventListener('click', () => { socket.emit('callUno'); playSfx('uno'); });
  $('catchUnoButton').addEventListener('click', () => {
    const challenge = state?.game?.unoChallenge;
    if (!challenge || Date.now() > challenge.deadline || challenge.targetId === socket.id) {
      $('unoCatchBanner').classList.add('is-hidden');
      return;
    }
    socket.emit('catchUno', challenge.targetId);
    playSfx('action');
  });
  $('challengeWildFour').addEventListener('click', () => { socket.emit('challengeWild4'); playSfx('action'); });
  $('acceptWildFour').addEventListener('click', () => { socket.emit('drawPenalty'); playSfx('draw'); });
  $('pressSix').addEventListener('click', () => { if (state?.game?.sixReaction) socket.emit('pressSix', state.game.sixReaction.id); playSfx('reaction'); });
  $('cancelWild').addEventListener('click', () => { pendingWildCardId = null; closeModal('wildPicker'); });
  document.querySelectorAll('[data-wild-color]').forEach(button => button.addEventListener('click', () => {
    const color = button.dataset.wildColor;
    const cardId = pendingWildCardId;
    pendingWildCardId = null;
    closeModal('wildPicker');
    if (cardId) socket.emit('playCard', { cardId, color });
    playSfx('action');
  }));
  $('backToLobby').addEventListener('click', () => {
    $('winOverlay').classList.add('is-hidden');
    socket.emit('leaveRoom');
    state = null; roomCode = ''; lastWinnerShown = null;
    showScreen('mainMenu');
  });

  // Real-time connection and server-authoritative state.
  socket.on('connected', () => socket.emit('resumeSession', sessionToken));
  socket.on('resumeFailed', () => {
    // A clean server restart may have lost its in-memory room. Keep the token
    // for future room creation, but do not pretend the former table survived.
    if (state?.code) { state = null; roomCode = ''; showScreen('mainMenu'); }
  });
  socket.on('roomJoined', data => {
    roomCode = data.code;
    if (data.token) { sessionToken = data.token; localStorage.setItem(TOKEN_KEY, sessionToken); }
    closeModal('roomSetupModal');
    toast(data.resumed ? 'Welcome back to your table.' : `Room ${data.code} is ready.`, 'success');
  });
  socket.on('roomLeft', () => { state = null; roomCode = ''; showScreen('mainMenu'); });
  socket.on('state', applyState);
  socket.on('toast', data => { toast(data?.text || 'Something went wrong.', data?.kind || 'warning'); if ((data?.kind || 'warning') === 'warning') playSfx('error'); });
  socket.on('notice', data => {
    if (!data || data.id === lastNoticeId) return;
    lastNoticeId = data.id;
    toast(data.text, data.kind || 'info');
    if (data.kind === 'penalty') playSfx('draw');
    if (data.kind === 'uno') playSfx('uno');
    if (data.kind === 'win') playSfx('win');
  });
  socket.on('connect_error', () => toast('Connection hiccup. Trying to reconnect…', 'warning'));
  socket.on('reconnect', () => { socket.emit('resumeSession', sessionToken); toast('Connection restored.', 'success'); });

  updateAudioControls();
  activateTextureCardBack();
  document.documentElement.classList.toggle('reduce-motion', Boolean(prefs.reduceMotion));
  showScreen('splashScreen');
})();
