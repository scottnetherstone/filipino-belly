// ─────────────────────────────────────────────────────────────
// The Filipino Belly — Cloudflare Worker
// ─────────────────────────────────────────────────────────────
// Routes:
//   POST /api/create-checkout-session  → builds a Stripe Checkout session and returns its URL
//   *                                  → falls through to the ASSETS binding (static files in public/)
//
// Add new endpoints inside the fetch() handler. Pattern:
//   if (url.pathname === '/api/whatever') return handleWhatever(request, env);
//
// Bindings expected on env:
//   env.ASSETS              static asset binding (configured in wrangler.jsonc)
//   env.STRIPE_SECRET_KEY   Stripe secret (set in Cloudflare dashboard as a Secret)
// ─────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// MENU — single source of truth for prices.
// The frontend sends only item IDs and quantities; the Worker re-prices
// from this object. Never trust client-supplied prices.
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

// Reasonable per-line and total caps to make abuse harder.
const MAX_QTY_PER_LINE = 50;
const MAX_TOTAL_CENTS = 500_000; // $5,000 — adjust if catering exceeds


// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// Stripe's API expects nested params as form-encoded keys like
// `line_items[0][price_data][currency]=usd`. This walks any plain
// object and produces those keys.
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


// ─────────────────────────────────────────────────────────────
// POST /api/create-checkout-session
// Body: { items: [{id, qty}], customer: {name, email, phone, notes} }
// Returns: { url, id }  (Stripe Checkout URL to redirect the user to)
// ─────────────────────────────────────────────────────────────
async function handleCreateCheckoutSession(request, env) {
  // ── Verify Stripe is configured ──
  if (!env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY is not configured.');
    return jsonResponse(
      { error: 'Payments are not configured. Please contact us directly to order.' },
      500,
    );
  }

  // ── Parse body ──
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid request format.' }, 400);
  }

  const { items, customer } = body || {};

  // ── Validate customer ──
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

  // ── Validate items ──
  if (!Array.isArray(items) || items.length === 0) {
    return jsonResponse({ error: 'Your cart is empty.' }, 400);
  }
  if (items.length > 50) {
    return jsonResponse({ error: 'Too many distinct items in cart.' }, 400);
  }

  // ── Build Stripe line items from server-side prices ──
  const lineItems = [];
  let subtotalCents = 0;

  for (const raw of items) {
    if (!raw || typeof raw !== 'object') {
      return jsonResponse({ error: 'Invalid cart item.' }, 400);
    }
    const id = String(raw.id || '');
    const qty = Number(raw.qty);

    if (!MENU[id]) {
      return jsonResponse({ error: `Unknown menu item: ${id}` }, 400);
    }
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

  if (subtotalCents > MAX_TOTAL_CENTS) {
    return jsonResponse(
      { error: 'Order total exceeds the online checkout limit. For large orders, please contact us directly.' },
      400,
    );
  }

  // ── Build absolute success/cancel URLs from this request's origin ──
  // Works correctly across custom domains (thefilipinobelly.com,
  // filipinobelly.com) and the workers.dev preview URL.
  const origin = new URL(request.url).origin;
  const successUrl = `${origin}/order-success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl  = `${origin}/order-cancelled`;

  // ── Build Stripe Checkout Session payload ──
  // Docs: https://stripe.com/docs/api/checkout/sessions/create
  const payload = {
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: lineItems,
    customer_email: email,
    success_url: successUrl,
    cancel_url: cancelUrl,
    // Stripe automatically emails the customer a receipt for successful payments
    // when customer_email is set. No extra config needed for that.
    metadata: {
      customer_name: name,
      customer_phone: phone,
      customer_notes: notes,
      source: 'thefilipinobelly.com',
    },
    payment_intent_data: {
      description: `Order from ${name}`,
      metadata: {
        customer_name: name,
        customer_phone: phone,
        customer_notes: notes,
      },
    },
    phone_number_collection: { enabled: false }, // already collected
    // Once Stripe Tax is configured in the dashboard, uncomment to auto-calculate tax:
    // automatic_tax: { enabled: true },
  };

  // ── Call Stripe ──
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
// Worker entry point — routes the request.
// ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // ── API routes ──
    if (pathname === '/api/create-checkout-session') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed.' }, 405);
      }
      return handleCreateCheckoutSession(request, env);
    }

    // Unknown /api/* paths → JSON 404 (don't fall through to assets)
    if (pathname.startsWith('/api/')) {
      return jsonResponse({ error: 'Not found.' }, 404);
    }

    // ── Everything else → static assets ──
    // The ASSETS binding handles file serving, html_handling redirects
    // (e.g. /order → public/order.html), and 404-page fallback.
    return env.ASSETS.fetch(request);
  },
};