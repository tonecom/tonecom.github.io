'use strict';
/*
 * ToneCOM Weather - a sample ToneCOM destination.
 *
 * This is an ordinary web page script. The ToneCOM dialer loads
 * /.tonecom/index.html in a hidden iframe and talks to it with postMessage.
 *
 * Call flow:
 *   1. Asks the caller to type a 5-digit US zip code on the keypad.
 *   2. Looks the zip code up (api.zippopotam.us -> latitude/longitude).
 *   3. Gets the forecast (api.open-meteo.com, no API key needed).
 *   4. Reads it back using an external text-to-speech API.
 *
 * Keys:  0-9 enter digits   * start over   # repeat the prompt
 *        Typing while it is talking interrupts it.
 */
(() => {
  const ZIP_LENGTH = 5;

  /* ------------------------------------------------------------------
   * External text-to-speech.
   * Return {url} for a service that serves audio from a plain GET URL
   * (the dialer plays it in an <audio> element, so no CORS is involved), or
   * {data: ArrayBuffer, mime: 'audio/mpeg'} if you need to POST or send an
   * API key: fetch the bytes here and return them.
   * If this fails, the call falls back to the browser's built-in voice.
   * ------------------------------------------------------------------ */
  const TTS = {
    async synthesize(text) {
      return { url: 'https://api.streamelements.com/kappa/v2/speech?voice=Brian&text=' + encodeURIComponent(text) };
    }
  };

  /* ---------------- ToneCOM client (the postMessage plumbing) ---------------- */
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

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const m = event.data;
    if (!m || m.tonecom !== 1) return;
    if (!dialer) {
      if (m.kind !== 'init') return;
      dialer = event.source;
      dialerOrigin = event.origin === 'null' ? '*' : event.origin;   // file:// dialers report "null"
      start(m.request);
      return;
    }
    if (dialerOrigin !== '*' && event.origin !== dialerOrigin) return;
    if (m.kind === 'done') {
      const resolve = waiting.get(m.id);
      if (resolve) { waiting.delete(m.id); resolve(m); }
    } else if (m.kind === 'dtmf') {
      onKey(String(m.key));
    }
  });
  window.parent.postMessage({ tonecom: 1, kind: 'ready', protocol: 'ToneCOM', version: 1 }, '*');

  /* ---------------- Speaking ---------------- */
  let gen = 0;            // bumping this cancels any speech still in progress
  let ttsFailed = false;  // after one failure, stop trying the external API for this call

  const chunksOf = (text) => (text.match(/[^.!?]+[.!?]*/g) || [text]).map(s => s.trim()).filter(Boolean);

  async function speak(text) {
    const mine = ++gen;
    for (const chunk of chunksOf(text)) {
      if (mine !== gen) return;
      let result = { ok: false };
      if (!ttsFailed) {
        try { result = await request('audio', await TTS.synthesize(chunk)); }
        catch { result = { ok: false }; }
        if (mine !== gen) return;
        if (!result.ok) ttsFailed = true;
      }
      if (!result.ok) {
        result = await request('say', { text: chunk });      // built-in voice as a fallback
        if (mine !== gen) return;
      }
    }
  }
  function silence() { gen++; send({ kind: 'stop' }); }
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
  let state = 'entry';    // 'entry' (typing a zip), 'lookup' (waiting on the APIs), 'report' (read out)
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
      caption(outcome.text);
      speak(outcome.text + ' To check another zip code, press any key. To hang up, end the call.');
    } else if (outcome.err && outcome.err.code === 'notfound') {
      const bad = zip;
      state = 'entry'; zip = ''; showZip();
      speak(`Sorry, I could not find zip code ${spaced(bad)}. Please enter another five digit zip code.`);
    } else {
      state = 'report';
      caption('The weather service could not be reached.');
      speak('Sorry, the weather service is not reachable right now. Press any key to try again.');
    }
  }

  function onKey(key) {
    if (state === 'lookup') return;
    silence();                                   // typing interrupts whatever is being said
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
    send({ kind: 'keypad', open: true });        // pop open the dialer's keypad
    promptZip(true);
  }
})();
