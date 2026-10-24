import { expect, test, type Page } from '@playwright/test';

async function fillIntake(page: Page, opts: { description: string; urgency?: 'Routine' | 'Urgent'; onset?: string }) {
  await page.goto('/intake');
  await page.getByLabel(/Age group/).selectOption('40_64');
  await page.getByLabel(/Describe the concern/).fill(opts.description);
  await page.getByLabel(/Approximate onset/).selectOption(opts.onset ?? 'TODAY');
  await page.getByLabel(opts.urgency ?? 'Routine', { exact: true }).check();
  const d = new Date();
  d.setDate(d.getDate() + 3);
  await page.getByLabel(/Preferred date/).fill(d.toISOString().slice(0, 10));
  await page.getByLabel(/Preferred time/).selectOption('MORNING');
}

test('demo banner and navigation pages load', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('demo-banner')).toHaveText('DEMO MODE — SYNTHETIC DATA ONLY');
  await expect(page.getByRole('heading', { name: 'Operations overview' })).toBeVisible();
  for (const [link, heading] of [
    ['Request Queue', 'Request queue'],
    ['Routing Policy', 'Routing policy'],
    ['Test Lab', 'Test Lab'],
    ['Analytics', 'Analytics & evaluation'],
    ['Audit Log', 'Audit log'],
    ['Settings & Safety', 'Settings & safety'],
    ['Case Details', 'Case details'],
  ]) {
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: link }).click();
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
  }
});

test('complete intake and staff review workflow', async ({ page }) => {
  await fillIntake(page, { description: 'I would like to book my annual check-up and a flu shot, no rush.', onset: 'UNKNOWN' });
  await page.getByRole('button', { name: /Submit request/ }).click();
  await expect(page.getByRole('heading', { name: 'Request submitted and routed' })).toBeVisible();
  const panel = page.getByTestId('recommendation-panel');
  await expect(panel.locator('[data-route="ROUTINE_APPOINTMENT"]').first()).toBeVisible();
  await expect(panel).toContainText('ROUTINE-ADMIN-01');
  await page.getByRole('link', { name: /Open case SYN-/ }).click();
  await expect(page.getByRole('heading', { name: /Case SYN-/ })).toBeVisible();
  await page.getByRole('button', { name: 'Approve recommendation' }).click();
  await expect(page.getByText('Recommendation approved (administrative review).')).toBeVisible();
  await expect(page.getByText('Approved by staff').first()).toBeVisible();
});

test('emergency guidance workflow shows immediately and persists on the case', async ({ page }) => {
  await fillIntake(page, { description: 'My father suddenly has crushing chest pain spreading to his arm.', urgency: 'Urgent' });
  await page.getByRole('button', { name: /Submit request/ }).click();
  const banner = page.getByTestId('emergency-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Contact your local emergency services immediately.');
  await expect(banner).toContainText('has NOT contacted emergency services');
  await expect(banner).toContainText('EMERG-CHEST-01');
  await page.getByRole('link', { name: /Open case SYN-/ }).click();
  await expect(page.getByTestId('emergency-banner')).toBeVisible();
});

test('unclear description takes the safe fallback route', async ({ page }) => {
  await fillIntake(page, { description: 'I just feel off and something is not right.', onset: 'UNKNOWN' });
  await page.getByRole('button', { name: /Submit request/ }).click();
  const panel = page.getByTestId('recommendation-panel');
  await expect(panel.locator('[data-route="NEEDS_CLARIFICATION_OR_HUMAN_REVIEW"]').first()).toBeVisible();
  await expect(page.getByTestId('uncertainty-reasons')).toContainText('Ambiguous description');
  await expect(panel.locator('[data-route="ROUTINE_APPOINTMENT"]')).toHaveCount(0);
});

test('staff override with reason is recorded in history and the audit log', async ({ page }) => {
  await fillIntake(page, { description: 'My cough has been getting worse for three days.', onset: '1_3_DAYS' });
  await page.getByRole('button', { name: /Submit request/ }).click();
  await page.getByRole('link', { name: /Open case SYN-/ }).click();
  const caseId = (await page.getByRole('heading', { name: /Case SYN-/ }).textContent())!.replace('Case ', '').trim();

  await page.getByRole('button', { name: /Override route/ }).click();
  await page.getByLabel('Final administrative route').selectOption('ROUTINE_APPOINTMENT');
  await page.getByRole('button', { name: 'Submit override' }).click();
  await expect(page.getByText(/A reason of at least 10 characters is required/)).toBeVisible();
  await page.getByLabel(/Reason for override/).fill('Phoned requester; cough improving, routine slot agreed.');
  await page.getByRole('button', { name: 'Submit override' }).click();
  await expect(page.getByText(/Override recorded/)).toBeVisible();
  await expect(page.getByTestId('review-history')).toContainText('Phoned requester');
  // Original recommendation preserved
  await expect(page.getByTestId('recommendation-panel').locator('[data-route="SAME_DAY_HUMAN_REVIEW"]').first()).toBeVisible();

  await page.goto(`/audit?requestId=${caseId}`);
  await expect(page.getByTestId('audit-table')).toContainText('Staff override submitted');
});

test('running the synthetic test suite from the interface', async ({ page }) => {
  await page.goto('/tests');
  await page.getByRole('button', { name: /Run all tests/ }).click();
  await expect(page.getByTestId('test-overall')).toContainText('All executed tests passed', { timeout: 30_000 });
  await expect(page.getByTestId('test-row-TC-06')).toContainText('Passed');
  await expect(page.getByTestId('test-row-TC-31')).toContainText('Skipped');
});
