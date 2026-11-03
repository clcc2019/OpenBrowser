'use strict';

const https = require('https');
const net = require('net');

// Resolve only the proxy server hostname. DoH bootstrap uses an IP literal, so
// establishing the encrypted DNS connection does not invoke the system resolver.
function createDohLookup({ request = https.request, timeoutMs = 3500, cacheMs = 60000 } = {}) {
  const cache = new Map();
  return function lookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (typeof options === 'number') options = { family: options };
    options ||= {};
    const family = Number(options.family) || 4;
    if (family !== 4 && family !== 6) return process.nextTick(callback, Object.assign(new Error('Unsupported address family'), { code: 'EAI_FAMILY' }));
    if (String(hostname).replace(/\.$/, '').toLowerCase() === 'localhost') {
      const address = family === 6 ? '::1' : '127.0.0.1';
      return process.nextTick(() => options.all ? callback(null, [{ address, family }]) : callback(null, address, family));
    }
    const key = `${hostname}:${family}`;
    const finish = (address) => options.all ? callback(null, [{ address, family }]) : callback(null, address, family);
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) return process.nextTick(() => finish(cached.address));
    const query = `/dns-query?name=${encodeURIComponent(hostname)}&type=${family === 6 ? 'AAAA' : 'A'}`;
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; callback(error); } };
    const req = request({ hostname: '1.1.1.1', port: 443, servername: 'cloudflare-dns.com', path: query, headers: { Accept: 'application/dns-json', Host: 'cloudflare-dns.com' }, rejectUnauthorized: true }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 65536) req.destroy(new Error('DoH response too large')); });
      res.on('error', fail);
      res.on('end', () => {
        if (settled) return;
        try {
          if (res.statusCode !== 200) throw new Error(`DoH HTTP ${res.statusCode}`);
          const data = JSON.parse(body);
          const record = data.Status === 0 && Array.isArray(data.Answer) && data.Answer.find(item => net.isIP(item.data) === family);
          if (!record) throw Object.assign(new Error('DoH returned no address'), { code: 'ENOTFOUND' });
          if (cache.size >= 500) cache.delete(cache.keys().next().value);
          cache.set(key, { address: record.data, expires: Date.now() + Math.min(cacheMs, Math.max(0, Number(record.TTL) || 0) * 1000) });
          settled = true; finish(record.data);
        } catch (error) { fail(error); }
      });
    });
    req.on('error', fail);
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('DoH lookup timed out'), { code: 'ETIMEDOUT' })));
    req.end();
  };
}

let proxyLookup;
function proxyDnsLookup() {
  if (String(process.env.OPENBROWSER_PROXY_DNS || '').toLowerCase() === 'system') return undefined;
  return proxyLookup ||= createDohLookup();
}
module.exports = { createDohLookup, proxyDnsLookup };
