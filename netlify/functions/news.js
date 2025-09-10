// netlify/functions/news.js
// GNews API Serverless Function for Netlify with bias + reliability tier support

const cache = new Map();
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

// --- simple helpers ---
const getHostname = (url) => {
  try { return new URL(url).hostname.replace(/^www\./,''); } catch { return ''; }
};
const norm = (s='') => s.toLowerCase().trim();

// ===== AllSides-style SOURCE -> BIAS bucket (very small seed list; extend as you like) =====
const biasByDomain = new Map([
  // LEFT
  ['alternet.org','left'],['slate.com','left'],['thenation.com','left'],
  // LEAN LEFT
  ['nytimes.com','lean-left'],['washingtonpost.com','lean-left'],['cnn.com','lean-left'],
  ['nbcnews.com','lean-left'],['cbsnews.com','lean-left'],['axios.com','lean-left'],
  ['bloomberg.com','lean-left'],['theguardian.com','lean-left'],['huffpost.com','lean-left'],
  // CENTER
  ['apnews.com','center'],['reuters.com','center'],['bbc.com','center'],['marketwatch.com','center'],
  ['wsj.com','center'], // treat WSJ news as center
  // LEAN RIGHT
  ['foxbusiness.com','lean-right'],['nationalreview.com','lean-right'],['thedispatch.com','lean-right'],
  ['washingtonexaminer.com','lean-right'],['nypost.com','right'], // AllSides rates NY Post: Right
  // RIGHT
  ['breitbart.com','right'],['dailywire.com','right'],['newsmax.com','right'],['theblaze.com','right'],
  ['dailysignal.com','right'],['dailycaller.com','right']
]);

// ===== Reliability tier map (example seed) =====
const tierByDomain = new Map([
  // Legacy (long-established)
  ['nytimes.com','legacy'],['washingtonpost.com','legacy'],['wsj.com','legacy'],
  ['apnews.com','legacy'],['reuters.com','legacy'],['bbc.com','legacy'],
  ['abcnews.go.com','legacy'],['cbsnews.com','legacy'],['cnn.com','legacy'],['nbcnews.com','legacy'],
  ['theguardian.com','legacy'],['npr.org','legacy'],

  // Less-legacy (digital-native or newer brands)
  ['vox.com','less-legacy'],['axios.com','less-legacy'],['semafor.com','less-legacy'],
  ['buzzfeednews.com','less-legacy'],['insider.com','less-legacy'],['huffpost.com','less-legacy'],
  ['theintercept.com','less-legacy'],['breitbart.com','less-legacy'],['dailywire.com','less-legacy'],
  ['vice.com','less-legacy']
]);

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const qp = event.queryStringParameters || {};
    const {
      q = 'latest news',
      lang = 'en',
      country = 'us',
      max = '10',
      category = '',
      expand = 'content',
      from = '',
      to = '',
      bias = '',            // 'left' | 'lean-left' | 'center' | 'lean-right' | 'right'
      tier = 'any'          // 'less-legacy' | 'unidentified' | 'legacy' | 'any'
    } = qp;

    const cacheKey = JSON.stringify({ q, lang, country, max, category, expand, from, to, bias, tier });
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.timestamp < CACHE_DURATION) {
      return { statusCode: 200, headers: { ...headers, 'X-Cache': 'HIT' }, body: JSON.stringify(hit.data) };
    }

    // choose endpoint
    const endpoint = category ? 'top-headlines' : 'search';
    const apiUrl = new URL(`https://gnews.io/api/v4/${endpoint}`);
    apiUrl.searchParams.append('apikey', process.env.GNEWS_API_KEY);
    apiUrl.searchParams.append('lang', lang);
    apiUrl.searchParams.append('max', max);
    apiUrl.searchParams.append('expand', expand);

    if (endpoint === 'search') {
      apiUrl.searchParams.append('q', q);
      if (country) apiUrl.searchParams.append('country', country);
      if (from) apiUrl.searchParams.append('from', from);
      if (to) apiUrl.searchParams.append('to', to);
    } else {
      apiUrl.searchParams.append('category', category);
      if (country) apiUrl.searchParams.append('country', country);
    }

    const response = await fetch(apiUrl.toString());
    if (!response.ok) {
      const text = await response.text();
      return { statusCode: response.status, headers, body: JSON.stringify({ error: 'Failed to fetch news', status: response.status, message: text }) };
    }
    const raw = await response.json();
    if (!raw.articles || !Array.isArray(raw.articles)) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Invalid response from news API', received: raw }) };
    }

    // decorate with bias + tier
    let articles = raw.articles.map(a => {
      const hostname = getHostname(a.url);
      const biasBucket = biasByDomain.get(hostname) || '';
      const tierBucket = tierByDomain.get(hostname) || 'unidentified';

      return {
        title: a.title || 'No title',
        description: a.description || 'No description',
        content: a.content || a.description || 'No content available',
        url: a.url,
        image: a.image,
        publishedAt: a.publishedAt,
        source: {
          name: a.source?.name || 'Unknown Source',
          url: a.source?.url || '',
          domain: hostname
        },
        bias: biasBucket,          // '', 'left','lean-left','center','lean-right','right'
        tier: tierBucket           // 'legacy' | 'less-legacy' | 'unidentified'
      };
    });

    // optional filtering
    const wantBias = norm(bias);
    if (wantBias && ['left','lean-left','center','lean-right','right'].includes(wantBias)) {
      articles = articles.filter(a => a.bias === wantBias);
    }
    const wantTier = norm(tier);
    if (wantTier && wantTier !== 'any') {
      articles = articles.filter(a => a.tier === wantTier);
    }

    const processed = {
      totalArticles: articles.length,
      articles,
      fetchedAt: new Date().toISOString(),
      endpoint,
      parameters: { q, lang, country, max, category, expand, from, to, bias: wantBias || 'default', tier: wantTier || 'any' }
    };

    cache.set(cacheKey, { data: processed, timestamp: Date.now() });
    if (cache.size > 100) cache.delete(cache.keys().next().value);

    return { statusCode: 200, headers: { ...headers, 'X-Cache': 'MISS', 'Content-Type': 'application/json' }, body: JSON.stringify(processed) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error', message: err.message, timestamp: new Date().toISOString() }) };
  }
};

