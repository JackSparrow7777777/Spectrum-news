// netlify/functions/news.js
// GNews API Serverless Function for Netlify

const cache = new Map();
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

// ---- AllSides-style buckets (seed list — expand as you like) ----
const BIAS_BUCKETS = {
  'left': [
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
  'center': [
    'apnews.com','reuters.com','bbc.com','bbc.co.uk','csmonitor.com','forbes.com',
    'marketwatch.com','newsweek.com','newsnationnow.com','thehill.com'
  ],
  'lean-right': [
    'thedispatch.com','theepochtimes.com','foxbusiness.com','justthenews.com',
    'nationalreview.com','nypost.com','realclearpolitics.com','washingtonexaminer.com',
    'washingtontimes.com','zerohedge.com','wsj.com'
  ],
  'right': [
    'theamericanconservative.com','spectator.org','theblaze.com','breitbart.com','cbn.com',
    'dailycaller.com','dailymail.co.uk','dailywire.com','foxnews.com','thefederalist.com',
    'ijr.com','newsmax.com','oann.com','thepostmillennial.com','freebeacon.com'
  ]
};

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

const ALLOWED_CATEGORIES = new Set([
  'general','world','nation','business','technology','entertainment','sports','science','health'
]);

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

    if (!ALLOWED_CATEGORIES.has(category)) category = '';

    // Cache key
    const cacheKey = JSON.stringify({ q, lang, country, maxReq, category, expand, from, to, bias: doBiasFilter ? bias : '' });
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      return { statusCode: 200, headers: { ...headers, 'X-Cache': 'HIT' }, body: JSON.stringify(cached.data) };
    }

    // Endpoint + base params (without max/page)
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
    }

    // How many raw items to attempt (over-fetch if bias filter enabled)
    const targetRaw = doBiasFilter
      ? Math.min(100, Math.max(maxReq, Math.ceil(maxReq * 2.5)))
      : maxReq;

    // GNews returns at most ~25 per request; paginate with &page=#
    const PER_PAGE_CAP = 25; // observed cap
    const perPage = Math.min(PER_PAGE_CAP, targetRaw);

    const collected = [];
    const seen = new Set(); // dedupe by URL
    let page = 1;

    while (collected.length < targetRaw && page <= Math.ceil(100 / perPage)) {
      const url = new URL(`https://gnews.io/api/v4/${endpoint}`);
      // copy base params
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

      // Stop if no more data
      if (batch.length === 0) break;

      // Append with de-dupe by absolute URL
      for (const a of batch) {
        const key = a?.url || a?.source?.url || '';
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        collected.push(a);
      }

      // If the API returned less than requested per page, we've likely exhausted results
      if (batch.length < perPage) break;

      page += 1;
    }

    // Normalize + annotate bias
    let articles = collected.map(a => {
      const primaryUrl = a.source?.url || a.url || '';
      const biasDetected = detectBiasByUrl(primaryUrl);
      return {
        title: a.title || 'No title',
        description: a.description || 'No description',
        content: a.content || a.description || 'No content available',
        url: a.url,
        image: a.image,
        publishedAt: a.publishedAt,
        source: { name: a.source?.name || 'Unknown Source', url: a.source?.url || '' },
        bias: biasDetected || '' // '', 'left','lean-left','center','lean-right','right'
      };
    });

    // Bias filter (if any), then trim to user request
    if (doBiasFilter) articles = articles.filter(a => a.bias === bias);
    articles = articles.slice(0, maxReq);

    const payload = {
      totalArticles: articles.length,
      articles,
      fetchedAt: new Date().toISOString(),
      endpoint,
      parameters: { q, lang, country, max: maxReq, category, expand, from, to, bias: doBiasFilter ? bias : 'default' }
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

