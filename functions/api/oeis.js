export async function onRequestGet({ request }) {
  const id = (new URL(request.url).searchParams.get('id') || '').trim().toUpperCase();

  if (!/^A\d{1,6}$/.test(id)) {
    return json({ error: 'Invalid OEIS ID' }, 400);
  }

  let resp;
  try {
    resp = await fetch(
      `https://oeis.org/search?q=id:${id}&fmt=json`,
      { signal: AbortSignal.timeout(10000) }
    );
  } catch {
    return json({ error: 'Upstream unavailable' }, 502);
  }

  if (!resp.ok) {
    return json({ error: 'OEIS returned ' + resp.status }, 502);
  }

  return new Response(await resp.text(), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
