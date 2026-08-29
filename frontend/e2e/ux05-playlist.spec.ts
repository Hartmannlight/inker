import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

const pin = process.env.E2E_ADMIN_PIN;
test.skip(!pin, 'Set E2E_ADMIN_PIN for the isolated local Inker test stack.');

test('UX-05 publishes explicit playlist bindings for playback', async ({ page }) => {
  const suffix = Date.now();
  const screenName = `UX-05 playlist screen ${suffix}`;
  const playlistName = `UX-05 playlist ${suffix}`;
  await page.goto('/login');
  await page.getByLabel(/pin|password/i).fill(pin!);
  await page.getByRole('button', { name: /sign in|login/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto('/screens/new');
  await page.getByLabel(/screen name/i).fill(screenName);
  await page.locator('input[type="file"]').setInputFiles(resolve(process.cwd(), '../backend/assets/test.png'));
  await page.getByRole('button', { name: /upload screen/i }).click();
  await expect(page).toHaveURL(/\/screens\/\d+$/);

  await page.goto('/playlists/new');
  await page.getByLabel(/playlist name/i).fill(playlistName);
  const value = await page.getByLabel(/select screen/i).locator('option').evaluateAll((options, name) => options.find(option => option.textContent?.includes(name))?.getAttribute('value') ?? null, screenName);
  expect(value).not.toBeNull();
  await page.getByLabel(/select screen/i).selectOption(value!);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: /create playlist/i }).click();
  await expect(page).toHaveURL(/\/playlists\/\d+$/);
  await page.getByRole('button', { name: /publish for playback/i }).click();
  await expect(page.getByText(/playlist revision published for playback/i)).toBeVisible();
  const playlistId = new URL(page.url()).pathname.match(/playlists\/(\d+)/)?.[1];
  expect(playlistId).toBeTruthy();

  await page.goto('/devices/new');
  await page.getByRole('button', { name: /web display/i }).click();
  await page.getByLabel(/device name/i).fill(`UX-05 playlist device ${suffix}`);
  await page.getByRole('button', { name: /create and pair/i }).click();
  await page.getByRole('link', { name: /view device details/i }).click();
  await page.getByRole('button', { name: 'Change content', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`${playlistName} Rotating playlist`) }).last().click();
  await expect(page.getByText('Rotating playlist', { exact: true }).last()).toBeVisible();

  const command = { version: 1, idempotencyKey: crypto.randomUUID() };
  const publishInTab = (target: typeof page) => target.evaluate(async ({ playlistId, command }) => {
    const session = await fetch('/api/auth/session');
    const csrf = session.headers.get('x-csrf-token');
    const draft = await fetch(`/api/playback/playlists/${playlistId}/draft`);
    const expectedDraftHash = (await draft.json()).data.draftHash;
    const response = await fetch(`/api/playback/playlists/${playlistId}/publish-from-draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
      body: JSON.stringify({ ...command, expectedDraftHash }),
    });
    return { status: response.status, body: await response.json() };
  }, { playlistId: playlistId!, command });
  const secondAdminTab = await page.context().newPage();
  await secondAdminTab.goto('/dashboard');
  const [first, second] = await Promise.all([publishInTab(page), publishInTab(secondAdminTab)]);
  await secondAdminTab.close();
  expect(first.status).toBeLessThan(300);
  expect(second.status).toBeLessThan(300);
  expect(first.body.data.playlistRevisionId).toBe(second.body.data.playlistRevisionId);
});
