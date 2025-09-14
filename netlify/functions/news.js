// netlify/functions/news.js
// GNews API Serverless Function for Netlify

const cache = new Map();
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

// ---- AllSides-style buckets (seed list — expand as you like) ----
const BIAS_BUCKETS = {
  left: [
    'alternet.org','democracynow.org','theguardian.com','huffpost.com','theintercept.com',
    'jacobin.com','motherjones.com','msnbc.com','thenation.com','newyorker.com',
    'thedailybeast.com','slate.com','vox.com','salon.com'
  ],
  'lean-left': [
    'abcnews.go.com','axios.com','bloomberg.com','cbsnews.com','cnbc.com','cnn.com',
    'insider.com','businessinsider.com','nbcnews.com','nytimes.com','npr.org',
    'politico.com','propublica.org','semafor.com','time.com','usatoday.com',
    'washingtonpost.com','news.yahoo.com'
  ],
  center: [
    'apnews.com','reuters.com','bbc.com','bbc.co.uk','csmonitor.com','forbes.com',
    'marketwatch.com','newsweek.com','newsnationnow.com','thehill.com'
  ],
  'lean-right': [
    'thedispatch.com','theepochtimes.com','foxbusiness.com','justthenews.com',
    'nationalreview.com','nypost.com','realclearpolitics.com','washingtonexaminer.com',
    'washingtontimes.com','zerohedge.com','wsj.com'
  ],
  right: [
    'theamericanconservative.com','spectator.org','theblaze.com','breitbart.com','cbn.com',
    'dailycaller.com','dailymail.co.uk','dailywire.com','foxnews.com','thefederalist.com',
    'ijr.com','newsmax.com','oann.com','thepostmillennial.com','freebeacon.com'
  ]
};

// ---- Simple reliability score map (0–100). Seed values; extend as needed. ----
const RELIABILITY_SCORES = {
  'apnews.com': 85, 'reuters.com': 88, 'bbc.com': 80, 'bbc.co.uk': 80,
  'nytimes.com': 78, 'wsj.com': 82, 'washingtonpost.com': 78, 'npr.org': 84,
  'theguardian.com': 75, 'cbsnews.com': 74, 'cnn.com': 70, 'foxnews.com': 60,
  'newsmax.com': 40, 'oann.com': 30, 'breitbart.com': 35, 'dailymail.co.uk': 45,
  'forbes.com': 70, 'marketwatch.com': 72, 'time.com': 70, 'usatoday.com': 72,
  'politico.com': 68, 'nbcnews.com': 70, 'abcnews.go.com': 72, 'wsj.com': 82,
  'thehill.com': 65, 'news.yahoo.com': 68, 'semafor.com': 68
};
const DEFAULT_RELIABILITY = 50;

// Extract hostname & registrable domain (handles co.uk/com.au etc.)
function parseHostParts(u) {
  try {
    const hostname = new URL(u).hostname.replace(/^www\./i, '');
    const parts = hostname.split('.');
    const two = parts.slice(-2).join('.');
    const three = parts.slice(-3).join('.');
    const twoLevelTLDs = new Set(['co.uk','com.au','com.br','co.jp','co.kr','co.in','com.sg','com.hk']);
    const registrable = twoLevelTLDs.has(two) ? three : two;
    return { hostname, registrable };
  } catch {
    return { hostname: '', registrable: '' };
  }
}

// Bias lookup
const DOMAIN_TO_BIAS = (() => {
  const m = new Map();
  for (const [bias, list] of Object.entries(BIAS_BUCKETS)) {
    for (const d of list) m.set(d, bias);
  }
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

const ALLOWED_CATEGORIES = new Set([
  'general','world','nation','business','technology','entertainment','sports','science','health'
]);

// Simple title key for clustering (optional future use)
const STOP = new Set(['the','a','an','to','of','in','on','and','or','as','for','at','by','with','from','about','amid','over','after','before','into','out','up','down']);
function titleKey(s) {
  if (!s) return '';
  const words = s.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !STOP.has(w));
  const uniq = [];
  for (const w of words) { if (!uniq.includes(w)) uniq.push(w); if (uniq.length >= 6) break; }
  return uniq.sort().join('-');
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const qp = event.queryStringParameters || {};

    // ---- Params ----
    const q        = String(qp.q || 'latest news').trim() || 'latest news';
    const lang     = String(qp.lang || 'en');
    const country  = String(qp.country || 'us');
    const maxReq   = Math.max(1, Math.min(parseInt(qp.max || '10', 10) || 10, 100));
    let   category = String(qp.category || qp.topic || '').toLowerCase().trim();
    const expand   = qp.expand === 'content' ? 'content' : 'summary';
    const from     = String(qp.from || ''); // ISO8601 (client sends; we filter locally)
    const to       = String(qp.to || '');   // ISO8601

    let bias = String(qp.bias || qp.spectrum || '').toLowerCase().trim();
    if (!['left','lean-left','center','lean-right','right','default',''].includes(bias)) bias = '';
    const doBiasFilter = !!bias && bias !== 'default';

    const minReliability = Math.max(0, Math.min(parseInt(qp.minReliability || '0', 10) || 0, 100));

    if (!ALLOWED_CATEGORIES.has(category)) category = '';

    // Cache key includes normalized params
    const cacheKey = JSON.stringify({ q, lang, country, maxReq, category, expand, from, to, bias: doBiasFilter ? bias : '', minReliability });
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      return { statusCode: 200, headers: { ...headers, 'X-Cache': 'HIT', 'Content-Type': 'application/json' }, body: JSON.stringify(cached.data) };
    }

    // Choose endpoint
    const endpoint = category ? 'top-headlines' : 'search';

    // Build base GNews params — NOTE: we DO NOT send from/to (plan-safe)
    const base = new URLSearchParams();
    base.append('apikey', process.env.GNEWS_API_KEY);
    base.append('lang', lang);
    base.append('expand', expand);
    base.append('q', q);
    if (endpoint === 'search') {
      if (country) base.append('country', country);
    } else {
      base.append('topic', category); // GNews v4 uses "topic" for headlines
      if (country) base.append('country', country);
    }

    // Over-fetch a bit when we need to filter locally (time/bias/reliability)
    const timeFiltering = !!(from || to);
    const needOverFetch = timeFiltering || doBiasFilter || (minReliability > 0);
    const targetRaw = needOverFetch
      ? Math.min(100, Math.max(maxReq, Math.ceil(maxReq * 1.5))) // reduced from 2.5x to save quota
      : maxReq;

    const PER_PAGE_CAP = 25;
    const perPage = Math.min(PER_PAGE_CAP, targetRaw);

    const collected = [];
    const seen = new Set();
    let page = 1;

    while (collected.length < targetRaw && page <= Math.ceil(100 / perPage)) {
      const url = new URL(`https://gnews.io/api/v4/${endpoint}`);
      for (const [k, v] of base.entries()) url.searchParams.append(k, v);
      url.searchParams.append('max', String(Math.min(perPage, targetRaw - collected.length)));
      url.searchParams.append('page', String(page));

      const resp = await fetch(url.toString());

      // --- Graceful handling when daily quota is exceeded ---
      if (resp.status === 403) {
        const fallback = cached?.data || {
          totalArticles: 0,
          articles: [],
          fetchedAt: new Date().toISOString(),
          endpoint,
          parameters: { q, lang, country, max: maxReq, category, expand, from, to, bias: doBiasFilter ? bias : 'default', minReliability }
        };
        return {
          statusCode: 200,
          headers: { ...headers, 'X-Cache': cached ? 'STALE' : 'MISS', 'X-Quota-Exceeded': '1', 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...fallback, quotaExceeded: true })
        };
      }

      if (!resp.ok) {
        const txt = await resp.text();
        return { statusCode: resp.status, headers, body: JSON.stringify({ error: 'Failed to fetch news', status: resp.status, message: txt }) };
      }

      const json = await resp.json();
      const batch = Array.isArray(json.articles) ? json.articles : [];
      if (batch.length === 0) break;

      for (const a of batch) {
        const key = a?.url || a?.source?.url || '';
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        collected.push(a);
      }

      if (batch.length < perPage) break;
      page += 1;
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

    // Time filter (server-side)
    if (from || to) {
      const fromT = from ? Date.parse(from) : Number.NEGATIVE_INFINITY;
      const toT   = to   ? Date.parse(to)   : Number.POSITIVE_INFINITY;
      articles = articles.filter(a => {
        const t = Date.parse(a.publishedAt || '');
        return isNaN(t) ? true : (t >= fromT && t <= toT);
      });
    }

    // Reliability floor
    if (minReliability > 0) {
      articles = articles.filter(a => (a.reliabilityScore ?? DEFAULT_RELIABILITY) >= minReliability);
    }

    // Bias filter (if selected)
    if (doBiasFilter) {
      articles = articles.filter(a => a.bias === bias);
    }

    // Final trim
    articles = articles.slice(0, maxReq);

    const payload = {
      totalArticles: articles.length,
      articles,
      fetchedAt: new Date().toISOString(),
      endpoint,
      parameters: { q, lang, country, max: maxReq, category, expand, from, to, bias: doBiasFilter ? bias : 'default', minReliability }
    };

    cache.set(cacheKey, { data: payload, timestamp: Date.now() });
    if (cache.size > 100) cache.delete(cache.keys().next().value);

    return {
      statusCode: 200,
      headers: { ...headers, 'X-Cache': 'MISS', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    };

  } catch (err) {
    console.error('Function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error', message: err.message, timestamp: new Date().toISOString() }) };
  }
};
