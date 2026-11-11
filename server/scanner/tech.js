// Technology detection from page markup: the CMS a site runs on, third party integrations,
// languages, and section signatures used to count distinct components. Deterministic and
// evidence based: every detection carries the marker that triggered it.

// CMS markers: generator meta, asset paths, globals and attributes.
const CMS_RULES = [
  { id: 'wordpress', name: 'WordPress', gen: /wordpress/i, html: [/\/wp-content\//, /\/wp-includes\//, /wp-json/] },
  { id: 'drupal', name: 'Drupal', gen: /drupal/i, html: [/\/sites\/(default|all)\/files\//, /Drupal\.settings|drupalSettings/, /data-drupal-/] },
  { id: 'webflow', name: 'Webflow', gen: /webflow/i, html: [/data-wf-site=/, /assets\.website-files\.com|cdn\.prod\.website-files\.com/] },
  { id: 'hubspot', name: 'HubSpot CMS', gen: /hubspot/i, html: [/\/hs-fs\/hubfs\//, /hs-sites\.com/, /\/_hcms\//] },
  { id: 'shopify', name: 'Shopify', gen: /shopify/i, html: [/cdn\.shopify\.com/, /Shopify\.theme/] },
  { id: 'squarespace', name: 'Squarespace', gen: /squarespace/i, html: [/static1\.squarespace\.com|squarespace-cdn\.com/] },
  { id: 'wix', name: 'Wix', gen: /wix\.com/i, html: [/static\.wixstatic\.com|parastorage\.com/] },
  { id: 'joomla', name: 'Joomla', gen: /joomla/i, html: [/\/media\/jui\/|\/components\/com_/] },
  { id: 'sitecore', name: 'Sitecore', gen: /sitecore/i, html: [/\/-\/media\//, /scItemId|sc_site/] },
  { id: 'aem', name: 'Adobe Experience Manager', gen: /adobe experience manager/i, html: [/\/etc\.clientlibs\//, /\/content\/dam\//] },
  { id: 'craft', name: 'Craft CMS', gen: /craft cms/i, html: [/\/cpresources\//] },
  { id: 'ghost', name: 'Ghost', gen: /ghost/i, html: [/ghost-portal|\/ghost\/api\//] },
  { id: 'contentful', name: 'Contentful (headless)', gen: null, html: [/images\.ctfassets\.net|ctfassets\.net/] },
  { id: 'sanity', name: 'Sanity (headless)', gen: null, html: [/cdn\.sanity\.io/] },
  { id: 'prismic', name: 'Prismic (headless)', gen: null, html: [/images\.prismic\.io|prismic\.io/] },
  { id: 'storyblok', name: 'Storyblok (headless)', gen: null, html: [/a\.storyblok\.com/] },
];
// Front end frameworks are recorded separately; they do not say where content lives.
const FRAMEWORK_RULES = [
  { id: 'nextjs', name: 'Next.js', html: [/__NEXT_DATA__|\/_next\/static\//] },
  { id: 'gatsby', name: 'Gatsby', html: [/___gatsby|\/page-data\//] },
  { id: 'nuxt', name: 'Nuxt', html: [/__NUXT__|\/_nuxt\//] },
  { id: 'elementor', name: 'Elementor', html: [/elementor-/] },
  { id: 'wpbakery', name: 'WPBakery', html: [/vc_row|wpb_/] },
  { id: 'divi', name: 'Divi', html: [/et_pb_/] },
  { id: 'gutenberg', name: 'WordPress blocks', html: [/wp-block-/] },
];
// Integrations: category decides which Pricing Library lines they inform.
export const INTEGRATION_RULES = [
  { id: 'ga4', name: 'Google Analytics', category: 'analytics', re: /googletagmanager\.com\/gtag\/js|google-analytics\.com\/(analytics|ga)\.js|gtag\(['"]config['"],\s*['"]G-/ },
  { id: 'gtm', name: 'Google Tag Manager', category: 'analytics', re: /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/ },
  { id: 'adobe_analytics', name: 'Adobe Analytics', category: 'analytics', re: /assets\.adobedtm\.com|omniture|s_code\.js/ },
  { id: 'segment', name: 'Segment', category: 'analytics', re: /cdn\.segment\.com/ },
  { id: 'hotjar', name: 'Hotjar', category: 'analytics', re: /static\.hotjar\.com/ },
  { id: 'meta_pixel', name: 'Meta Pixel', category: 'analytics', re: /connect\.facebook\.net\/[^"']*fbevents\.js/ },
  { id: 'linkedin_insight', name: 'LinkedIn Insight', category: 'analytics', re: /snap\.licdn\.com/ },
  { id: 'hubspot_tracking', name: 'HubSpot', category: 'crm', re: /js\.hs-scripts\.com|js\.hsforms\.net|js\.hs-analytics\.net|hbspt\.forms/ },
  { id: 'marketo', name: 'Marketo', category: 'crm', re: /munchkin\.marketo\.net|mktoForms|marketo\.com\/js\/forms2/ },
  { id: 'pardot', name: 'Salesforce Pardot', category: 'crm', re: /pi\.pardot\.com|go\.pardot\.com/ },
  { id: 'salesforce', name: 'Salesforce', category: 'crm', re: /force\.com\/servlet\/servlet\.WebToLead|my\.salesforce\.com/ },
  { id: 'mailchimp', name: 'Mailchimp', category: 'newsletter', re: /list-manage\.com|chimpstatic\.com|mc\.us\d+\.list-manage/ },
  { id: 'constant_contact', name: 'Constant Contact', category: 'newsletter', re: /constantcontact\.com|ctctcdn\.com/ },
  { id: 'klaviyo', name: 'Klaviyo', category: 'newsletter', re: /static\.klaviyo\.com/ },
  { id: 'gravity_forms', name: 'Gravity Forms', category: 'forms', re: /gform_wrapper|gravityforms/ },
  { id: 'contact_form_7', name: 'Contact Form 7', category: 'forms', re: /wpcf7/ },
  { id: 'typeform', name: 'Typeform', category: 'forms', re: /embed\.typeform\.com|form\.typeform\.com/ },
  { id: 'jotform', name: 'Jotform', category: 'forms', re: /jotform\.(com|us)/ },
  { id: 'algolia', name: 'Algolia', category: 'search', re: /algolia(net)?\.(com|net)|algoliasearch/ },
  { id: 'coveo', name: 'Coveo', category: 'search', re: /coveo\.com|CoveoSearch/ },
  { id: 'google_cse', name: 'Google Programmable Search', category: 'search', re: /cse\.google\.com/ },
  { id: 'stripe', name: 'Stripe', category: 'commerce', re: /js\.stripe\.com/ },
  { id: 'paypal', name: 'PayPal', category: 'commerce', re: /paypal\.com\/sdk|paypalobjects\.com/ },
  { id: 'woocommerce', name: 'WooCommerce', category: 'commerce', re: /woocommerce/ },
  { id: 'shopify_buy', name: 'Shopify Buy Button', category: 'commerce', re: /sdks\.shopifycdn\.com/ },
  { id: 'donorbox', name: 'Donation platform', category: 'commerce', re: /donorbox\.org|givebutter\.com|classy\.org|blackbaud|canadahelps\.org/ },
  { id: 'calendly', name: 'Calendly', category: 'booking', re: /assets\.calendly\.com|calendly\.com\// },
  { id: 'zenoti', name: 'Zenoti', category: 'booking', re: /zenoti\.com/ },
  { id: 'jane', name: 'Jane App', category: 'booking', re: /\.janeapp\.com/ },
  { id: 'mindbody', name: 'Mindbody', category: 'booking', re: /mindbodyonline\.com|healcode\.com/ },
  { id: 'opentable', name: 'OpenTable', category: 'booking', re: /opentable\.(com|ca)\/widget/ },
  { id: 'eventbrite', name: 'Eventbrite', category: 'events', re: /eventbrite\.(com|ca)/ },
  { id: 'tribe_events', name: 'The Events Calendar', category: 'events', re: /tribe-events/ },
  { id: 'google_maps', name: 'Google Maps', category: 'maps', re: /maps\.googleapis\.com|google\.com\/maps\/embed/ },
  { id: 'mapbox', name: 'Mapbox', category: 'maps', re: /api\.mapbox\.com/ },
  { id: 'intercom', name: 'Intercom', category: 'chat', re: /widget\.intercom\.io/ },
  { id: 'drift', name: 'Drift', category: 'chat', re: /js\.driftt\.com/ },
  { id: 'zendesk', name: 'Zendesk', category: 'chat', re: /static\.zdassets\.com/ },
  { id: 'livechat', name: 'LiveChat', category: 'chat', re: /cdn\.livechatinc\.com/ },
  { id: 'onetrust', name: 'OneTrust', category: 'consent', re: /cdn\.cookielaw\.org|onetrust/ },
  { id: 'cookiebot', name: 'Cookiebot', category: 'consent', re: /consent\.cookiebot\.com/ },
  { id: 'recaptcha', name: 'reCAPTCHA', category: 'security', re: /google\.com\/recaptcha/ },
  { id: 'weglot', name: 'Weglot', category: 'translation', re: /cdn\.weglot\.com/ },
  { id: 'wpml', name: 'WPML', category: 'translation', re: /wpml|sitepress-multilingual/ },
  { id: 'polylang', name: 'Polylang', category: 'translation', re: /polylang/ },
  { id: 'youtube', name: 'YouTube', category: 'video', re: /youtube(-nocookie)?\.com\/embed/ },
  { id: 'vimeo', name: 'Vimeo', category: 'video', re: /player\.vimeo\.com/ },
  { id: 'wistia', name: 'Wistia', category: 'video', re: /fast\.wistia\.(com|net)/ },
  { id: 'auth0', name: 'Auth0', category: 'identity', re: /auth0\.com|cdn\.auth0\.com/ },
  { id: 'okta', name: 'Okta', category: 'identity', re: /okta(cdn)?\.com/ },
];
export const INTEGRATION_CATEGORIES = {
  analytics: 'Analytics and tracking', crm: 'CRM and marketing automation', newsletter: 'Email newsletter', forms: 'Form platform', search: 'Site search',
  commerce: 'Payments and commerce', booking: 'Booking and scheduling', events: 'Events', maps: 'Maps', chat: 'Live chat and support', consent: 'Cookie consent',
  security: 'Spam protection', translation: 'Translation', video: 'Video hosting', identity: 'Sign in and identity',
};

// What the page loads: script sources, iframes, link hrefs, form actions and inline script text.
function surface($, html) {
  const parts = [];
  $('script[src], iframe[src], iframe[data-src], link[href], form[action], img[src]').each((_, el) => { const $e = $(el); parts.push($e.attr('src') || $e.attr('data-src') || $e.attr('href') || $e.attr('action') || ''); });
  $('script:not([src])').each((_, el) => { const t = $(el).contents().text(); if (t) parts.push(t.slice(0, 4000)); });
  const cls = []; $('[class*="gform"], [class*="wpcf7"], [class*="tribe-events"], [class*="woocommerce"]').slice(0, 20).each((_, el) => cls.push($(el).attr('class') || ''));
  return parts.join('\n') + '\n' + cls.join(' ') + '\n' + html.slice(0, 2000);
}

export function detectTech($, html, generator = '') {
  const text = surface($, html);
  const cms = [];
  for (const r of CMS_RULES) {
    if (r.gen && r.gen.test(generator)) { cms.push({ id: r.id, name: r.name, evidence: `generator: ${generator.slice(0, 60)}`, strong: true }); continue; }
    const hit = r.html.find(re => re.test(text) || re.test(html));
    if (hit) cms.push({ id: r.id, name: r.name, evidence: `markup matches ${String(hit).slice(1, 40)}`, strong: false });
  }
  const frameworks = FRAMEWORK_RULES.filter(r => r.html.some(re => re.test(html))).map(r => ({ id: r.id, name: r.name }));
  const integrations = INTEGRATION_RULES.filter(r => r.re.test(text)).map(r => ({ id: r.id, name: r.name, category: r.category }));
  return { cms, frameworks, integrations };
}

export function detectLanguages($, pageUrl) {
  const lang = ($('html').attr('lang') || '').trim().toLowerCase().split(/[_]/)[0] || null;
  const alternates = [];
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    const code = ($(el).attr('hreflang') || '').toLowerCase();
    if (!code || code === 'x-default') return;
    let href = $(el).attr('href') || '';
    try { href = new URL(href, pageUrl).toString(); } catch { /* keep as is */ }
    alternates.push({ code, href });
  });
  return { lang, alternates };
}

// A component signature: what kind of section it is and its broad shape, so the same hero on
// fifty pages counts once and a hero with a form counts separately.
export function sectionSignature($, el, type) {
  const $e = $(el);
  const has = sel => $e.find(sel).length > 0;
  const flags = [
    has('h1') && 'h1', has('h2, h3') && 'h', has('img, picture, video, svg') && 'media', has('form') && 'form',
    has('[role="tablist"], [class*="tab"]') && 'tabs', has('details, [class*="accordion"], [aria-expanded]') && 'accordion',
    has('[class*="carousel"], [class*="slider"], [class*="swiper"], [class*="slick"]') && 'carousel', has('iframe') && 'embed',
    has('table') && 'table', has('blockquote, [class*="testimonial"]') && 'quote',
  ].filter(Boolean);
  const kids = $e.children().toArray();
  const sigs = {}; for (const k of kids) { const s = k.name + '.' + (($(k).attr('class') || '').split(/\s+/)[0] || ''); sigs[s] = (sigs[s] || 0) + 1; }
  const maxRun = Math.max(0, ...Object.values(sigs));
  const cards = $e.find('*').toArray().some(n => { const c = $(n).children(); return c.length >= 3 && c.filter((_, x) => x.name === c[0].name).length === c.length && $(n).find('a').length >= 3; });
  if (cards || maxRun >= 3) flags.push('repeat');
  const interactive = flags.some(f => ['form', 'tabs', 'accordion', 'carousel', 'embed'].includes(f));
  // plain text sections are one component however their classes are named
  if (!flags.length) return { sig: 'text|', type: 'text', flags, interactive: false };
  return { sig: `${type}|${flags.sort().join('+')}`, type, flags, interactive };
}
