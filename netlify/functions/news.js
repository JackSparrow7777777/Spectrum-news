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
      q = 'latest news',
      lang = 'en',
      country = 'us',
      max = '10',
      category = '',
      expand = 'content',
      from = '',
      to = '',
      sources = '',
      timeframe = ''
    } = queryParams;

    // Handle timeframe shortcuts - DEFINE THESE FIRST
    let actualFrom = from;
    let actualTo = to;
    
    if (timeframe) {
      const now = new Date();
      const formatDate = (date) => date.toISOString().split('T')[0];
      
      switch (timeframe) {
        case '1day':
          const yesterday = new Date(now);
          yesterday.setDate(now.getDate() - 1);
          actualFrom = formatDate(yesterday);
          actualTo = formatDate(now);
          break;
        case '1week':
          const weekAgo = new Date(now);
          weekAgo.setDate(now.getDate() - 7);
          actualFrom = formatDate(weekAgo);
          actualTo = formatDate(now);
          break;
        case '1month':
          const monthAgo = new Date(now);
          monthAgo.setMonth(now.getMonth() - 1);
          actualFrom = formatDate(monthAgo);
          actualTo = formatDate(now);
          break;
        case '1year':
          const yearAgo = new Date(now);
          yearAgo.setFullYear(now.getFullYear() - 1);
          actualFrom = formatDate(yearAgo);
          actualTo = formatDate(now);
          break;
      }
    }

    // Premium news sources
    const premiumSources = [
      'nytimes.com',
      'washingtonpost.com',
      'wsj.com',
      'cnn.com',
      'bbc.com',
      'reuters.com',
      'apnews.com',
      'bloomberg.com',
      'theguardian.com',
      'npr.org',
      'usatoday.com',
      'latimes.com',
      'politico.com',
      'axios.com',
      'economist.com'
    ];

    // Create cache key - NOW variables are properly defined
    const cacheKey = JSON.stringify({ q, lang, country, max, category, expand, actualFrom, actualTo, sources, timeframe });
    
    // Check cache first
    const cachedResult = cache.get(cacheKey);
    if (cachedResult && Date.now() - cachedResult.timestamp < cacheTimeout) {
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

    // Build search query
    let searchQuery = q;
    
    // Handle category-specific searches
    if (category && category !== '') {
      const categoryKeywords = {
        'general': 'news OR headlines',
        'world': 'world OR international',
        'business': 'business OR economy',
        'technology': 'technology OR tech',
        'entertainment': 'entertainment',
        'sports': 'sports',
        'science': 'science',
        'health': 'health'
      };
      
      const categoryTerm = categoryKeywords[category] || category;
      
      if (q === 'latest news') {
        searchQuery = categoryTerm;
      } else {
        searchQuery = `(${q}) AND (${categoryTerm})`;
      }
    }

    // Add premium source filtering if requested
    if (sources === 'premium') {
      const siteQueries = premiumSources.slice(0, 5).map(source => `site:${source}`).join(' OR ');
      searchQuery = `(${searchQuery}) AND (${siteQueries})`;
    }

    // Build API URL - always use search endpoint
    const apiUrl = new URL('https://gnews.io/api/v4/search');
    apiUrl.searchParams.append('apikey', process.env.GNEWS_API_KEY);
    apiUrl.searchParams.append('lang', lang);
    apiUrl.searchParams.append('max', max);
    apiUrl.searchParams.append('expand', expand);
    apiUrl.searchParams.append('q', searchQuery);
    
    if (country) apiUrl.searchParams.append('country', country);
    if (actualFrom) apiUrl.searchParams.append('from', actualFrom);
    if (actualTo) apiUrl.searchParams.append('to', actualTo);

    console.log('Fetching from:', apiUrl.toString().replace(process.env.GNEWS_API_KEY, 'HIDDEN'));

    // Make API request
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

    // Process articles
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
      parameters: { q, searchQuery, lang, country, max, category, expand, actualFrom, actualTo, timeframe, sources }
    };

    // Cache the result
    cache.set(cacheKey, {
      data: processedData,
      timestamp: Date.now()
    });

    // Clean up old cache entries
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
