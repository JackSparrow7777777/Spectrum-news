const cache = new Map();
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

exports.handler = async (event, context) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  // Handle preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: '',
    };
  }

  // Only allow GET requests
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    // Extract query parameters
    const queryParams = event.queryStringParameters || {};
    
    // Set default parameters
    const {
      q = 'latest news', // Default search query
      lang = 'en',
      country = 'us',
      max = '10',
      category = '',
      expand = 'content', // Get full article content
      from = '', // Date from (YYYY-MM-DD)
      to = '' // Date to (YYYY-MM-DD)
    } = queryParams;

    // Create cache key
    const cacheKey = JSON.stringify({ q, lang, country, max, category, expand, from, to });
    
    // Check cache first
    const cachedResult = cache.get(cacheKey);
    if (cachedResult && Date.now() - cachedResult.timestamp < CACHE_DURATION) {
      console.log('Returning cached result');
      return {
        statusCode: 200,
        headers: {
          ...headers,
          'X-Cache': 'HIT',
        },
        body: JSON.stringify(cachedResult.data),
      };
    }

    // Determine endpoint based on category
    let endpoint = 'search';
    if (category) {
      endpoint = 'top-headlines';
    }

    // Build API URL
    const apiUrl = new URL(`https://gnews.io/api/v4/${endpoint}`);
    
    // Add parameters to URL
    apiUrl.searchParams.append('apikey', process.env.GNEWS_API_KEY);
    apiUrl.searchParams.append('lang', lang);
    apiUrl.searchParams.append('max', max);
    apiUrl.searchParams.append('expand', expand);

    if (endpoint === 'search') {
      apiUrl.searchParams.append('q', q);
      if (country) apiUrl.searchParams.append('country', country);
      if (from) apiUrl.searchParams.append('from', from);
      if (to) apiUrl.searchParams.append('to', to);
    } else if (endpoint === 'top-headlines') {
      apiUrl.searchParams.append('category', category);
      if (country) apiUrl.searchParams.append('country', country);
    }

    console.log('Fetching from:', apiUrl.toString().replace(process.env.GNEWS_API_KEY, 'HIDDEN'));

    // Make API request (using built-in fetch in Node 18+)
    const response = await fetch(apiUrl.toString());
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('GNews API Error:', response.status, errorText);
      
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({ 
          error: 'Failed to fetch news',
          status: response.status,
          message: errorText
        }),
      };
    }

    const data = await response.json();
    
    // Validate response structure
    if (!data.articles || !Array.isArray(data.articles)) {
      console.error('Invalid response structure:', data);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          error: 'Invalid response from news API',
          received: data
        }),
      };
    }

    // Process articles - clean up and standardize data
    const processedArticles = data.articles.map(article => ({
      title: article.title || 'No title',
      description: article.description || 'No description',
      content: article.content || article.description || 'No content available',
      url: article.url,
      image: article.image,
      publishedAt: article.publishedAt,
      source: {
        name: article.source?.name || 'Unknown Source',
        url: article.source?.url || ''
      }
    }));

    const processedData = {
      totalArticles: data.totalArticles || processedArticles.length,
      articles: processedArticles,
      fetchedAt: new Date().toISOString(),
      endpoint: endpoint,
      parameters: { q, lang, country, max, category, expand, from, to }
    };

    // Cache the result
    cache.set(cacheKey, {
      data: processedData,
      timestamp: Date.now()
    });

    // Clean up old cache entries (keep cache size reasonable)
    if (cache.size > 100) {
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey);
    }

    return {
      statusCode: 200,
      headers: {
        ...headers,
        'X-Cache': 'MISS',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(processedData),
    };

  } catch (error) {
    console.error('Function error:', error);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Internal server error',
        message: error.message,
        timestamp: new Date().toISOString()
      }),
    };
  }
};
