// This trusted function's source is evaluated only inside QuickJS, after the
// browser bundle. It must not capture host imports, globals, functions or handles.
declare const liquidjs: any;
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
  liquid.registerFilter('number_with_delimiter', (value: any, delimiter = ',', separator = '.') => {
    if (value == null) return '';
    const parts = String(value).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, delimiter);
    return parts.join(separator);
  });
  liquid.registerFilter('number_to_currency', (value: any, unit = '$', delimiter = ',', separator = '.', precision = 2) => {
    if (value == null) return '';
    const num = Number(value);
    if (isNaN(num)) return String(value);
    const parts = num.toFixed(precision).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, delimiter);
    return String(unit) + parts.join(separator);
  });
  liquid.registerFilter('days_ago', (value: any, _timezone = 'UTC') => {
    const date = new Date();
    date.setDate(date.getDate() - (Number(value) || 0));
    return date.toISOString().split('T')[0];
  });
  liquid.registerFilter('pluralize', (singular: any, count: any, options?: any) => {
    const n = Number(count) || 0;
    return n + ' ' + (n === 1 ? singular : (options?.plural || String(singular) + 's'));
  });
  liquid.registerFilter('group_by', (collection: any, key: string) => {
    const groups = Object.create(null);
    if (!Array.isArray(collection)) return groups;
    for (const item of collection) {
      const name = String(item?.[key] ?? '');
      if (!groups[name]) groups[name] = [];
      groups[name].push(item);
    }
    return groups;
  });
  liquid.registerFilter('find_by', (collection: any, key: string, value: any, fallback?: any) => {
    if (!Array.isArray(collection)) return fallback ?? null;
    return collection.find(item => item?.[key] == value) ?? fallback ?? null;
  });
  liquid.registerFilter('json', (value: any) => {
    try { return JSON.stringify(value); } catch { return ''; }
  });
  liquid.registerFilter('parse_json', (value: any) => {
    try { return JSON.parse(String(value)); } catch { return null; }
  });
  liquid.registerFilter('append_random', (value: any) => String(value ?? '') + Math.random().toString(16).slice(2, 6));
  liquid.registerFilter('sample', (arr: any) => {
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr[Math.floor(Math.random() * arr.length)];
  });
  liquid.registerFilter('map_to_i', (arr: any) => {
    if (!Array.isArray(arr)) return arr;
    return arr.map(value => parseInt(String(value), 10) || 0);
  });
  liquid.registerFilter('ordinalize', (value: any, format?: string) => {
    const date = new Date(String(value));
    if (isNaN(date.getTime())) return String(value);
    const day = date.getDate();
    const suffix = [11, 12, 13].includes(day % 100) ? 'th'
      : day % 10 === 1 ? 'st' : day % 10 === 2 ? 'nd' : day % 10 === 3 ? 'rd' : 'th';
    if (!format) return day + suffix;
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return format.replace('<<ordinal_day>>', day + suffix)
      .replace('%A', weekdays[date.getDay()]).replace('%B', months[date.getMonth()])
      .replace('%Y', String(date.getFullYear())).replace('%y', String(date.getFullYear()).slice(-2))
      .replace('%m', String(date.getMonth() + 1).padStart(2, '0')).replace('%d', String(day).padStart(2, '0'));
  });
  liquid.registerFilter('l_date', (value: any, format?: string, locale = 'en') => {
    const date = value === 'now' || value === 'today' ? new Date()
      : typeof value === 'number' && value > 1e9 ? new Date(value * 1000) : new Date(String(value));
    if (isNaN(date.getTime())) return String(value);
    if (!format) return date.toLocaleDateString(locale);
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
