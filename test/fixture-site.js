// A small local website used by the scanner tests: nested and gzipped sitemaps, a broken sitemap,
// robots rules, an out-of-scope host, archives, records, simple and complex pages, and redirects.
import http from 'node:http';
import zlib from 'node:zlib';

export function startFixture(state = {}) {
  const s = { privacyText: 'We respect your privacy.', extraPage: false, dropContact: false, ...state };
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(req.url, base);
    const send = (code, body, type = 'text/html') => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    const xml = b => send(200, `<?xml version="1.0" encoding="UTF-8"?>${b}`, 'application/xml');
    const urlset = (locs, extra = '') => `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${locs.map(l => `<url><loc>${l.startsWith('http') ? l : base + l}</loc><lastmod>2026-09-01</lastmod>${extra}</url>`).join('')}</urlset>`;
    switch (url.pathname) {
      case '/robots.txt': return send(200, `User-agent: *\nDisallow: /private/\nCrawl-delay: 0\n\nSitemap: ${base}/sitemap_index.xml\nSitemap: http://other.example/sitemap.xml\n`, 'text/plain');
      case '/sitemap_index.xml': return xml(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>${base}/wp-sitemap-posts-page-1.xml</loc></sitemap>
        <sitemap><loc>${base}/wp-sitemap-posts-post-1.xml.gz</loc></sitemap>
        <sitemap><loc>${base}/nested-index.xml</loc></sitemap>
        <sitemap><loc>${base}/wp-sitemap-taxonomies-post_tag-1.xml</loc></sitemap>
        <sitemap><loc>${base}/broken.xml</loc></sitemap>
        <sitemap><loc>${base}/missing.xml</loc></sitemap></sitemapindex>`);
      case '/wp-sitemap-posts-page-1.xml': {
        const pages = ['/', '/about/', '/privacy/', '/private/secret/', '/about/', 'https://sub.other.org/elsewhere', '/locations/a/'];
        if (!s.dropContact) pages.push('/contact/');
        if (s.extraPage) pages.push('/new-page/');
        for (let i = 1; i <= 11; i++) pages.push(`/locations/l-${i}/`);
        return xml(urlset(pages));
      }
      case '/wp-sitemap-posts-post-1.xml.gz': {
        const body = urlset(Array.from({ length: 12 }, (_, i) => `/blog/post-${i + 1}/`), `<image:image><image:loc>${base}/wp-content/uploads/hero.jpg</image:loc></image:image>`);
        res.writeHead(200, { 'content-type': 'application/gzip' }); return res.end(zlib.gzipSync(`<?xml version="1.0"?>${body}`));
      }
      case '/nested-index.xml': return xml(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${base}/wp-sitemap-posts-tribe_events-1.xml</loc></sitemap></sitemapindex>`);
      case '/wp-sitemap-posts-tribe_events-1.xml': return xml(urlset(['/events/e-1/', '/events/e-2/', '/events/e-3/']));
      case '/wp-sitemap-taxonomies-post_tag-1.xml': return xml(urlset(['/tag/news/', '/tag/security/']));
      case '/broken.xml': return send(500, 'oops', 'text/plain');
      case '/go-internal': res.writeHead(302, { location: 'http://10.0.0.5/admin' }); return res.end();
    }
    const img = n => `<img src="/wp-content/uploads/pic-${n}-300x200.jpg" srcset="/wp-content/uploads/pic-${n}-300x200.jpg 300w, /wp-content/uploads/pic-${n}-1024x683.jpg 1024w, /wp-content/uploads/pic-${n}.jpg 2000w">`;
    const page = (title, main, extra = '') => send(200, `<!doctype html><html><head><title>${title}</title>${extra}</head><body class="page"><header><nav><a href="/">Home</a></nav></header><main>${main}</main><footer>© fixture</footer></body></html>`);
    if (url.pathname === '/') return page('Fixture Home', `
      <section class="hero"><h1>Welcome</h1>${img(1)}</section>
      <section class="features-grid"><h2>Features</h2><div class="cards">${Array.from({ length: 8 }, (_, i) => `<div class="card"><a href="/f${i}">F${i}</a></div>`).join('')}</div></section>
      <section class="tabs"><div role="tablist"><button>One</button><button>Two</button></div></section>
      <section class="accordion"><details><summary>Q</summary>A</details></section>
      <section class="video"><iframe src="https://www.youtube.com/embed/abc"></iframe></section>
      <section class="cta"><form><input name="name"><input type="email" name="email"><textarea name="msg"></textarea></form></section>
      <section class="logos">${Array.from({ length: 9 }, (_, i) => `<img alt="member logo ${i}" src="/wp-content/uploads/logo-${i}.png">`).join('')}</section>
      <a href="/files/annual-report.pdf">Report</a>`);
    if (url.pathname === '/about/') return page('About', `<section class="intro"><h1>About</h1><p>Text</p>${img(2)}</section><section class="team"><h2>Team</h2></section><section class="cta"><a href="/contact/">Contact</a></section><section class="stats"><p>1</p></section>`);
    if (url.pathname === '/privacy/') return page('Privacy', `<h1>Privacy</h1><p>${s.privacyText}</p>`);
    if (url.pathname === '/contact/') return page('Contact', `<section class="contact"><h1>Contact</h1><form><input name="a"><input name="b"><textarea></textarea></form></section>`);
    if (url.pathname === '/new-page/') return page('New page', '<h1>New</h1><p>Fresh</p>');
    if (url.pathname.startsWith('/locations/')) return page('Location', `<section class="location"><h1>Location</h1><p>Address</p></section><section class="map-note"><p>Hours</p></section>`);
    if (url.pathname.startsWith('/blog/')) return page('Post', `<article><h1>Post</h1><time datetime="2026-01-01">Jan 1</time><span class="author">A. Writer</span>${img(3)}<p>${'word '.repeat(2000)}</p></article>`, '<meta property="og:type" content="article"><script type="application/ld+json">{"@type":"BlogPosting"}</script>');
    if (url.pathname.startsWith('/events/')) return page('Event', '<article><h1>Event</h1><time datetime="2026-02-01">Feb</time></article>', '<script type="application/ld+json">{"@type":"Event"}</script>');
    if (url.pathname.startsWith('/tag/')) return page('Tag', '<h1>Tag</h1>');
    return send(404, 'not found', 'text/plain');
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, state: s, base: `http://127.0.0.1:${server.address().port}` })));
}
