import fs from 'node:fs';
import path from 'node:path';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PAYMENT_USD = process.env.PAYMENT_LINK_USD || 'https://maco24.gumroad.com';
const PAYMENT_IDR = process.env.PAYMENT_LINK_IDR || 'https://lynk.id/r4scal';
const STATE_PATH = path.resolve('data/company-state.json');

function safeParseJson(text) {
  const cleaned = text.replace(/^```json\s*|^```\s*|```$/gm, '').trim();
  return JSON.parse(cleaned);
}

async function callGroq(systemInstruction, userPrompt, expectJson) {
  const res = await fetch('[https://api.groq.com/openai/v1/chat/completions](https://api.groq.com/openai/v1/chat/completions)', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.75,
      ...(expectJson ? { response_format: { type: 'json_object' } } : {})
    })
  });
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function callGemini(systemInstruction, userPrompt, expectJson) {
  const url = `[https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$](https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$){GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemInstruction }] },
      contents: [{ parts: [{ text: userPrompt }] }],
      generationConfig: expectJson ? { responseMimeType: 'application/json' } : {}
    })
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
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

  // 2. TIM RISET & AI CEO: Bebas memilih sektor kerja apa pun di internet
  const ceoDecision = await askDepartment(
    'fast',
    `Anda adalah AI CEO perusahaan digital otonom tanpa batas sektor dan wilayah (Global USD & Indonesia IDR). Anda bebas membangun alat audit keamanan server/website pasif, micro-SaaS, kalkulator bisnis, generator dokumen, direktori afiliasi, atau produk digital spesifik. Biaya produksi wajib Rp 0.`,
    `Saldo saat ini: Rp ${state.finance.totalNetWorth}. Proyek yang sudah ada: ${JSON.stringify(state.activeVentures.slice(-6))}.
    Tentukan 1 lini pekerjaan atau produk baru yang berbeda dari sebelumnya dan paling cepat menghasilkan uang hari ini.
    Kembalikan JSON valid:
    {
      "sector": "nama sektor pekerjaan",
      "slug": "nama-file-huruf-kecil-tanpa-spasi",
      "title": "Judul Produk atau Layanan",
      "targetMarket": "Global (USD) / Indonesia (IDR)",
      "priceLabel": "Harga jual (misal: $9 atau Rp 25.000)",
      "marketingCopy": "1 paragraf promosi singkat dan persuasif",
      "toolSpec": "Deskripsi lengkap fitur interaktif halaman web yang akan dibangun tim developer"
    }`,
    true
  );

  // 3. TIM PENGEMBANGAN & PRODUKSI: Merakit halaman web produk/alat nyata
  const htmlProduct = await askDepartment(
    'builder',
    `Anda adalah Senior Full-Stack Developer. Buat 1 file HTML lengkap (CSS modern dark-mode responsif + JavaScript fungsional yang benar-benar bekerja di browser pengguna) sesuai spesifikasi. Sertakan bagian penawaran jelas dengan dua tombol pembayaran: "Akses Pro Global (USD)" menuju "${PAYMENT_USD}" dan "Bayar QRIS / E-Wallet (IDR)" menuju "${PAYMENT_IDR}", serta link kembali ke "/index.html". Kembalikan HANYA kode HTML murni tanpa markdown backticks.`,
    `Judul: ${ceoDecision.title}. Sektor: ${ceoDecision.sector}. Spesifikasi: ${ceoDecision.toolSpec}. Harga: ${ceoDecision.priceLabel}.`,
    false
  );

  const cleanHtml = htmlProduct.replace(/^```html\s*|```$/gm, '').trim();
  const safeSlug = ceoDecision.slug.toLowerCase().replace(/[^a-z0-9-]/g, '') || `venture-${Date.now()}`;
  fs.mkdirSync(path.resolve('public/tools'), { recursive: true });
  fs.writeFileSync(path.resolve(`public/tools/${safeSlug}.html`), cleanHtml);

  // 4. TIM TREASURY & SEKRETARIS: Catat laporan & evaluasi alokasi dana
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
  console.log('Siklus selesai:', ceoDecision.title);
}

runEnterpriseCycle();
