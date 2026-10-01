// CloudFront Functions runtime 2.0. Deployment injects secrets; never serve this file.
var crypto = require('crypto');
var CONFIG = __ACCESS_CONFIG__;
var COOKIE = '__Host-thinker_session';
var SESSION_SECONDS = 604800;

function equal(a, b) {
    if (typeof a !== 'string' || a.length !== b.length) return false;
    var difference = 0;
    for (var i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return difference === 0;
}
function sign(value) {
    return crypto.createHmac('sha256', CONFIG.signingKey).update(value).digest('hex');
}
function codeValid(value) {
    var hash = crypto.createHash('sha256').update(value.trim()).digest('hex');
    var hashes = CONFIG.codeHashes || [CONFIG.codeHash];
    var matched = false;
    for (var i = 0; i < hashes.length; i++) matched = equal(hash, hashes[i]) || matched;
    return matched;
}
function response(status, body, type) {
    return { statusCode: status, headers: {
        'cache-control': { value: 'private, no-store' },
        'content-type': { value: type || 'application/json' },
        'referrer-policy': { value: 'no-referrer' },
        'x-content-type-options': { value: 'nosniff' }
    }, body: body || '' };
}
function sessionValid(request) {
    var cookie = request.cookies[COOKIE];
    if (!cookie || cookie.multiValue) return false;
    var parts = cookie.value.split('.');
    if (parts.length !== 2 || !/^\d{10}$/.test(parts[0])) return false;
    var expires = Number(parts[0]);
    var now = Math.floor(Date.now() / 1000);
    return expires > now && expires <= now + SESSION_SECONDS && equal(parts[1], sign('session:' + parts[0]));
}
function publicPath(uri) {
    // Fixed deadline checked on every request, before cache lookup.
    var legacyDownload = /^\/dist\/(thinker\.tgz|install\.sh|version\.json)$/.test(uri) &&
        Date.now() < Date.parse(CONFIG.legacyDownloadsUntil || '');
    return legacyDownload || uri === '/' || uri === '/index.html' ||
        /^\/(favicon(?:-(?:16x16|32x32|48x48))?\.(?:ico|png|svg)|apple-touch-icon\.png|icon-(?:192|512)\.png|og-image\.png|site\.webmanifest)$/.test(uri) ||
        uri === '/gokce-bday' || uri.indexOf('/gokce-bday/') === 0;
}
function handler(event) {
    var request = event.request;
    var uri = request.uri;
    // Reject ambiguous paths before classifying or rewriting them.
    if (/[\\%]/.test(uri) || uri.indexOf('//') !== -1 || /\/(?:\.|\.\.)(?:\/|$)/.test(uri)) {
        return response(400, '{"error":"Invalid path"}');
    }
    var host = request.headers.host && request.headers.host.value;
    if (host === 'www.zerotime.dev') {
        var redirect = response(302);
        redirect.headers.location = { value: 'https://zerotime.dev' + uri };
        return redirect;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return response(405);
    var authorized = sessionValid(request);
    if (uri === '/access/session') {
        if (request.method !== 'GET') return response(405);
        var origin = request.headers.origin;
        var fetchSite = request.headers['sec-fetch-site'];
        if ((origin && origin.value !== 'https://zerotime.dev') ||
            (fetchSite && fetchSite.value !== 'same-origin' && fetchSite.value !== 'none')) return response(403);
        var code = request.headers['x-thinker-access-code'];
        if (code) {
            if (code.multiValue || code.value.length > 256 || !codeValid(code.value))
                return response(401, '{"error":"Invalid access code"}');
            authorized = true;
        }
        if (!authorized) return response(401, '{"error":"Access code required"}');
        var base = 'https://zerotime.dev/access/download/' + sign('download');
        var result = response(200, JSON.stringify({ installCommand: 'curl -fsSL ' + base + '/install.sh | bash' }));
        // Restoring a session does not extend its lifetime.
        if (code) {
            var expires = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
            result.cookies = {};
            result.cookies[COOKIE] = { value: expires + '.' + sign('session:' + expires),
                attributes: 'Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=' + SESSION_SECONDS };
        }
        return result;
    }
    var download = uri.match(/^\/access\/download\/([a-f0-9]{64})\/(install.sh|installer.sh|thinker.tgz|version.json)$/);
    if (download) {
        if (!equal(download[1], sign('download'))) return response(403, '{"error":"Access denied"}');
        if (download[2] === 'install.sh') {
            var base = 'https://zerotime.dev/access/download/' + download[1];
            var script = '#!/usr/bin/env bash\nset -euo pipefail\n' +
                'export THINKER_DIST_URL="' + base + '/thinker.tgz"\n' +
                'installer=$(mktemp)\ntrap \'rm -f "$installer"\' EXIT\n' +
                'curl -fsSL "' + base + '/installer.sh" -o "$installer"\n' +
                'bash "$installer" "$@"\n';
            return response(200, request.method === 'HEAD' ? '' : script, 'text/plain; charset=utf-8');
        }
        request.uri = '/dist/' + (download[2] === 'installer.sh' ? 'install.sh' : download[2]);
        return request;
    }
    if (uri.indexOf('/access/') === 0) return response(404);
    if (!publicPath(uri) && !authorized) {
        if (/^\/docs(?:\.html|\/|$)/i.test(uri)) {
            var login = response(302);
            login.headers.location = { value: '/?next=' + encodeURIComponent(uri) };
            return login;
        }
        return response(403, '{"error":"Access code required"}');
    }
    // Preserve the existing S3 directory-index routing.
    if (uri !== '/' && uri.split('/').pop().indexOf('.') === -1) {
        request.uri = (uri.endsWith('/') ? uri.slice(0, -1) : uri) + '/index.html';
    }
    return request;
}
