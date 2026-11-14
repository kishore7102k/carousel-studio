// Dev-only Client ID Metadata Document for the OAuth smoke test. Its client_id is its own full URL (query
// string included, so a test can mint many distinct clients); `?redirect=` sets the redirect URI.
// The CIMD fetcher allows exactly this http://localhost URL outside production. 404 in production.
// Build the query with URLSearchParams: Next re-serializes req.url that way, and the fetcher requires the
// document's client_id to equal the requested URL exactly (e.g. `?redirect=http://…` unencoded will not match).
export function GET(req: Request) {
  if (process.env.NODE_ENV === 'production') return new Response('Not found', { status: 404 });
  const url = new URL(req.url);
  return Response.json(
    {
      client_id: req.url,
      client_name: 'CIMD test client',
      redirect_uris: [url.searchParams.get('redirect') || 'http://127.0.0.1/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
