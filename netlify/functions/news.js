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
// Fallback score when unknown (keeps slider usable without a giant mapping)
const DEFAULT_RELIABILITY = 50;

function parseHostParts(u) {
  try {
    const hostname = new URL(u).hostname.replace(/^www\./i, '');
    const parts = hostname.split('.');
    const two = parts.slice(-2).join('.');
    const three = parts.slice(-3).join('.');
    const twoLevelTLDs = new Set(['co.uk','com.au','com.br','co.jp','co.kr','co.in','com.sg','com.hk']);
    const registrable = twoLevelTLDs.has(two) ? three : two;
    return { hostname, registrable };
  } catch { return { hostname: '', registrable: '' }; }
}

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

// Very light title normalization for clustering
const STOP = new Set(['the','a','an','to','of','in','on','and','or','as','for','at','by','with','from','about','amid','over','after','before','into','out','up','down']);
function titleKey(s) {
  if (!s) return '';
  const words = s.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !STOP.has(w));
  // pick the first 6 distinct words (order-insensitive key)
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
  if (event.httpMethod !== 'GET')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const qp = event.queryStringParameters || {};

    // ----- Params -----
    const q        = String(qp.q || 'latest news').trim() || 'latest news';
    const lang     = String(qp.lang || 'en');
    const country  = String(qp.country || 'us');
    const maxReq   = Math.max(1, Math.min(parseInt(qp.max || '10', 10) || 10, 100));
    let category   = String(qp.category || qp.topic || '').toLowerCase().trim();
    const expand   = qp.expand === 'content' ? 'content' : 'summary';
    const from     = String(qp.from || '');
    const to       = String(qp.to || '');

    let bias = String(qp.bias || qp.spectrum || '').toLowerCase().trim();
    if (!['left','lean-left','center','lean-right','right','default',''].includes(bias)) bias = '';
    const doBiasFilter = !!bias && bias !== 'default';

    const minReliability = Math.max(0, Math.min(parseInt(qp.minReliability || '0', 10) || 0, 100));
    const balanced = qp.balanced === '1';
    const clusterMode = String(qp.cluster || '').toLowerCase(); // 'title' | ''

    if (!ALLOWED_CATEGORIES.has(category)) category = '';

    // Cache key
    const cacheKey = JSON.stringify({ q, lang, country, maxReq, category, expand, from, to, bias: doBiasFilter ? bias : '', minReliability, balanced, clusterMode });
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      return { statusCode: 200, headers: { ...headers, 'X-Cache': 'HIT', 'Content-Type': 'application/json' }, body: JSON.stringify(cached.data) };
    }

    // Endpoint + immutable base params
    const endpoint = category ? 'top-headlines' : 'search';
    const base = new URLSearchParams();
    base.append('apikey', process.env.GNEWS_API_KEY);
    base.append('lang', lang);
    base.append('expand', expand);
    base.append('q', q);
    if (endpoint === 'search') {
      if (country) base.append('country', country);
      if (from)    base.append('from', from);
      if (to)      base.append('to', to);
    } else {
      base.append('category', category);
      if (country) base.append('country', country);
      // GNews doesn't honor from/to for top-headlines; search does.
    }

    // How many raw items to attempt (over-fetch if we need balanced or bias filtering)
    const needOverFetch = balanced || doBiasFilter;
    const targetRaw = needOverFetch
      ? Math.min(100, Math.max(maxReq, Math.ceil(maxReq * 2.5)))
      : maxReq;

    // GNews returns at most ~25 per request; paginate with &page=#
    const PER_PAGE_CAP = 25;
    const perPage = Math.min(PER_PAGE_CAP, targetRaw);

    const collected = [];
    const seen = new Set(); // de-dupe by url
    let page = 1;

    while (collected.length < targetRaw && page <= Math.ceil(100 / perPage)) {
      const url = new URL(`https://gnews.io/api/v4/${endpoint}`);
      for (const [k, v] of base.entries()) url.searchParams.append(k, v);
      url.searchParams.append('max', String(Math.min(perPage, targetRaw - collected.length)));
      url.searchParams.append('page', String(page));

      console.log('Fetching:', url.toString().replace(process.env.GNEWS_API_KEY, 'HIDDEN'));

      const resp = await fetch(url.toString());
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

    // Normalize + annotate bias & reliability
    let articles = collected.map(a => {
      const primaryUrl = a.source?.url || a.url || '';
      const biasDetected = detectBiasByUrl(primaryUrl);
      const relScore = reliabilityByUrl(primaryUrl);
      return {
        title: a.title || 'No title',
        description: a.description || 'No description',
        content: a.content || a.description || 'No content available',
        url: a.url,
        image: a.image,
        publishedAt: a.publishedAt,
        source: { name: a.source?.name || 'Unknown Source', url: a.source?.url || '' },
        bias: biasDetected || '',                  // '', 'left', 'lean-left', 'center', 'lean-right', 'right'
        reliabilityScore: relScore                 // 0..100 (fallback DEFAULT_RELIABILITY)
      };
    });

    // Reliability filter
    if (minReliability > 0) {
      articles = articles.filter(a => (a.reliabilityScore ?? DEFAULT_RELIABILITY) >= minReliability);
    }

    // Bias filter OR Balanced sampler
    if (doBiasFilter) {
      articles = articles.filter(a => a.bias === bias);
    } else if (balanced) {
      const buckets = ['left','lean-left','center','lean-right','right'];
      const perBucket = Math.ceil(maxReq / buckets.length);
      const picked = [];
      const used = new Set();

      // First pass: take up to perBucket from each bucket
      for (const b of buckets) {
        const list = articles.filter(a => a.bias === b && !used.has(a.url));
        for (const a of list.slice(0, perBucket)) {
          picked.push(a); used.add(a.url);
        }
      }
      // Fill remaining from any bias, newest first
      if (picked.length < maxReq) {
        const rest = articles.filter(a => !used.has(a.url))
          .sort((a, b) => new Date(b.publishedAt||0) - new Date(a.publishedAt||0));
        picked.push(...rest.slice(0, maxReq - picked.length));
      }
      articles = picked;
    }

    // Optional clustering (collapse near-duplicate titles)
    if (clusterMode === 'title') {
      const seenKeys = new Set();
      const clustered = [];
      for (const a of articles) {
        const k = titleKey(a.title);
        if (!seenKeys.has(k)) { seenKeys.add(k); clustered.push(a); }
      }
      articles = clustered;
    }

    // Final trim to request size
    articles = articles.slice(0, maxReq);

    const payload = {
      totalArticles: articles.length,
      articles,
      fetchedAt: new Date().toISOString(),
      endpoint,
      parameters: {
        q, lang, country, max: maxReq, category, expand, from, to,
        bias: doBiasFilter ? bias : (balanced ? 'balanced' : 'default'),
        minReliability,
        cluster: clusterMode || 'off'
      }
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
