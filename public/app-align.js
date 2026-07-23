// Mobile antenna-alignment page at /align.
//
// PRESENTATION LAYER ONLY (docs/BROWSER_CONTRACT.md). The backend owns every
// displayed value. This file only renders the pushed align view-model and sends
// raw operator inputs back to the existing REST endpoints.
//
// Deliberately framework-free: this field page must remain operational when a
// third-party JavaScript CDN is unavailable or Alpine fails to initialize.

(function () {
  'use strict';

  var app = {
    model: {
      running: false,
      readings: [],
      burst: null,
      best: null,
      current: null,
      warning: null,
      tx: null,
      nBurst: 4,
      replyWindowSec: 30
    },
    nBurst: 4,
    replyWinSec: 30,
    target: '',
    targets: [],
    elements: {},
    ws: null,
    wsOpening: null,
    reconnectTimer: null,
    pollTimer: null,
    pollBusy: false,
    wake: null,
    ended: false,
    submitting: false,

    mount: function () {
      this.elements = {
        target: document.getElementById('align-target'),
        status: document.getElementById('align-status'),
        nBurst: document.getElementById('align-burst-size'),
        replyWindow: document.getElementById('align-reply-window'),
        warning: document.getElementById('align-warning'),
        currentCard: document.getElementById('align-current-card'),
        currentEmpty: document.getElementById('align-current-empty'),
        current: document.getElementById('align-current'),
        quality: document.getElementById('align-quality'),
        qualityLabel: document.getElementById('align-quality-label'),
        tx: document.getElementById('align-tx'),
        spread: document.getElementById('align-spread'),
        got: document.getElementById('align-got'),
        of: document.getElementById('align-of'),
        trend: document.getElementById('align-trend'),
        bestLine: document.getElementById('align-best-line'),
        yagiQuality: document.getElementById('align-yagi-quality'),
        omniQuality: document.getElementById('align-omni-quality'),
        rssi: document.getElementById('align-rssi'),
        snr: document.getElementById('align-snr'),
        readingsEmpty: document.getElementById('align-readings-empty'),
        readingsEmptyN: document.getElementById('align-readings-empty-n'),
        readings: document.getElementById('align-readings'),
        ping: document.getElementById('align-ping'),
        pingIdle: document.getElementById('align-ping-idle'),
        pingActive: document.getElementById('align-ping-active'),
        pingProgress: document.getElementById('align-ping-progress'),
        end: document.getElementById('align-end')
      };

      var self = this;
      this.elements.target.addEventListener('change', function () {
        self.target = this.value === '' ? '' : Number(this.value);
        self.renderControls();
      });
      this.elements.nBurst.addEventListener('change', function () {
        self.nBurst = Number(this.value);
        self.renderControls();
      });
      this.elements.replyWindow.addEventListener('change', function () {
        self.replyWinSec = Number(this.value);
        self.setReplyWindow();
      });
      this.elements.ping.addEventListener('click', function () { self.ping(); });
      this.elements.end.addEventListener('click', function () { self.stop(); });

      window.addEventListener('pageshow', function () { self.resume(); });
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') self.resume();
      });

      document.documentElement.setAttribute('data-align-runtime', 'native-rest-v2');
      this.render();
      this.init();
    },

    init: async function () {
      try {
        var response = await fetch('/align/targets', { cache: 'no-store' });
        await this.requireOk(response, 'Load targets');
        this.targets = await response.json();
      } catch (error) {
        console.error('[align] targets failed:', error.message);
        this.targets = [];
      }

      if (this.targets.length) this.target = Number(this.targets[0].num);
      this.renderTargets();
      this.renderControls();
      this.startPolling();
      this.pollState(true);
      this.open().catch(function (error) {
        console.warn('[align] socket unavailable; using state polling:', error.message);
      });
    },

    render: function () {
      this.renderTargets();
      this.renderControls();
      this.renderWarning();
      this.renderCurrent();
      this.renderReadings();
    },

    renderTargets: function () {
      var select = this.elements.target;
      if (!select) return;

      while (select.firstChild) select.removeChild(select.firstChild);
      if (!this.targets.length) {
        var empty = document.createElement('option');
        empty.value = '';
        empty.textContent = 'Star a node to align it';
        select.appendChild(empty);
        this.target = '';
        return;
      }

      for (var i = 0; i < this.targets.length; i += 1) {
        var target = this.targets[i];
        var option = document.createElement('option');
        option.value = String(target.num);
        option.textContent = target.label;
        select.appendChild(option);
      }
      select.value = String(this.target);
    },

    renderControls: function () {
      var burst = this.model.burst;
      var bursting = !!(burst && burst.active);
      var running = !!this.model.running;

      this.elements.target.disabled = bursting || this.submitting;
      this.elements.nBurst.disabled = bursting || this.submitting;
      this.elements.nBurst.value = String(this.nBurst);
      this.elements.replyWindow.disabled = bursting || this.submitting;
      this.elements.replyWindow.value = String(this.replyWinSec);

      this.elements.ping.disabled = bursting || this.submitting || !this.target;
      this.elements.ping.classList.toggle('btn-primary', !bursting && !this.submitting && !!this.target);
      this.elements.ping.classList.toggle('btn-disabled', bursting || this.submitting || !this.target);
      this.elements.pingIdle.hidden = bursting;
      this.elements.pingActive.hidden = !bursting;
      this.elements.pingProgress.textContent = 'GATHERING ' +
        (burst ? burst.got : 0) + '/' + (burst ? burst.of : 0);

      this.elements.end.disabled = !running;
      this.elements.status.textContent = running ? 'RUNNING' : 'READY';
      this.elements.status.classList.toggle('badge-success', running);
      this.elements.status.classList.toggle('badge-ghost', !running);
    },

    renderWarning: function () {
      var warning = this.model.warning;
      this.elements.warning.hidden = !warning;
      this.elements.warning.textContent = warning || '';
    },

    renderCurrent: function () {
      var current = this.model.current;
      this.elements.currentEmpty.hidden = !!current;
      this.elements.current.hidden = !current;
      this.elements.currentCard.classList.toggle('border-success', !!(current && current.isBest));
      this.elements.currentCard.classList.toggle('border-base-300', !(current && current.isBest));
      if (!current) return;

      this.setTone(this.elements.quality, current.cls);
      this.setTone(this.elements.qualityLabel, current.cls);
      this.elements.quality.textContent = current.quality;
      this.elements.qualityLabel.textContent = current.label;
      this.elements.tx.textContent = this.model.tx == null ? '' : this.model.tx;
      this.elements.spread.textContent = current.spread;
      this.elements.got.textContent = current.got;
      this.elements.of.textContent = current.of;

      this.elements.trend.className = 'text-lg font-display font-semibold mt-1';
      if (current.trendDir === null) {
        this.elements.trend.classList.add('text-base-content/50');
        this.elements.trend.textContent = 'First reading';
      } else if (current.trendDir === 'up') {
        this.elements.trend.classList.add('text-success');
        this.elements.trend.textContent = '▲ BETTER +' + current.trendDelta;
      } else if (current.trendDir === 'down') {
        this.elements.trend.classList.add('text-error');
        this.elements.trend.textContent = '▼ worse ' + current.trendDelta;
      } else {
        this.elements.trend.classList.add('text-base-content/60');
        this.elements.trend.textContent = '■ same as last';
      }

      if (current.isBest) {
        this.elements.bestLine.className = 'badge badge-success badge-lg gap-1 font-display';
        this.elements.bestLine.textContent = '★ BEST YET';
      } else {
        this.elements.bestLine.className = 'text-sm text-base-content/70';
        this.elements.bestLine.textContent = '−' + current.gapToBest +
          ' below best — reading #' + current.bestN + ', ' +
          (current.bestAgo === 1 ? 'the one before' : current.bestAgo + ' readings ago');
      }

      this.elements.yagiQuality.textContent = current.yagi_q == null ? '—' : current.yagi_q;
      this.elements.omniQuality.textContent = current.omni_q == null ? '—' : current.omni_q;
      this.elements.rssi.textContent = current.rssi;
      this.elements.snr.textContent = current.snr;
    },

    renderReadings: function () {
      var readings = this.model.readings || [];
      this.elements.readingsEmpty.hidden = readings.length > 0;
      this.elements.readingsEmptyN.textContent = this.nBurst;
      this.elements.readings.hidden = readings.length === 0;

      while (this.elements.readings.firstChild) {
        this.elements.readings.removeChild(this.elements.readings.firstChild);
      }

      for (var i = 0; i < readings.length; i += 1) {
        var reading = readings[i];
        var column = document.createElement('div');
        column.className = 'flex flex-col items-center gap-1 shrink-0 h-full';
        column.style.width = '2.25rem';

        var star = document.createElement('div');
        star.className = 'text-sm leading-none h-4 text-warning';
        star.textContent = reading.isBest ? '★' : '';

        var track = document.createElement('div');
        track.className = 'flex-1 w-full flex items-end min-h-0';
        var bar = document.createElement('div');
        bar.className = 'w-full rounded-t transition-[height] duration-300 ' +
          (reading.isBest ? 'bg-success' : (reading.isCurrent ? 'bg-primary' : 'bg-base-content/30'));
        bar.style.height = String(reading.barPct) + '%';
        track.appendChild(bar);

        var quality = document.createElement('div');
        quality.className = 'text-xs font-mono tabular-nums leading-none ' +
          (reading.isCurrent ? 'font-bold text-primary' : 'text-base-content/60');
        quality.textContent = reading.quality;

        var number = document.createElement('div');
        number.className = 'text-[0.6rem] font-mono text-base-content/30 leading-none';
        number.textContent = '#' + reading.n;

        column.appendChild(star);
        column.appendChild(track);
        column.appendChild(quality);
        column.appendChild(number);
        this.elements.readings.appendChild(column);
      }
    },

    setTone: function (element, tone) {
      var tones = ['text-success', 'text-warning', 'text-error', 'text-base-content/30'];
      for (var i = 0; i < tones.length; i += 1) element.classList.remove(tones[i]);
      element.classList.add('text-' + tone);
    },

    ping: async function () {
      if (!this.target || this.submitting || (this.model.burst && this.model.burst.active)) return;
      this.ended = false;
      this.submitting = true;
      this.renderControls();
      try {
        // REST is the action transport. A failed WS upgrade must never suppress
        // a radio command; polling supplies the same authoritative model.
        this.open().catch(function (error) {
          console.warn('[align] socket unavailable; polling state:', error.message);
        });
        var response = await fetch('/align/ping', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ num: this.target, n: this.nBurst })
        });
        await this.requireOk(response, 'PING');
        await this.pollState(true);
        await this.holdWake();
      } catch (error) {
        console.error('[align] ping failed:', error.message);
      } finally {
        this.submitting = false;
        this.renderControls();
      }
    },

    setReplyWindow: async function () {
      try {
        var response = await fetch('/align/reply-window', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sec: this.replyWinSec })
        });
        await this.requireOk(response, 'Set reply window');
      } catch (error) {
        console.error('[align] reply-window failed:', error.message);
      }
    },

    stop: async function () {
      this.ended = true;
      this.clearReconnect();
      try {
        var response = await fetch('/align/stop', { method: 'POST' });
        await this.requireOk(response, 'End');
        await this.pollState(true);
      } catch (error) {
        console.error('[align] end failed:', error.message);
      } finally {
        var socket = this.ws;
        this.ws = null;
        this.wsOpening = null;
        if (socket) {
          socket.onmessage = null;
          try { socket.close(); } catch (error) { /* already closed */ }
        }
        await this.releaseWake();
      }
    },

    open: async function () {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
      if (this.wsOpening) return this.wsOpening;
      this.clearReconnect();

      var protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      var socket = new WebSocket(protocol + '://' + location.host + '/align/events');
      var self = this;
      this.ws = socket;

      socket.onmessage = function (event) {
        var frame;
        try { frame = JSON.parse(event.data); } catch (error) { return; }
        if (frame.kind !== 'align') return;
        self.adoptModel(frame);
      };

      var opening = new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          try { socket.close(); } catch (error) { /* already closed */ }
          reject(new Error('WebSocket open timeout'));
        }, 5000);

        socket.onopen = function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        socket.onerror = function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { socket.close(); } catch (error) { /* already closed */ }
          reject(new Error('WebSocket connection error'));
        };
        socket.onclose = function () {
          clearTimeout(timer);
          if (self.ws === socket) self.ws = null;
          if (!settled) {
            settled = true;
            reject(new Error('WebSocket closed before opening'));
          }
          self.scheduleReconnect();
        };
      });

      this.wsOpening = opening;
      try {
        await opening;
      } finally {
        if (this.wsOpening === opening) this.wsOpening = null;
      }
    },

    scheduleReconnect: function () {
      if (this.ended || this.reconnectTimer) return;
      var self = this;
      this.reconnectTimer = setTimeout(function () {
        self.reconnectTimer = null;
        if (document.visibilityState !== 'visible' || self.ended) return;
        self.open().catch(function (error) {
          console.warn('[align] reconnect unavailable; polling state:', error.message);
        });
      }, 1000);
    },

    clearReconnect: function () {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    },

    startPolling: function () {
      if (this.pollTimer) return;
      var self = this;
      this.pollTimer = setInterval(function () { self.pollState(false); }, 1000);
    },

    pollState: async function (force) {
      if (this.pollBusy || document.visibilityState !== 'visible') return;
      if (!force && this.ws && this.ws.readyState === WebSocket.OPEN) return;
      this.pollBusy = true;
      try {
        var response = await fetch('/align/state', { cache: 'no-store' });
        await this.requireOk(response, 'Load align state');
        var frame = await response.json();
        if (frame.kind === 'align') this.adoptModel(frame);
      } catch (error) {
        console.error('[align] state poll failed:', error.message);
      } finally {
        this.pollBusy = false;
      }
    },

    adoptModel: function (frame) {
      this.model = frame;
      if (frame.target != null) {
        this.target = Number(frame.target);
        this.elements.target.value = String(this.target);
      }
      if (typeof frame.replyWindowSec === 'number') this.replyWinSec = frame.replyWindowSec;
      this.render();
      if (frame.running) this.holdWake();
      else this.releaseWake();
    },

    resume: function () {
      if (this.ended) return;
      this.startPolling();
      this.pollState(true);
      this.open().catch(function (error) {
        console.warn('[align] resume socket unavailable; polling state:', error.message);
      });
      if (this.model.running) this.holdWake();
    },

    holdWake: async function () {
      if (!this.model.running || document.visibilityState !== 'visible') return;
      if (!navigator.wakeLock || !navigator.wakeLock.request ||
          (this.wake && !this.wake.released)) return;
      try {
        var lock = await navigator.wakeLock.request('screen');
        var self = this;
        this.wake = lock;
        lock.addEventListener('release', function () {
          if (self.wake === lock) self.wake = null;
        }, { once: true });
      } catch (error) { /* unavailable or insecure is non-fatal */ }
    },

    releaseWake: async function () {
      var lock = this.wake;
      this.wake = null;
      try {
        if (lock) await lock.release();
      } catch (error) { /* already released */ }
    },

    requireOk: async function (response, action) {
      if (response.ok) return response;
      var detail = (await response.text()).slice(0, 160);
      throw new Error(action + ' failed HTTP ' + response.status + (detail ? ': ' + detail : ''));
    }
  };

  window.alignPage = app;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { app.mount(); });
  } else {
    app.mount();
  }
}());
