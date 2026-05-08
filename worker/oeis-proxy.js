export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET',
        },
      });
    }

    const id = (new URL(request.url).searchParams.get('id') || '').trim().toUpperCase();

    if (!/^A\d{1,6}$/.test(id)) {
      return new Response(JSON.stringify({ error: 'Invalid OEIS ID' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    try {
      const resp = await fetch(
        `https://oeis.org/search?q=id:${id}&fmt=json`,
        { signal: AbortSignal.timeout(10000) }
      );
      const body = await resp.text();
      return new Response(body, {
        status: resp.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Upstream unavailable' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  },
};
