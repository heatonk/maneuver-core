import type { Handler } from '@netlify/functions';

type Provider = 'tba' | 'nexus';

const TBA_BASE_URL = 'https://www.thebluealliance.com/api/v3';
const NEXUS_BASE_URL = 'https://frc.nexus/api/v1';

const tbaAllowed = [
  /^\/events\/\d+(?:\/simple)?$/,
  /^\/event\/[a-z0-9]+\/matches(?:\/simple)?$/i,
  /^\/event\/[a-z0-9]+\/teams\/keys$/i,
  /^\/match\/[a-z0-9_]+$/i,
  /^\/team\/frc\d+\/social_media$/i,
];

const nexusAllowed = [
  /^\/events$/,
  /^\/event\/[a-z0-9]+$/i,
  /^\/event\/[a-z0-9]+\/pits$/i,
  /^\/event\/[a-z0-9]+\/map$/i,
];

function isAllowedEndpoint(provider: Provider, endpoint: string): boolean {
  const rules = provider === 'tba' ? tbaAllowed : nexusAllowed;
  return rules.some(rule => rule.test(endpoint));
}

function getServerApiKey(provider: Provider): string | undefined {
  if (provider === 'tba') {
    return process.env.TBA_API_KEY || process.env.TBA_AUTH_KEY || process.env.VITE_TBA_API_KEY;
  }
  return process.env.NEXUS_API_KEY || process.env.NEXUS_AUTH_KEY || process.env.VITE_NEXUS_API_KEY;
}

export const handler: Handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Client-Api-Key',
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
    const provider = (event.queryStringParameters?.provider || '').toLowerCase() as Provider;
    const endpoint = event.queryStringParameters?.endpoint || '';

    if (provider !== 'tba' && provider !== 'nexus') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid provider' }) };
    }

    if (!endpoint.startsWith('/') || !isAllowedEndpoint(provider, endpoint)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Endpoint not allowed' }) };
    }

    const overrideKey = event.headers['x-client-api-key'] || event.headers['X-Client-Api-Key'];
    const apiKey = overrideKey || getServerApiKey(provider);

    if (!apiKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: `${provider.toUpperCase()} API key not configured on server. Set ${provider === 'tba' ? 'TBA_API_KEY (preferred) or TBA_AUTH_KEY (or VITE_TBA_API_KEY for local dev)' : 'NEXUS_API_KEY (preferred) or NEXUS_AUTH_KEY (or VITE_NEXUS_API_KEY for local dev)'}`,
        }),
      };
    }

    const baseUrl = provider === 'tba' ? TBA_BASE_URL : NEXUS_BASE_URL;
    const upstreamHeaders: Record<string, string> = {
      Accept: 'application/json',
      ...(provider === 'tba'
        ? { 'X-TBA-Auth-Key': apiKey }
        : { 'Nexus-Api-Key': apiKey }),
    };

    const upstreamResponse = await fetch(`${baseUrl}${endpoint}`, {
      method: 'GET',
      headers: upstreamHeaders,
    });

    const text = await upstreamResponse.text();

    return {
      statusCode: upstreamResponse.status,
      headers,
      body: text || JSON.stringify({}),
    };
  } catch (error) {
    console.error('api-proxy error', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error instanceof Error ? error.message : 'Proxy error' }),
    };
  }
};