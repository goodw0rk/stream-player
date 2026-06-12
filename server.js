const express = require('express');
const path = require('path');
const he = require('he');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

const cache = { listings: {}, streams: {}, m3u8: {} };
const LISTING_TTL = 2 * 60 * 1000;
const STREAM_TTL = 5 * 60 * 1000;
const M3U8_TTL = 15 * 60 * 1000;

const SPORTS = {
  football:    { id: 1,   label: '⚽ Football',       source: 'livetv' },
  motogp:      { id: null, label: '🏍️ MotoGP',        source: 'nontonx', nontonxPath: 'mgpplayer2' },
  worldsbk:    { id: null, label: '🏁 WorldSBK',       source: 'nontonx', nontonxPath: 'wsbkplayer1' },
  f1:          { id: null, label: '🏎️ Formula 1',      source: 'nontonx', nontonxPath: 'formulaplayer1' },
  randomtv:    { id: null, label: '📺 RandomTV',       source: 'nontonx', nontonxPath: 'randomplayer' },
  basketball:  { id: 3,   label: '🏀 Basketball',     source: 'livetv' },
  tennis:      { id: 4,   label: '🎾 Tennis',         source: 'livetv' },
  hockey:      { id: 2,   label: '🏒 Ice Hockey',     source: 'livetv' },
  mma:         { id: 110, label: '🥊 MMA',            source: 'livetv' },
};

const NONTONX_SERVERS = {
  mgpplayer2:    { label: '🚜 Server Ekonomi', path: 'mgpplayer2' },
  edgeplayer:    { label: '🧪 Server Turbo',   path: 'edgeplayer' },
  passplayer:    { label: '🖥️ Chrome SPO',     path: 'passplayer' },
  passplayer2:   { label: '🖥️ Chrome TNT2',    path: 'passplayer2' },
  oldplayer:     { label: '📼 Server Old',     path: 'oldplayer' },
};

let browser = null;
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browser;
}

// ─── LiveTV: Scrape listings ─────────────────────────────────────────
async function scrapeListings(sportKey) {
  const sport = SPORTS[sportKey];
  if (!sport || sport.source !== 'livetv') return [];
  const cached = cache.listings[sportKey];
  if (cached && Date.now() - cached.ts < LISTING_TTL) return cached.data;

  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.goto(`https://livetv.sx/enx/allupcomingsports/${sport.id}/`, {
      waitUntil: 'domcontentloaded', timeout: 20000,
    });
    await page.waitForTimeout(3000);
    const events = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="eventinfo"]');
      const results = [];
      const seen = new Set();
      links.forEach(a => {
        const href = a.getAttribute('href');
        const text = a.textContent.trim().replace(/\s+/g, ' ');
        if (text.length > 2 && text.length < 120 && !seen.has(href)) {
          seen.add(href);
          results.push({ name: text, url: href.startsWith('http') ? href : 'https://livetv.sx' + href });
        }
      });
      return results;
    });
    events.forEach(e => { e.name = he.decode(e.name); });
    cache.listings[sportKey] = { data: events, ts: Date.now() };
    console.log(`[livetv:${sportKey}] ${events.length} events`);
    return events;
  } catch (err) {
    console.error(`[livetv:${sportKey}] Error:`, err.message);
    return cached?.data || [];
  } finally {
    await page.close();
  }
}

// ─── NontonX: Get stream sources ─────────────────────────────────────
function getNontonXStreams(sportKey) {
  const sport = SPORTS[sportKey];
  if (!sport || sport.source !== 'nontonx') return [];
  return Object.entries(NONTONX_SERVERS).map(([key, server]) => ({
    name: server.label,
    url: `https://esp32.nontonx.com/${server.path}`,
    sportPath: sport.nontonxPath,
    serverKey: key,
  }));
}

// ─── LiveTV: Get stream embed URLs for iframe ────────────────────────
async function getStreamEmbeds(eventUrl) {
  const cached = cache.streams[eventUrl];
  if (cached && Date.now() - cached.ts < STREAM_TTL) return cached.data;

  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.goto(eventUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);
    const raw = await page.evaluate(() => {
      const results = [];
      const seen = new Set();
      document.querySelectorAll('a[href*="webplayer"]').forEach(a => {
        const href = a.href;
        if (!seen.has(href)) {
          seen.add(href);
          const row = a.closest('tr') || a.closest('td');
          let label = '';
          if (row) {
            row.querySelectorAll('td').forEach(td => {
              const t = td.textContent?.trim();
              if (t && t.length > 2 && t.length < 40 && !t.includes('webplayer')) label = t;
            });
          }
          results.push({ text: label || `Server ${results.length + 1}`, url: href });
        }
      });
      return results;
    });

    // Deduplicate by channel ID and convert to embed URLs
    const seen = new Set();
    const streams = [];
    for (const s of raw) {
      const match = s.url.match(/[?&]c=(\d+)/);
      const key = match ? match[1] : s.url;
      if (!seen.has(key)) {
        seen.add(key);
        // Convert webplayer URL to direct embed URL for iframe
        if (match && s.url.includes('webplayer2.php')) {
          const channelId = match[1];
          streams.push({
            text: s.text,
            url: s.url,
            embedUrl: `https://emb.apl414.me/player/live.php?id=${channelId}&w=700&h=480`,
            type: 'iframe',
          });
        } else {
          streams.push({ text: s.text, url: s.url, type: 'webplayer' });
        }
      }
    }

    cache.streams[eventUrl] = { data: streams, ts: Date.now() };
    console.log(`[streams] ${eventUrl.split('/').pop()} → ${streams.length}`);
    return streams;
  } catch (err) {
    console.error('[streams] Error:', err.message);
    return cached?.data || [];
  } finally {
    await page.close();
  }
}

// ─── Extract m3u8 from NontonX ───────────────────────────────────────
async function extractM3u8FromNontonX(nontonxUrl) {
  const cached = cache.m3u8[nontonxUrl];
  if (cached && Date.now() - cached.ts < M3U8_TTL) return cached.url;

  const b = await getBrowser();
  let m3u8Url = null;
  try {
    const page = await b.newPage();
    page.on('response', async (res) => {
      const url = res.url();
      if (url.includes('.m3u8') && !m3u8Url) m3u8Url = url;
    });
    await page.goto(nontonxUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(10000);
    if (!m3u8Url) {
      m3u8Url = await page.evaluate(() => {
        const entries = performance.getEntriesByType('resource');
        for (const e of entries) { if (e.name.includes('.m3u8')) return e.name; }
        return null;
      });
    }
    await page.close();
    if (m3u8Url) {
      cache.m3u8[nontonxUrl] = { url: m3u8Url, ts: Date.now() };
      console.log('[nontonx:m3u8] ✓', m3u8Url.substring(0, 80));
    } else {
      console.log('[nontonx:m3u8] ✗', nontonxUrl);
    }
    return m3u8Url;
  } catch (err) {
    console.error('[nontonx:m3u8] Error:', err.message);
    return cached?.url || null;
  }
}

// ─── API Routes ──────────────────────────────────────────────────────
app.get('/api/sports', (req, res) => {
  res.json(Object.entries(SPORTS).map(([key, val]) => ({
    key, label: val.label, source: val.source,
  })));
});

app.get('/api/listings/:sport', async (req, res) => {
  const sport = req.params.sport;
  if (!SPORTS[sport]) return res.status(404).json({ error: 'Unknown sport' });
  if (SPORTS[sport].source === 'nontonx') {
    res.json(getNontonXStreams(sport));
  } else {
    res.json(await scrapeListings(sport));
  }
});

// Get streams for a LiveTV event (returns embed URLs for iframe)
app.get('/api/streams', async (req, res) => {
  if (!req.query.url) return res.status(400).json({ error: 'Missing url' });
  res.json(await getStreamEmbeds(req.query.url));
});

// Extract m3u8 from NontonX only (LiveTV uses iframe now)
app.get('/api/m3u8', async (req, res) => {
  if (!req.query.url) return res.status(400).json({ error: 'Missing url' });
  const url = req.query.url;
  let m3u8;
  if (url.includes('nontonx.com')) {
    m3u8 = await extractM3u8FromNontonX(url);
  } else {
    // LiveTV: not supported via m3u8, use iframe embed instead
    m3u8 = null;
  }
  res.json({ url: m3u8 });
});

// ─── Static ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`Stream player running on :${PORT}`));
