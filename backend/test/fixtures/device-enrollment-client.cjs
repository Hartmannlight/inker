const assert = require('node:assert/strict');

// Match the immutable 800x480 monochrome PNGs used by these container fixtures.
const capabilitiesOverride = { display: { width: 800, height: 480, colorSpace: 'monochrome',
  bitDepth: 1, renderFormats: ['png'], mimeTypes: ['image/png'] } };

async function enroll(request, device, secrets) {
  const invitation = await request(`/api/devices/${device.id}/enrollments`, { method: 'POST', admin: true });
  assert.equal(invitation.response.status, 201);
  assert.equal(typeof invitation.body.code, 'string');
  secrets.push(invitation.body.code);
  const exchangeCode = () => request('/api/device-enrollments/exchange', { method: 'POST', data: { code: invitation.body.code } });
  let exchange = await exchangeCode();
  if (exchange.response.status === 429) {
    // A smoke run enrolls several independent fixtures from one client IP.
    // Respect the real production limit rather than disabling its guard.
    const retryAfter = Number(exchange.response.headers.get('retry-after'));
    assert.ok(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 60);
    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000 + 100));
    exchange = await exchangeCode();
  }
  assert.equal(exchange.response.status, 200);
  assert.equal(typeof exchange.body.credential, 'string');
  assert.ok(exchange.body.credential.length > 0);
  secrets.push(exchange.body.credential);
  return exchange.body.credential;
}

module.exports = { enroll, capabilitiesOverride };
