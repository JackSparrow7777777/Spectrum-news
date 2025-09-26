'use strict';

/**
 * GNews API Serverless Function
 * - balanced-view v3 + bucket-targeted backfill + topic search fix
 * - BACKFILL BUDGET CAPS + REQUEST TIMEOUTS
 * - clustering:
 *    cluster=off    -> no clustering
 *    cluster=title  -> simple title-key dedupe (legacy)
 *    cluster=smart  -> semantic clustering (entities + fuzzy title + temporal + URL hints)
 */

const cache = new Map();
const CACHE_DURATION = 30 * 60 * 1000;   // 30 min
const API_BASE = 'https://gnews.io/api/v4';
const PER_REQ_CAP = 25;

const BUCKETS = ['left','lean-left','center','lean-right','right'];
const ALLOWED_CATEGORIES = new Set([
  'general','world','nation','business','technology','entertainment','sports','science','health'
]);

/* -------- Bias buckets (expanded) -------- */
const BIAS_BUCKETS = {
  left: [
    'alternet.org','democracynow.org','theguardian.com','huffpost.com','theintercept.com',
    'jacobin.com','motherjones.com','msnbc.com','thenation.com','newyorker.com',
    'thedailybeast.com','slate.com','vox.com','salon.com','bostonglobe.com','rollingstone.com'
  ],
  'lean-left': [
    'abcnews.go.com','axios.com','bloomberg.com','cbsnews.com','cnbc.com','cnn.com',
    'insider.com','businessinsider.com','nbcnews.com','nytimes.com','npr.org',
    'politico.com','propublica.com','propublica.org','semafor.com','time.com','usatoday.com',
    'washingtonpost.com','news.yahoo.com','variety.com','al-monitor.com'
  ],
  center: [
    'apnews.com','reuters.com','bbc.com','bbc.co.uk','csmonitor.com','forbes.com',
    'marketwatch.com','newsweek.com','newsnationnow.com','thehill.com','upi.com',
    'foreignpolicy.com','fortune.com','economist.com'
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

/* -------- Reliability (seed) -------- */
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

/* -------- Backfill budget caps -------- */
const BACKFILL_DOMAIN_LIMIT = parseInt(process.env.BACKFILL_DOMAIN_LIMIT || '5', 10); // per bucket
const BACKFILL_PAGES        = parseInt(process.env.BACKFILL_PAGES || '1', 10);       // per domain
const BACKFILL_PER_PAGE     = parseInt(process.env.BACKFILL_PER_PAGE || '15', 10);   // per page
const MAX_FETCH_BUDGET      = parseInt(process.env.MAX_FETCH_BUDGET || '12', 10);    // total external calls per request

/* -------- Helpers -------- */
const STOP = new Set([
  'the','a','an','to','of','in','on','and','or','as','for','at','by','with','from',
  'about','amid','over','after','before','into','out','up','down','is','are','be','was','were',
  'that','this','those','these','it','its','their','his','her','you','i','we','they','but'
]);

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

/* -------- Similarity utilities for smart clustering -------- */
function tokenize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !STOP.has(w));
}
function ngrams(tokens, n=2) {
  const arr = [];
  for (let i=0; i<=tokens.length-n; i++) arr.push(tokens.slice(i,i+n).join(' '));
  return arr;
}
function cosineSim(aVec, bVec) {
  let dot=0, aN=0, bN=0;
  const seen = new Set([...Object.keys(aVec), ...Object.keys(bVec)]);
  for (const k of seen) {
    const av=aVec[k]||0, bv=bVec[k]||0;
    dot += av*bv; aN += av*av; bN += bv*bv;
  }
  const denom = Math.sqrt(aN)*Math.sqrt(bN);
  return denom ? (dot/denom) : 0;
}
function bagify(tokens) {
  const v = {};
  for (const t of tokens) v[t] = (v[t]||0) + 1;
  return v;
}
function titleSimilarity(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (!ta.length || !tb.length) return 0;
  // mix of unigram + bigram cosine
  const ua = bagify(ta), ub = bagify(tb);
  const ba = bagify(ngrams(ta,2).concat(ngrams(ta,3)));
  const bb = bagify(ngrams(tb,2).concat(ngrams(tb,3)));
  return 0.6*cosineSim(ua,ub) + 0.4*cosineSim(ba,bb);
}
function extractEntities(text) {
  // simple proper noun heuristic from original case
  const m = (text || '').match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];
  return new Set(m.map(s=>s.toLowerCase()));
}
function jaccard(set1, set2) {
  if (!set1.size && !set2.size) return 0;
  let inter=0;
  for (const x of set1) if (set2.has(x)) inter++;
  const union = set1.size + set2.size - inter;
  return union ? inter/union : 0;
}
function temporalSimilarity(aIso, bIso) {
  const ta = Date.parse(aIso||0), tb = Date.parse(bIso||0);
  if (!isFinite(ta) || !isFinite(tb)) return 0.2; // shrug
  const diffHrs = Math.abs(ta - tb) / (1000*60*60);
  // full score if within 6h, decays to ~0 by ~72h
  if (diffHrs <= 6) return 1;
  if (diffHrs >= 72) return 0;
  return 1 - (diffHrs - 6) / (72 - 6);
}
function sourceSimilarity(aSource, bSource) {
  const a = (aSource?.name||'').toLowerCase();
  const b = (bSource?.name||'').toLowerCase();
  if (!a || !b) return 0.2;
  return a === b ? 1 : 0.2; // small bonus if same outlet
}
function urlHints(article) {
  const url = article?.url || '';
  const parts = url.split(/[\/\?#]/).filter(p => p && p.length>2 && !/^(www|com|org|net|html?|php|amp)$/i.test(p));
  const idMatches = [];
  const patterns = [
    /story[_-]?(\d+)/i,
    /article[_-]?(\d+)/i,
    /(\d{4}\/\d{2}\/\d{2})/,
    /([a-z]+(?:-[a-z]+){2,})/i
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m && m[1]) idMatches.push(m[1].toLowerCase());
  }
  return new Set(parts.concat(idMatches).map(s => s.toLowerCase()));
}
function urlSimilarity(a, b) {
  const sa = urlHints(a), sb = urlHints(b);
  return jaccard(sa, sb);
}

/* Budget is reset per request inside handler */
let fetchBudget = Infinity;

async function call(url, { timeoutMs = 8000 } = {}) {
  if (fetchBudget <= 0) return { articles: [] };
  const ac = new AbortController();
  const timer = setTimeout(()=>ac.abort(), timeoutMs);
  try {
    fetchBudget--;
    const resp = await fetch(url, { signal: ac.signal });
    if (resp.status === 403) throw new Error('403 quota/plan restriction from GNews');
    if (!resp.ok) {
      const txt = await resp.text().catch(()=> '');
      throw new Error(`GNews ${resp.status} ${resp.statusText} ${txt}`.trim());
    }
    return resp.json();
  } finally { clearTimeout(timer); }
}

function normArticle(a) {
  const primaryUrl = a?.source?.url || a?.url || '';
  return {
    title: a?.title || 'No title',
    description: a?.description || 'No description',
    content: a?.content || a?.description || 'No content available',
    url: a?.url,
    image: a?.image,
    publishedAt: a?.publishedAt,
    source: { name: a?.source?.name || 'Unknown Source', url: a?.source?.url || '' },
    bias: detectBiasByUrl(primaryUrl) || '',
    reliabilityScore: reliabilityByUrl(primaryUrl)
  };
}

function dedupeKeepNewest(list) {
  const byKey = new Map();
  for (const a of list) {
    const k = a?.url || a?.source?.url || a?.title || '';
    if (!k) continue;
    const prev = byKey.get(k);
    if (!prev) byKey.set(k, a);
    else {
      const tPrev = Date.parse(prev.publishedAt || 0);
      const tNow  = Date.parse(a.publishedAt || 0);
      if (tNow > tPrev) byKey.set(k, a);
    }
  }
  return [...byKey.values()];
}

function partitionByBias(articles) {
  const bins = Object.fromEntries(BUCKETS.map(b => [b, []]));
  const unknown = [];
  for (const a of articles) {
    if (BUCKETS.includes(a.bias)) bins[a.bias].push(a);
    else unknown.push(a);
  }
  for (const b of BUCKETS) bins[b].sort((x,y) => new Date(y.publishedAt||0) - new Date(x.publishedAt||0));
  unknown.sort((x,y) => new Date(y.publishedAt||0) - new Date(x.publishedAt||0));
  return { bins, unknown };
}

/* ----- SMART CLUSTERING ----- */
// Composite similarity with bounded cost (O(n^2) but guarded by caps)
function smartCluster(articles, options = {}) {
  const {
    threshold = 0.68,
    maxPairs = 15000,      // safety: do not compute pairwise beyond this
    maxArticles = 400      // another safety: if pool is huge, pre-trim by recency
  } = options;

  if (articles.length <= 1) return articles;

  // trim newest-first if too many
  const pool = articles.slice().sort((a,b)=>Date.parse(b.publishedAt||0)-Date.parse(a.publishedAt||0))
                       .slice(0, Math.min(maxArticles, articles.length));

  // Precompute metadata
  const meta = pool.map(a => ({
    ents: extractEntities(a.title + ' ' + (a.description || '')),
    urlSet: urlHints(a),
    t: Date.parse(a.publishedAt || 0) || 0,
  }));

  // Union-Find to build clusters
  const parent = Array(pool.length).fill(0).map((_,i)=>i);
  const find = (x)=> parent[x]===x?x:(parent[x]=find(parent[x]));
  const unite = (a,b)=>{ a=find(a); b=find(b); if(a!==b) parent[b]=a; };

  let computed = 0;
  for (let i=0;i<pool.length;i++){
    for (let j=i+1;j<pool.length;j++){
      if (computed++ > maxPairs) break;
      const A = pool[i], B = pool[j];
      // Weighted composite
      const sTitle = titleSimilarity(A.title, B.title);                 // 0..1
      const sEnt   = jaccard(meta[i].ents, meta[j].ents);               // 0..1
      const sTemp  = temporalSimilarity(A.publishedAt, B.publishedAt);  // 0..1
      const sUrl   = jaccard(meta[i].urlSet, meta[j].urlSet);           // 0..1

      const composite = 0.45*sTitle + 0.30*sEnt + 0.20*sTemp + 0.05*sUrl;
      if (composite >= threshold) unite(i,j);
    }
    if (computed > maxPairs) break;
  }

  // Group by root and pick representative (newest, then highest reliability)
  const groups = new Map();
  for (let i=0;i<pool.length;i++){
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(pool[i]);
  }

  const reps = [];
  for (const grp of groups.values()){
    grp.sort((a,b)=>{
      const tb = Date.parse(b.publishedAt||0), ta = Date.parse(a.publishedAt||0);
      if (tb !== ta) return tb - ta;
      const rb = (b.reliabilityScore ?? DEFAULT_RELIABILITY);
      const ra = (a.reliabilityScore ?? DEFAULT_RELIABILITY);
      return rb - ra;
    });
    reps.push(grp[0]);
  }

  // Keep original items that weren't in the trimmed pool (rare) by appending if unique by URL
  const used = new Set(reps.map(x=>x.url));
  for (const a of articles) {
    if (used.size >= reps.length + 100) break; // do not explode
    if (!used.has(a.url) && !pool.find(p=>p.url===a.url)) used.add(a.url), reps.push(a);
  }

  return reps;
}

/* -------- Main handler -------- */
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

  // Reset budget per request
  fetchBudget = MAX_FETCH_BUDGET;

  try {
    const qp = event.queryStringParameters || {};
    const qRaw     = String(qp.q || 'latest news').trim() || 'latest news';
    const q        = qRaw.slice(0, 200); // guard against silly-long queries
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
    const clusterMode = String(qp.cluster || '').toLowerCase(); // off | title | smart

    if (!ALLOWED_CATEGORIES.has(category)) category = '';

    /* ---- Cache ---- */
    const cacheKey = JSON.stringify({
      q, lang, country, maxReq, category, expand, from, to,
      bias: doBiasFilter ? bias : '', minReliability, balanced, clusterMode
    });
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      return { statusCode: 200, headers: { ...headers, 'X-Cache': 'HIT' }, body: JSON.stringify(cached.data) };
    }

    /* ---- Build base params ---- */
    const endpointFor = (cat) => (cat ? 'top-headlines' : 'search');
    const baseParams = (cat) => {
      const s = new URLSearchParams();
      s.append('apikey', API_KEY);
      s.append('lang', lang);
      s.append('expand', expand);
      if (q) s.append('q', q);           // ✅ topic search fix: always include q
      if (cat) s.append('topic', cat);
      if (country) s.append('country', country);
      return s;
    };

    /* ---- Fetch helpers (count against budget via call()) ---- */
    async function fetchPages(cat, pages, perPage) {
      const endpoint = endpointFor(cat);
      const tasks = [];
      for (let p = 1; p <= pages; p++) {
        const u = new URL(`${API_BASE}/${endpoint}`);
        const b = baseParams(cat);
        for (const [k,v] of b.entries()) u.searchParams.append(k, v);
        u.searchParams.append('max', String(perPage));
        u.searchParams.append('page', String(p));
        tasks.push(call(u.toString()).catch(()=>({ articles: [] })));
      }
      const results = await Promise.all(tasks);
      return results.flatMap(r => Array.isArray(r.articles) ? r.articles : []);
    }

    // Site-targeted search to backfill a domain (also counts against budget)
    async function fetchForDomain(domain, pages = 1, perPage = 20) {
      const u = new URL(`${API_BASE}/search`);
      const s = new URLSearchParams();
      s.append('apikey', API_KEY);
      s.append('lang', lang);
      s.append('expand', expand);
      const siteQ = q ? `${q} site:${domain}` : `site:${domain}`;
      s.append('q', siteQ);
      if (country) s.append('country', country);
      s.append('max', String(Math.min(PER_REQ_CAP, perPage)));
      const tasks = [];
      for (let p = 1; p <= pages; p++) {
        const url = new URL(u);
        for (const [k,v] of s.entries()) url.searchParams.append(k, v);
        url.searchParams.append('page', String(p));
        tasks.push(call(url.toString()).catch(()=>({ articles: [] })));
      }
      const results = await Promise.all(tasks);
      return results.flatMap(r => Array.isArray(r.articles) ? r.articles : []);
    }

    /* ---- Strategy ---- */
    const overFetchFactor =
      balanced ? 3
      : (doBiasFilter || minReliability > 0 || (clusterMode === 'title' || clusterMode === 'smart') ? 1.5 : 1);

    const rawTarget = Math.min(100, Math.max(maxReq, Math.ceil(maxReq * overFetchFactor)));

    // Primary pool (topic-respecting)
    const primary = await fetchPages(category, Math.ceil(rawTarget / PER_REQ_CAP) || 1, Math.min(PER_REQ_CAP, rawTarget));

    // Supplemental general pool to add variety (light)
    let supplemental = [];
    if (balanced && !category) {
      const picks = ['world','business','technology'];
      const res = await Promise.all(picks.map(t => fetchPages(t, 1, 20)));
      supplemental = res.flat();
    }

    // Merge -> normalize
    let pool = dedupeKeepNewest([...primary, ...supplemental]).map(normArticle);

    // Time window
    if (from || to) {
      const fromT = from ? Date.parse(from) : Number.NEGATIVE_INFINITY;
      const toT   = to   ? Date.parse(to)   : Number.POSITIVE_INFINITY;
      pool = pool.filter(a => {
        const t = Date.parse(a.publishedAt || '');
        return isNaN(t) ? true : (t >= fromT && t <= toT);
      });
    }
    // Reliability
    if (minReliability > 0) pool = pool.filter(a => (a.reliabilityScore ?? DEFAULT_RELIABILITY) >= minReliability);

    // Clustering
    if (clusterMode === 'title') {
      const seenKeys = new Set();
      pool = pool.filter(a => {
        const k = titleKey(a.title);
        if (seenKeys.has(k)) return false;
        seenKeys.add(k); return true;
      });
    } else if (clusterMode === 'smart') {
      pool = smartCluster(pool, { threshold: 0.68, maxPairs: 15000, maxArticles: 400 });
      // ensure stability post-cluster
      pool = dedupeKeepNewest(pool);
    }

    /* -------- Bucket-targeted backfill when balanced ON (with budget caps) -------- */
    if (balanced) {
      const targetPerBucket = Math.ceil(maxReq / BUCKETS.length); // equal target
      const { bins } = partitionByBias(pool);
      const need = Object.fromEntries(BUCKETS.map(b => [b, Math.max(0, targetPerBucket - (bins[b]?.length || 0))]));

      const backfillTasks = [];
      for (const b of BUCKETS) {
        if (need[b] <= 0) continue;
        const domains = (BIAS_BUCKETS[b] || []).slice(0, BACKFILL_DOMAIN_LIMIT);
        for (const d of domains) {
          if (fetchBudget <= 0) break;
          backfillTasks.push(fetchForDomain(d, BACKFILL_PAGES, BACKFILL_PER_PAGE));
          if (backfillTasks.length >= MAX_FETCH_BUDGET) break;
        }
        if (fetchBudget <= 0) break;
      }

      if (backfillTasks.length) {
        const results = await Promise.all(backfillTasks);
        const extra = dedupeKeepNewest(results.flat()).map(normArticle).filter(a => BUCKETS.includes(a.bias));
        pool = dedupeKeepNewest([...pool, ...extra]);
      }
    }

    /* ---- Final selection ---- */
    let articles;
    if (doBiasFilter) {
      articles = pool.filter(a => a.bias === bias).slice(0, maxReq);
    } else if (balanced) {
      articles = balancedSampler(pool, maxReq);
    } else {
      // default: newest first
      articles = pool
        .sort((a,b) => new Date(b.publishedAt||0) - new Date(a.publishedAt||0))
        .slice(0, maxReq);
    }

    const payload = {
      totalArticles: articles.length,
      articles,
      fetchedAt: new Date().toISOString(),
      endpoint: (category ? 'top-headlines' : 'search'),
      parameters: {
        q, lang, country, max: maxReq, category, expand, from, to,
        bias: doBiasFilter ? bias : (balanced ? 'balanced' : 'default'),
        minReliability, cluster: clusterMode || 'off', balanced: !!balanced
      }
    };

    cache.set(cacheKey, { data: payload, timestamp: Date.now() });
    if (cache.size > 120) cache.delete(cache.keys().next().value);

    return { statusCode: 200, headers: { ...headers, 'X-Cache': 'MISS' }, body: JSON.stringify(payload) };

  } catch (err) {
    const friendly = /403/.test(err.message)
      ? 'API quota/plan limit reached. Try fewer articles, turn off Balanced view, or wait before retrying.'
      : 'We hit a temporary error fetching news.';
    const body = JSON.stringify({ error: friendly, message: err.message, timestamp: new Date().toISOString() });
    return { statusCode: 500, headers, body };
  }
};

/* ---------- Sampler that respects targets and avoids CL dominance ---------- */
function balancedSampler(pool, maxReq) {
  const { bins, unknown } = partitionByBias(pool);
  const target = Math.ceil(maxReq / BUCKETS.length);

  // Queues per bucket
  const queues = BUCKETS.map(b => (bins[b] ? bins[b].slice() : []));

  // First pass: round-robin pick up to target from each bucket
  const picks = [];
  const used = new Set();
  for (let round = 0; round < target; round++) {
    for (let i = 0; i < BUCKETS.length; i++) {
      const q = queues[i];
      while (q && q.length) {
        const a = q.shift();
        const k = a.url;
        if (!used.has(k)) { picks.push(a); used.add(k); break; }
      }
    }
    if (picks.length >= maxReq) break;
  }

  // Second pass: fill remaining slots favoring still under-target buckets
  function bucketCount(bias) { return picks.filter(a => a.bias === bias).length; }
  while (picks.length < maxReq) {
    const under = BUCKETS.filter(b => bucketCount(b) < target);
    if (!under.length) break;

    let added = false;
    for (const b of under) {
      const q = (bins[b] || []);
      while (q.length) {
        const a = q.shift();
        const k = a.url;
        if (!used.has(k)) { picks.push(a); used.add(k); added = true; break; }
      }
      if (picks.length >= maxReq) break;
    }
    if (!added) break;
  }

  // Third pass: unknowns (if any)
  for (const a of unknown) {
    if (picks.length >= maxReq) break;
    const k = a.url;
    if (!used.has(k)) { picks.push(a); used.add(k); }
  }

  // Final pass: anything else newest-first
  if (picks.length < maxReq) {
    const rest = pool
      .filter(a => !used.has(a.url))
      .sort((x,y) => new Date(y.publishedAt||0) - new Date(x.publishedAt||0));
    for (const a of rest) {
      picks.push(a);
      if (picks.length >= maxReq) break;
    }
  }

  return picks.slice(0, maxReq);
}

