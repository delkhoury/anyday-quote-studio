// robots.txt parsing: groups, Allow/Disallow with * and $ wildcards (longest match wins,
// Allow wins ties), Crawl-delay and Sitemap declarations.
import { UA_TOKEN } from './net.js';

export function parseRobots(text) {
  const groups = []; const sitemaps = [];
  let cur = null; let lastWasAgent = false;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase(); const value = m[2].trim();
    if (field === 'sitemap') { if (value) sitemaps.push(value); continue; }
    if (field === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], crawlDelay: null }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true; continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (field === 'allow' || field === 'disallow') cur.rules.push({ allow: field === 'allow', path: value });
    else if (field === 'crawl-delay') { const n = Number(value); if (Number.isFinite(n)) cur.crawlDelay = n; }
  }
  return { groups, sitemaps };
}

function groupFor(robots, token = UA_TOKEN) {
  const specific = robots.groups.filter(g => g.agents.some(a => a !== '*' && token.includes(a)));
  if (specific.length) return mergeGroups(specific);
  const star = robots.groups.filter(g => g.agents.includes('*'));
  return star.length ? mergeGroups(star) : { rules: [], crawlDelay: null };
}
function mergeGroups(gs) { return { rules: gs.flatMap(g => g.rules), crawlDelay: gs.map(g => g.crawlDelay).find(v => v !== null) ?? null }; }

function ruleRegex(path) {
  const anchored = path.endsWith('$');
  const body = (anchored ? path.slice(0, -1) : path).split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

export function makeRobotsChecker(robots, token = UA_TOKEN) {
  const g = groupFor(robots, token);
  const rules = g.rules.filter(r => r.path !== '' || !r.allow).map(r => ({ ...r, re: r.path === '' ? null : ruleRegex(r.path), len: r.path.length }));
  return {
    crawlDelay: g.crawlDelay,
    allowed(urlOrPath) {
      let p;
      try { const u = new URL(urlOrPath); p = u.pathname + u.search; } catch { p = urlOrPath; }
      let best = null;
      for (const r of rules) {
        if (!r.re) continue; // empty Disallow = allow everything
        if (r.re.test(p)) {
          if (!best || r.len > best.len || (r.len === best.len && r.allow && !best.allow)) best = r;
        }
      }
      return !best || best.allow;
    },
  };
}
