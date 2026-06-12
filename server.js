const express = require('express');
const path = require('path');
const he = require('he');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

const cache = { footybitez: null, footybitez_ts: 0, streams: {}, m3u8: {} };
const CACHE_TTL = 2 * 60 * 1000;
const STREAM_TTL = 5 * 60 * 1000;
const M3U8_TTL = 15 * 60 * 1000;

const SPORTS = {
  football:   { label: '⚽ Football',       source: 'footybitez' },
  motogp:     { label: '🏍️ MotoGP',        source: 'nontonx', nontonxPath: 'mgpplayer2' },
  worldsbk:   { label: '🏁 WorldSBK',       source: 'nontonx', nontonxPath: 'wsbkplayer1' },
  f1:         { label: '🏎️ Formula 1',      source: 'nontonx', nontonxPath: 'formulaplayer1' },
  randomtv:   { label: '📺 RandomTV',       source: 'nontonx', nontonxPath: 'randomplayer' },
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

// ─── Footybitez: Scrape live football matches ────────────────────────
async function scrapeFootybitez() {
  if (cache.footybitez && Date.now() - cache.footybitez_ts < CACHE_TTL) {
    return cache.footybitez;
  }

  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.goto('https://footybite.vc/', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(3000);

    const matches = await page.evaluate(() => {
      const results = [];
      // Find match cards - each has a link to the match page
      document.querySelectorAll('a[href*="/"]').forEach(a => {
        const href = a.getAttribute('href') || '';
        // Match URLs like /Canada-vs-Bosnia-and-Herzegovina/68732
        if (href.match(/\/[A-Za-z].*\/\d+$/)) {
          const text = a.textContent?.trim()?.replace(/\s+/g, ' ');
          if (text && text.length > 5 && text.length < 150) {
            // Check if it's football/soccer (not NBA, NFL, etc.)
            const parent = a.closest('div');
            const section = parent?.querySelector('img');
            const sportIcon = section?.alt || '';
            const isFootball = !sportIcon.match(/nba|nfl|nhl|mlb|wnba|boxing|ufc|golf|rugby|cricket/i);
            
            // Check if it has "Live Streams" button
            const hasLiveBtn = a.textContent.includes('Live Streams');
            
            if (hasLiveBtn) {
              const fullUrl = href.startsWith('http') ? href : 'https://footybite.vc' + href;
              const name = text.replace(/Starts in.*?min/, '').replace(/Match Started/, '').replace(/Live Streams/, '').trim();
              const isLive = text.includes('Match Started');
              results.push({ name, url: fullUrl, isLive });
            }
          }
        }
      });
      return results;
    });

    // Deduplicate
    const seen = new Set();
    const unique = matches.filter(m => {
      if (seen.has(m.url)) return false;
      seen.add(m.url);
      return true;
    });

    cache.footybitez = unique;
    cache.footybitez_ts = Date.now();
    console.log(`[footybitez] ${unique.length} matches`);
    return unique;
  } catch (err) {
    console.error('[footybitez] Error:', err.message);
    return cache.footybitez || [];
  } finally {
    await page.close();
  }
}

// ─── Footybitez: Get stream provider URLs for a match ────────────────
async function getFootybitezStreams(matchUrl) {
  const cached = cache.streams[matchUrl];
  if (cached && Date.now() - cached.ts < STREAM_TTL) return cached.data;

  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.goto(matchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(3000);

    // Extract stream provider URLs from hidden inputs
    const streams = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('input[id^="linkk"]').forEach(inp => {
        const url = inp.value;
        if (url && url.startsWith('http')) {
          const id = inp.id.replace('linkk', '');
          // Find the associated stream name from the onclick row
          const row = document.querySelector(`[onclick="view(${id})"]`);
          let name = `Provider ${results.length + 1}`;
          let channel = '';
          if (row) {
            const cells = row.closest('tr')?.querySelectorAll('td');
            if (cells) {
              cells.forEach((td, i) => {
                const text = td.textContent?.trim();
                if (i === 1 && text) name = text; // Name column
                if (i === 6 && text) channel = text; // Channel column
              });
            }
          }
          results.push({ name, channel, url, providerId: id });
        }
      });
      return results;
    });

    cache.streams[matchUrl] = { data: streams, ts: Date.now() };
    console.log(`[footybitez:streams] ${matchUrl.split('/').pop()} → ${streams.length}`);
    return streams;
  } catch (err) {
    console.error('[footybitez:streams] Error:', err.message);
    return cached?.data || [];
  } finally {
    await page.close();
  }
}

// ─── Extract m3u8 from a stream provider URL ─────────────────────────
async function extractM3u8(providerUrl) {
  const cached = cache.m3u8[providerUrl];
  if (cached && Date.now() - cached.ts < M3U8_TTL) return cached.url;

  const b = await getBrowser();
  let m3u8Url = null;
  try {
    const page = await b.newPage();

    // Intercept ALL responses for m3u8 (catches nested iframe requests)
    page.on('response', async (res) => {
      const url = res.url();
      if (url.includes('.m3u8') && !m3u8Url) {
        m3u8Url = url;
      }
    });

    await page.goto(providerUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(12000); // Wait for nested iframes to load

    // Also check all frames for m3u8
    if (!m3u8Url) {
      for (const frame of page.frames()) {
        try {
          const found = await frame.evaluate(() => {
            const entries = performance.getEntriesByType('resource');
            for (const e of entries) { if (e.name.includes('.m3u8')) return e.name; }
            return null;
          });
          if (found) { m3u8Url = found; break; }
        } catch {}
      }
    }

    // Check main page performance
    if (!m3u8Url) {
      m3u8Url = await page.evaluate(() => {
        const entries = performance.getEntriesByType('resource');
        for (const e of entries) { if (e.name.includes('.m3u8')) return e.name; }
        return null;
      });
    }

    await page.close();

    if (m3u8Url) {
      cache.m3u8[providerUrl] = { url: m3u8Url, ts: Date.now() };
      console.log('[m3u8] ✓', m3u8Url.substring(0, 100));
    } else {
      console.log('[m3u8] ✗', providerUrl.substring(0, 80));
    }
    return m3u8Url;
  } catch (err) {
    console.error('[m3u8] Error:', err.message);
    return cached?.url || null;
  }
}

// ─── NontonX: Get sources ────────────────────────────────────────────
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

// ─── NontonX: Extract m3u8 ───────────────────────────────────────────
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
  } else if (SPORTS[sport].source === 'footybitez') {
    res.json(await scrapeFootybitez());
  }
});

// Get stream providers for a footybitez match
app.get('/api/streams', async (req, res) => {
  if (!req.query.url) return res.status(400).json({ error: 'Missing url' });
  res.json(await getFootybitezStreams(req.query.url));
});

// Extract m3u8 from any source
app.get('/api/m3u8', async (req, res) => {
  if (!req.query.url) return res.status(400).json({ error: 'Missing url' });
  const url = req.query.url;
  let m3u8;
  if (url.includes('nontonx.com')) {
    m3u8 = await extractM3u8FromNontonX(url);
  } else {
    m3u8 = await extractM3u8(url);
  }
  res.json({ url: m3u8 });
});

// ─── Static ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`Stream player running on :${PORT}`));
