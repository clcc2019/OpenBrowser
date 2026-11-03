'use strict';

// Chromium reads repeated switches inconsistently. Merge list-valued switches
// while retaining the first value of scalar switches and positional arguments.
function mergeLaunchArgs(...groups) {
  const result = [];
  const indexes = new Map();
  const listFlags = new Set(['--enable-features', '--disable-features', '--disable-blink-features']);
  for (const arg of groups.flat()) {
    if (typeof arg !== 'string' || !arg) continue;
    if (!arg.startsWith('--')) { result.push(arg); continue; }
    const equal = arg.indexOf('=');
    const name = equal < 0 ? arg : arg.slice(0, equal);
    if (!indexes.has(name)) { indexes.set(name, result.length); result.push(arg); continue; }
    if (!listFlags.has(name) || equal < 0) continue;
    const index = indexes.get(name);
    const previous = result[index].indexOf('=');
    const values = previous < 0 ? [] : result[index].slice(previous + 1).split(',').filter(Boolean);
    for (const value of arg.slice(equal + 1).split(',').filter(Boolean)) {
      if (!values.includes(value)) values.push(value);
    }
    if (values.length) result[index] = `${name}=${values.join(',')}`;
  }
  return result;
}

module.exports = { mergeLaunchArgs };
