import { turnCredentials } from './worker.js';

const NEW_ORIGIN = 'https://saturn-devouring.arieldeschapell.workers.dev';
const DOCUMENT_PATHS = new Set([
  '/', '/index.html', '/game', '/game/', '/game/index.html',
  '/sim', '/sim/', '/sim/index.html', '/fused', '/fused/',
  '/fused/index.html', '/vat', '/vat/', '/vat/index.html',
  '/game/sandbox.html',
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/turn-credentials') return turnCredentials(request, env);

    // Navigate old links to the new address. Keep assets on the old origin so
    // tabs opened before the rename can finish loading modules and textures.
    if ((request.method === 'GET' || request.method === 'HEAD')
      && (DOCUMENT_PATHS.has(url.pathname)
        || request.headers.get('accept')?.includes('text/html'))) {
      return Response.redirect(`${NEW_ORIGIN}${url.pathname}${url.search}`, 308);
    }
    return env.ASSETS.fetch(request);
  },
};
