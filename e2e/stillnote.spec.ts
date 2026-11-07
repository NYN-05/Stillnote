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

interface Options {
  /**
   * The XSS test deliberately pastes inline event handlers. The browser logs a
   * CSP violation before the paste sanitizer removes them; that block is the
   * expected defence, not an application error.
   */
  allowBlockedInlineHandlers: boolean;
}

export const test = base.extend<Fixtures & Options>({
  allowBlockedInlineHandlers: [false, { option: true }],

  guarded: async ({ page, allowBlockedInlineHandlers }, use) => {
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
      if (
        allowBlockedInlineHandlers &&
        (/Executing inline event handler violates the following Content Security Policy/.test(text) ||
          /CSP violation: script-src-attr blocked inline/.test(text))
      ) {
        return;
      }
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
  await editorText(page).waitFor();
}

const status = (page: Page) => page.getByRole('status').first();
const editorText = (page: Page) => page.locator('.rich-text');
const waitSaved = (page: Page) => expect(status(page)).toContainText('Saved', { timeout: 12_000 });

async function storedNote(page: Page, id: string) {
  return page.evaluate(async (noteId) => {
    const response = await fetch(`/api/documents/${noteId}`);
    return (await response.json()) as {
      document: { content: string; contentFormat: string; contentSchemaVersion: number; version: number };
    };
  }, id);
}

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
  test('formatting commands, undo and rich HTML persistence across reload', async ({ account }) => {
    const { page } = account;
    const editor = editorText(page);

    await editor.click();
    await page.keyboard.type('# ');
    await expect(editor.locator('h1')).toHaveCount(1);
    await page.keyboard.type('Plan');
    await page.keyboard.press('Enter');
    await page.keyboard.type('keep it simple');
    await page.keyboard.press('Shift+Home'); // select just this line

    await page.getByRole('button', { name: 'Bold' }).click();
    await expect(editor.locator('strong')).toHaveText('keep it simple');
    await expect(page.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Control+b');
    await expect(editor.locator('strong')).toHaveCount(0);
    await page.keyboard.press('Control+b');
    await expect(editor.locator('strong')).toHaveText('keep it simple');

    // Undo and redo operate on the document, not on Markdown text.
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' xyzzy');
    await expect(editor).toContainText('xyzzy');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(editor).not.toContainText('xyzzy');
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect(editor).toContainText('xyzzy');

    // Alignment is stored as a CSS property the shared policy allows.
    await editor.locator('h1').click();
    await page.getByRole('button', { name: 'Align center' }).click();
    await expect(editor.locator('h1')).toHaveCSS('text-align', 'center');

    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Bulleted list' }).click();
    await page.keyboard.type('first item');
    await expect(editor.locator('ul li')).toContainText('first item');

    await waitSaved(page);
    const id = page.url().split('/notes/')[1];
    const saved = await storedNote(page, id);
    expect(saved.document.contentFormat).toBe('html');
    expect(saved.document.contentSchemaVersion).toBe(1);
    expect(saved.document.content).toMatch(/<h1 style="text-align:\s*center">Plan<\/h1>/);
    expect(saved.document.content).toMatch(/<strong>keep it simple/);
    expect(saved.document.content).toContain('<ul>');

    await page.reload();
    await expect(editorText(page).locator('h1')).toHaveText('Plan');
    await expect(editorText(page).locator('h1')).toHaveCSS('text-align', 'center');
    await expect(editorText(page).locator('strong')).toContainText('keep it simple');
    await expect(editorText(page).locator('ul li')).toContainText('first item');
  });

  test('autosave confirmations do not move the caret or replace the text', async ({ account }) => {
    const { page } = account;
    const editor = editorText(page);
    await editor.click();
    await page.keyboard.type('hello world');
    await page.keyboard.press('Home');
    for (let index = 0; index < 5; index += 1) await page.keyboard.press('ArrowRight');
    await waitSaved(page);

    await page.keyboard.type(' there');
    await expect(editor).toContainText('hello there world');
  });

  test.describe('pasted HTML', () => {
    test.use({ allowBlockedInlineHandlers: true });

    test('pasted HTML is sanitized before it reaches the editor or the server', async ({ account }) => {
      const { page } = account;
      const editor = editorText(page);
      const payload = [
        '<p style="text-align: center; color: red; position: fixed"><strong>safe</strong> text</p>',
        '<p><img src="x" onerror="window.__pwned=1">',
        '<a href="javascript:window.__pwned=2" onclick="window.__pwned=3">bad link</a></p>',
        '<script>window.__pwned=4</script>',
        '<table><thead><tr><th>Head</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table>',
      ].join('');

      await editor.click();
      await page.evaluate((html) => {
        const target = document.querySelector<HTMLElement>('.rich-text');
        if (!target) throw new Error('editor not found');
        target.focus();
        const data = new DataTransfer();
        data.setData('text/html', html);
        data.setData('text/plain', 'safe text bad link');
        target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
      }, payload);

      await expect(editor.locator('strong')).toHaveText('safe');
      await expect(editor.locator('table th')).toHaveText('Head');
      await expect(editor.locator('table td')).toHaveText('Cell');
      expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();

      const live = await editor.innerHTML();
      expect(live).not.toMatch(/onerror|javascript:|<script|position:|color:/i);

      await waitSaved(page);
      const id = page.url().split('/notes/')[1];
      const saved = await storedNote(page, id);
      expect(saved.document.content).toContain('<strong>safe</strong>');
      expect(saved.document.content).toMatch(/<table[ >]/);
      expect(saved.document.content).not.toMatch(/onerror|javascript:|<script|position:|color:/i);

      await page.reload();
      await expect(editorText(page).locator('strong')).toHaveText('safe');
      await expect(editorText(page).locator('table th')).toHaveText('Head');
    });
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
    await expect(secondPage.locator('.rich-text')).toContainText('reachable by link');
    expect(secondPage.url()).toBe(noteUrl);
    await second.close();
  });
});

test.describe('conflicts', () => {
  test('a conflicting save keeps the open note’s text until the user chooses', async ({ account }) => {
    const { page } = account;
    const editor = editorText(page);
    await editor.click();
    await page.keyboard.type('mine');
    await waitSaved(page);
    const id = page.url().split('/notes/')[1];

    // Another session saves the note after this device last saw it.
    const current = await storedNote(page, id);
    const response = await page.evaluate(
      async ({ noteId, version }) => {
        const result = await fetch(`/api/documents/${noteId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            content: '<p>theirs</p>',
            contentFormat: 'html',
            contentSchemaVersion: 1,
            version,
            updatedAt: new Date().toISOString(),
          }),
        });
        return result.status;
      },
      { noteId: id, version: current.document.version },
    );
    expect(response).toBe(200);

    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' plus mine');
    await expect(page.getByRole('alert')).toContainText('changed in another session');
    await expect(editor).toContainText('mine plus mine');
    expect((await storedNote(page, id)).document.content).toContain('theirs');

    await page.getByRole('button', { name: 'Reload latest' }).click();
    await expect(editor).toContainText('theirs');
    await expect(editor).not.toContainText('mine plus mine');
    await expect(page.getByRole('alert')).toHaveCount(0);
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
    const saved = await storedNote(page, id);
    expect(saved.document.content).toContain('<p>');
    expect(saved.document.content).toContain('online text plus offline text');
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
