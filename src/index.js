// ─────────────────────────────────────────────────────────────
// The Filipino Belly — Cloudflare Worker
// ─────────────────────────────────────────────────────────────
// Routes:
//   POST /api/create-checkout-session  → builds a Stripe Checkout session, returns its URL
//   POST /api/stripe-webhook           → receives checkout.session.completed events, sends emails via Resend
//   *                                  → falls through to ASSETS binding (static files in public/)
//
// Bindings expected on env:
//   env.ASSETS                 static asset binding (configured in wrangler.jsonc)
//   env.STRIPE_SECRET_KEY      Stripe secret key (Cloudflare dashboard secret)
//   env.STRIPE_WEBHOOK_SECRET  Stripe webhook signing secret, starts with whsec_
//   env.RESEND_API_KEY         Resend API key, starts with re_
// ─────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// MENU — single source of truth for prices.
// The frontend sends only item IDs and quantities; the Worker re-prices.
// All amounts are in USD cents.
// ─────────────────────────────────────────────────────────────
const MENU = {
  // Daily menu
  'pork-lumpia-10':    { name: 'Pork Lumpia (10 pcs)',    price: 1500 },
  'chicken-lumpia-10': { name: 'Chicken Lumpia (10 pcs)', price: 1500 },
  'veggie-lumpia-10':  { name: 'Veggie Lumpia (10 pcs)',  price: 1500 },
  'pansit':            { name: 'Pansit Noodles',          price: 2000 },
  'pork-adobo':        { name: 'Pork Adobo',              price: 2500 },
  'chicken-adobo':     { name: 'Chicken Adobo',           price: 2000 },
  'fried-pork-belly':  { name: 'Fried Pork Belly',        price: 3000 },
  'fried-rice':        { name: 'Fried Rice',              price: 3000 },

  // Catering / party trays
  'pork-lumpia-party':     { name: 'Pork Lumpia — Party Tray (230 pcs)',     price: 34500 },
  'pork-lumpia-full':      { name: 'Pork Lumpia — Full Tray (60 pcs)',       price:  9000 },
  'chicken-lumpia-party':  { name: 'Chicken Lumpia — Party Tray (230 pcs)',  price: 34500 },
  'chicken-lumpia-full':   { name: 'Chicken Lumpia — Full Tray (60 pcs)',    price:  9000 },
  'pansit-party':          { name: 'Pansit — Party Tray',                    price: 12000 },
  'pansit-full':           { name: 'Pansit — Full Tray',                     price:  7500 },
  'pork-adobo-full':       { name: 'Pork Adobo — Full Tray',                 price: 11500 },
  'chicken-adobo-party':   { name: 'Chicken Adobo — Party Tray (30 legs)',   price: 16000 },
  'chicken-adobo-full':    { name: 'Chicken Adobo — Full Tray (15 legs)',    price:  9000 },
  'fried-pork-belly-full': { name: 'Fried Pork Belly — Full Tray',           price: 19500 },
  'fried-rice-full':       { name: 'Fried Rice — Full Tray',                 price:  8000 },
  'buttered-shrimp-full':  { name: 'Buttered Shrimp — Full Tray',            price: 17500 },
  'veggie-tray-full':      { name: 'Veggie — Full Tray',                     price:  7500 },
};

// Limits
const MAX_QTY_PER_LINE = 50;
const MAX_TOTAL_CENTS = 500_000;  // $5,000
const MAX_TIP_CENTS   = 100_000;  // $1,000 — generous; catering tips can be large

// Email config
const EMAIL_FROM            = 'The Filipino Belly <orders@thefilipinobelly.com>';
const EMAIL_REPLY_TO        = 'thefilipinobelly2020@gmail.com';
const MERCY_NOTIFY_ADDRESS  = 'thefilipinobelly2020@gmail.com';


// ─────────────────────────────────────────────────────────────
// Generic helpers
// ─────────────────────────────────────────────────────────────
function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// Stripe's API expects nested params as form-encoded keys.
function toStripeForm(obj) {
  const params = new URLSearchParams();
  function walk(key, val) {
    if (val === null || val === undefined) return;
    if (Array.isArray(val)) {
      val.forEach((v, i) => walk(`${key}[${i}]`, v));
    } else if (typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) walk(`${key}[${k}]`, v);
    } else {
      params.append(key, String(val));
    }
  }
  for (const [k, v] of Object.entries(obj)) walk(k, v);
  return params;
}

function fmtMoney(cents) {
  return '$' + (cents / 100).toFixed(2);
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}


// ─────────────────────────────────────────────────────────────
// POST /api/create-checkout-session
// Body: { items: [{id, qty}], customer: {name, email, phone, notes}, tip?: number (cents) }
// Returns: { url, id }
// ─────────────────────────────────────────────────────────────
async function handleCreateCheckoutSession(request, env) {
  if (!env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY is not configured.');
    return jsonResponse({ error: 'Payments are not configured. Please contact us directly to order.' }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: 'Invalid request format.' }, 400); }

  const { items, customItems, customer, tip } = body || {};

  // Validate customer
  if (!customer || typeof customer !== 'object') {
    return jsonResponse({ error: 'Customer information is required.' }, 400);
  }
  const name  = String(customer.name  || '').trim().slice(0, 100);
  const email = String(customer.email || '').trim().slice(0, 200);
  const phone = String(customer.phone || '').trim().slice(0, 30);
  const notes = String(customer.notes || '').trim().slice(0, 1000);

  if (!name) return jsonResponse({ error: 'Name is required.' }, 400);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ error: 'A valid email is required.' }, 400);
  }
  if (!phone) return jsonResponse({ error: 'Phone number is required.' }, 400);

  // Normalize both item lists
  const itemsList = Array.isArray(items) ? items : [];
  const customList = Array.isArray(customItems) ? customItems : [];

  if (itemsList.length === 0 && customList.length === 0) {
    return jsonResponse({ error: 'Your cart is empty.' }, 400);
  }
  if (itemsList.length > 50) {
    return jsonResponse({ error: 'Too many distinct items in cart.' }, 400);
  }
  if (customList.length > 20) {
    return jsonResponse({ error: 'Too many custom items in cart.' }, 400);
  }

  // Build Stripe line items from server-side prices
  const lineItems = [];
  let subtotalCents = 0;

  for (const raw of itemsList) {
    if (!raw || typeof raw !== 'object') return jsonResponse({ error: 'Invalid cart item.' }, 400);
    const id = String(raw.id || '');
    const qty = Number(raw.qty);

    if (!MENU[id]) return jsonResponse({ error: `Unknown menu item: ${id}` }, 400);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_LINE) {
      return jsonResponse({ error: `Invalid quantity for ${MENU[id].name}.` }, 400);
    }

    const item = MENU[id];
    subtotalCents += item.price * qty;

    lineItems.push({
      quantity: qty,
      price_data: {
        currency: 'usd',
        unit_amount: item.price,
        product_data: {
          name: item.name,
          metadata: { item_id: id },
        },
      },
    });
  }

  // Custom items — Mercy uses these for special orders not on the standard menu.
  // Name and price come from the client; we cap the per-item price to limit abuse.
  // Custom items use the default tax code (i.e. they're taxable when Stripe Tax is enabled),
  // which is the safe default for prepared food.
  for (const raw of customList) {
    if (!raw || typeof raw !== 'object') return jsonResponse({ error: 'Invalid custom item.' }, 400);
    const ciName = String(raw.name || '').trim().slice(0, 100);
    const ciPriceCents = Number(raw.priceCents);
    const ciQty = Number(raw.qty);

    if (!ciName) {
      return jsonResponse({ error: 'Custom items require a name.' }, 400);
    }
    if (!Number.isInteger(ciPriceCents) || ciPriceCents < 50 || ciPriceCents > 50_000) {
      return jsonResponse({ error: 'Custom item price must be between $0.50 and $500.' }, 400);
    }
    if (!Number.isInteger(ciQty) || ciQty < 1 || ciQty > MAX_QTY_PER_LINE) {
      return jsonResponse({ error: 'Invalid quantity for custom item.' }, 400);
    }

    subtotalCents += ciPriceCents * ciQty;

    lineItems.push({
      quantity: ciQty,
      price_data: {
        currency: 'usd',
        unit_amount: ciPriceCents,
        product_data: {
          name: ciName,
          metadata: { item_id: 'custom' },
        },
      },
    });
  }

  if (subtotalCents > MAX_TOTAL_CENTS) {
    return jsonResponse(
      { error: 'Order total exceeds the online checkout limit. For large orders, please contact us directly.' },
      400
    );
  }

  // Validate and add tip as a Gratuity line item.
  // Tax behaviors: tip is marked non-taxable via tax_code so when Stripe Tax
  // is enabled later, gratuities are automatically excluded from sales tax.
  const tipCents = Number.isFinite(Number(tip)) ? Math.floor(Number(tip)) : 0;
  if (tipCents < 0 || tipCents > MAX_TIP_CENTS) {
    return jsonResponse({ error: 'Invalid tip amount.' }, 400);
  }
  if (tipCents > 0) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: tipCents,
        tax_behavior: 'exclusive',
        product_data: {
          name: 'Gratuity',
          tax_code: 'txcd_00000000',  // Non-taxable
          metadata: { item_id: 'gratuity' },
        },
      },
    });
  }

  // Build absolute success/cancel URLs from this request's origin
  const origin = new URL(request.url).origin;
  const successUrl = `${origin}/order-success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl  = `${origin}/order-cancelled`;

  const payload = {
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: lineItems,
    customer_email: email,
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      customer_name: name,
      customer_phone: phone,
      customer_notes: notes,
      tip_cents: String(tipCents),
      source: 'thefilipinobelly.com',
    },
    payment_intent_data: {
      description: `Order from ${name}`,
      metadata: {
        customer_name: name,
        customer_phone: phone,
        customer_notes: notes,
        tip_cents: String(tipCents),
      },
    },
    phone_number_collection: { enabled: false },
    // Once Stripe Tax is configured in the dashboard, uncomment to auto-calculate tax:
    // automatic_tax: { enabled: true },
  };

  let stripeRes;
  try {
    stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': '2024-06-20',
      },
      body: toStripeForm(payload).toString(),
    });
  } catch (e) {
    console.error('Network error reaching Stripe:', e);
    return jsonResponse({ error: 'Could not reach payment processor. Please try again.' }, 502);
  }

  const session = await stripeRes.json().catch(() => ({}));

  if (!stripeRes.ok) {
    console.error('Stripe error:', session);
    const userMsg = session?.error?.message || 'Payment processor returned an error.';
    return jsonResponse({ error: userMsg }, 502);
  }

  if (!session.url) {
    console.error('Stripe returned OK but no URL:', session);
    return jsonResponse({ error: 'Checkout session created but no redirect URL was returned.' }, 502);
  }

  return jsonResponse({ url: session.url, id: session.id });
}


// ─────────────────────────────────────────────────────────────
// Stripe webhook signature verification
// Uses the Web Crypto API; no external library needed.
// Stripe sends header: `t=<timestamp>,v1=<sig>` (HMAC-SHA256 of `${t}.${rawBody}`).
// ─────────────────────────────────────────────────────────────
async function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;

  const parts = signatureHeader.split(',').map(p => p.trim().split('='));
  const tsEntry  = parts.find(([k]) => k === 't');
  const sigEntry = parts.find(([k]) => k === 'v1');
  if (!tsEntry || !sigEntry) return false;

  const timestamp = tsEntry[1];
  const expectedSig = sigEntry[1];

  // Replay protection: reject signatures older than 5 minutes.
  const tsNum = parseInt(timestamp, 10);
  if (!Number.isFinite(tsNum)) return false;
  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
  if (ageSec > 300) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sigBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
  const computedSig = Array.from(new Uint8Array(sigBytes))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison
  if (computedSig.length !== expectedSig.length) return false;
  let diff = 0;
  for (let i = 0; i < computedSig.length; i++) {
    diff |= computedSig.charCodeAt(i) ^ expectedSig.charCodeAt(i);
  }
  return diff === 0;
}


// ─────────────────────────────────────────────────────────────
// Fetch a full Checkout session with line items expanded.
// Needed because webhook event payload doesn't include line_items by default.
// ─────────────────────────────────────────────────────────────
async function fetchStripeSession(sessionId, env) {
  try {
    const res = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${sessionId}?expand[]=line_items`,
      { headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` } }
    );
    if (!res.ok) {
      console.error('Stripe session fetch failed:', res.status, await res.text());
      return null;
    }
    return res.json();
  } catch (e) {
    console.error('Network error fetching session:', e);
    return null;
  }
}


// ─────────────────────────────────────────────────────────────
// Resend email sender
// ─────────────────────────────────────────────────────────────
async function sendResendEmail({ to, replyTo, subject, html, env }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: Array.isArray(to) ? to : [to],
      reply_to: replyTo,
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error('Resend send failed:', res.status, errBody);
    throw new Error(`Resend ${res.status}: ${errBody}`);
  }
  return res.json();
}


// ─────────────────────────────────────────────────────────────
// Email templates
// Inline styles only (email clients strip <style> tags).
// ─────────────────────────────────────────────────────────────
function renderLineItemRows(lineItems) {
  return lineItems.map(li => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;">${escapeHtml(li.description || 'Item')}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;text-align:center;">${li.quantity}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;text-align:right;white-space:nowrap;">${fmtMoney(li.amount_total)}</td>
    </tr>
  `).join('');
}

function buildCustomerEmailHtml({ customerName, lineItems, session, customerNotes }) {
  const items = renderLineItemRows(lineItems);
  const total = fmtMoney(session.amount_total);
  const hasCatering = lineItems.some(li => /tray/i.test(li.description || ''));

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Order Confirmed</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#F0EBE3;margin:0;padding:20px;color:#1A1A1A;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto;background:#fff;">
    <tr><td style="padding:32px;text-align:center;background:#0D0D0D;color:#fff;">
      <h1 style="margin:0;font-size:28px;letter-spacing:0.04em;color:#F5B731;">THE FILIPINO BELLY</h1>
      <p style="margin:8px 0 0;font-size:13px;color:#aaa;letter-spacing:0.1em;">ORDER CONFIRMED ✓</p>
    </td></tr>
    <tr><td style="padding:32px;">
      <p style="font-size:16px;margin:0 0 16px;">Hi ${escapeHtml(customerName)},</p>
      <p style="font-size:15px;line-height:1.6;margin:0 0 24px;">Thank you for ordering from The Filipino Belly! We've received your order and your payment was successful.</p>

      <h2 style="font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:#D42E12;margin:24px 0 12px;border-bottom:2px solid #F5B731;padding-bottom:6px;">Your order</h2>
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;">
        <thead><tr style="background:#F0EBE3;">
          <th style="padding:10px 12px;text-align:left;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#6B6560;">Item</th>
          <th style="padding:10px 12px;text-align:center;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#6B6560;">Qty</th>
          <th style="padding:10px 12px;text-align:right;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#6B6560;">Amount</th>
        </tr></thead>
        <tbody>${items}</tbody>
        <tfoot><tr>
          <td colspan="2" style="padding:16px 12px 8px;font-weight:bold;font-size:16px;">Total paid</td>
          <td style="padding:16px 12px 8px;text-align:right;font-weight:bold;font-size:18px;color:#F5B731;white-space:nowrap;">${total}</td>
        </tr></tfoot>
      </table>

      ${customerNotes ? `
        <h2 style="font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:#D42E12;margin:24px 0 8px;">Your notes</h2>
        <p style="font-size:14px;background:#F0EBE3;padding:12px;margin:0;line-height:1.5;">${escapeHtml(customerNotes)}</p>
      ` : ''}

      <h2 style="font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:#D42E12;margin:24px 0 12px;">What happens next</h2>
      <p style="font-size:14px;line-height:1.7;margin:0 0 12px;">Mercy will reach out to you by <strong>phone, text, or Facebook Messenger within 24 hours</strong> to confirm your pickup or drop-off details.</p>
      ${hasCatering ? `<p style="font-size:14px;line-height:1.7;margin:0 0 12px;"><strong>For party trays:</strong> please allow at least 4 days for prep — we'll confirm your event date when we follow up.</p>` : ''}

      <div style="background:#F0EBE3;border-left:3px solid #0047AB;padding:12px 16px;margin:24px 0;font-size:13px;line-height:1.6;color:#4A4440;">
        <strong>📩 You'll also receive a separate payment receipt from Stripe.</strong> That's just your payment confirmation from the processor — it's <em>not</em> a duplicate charge. This email is your order summary.
      </div>

      <p style="font-size:14px;line-height:1.6;margin:24px 0 0;">Questions? Just reply to this email or message us on Facebook.</p>
    </td></tr>
    <tr><td style="padding:24px 32px;background:#0D0D0D;color:#aaa;text-align:center;font-size:12px;line-height:1.6;">
      <p style="margin:0 0 8px;color:#F5B731;font-size:14px;letter-spacing:0.08em;">THE FILIPINO BELLY</p>
      <p style="margin:0;">Wimauma, FL · <a href="https://m.me/TheFilipinoBelly2020" style="color:#F5B731;">Messenger</a> · <a href="tel:+17206455088" style="color:#F5B731;">(720) 645-5088</a></p>
    </td></tr>
  </table>
  <div style="height:6px;max-width:600px;margin:0 auto;background:linear-gradient(90deg,#0047AB 33%,#F5B731 33% 66%,#D42E12 66%);"></div>
</body></html>`;
}

function buildMercyEmailHtml({ customerName, customerEmail, customerPhone, customerNotes, lineItems, session }) {
  const items = renderLineItemRows(lineItems);
  const total = fmtMoney(session.amount_total);
  const stripeUrl = session.payment_intent ? `https://dashboard.stripe.com/payments/${session.payment_intent}` : 'https://dashboard.stripe.com/payments';

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>New Order</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#F0EBE3;margin:0;padding:20px;color:#1A1A1A;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto;background:#fff;">
    <tr><td style="padding:24px 32px;background:#D42E12;color:#fff;">
      <h1 style="margin:0;font-size:22px;">🍴 New order: ${total}</h1>
      <p style="margin:4px 0 0;font-size:14px;opacity:0.9;">from ${escapeHtml(customerName)}</p>
    </td></tr>
    <tr><td style="padding:24px 32px;">
      <h2 style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#6B6560;margin:0 0 8px;">Customer</h2>
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;line-height:1.7;">
        <tr><td style="color:#6B6560;padding-right:12px;width:70px;">Name:</td><td><strong>${escapeHtml(customerName)}</strong></td></tr>
        <tr><td style="color:#6B6560;padding-right:12px;">Email:</td><td><a href="mailto:${escapeHtml(customerEmail || '')}" style="color:#0047AB;">${escapeHtml(customerEmail || '—')}</a></td></tr>
        <tr><td style="color:#6B6560;padding-right:12px;">Phone:</td><td><a href="tel:${escapeHtml(customerPhone)}" style="color:#0047AB;">${escapeHtml(customerPhone || '—')}</a></td></tr>
      </table>

      ${customerNotes ? `
        <h2 style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#6B6560;margin:20px 0 8px;">Notes from customer</h2>
        <p style="font-size:14px;background:#FFFBEA;border-left:3px solid #F5B731;padding:12px;margin:0;line-height:1.5;">${escapeHtml(customerNotes)}</p>
      ` : ''}

      <h2 style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#6B6560;margin:20px 0 8px;">Order</h2>
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;">
        <thead><tr style="background:#F0EBE3;">
          <th style="padding:8px 12px;text-align:left;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#6B6560;">Item</th>
          <th style="padding:8px 12px;text-align:center;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#6B6560;">Qty</th>
          <th style="padding:8px 12px;text-align:right;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#6B6560;">Amount</th>
        </tr></thead>
        <tbody>${items}</tbody>
        <tfoot><tr>
          <td colspan="2" style="padding:14px 12px 8px;font-weight:bold;font-size:15px;">Total paid</td>
          <td style="padding:14px 12px 8px;text-align:right;font-weight:bold;font-size:17px;color:#D42E12;white-space:nowrap;">${total}</td>
        </tr></tfoot>
      </table>

      <div style="margin:24px 0 0;text-align:center;">
        <a href="${stripeUrl}" style="display:inline-block;background:#0D0D0D;color:#fff;padding:10px 20px;text-decoration:none;font-size:13px;letter-spacing:0.08em;">VIEW IN STRIPE →</a>
      </div>

      <p style="font-size:11px;color:#999;text-align:center;margin:24px 0 0;line-height:1.5;">
        Session: <code style="font-size:10px;">${escapeHtml(session.id)}</code><br>
        Replying to this email will go to <strong>${escapeHtml(customerEmail || '—')}</strong>.
      </p>
    </td></tr>
  </table>
</body></html>`;
}


// ─────────────────────────────────────────────────────────────
// Orchestrate the two emails after a successful checkout.
// Throws if the session fetch fails so Stripe will retry the webhook.
// Individual email failures are logged but don't abort the other email.
// ─────────────────────────────────────────────────────────────
async function sendOrderEmails(session, env) {
  const fullSession = await fetchStripeSession(session.id, env);
  if (!fullSession) {
    throw new Error('Could not fetch full Checkout session for line items.');
  }

  const lineItems     = fullSession.line_items?.data || [];
  const customerName  = session.metadata?.customer_name || fullSession.customer_details?.name || 'Customer';
  const customerEmail = session.customer_email || fullSession.customer_details?.email || '';
  const customerPhone = session.metadata?.customer_phone || '';
  const customerNotes = session.metadata?.customer_notes || '';

  const customerHtml = buildCustomerEmailHtml({
    customerName, lineItems, session: fullSession, customerNotes,
  });
  const mercyHtml = buildMercyEmailHtml({
    customerName, customerEmail, customerPhone, customerNotes, lineItems, session: fullSession,
  });

  // Send both emails. Use try/catch around each so one failure doesn't block the other.
  if (customerEmail) {
    try {
      await sendResendEmail({
        to: customerEmail,
        replyTo: EMAIL_REPLY_TO,
        subject: 'Order Confirmed — The Filipino Belly',
        html: customerHtml,
        env,
      });
    } catch (e) {
      console.error('Failed to send customer email:', e);
    }
  } else {
    console.warn('No customer email on session — skipping customer confirmation.');
  }

  try {
    await sendResendEmail({
      to: MERCY_NOTIFY_ADDRESS,
      replyTo: customerEmail || EMAIL_REPLY_TO,
      subject: `🍴 New order — ${customerName} — ${fmtMoney(fullSession.amount_total)}`,
      html: mercyHtml,
      env,
    });
  } catch (e) {
    console.error('Failed to send Mercy email:', e);
  }
}


// ─────────────────────────────────────────────────────────────
// POST /api/stripe-webhook
// ─────────────────────────────────────────────────────────────
async function handleStripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    console.error('STRIPE_WEBHOOK_SECRET is not configured.');
    return new Response('Server misconfigured.', { status: 500 });
  }

  const signatureHeader = request.headers.get('stripe-signature');
  const rawBody = await request.text();

  const verified = await verifyStripeSignature(rawBody, signatureHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!verified) {
    console.warn('Stripe webhook signature verification failed.');
    return new Response('Invalid signature.', { status: 400 });
  }

  let event;
  try { event = JSON.parse(rawBody); }
  catch (e) { return new Response('Invalid JSON.', { status: 400 }); }

  // Only act on checkout completion. Other event types acknowledged silently.
  if (event.type !== 'checkout.session.completed') {
    return new Response('Event ignored.', { status: 200 });
  }

  const session = event.data?.object;
  if (!session) return new Response('No session in payload.', { status: 400 });

  // Only send emails if the session was actually paid
  // (avoids sending order confirmations for sessions in unpaid/processing states).
  if (session.payment_status !== 'paid') {
    console.log(`Skipping emails — payment_status: ${session.payment_status}`);
    return new Response('OK (not paid).', { status: 200 });
  }

  try {
    await sendOrderEmails(session, env);
    return new Response('OK', { status: 200 });
  } catch (e) {
    console.error('Email orchestration failed:', e);
    // Non-2xx → Stripe will retry the webhook with exponential backoff.
    return new Response('Email send failed.', { status: 500 });
  }
}


// ─────────────────────────────────────────────────────────────
// Worker entry point
// ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/api/create-checkout-session') {
      if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);
      return handleCreateCheckoutSession(request, env);
    }

    if (pathname === '/api/stripe-webhook') {
      if (request.method !== 'POST') return new Response('Method not allowed.', { status: 405 });
      return handleStripeWebhook(request, env);
    }

    if (pathname.startsWith('/api/')) return jsonResponse({ error: 'Not found.' }, 404);

    return env.ASSETS.fetch(request);
  },
};