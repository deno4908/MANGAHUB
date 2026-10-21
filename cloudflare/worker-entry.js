import { WorkerEntrypoint } from 'cloudflare:workers';
import worker, { fetchQQOrigin } from './mangadex-edge-worker.js';

// Only validated page/form parameters cross this internal binding. Incoming
// browser/server Request objects, account headers, and cf metadata do not.
export class QQOrigin extends WorkerEntrypoint {
  load(path, query, body) {
    return fetchQQOrigin(path, query, body);
  }
}

export default {
  fetch(request, env, ctx) {
    return worker.fetch(request, { QQ_ORIGIN: ctx.exports.QQOrigin });
  },
};
