// CloudFront Functions runtime 2.0: public site, with the S3 origin kept private.
function handler(event) {
    var request = event.request;
    var uri = request.uri;
    if (/[\\%]/.test(uri) || uri.indexOf('//') !== -1 || /\/(?:\.|\.\.)(?:\/|$)/.test(uri)) return { statusCode: 400 };
    if (request.headers.host && request.headers.host.value === 'www.zerotime.dev') {
        return { statusCode: 302, headers: { location: { value: 'https://zerotime.dev' + uri } } };
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return { statusCode: 405 };
    // Old installed clients retain these distribution URLs. Downloads are now public.
    var legacy = uri.match(/^\/access\/download\/[a-f0-9]{64}\/(install.sh|installer.sh|thinker.tgz|version.json)$/);
    if (legacy) { request.uri = '/dist/' + (legacy[1] === 'installer.sh' ? 'install.sh' : legacy[1]); return request; }
    if (uri === '/access/session') return { statusCode: 200, headers: {
        'content-type': { value: 'application/json' }, 'cache-control': { value: 'no-store' }
    }, body: request.method === 'HEAD' ? '' : JSON.stringify({ installCommand: 'curl -fsSL https://zerotime.dev/dist/install.sh | bash' }) };
    if (/^\/docs(?:\.html|\/index\.html|\/)?$/.test(uri)) { request.uri = '/docs.html'; return request; }
    if (/^\/(?:[Tt]hinker101\/)?install.sh$/.test(uri)) { request.uri = '/dist/install.sh'; return request; }
    if (uri === '/' || uri === '/index.html' || /^\/message\.(js|css)$/.test(uri) ||
        /^\/dist\/(thinker\.tgz|install\.sh|version\.json)$/.test(uri) ||
        /^\/(favicon(?:-16x16|-32x32)?\.(?:ico|png|svg)|apple-touch-icon.png)$/.test(uri)) return request;
    if (uri === '/gokce-bday' || uri.indexOf('/gokce-bday/') === 0) {
        if (uri.split('/').pop().indexOf('.') === -1) request.uri = uri.replace(/\/$/, '') + '/index.html';
        return request;
    }
    return { statusCode: 404 };
}
