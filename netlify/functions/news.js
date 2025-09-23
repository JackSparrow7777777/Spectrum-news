'use strict';

/**
 * GNews API Serverless Function (balanced-view v2)
 * - Bias-aware overfetch (3× when balanced)
 * - Supplemental topic pulls (top-headlines) to widen the pool
 * - Strict 5-bucket sampler (Left, CL, Center, CR, Right) with adjacent backfill
 * - Expanded domain maps for Right/Lean-Right
 */

const cache = new Map();
const CACHE_DURATION = 30 * 60 * 1000;
const API_BASE = 'https://gnews.io/api/v4';
const PER_REQ_CAP = 25; // Essential plan per-call cap

// ---- Bias buckets (expanded) ----
const BIAS_BUCKETS = {
  left: [
    'alternet.org','democracynow.org','theguardian.com','huffpost.com','theintercept.com',
    'jacobin.com','motherjones.com','msnbc.com','thenation.com','newyorker.com',
    'thedailybeast.com','slate.com','vox.com','salon.com','bostonglobe.com','rollingstone.com'
  ],
  'lean-left': [
    'abcnews.go.com','axios.com','bloomberg.com','cbsnews.com','cnbc.com','cnn.com',
    'insider.com','businessinsider.com','nbcnews.com','nytimes.com','npr.org',
    'politico.com','propublica.org','semafor.com','time.com','usatoday.com',
    'washingtonpost.com','news.yahoo.com','variety.com','al-monitor.com'
  ],
  center: [
    'apnews.com','reuters.com','bbc.com','bbc.co.uk','csmonitor.com','forbes.com',
    'marketwatch.com','newsweek.com','newsnationnow.com','thehill.com','upi.com',
    'foreignpolicy.com','fortune.com','economist.com','statista.com'
  ],
  'lean-right': [
    'thedispatch.com','theepochtimes.com','foxbusiness.com','justthenews.com',
    'nationalreview.com','nypost.com','realclearpolitics.com','washingtonexaminer.com',
    'washingtontimes.com','zerohedge.com','wsj.com','telegraph.co.uk','spectator.co.uk','nysun.com'
  ],
  right: [
    'theamericanconservative.com','spectator.org','theblaze.com','breitbart.com','cbn.com',
    'dailycaller.com','dailymail.co.uk','dailywire.com','foxnews.com','thefederalist.com',
    'ijr.com','newsmax.com','oann.com','thepostmillennial.com','freebeacon.com',
    'redstate.com','westernjournal.com','pjmedia.com','hotair.com','townhall.com'
  ]
};

// ---- Reliability seeds (extend as needed) ----
const RELIABILITY_SCORES = {
  'apnews.com': 85, 'reuters.com': 88, 'bbc.com': 80, 'bbc.co.uk': 80,
  'nytimes.com': 78, 'wsj.com': 82, 'washingtonpost.com': 78, 'npr.org': 84,
  'theguardian.com': 75, 'cbsnews.com': 74, 'cnn.com': 70, 'foxnews.com': 60,
  'newsmax.com': 40, 'oann.com': 30, 'breitbart.com': 35, 'dailymail.co.uk': 45,
  'forbes.com': 70, 'marketwatch.com': 72, 'time.com': 70, 'usatoday.com': 72,
  'politico.com': 68, 'nbcnews.com': 70, 'abcnews.go.com': 72,
  'thehill.com': 65, 'news.yahoo.com': 68, 'semafor.com': 68,
  'nationalreview.com': 65, 'nypost.com': 55, 'realclearpolitics.com': 60,
  'washingtonexaminer.com': 60, 'washingtontimes.com': 55, 'telegraph.co.uk': 70,
  'spectator.co.uk': 55, 'nysun.com': 60, 'dailywire.com': 45, 'freebeacon.com': 55
};
const DEFAULT_RELIABILITY = 50;

const ALLOWED_CATEGORIES = new Set([
  'general','world','nation','business','technology','entertainment','sports','science','health'
]);

// Small stoplist for clustering key
const STOP = new Set(['the','a','an','to','of','in','on','and','or','as','for','at','by','with','from','about','amid','over','after','before','into','out','up','down']);

// ---------- helpers ----------
function parseHostParts(u) {
  try {
    const hostname = new URL(u).hostname.replace(/^www\./i, '');
    const parts = hostname.split('.');
    const two = parts.slice(-2).join('.');
    const three = parts.slice(-3).join('.');
    const sld = new Set(['co.uk','com.au','com.br','co.jp','co.kr','co.in','com.sg','com.hk']);
    const registrable = sld.has(two) ? three : two;
    return { hostname, registrable };
  } catch { return { hostname: '', registrable: '' }; }
}
const DOMAIN_TO_BIAS = (() => {
  const m = new Map();
  for (const [k, arr] of Object.entries(BIAS_BUCKETS)) for (const d of arr) m.set(d, k);
  return m;
})();
function detectBiasByUrl(url) {
  const { hostname, registrable } = parseHostParts(url || '');
  if (!hostname) return '';
  if (DOMAIN_TO_BIAS.has(hostname)) return DOMAIN_TO_BIAS.get(hostname);
  if (DOMAIN_TO_BIAS.has(registrable)) return DOMAIN_TO_BIAS.get(registrable);
  return '';
}
function reliabilityByUrl(url) {
  const { hostname, registrable } = parseHostParts(url || '');
  if (!hostname) return DEFAULT_RELIABILITY;
  if (RELIABILITY_SCORES[hostname] != null) return RELIABILITY_SCORES[hostname];
  if (RELIABILITY_SCORES[registrable] != null) return RELIABILITY_SCORES[registrable];
  return DEFAULT_RELIABILITY;
}
function titleKey(s) {
  if (!s) return '';
  const words = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w));
  const uniq = [];
  for (const w of words) { if (!uniq.includes(w)) uniq.push(w); if (uniq.length >= 6) break; }
  return uniq.sort().join('-');
}
const BUCKETS = ['left','lean-left','center','lean-right','right'];
const ADJACENT = {
  left: ['lean-left','center','lean-right','right'],
  'lean-left': ['left','center','lean-right','right'],
  center: ['lean-left','lean-right','left','right'],
  'lean-right': ['right','center','lean-left','left'],
  right: ['lean-right','center','lean-left','left']
};

// ---------- Netlify handler ----------
exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const API_KEY = process.env.GNEWS_API_KEY || '';
  if (!API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing GNEWS_API_KEY env var' }) };

  try {
    // ---- Params ----
    const qp = event.queryStringParameters || {};
    const q        = String(qp.q || 'latest news').trim() || 'latest news';
    const lang     = String(qp.lang || 'en');
    const country  = String(qp.country || 'us');
    const maxReq   = Math.max(1, Math.min(parseInt(qp.max || '10', 10) || 10, 100));
    let category   = String(qp.category || qp.topic || '').toLowerCase().trim();
    const expand   = qp.expand === 'content' ? 'content' : 'summary';
    const from     = String(qp.from || '');
    const to       = String(qp.to || '');
    let bias       = String(qp.bias || qp.spectrum || '').toLowerCase().trim();
    if (!['left','lean-left','center','lean-right','right','default',''].includes(bias)) bias = '';
    const doBiasFilter = !!bias && bias !== 'default';
    const minReliability = Math.max(0, Math.min(parseInt(qp.minReliability || '0', 10) || 0, 100));
    const balanced = qp.balanced === '1';
    const clusterMode = String(qp.cluster || '').toLowerCase(); // 'title' or ''

    if (!ALLOWED_CATEGORIES.has(category)) category = '';

    // ---- Cache key ----
    const cacheKey = JSON.stringify({
      q, lang, country, maxReq, category, expand, from, to,
      bias: doBiasFilter ? bias : '', minReliability, balanced, clusterMode
    });
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      return { statusCode: 200, headers: { ...headers, 'X-Cache': 'HIT' }, body: JSON.stringify(cached.data) };
    }

    // ---- Fetch helpers ----
    const endpointFor = (cat) => (cat ? 'top-headlines' : 'search');
    const baseParams = (cat) => {
      const s = new URLSearchParams();
      s.append('apikey', API_KEY);
      s.append('lang', lang);
      s.append('expand', expand);
      if (cat) { s.append('topic', cat); if (country) s.append('country', country); }
      else { s.append('q', q); if (country) s.append('country', country); }
      return s;
    };

    async function callGNews(url) {
      const resp = await fetch(url);
      if (resp.status === 403) throw new Error('403 quota/plan restriction from GNews');
      if (!resp.ok) {
        const txt = await resp.text().catch(()=> '');
        throw new Error(`GNews ${resp.status} ${resp.statusText} ${txt}`.trim());
      }
      return resp.json();
    }

    async function fetchPaged(cat, pages, perPage) {
      const endpoint = endpointFor(cat);
      const tasks = [];
      for (let p = 1; p <= pages; p++) {
        const u = new URL(`${API_BASE}/${endpoint}`);
        const b = baseParams(cat);
        for (const [k,v] of b.entries()) u.searchParams.append(k, v);
        u.searchParams.append('max', String(perPage));
        u.searchParams.append('page', String(p));
        tasks.push(callGNews(u.toString()).catch(()=>({ articles: [] })));
      }
      const results = await Promise.all(tasks);
      return results.flatMap(r => Array.isArray(r.articles) ? r.articles : []);
    }

    // ---- Strategy ----
    // 1) Primary pull based on user's selection (search or topic)
    // 2) If balanced ON, widen the pool with supplemental top-headlines across multiple topics
    //    so Right/Lean-Right buckets have enough candidates.
    const overFetchFactor = balanced ? 3 : (doBiasFilter || minReliability > 0 || clusterMode === 'title' ? 1.5 : 1);
    const rawTarget = Math.min(100, Math.max(maxReq, Math.ceil(maxReq * overFetchFactor)));

    // First page to detect effective per-page
    async function firstPage(cat) {
      const endpoint = endpointFor(cat);
      const u = new URL(`${API_BASE}/${endpoint}`);
      const b = baseParams(cat);
      for (const [k,v] of b.entries()) u.searchParams.append(k, v);
      u.searchParams.append('max', String(Math.min(PER_REQ_CAP, rawTarget)));
      u.searchParams.append('page', '1');
      const r = await callGNews(u.toString());
      const arr = Array.isArray(r.articles) ? r.articles : [];
      const effectivePerPage = arr.length;
      const totalArticlesAPI = typeof r.totalArticles === 'number' ? r.totalArticles : undefined;
      return { arr, effectivePerPage, totalArticlesAPI };
    }

    const { arr: firstArr, effectivePerPage } = await firstPage(category);
    const perPage = Math.max(1, effectivePerPage || 10);
    const pagesNeeded = Math.ceil(rawTarget / perPage);
    const primaryPool = firstArr.concat(
      await fetchPaged(category, Math.max(0, pagesNeeded - 1), Math.min(PER_REQ_CAP, rawTarget))
    );

    // Supplemental pool when balanced ON
    let supplementalPool = [];
    if (balanced) {
      const topics = category ? [category] : ['general','world','business','technology','science','health','entertainment'];
      // Pull at most 3 topics to respect quota; rotate by day for variety
      const seed = new Date().getUTCDate() % topics.length;
      const pick = [];
      for (let i = 0; i < Math.min(3, topics.length); i++) pick.push(topics[(seed + i) % topics.length]);
      const supPages = 2;            // up to 2 pages each
      const supPerPage = Math.min(PER_REQ_CAP, 20);
      const tasks = pick.map(t => fetchPaged(t, supPages, supPerPage));
      const results = await Promise.all(tasks);
      supplementalPool = results.flat();
    }

    // Merge & dedupe
    const seen = new Set();
    const collected = [];
    for (const a of [...primaryPool, ...supplementalPool]) {
      const key = a?.url || a?.source?.url || a?.title || '';
      if (key && !seen.has(key)) { seen.add(key); collected.push(a); }
      if (collected.length >= 400) break; // hard cap
    }

    // Normalize + annotate
    let articles = collected.map(a => {
      const primaryUrl = a.source?.url || a.url || '';
      return {
        title: a.title || 'No title',
        description: a.description || 'No description',
        content: a.content || a.description || 'No content available',
        url: a.url,
        image: a.image,
        publishedAt: a.publishedAt,
        source: { name: a.source?.name || 'Unknown Source', url: a.source?.url || '' },
        bias: detectBiasByUrl(primaryUrl) || '',
        reliabilityScore: reliabilityByUrl(primaryUrl)
      };
    });

    // Time window
    if (from || to) {
      const fromT = from ? Date.parse(from) : Number.NEGATIVE_INFINITY;
      const toT   = to   ? Date.parse(to)   : Number.POSITIVE_INFINITY;
      articles = articles.filter(a => {
        const t = Date.parse(a.publishedAt || '');
        return isNaN(t) ? true : (t >= fromT && t <= toT);
      });
    }

    // Reliability
    if (minReliability > 0) {
      articles = articles.filter(a => (a.reliabilityScore ?? DEFAULT_RELIABILITY) >= minReliability);
    }

    // Cluster similar titles
    if (clusterMode === 'title') {
      const seenKeys = new Set();
      const out = [];
      for (const a of articles) {
        const k = titleKey(a.title);
        if (!seenKeys.has(k)) { seenKeys.add(k); out.push(a); }
      }
      articles = out;
    }

    // Bias filter OR Balanced mix
    if (doBiasFilter) {
      articles = articles.filter(a => a.bias === bias);
    } else if (balanced) {
      articles = balancedSampler(articles, maxReq);
    }

    // Final trim + payload
    articles = articles.slice(0, maxReq);

    const payload = basePayload({
      articles,
      endpoint: endpointFor(category),
      q, lang, country, maxReq, category, expand, from, to,
      bias: doBiasFilter ? bias : (balanced ? 'balanced' : 'default'),
      doBiasFilter, minReliability, balanced, clusterMode
    });

    cache.set(cacheKey, { data: payload, timestamp: Date.now() });
    if (cache.size > 120) cache.delete(cache.keys().next().value);

    return {
      statusCode: 200,
      headers: { ...headers, 'X-Cache': 'MISS' },
      body: JSON.stringify(payload)
    };

  } catch (err) {
    const body = JSON.stringify({ error: 'Internal server error', message: err.message, timestamp: new Date().toISOString() });
    return { statusCode: 500, headers, body };
  }
};

// ---------- balanced sampler ----------
function balancedSampler(pool, maxReq) {
  // Split pool by bias
  const bins = Object.fromEntries(BUCKETS.map(b => [b, []]));
  const unknown = [];
  for (const a of pool) {
    if (BUCKETS.includes(a.bias)) bins[a.bias].push(a);
    else unknown.push(a);
  }
  // Sort each bin by recency
  for (const b of BUCKETS) bins[b].sort((x,y) => new Date(y.publishedAt||0) - new Date(x.publishedAt||0));
  unknown.sort((x,y) => new Date(y.publishedAt||0) - new Date(x.publishedAt||0));

  const perBucket = Math.ceil(maxReq / BUCKETS.length);
  const picked = [];
  const used = new Set();

  // Strict take
  for (const b of BUCKETS) {
    for (const a of bins[b]) {
      if (used.has(a.url)) continue;
      picked.push(a); used.add(a.url);
      if (countBias(picked, b) >= perBucket) break;
    }
  }

  // Backfill deficits with adjacent buckets first
  for (const b of BUCKETS) {
    while (countBias(picked, b) < perBucket) {
      let filled = false;
      for (const adj of ADJACENT[b]) {
        const next = bins[adj].find(x => !used.has(x.url));
        if (next) { picked.push(next); used.add(next.url); filled = true; break; }
      }
      if (!filled) break; // nothing left
    }
  }

  // Still short? Use unknowns, then any remainder by recency
  if (picked.length < maxReq) {
    for (const a of unknown) {
      if (used.has(a.url)) continue;
      picked.push(a); used.add(a.url);
      if (picked.length >= maxReq) break;
    }
  }
  if (picked.length < maxReq) {
    const rest = pool.filter(a => !used.has(a.url))
      .sort((x,y) => new Date(y.publishedAt||0) - new Date(x.publishedAt||0));
    for (const a of rest) {
      picked.push(a); if (picked.length >= maxReq) break;
    }
  }

  // Final: interleave by bucket to avoid long same-bias runs
  const queues = BUCKETS.map(b => picked.filter(a => a.bias === b));
  const misc = picked.filter(a => !BUCKETS.includes(a.bias));
  const out = [];
  let i = 0;
  while (out.length < Math.min(maxReq, picked.length)) {
    const q = queues[i % queues.length];
    if (q && q.length) out.push(q.shift());
    else if (misc.length) out.push(misc.shift());
    i++;
    if (i > maxReq * 5) break; // safety
  }
  return out.slice(0, maxReq);
}
function countBias(arr, b) { return arr.reduce((n,a)=> n + (a.bias===b), 0); }

// ---------- payload ----------
function basePayload ({
  articles, endpoint, q, lang, country, maxReq, category, expand, from, to,
  bias, doBiasFilter, minReliability, balanced, clusterMode
}) {
  return {
    totalArticles: articles.length,
    articles,
    fetchedAt: new Date().toISOString(),
    endpoint,
    parameters: { q, lang, country, max: maxReq, category, expand, from, to,
      bias, minReliability, cluster: clusterMode || 'off', balanced: !!balanced
    }
  };
}


