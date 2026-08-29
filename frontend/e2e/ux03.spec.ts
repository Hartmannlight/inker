import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

const pin = process.env.E2E_ADMIN_PIN;

test.skip(!pin, 'Set E2E_ADMIN_PIN for the isolated local Inker test stack.');

test('UX-03 admin pages avoid retired device-image routes', async ({ page }) => {
  const retired: string[] = [];
  const gone: string[] = [];
  page.on('response', response => {
    if (/\/api\/device-images\//.test(response.url())) retired.push(`${response.status()} ${response.url()}`);
    if (response.status() === 410) gone.push(response.url());
  });
  await page.goto('/login');
  await page.getByLabel(/pin|password/i).fill(pin!);
  await page.getByRole('button', { name: /sign in|login/i }).click();
  await expect(page).toHaveURL(/\/(dashboard)?$/);
  await page.goto('/dashboard');
  await expect(page.locator('main')).toBeVisible();
  await page.goto('/screens');
  await expect(page.getByRole('heading', { name: 'Screens', exact: true })).toBeVisible();
  await page.goto('/playlists');
  await expect(page.getByRole('heading', { name: 'Playlists', exact: true })).toBeVisible();

  await page.goto('/devices/new');
  await page.getByRole('button', { name: /web display/i }).click();
  await page.getByLabel(/device name/i).fill('UX-03 preview fixture');
  await page.getByRole('button', { name: /create and pair/i }).click();
  await page.getByRole('link', { name: /view device details/i }).click();
  await expect(page).toHaveURL(/\/devices\/\d+$/);
  const deviceDetailUrl = page.url();
  await expect(page.getByText(/no published content is assigned/i)).toBeVisible();

  await page.goto('/screens/new');
  await page.getByLabel(/screen name/i).fill('UX-03 upload fixture');
  await page.locator('input[type="file"]').setInputFiles(resolve(process.cwd(), '../backend/assets/test.png'));
  await page.getByRole('button', { name: /upload screen/i }).click();
  await expect(page).toHaveURL(/\/screens\/\d+$/);

  await page.goto('/screens/designer');
  await page.getByRole('button', { name: /trmnl standard/i }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByPlaceholder('Enter design name').fill('UX-03 design fixture');
  await page.getByRole('button', { name: 'Save', exact: true }).last().click();
  await expect(page).toHaveURL(/\/screens\/designer\/\d+$/);
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText(/published revision \d+/i).first()).toBeVisible();

  await page.goto('/playlists/new');
  await page.getByLabel(/playlist name/i).fill('UX-03 assigned fixture');
  const designOption = await page.getByLabel(/select screen/i).locator('option').evaluateAll(options =>
    options.find(option => option.textContent?.includes('UX-03 design fixture'))?.getAttribute('value') ?? null,
  );
  expect(designOption).not.toBeNull();
  await page.getByLabel(/select screen/i).selectOption(designOption!);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: /create playlist/i }).click();
  await expect(page).toHaveURL(/\/playlists\/\d+$/);
  await page.getByRole('button', { name: /assign device/i }).click();
  await page.getByLabel('Device').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Assign Playlist', exact: true }).click();

  await page.goto(deviceDetailUrl);
  await expect(page.getByRole('heading', { name: 'Content', exact: true })).toBeVisible();
  expect(retired).toEqual([]);
  expect(gone).toEqual([]);
});
