'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

const EXPLICIT_PROXY_ENV = 'OPENBROWSER_KERNEL_PROXY';
const HTTPS_PROXY_KEYS = Object.freeze([
  EXPLICIT_PROXY_ENV,
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'HTTP_PROXY',
  'http_proxy',
]);
const HTTP_PROXY_KEYS = Object.freeze([
  EXPLICIT_PROXY_ENV,
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'HTTPS_PROXY',
  'https_proxy',
]);
const TLS_OPTION_KEYS = Object.freeze([
  'servername',
  'ca',
  'cert',
  'key',
  'pfx',
  'passphrase',
  'rejectUnauthorized',
  'checkServerIdentity',
  'minVersion',
  'maxVersion',
  'ciphers',
  'secureProtocol',
  'ALPNProtocols',
]);

function stripIpv6Brackets(hostname) {
  return String(hostname || '').replace(/^\[|\]$/g, '');
}

function defaultPort(protocol) {
  return protocol === 'https:' ? 443 : 80;
}

function normalizeProxyUrl(value, source = 'proxy') {
  let text = String(value || '').trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'http://' + text;
  let parsed;
  try {
    parsed = new URL(text);
  } catch (_) {
    throw new Error(`${source} is not a valid proxy URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(`${source} must be an HTTP or HTTPS forward proxy`);
  }
  return parsed;
}

function proxyEnvValue(env, keys) {
  for (const key of keys) {
    const value = String(env?.[key] || '').trim();
    if (value) return { value, source: key };
  }
  return null;
}

function splitNoProxyPort(rule) {
  if (rule.startsWith('[')) {
    const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(rule);
    return match ? { host: match[1], port: match[2] || '' } : null;
  }
  const colon = rule.lastIndexOf(':');
  if (colon > 0 && rule.indexOf(':') === colon && /^\d+$/.test(rule.slice(colon + 1))) {
    return { host: rule.slice(0, colon), port: rule.slice(colon + 1) };
  }
  return { host: rule, port: '' };
}

function shouldBypassProxy(target, env) {
  const raw = String(env?.NO_PROXY || env?.no_proxy || '').trim();
  if (!raw) return false;
  const host = stripIpv6Brackets(target.hostname).toLowerCase();
  const port = target.port || String(defaultPort(target.protocol));
  for (const item of raw.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)) {
    if (item === '*') return true;
    let rule = item;
    if (rule.includes('://')) {
      try {
        const parsed = new URL(rule);
        rule = parsed.host;
      } catch (_) {
        continue;
      }
    }
    const split = splitNoProxyPort(rule);
    if (!split || (split.port && split.port !== port)) continue;
    const candidate = split.host.replace(/^(?:\*\.)?\.?/, '');
    if (!candidate) continue;
    if (host === candidate || host.endsWith('.' + candidate)) return true;
  }
  return false;
}

function proxyForUrl(value, env = process.env) {
  const target = value instanceof URL ? value : new URL(value);
  if (!['http:', 'https:'].includes(target.protocol) || shouldBypassProxy(target, env)) return null;
  const matched = proxyEnvValue(env, target.protocol === 'https:' ? HTTPS_PROXY_KEYS : HTTP_PROXY_KEYS);
  return matched ? normalizeProxyUrl(matched.value, matched.source) : null;
}

function proxyAuthorization(proxy) {
  if (!proxy.username && !proxy.password) return '';
  const decode = (value) => {
    try { return decodeURIComponent(value); } catch (_) { return value; }
  };
  const credentials = `${decode(proxy.username)}:${decode(proxy.password)}`;
  return 'Basic ' + Buffer.from(credentials, 'utf8').toString('base64');
}

function targetAuthority(target) {
  const host = target.hostname.includes(':') ? `[${stripIpv6Brackets(target.hostname)}]` : target.hostname;
  return `${host}:${target.port || defaultPort(target.protocol)}`;
}

function requestOptions(options = {}, timeout) {
  const result = {
    headers: { ...(options.headers || {}) },
    timeout,
  };
  for (const key of TLS_OPTION_KEYS) {
    if (options[key] !== undefined) result[key] = options[key];
  }
  if (options.lookup) result.lookup = options.lookup;
  return result;
}

function attachRequestHandlers(req, reject, label) {
  req.once('timeout', () => req.destroy(new Error(`${label} timed out`)));
  req.once('error', reject);
}

function directRequest(target, options) {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http;
    let req;
    try {
      req = transport.get(target, options, resolve);
    } catch (error) {
      reject(error);
      return;
    }
    attachRequestHandlers(req, reject, 'Kernel network request');
  });
}

function requestHttpViaProxy(target, proxy, options) {
  return new Promise((resolve, reject) => {
    const transport = proxy.protocol === 'https:' ? https : http;
    const headers = {
      ...options.headers,
      Host: target.host,
    };
    const authorization = proxyAuthorization(proxy);
    if (authorization) headers['Proxy-Authorization'] = authorization;
    const proxyOptions = {
      protocol: proxy.protocol,
      hostname: stripIpv6Brackets(proxy.hostname),
      port: Number(proxy.port) || defaultPort(proxy.protocol),
      method: 'GET',
      path: target.href,
      headers,
      timeout: options.timeout,
    };
    if (proxy.protocol === 'https:') proxyOptions.servername = stripIpv6Brackets(proxy.hostname);
    let req;
    try {
      req = transport.get(proxyOptions, resolve);
    } catch (error) {
      reject(error);
      return;
    }
    attachRequestHandlers(req, reject, 'Kernel proxy request');
  });
}

function connectProxyAuthority(target, proxy, timeout) {
  return new Promise((resolve, reject) => {
    const transport = proxy.protocol === 'https:' ? https : http;
    const authority = targetAuthority(target);
    const headers = {
      Host: authority,
      'Proxy-Connection': 'keep-alive',
    };
    const authorization = proxyAuthorization(proxy);
    if (authorization) headers['Proxy-Authorization'] = authorization;
    const connectOptions = {
      protocol: proxy.protocol,
      hostname: stripIpv6Brackets(proxy.hostname),
      port: Number(proxy.port) || defaultPort(proxy.protocol),
      method: 'CONNECT',
      path: authority,
      headers,
      timeout,
    };
    if (proxy.protocol === 'https:') connectOptions.servername = stripIpv6Brackets(proxy.hostname);
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };
    let req;
    try {
      req = transport.request(connectOptions, (res) => {
        res.resume();
        finish(reject, new Error(`Proxy CONNECT failed with HTTP ${res.statusCode}`));
        req.destroy();
      });
    } catch (error) {
      reject(error);
      return;
    }
    req.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        const authHint = res.statusCode === 407 ? ' (proxy authentication required)' : '';
        finish(reject, new Error(`Proxy CONNECT failed${authHint} with HTTP ${res.statusCode}`));
        return;
      }
      if (head?.length) socket.unshift(head);
      finish(resolve, socket);
    });
    attachRequestHandlers(req, (error) => finish(reject, error), 'Kernel proxy CONNECT');
    req.end();
  });
}

class SingleTunnelAgent extends https.Agent {
  constructor(socket, target, options) {
    super({ keepAlive: false });
    this.tunnelSocket = socket;
    this.target = target;
    this.tlsOptions = {};
    for (const key of TLS_OPTION_KEYS) {
      if (options[key] !== undefined) this.tlsOptions[key] = options[key];
    }
  }

  createConnection(options, callback) {
    const tlsOptions = {
      ...this.tlsOptions,
      socket: this.tunnelSocket,
      servername: this.tlsOptions.servername
        || (net.isIP(stripIpv6Brackets(this.target.hostname)) ? '' : stripIpv6Brackets(this.target.hostname)),
    };
    return tls.connect(tlsOptions, callback);
  }

  getName() {
    return 'openbrowser-single-tunnel';
  }
}

async function requestHttpsViaProxy(target, proxy, options) {
  const tunnelSocket = await connectProxyAuthority(target, proxy, options.timeout);
  return new Promise((resolve, reject) => {
    const agent = new SingleTunnelAgent(tunnelSocket, target, options);
    let req;
    try {
      req = https.get(target, { ...options, agent }, resolve);
    } catch (error) {
      tunnelSocket.destroy();
      reject(error);
      return;
    }
    attachRequestHandlers(req, (error) => {
      tunnelSocket.destroy();
      reject(error);
    }, 'Kernel HTTPS request');
  });
}

async function requestUrl(value, options = {}) {
  const target = value instanceof URL ? new URL(value.toString()) : new URL(value);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error(`Unsupported URL protocol: ${target.protocol}`);
  }
  const env = options.env || process.env;
  const proxy = Object.prototype.hasOwnProperty.call(options, 'proxy')
    ? normalizeProxyUrl(options.proxy, 'proxy option')
    : proxyForUrl(target, env);
  const timeout = Number(options.timeout) || 60000;
  const normalized = requestOptions(options, timeout);
  if (!proxy) return directRequest(target, normalized);
  if (target.protocol === 'http:') return requestHttpViaProxy(target, proxy, normalized);
  return requestHttpsViaProxy(target, proxy, normalized);
}

module.exports = {
  EXPLICIT_PROXY_ENV,
  proxyForUrl,
  normalizeProxyUrl,
  shouldBypassProxy,
  requestUrl,
};
