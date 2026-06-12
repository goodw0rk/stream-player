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
  football:   { id: 1,   label: '⚽ Football' },
  racing:     { id: 7,   label: '🏎️ Motorsport' },
  basketball: { id: 3,   label: '🏀 Basketball' },
  tennis:     { id: 4,   label: '🎾 Tennis' },
  hockey:     { id: 2,   label: '🏒 Ice Hockey' },
  mma:        { id: 110, label: '🥊 MMA' },
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

// ─── Scrape listings ─────────────────────────────────────────────────
async function scrapeListings(sportKey) {
  const sport = SPORTS[sportKey];
  if (!sport) return [];
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
          results.push({
            name: text,
            url: href.startsWith('http') ? href : 'https://livetv.sx' + href,
          });
        }
      });
      return results;
    });

    events.forEach(e => { e.name = he.decode(e.name); });
    cache.listings[sportKey] = { data: events, ts: Date.now() };
    console.log(`[${sportKey}] ${events.length} events`);
    return events;
  } catch (err) {
    console.error(`[${sportKey}] Error:`, err.message);
    return cached?.data || [];
  } finally {
    await page.close();
  }
}

// ─── Scrape streams from event page ──────────────────────────────────
async function scrapeStreams(eventUrl) {
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
          // Get server label from parent row
          const row = a.closest('tr') || a.closest('td');
          let label = '';
          if (row) {
            const tds = row.querySelectorAll('td');
            tds.forEach(td => {
              const t = td.textContent?.trim();
              if (t && t.length > 2 && t.length < 40 && !t.includes('webplayer')) {
                label = t;
              }
            });
          }
          results.push({ text: label || `Server ${results.length + 1}`, url: href });
        }
      });
      return results;
    });

    // Deduplicate by channel ID (c= param)
    const seen = new Set();
    const streams = [];
    for (const s of raw) {
      const match = s.url.match(/[?&]c=(\d+)/);
      const key = match ? match[1] : s.url;
      if (!seen.has(key)) {
        seen.add(key);
        streams.push(s);
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

// ─── Extract m3u8 from webplayer URL ─────────────────────────────────
function parseChannelId(webplayerUrl) {
  // webplayer2.php?t=alieztv&c=260846 → channel 260846
  // webplayer.php?t=ifr&c=3023569 → lid 3023569
  const params = new URL(webplayerUrl).searchParams;
  return {
    type: params.get('t'),
    channelId: params.get('c'),
    lid: params.get('lid'),
    eid: params.get('eid'),
  };
}

async function extractM3u8(webplayerUrl) {
  const cached = cache.m3u8[webplayerUrl];
  if (cached && Date.now() - cached.ts < M3U8_TTL) return cached.url;

  const info = parseChannelId(webplayerUrl);
  const b = await getBrowser();
  let m3u8Url = null;

  try {
    if (info.type === 'alieztv' && info.channelId) {
      // Direct embed URL — construct from channel ID
      const embedUrl = `https://emb.apl414.me/player/live.php?id=${info.channelId}&w=700&h=480`;
      console.log('[m3u8] Direct embed:', embedUrl);

      const page = await b.newPage();

      // Intercept responses
      page.on('response', async (res) => {
        const url = res.url();
        if (url.includes('.m3u8') && !m3u8Url) {
          m3u8Url = url;
        }
      });

      await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(8000);

      // Fallback: performance API
      if (!m3u8Url) {
        m3u8Url = await page.evaluate(() => {
          const entries = performance.getEntriesByType('resource');
          for (const e of entries) {
            if (e.name.includes('.m3u8')) return e.name;
          }
          const video = document.querySelector('video');
          if (video?.currentSrc?.includes('.m3u8')) return video.currentSrc;
          return null;
        });
      }
      await page.close();

    } else if (info.type === 'ifr') {
      // iframe type — open webplayer, find the actual iframe src
      console.log('[m3u8] iframe type, lid:', info.lid);
      const page = await b.newPage();
      
      page.on('response', async (res) => {
        const url = res.url();
        if (url.includes('.m3u8') && !m3u8Url) {
          m3u8Url = url;
        }
      });

      await page.goto(webplayerUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(6000);

      // Try performance API
      if (!m3u8Url) {
        m3u8Url = await page.evaluate(() => {
          const entries = performance.getEntriesByType('resource');
          for (const e of entries) {
            if (e.name.includes('.m3u8')) return e.name;
          }
          return null;
        });
      }

      // Try to find embed src in iframes and navigate to it
      if (!m3u8Url) {
        const embedSrc = await page.evaluate(() => {
          const iframes = document.querySelectorAll('iframe');
          for (const f of iframes) {
            if (f.src && (f.src.includes('apl') || f.src.includes('emb.'))) return f.src;
          }
          return null;
        });

        if (embedSrc) {
          console.log('[m3u8] Found nested embed:', embedSrc.substring(0, 60));
          const embedPage = await b.newPage();
          embedPage.on('response', async (res) => {
            const url = res.url();
            if (url.includes('.m3u8') && !m3u8Url) m3u8Url = url;
          });
          await embedPage.goto(embedSrc, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await embedPage.waitForTimeout(8000);
          if (!m3u8Url) {
            m3u8Url = await embedPage.evaluate(() => {
              const entries = performance.getEntriesByType('resource');
              for (const e of entries) { if (e.name.includes('.m3u8')) return e.name; }
              return null;
            });
          }
          await embedPage.close();
        }
      }
      await page.close();
    }

    if (m3u8Url) {
      cache.m3u8[webplayerUrl] = { url: m3u8Url, ts: Date.now() };
      console.log('[m3u8] ✓', m3u8Url.substring(0, 100));
    } else {
      console.log('[m3u8] ✗', webplayerUrl.substring(0, 60));
    }
    return m3u8Url;
  } catch (err) {
    console.error('[m3u8] Error:', err.message);
    return cached?.url || null;
  }
}

// ─── API Routes ──────────────────────────────────────────────────────
app.get('/api/sports', (req, res) => {
  res.json(Object.entries(SPORTS).map(([key, val]) => ({ key, label: val.label })));
});

app.get('/api/listings/:sport', async (req, res) => {
  if (!SPORTS[req.params.sport]) return res.status(404).json({ error: 'Unknown sport' });
  res.json(await scrapeListings(req.params.sport));
});

app.get('/api/streams', async (req, res) => {
  if (!req.query.url) return res.status(400).json({ error: 'Missing url' });
  res.json(await scrapeStreams(req.query.url));
});

app.get('/api/m3u8', async (req, res) => {
  if (!req.query.url) return res.status(400).json({ error: 'Missing url' });
  res.json({ url: await extractM3u8(req.query.url) });
});

// ─── Static ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`Stream player running on :${PORT}`));
