/**
 * TikTok OAuth Callback Handler
 * 
 * This catches the redirect from TikTok after a user authorizes,
 * exchanges the auth code for an access token, and saves it to Supabase.
 * 
 * It saves to BOTH tables:
 *   - tiktok_tokens (master token storage)
 *   - tiktok_accounts (per-user ad account list for the Settings/Spark Testing pages)
 * 
 * Redirect URL to register in TikTok: https://tiktok0auth.vercel.app/api/callback
 */

export default async function handler(req, res) {
  const { auth_code, code, state, error } = req.query;

  // Handle errors from TikTok
  if (error) {
    return res.status(400).send(errorPage(`TikTok returned an error: ${error}`));
  }

  // Advertiser auth uses 'auth_code', Account holder uses 'code'
  const authCode = auth_code || code;

  if (!authCode) {
    return res.status(400).send(errorPage('No authorization code received. Make sure you approved the authorization on TikTok.'));
  }

  try {
    let tokenData;
    let tokenType = 'advertiser';

    if (auth_code) {
      // Advertiser / Business Center authorization
      tokenData = await exchangeAdvertiserCode(auth_code);
      tokenType = 'advertiser';
    } else if (code) {
      // TikTok Account Holder (Spark Ads)
      tokenData = await exchangeAccountHolderCode(code);
      tokenType = 'account_holder';
    }

    // Save to Supabase (both tiktok_tokens AND tiktok_accounts)
    await saveToken(tokenData, tokenType, state);

    // If advertiser type and we have a user_id (state), also save individual ad accounts
    if (tokenType === 'advertiser' && state && tokenData.data?.advertiser_ids?.length) {
      await saveAdAccounts(tokenData, state);
    }

    // Show success page
    return res.status(200).send(successPage(tokenData, tokenType));
  } catch (err) {
    console.error('OAuth callback error:', err);
    return res.status(500).send(errorPage(err.message));
  }
}

// ============================================================
// TOKEN EXCHANGE
// ============================================================

async function exchangeAdvertiserCode(authCode) {
  const response = await fetch('https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: process.env.TIKTOK_APP_ID,
      secret: process.env.TIKTOK_APP_SECRET,
      auth_code: authCode
    })
  });

  const data = await response.json();
  
  if (data.code !== 0 && !data.data?.access_token) {
    throw new Error(`TikTok API error: ${JSON.stringify(data)}`);
  }

  return data;
}

async function exchangeAccountHolderCode(code) {
  const response = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_key: process.env.TIKTOK_APP_ID,
      client_secret: process.env.TIKTOK_APP_SECRET,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: `https://tiktok0auth.vercel.app/api/callback`
    })
  });

  return await response.json();
}

// ============================================================
// SAVE TO SUPABASE
// ============================================================

async function saveToken(tokenData, tokenType, state) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  let record;

  if (tokenType === 'advertiser') {
    record = {
      advertiser_id: tokenData.data?.advertiser_ids?.[0] || null,
      advertiser_ids: tokenData.data?.advertiser_ids || [],
      access_token: tokenData.data?.access_token,
      refresh_token: tokenData.data?.refresh_token || null,
      token_type: 'advertiser',
      scope: tokenData.data?.scope || [],
      expires_at: new Date(Date.now() + (tokenData.data?.expires_in || 86400) * 1000).toISOString(),
      refresh_expires_at: tokenData.data?.refresh_token_expires_in
        ? new Date(Date.now() + tokenData.data.refresh_token_expires_in * 1000).toISOString()
        : null,
      raw_response: tokenData,
      label: state || 'Affiliate',
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
  } else {
    record = {
      advertiser_id: null,
      advertiser_ids: [],
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || null,
      token_type: 'account_holder',
      scope: tokenData.scope ? (Array.isArray(tokenData.scope) ? tokenData.scope : tokenData.scope.split(',')) : [],
      expires_at: new Date(Date.now() + (tokenData.expires_in || 86400) * 1000).toISOString(),
      refresh_expires_at: tokenData.refresh_expires_in
        ? new Date(Date.now() + tokenData.refresh_expires_in * 1000).toISOString()
        : null,
      raw_response: tokenData,
      label: state || 'TikTok Account',
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/tiktok_tokens`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify(record)
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('Supabase tiktok_tokens save error:', errText);
  }

  return record;
}

/**
 * Save individual ad accounts to the tiktok_accounts table
 * This is what the Settings page and Spark Testing page read from
 */
async function saveAdAccounts(tokenData, userId) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const accessToken = tokenData.data?.access_token;
  const advertiserIds = tokenData.data?.advertiser_ids || [];

  // Fetch advertiser info for each account (get names)
  for (const advId of advertiserIds) {
    let advertiserName = 'Ad Account';

    try {
      const infoRes = await fetch(
        `https://business-api.tiktok.com/open_api/v1.3/advertiser/info/?advertiser_ids=["${advId}"]`,
        { headers: { 'Access-Token': accessToken } }
      );
      const infoData = await infoRes.json();
      if (infoData.data?.list?.[0]?.advertiser_name) {
        advertiserName = infoData.data.list[0].advertiser_name;
      }
    } catch (e) {
      // If we can't get the name, just use default
      console.error('Failed to get advertiser name for', advId, e.message);
    }

    // Upsert into tiktok_accounts
    const accountRecord = {
      user_id: userId,
      advertiser_id: advId,
      advertiser_name: advertiserName,
      access_token: accessToken,
      status: 'active',
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const response = await fetch(`${SUPABASE_URL}/rest/v1/tiktok_accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(accountRecord)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Supabase tiktok_accounts save error for', advId, ':', errText);
    }
  }
}

// ============================================================
// HTML PAGES
// ============================================================

function successPage(tokenData, tokenType) {
  const advertiserIds = tokenData.data?.advertiser_ids || [];
  const tokenPreview = tokenData.data?.access_token 
    ? tokenData.data.access_token.substring(0, 20) + '...' 
    : tokenData.access_token?.substring(0, 20) + '...' || 'N/A';

  return `<!DOCTYPE html>
<html>
<head>
  <title>SPRK Network — Connected!</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0a0a0f; color: #e0e0e0; min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      padding: 20px;
    }
    .container { max-width: 550px; width: 100%; text-align: center; }
    .check { font-size: 64px; margin-bottom: 20px; }
    h1 { color: #22c55e; font-size: 24px; margin-bottom: 12px; }
    p { color: #aaa; margin-bottom: 20px; line-height: 1.6; }
    .details {
      background: rgba(255,255,255,0.03); border: 1px solid rgba(212,175,55,0.2);
      border-radius: 12px; padding: 20px; text-align: left; margin: 20px 0;
      max-height: 300px; overflow-y: auto;
    }
    .details pre { 
      color: #d4af37; font-size: 12px; white-space: pre-wrap; word-break: break-all;
    }
    .btn { 
      display: inline-block; padding: 14px 28px; border-radius: 8px;
      background: #d4af37; color: #000; text-decoration: none; font-weight: 600;
      font-size: 14px; margin-top: 10px;
    }
    .btn:hover { background: #e5c54a; }
  </style>
</head>
<body>
  <div class="container">
    <div class="check">&#10003;</div>
    <h1>Authorization Successful!</h1>
    <p>Your TikTok ${tokenType === 'advertiser' ? 'Business Center' : 'Account'} has been connected to SPRK Network.</p>
    <div class="details">
      <pre>Type: ${tokenType}
${tokenType === 'advertiser' ? `Ad Accounts: ${advertiserIds.length} connected` : 'Account connected'}
Token: ${tokenPreview}
Expires: ~24 hours (auto-refreshable)</pre>
    </div>
    <p>You can close this window now and return to the SPRK Network panel.</p>
    <a href="https://www.sprknetwork.ad/settings" class="btn">Return to SPRK Network</a>
  </div>
</body>
</html>`;
}

function errorPage(error) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>SPRK Network — Error</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0a0a0f; color: #e0e0e0; min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      padding: 20px;
    }
    .container { max-width: 550px; width: 100%; text-align: center; }
    h1 { color: #ef4444; margin-bottom: 12px; }
    pre { 
      background: rgba(255,0,0,0.1); padding: 16px; border-radius: 8px; 
      text-align: left; overflow-x: auto; font-size: 12px; color: #fca5a5;
      white-space: pre-wrap; word-break: break-all; margin: 20px 0;
    }
    a { color: #d4af37; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Failed</h1>
    <p>Something went wrong during the connection process.</p>
    <pre>${error}</pre>
    <p><a href="https://www.sprknetwork.ad/settings">Return to SPRK Network</a> and try again.</p>
  </div>
</body>
</html>`;
}
