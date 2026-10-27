import { test as base, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const PASSWORD = 'a-long-enough-password';
const uniqueEmail = (label: string) => `e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;

interface Fixtures {
  /** Fails the test if the page logs an error or the browser blocks something with the CSP. */
  guarded: Page;
  /** A page that has already registered a fresh account. */
  account: { page: Page; email: string };
}

export const test = base.extend<Fixtures>({
  guarded: async ({ page }, use) => {
    const problems: string[] = [];
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        console.error(`CSP violation: ${event.violatedDirective} blocked ${event.blockedURI}`);
      });
    });
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      // Expected while signed out or offline; everything else is a bug.
      if (/status of (401|400|409)|ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(text)) return;
      problems.push(`console.error: ${text}`);
    });
    await use(page);
    expect(problems, 'browser console must stay clean').toEqual([]);
  },

  account: async ({ guarded: page }, use) => {
    const email = uniqueEmail('acct');
    await register(page, email);
    await use({ page, email });
  },
});

async function register(page: Page, email: string) {
  await page.goto('/');
  await page.waitForURL('**/login');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/notes/**');
  await page.locator('.cm-content').waitFor();
}

const status = (page: Page) => page.getByRole('status').first();
const editorText = (page: Page) => page.locator('.cm-content');
const waitSaved = (page: Page) => expect(status(page)).toContainText('Saved', { timeout: 12_000 });

test.describe('accounts', () => {
  test('validation, sign-up, sign-out and sign-in', async ({ guarded: page }) => {
    const email = uniqueEmail('auth');
    await page.goto('/notes');
    await page.waitForURL('**/login');

    await page.getByRole('button', { name: 'Create an account' }).click();
    await page.fill('#auth-email', email);
    await page.fill('#auth-password', 'short');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('alert')).toContainText('10');

    await page.fill('#auth-password', PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForURL('**/notes/**');

    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.waitForURL('**/login');

    await page.fill('#auth-email', email);
    await page.fill('#auth-password', 'not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('incorrect');

    await page.fill('#auth-password', PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/notes/**');
  });

  test("one account cannot read another's notes", async ({ account, browser }) => {
    const { page } = account;
    await editorText(page).click();
    await page.keyboard.type('private thought');
    await waitSaved(page);
    const id = page.url().split('/notes/')[1];

    const other = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const otherPage = await other.newPage();
    await register(otherPage, uniqueEmail('other'));
    const response = await otherPage.evaluate((noteId) => fetch(`/api/documents/${noteId}`).then((r) => r.status), id);
    expect(response).toBe(404);
    await other.close();
  });
});

test.describe('writing', () => {
  test('formatting commands, split preview and persistence across reload', async ({ account }) => {
    const { page } = account;
    await editorText(page).click();
    await page.keyboard.type('# Plan');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('keep it simple');
    await page.keyboard.press('Shift+Home'); // select just this line
    await page.getByRole('button', { name: 'Bold' }).click();
    await expect(editorText(page)).toContainText('**keep it simple**');
    await page.keyboard.press('Control+B');
    await expect(editorText(page)).not.toContainText('**');

    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Bulleted list' }).click();
    await page.keyboard.type('first item');
    await expect(editorText(page)).toContainText('- first item');

    await page.getByRole('button', { name: 'Split' }).click();
    await expect(page.locator('.markdown-preview h1')).toHaveText('Plan');
    await expect(page.locator('.markdown-preview li')).toHaveText('first item');
    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.locator('.cm-content')).toHaveCount(0);
    await page.getByRole('button', { name: 'Write' }).click();

    await waitSaved(page);
    await page.reload();
    await expect(editorText(page)).toContainText('# Plan');
    await expect(editorText(page)).toContainText('- first item');
  });

  test('raw HTML and script URLs in a note are not executed', async ({ account }) => {
    const { page } = account;
    await editorText(page).click();
    await page.keyboard.type('<img src=x onerror="window.__pwned=1"> [click](javascript:window.__pwned=2)');
    await page.getByRole('button', { name: 'Preview' }).click();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await expect(page.locator('.markdown-preview a[href^="javascript"]')).toHaveCount(0);
  });
});

test.describe('links', () => {
  test('a link to a note that is not on this device yet opens that note', async ({ account, browser }) => {
    const { page } = account;
    await page.getByLabel('Note title').fill('Shared plan');
    await editorText(page).click();
    await page.keyboard.type('reachable by link');
    await waitSaved(page);
    const noteUrl = page.url();

    // Same account, but a fresh browser profile: cookies carry over, the offline database does not.
    const second = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      storageState: await page.context().storageState(),
    });
    const secondPage = await second.newPage();
    await secondPage.goto(noteUrl);
    await expect(secondPage.getByLabel('Note title')).toHaveValue('Shared plan');
    await expect(secondPage.locator('.cm-content')).toContainText('reachable by link');
    expect(secondPage.url()).toBe(noteUrl);
    await second.close();
  });
});

test.describe('library', () => {
  test('new note, pin, palette navigation and delete', async ({ account }) => {
    const { page } = account;
    await editorText(page).click();
    await page.keyboard.type('alpha note body');
    await waitSaved(page);

    await page.keyboard.press('Alt+n');
    await expect(page.locator('nav[aria-label="Note list"] li')).toHaveCount(2);
    await page.getByLabel('Note title').fill('Groceries');
    await page.getByRole('button', { name: 'Pin note' }).click();
    await expect(page.locator('#pinned-heading')).toBeVisible();

    await page.keyboard.press('Control+k');
    await page.locator('[cmdk-input]').fill('alpha');
    await expect(page.locator('[cmdk-item]').first()).toContainText('alpha note body');
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Note title')).toHaveValue('Untitled note');

    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: /Delete note/ }).click();
    await page.getByRole('button', { name: 'Delete note' }).click();
    await expect(page.locator('nav[aria-label="Note list"] li')).toHaveCount(1);
    await expect(page.getByLabel('Note title')).toHaveValue('Groceries');
  });
});

test.describe('offline', () => {
  test('edits made offline are kept and uploaded on reconnect', async ({ account }) => {
    const { page } = account;
    await editorText(page).click();
    await page.keyboard.type('online text');
    await waitSaved(page);

    await page.context().setOffline(true);
    await page.keyboard.type(' plus offline text');
    await expect(status(page)).toContainText('Offline', { timeout: 12_000 });

    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitSaved(page);

    const id = page.url().split('/notes/')[1];
    const content = await page.evaluate((noteId) => fetch(`/api/documents/${noteId}`).then((r) => r.json()), id);
    expect(content.document.content).toBe('online text plus offline text');
  });
});

test.describe('accessibility', () => {
  const serious = (results: Awaited<ReturnType<AxeBuilder['analyze']>>) =>
    results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');

  for (const scheme of ['light', 'dark'] as const) {
    test(`login page has no serious violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/login');
      await page.locator('#auth-email').waitFor();
      expect(serious(await new AxeBuilder({ page }).analyze())).toEqual([]);
    });

    test(`notes screen has no serious violations (${scheme})`, async ({ guarded: page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await register(page, uniqueEmail(`a11y-${scheme}`));
      await editorText(page).click();
      await page.keyboard.type('some text to render');
      await page.waitForTimeout(400);
      expect(serious(await new AxeBuilder({ page }).analyze())).toEqual([]);
    });
  }
});
