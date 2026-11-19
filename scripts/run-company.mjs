import fs from 'node:fs';
import path from 'node:path';

const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const PAYMENT_USD = (process.env.PAYMENT_LINK_USD || ['https:/', 'maco24.gumroad.com'].join('/')).trim();
const PAYMENT_IDR = (process.env.PAYMENT_LINK_IDR || ['https:/', 'lynk.id', 'r4scal'].join('/')).trim();
const SITE_URL = (process.env.SITE_URL || ['https:/', 'automation112.netlify.app'].join('/')).trim();
const STATE_PATH = path.resolve('data/company-state.json');

const GROQ_BASE = ['https:/', 'api.groq.com', 'openai', 'v1'].join('/');
const GEMINI_BASE = ['https:/', 'generativelanguage.googleapis.com', 'v1beta'].join('/');

function safeParseJson(text) {
  const cleaned = text.replace(/^```json\s*|^```\s*|```$/gm, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1) {
    return JSON.parse(cleaned.slice(start, end + 1));
  }
  return JSON.parse(cleaned);
}

async function getActiveGroqModel() {
  const res = await fetch(`${GROQ_BASE}/models`, {
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` }
  });
  if (!res.ok) throw new Error(`Groq Models HTTP ${res.status}`);
  const data = await res.json();
  const models = (data.data || [])
    .map(m => m.id)
    .filter(id => !/whisper|tts|guard|embed|vision|orpheus|playai/i.test(id));
  const preferred = models.find(id => /llama-3\.3|llama-3\.1|qwen|gpt-oss|llama/i.test(id));
  return preferred || models[0];
}

async function getActiveGeminiModel() {
  const res = await fetch(`${GEMINI_BASE}/models?key=${GEMINI_API_KEY}`);
  if (!res.ok) throw new Error(`Gemini Models HTTP ${res.status}`);
  const data = await res.json();
  const models = (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''));
  return models.find(id => /flash/i.test(id)) || models.find(id => /gemini/i.test(id));
}

async function callGroq(systemInstruction, userPrompt, expectJson) {
  const model = await getActiveGroqModel();
  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.75,
      ...(expectJson ? { response_format: { type: 'json_object' } } : {})
    })
  });
  if (!res.ok) throw new Error(`Groq Chat HTTP ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function callGemini(systemInstruction, userPrompt, expectJson) {
  const model = await getActiveGeminiModel();
  const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemInstruction }] },
      contents: [{ parts: [{ text: userPrompt }] }],
      generationConfig: expectJson ? { responseMimeType: 'application/json' } : {}
    })
  });
  if (!res.ok) throw new Error(`Gemini Generate HTTP ${res.status}`);
  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
}

async function askDepartment(mode, systemInstruction, userPrompt, expectJson = true) {
  let rawText = '';
  try {
    rawText = mode === 'fast' && GROQ_API_KEY
      ? await callGroq(systemInstruction, userPrompt, expectJson)
      : await callGemini(systemInstruction, userPrompt, expectJson);
  } catch (primaryErr) {
    console.warn(`Fallback AI aktif (${mode}):`, primaryErr.message);
    rawText = mode === 'fast'
      ? await callGemini(systemInstruction, userPrompt, expectJson)
      : await callGroq(systemInstruction, userPrompt, expectJson);
  }
  return expectJson ? safeParseJson(rawText) : rawText;
}

function updateSeoFiles(ventures) {
  const today = new Date().toISOString().split('T')[0];
  const urls = [
    `<url><loc>${SITE_URL}/</loc><lastmod>${today}</lastmod><priority>1.0</priority></url>`,
    ...ventures.map(v => `<url><loc>${SITE_URL}${v.url}</loc><lastmod>${v.date || today}</lastmod><priority>0.8</priority></url>`)
  ];

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="[http://www.sitemaps.org/schemas/sitemap/0.9](http://www.sitemaps.org/schemas/sitemap/0.9)">\n  ${urls.join('\n  ')}\n</urlset>\n`;
  const robots = `User-agent: *\nAllow: /\nDisallow: /dashboard.html\nSitemap: ${SITE_URL}/sitemap.xml\n`;

  fs.writeFileSync(path.resolve('public/sitemap.xml'), sitemap);
  fs.writeFileSync(path.resolve('public/robots.txt'), robots);
}

async function runEnterpriseCycle() {
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  const now = new Date();
  const dayOfMonth = now.getUTCDate();

  // 1. TIM KEUANGAN: Kunci High-Water Mark tiap Tanggal 1 & Lock Akhir Bulan
  if (dayOfMonth === 1) {
    state.finance.highWaterMarkDate1 = Math.max(
      state.finance.highWaterMarkDate1,
      state.finance.totalNetWorth
    );
  }
  state.finance.isMonthEndLocked = dayOfMonth >= 28;

  // 2. TIM RISET & AI CEO: Bebas memilih sektor kerja (termasuk audit server security via API backend)
  const hasSecurityTool = state.activeVentures.some(v => /security|audit|server|ssl|header/i.test(v.sector + v.title));
  const priorityHint = hasSecurityTool
    ? 'Eksplorasi sektor baru yang belum pernah dibuat (misal: Server Security Audit, Micro-SaaS, Developer API Utility, SEO/Performance Analyzer, atau Business Calculator).'
    : 'PRIORITAS HARI INI: Bangun layanan di sektor Server & Website Security Audit yang memanfaatkan endpoint backend "/.netlify/functions/security-recon" untuk memindai keamanan domain pengguna secara real-time.';

  const ceoDecision = await askDepartment(
    'fast',
    `Anda adalah AI CEO perusahaan digital otonom tanpa batas sektor (Global USD & Indonesia IDR). Perusahaan Anda memiliki endpoint backend aktif di "/.netlify/functions/security-recon" (POST JSON {"domain": "example.com"} atau GET "?domain=example.com") yang mengembalikan skor keamanan HTTP headers, HTTPS, dan DNS SPF/DMARC secara real-time. Biaya operasional wajib Rp 0.`,
    `Saldo saat ini: Rp ${state.finance.totalNetWorth}. Proyek yang sudah ada: ${JSON.stringify(state.activeVentures.slice(-8))}.
    ${priorityHint}
    Kembalikan JSON valid:
    {
      "sector": "nama sektor pekerjaan",
      "slug": "nama-file-huruf-kecil-tanpa-spasi",
      "title": "Judul Produk atau Layanan",
      "targetMarket": "Global (USD) / Indonesia (IDR)",
      "priceLabel": "Harga jual (misal: $12 atau Rp 150.000)",
      "marketingCopy": "1 paragraf promosi singkat dan persuasif",
      "usesSecurityApi": true,
      "toolSpec": "Deskripsi lengkap fitur interaktif halaman web yang akan dibangun tim developer"
    }`,
    true
  );

  // 3. TIM PENGEMBANGAN & PRODUKSI: Merakit halaman web produk/layanan nyata
  const apiInstruction = ceoDecision.usesSecurityApi
    ? `PENTING: Halaman web ini WAJIB memiliki form input domain dan tombol "Scan Keamanan Sekarang" yang memanggil fetch('/.netlify/functions/security-recon', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain }) }) lalu menampilkan skor (0-100), grade (A-F), status tiap security header, status DNS SPF/DMARC, dan daftar rekomendasi perbaikan secara interaktif!`
    : '';

  const htmlProduct = await askDepartment(
    'builder',
    `Anda adalah Senior Full-Stack Developer. Buat 1 file HTML lengkap (CSS modern dark-mode responsif + JavaScript fungsional yang benar-benar bekerja di browser pengguna) sesuai spesifikasi. ${apiInstruction} Sertakan bagian penawaran jelas dengan dua tombol pembayaran: "Akses Pro / Full Audit Report (USD)" menuju "${PAYMENT_USD}" dan "Bayar QRIS / E-Wallet (IDR)" menuju "${PAYMENT_IDR}", serta link kembali ke "/index.html". Kembalikan HANYA kode HTML murni tanpa markdown backticks.`,
    `Judul: ${ceoDecision.title}. Sektor: ${ceoDecision.sector}. Spesifikasi: ${ceoDecision.toolSpec}. Harga: ${ceoDecision.priceLabel}.`,
    false
  );

  const cleanHtml = htmlProduct.replace(/^```html\s*|```$/gm, '').trim();
  const safeSlug = ceoDecision.slug.toLowerCase().replace(/[^a-z0-9-]/g, '') || `venture-${Date.now()}`;
  fs.mkdirSync(path.resolve('public/tools'), { recursive: true });
  fs.writeFileSync(path.resolve(`public/tools/${safeSlug}.html`), cleanHtml);

  // 4. TIM TREASURY, SEO & SEKRETARIS: Update Sitemap & Catat Laporan
  const treasuryStatus = state.finance.isMonthEndLocked
    ? 'Mode Pengamanan Akhir Bulan (Tgl 28-31): Dana dikunci di Safe Yield menjelang Tgl 1.'
    : state.finance.totalNetWorth > 0
      ? `Alokasi aktif -> Safe Yield: Rp ${state.finance.buckets.safeYield.toLocaleString('id-ID')} | Ekspansi: Rp ${state.finance.buckets.assetExpansion.toLocaleString('id-ID')} | Trading: Rp ${state.finance.buckets.quantTrading.toLocaleString('id-ID')}`
      : 'Mode Bootstrapping Rp 0: Fokus memproduksi aset & mendatangkan transaksi pertama.';

  state.activeVentures.push({
    date: now.toISOString().split('T')[0],
    sector: ceoDecision.sector,
    title: ceoDecision.title,
    url: `/tools/${safeSlug}.html`,
    market: ceoDecision.targetMarket,
    price: ceoDecision.priceLabel,
    promo: ceoDecision.marketingCopy
  });

  state.weeklyLogs.unshift({
    timestamp: now.toISOString(),
    summary: `[${ceoDecision.sector}] Merilis "${ceoDecision.title}" (${ceoDecision.priceLabel})`,
    treasuryStatus
  });

  state.weeklyLogs = state.weeklyLogs.slice(0, 40);
  state.lastUpdated = now.toISOString();

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  fs.writeFileSync(path.resolve('public/state.json'), JSON.stringify(state, null, 2));
  updateSeoFiles(state.activeVentures);
  console.log('Siklus selesai:', ceoDecision.title);
}

runEnterpriseCycle();
