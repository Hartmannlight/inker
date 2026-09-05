// This trusted function's source is evaluated only inside QuickJS, after the
// browser bundle. It must not capture host imports, globals, functions or handles.
interface GuestLiquidEngine {
  registerTag(name: string, implementation: { parse(): never; render(): never }): void;
  registerFilter(name: string, filter: (...values: never[]) => unknown): void;
}

interface GuestLiquidConstructor {
  new(options: Record<string, unknown>): GuestLiquidEngine;
}

declare const liquidjs: { Liquid: GuestLiquidConstructor };
export function makeLiquid() {
  const liquid = new liquidjs.Liquid({
    strictVariables: false, strictFilters: false, ownPropertyOnly: true,
    relativeReference: false, locale: 'en-US',
    parseLimit: 131072, renderLimit: 1000, memoryLimit: 262144,
    fs: {
      readFile() { throw new Error('ISOLATION_FAILED'); },
      readFileSync() { throw new Error('ISOLATION_FAILED'); },
      exists() { return false; }, existsSync() { return false; },
      resolve() { throw new Error('ISOLATION_FAILED'); },
      dirname() { throw new Error('ISOLATION_FAILED'); },
      contains() { return false; },
    },
  });
  for (const tag of ['include', 'render', 'layout']) {
    liquid.registerTag(tag, {
      parse() { throw new Error('ISOLATION_FAILED'); },
      render() { throw new Error('ISOLATION_FAILED'); },
    });
  }
  liquid.registerFilter('where_exp', () => { throw new Error('ISOLATION_FAILED'); });
  liquid.registerFilter('number_with_delimiter', (value: unknown, delimiter: string = ',', separator: string = '.') => {
    if (value == null) return '';
    const parts = String(value).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, delimiter);
    return parts.join(separator);
  });
  liquid.registerFilter('number_to_currency', (value: unknown, unit: string = '$', delimiter: string = ',', separator: string = '.', precision: number = 2) => {
    if (value == null) return '';
    const num = Number(value);
    if (isNaN(num)) return String(value);
    const parts = num.toFixed(precision).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, delimiter);
    return String(unit) + parts.join(separator);
  });
  liquid.registerFilter('days_ago', (value: unknown, _timezone: string = 'UTC') => {
    const date = new Date();
    date.setDate(date.getDate() - (Number(value) || 0));
    return date.toISOString().split('T')[0];
  });
  liquid.registerFilter('pluralize', (singular: unknown, count: unknown, options?: unknown) => {
    const n = Number(count) || 0;
    const plural = typeof options === 'object' && options !== null && 'plural' in options
      ? String(options.plural) : String(singular) + 's';
    return n + ' ' + (n === 1 ? String(singular) : plural);
  });
  liquid.registerFilter('group_by', (collection: unknown, key: string = '') => {
    const groups: Record<string, unknown[]> = Object.create(null);
    if (!Array.isArray(collection)) return groups;
    for (const item of collection) {
      const name = typeof item === 'object' && item !== null
        ? String((item as Record<string, unknown>)[key] ?? '') : '';
      if (!groups[name]) groups[name] = [];
      groups[name].push(item);
    }
    return groups;
  });
  liquid.registerFilter('find_by', (collection: unknown, key: string = '', value?: unknown, fallback?: unknown) => {
    if (!Array.isArray(collection)) return fallback ?? null;
    return collection.find(item => typeof item === 'object' && item !== null
      && (item as Record<string, unknown>)[key] == value) ?? fallback ?? null;
  });
  liquid.registerFilter('json', (value: unknown) => {
    try { return JSON.stringify(value); } catch { return ''; }
  });
  liquid.registerFilter('parse_json', (value: unknown) => {
    try { return JSON.parse(String(value)); } catch { return null; }
  });
  liquid.registerFilter('append_random', (value: unknown) => String(value ?? '') + Math.random().toString(16).slice(2, 6));
  liquid.registerFilter('sample', (arr: unknown) => {
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr[Math.floor(Math.random() * arr.length)];
  });
  liquid.registerFilter('map_to_i', (arr: unknown) => {
    if (!Array.isArray(arr)) return arr;
    return arr.map(value => parseInt(String(value), 10) || 0);
  });
  liquid.registerFilter('ordinalize', (value: unknown, format?: unknown) => {
    const date = new Date(String(value));
    if (isNaN(date.getTime())) return String(value);
    const day = date.getDate();
    const suffix = [11, 12, 13].includes(day % 100) ? 'th'
      : day % 10 === 1 ? 'st' : day % 10 === 2 ? 'nd' : day % 10 === 3 ? 'rd' : 'th';
    if (typeof format !== 'string' || !format) return day + suffix;
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return format.replace('<<ordinal_day>>', day + suffix)
      .replace('%A', weekdays[date.getDay()]).replace('%B', months[date.getMonth()])
      .replace('%Y', String(date.getFullYear())).replace('%y', String(date.getFullYear()).slice(-2))
      .replace('%m', String(date.getMonth() + 1).padStart(2, '0')).replace('%d', String(day).padStart(2, '0'));
  });
  liquid.registerFilter('l_date', (value: unknown, format?: unknown, locale: string = 'en') => {
    const date = value === 'now' || value === 'today' ? new Date()
      : typeof value === 'number' && value > 1e9 ? new Date(value * 1000) : new Date(String(value));
    if (isNaN(date.getTime())) return String(value);
    if (typeof format !== 'string' || !format) return date.toLocaleDateString(String(locale));
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const fullMonths = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return format.replace('%Y', String(date.getFullYear())).replace('%y', String(date.getFullYear()).slice(-2))
      .replace('%B', fullMonths[date.getMonth()]).replace('%b', months[date.getMonth()])
      .replace('%A', ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][date.getDay()])
      .replace('%a', weekdays[date.getDay()]).replace('%m', String(date.getMonth() + 1).padStart(2, '0'))
      .replace('%d', String(date.getDate()).padStart(2, '0')).replace('%H', String(date.getHours()).padStart(2, '0'))
      .replace('%M', String(date.getMinutes()).padStart(2, '0')).replace('%S', String(date.getSeconds()).padStart(2, '0'))
      .replace('%I', String(date.getHours() % 12 || 12).padStart(2, '0')).replace('%p', date.getHours() >= 12 ? 'PM' : 'AM');
  });
  return liquid;
}
