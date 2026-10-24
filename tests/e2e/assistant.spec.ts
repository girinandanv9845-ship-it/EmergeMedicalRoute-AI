import { expect, test } from '@playwright/test';

// E2E servers run with AI_PROVIDER=disabled, so these cover the deterministic parts of the assistant:
// the emergency gate, the honest "unavailable" state, and handing the draft to the form.

test('assistant: emergency in chat shows guidance and locks the chat', async ({ page }) => {
  await page.goto('/assistant');
  await expect(page.getByText(/I'm the clinic's AI intake assistant/)).toBeVisible();
  await page.getByLabel('Message the intake assistant').fill('My mum collapsed and is not responding');
  await page.getByLabel('Message the intake assistant').press('Enter');
  const banner = page.getByTestId('emergency-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('EMERG-UNRESP-01');
  await expect(page.getByText('Safety rule — AI not used')).toBeVisible();
  await expect(page.getByLabel('Message the intake assistant')).toHaveCount(0);
});

test('assistant: without Ollama it says so honestly and hands the draft to the form for submission', async ({ page }) => {
  await page.goto('/assistant');
  await expect(page.getByTestId('assistant-ai-status')).toContainText('Local AI unavailable');
  await page.getByLabel('Message the intake assistant').fill('I would like to book my annual check-up and a flu shot');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('AI unavailable', { exact: true })).toBeVisible();
  await expect(page.getByTestId('assistant-draft')).toContainText('annual check-up');
  await page.getByTestId('assistant-review').click();

  await expect(page.getByRole('heading', { name: 'New appointment request' })).toBeVisible();
  await expect(page.getByText(/Prefilled from your conversation with the AI intake assistant/)).toBeVisible();
  await expect(page.getByLabel(/Describe the concern/)).toHaveValue('I would like to book my annual check-up and a flu shot');
  await page.getByLabel(/Age group/).selectOption('40_64');
  await page.getByLabel(/Approximate onset/).selectOption('UNKNOWN');
  await page.getByLabel('Routine', { exact: true }).check();
  const d = new Date();
  d.setDate(d.getDate() + 3);
  await page.getByLabel(/Preferred date/).fill(d.toISOString().slice(0, 10));
  await page.getByLabel(/Preferred time/).selectOption('MORNING');
  await page.getByRole('button', { name: /Submit request/ }).click();
  await expect(page.getByRole('heading', { name: 'Request submitted and routed' })).toBeVisible();
  await expect(page.getByTestId('recommendation-panel')).toContainText('ROUTINE-ADMIN-01');
});
