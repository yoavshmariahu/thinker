// CloudFront Functions runtime 2.0: public site, with the S3 origin kept private.
function handler(event) {
    var request = event.request;
    var uri = request.uri;
    if (/[\\%]/.test(uri) || uri.indexOf('//') !== -1 || /\/(?:\.|\.\.)(?:\/|$)/.test(uri)) return { statusCode: 400 };
    var host = request.headers.host && request.headers.host.value;
    var dataPage = /^\/(?:see-the-data|compression|clearing)(?:\.html|\/)?$/.test(uri);
    var tourPage = /^\/how-it-works(?:\.html|\/)?$/.test(uri);
    var canonicalUri = dataPage ? '/see-the-data' : tourPage ? '/how-it-works' : uri;
    if (host === 'zerotime.dev' || host === 'www.zerotime.dev' || host === 'www.thinker.sh' || canonicalUri !== uri) {
        // CloudFront supplies encoded query names/values; keep them and repeated keys intact.
        var query = request.querystring || {};
        var parts = [];
        Object.keys(query).forEach(function (key) {
            var values = query[key].multiValue || [query[key]];
            values.forEach(function (entry) { parts.push(key + '=' + entry.value); });
        });
        return { statusCode: 301, headers: { location: { value: 'https://thinker.sh' + canonicalUri + (parts.length ? '?' + parts.join('&') : '') } } };
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return { statusCode: 405 };
    // Old installed clients retain these distribution URLs. Downloads are now public.
    var legacy = uri.match(/^\/access\/download\/[a-f0-9]{64}\/(install.sh|installer.sh|thinker.tgz|version.json)$/);
    if (legacy) { request.uri = '/dist/' + (legacy[1] === 'installer.sh' ? 'install.sh' : legacy[1]); return request; }
    if (uri === '/access/session') return { statusCode: 200, headers: {
        'content-type': { value: 'application/json' }, 'cache-control': { value: 'no-store' }
    }, body: request.method === 'HEAD' ? '' : JSON.stringify({ installCommand: 'curl -fsSL https://raw.githubusercontent.com/yoavshmariahu/thinker/main/install.sh | bash' }) };
    if (/^\/docs(?:\.html|\/index\.html|\/)?$/.test(uri)) { request.uri = '/docs.html'; return request; }
    // Crawlers and web-filter vendors read these before they categorize a site; the root security.txt is the RFC 9116 legacy alias.
    if (uri === '/security.txt') { request.uri = '/.well-known/security.txt'; return request; }
    if (uri === '/robots.txt' || uri === '/sitemap.xml' || uri === '/.well-known/security.txt') return request;
    if (uri === '/how-it-works') { request.uri = '/how-it-works.html'; return request; }
    if (uri === '/see-the-data') { request.uri = '/compression.html'; return request; }
    if (/^\/(?:[Tt]hinker101\/)?install.sh$/.test(uri)) { request.uri = '/dist/install.sh'; return request; }
    if (uri === '/' || uri === '/index.html' || uri === '/nav.css' || uri === '/home.css' || uri === '/card.png' || /^\/clearing-[a-z0-9-]+\.json$/.test(uri) || /^\/message\.(js|css)$/.test(uri) ||
        /^\/dist\/(thinker\.tgz|install\.sh|version\.json)$/.test(uri) ||
        /^\/(favicon(?:-16x16|-32x32)?\.(?:ico|png|svg)|apple-touch-icon.png)$/.test(uri)) return request;
    if (uri === '/gokce-bday' || uri.indexOf('/gokce-bday/') === 0) {
        if (uri.split('/').pop().indexOf('.') === -1) request.uri = uri.replace(/\/$/, '') + '/index.html';
        return request;
    }
    return { statusCode: 404 };
}
