export default {
  async fetch(request, env) {
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
      const resp = await fetchOEIS(id);
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

  async scheduled(event, env) {
    try {
      const resp = await fetchOEIS('A000045');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const json = await resp.json();
      const results = Array.isArray(json) ? json : (json.results || []);
      if (results.length === 0) throw new Error('empty response from OEIS');
    } catch (err) {
      await sendAlert(env, `OEIS proxy health check failed: ${err.message}`);
    }
  },
};

function fetchOEIS(id) {
  return fetch(
    `https://oeis.org/search?q=id:${id}&fmt=json`,
    { signal: AbortSignal.timeout(10000) }
  );
}

async function sendAlert(env, message) {
  if (!env.WEBHOOK_URL) return;
  await fetch(env.WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: message }),
  }).catch(() => {});
}
