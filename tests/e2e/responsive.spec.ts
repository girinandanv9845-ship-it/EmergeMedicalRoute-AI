/// <reference lib="dom" />
import { expect, test } from '@playwright/test';

test('mobile layout: collapsible navigation and no horizontal page scroll', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('demo-banner')).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'New Intake' }).click();
  await expect(page.getByRole('heading', { name: 'New appointment request' })).toBeVisible();
  await expect(page.getByText(/This form is not an emergency service/)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
