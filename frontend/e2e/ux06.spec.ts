import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

const pin = process.env.E2E_ADMIN_PIN;

test.skip(!pin, 'Set E2E_ADMIN_PIN for the isolated local Inker test stack.');

test('UX-06 keeps a risky raster selectable and requires a target-fit review', async ({ page }) => {
  const suffix = Date.now();
  const screenName = `UX-06 raster ${suffix}`;
  const deviceName = `UX-06 device ${suffix}`;
  const unexpectedResponses: number[] = [];
  page.on('response', response => {
    if (response.status() === 410 || response.status() === 503) unexpectedResponses.push(response.status());
  });

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
  await page.getByLabel(/screen name/i).fill(screenName);
  await page.locator('input[type="file"]').setInputFiles(resolve(process.cwd(), '../backend/assets/test.png'));
  await page.getByRole('button', { name: /upload screen/i }).click();
  await expect(page).toHaveURL(/\/screens\/\d+$/);

  await page.goto(deviceUrl);
  await page.getByRole('button', { name: 'Change content', exact: true }).click();
  const choice = page.getByRole('button', { name: new RegExp(`${screenName}.*Risky.*Single screen`, 'i') });
  await expect(choice).toBeVisible();
  await expect(choice).toHaveAccessibleName(/Risky:/);
  await expect(choice).toHaveAccessibleName(/raster|orientation|aspect ratio/i);
  await choice.click();

  const review = page.getByRole('dialog', { name: 'Review screen fit' });
  await expect(review).toBeVisible();
  await expect(review.getByLabel('Target device preview with safe area')).toBeVisible();
  await expect(review.getByText(/contain by default; crop is never implicit/i)).toBeVisible();
  await page.getByRole('button', { name: 'Assign after review', exact: true }).click();
  await expect(page.getByText('Single screen', { exact: true }).last()).toBeVisible();
  expect(unexpectedResponses).toEqual([]);
});
