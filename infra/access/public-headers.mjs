// The response headers of the public site, in one place: the CloudFront response headers policy the
// distribution applies to every S3 object and function response, and the Cache-Control each uploaded
// object carries. Until 2026-11-09 the policy was the gated site's ("private, no-store" on every page,
// no HSTS, no nosniff), which crawlers and web-filter vendors read as a site that does not want to be
// indexed; `test/public-website.test.js` pins what is here.
export const RESPONSE_POLICY = name => ({
  Name: name,
  Comment: 'Public thinker.sh: cacheable pages with standard security headers',
  SecurityHeadersConfig: {
    // IncludeSubdomains is off on purpose: the policy also answers on zerotime.dev, whose other
    // subdomains are not this site's to commit to HTTPS.
    StrictTransportSecurity: { Override: true, AccessControlMaxAgeSec: 31536000, IncludeSubdomains: false, Preload: false },
    ContentTypeOptions: { Override: true },
    FrameOptions: { Override: true, FrameOption: 'DENY' },
    ReferrerPolicy: { Override: true, ReferrerPolicy: 'strict-origin-when-cross-origin' },
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
