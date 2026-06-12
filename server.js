const express = require('express');
const path = require('path');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Cache ──────────────────────────────────────────────────────────
const cache = { footybitez: null, footybitez_ts: 0, streams: {}, m3u8: {} };
const CACHE_TTL = 2 * 60 * 1000;
const STREAM_TTL = 5 * 60 * 1000;
const M3U8_TTL = 15 * 60 * 1000;

// ─── Sports config ──────────────────────────────────────────────────
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

// ─── Browser pool ───────────────────────────────────────────────────
let browser = null;
let browserLaunchPromise = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (browserLaunchPromise) return browserLaunchPromise;

  browserLaunchPromise = chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--single-process',
    ],
  }).then(b => {
    browser = b;
    browserLaunchPromise = null;
    b.on('disconnected', () => { browser = null; });
    console.log('[browser] launched');
    return b;
  }).catch(err => {
    browserLaunchPromise = null;
    throw err;
  });

  return browserLaunchPromise;
}

// ─── Concurrency limiter ────────────────────────────────────────────
const MAX_CONCURRENT = 3;
let activePages = 0;
const waitQueue = [];

async function acquirePage() {
  if (activePages < MAX_CONCURRENT) {
    activePages++;
    return;
  }
  await new Promise(resolve => waitQueue.push(resolve));
  activePages++;
}

function releasePage() {
  activePages--;
  if (waitQueue.length > 0 && activePages < MAX_CONCURRENT) {
    activePages--;
    waitQueue.shift()();
  }
}

// ─── Footybitez: scrape matches ─────────────────────────────────────
async function scrapeFootybitez() {
  if (cache.footybitez && Date.now() - cache.footybitez_ts < CACHE_TTL) {
    return cache.footybitez;
  }

  await acquirePage();
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.goto('https://footybite.vc/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const matches = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('a[href*="/"]').forEach(a => {
        const href = a.getAttribute('href') || '';
        if (href.match(/\/[A-Za-z].*\/\d+$/)) {
          const text = a.textContent?.trim()?.replace(/\s+/g, ' ');
          if (text && text.length > 5 && text.length < 150) {
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
    await page.close().catch(() => {});
    releasePage();
  }
}

// ─── Footybitez: get stream providers for a match ───────────────────
async function getFootybitezStreams(matchUrl) {
  const cached = cache.streams[matchUrl];
  if (cached && Date.now() - cached.ts < STREAM_TTL) return cached.data;

  await acquirePage();
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.goto(matchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const streams = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('input[id^="linkk"]').forEach(inp => {
        const url = inp.value;
        if (url && url.startsWith('http')) {
          const id = inp.id.replace('linkk', '');
          const row = document.querySelector(`[onclick="view(${id})"]`);
          let name = `Provider ${results.length + 1}`;
          let channel = '';
          if (row) {
            const cells = row.closest('tr')?.querySelectorAll('td');
            if (cells) {
              cells.forEach((td, i) => {
                const text = td.textContent?.trim();
                if (i === 1 && text) name = text;
                if (i === 6 && text) channel = text;
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
    await page.close().catch(() => {});
    releasePage();
  }
}

// ─── Extract m3u8: multi-strategy ───────────────────────────────────
async function extractM3u8(providerUrl) {
  const cached = cache.m3u8[providerUrl];
  if (cached && Date.now() - cached.ts < M3U8_TTL) return cached.url;

  await acquirePage();
  const b = await getBrowser();
  let m3u8Url = null;
  try {
    const page = await b.newPage();

    // Strategy 1: Intercept responses
    page.on('response', async (res) => {
      try {
        const url = res.url();
        if (url.includes('.m3u8') && !m3u8Url) {
          m3u8Url = url;
        }
      } catch {}
    });

    await page.goto(providerUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Wait with early exit — poll every 1s for m3u8, max 10s
    for (let i = 0; i < 10; i++) {
      if (m3u8Url) break;
      await page.waitForTimeout(1000);
    }

    // Strategy 2: Check performance entries on all frames
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

    // Strategy 3: Regex scan page HTML for m3u8 URLs
    if (!m3u8Url) {
      try {
        const html = await page.content();
        const m3u8Match = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
        if (m3u8Match) m3u8Url = m3u8Match[0].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
      } catch {}
    }

    // Strategy 4: Check iframes srcdoc for m3u8
    if (!m3u8Url) {
      try {
        const srcdocs = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('iframe[srcdoc]')).map(f => f.srcdoc);
        });
        for (const srcdoc of srcdocs) {
          const m = srcdoc.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
          if (m) { m3u8Url = m[0].replace(/\\u002F/g, '/').replace(/\\\//g, '/'); break; }
        }
      } catch {}
    }

    // Strategy 5: Check JS variables for m3u8 patterns
    if (!m3u8Url) {
      try {
        const found = await page.evaluate(() => {
          // Check common player variable names
          const patterns = ['file', 'source', 'src', 'url', 'stream', 'video', 'hls', 'm3u8'];
          for (const key of patterns) {
            try {
              const val = window[key];
              if (typeof val === 'string' && val.includes('.m3u8')) return val;
            } catch {}
          }
          // Check script tags for inline m3u8
          for (const script of document.querySelectorAll('script')) {
            const text = script.textContent || '';
            const m = text.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*?)["']/);
            if (m) return m[1];
          }
          return null;
        });
        if (found) m3u8Url = found;
      } catch {}
    }

    await page.close().catch(() => {});

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
  } finally {
    releasePage();
  }
}

// ─── NontonX: get sources ───────────────────────────────────────────
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

// ─── NontonX: extract m3u8 ──────────────────────────────────────────
async function extractM3u8FromNontonX(nontonxUrl) {
  const cached = cache.m3u8[nontonxUrl];
  if (cached && Date.now() - cached.ts < M3U8_TTL) return cached.url;

  await acquirePage();
  const b = await getBrowser();
  let m3u8Url = null;
  try {
    const page = await b.newPage();
    page.on('response', async (res) => {
      try {
        const url = res.url();
        if (url.includes('.m3u8') && !m3u8Url) m3u8Url = url;
      } catch {}
    });

    await page.goto(nontonxUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Wait with early exit
    for (let i = 0; i < 8; i++) {
      if (m3u8Url) break;
      await page.waitForTimeout(1000);
    }

    if (!m3u8Url) {
      // Check performance + regex scan
      m3u8Url = await page.evaluate(() => {
        const entries = performance.getEntriesByType('resource');
        for (const e of entries) { if (e.name.includes('.m3u8')) return e.name; }
        const html = document.documentElement.innerHTML;
        const m = html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*?)["']/);
        return m ? m[1] : null;
      });
    }

    await page.close().catch(() => {});

    if (m3u8Url) {
      cache.m3u8[nontonxUrl] = { url: m3u8Url, ts: Date.now() };
      console.log('[nontonx:m3u8] ✓', m3u8Url.substring(0, 80));
    } else {
      console.log('[nontonx:m3u8] ✗', nontonxUrl.substring(0, 60));
    }
    return m3u8Url;
  } catch (err) {
    console.error('[nontonx:m3u8] Error:', err.message);
    return cached?.url || null;
  } finally {
    releasePage();
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
  try {
    if (SPORTS[sport].source === 'nontonx') {
      res.json(getNontonXStreams(sport));
    } else if (SPORTS[sport].source === 'footybitez') {
      res.json(await scrapeFootybitez());
    }
  } catch (err) {
    console.error(`[listings:${sport}] Error:`, err.message);
    res.status(500).json({ error: 'Failed to load listings' });
  }
});

app.get('/api/streams', async (req, res) => {
  if (!req.query.url) return res.status(400).json({ error: 'Missing url' });
  try {
    res.json(await getFootybitezStreams(req.query.url));
  } catch (err) {
    console.error('[streams] Error:', err.message);
    res.status(500).json({ error: 'Failed to load streams' });
  }
});

app.get('/api/m3u8', async (req, res) => {
  if (!req.query.url) return res.status(400).json({ error: 'Missing url' });
  const url = req.query.url;
  try {
    let m3u8;
    if (url.includes('nontonx.com')) {
      m3u8 = await extractM3u8FromNontonX(url);
    } else {
      m3u8 = await extractM3u8(url);
    }
    res.json({ url: m3u8 });
  } catch (err) {
    console.error('[m3u8] Error:', err.message);
    res.json({ url: null });
  }
});

// ─── Health check ───────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, activePages, browser: !!browser });
});

// ─── Static ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`Stream player running on :${PORT}`));
