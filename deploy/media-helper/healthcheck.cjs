'use strict';
const fs = require('node:fs');
(async () => {
    const token = fs.readFileSync(process.env.EUFY_MEDIA_SECRET_FILE || '/data/auth.key', 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw Error();
    const port = Number(process.env.EUFY_MEDIA_PORT || 8769);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error();
    const response = await fetch(`http://127.0.0.1:${port}/v1/health`, {
        headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw Error();
    const health = await response.json();
    if (health.protocol !== 1 || health.version !== '0.1.0' || health.sdk !== '4.2.6') throw Error();
})().catch(() => { process.exitCode = 1; });
