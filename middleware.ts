import { next } from '@vercel/edge';

// HTTP Basic Auth at the edge. Activates only when both env vars are present
// (BASIC_AUTH_USER, BASIC_AUTH_PASS in Vercel project settings), so the site
// can be deployed without protection if those aren't set yet.

export const config = {
  // Protect everything except static assets and the favicon. /api is included
  // — the browser auto-sends the Basic Auth header on same-origin requests
  // after the initial prompt.
  matcher: ['/((?!_expo/static|assets|favicon|robots.txt|apple-touch-icon).*)'],
};

export default function middleware(req: Request) {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;
  if (!user || !pass) return next();

  const auth = req.headers.get('authorization');
  const expected = 'Basic ' + btoa(`${user}:${pass}`);

  if (auth !== expected) {
    return new Response('Authentication required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="JetLagLess"' },
    });
  }
  return next();
}
