'use strict';
const assert = require('assert/strict');
const { EventEmitter } = require('events');
const { createDohLookup, proxyDnsLookup } = require('./doh-resolver');

function mockRequest(response, calls) {
  return (options, onResponse) => {
    calls.push(options);
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = error => request.emit('error', error);
    request.end = () => process.nextTick(() => {
      const result = new EventEmitter(); result.statusCode = 200; result.setEncoding = () => {};
      onResponse(result); result.emit('data', JSON.stringify(response)); result.emit('end');
    });
    return request;
  };
}
function lookup(fn, host, options = {}) {
  return new Promise((resolve, reject) => fn(host, options, (error, address, family) => error ? reject(error) : resolve({ address, family })));
}
(async () => {
  const calls = [];
  const resolve = createDohLookup({ request: mockRequest({ Status: 0, Answer: [{ data: '192.0.2.42', TTL: 60 }] }, calls) });
  assert.deepEqual(await lookup(resolve, 'proxy.example'), { address: '192.0.2.42', family: 4 });
  assert.deepEqual(await lookup(resolve, 'proxy.example', { all: true }), { address: [{ address: '192.0.2.42', family: 4 }], family: undefined });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hostname, '1.1.1.1');
  assert.equal(calls[0].servername, 'cloudflare-dns.com');
  assert.deepEqual(await lookup(resolve, 'localhost'), { address: '127.0.0.1', family: 4 });
  assert.equal(calls.length, 1);
  const oldMode = process.env.OPENBROWSER_PROXY_DNS;
  delete process.env.OPENBROWSER_PROXY_DNS;
  assert.equal(typeof proxyDnsLookup(), 'function');
  process.env.OPENBROWSER_PROXY_DNS = 'system';
  assert.equal(proxyDnsLookup(), undefined);
  if (oldMode === undefined) delete process.env.OPENBROWSER_PROXY_DNS; else process.env.OPENBROWSER_PROXY_DNS = oldMode;
  const missing = createDohLookup({ request: mockRequest({ Status: 3 }, []) });
  await assert.rejects(lookup(missing, 'missing.example'), { code: 'ENOTFOUND' });
  console.log('doh-resolver-selftest: ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
