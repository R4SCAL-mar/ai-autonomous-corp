async function updateRepoFile(ghRepo, ghToken, filePath, jsonObj, message) {
  const apiUrl = `https://api.github.com/repos/${ghRepo}/contents/${filePath}`;
  const headers = {
    Authorization: `Bearer ${ghToken}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json'
  };

  let sha;
  const getRes = await fetch(apiUrl, { headers });
  if (getRes.ok) {
    const existing = await getRes.json();
    sha = existing.sha;
  }

  const content = Buffer.from(JSON.stringify(jsonObj, null, 2)).toString('base64');
  await fetch(apiUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ message, content, ...(sha ? { sha } : {}) })
  });
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const contentType = event.headers['content-type'] || '';
    let amountIDR = 0;
    let sourceLabel = 'Direct';

    if (contentType.includes('application/x-www-form-urlencoded')) {
      // Format Gumroad Ping (satuan sen USD, misal 900 = $9.00)
      const params = new URLSearchParams(event.body);
      const centsUSD = Number(params.get('price') || 0);
      const usd = centsUSD / 100;
      amountIDR = Math.round(usd * 16000);
      sourceLabel = `Gumroad ($${usd.toFixed(2)})`;
    } else {
      // Format JSON Lynk.id / Mayar (satuan IDR)
      const payload = JSON.parse(event.body || '{}');
      amountIDR = Number(
        payload?.data?.message_data?.totals?.grandTotal ||
        payload?.amount ||
        payload?.price ||
        0
      );
      sourceLabel = 'Lynk.id (IDR)';
    }

    if (amountIDR <= 0) {
      return { statusCode: 200, body: 'Ignored zero amount' };
    }

    const { GH_TOKEN, GH_REPO } = process.env;
    const apiUrl = `https://api.github.com/repos/${GH_REPO}/contents/data/company-state.json`;
    const fileRes = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
    });
    const fileData = await fileRes.json();
    const state = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf-8'));

    // Tambah Total Kekayaan & Pecah Otomatis ke 4 Mesin Pertumbuhan
    state.finance.totalNetWorth += amountIDR;
    state.finance.buckets.safeYield += Math.round(amountIDR * 0.40);
    state.finance.buckets.assetExpansion += Math.round(amountIDR * 0.25);
    state.finance.buckets.quantTrading += Math.round(amountIDR * 0.20);
    state.finance.buckets.trafficArbitrage += Math.round(amountIDR * 0.15);
    state.lastUpdated = new Date().toISOString();

    state.weeklyLogs.unshift({
      timestamp: state.lastUpdated,
      summary: `[KAS MASUK - ${sourceLabel}] +Rp ${amountIDR.toLocaleString('id-ID')}`,
      treasuryStatus: `Total Kekayaan Baru: Rp ${state.finance.totalNetWorth.toLocaleString('id-ID')}`
    });

    const commitMsg = `finance(webhook): +Rp ${amountIDR} from ${sourceLabel}`;
    await updateRepoFile(GH_REPO, GH_TOKEN, 'data/company-state.json', state, commitMsg);
    await updateRepoFile(GH_REPO, GH_TOKEN, 'public/state.json', state, commitMsg);

    return { statusCode: 200, body: JSON.stringify({ status: 'recorded', amountIDR }) };
  } catch (err) {
    return { statusCode: 500, body: err.message };
  }
}
