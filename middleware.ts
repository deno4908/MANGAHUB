import { next } from '@vercel/functions';
import { accessDecision, privateHeaders } from './cloudflare/access-gate.js';

// Every resource is protected: assets, favicon, robots, legal pages and routes.
export const config = { matcher: '/:path*' };

export default async function middleware(request: Request) {
  const decision = await accessDecision(request, process.env);
  if (decision.denied) return decision.denied;
  const response = next();
  if (decision.enabled) {
    for (const [name, value] of Object.entries(privateHeaders())) response.headers.set(name, String(value));
  }
  return response;
}
