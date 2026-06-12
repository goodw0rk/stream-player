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
      '--disable-features=IsolateOrigins,site-per-process',
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
const MAX_CONCURRENT = 5;
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
    await page.goto('https://home.footybite.vc/', { waitUntil: 'domcontentloaded', timeout: 20000 });
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
              const fullUrl = href.startsWith('http') ? href : 'https://home.footybite.vc' + href;
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

// ─── Helper: check if URL is likely an m3u8 stream ─────────────────
function isLikelyM3u8(url, contentType) {
  // Explicit m3u8 extension
  if (url.includes('.m3u8')) return true;
  // Content-type check
  if (contentType && (contentType.includes('mpegurl') || contentType.includes('m3u8'))) return true;
  // /hls/ path but NOT a JS/CSS/image file
  if (url.includes('/hls/') && !url.match(/\.(js|css|png|jpg|svg|woff|ttf)(\?|$)/i)) return true;
  return false;
}

// ─── Extract m3u8: enhanced multi-strategy ──────────────────────────
async function extractM3u8(providerUrl) {
  const cached = cache.m3u8[providerUrl];
  if (cached && Date.now() - cached.ts < M3U8_TTL) return cached.url;

  await acquirePage();
  const b = await getBrowser();
  let m3u8Url = null;
  let allNetworkUrls = [];
  try {
    const page = await b.newPage();

    // Strategy 1: Intercept ALL network responses
    page.on('response', async (res) => {
      try {
        const url = res.url();
        const ct = res.headers()['content-type'] || '';
        allNetworkUrls.push(url);
        if (!m3u8Url && isLikelyM3u8(url, ct)) {
          m3u8Url = url;
        }
      } catch {}
    });

    // Also intercept requests
    page.on('request', (req) => {
      try {
        const url = req.url();
        if (!m3u8Url && url.includes('.m3u8')) {
          m3u8Url = url;
        }
      } catch {}
    });

    await page.goto(providerUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Wait with early exit — poll every 1s for m3u8, max 12s
    for (let i = 0; i < 12; i++) {
      if (m3u8Url) break;
      await page.waitForTimeout(1000);
    }

    // Strategy 2: Check performance entries on all frames
    if (!m3u8Url) {
      for (const frame of page.frames()) {
        try {
          const found = await frame.evaluate(() => {
            const entries = performance.getEntriesByType('resource');
            for (const e of entries) {
              if (e.name.includes('.m3u8')) return e.name;
            }
            return null;
          });
          if (found) { m3u8Url = found; break; }
        } catch {}
      }
    }

    // Strategy 3: Aggressive regex scan of ALL frames' HTML
    if (!m3u8Url) {
      for (const frame of page.frames()) {
        try {
          const found = await frame.evaluate(() => {
            const html = document.documentElement.innerHTML;
            // Multiple regex patterns for different escaping styles
            const patterns = [
              /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i,
              /https?:\/\/[^\s"'<>]+\/hls\/[^\s"'<>]*/i,
              /['"]((?:https?:)?\/\/[^'"]+\.m3u8[^'"]*?)['"]/i,
              /['"]((?:https?:)?\/\/[^'"]+\/hls\/[^'"]*?)['"]/i,
              /file\s*[:=]\s*['"]([^'"]+\.m3u8[^'"]*?)['"]/i,
              /source\s*[:=]\s*['"]([^'"]+\.m3u8[^'"]*?)['"]/i,
              /src\s*[:=]\s*['"]([^'"]+\.m3u8[^'"]*?)['"]/i,
            ];
            for (const pat of patterns) {
              const m = html.match(pat);
              if (m) return (m[1] || m[0]).replace(/\\u002F/g, '/').replace(/\\\//g, '/');
            }
            return null;
          });
          if (found) { m3u8Url = found; break; }
        } catch {}
      }
    }

    // Strategy 4: Check iframes srcdoc for m3u8
    if (!m3u8Url) {
      try {
        const srcdocs = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('iframe[srcdoc]')).map(f => f.srcdoc);
        });
        for (const srcdoc of srcdocs) {
          const patterns = [
            /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i,
            /https?:\/\/[^\s"'<>]+\/hls\/[^\s"'<>]*/i,
          ];
          for (const pat of patterns) {
            const m = srcdoc.match(pat);
            if (m) { m3u8Url = m[0].replace(/\\u002F/g, '/').replace(/\\\//g, '/'); break; }
          }
          if (m3u8Url) break;
        }
      } catch {}
    }

    // Strategy 5: Check JS variables for m3u8 patterns (expanded)
    if (!m3u8Url) {
      try {
        const found = await page.evaluate(() => {
          // Check common player variable names
          const patterns = ['file', 'source', 'src', 'url', 'stream', 'video', 'hls', 'm3u8',
                           'videoUrl', 'streamUrl', 'playUrl', 'mediaUrl', 'videoSrc'];
          for (const key of patterns) {
            try {
              const val = window[key];
              if (typeof val === 'string' && val.includes('.m3u8')) return val;
              if (typeof val === 'object' && val !== null) {
                // Check nested objects (common in player configs)
                for (const [k, v] of Object.entries(val)) {
                  if (typeof v === 'string' && v.includes('.m3u8')) return v;
                }
              }
            } catch {}
          }
          // Check script tags for inline m3u8
          for (const script of document.querySelectorAll('script')) {
            const text = script.textContent || '';
            const m38patterns = [
              /["'](https?:\/\/[^"']+\.m3u8[^"']*?)["']/,
              /file\s*[:=]\s*["']([^"']+\.m3u8[^"']*?)["']/,
              /source\s*[:=]\s*["']([^"']+\.m3u8[^"']*?)["']/,
            ];
            for (const pat of m38patterns) {
              const m = text.match(pat);
              if (m) return m[1];
            }
          }
          return null;
        });
        if (found) m3u8Url = found;
      } catch {}
    }

    // Strategy 6: Check for blob: URLs and trace them
    if (!m3u8Url) {
      try {
        const blobInfo = await page.evaluate(() => {
          const videos = document.querySelectorAll('video');
          for (const v of videos) {
            if (v.src && v.src.startsWith('blob:')) {
              return { hasBlob: true, blobUrl: v.src };
            }
          }
          return null;
        });
        if (blobInfo?.hasBlob) {
          const m3u8FromBlob = await page.evaluate(() => {
            const entries = performance.getEntriesByType('resource');
            for (const e of entries) {
              if (e.name.includes('.m3u8')) return e.name;
            }
            return null;
          });
          if (m3u8FromBlob) m3u8Url = m3u8FromBlob;
        }
      } catch {}
    }

    // Strategy 7: Navigate into iframe sources to find m3u8
    if (!m3u8Url) {
      try {
        const iframeSrcs = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('iframe[src]'))
            .map(f => f.src)
            .filter(s => s && s.startsWith('http') && !s.includes('about:blank') && !s.includes('google') && !s.includes('facebook'));
        });
        console.log(`[m3u8] Found ${iframeSrcs.length} iframe(s)`);

        // Try to navigate into the first few iframes
        for (const iframeSrc of iframeSrcs.slice(0, 3)) {
          if (m3u8Url) break;
          try {
            const iframePage = await b.newPage();
            let iframeM3u8 = null;

            iframePage.on('response', async (res) => {
              try {
                const url = res.url();
                const ct = res.headers()['content-type'] || '';
                if (!iframeM3u8 && isLikelyM3u8(url, ct)) iframeM3u8 = url;
              } catch {}
            });

            await iframePage.goto(iframeSrc, { waitUntil: 'domcontentloaded', timeout: 15000 });

            // Wait for m3u8 to appear
            for (let i = 0; i < 8; i++) {
              if (iframeM3u8) break;
              await iframePage.waitForTimeout(1000);
            }

            // Also check performance entries in iframe
            if (!iframeM3u8) {
              try {
                iframeM3u8 = await iframePage.evaluate(() => {
                  const entries = performance.getEntriesByType('resource');
                  for (const e of entries) { if (e.name.includes('.m3u8')) return e.name; }
                  // Check script content
                  for (const script of document.querySelectorAll('script')) {
                    const text = script.textContent || '';
                    const m = text.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*?)["']/);
                    if (m) return m[1];
                  }
                  return null;
                });
              } catch {}
            }

            // Check nested iframes too (some sites have 2+ levels)
            if (!iframeM3u8) {
              try {
                const nestedSrcs = await iframePage.evaluate(() => {
                  return Array.from(document.querySelectorAll('iframe[src]'))
                    .map(f => f.src)
                    .filter(s => s && s.startsWith('http') && !s.includes('about:blank'));
                });
                for (const nestedSrc of nestedSrcs.slice(0, 2)) {
                  if (iframeM3u8) break;
                  try {
                    const nestedPage = await b.newPage();
                    nestedPage.on('response', async (res) => {
                      try {
                        const url = res.url();
                        if (!iframeM3u8 && url.includes('.m3u8')) iframeM3u8 = url;
                      } catch {}
                    });
                    await nestedPage.goto(nestedSrc, { waitUntil: 'domcontentloaded', timeout: 12000 });
                    for (let i = 0; i < 6; i++) {
                      if (iframeM3u8) break;
                      await nestedPage.waitForTimeout(1000);
                    }
                    if (!iframeM3u8) {
                      try {
                        iframeM3u8 = await nestedPage.evaluate(() => {
                          const entries = performance.getEntriesByType('resource');
                          for (const e of entries) { if (e.name.includes('.m3u8')) return e.name; }
                          return null;
                        });
                      } catch {}
                    }
                    await nestedPage.close().catch(() => {});
                  } catch {}
                }
              } catch {}
            }

            await iframePage.close().catch(() => {});
            if (iframeM3u8) m3u8Url = iframeM3u8;
          } catch (err) {
            console.log(`[m3u8] iframe navigate failed: ${err.message.substring(0, 60)}`);
          }
        }
      } catch {}
    }

    // Strategy 8: Scan all collected network URLs for potential stream URLs
    if (!m3u8Url && allNetworkUrls.length > 0) {
      const m3u8Candidate = allNetworkUrls.find(u => u.includes('.m3u8'));
      if (m3u8Candidate) m3u8Url = m3u8Candidate;
    }

    await page.close().catch(() => {});

    // Final validation: must contain .m3u8
    if (m3u8Url && !m3u8Url.includes('.m3u8')) {
      console.log('[m3u8] Rejected non-m3u8 URL:', m3u8Url.substring(0, 80));
      m3u8Url = null;
    }

    if (m3u8Url) {
      cache.m3u8[providerUrl] = { url: m3u8Url, ts: Date.now() };
      console.log('[m3u8] ✓', m3u8Url.substring(0, 100));
    } else {
      console.log('[m3u8] ✗', providerUrl.substring(0, 80), `(${allNetworkUrls.length} network reqs)`);
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
    res.json({ url: m3u8, fallbackUrl: m3u8 ? null : url });
  } catch (err) {
    console.error('[m3u8] Error:', err.message);
    res.json({ url: null, fallbackUrl: url });
  }
});

// ─── Working streams: test providers in parallel, return only working ones ─
app.get('/api/working-streams', async (req, res) => {
  if (!req.query.url) return res.status(400).json({ error: 'Missing url' });
  const matchUrl = req.query.url;
  try {
    // Get all providers for this match
    const providers = await getFootybitezStreams(matchUrl);
    if (!providers.length) return res.json([]);

    console.log(`[working-streams] Testing ${providers.length} providers for ${matchUrl.split('/').pop()}`);

    // Test providers in batches of 5 (limited by browser concurrency)
    const results = [];
    const BATCH_SIZE = 5;
    for (let i = 0; i < providers.length; i += BATCH_SIZE) {
      const batch = providers.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(async (p) => {
          try {
            const m3u8 = await extractM3u8(p.url);
            if (m3u8) {
              return { ...p, m3u8 };
            }
            return null;
          } catch {
            return null;
          }
        })
      );
      for (const r of batchResults) {
        if (r.status === 'fulfilled' && r.value) {
          results.push(r.value);
        }
      }
      // Stop early if we found enough working streams
      if (results.length >= 5) break;
    }

    console.log(`[working-streams] ${results.length}/${providers.length} working`);
    res.json(results);
  } catch (err) {
    console.error('[working-streams] Error:', err.message);
    res.status(500).json({ error: 'Failed to find working streams' });
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
