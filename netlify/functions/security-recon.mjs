import dns from 'node:dns/promises';
import net from 'node:net';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(payload)
  };
}

function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80')
    );
  }
  return true;
}

function normalizeHostname(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return null;
  let cleaned = rawInput.trim().toLowerCase();
  cleaned = cleaned.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  if (!cleaned || cleaned.length > 253) return null;
  if (net.isIP(cleaned)) return null;
  if (cleaned === 'localhost' || cleaned.endsWith('.local') || cleaned.endsWith('.internal')) {
    return null;
  }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(cleaned)) return null;
  return cleaned;
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  try {
    let rawDomain = event.queryStringParameters?.domain || '';
    if (!rawDomain && event.body) {
      const parsed = JSON.parse(event.body);
      rawDomain = parsed.domain || '';
    }

    const hostname = normalizeHostname(rawDomain);
    if (!hostname) {
      return jsonResponse(400, { error: 'Masukkan nama domain publik yang valid (contoh: example.com).' });
    }

    const addresses = await dns.lookup(hostname, { all: true }).catch(() => []);
    if (!addresses.length || addresses.some(a => isPrivateIP(a.address))) {
      return jsonResponse(400, { error: 'Domain tidak ditemukan atau mengarah ke alamat jaringan privat.' });
    }

    const targetUrl = ['https:/', hostname].join('/');
    const res = await fetch(targetUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(7000),
      headers: { 'User-Agent': 'AutonomousSecurityAuditBot/1.0' }
    });

    const h = res.headers;
    const headerChecks = [
      {
        name: 'Strict-Transport-Security (HSTS)',
        present: Boolean(h.get('strict-transport-security')),
        weight: 20,
        advice: 'Aktifkan header HSTS agar browser selalu memaksa koneksi HTTPS terenkripsi.'
      },
      {
        name: 'Content-Security-Policy (CSP)',
        present: Boolean(h.get('content-security-policy')),
        weight: 20,
        advice: 'Tambahkan CSP untuk mencegah serangan injeksi skrip (XSS) dan pemuatan aset asing.'
      },
      {
        name: 'X-Frame-Options',
        present: Boolean(h.get('x-frame-options')),
        weight: 15,
        advice: 'Setel X-Frame-Options ke DENY atau SAMEORIGIN untuk mencegah serangan Clickjacking.'
      },
      {
        name: 'X-Content-Type-Options',
        present: (h.get('x-content-type-options') || '').toLowerCase() === 'nosniff',
        weight: 15,
        advice: 'Setel X-Content-Type-Options: nosniff agar browser tidak menebak tipe MIME secara sembarangan.'
      },
      {
        name: 'Referrer-Policy',
        present: Boolean(h.get('referrer-policy')),
        weight: 10,
        advice: 'Konfigurasikan Referrer-Policy untuk membatasi kebocoran URL sensitif ke situs eksternal.'
      },
      {
        name: 'Permissions-Policy',
        present: Boolean(h.get('permissions-policy')),
        weight: 10,
        advice: 'Batasi akses fitur browser (kamera, mikrofon, lokasi) melalui Permissions-Policy.'
      }
    ];

    let hasSPF = false;
    let hasDMARC = false;
    try {
      const txt = await dns.resolveTxt(hostname);
      hasSPF = txt.flat().some(line => line.toLowerCase().includes('v=spf1'));
    } catch {}
    try {
      const dmarc = await dns.resolveTxt(`_dmarc.${hostname}`);
      hasDMARC = dmarc.flat().some(line => line.toLowerCase().includes('v=dmarc1'));
    } catch {}

    let score = headerChecks.reduce((acc, item) => acc + (item.present ? item.weight : 0), 0);
    if (hasSPF) score += 5;
    if (hasDMARC) score += 5;

    const grade =
      score >= 90 ? 'A' :
      score >= 75 ? 'B' :
      score >= 55 ? 'C' :
      score >= 35 ? 'D' : 'F';

    const recommendations = headerChecks.filter(i => !i.present).map(i => i.advice);
    if (!hasSPF) recommendations.push('Tambahkan DNS TXT record SPF (v=spf1) untuk mencegah pemalsuan email domain.');
    if (!hasDMARC) recommendations.push('Tambahkan DNS TXT record _dmarc (v=DMARC1) untuk perlindungan anti-spoofing email.');

    return jsonResponse(200, {
      domain: hostname,
      finalUrl: res.url,
      httpStatus: res.status,
      score,
      grade,
      serverExposure: {
        server: h.get('server') || 'Tersembunyi',
        poweredBy: h.get('x-powered-by') || 'Tersembunyi'
      },
      headers: headerChecks.map(({ name, present }) => ({ name, present })),
      dnsSecurity: { spf: hasSPF, dmarc: hasDMARC },
      recommendations
    });
  } catch (err) {
    return jsonResponse(502, {
      error: `Gagal terhubung ke domain target: ${err.message}`
    });
  }
}
