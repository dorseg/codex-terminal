const INTERNAL_PORTS = new Set([7681, 7682]);

export function appPorts(value = '') {
  if (!value.trim()) return new Set();
  const ports = value.split(',').map(part => part.trim());
  if (ports.some(port => !/^[1-9]\d*$/.test(port) || Number(port) < 1024 || Number(port) > 65535 || INTERNAL_PORTS.has(Number(port)))) {
    throw new Error('APP_PORTS must contain comma-separated ports from 1024 to 65535, excluding 7681 and 7682.');
  }
  return new Set(ports.map(Number));
}

export function appRoute(url, ports) {
  const pathname = url.split('?')[0];
  if (pathname !== '/apps' && !pathname.startsWith('/apps/')) return null;
  const match = /^\/apps\/([1-9]\d*)(\/.*)?$/.exec(pathname);
  if (!match || !ports.has(Number(match[1])) || /[\\\x00-\x20\x7f]/.test(url)) return { invalid: true };
  // Reject paths a browser would normalize into another route.
  try {
    if (new URL(url, 'http://localhost').pathname !== pathname) return { invalid: true };
    if (pathname.split('/').some(segment => /[\/\\]/.test(decodeURIComponent(segment)))) return { invalid: true };
  } catch { return { invalid: true }; }
  return { port: Number(match[1]), redirect: !match[2] };
}
