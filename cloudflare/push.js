import webpush from 'web-push';

export function pushEndpointError(raw) {
  let u; try { u = new URL(raw); } catch { return 'invalid push endpoint'; }
  // A browser chooses its vendor's endpoint. No arbitrary URL, private-network
  // request, alternate port or redirect is needed to deliver a Web Push message.
  const host = u.hostname;
  const allowed = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com'
    || host === 'web.push.apple.com' || host.endsWith('.push.apple.com')
    || host.endsWith('.notify.windows.com');
  return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && allowed
    ? null : 'unsupported browser push service';
}
export async function sendNotification(subscription, payload, options) {
  if (pushEndpointError(subscription.endpoint)) throw new Error('Unsupported push endpoint');
  const { endpoint, headers, body, method } = webpush.generateRequestDetails(subscription, payload, options);
  const r = await fetch(endpoint, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(options.timeout || 10000) });
  if (!r.ok) throw Object.assign(new Error('Push service rejected notification'), { statusCode: r.status });
}
