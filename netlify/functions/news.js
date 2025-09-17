// netlify/functions/news.js
// GNews API Serverless Function for Netlify (parallel pagination + plan-cap detection)

const cache = new Map();
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes
const API_BASE = 'https://gnews.io/api/v4';

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

// Title key for clustering
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
    'Content-Type': 'application/json; charset=utf-8',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const API_KEY = process.env.GNEWS_API_KEY || '';
  if (!API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing GNEWS_API_KEY env var' }) };
  }

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
    const cacheKey = JSON.stringify({
      q, lang, country, maxReq, category, expand, from, to,
      bias: doBiasFilter ? bias : '', minReliability, balanced, clusterMode
    });
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      return {
        statusCode: 200,
        headers: { ...headers, 'X-Cache': 'HIT', 'X-Key-Suffix': maskKey(API_KEY) },
        body: JSON.stringify(cached.data)
      };
    }

    // Endpoint
    const endpoint = category ? 'top-headlines' : 'search';

    // Build base params
    const base = new URLSearchParams();
    base.append('apikey', API_KEY);
    base.append('lang', lang);
    base.append('expand', expand);
    base.append('q', q);
    if (endpoint === 'search') {
      if (country) base.append('country', country);
    } else {
      base.append('topic', category);
      if (country) base.append('country', country);
    }

    // Over-fetch when we need local post-filtering
    const timeFiltering = !!(from || to);
    const needOverFetch = timeFiltering || doBiasFilter || (minReliability > 0) || balanced || (clusterMode === 'title');

    // Essential: 25 per page cap; detect effectivePerPage dynamically from first page
    const PER_PAGE_CAP = 25;
    const targetRaw = needOverFetch
      ? Math.min(100, Math.max(maxReq, Math.ceil(maxReq * 1.5)))
      : maxReq;

    // ---- Core fetching helpers ----
    const collected = [];
    const seen = new Set();
    let totalFromAPI = undefined;
    let effectivePerPage = null;

    const fetchPage = async (pageNo, perPageAsk) => {
      const url = new URL(`${API_BASE}/${endpoint}`);
      for (const [k, v] of base.entries()) url.searchParams.append(k, v);
      url.searchParams.append('max', String(perPageAsk));
      url.searchParams.append('page', String(pageNo));
      const resp = await fetch(url.toString());
      if (resp.status === 403) throw new Error('403 quota/plan restriction from GNews');
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`GNews ${resp.status} ${resp.statusText} ${txt}`.trim());
      }
      return resp.json();
    };

    function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
    async function fetchPageWithRetry(pageNo, perPageAsk, tries = 2){
      try {
        return await fetchPage(pageNo, perPageAsk);
      } catch (e) {
        if (tries > 1) { await sleep(250); return fetchPageWithRetry(pageNo, perPageAsk, tries - 1); }
        throw e;
      }
    }

    // ---- Page 1 (learn effectivePerPage) ----
    const first = await fetchPage(1, Math.min(PER_PAGE_CAP, targetRaw));
    const firstBatch = Array.isArray(first.articles) ? first.articles : [];
    totalFromAPI = typeof first.totalArticles === 'number' ? first.totalArticles : undefined;
    effectivePerPage = Math.max(0, firstBatch.length); // 25 on Essential, 10 on Free, etc.

    for (const a of firstBatch) {
      const key = a?.url || a?.source?.url || '';
      if (key && !seen.has(key)) { seen.add(key); collected.push(a); }
    }

    // Early return if nothing
    if (collected.length === 0) {
      const payloadEmpty = basePayload({
        articles: [],
        endpoint, q, lang, country, maxReq, category, expand, from, to,
        bias: doBiasFilter ? bias : (balanced ? 'balanced' : 'default'),
        doBiasFilter, minReliability, balanced, clusterMode,
        totalFromAPI, effectivePerPage,
        planLimited: null
      });
      cache.set(cacheKey, { data: payloadEmpty, timestamp: Date.now() });
      return {
        statusCode: 200,
        headers: {
          ...headers, 'X-Cache': 'MISS', 'X-Key-Suffix': maskKey(API_KEY),
          'X-Requested': String(maxReq), 'X-Delivered': '0',
          'X-Effective-PerPage': String(effectivePerPage || 0)
        },
        body: JSON.stringify(payloadEmpty)
      };
    }

    // ---- Remaining pages IN PARALLEL ----
    const perEff = Math.max(1, effectivePerPage);
    const totalTarget = totalFromAPI ? Math.min(targetRaw, totalFromAPI) : targetRaw;
    const pagesNeeded = Math.ceil(totalTarget / perEff);

    const remainingPages = [];
    for (let p = 2; p <= pagesNeeded; p++) remainingPages.push(p);

    // Respect Essential RPS: after the first request, 3 parallel is safe for 100 target
    const perPageAsk = Math.min(PER_PAGE_CAP, targetRaw);

    const results = await Promise.all(
      remainingPages.map(p => fetchPageWithRetry(p, perPageAsk))
    );

    // Merge in page order (Promise.all preserves input order)
    for (const nxt of results) {
      const batch = Array.isArray(nxt?.articles) ? nxt.articles : [];
      if (!batch.length) continue;
      for (const a of batch) {
        const key = a?.url || a?.source?.url || '';
        if (key && !seen.has(key)) { seen.add(key); collected.push(a); }
        if (collected.length >= targetRaw) break;
      }
      if (collected.length >= targetRaw) break;
    }

    // ---- Normalize + annotate ----
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

    // Time filter
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

    // Cluster by title (keeps first of each cluster)
    if (clusterMode === 'title') {
      const seenKeys = new Set();
      const clustered = [];
      for (const a of articles) {
        const k = titleKey(a.title);
        if (!seenKeys.has(k)) { seenKeys.add(k); clustered.push(a); }
      }
      articles = clustered;
    }

    // Bias filter or balanced sampler
    if (doBiasFilter) {
      articles = articles.filter(a => a.bias === bias);
    } else if (balanced) {
      const buckets = ['left','lean-left','center','lean-right','right'];
      const perBucket = Math.ceil(maxReq / buckets.length);
      const picked = [];
      const used = new Set();

      for (const b of buckets) {
        const list = articles.filter(a => a.bias === b && !used.has(a.url));
        for (const a of list.slice(0, perBucket)) { picked.push(a); used.add(a.url); }
      }
      if (picked.length < maxReq) {
        const rest = articles.filter(a => !used.has(a.url))
          .sort((a, b) => new Date(b.publishedAt||0) - new Date(a.publishedAt||0));
        picked.push(...rest.slice(0, maxReq - picked.length));
      }
      articles = picked;
    }

    // Final trim to UI request
    articles = articles.slice(0, maxReq);

    // Detect plan/page cap
    const planLimited = effectivePerPage > 0 && effectivePerPage < PER_PAGE_CAP ? effectivePerPage : null;

    const payload = basePayload({
      articles,
      endpoint, q, lang, country, maxReq, category, expand, from, to,
      bias: doBiasFilter ? bias : (balanced ? 'balanced' : 'default'),
      doBiasFilter, minReliability, balanced, clusterMode,
      totalFromAPI, effectivePerPage,
      planLimited
    });

    cache.set(cacheKey, { data: payload, timestamp: Date.now() });
    if (cache.size > 100) cache.delete(cache.keys().next().value);

    return {
      statusCode: 200,
      headers: {
        ...headers,
        'X-Cache': 'MISS',
        'X-Key-Suffix': maskKey(API_KEY),
        'X-Requested': String(maxReq),
        'X-Delivered': String(articles.length),
        'X-Effective-PerPage': String(effectivePerPage || 0)
      },
      body: JSON.stringify(payload)
    };
  } catch (err) {
    const body = JSON.stringify({ error: 'Internal server error', message: err.message, timestamp: new Date().toISOString() });
    return { statusCode: 500, headers, body };
  }
};

// ---- helpers ----
function maskKey(k) {
  if (!k) return 'none';
  return `...${String(k).slice(-4)}`;
}

function basePayload ({
  articles, endpoint, q, lang, country, maxReq, category, expand, from, to,
  bias, doBiasFilter, minReliability, balanced, clusterMode,
  totalFromAPI, effectivePerPage, planLimited
}) {
  return {
    totalArticles: articles.length,
    articles,
    fetchedAt: new Date().toISOString(),
    endpoint,
    parameters: {
      q, lang, country, max: maxReq, category, expand, from, to,
      bias, minReliability, cluster: clusterMode || 'off', balanced: !!balanced
    },
    debug: {
      totalFromAPI: typeof totalFromAPI === 'number' ? totalFromAPI : null,
      effectivePerPage: effectivePerPage ?? null,
      planLimited
    }
  };
}


