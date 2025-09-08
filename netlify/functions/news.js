const cache = new Map();
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const API_KEY = process.env.GNEWS_API_KEY;
    if (!API_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing GNEWS_API_KEY' }) };
    }

    const qp = event.queryStringParameters || {};

    // Detect if the user actually provided q (Search requires q) :contentReference[oaicite:1]{index=1}
    const hasUserQuery = Object.prototype.hasOwnProperty.call(qp, 'q') && qp.q && qp.q.trim() !== '';
    const hasCategory = qp.category && qp.category.trim() !== '';

    // Prefer top-headlines when there's no explicit q, otherwise use search
    const endpoint = hasCategory || !hasUserQuery ? 'top-headlines' : 'search';

    // Build query
    const params = new URLSearchParams();
    params.set('apikey', API_KEY);
    params.set('lang', qp.lang || 'en');
    params.set('max', qp.max || '20');

    // country is allowed on both endpoints
    if (qp.country) params.set('country', qp.country);

    if (endpoint === 'top-headlines') {
      params.set('category', qp.category || 'general');
      if (qp.q) params.set('q', qp.q); // optional keyword filter on headlines :contentReference[oaicite:2]{index=2}
    } else {
      params.set('q', qp.q.trim());
    }

    // Normalize from/to to ISO 8601 (required) :contentReference[oaicite:3]{index=3}
    for (const key of ['from', 'to']) {
      const v = qp[key];
      if (!v) continue;
      const d = new Date(v);
      params.set(key, isNaN(d.getTime()) ? `${v}T00:00:00.000Z` : d.toISOString());
    }

    // Only send expand=content if explicitly enabled by env (paid feature) :contentReference[oaicite:4]{index=4}
    const allowExpand = (process.env.GNEWS_EXPAND_CONTENT || '').toLowerCase() === 'true';
    if (allowExpand && qp.expand === 'content') params.set('expand', 'content');

    const baseUrl = (q) => `https://gnews.io/api/v4/${endpoint}?${q.toString()}`;

    // Simple in-memory cache
    const cacheKey = `${endpoint}|${params.toString()}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.t < CACHE_DURATION) {
      return { statusCode: 200, headers: { ...headers, 'X-Cache': 'HIT' }, body: JSON.stringify(cached.data) };
    }

    // Fetch with graceful fallback if expand triggers a plan error
    let url = baseUrl(params);
    let res = await fetch(url);
    let data = await res.json();

    if (!res.ok && params.has('expand')) {
      params.delete('expand');
      url = baseUrl(params);
      res = await fetch(url);
      data = await res.json();
    }

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers,
        body: JSON.stringify({
          error: data?.errors?.[0] || data?.message || 'GNews API error',
          status: res.status,
        }),
      };
    }

    if (!data.articles || !Array.isArray(data.articles)) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Invalid response from news API' }) };
    }

    const articles = data.articles.map((a) => ({
      title: a.title || 'No title',
      description: a.description || 'No description',
      content: a.content || a.description || 'No content available',
      url: a.url,
      image: a.image,
      publishedAt: a.publishedAt,
      source: { name: a.source?.name || 'Unknown Source', url: a.source?.url || '' },
    }));

    const payload = {
      totalArticles: data.totalArticles || articles.length,
      articles,
      fetchedAt: new Date().toISOString(),
      endpoint,
      parameters: Object.fromEntries(params),
    };

    cache.set(cacheKey, { t: Date.now(), data: payload });
    if (cache.size > 100) cache.delete(cache.keys().next().value);

    return { statusCode: 200, headers: { ...headers, 'X-Cache': 'MISS' }, body: JSON.stringify(payload) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error', message: String(err) }) };
  }
};
