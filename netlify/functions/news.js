const cache = new Map();
const CACHE_DURATION = 30 * 60 * 1000;

exports.handler = async (event, context) => {
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
    console.log('Function started successfully');
    
    // Extract query parameters
    const queryParams = event.queryStringParameters || {};
    
    const {
      q = 'latest news',
      lang = 'en',
      country = 'us',
      max = '25',
      category = '',
      expand = 'content',
      from = '',
      to = '',
      sources = 'premium',
      timeframe = ''
    } = queryParams;

    console.log('Parameters extracted:', { q, sources, timeframe });

    // Handle timeframe shortcuts
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

    console.log('Timeframe processed');

    // Basic source filtering (simplified)
    const premiumSources = [
      'nytimes.com', 'washingtonpost.com', 'wsj.com', 'cnn.com', 'bbc.com',
      'reuters.com', 'apnews.com', 'bloomberg.com'
    ];

    // Build search query
    let searchQuery = q;
    
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
      searchQuery = q === 'latest news' ? categoryTerm : `(${q}) AND (${categoryTerm})`;
    }

    // Add source filtering
    if (sources === 'premium' || sources === 'balanced' || sources === 'mainstream') {
      const siteQueries = premiumSources.slice(0, 5).map(source => `site:${source}`).join(' OR ');
      searchQuery = `searchQuery = q === 'latest news' ? categoryTerm : `${q} ${categoryTerm}`;`;
    }

    console.log('Search query built:', searchQuery);

    // Build API URL
    const apiUrl = new URL('https://gnews.io/api/v4/search');
    apiUrl.searchParams.append('apikey', process.env.GNEWS_API_KEY);
    apiUrl.searchParams.append('lang', lang);
    apiUrl.searchParams.append('max', max);
    apiUrl.searchParams.append('expand', expand);
    apiUrl.searchParams.append('q', searchQuery);
    
    if (country) apiUrl.searchParams.append('country', country);
    if (actualFrom) apiUrl.searchParams.append('from', actualFrom);
    if (actualTo) apiUrl.searchParams.append('to', actualTo);

    console.log('About to fetch from GNews API');

    // Make API request
    const response = await fetch(apiUrl.toString());
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('GNews API Error:', response.status, errorText);
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({ error: 'Failed to fetch news', status: response.status, message: errorText }),
      };
    }

    const data = await response.json();
    console.log('GNews API response received, articles:', data.articles?.length || 0);
    
    if (!data.articles || !Array.isArray(data.articles)) {
      console.error('Invalid response structure:', data);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Invalid response from news API' }),
      };
    }

    // Process articles with basic classification
    const processedArticles = data.articles.map(article => {
      // Simple source classification
      let bias = 'unknown';
      let reliability = 'medium';
      
      const sourceName = article.source?.name?.toLowerCase() || '';
      const sourceUrl = article.source?.url || '';
      
      if (sourceName.includes('nytimes') || sourceUrl.includes('nytimes.com')) {
        bias = 'center-left';
        reliability = 'high';
      } else if (sourceName.includes('wsj') || sourceUrl.includes('wsj.com')) {
        bias = 'center-right';
        reliability = 'high';
      } else if (sourceName.includes('reuters') || sourceUrl.includes('reuters.com')) {
        bias = 'center';
        reliability = 'very-high';
      } else if (sourceName.includes('cnn') || sourceUrl.includes('cnn.com')) {
        bias = 'left-lean';
        reliability = 'high';
      } else if (sourceName.includes('bbc') || sourceUrl.includes('bbc.com')) {
        bias = 'center';
        reliability = 'high';
      }
      
      return {
        title: article.title || 'No title',
        description: article.description || 'No description',
        content: article.content || article.description || 'No content available',
        url: article.url,
        image: article.image,
        publishedAt: article.publishedAt,
        source: {
          name: article.source?.name || 'Unknown Source',
          url: article.source?.url || '',
          classification: {
            bias: bias,
            reliability: reliability,
            name: article.source?.name || 'Unknown Source'
          }
        }
      };
    });

    console.log('Articles processed successfully');

    const processedData = {
      totalArticles: finalArticles.length,
      originalTotal: processedArticles.length,
      articles: finalArticles,
      hasGroups: false,
      sourceTypes: sources,
      fetchedAt: new Date().toISOString(),
      debug: 'Simplified version working - post-filtering approach'
    };

    console.log('Response prepared, sending back');

    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
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
        stack: error.stack,
        timestamp: new Date().toISOString()
      }),
    };
  }
};
