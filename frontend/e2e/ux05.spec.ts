import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

const pin = process.env.E2E_ADMIN_PIN;

test.skip(!pin, 'Set E2E_ADMIN_PIN for the isolated local Inker test stack.');

test('UX-05 assigns an uploaded screen directly from device content', async ({ page }) => {
  const fixtureName = `UX-05 direct screen ${Date.now()}`;
  const deviceName = `UX-05 direct device ${Date.now()}`;
  await page.goto('/login');
  await page.getByLabel(/pin|password/i).fill(pin!);
  await page.getByRole('button', { name: /sign in|login/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto('/devices/new');
  await page.getByRole('button', { name: /web display/i }).click();
  await page.getByLabel(/device name/i).fill(deviceName);
  await page.getByRole('button', { name: /create and pair/i }).click();
  await page.getByRole('link', { name: /view device details/i }).click();
  const deviceUrl = page.url();

  await page.goto('/screens/new');
  await page.getByLabel(/screen name/i).fill(fixtureName);
  await page.locator('input[type="file"]').setInputFiles(resolve(process.cwd(), '../backend/assets/test.png'));
  await page.getByRole('button', { name: /upload screen/i }).click();
  await expect(page).toHaveURL(/\/screens\/\d+$/);
  const screenUrl = page.url();

  await page.goto(deviceUrl);
  await page.getByRole('button', { name: 'Change content', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`${fixtureName}.*Single screen`) }).click();
  if (await page.getByRole('button', { name: 'Assign after review', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Assign after review', exact: true }).click();
  }
  await expect(page.getByText('Single screen', { exact: true }).last()).toBeVisible();
  await expect(page.getByAltText('Current published device content')).toBeVisible();

  await page.goto(screenUrl + '?assign=1');
  await page.getByRole('checkbox', { name: `${deviceName} Web display`, exact: true }).check();
  await page.getByRole('button', { name: 'Assign 1 device', exact: true }).click();
  await expect(page.getByText('Screen assigned to selected devices')).toBeVisible();

  await page.goto(deviceUrl);
  await page.getByRole('button', { name: 'Change content', exact: true }).click();
  await page.getByRole('button', { name: 'Choose later', exact: true }).click();
  await expect(page.getByText('No content selected', { exact: true })).toBeVisible();
});

test('UX-05 pairs a screen-assigned web display and receives the publication', async ({ page, browser }) => {
  test.setTimeout(60_000);
  const suffix = Date.now();
  const screenName = `UX-05 paired screen ${suffix}`;
  const deviceName = `UX-05 paired device ${suffix}`;
  await page.goto('/login');
  await expect(page.getByRole('button', { name: /sign in|login/i })).toBeVisible();
  const login = await page.evaluate(async (password) => {
    const response = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ password }),
    });
    return response.status;
  }, pin!);
  expect(login).toBeLessThan(300);
  await page.goto('/screens/new');
  await page.getByLabel(/screen name/i).fill(screenName);
  await page.locator('input[type="file"]').setInputFiles(resolve(process.cwd(), '../backend/assets/test.png'));
  await page.getByRole('button', { name: /upload screen/i }).click();
  await expect(page).toHaveURL(/\/screens\/\d+$/);

  await page.goto('/devices/new');
  await page.getByRole('button', { name: /web display/i }).click();
  await page.getByLabel(/device name/i).fill(deviceName);
  await page.getByRole('button', { name: /create and pair/i }).click();
  await page.getByRole('button', { name: new RegExp(`${screenName}.*Single screen`) }).click();
  await expect(page.getByText('Single screen assigned.')).toBeVisible();
  const code = await page.getByText(/^[0-9A-HJKMNP-TV-Z-]{10,12}$/).textContent();
  expect(code).toBeTruthy();

  const displayContext = await browser.newContext();
  const display = await displayContext.newPage();
  try {
    const pairingUrl = new URL('/', process.env.E2E_BASE_URL ?? 'http://127.0.0.1:18080');
    pairingUrl.searchParams.set('mode', 'pair');
    pairingUrl.searchParams.set('code', code!);
    await display.goto(pairingUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 10_000 });
    await expect(display.getByLabel('Pairing code')).toBeVisible({ timeout: 10_000 });
    await display.getByLabel('Pairing code').fill(code!);
    await display.getByRole('button', { name: 'Pair display', exact: true }).click();
    await expect(display).toHaveURL(/\/display\//);
    await expect(display.getByAltText('Published content')).toBeVisible({ timeout: 15_000 });
  } finally {
    await display.close();
    await displayContext.close();
  }
});
