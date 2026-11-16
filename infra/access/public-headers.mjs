// The response headers of the public site, in one place: the CloudFront response headers policy the
// distribution applies to every S3 object and function response, and the Cache-Control each uploaded
// object carries. Until 2026-11-09 the policy was the gated site's ("private, no-store" on every page,
// no HSTS, no nosniff), which crawlers and web-filter vendors read as a site that does not want to be
// indexed; `test/public-website.test.js` pins what is here.
import fs from 'node:fs';
import { createHash } from 'node:crypto';

// The Content-Security-Policy. Web filters and link scanners mark a site down for having none, and for
// one that allows any inline script, so each inline script is allowed by the hash of its text: a page
// edited without a deploy loses its inline scripts until the next one. No page may use an inline event
// handler (onclick=), which no hash covers. Styles stay 'unsafe-inline': the pages set style attributes.
export const inlineScriptHashes = html => [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`);
const SITE = new URL('../../site/', import.meta.url);
export const siteScriptHashes = () => fs.readdirSync(SITE).filter(name => name.endsWith('.html')).sort()
  .flatMap(name => inlineScriptHashes(fs.readFileSync(new URL(name, SITE), 'utf8')));
// `otherScripts`: the hashes of the pages the bucket serves that this repository does not hold
// (OTHER_PAGES in public-deploy.mjs), read from the bucket at prepare. Google Fonts is theirs too.
export const contentSecurityPolicy = (otherScripts = []) => [
  "default-src 'self'",
  `script-src ${["'self'", ...new Set([...siteScriptHashes(), ...otherScripts])].join(' ')}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  // message.js: the message form's API and the booking calendar it frames.
  "connect-src 'self' https://khsky10r4l.execute-api.us-east-1.amazonaws.com",
  "frame-src https://calendar.google.com",
  "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'", 'upgrade-insecure-requests',
].join('; ');

export const RESPONSE_POLICY = (name, otherScripts = []) => ({
  Name: name,
  Comment: 'Public thinker.sh: cacheable pages with standard security headers',
  SecurityHeadersConfig: {
    // IncludeSubdomains is off on purpose: the policy also answers on zerotime.dev, whose other
    // subdomains are not this site's to commit to HTTPS.
    StrictTransportSecurity: { Override: true, AccessControlMaxAgeSec: 31536000, IncludeSubdomains: false, Preload: false },
    ContentTypeOptions: { Override: true },
    FrameOptions: { Override: true, FrameOption: 'DENY' },
    ReferrerPolicy: { Override: true, ReferrerPolicy: 'strict-origin-when-cross-origin' },
    ContentSecurityPolicy: { Override: true, ContentSecurityPolicy: contentSecurityPolicy(otherScripts) },
  },
  // A fallback for objects uploaded outside the deploy (favicons, the old releases); never an override,
  // so the function's own no-store on /access/session and each upload's value stand.
  CustomHeadersConfig: { Quantity: 1, Items: [{ Header: 'Cache-Control', Value: 'public, max-age=300', Override: false }] },
});

export const DAY = 86400, FIVE_MINUTES = 300;
// Media and the run data change only with a deploy, which invalidates them; pages, scripts and the
// downloads are revalidated every five minutes so a fix reaches browsers without one.
export const cacheControlFor = key => /\.(png|ico|svg)$|^clearing-[a-z0-9-]+\.json$/.test(key)
  ? `public, max-age=${DAY}` : `public, max-age=${FIVE_MINUTES}`;
