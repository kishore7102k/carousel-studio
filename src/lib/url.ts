/** Public studio URL: STUDIO_URL, else the Vercel production domain, else localhost. No trailing slash on the base. */
export function studioUrl(path = '') {
  const base =
    process.env.STUDIO_URL?.replace(/\/+$/, '') ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : 'http://localhost:3000');
  return `${base}${path}`;
}
