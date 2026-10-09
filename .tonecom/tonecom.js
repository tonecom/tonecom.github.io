'use strict';
/*
 * ToneCOM Weather - a sample ToneCOM destination.
 *
 * This is an ordinary static web page. The ToneCOM dialer loads
 * /.tonecom/index.html in a hidden iframe and talks to it with postMessage.
 *
 * Voice is real audio over WebRTC (parent↔iframe). Signaling uses postMessage
 * only — no STUN/TURN/backend required. The dialer is speakers-only; it never
 * synthesizes speech from text.
 *
 * Call flow:
 *   1. Asks the caller to type a 5-digit US zip code on the keypad.
 *   2. Looks the zip code up (api.zippopotam.us -> latitude/longitude).
 *   3. Gets the forecast (api.open-meteo.com, no API key needed).
 *   4. Fetches TTS audio and streams it to the dialer over WebRTC.
 *
 * Keys:  0-9 enter digits   * start over   # repeat the prompt
 *        Typing while it is talking interrupts it.
 */
(() => {
  const ZIP_LENGTH = 5;

  /* ------------------------------------------------------------------
   * External TTS → audio bytes. Several free endpoints are tried in order;
   * the first that returns playable audio wins. Prefer {data, mime} so we
   * can decode into a WebRTC track without cross-origin media restrictions.
   * ------------------------------------------------------------------ */
  const TTS_PROVIDERS = [
    {
      name: 'StreamElements',
      async synthesize(text) {
        const url = 'https://api.streamelements.com/kappa/v2/speech?voice=Brian&text=' + encodeURIComponent(text);
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.arrayBuffer();
        if (!data.byteLength) throw new Error('empty body');
        const mime = (res.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim();
        return { data, mime };
      }
    },
    {
      name: 'Google Translate TTS',
      async synthesize(text) {
        // Unofficial endpoint; chunks must stay short. We already sentence-split upstream.
        const q = text.slice(0, 180);
        const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=' + encodeURIComponent(q);
        const res = await fetch(url, {
          cache: 'no-store',
          headers: { 'Accept': 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8' }
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.arrayBuffer();
        if (!data.byteLength) throw new Error('empty body');
        return { data, mime: 'audio/mpeg' };
      }
    },
    {
      name: 'StreamElements (Jessica)',
      async synthesize(text) {
        const url = 'https://api.streamelements.com/kappa/v2/speech?voice=Jessica&text=' + encodeURIComponent(text);
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.arrayBuffer();
        if (!data.byteLength) throw new Error('empty body');
        const mime = (res.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim();
        return { data, mime };
      }
    }
  ];

  const TTS = {
    async synthesize(text) {
      const errors = [];
      for (const provider of TTS_PROVIDERS) {
        try {
          const result = await provider.synthesize(text);
          if (!result || !result.data || !result.data.byteLength) {
            throw new Error('no audio data');
          }
          return result;
        } catch (err) {
          errors.push(provider.name + ': ' + (err && err.message ? err.message : err));
        }
      }
      throw new Error('All TTS providers failed — ' + errors.join(' | '));
    }
  };

  /* ---------------- ToneCOM client (postMessage + WebRTC) ---------------- */
  const statusEl = document.getElementById('status');
  if (window.parent === window) {
    statusEl.innerHTML = 'This is a <strong>ToneCOM</strong> destination. Open it by dialing this site\u2019s number in a ToneCOM dialer; it has nothing to show in a normal tab.';
    return;
  }

  let dialer = null, dialerOrigin = '*', nextId = 0;
  const waiting = new Map();

  function send(msg) {
    if (dialer) dialer.postMessage({ tonecom: 1, ...msg }, dialerOrigin);
  }
  function request(kind, payload) {
    return new Promise(resolve => {
      const id = ++nextId;
      waiting.set(id, resolve);
      send({ kind, id, ...payload });
    });
  }

  /* ---- WebRTC: we are the offerer; dialer answers. Audio track → speakers. ---- */
  let pc = null;
  let audioCtx = null;
  let streamDest = null;
  let sender = null;
  let iceQueue = [];

  function ensureAudioGraph() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      streamDest = audioCtx.createMediaStreamDestination();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return { audioCtx, streamDest };
  }

  async function ensurePeer() {
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: [] });
    pc.onicecandidate = (ev) => {
      if (ev.candidate) send({ kind: 'signal', candidate: ev.candidate.toJSON() });
    };
    // Add a live track up front so the offer includes audio m-line.
    const { streamDest } = ensureAudioGraph();
    const track = streamDest.stream.getAudioTracks()[0];
    sender = pc.addTrack(track, streamDest.stream);

    const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
    await pc.setLocalDescription(offer);
    send({ kind: 'signal', sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });

    // Flush any ICE that arrived before pc existed
    for (const c of iceQueue) {
      try { await pc.addIceCandidate(c); } catch {}
    }
    iceQueue = [];
    return pc;
  }

  async function handleSignal(m) {
    if (m.sdp) {
      await ensurePeer();
      if (m.sdp.type === 'answer') {
        if (!pc.currentRemoteDescription) {
          await pc.setRemoteDescription(m.sdp);
        }
      }
    } else if (m.candidate) {
      if (!pc) { iceQueue.push(m.candidate); return; }
      try { await pc.addIceCandidate(m.candidate); } catch {}
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const m = event.data;
    if (!m || m.tonecom !== 1) return;
    if (!dialer) {
      if (m.kind !== 'init') return;
      dialer = event.source;
      dialerOrigin = event.origin === 'null' ? '*' : event.origin;
      ensurePeer().then(() => start(m.request)).catch((err) => {
        caption('Could not start voice link.');
        console.error(err);
      });
      return;
    }
    if (dialerOrigin !== '*' && event.origin !== dialerOrigin) return;
    if (m.kind === 'done') {
      const resolve = waiting.get(m.id);
      if (resolve) { waiting.delete(m.id); resolve(m); }
    } else if (m.kind === 'dtmf') {
      onKey(String(m.key));
    } else if (m.kind === 'signal') {
      handleSignal(m);
    } else if (m.kind === 'state') {
      // Dialer mute/hold is applied on its side; nothing required here.
    }
  });
  window.parent.postMessage({ tonecom: 1, kind: 'ready', protocol: 'ToneCOM', version: 1 }, '*');

  /* ---------------- Voice: decode audio → WebRTC track (never text) ---------------- */
  let gen = 0;
  let playingNodes = [];

  function stopVoiceGraph() {
    for (const n of playingNodes) {
      try { n.stop(); } catch {}
      try { n.disconnect(); } catch {}
    }
    playingNodes = [];
  }

  async function playBytes(arrayBuffer) {
    await ensurePeer();
    const { audioCtx, streamDest } = ensureAudioGraph();
    const buffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    return new Promise((resolve) => {
      const src = audioCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(streamDest);
      playingNodes.push(src);
      src.onended = () => {
        playingNodes = playingNodes.filter((n) => n !== src);
        resolve({ ok: true });
      };
      try {
        src.start();
      } catch (err) {
        resolve({ ok: false, error: String(err.message || err) });
      }
    });
  }

  const chunksOf = (text) => (text.match(/[^.!?]+[.!?]*/g) || [text]).map(s => s.trim()).filter(Boolean);

  async function speak(text) {
    const mine = ++gen;
    stopVoiceGraph();
    for (const chunk of chunksOf(text)) {
      if (mine !== gen) return;
      try {
        const synth = await TTS.synthesize(chunk);
        if (mine !== gen) return;
        if (!synth.data) throw new Error('TTS returned no audio data');
        await playBytes(synth.data);
      } catch (err) {
        console.warn('ToneCOM TTS failed for chunk:', chunk.slice(0, 48), err);
        // Voice only — never push the spoken sentence to the dialer as text.
        if (mine !== gen) return;
      }
    }
  }

  function silence() {
    gen++;
    stopVoiceGraph();
    send({ kind: 'stop' });
  }
  function caption(text) { send({ kind: 'caption', text }); }

  /* ---------------- Weather ---------------- */
  const CODES = {
    0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'foggy', 48: 'foggy',
    51: 'light drizzle', 53: 'drizzling', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
    61: 'lightly raining', 63: 'raining', 65: 'raining heavily', 66: 'freezing rain', 67: 'freezing rain',
    71: 'lightly snowing', 73: 'snowing', 75: 'snowing heavily', 77: 'snowing', 80: 'a few rain showers',
    81: 'rain showers', 82: 'heavy rain showers', 85: 'snow showers', 86: 'heavy snow showers',
    95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with hail'
  };

  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.status === 404) { const e = new Error('not found'); e.code = 'notfound'; throw e; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function fetchReport(zip) {
    const place = await getJson(`https://api.zippopotam.us/us/${zip}`);
    const p = place.places && place.places[0];
    if (!p) { const e = new Error('not found'); e.code = 'notfound'; throw e; }
    const params = new URLSearchParams({
      latitude: p.latitude, longitude: p.longitude,
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', timezone: 'auto', forecast_days: '1'
    });
    const wx = await getJson('https://api.open-meteo.com/v1/forecast?' + params);
    const c = wx.current, d = wx.daily || {};
    const r = (n) => Math.round(n);
    const lines = [`Weather for ${p['place name']}, ${p.state}.`];
    lines.push(`Right now it is ${r(c.temperature_2m)} degrees and ${CODES[c.weather_code] || 'unsettled'}, feeling like ${r(c.apparent_temperature)}.`);
    lines.push(`Wind is ${r(c.wind_speed_10m)} miles per hour, with ${r(c.relative_humidity_2m)} percent humidity.`);
    if (d.temperature_2m_max && d.temperature_2m_min) {
      lines.push(`Today's high is ${r(d.temperature_2m_max[0])} and the low is ${r(d.temperature_2m_min[0])}.`);
    }
    const chance = d.precipitation_probability_max && d.precipitation_probability_max[0];
    if (chance != null) lines.push(`There is a ${r(chance)} percent chance of precipitation.`);
    return lines.join(' ');
  }

  /* ---------------- The call ---------------- */
  let state = 'entry';
  let zip = '';

  const spaced = (s) => s.split('').join(' ');
  function showZip() { caption('Zip code\n' + spaced(zip.padEnd(ZIP_LENGTH, '_'))); }

  function promptZip(welcome) {
    state = 'entry'; zip = ''; showZip();
    speak((welcome ? 'Welcome to ToneCOM Weather. ' : '') + 'Using the keypad, enter your five digit zip code.');
  }

  async function lookup() {
    state = 'lookup';
    const ack = speak(`Looking up the weather for zip code ${spaced(zip)}.`);
    let outcome;
    try { outcome = { text: await fetchReport(zip) }; }
    catch (err) { outcome = { err }; }
    await ack;
    if (outcome.text) {
      state = 'report';
      // Status only — the spoken report is audio over WebRTC, not this caption text as voice.
      caption('Playing weather report…');
      speak(outcome.text + ' To check another zip code, press any key. To hang up, end the call.');
    } else if (outcome.err && outcome.err.code === 'notfound') {
      const bad = zip;
      state = 'entry'; zip = ''; showZip();
      speak(`Sorry, I could not find zip code ${spaced(bad)}. Please enter another five digit zip code.`);
    } else {
      state = 'report';
      caption('Weather service unreachable.');
      speak('Sorry, the weather service is not reachable right now. Press any key to try again.');
    }
  }

  function onKey(key) {
    if (state === 'lookup') return;
    silence();
    if (state === 'report') {
      state = 'entry'; zip = '';
      if (!/^\d$/.test(key)) { promptZip(false); return; }
    }
    if (key === '*') { promptZip(false); return; }
    if (key === '#') { promptZip(false); return; }
    if (/^\d$/.test(key) && zip.length < ZIP_LENGTH) {
      zip += key; showZip();
      if (zip.length === ZIP_LENGTH) lookup();
    }
  }

  function start() {
    send({ kind: 'keypad', open: true });
    promptZip(true);
  }
})();
