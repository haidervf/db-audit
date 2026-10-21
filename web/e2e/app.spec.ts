import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end walk through the UI against a real backend + the local Docker SQL Server (dev seed).
 * Connections are created through the form; refreshes are started from the UI.
 * Fails on any browser console error or uncaught exception.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.E2E_SCREENSHOT_DIR ?? path.join(here, '..', 'test-results', 'screens');
fs.mkdirSync(SHOTS, { recursive: true });

function devEnv(): Record<string, string> {
  const file = path.resolve(here, '../../dev/.env.dev');
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const env = { ...devEnv(), ...process.env } as Record<string, string | undefined>;
const DB_HOST = env.DB_AUDIT_MSSQL_HOST ?? 'localhost';
const DB_PORT = env.DB_AUDIT_MSSQL_PORT ?? '14340';
const FULL_PW = env.DB_AUDIT_FULL_PASSWORD ?? '';
const READER_PW = env.DB_AUDIT_READER_PASSWORD ?? '';

const DEMO = 'AuditDemo (audit_full)';
const ARCHIVE = 'AuditArchive (audit_reader)';

test.describe.configure({ mode: 'serial' });

let page: Page;
const problems: string[] = [];

async function shot(name: string) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function waitForGraph() {
  await expect(page.getByTestId('graph-canvas').first()).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await expect(page.getByTestId('graph-node').first()).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()} @ ${m.location().url}`);
  });
  page.on('pageerror', (e) => problems.push(`uncaught: ${e.message}`));
});

test.afterEach(() => {
  const found = problems.splice(0);
  expect(found, 'browser console errors / uncaught exceptions').toEqual([]);
});

test.afterAll(async () => {
  await page.context().close();
});

async function fillConnection(o: { name: string; database: string; user: string; password: string; jobsDb?: string }) {
  const form = page.getByTestId('connection-form');
  await expect(form).toBeVisible();
  await form.getByTestId('f-name').fill(o.name);
  await form.getByTestId('f-server').fill(DB_HOST);
  await form.getByTestId('f-database').fill(o.database);
  await form.getByTestId('f-port').fill(DB_PORT);
  await form.getByTestId('f-mode').selectOption('sql');
  await form.getByTestId('f-user').fill(o.user);
  await form.getByTestId('f-password').fill(o.password);
  await form.getByTestId('f-trust').check();
  if (o.jobsDb) {
    await form.getByTestId('f-jobs-toggle').click();
    await form.getByTestId('f-jobs-enabled').check();
    await form.getByTestId('f-jobs-server').fill(DB_HOST);
    await form.getByTestId('f-jobs-database').fill(o.jobsDb);
    await form.getByTestId('f-jobs-port').fill(DB_PORT);
  }
}

async function runRefreshFromDialog(mode: 'Full' | 'Incremental' = 'Full') {
  const dialog = page.getByTestId('refresh-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('segment-analysis')).toBeChecked();
  await page.getByRole('group', { name: 'Refresh mode' }).getByRole('button', { name: mode }).click();
  await page.getByTestId('refresh-run').click();
  const run = dialog.getByTestId('refresh-run-view');
  await expect(run).toBeVisible();
  await expect(run).toHaveAttribute('data-status', /succeeded|partial/, { timeout: 150_000 });
}

test('onboarding, then create the AuditDemo connection through the form and test it', async () => {
  expect(FULL_PW, 'DB_AUDIT_FULL_PASSWORD (dev/.env.dev)').not.toBe('');
  await page.goto('/');
  await expect(page).toHaveURL(/\/connections$/);
  await expect(page.getByTestId('onboarding')).toBeVisible();
  await shot('01-onboarding-light');

  await page.getByTestId('add-connection').click();
  await fillConnection({ name: DEMO, database: 'AuditDemo', user: 'audit_full', password: FULL_PW, jobsDb: 'AuditJobs' });
  await shot('02-connection-form-light');
  await page.getByTestId('f-test').click();

  const result = page.getByTestId('test-result');
  await expect(result).toBeVisible({ timeout: 60_000 });
  const target = result.getByTestId('endpoint-result').first();
  await expect(target.getByTestId('engine-edition')).toContainText(/EngineEdition \d+/);
  const perms = target.getByTestId('permission-list');
  await expect(perms.locator('[data-perm="viewDefinition"]')).toHaveAttribute('data-state', 'ok');
  await expect(perms.locator('[data-perm="expressionDependencies"]')).toHaveAttribute('data-state', 'ok');
  await expect(perms.locator('[data-perm="agentJobs"]')).toHaveAttribute('data-state', 'ok');
  // the Elastic Jobs database is probed separately
  await expect(result.getByTestId('endpoint-result').nth(1).locator('[data-perm="jobsViews"]')).toHaveAttribute('data-state', 'ok');
  await shot('03-connection-test-full-light');
});

test('create the AuditArchive connection (audit_reader) and see the permission fix hints', async () => {
  expect(READER_PW, 'DB_AUDIT_READER_PASSWORD (dev/.env.dev)').not.toBe('');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByTestId('add-connection').click();
  await fillConnection({ name: ARCHIVE, database: 'AuditArchive', user: 'audit_reader', password: READER_PW });
  await page.getByTestId('f-test').click();
  const result = page.getByTestId('test-result');
  await expect(result).toBeVisible({ timeout: 60_000 });
  const perms = result.getByTestId('permission-list').first();
  await expect(perms.locator('[data-perm="viewDefinition"]')).toHaveAttribute('data-state', 'ok');
  // audit_reader lacks SELECT on sys.sql_expression_dependencies -> red with the GRANT to fix it
  const dep = perms.locator('[data-perm="expressionDependencies"]');
  await expect(dep).toHaveAttribute('data-state', 'bad');
  await expect(dep).toContainText('GRANT SELECT ON sys.sql_expression_dependencies');
  await shot('04-connection-test-reader-light');

  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByTestId('connection-card')).toHaveCount(2);
  await shot('05-connections-list-light');
});

test('open AuditDemo and run a full refresh from the UI', async () => {
  await page.locator(`[data-testid="connection-card"][data-name="${DEMO}"]`).getByTestId('open-connection').click();
  await expect(page).toHaveURL(/\/c\/[a-z0-9]+\/overview$/);
  await expect(page.getByTestId('first-refresh')).toBeVisible();
  await page.getByTestId('first-refresh-button').click();
  await runRefreshFromDialog('Full');
  await shot('06-refresh-done-light');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByTestId('refresh-dialog')).toHaveCount(0);
});

test('overview shows counts, last refresh, warnings and insights', async () => {
  await expect(page.getByTestId('overview-page')).toBeVisible();
  await expect(page.getByTestId('count-procedure').locator('.stat-value')).not.toHaveText('0');
  await expect(page.getByTestId('count-table').locator('.stat-value')).not.toHaveText('0');
  await expect(page.getByTestId('count-job').locator('.stat-value')).not.toHaveText('0');
  await expect(page.getByTestId('last-refresh')).toContainText(/succeeded|partial/);
  await expect(page.getByTestId('insight-most-referenced-tables').getByTestId('insight-item').first()).toContainText(/\d+ refs?$/);
  await expect(page.getByTestId('insight-failing-jobs')).toBeVisible();
  await expect(page.getByTestId('insight-orphan-procedures')).toBeVisible();
  await expect(page.getByTestId('recent-runs')).toBeVisible();
  await shot('07-overview-light');
});

test('audit insights: grouped by category, stale module linked to its Dependencies tab, zero-findings line', async () => {
  const cats = page.locator('[data-testid^="insight-category-"]');
  await expect(cats).toHaveCount(5);
  expect(await cats.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).toEqual([
    'insight-category-usage',
    'insight-category-code-risk',
    'insight-category-dependency-health',
    'insight-category-schema-health',
    'insight-category-jobs-ops',
  ]);
  await expect(page.getByTestId('insight-category-usage').getByTestId('insight-most-referenced-tables')).toBeVisible();
  await expect(page.getByTestId('insight-category-jobs-ops').getByTestId('insight-failing-jobs')).toBeVisible();
  const zero = page.getByTestId('insights-zero').first();
  await expect(zero).toContainText(/^No findings: \S/);

  const stale = page.getByTestId('insight-category-dependency-health').getByTestId('insight-stale-modules');
  await expect(stale.locator('.badge').first()).toHaveText('high');
  const link = stale.getByTestId('insight-object').filter({ hasText: 'dbo.usp_Stale' });
  await expect(link).toHaveAttribute('data-linked', 'true');
  await expect(link).toHaveAttribute('href', /\/procedures\/dbo\/usp_Stale\?tab=deps$/);
  await page.getByTestId('insight-category-usage').scrollIntoViewIfNeeded();
  await shot('07c-insights-light');

  await link.click();
  await expect(page).toHaveURL(/\/procedures\/dbo\/usp_Stale\?tab=deps$/);
  await expect(page.getByRole('tab', { name: /Dependencies/ })).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(page.getByTestId('overview-page')).toBeVisible();
});

test('insights AI analysis: Ask AI preselects without running, Analyze, copy (AI endpoints mocked; nothing is sent to Anthropic)', async () => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('**/api/ai/status', (r) =>
    r.fulfill({ json: { configured: true, keySource: 'settings', model: 'claude-opus-5-5', effort: 'medium' } }),
  );
  const gets: string[] = [];
  await page.route(/\/insights\/analysis\?/, (r) => {
    gets.push(new URL(r.request().url()).searchParams.get('categories') ?? '');
    return r.fulfill({ status: 200, contentType: 'application/json', body: 'null' }); // no analysis yet (same as the server)
  });
  const posts: unknown[] = [];
  await page.route(/\/insights\/analyze$/, async (r) => {
    posts.push(r.request().postDataJSON());
    await new Promise((res) => setTimeout(res, 800));
    await r.fulfill({
      json: {
        model: 'claude-opus-5-5',
        effort: 'medium',
        promptVersion: 'test',
        createdAt: new Date().toISOString(),
        definitionSha256: 'x',
        stale: false,
        usage: { inputTokens: 4321, outputTokens: 654 },
        categories: ['code-risk'],
        content: {
          summary: 'Two code-risk patterns need attention.',
          findings: [
            { title: 'A cursor in a hot path', severity: 'low', category: 'code-risk', insightIds: ['cursors'], explanation: 'Uses a cursor.', objects: [], recommendation: 'Rewrite it set-based.' },
            {
              title: 'Dynamic SQL in usp_Stale',
              severity: 'high',
              category: 'code-risk',
              insightIds: ['dynamic-sql'],
              explanation: 'Builds SQL from strings.',
              objects: [
                { kind: 'procedure', schema: 'dbo', name: 'usp_Stale' },
                { kind: 'table', schema: 'dbo', name: 'OrderLog' },
              ],
              recommendation: 'Use sp_executesql with parameters.',
            },
          ],
          quickWins: ['Parameterize the dynamic SQL.'],
          notes: ['Static analysis only.'],
        },
      },
    });
  });
  await page.evaluate(() => localStorage.removeItem('dbaudit.aiConsent'));
  await page.reload();
  const panel = page.getByTestId('insights-ai');
  const analyze = panel.getByTestId('insights-ai-analyze');
  await expect(analyze).toBeEnabled();
  await expect(panel.getByTestId('insights-ai-all')).toBeChecked();

  // "Ask AI" on a code-risk card: selects only that category, focuses Analyze, does not run
  await page.getByTestId('insight-category-code-risk').getByTestId('insight-ask-ai').first().click();
  await expect(panel.getByTestId('insights-ai-cat-code-risk')).toBeChecked();
  for (const other of ['usage', 'dependency-health', 'schema-health', 'jobs-ops']) await expect(panel.getByTestId(`insights-ai-cat-${other}`)).not.toBeChecked();
  await expect(analyze).toBeFocused();
  await expect.poll(() => gets).toContain('code-risk');
  await expect(panel).toContainText('No analysis for this selection yet');
  expect(posts).toHaveLength(0);

  await analyze.click();
  const consent = page.getByRole('dialog', { name: 'Send the insights report to Anthropic?' });
  await expect(consent).toBeVisible();
  expect(posts).toHaveLength(0);
  await consent.getByRole('button', { name: 'I understand, continue' }).click();
  await expect(panel.getByTestId('insights-ai-loading')).toBeVisible();
  await expect(panel.getByTestId('insights-ai-result')).toBeVisible();
  expect(posts).toEqual([{ categories: ['code-risk'], force: false }]);

  const findings = panel.getByTestId('insights-ai-finding');
  await expect(findings).toHaveCount(2);
  await expect(findings.first()).toHaveAttribute('data-severity', 'high'); // high before low
  const procChip = findings.first().getByTestId('insights-ai-object').filter({ hasText: 'dbo.usp_Stale' });
  await expect(procChip).toHaveAttribute('data-linked', 'true');
  await expect(procChip).toHaveAttribute('href', /\/procedures\/dbo\/usp_Stale\?tab=deps$/);
  await expect(findings.first().getByTestId('insights-ai-object').filter({ hasText: 'dbo.OrderLog' })).toHaveAttribute('href', /\/tables\/dbo\/OrderLog$/);

  // an insight link scrolls to and highlights the insight
  await findings.first().getByTestId('insights-ai-insight-link').click();
  await expect(page.getByTestId('insight-dynamic-sql')).toHaveClass(/insight-flash/);

  await panel.scrollIntoViewIfNeeded();
  await shot('07d-insights-ai-light');
  const copy = panel.getByTestId('insights-ai-copy');
  await copy.click();
  await expect(copy).toHaveAttribute('data-state', 'copied');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(
    [
      '# AI analysis of audit insights (Code risk)',
      '',
      '## Summary',
      'Two code-risk patterns need attention.',
      '',
      '## Findings',
      '### [high] Dynamic SQL in usp_Stale',
      'Category: Code risk · Insights: Dynamic SQL',
      'Builds SQL from strings.',
      'Recommendation: Use sp_executesql with parameters.',
      'Objects:',
      '- procedure dbo.usp_Stale',
      '- table dbo.OrderLog',
      '',
      '### [low] A cursor in a hot path',
      'Category: Code risk · Insights: Cursors',
      'Uses a cursor.',
      'Recommendation: Rewrite it set-based.',
      '',
      '## Quick wins',
      '- Parameterize the dynamic SQL.',
      '',
      '## Notes',
      '- Static analysis only.',
    ].join('\n'),
  );
  expect(posts).toHaveLength(1);

  await page.unroute('**/api/ai/status');
  await page.unroute(/\/insights\/analysis\?/);
  await page.unroute(/\/insights\/analyze$/);
  await page.reload(); // drop the mocked AI status / analysis from the client cache
  await expect(page.getByTestId('overview-page')).toBeVisible();
});

test('refresh history: expand the latest run, open a warning object chip, copy a warning', async () => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByTestId('nav-refreshes').click();
  await expect(page).toHaveURL(/\/c\/[a-z0-9]+\/refreshes$/);
  await expect(page.getByTestId('breadcrumb')).toContainText('Refresh history');
  const latest = page.getByTestId('run-row').first();
  await expect(latest).toHaveAttribute('data-status', /succeeded|partial/);
  const runId = (await latest.getAttribute('data-run-id'))!;
  await latest.click();
  const runUrl = new RegExp(`/refreshes\\?run=${runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  await expect(page).toHaveURL(runUrl);
  const stale = page.getByTestId('run-detail').getByTestId('warning').filter({ hasText: 'Stale module' }).filter({ hasText: 'usp_Stale' }).first();
  const chip = stale.getByTestId('warning-object').filter({ hasText: 'dbo.usp_Stale' });
  await expect(chip).toHaveAttribute('data-linked', 'true');
  await shot('07b-refresh-history-light');

  await chip.click();
  await expect(page).toHaveURL(/\/procedures\/dbo\/usp_Stale\?tab=deps$/);
  await expect(page.getByTestId('detail-title')).toContainText('usp_Stale');
  await expect(page.getByRole('tab', { name: /Dependencies/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('deps-tab')).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(runUrl);
  const copy = stale.getByTestId('warning-copy');
  await copy.click();
  await expect(copy).toHaveAttribute('data-state', 'copied');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toMatch(/^Stale module \(binding error, would fail to compile\): dbo\.usp_Stale: [^\n]+\nprocedure dbo\.usp_Stale$/);
});

test('procedures list -> procedure detail; outline click moves the code highlight', async () => {
  await page.getByTestId('nav-procedures').click();
  const table = page.getByTestId('object-table');
  await expect(table.locator('tbody tr').nth(3)).toBeVisible();
  await shot('08-procedures-light');
  await page.getByPlaceholder('Filter procedures…').fill('PlaceOrder');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await table.locator('tbody tr').first().click();
  await expect(page.getByTestId('detail-title')).toContainText('usp_PlaceOrder');

  const noAnalysis = page.getByTestId('explain-no-analysis');
  const outline = page.getByTestId('explain-outline');
  await expect(noAnalysis.or(outline)).toBeVisible();
  if (await noAnalysis.isVisible()) {
    // Backend without static analysis: graceful message instead of the outline.
    await expect(noAnalysis).toContainText('Analysis not available — run a refresh');
    test.info().annotations.push({ type: 'note', description: 'analysis null: graceful fallback asserted' });
    await shot('09-procedure-explain-light');
    return;
  }

  const code = page.getByTestId('explain-code');
  const pick = async (text: string) => {
    const node = outline.getByTestId('outline-node').filter({ hasText: text }).first();
    const lines = (await node.getAttribute('data-lines'))!;
    await node.click();
    await expect(code).toHaveAttribute('data-highlight', lines);
    const [from, to] = lines.split('-').map(Number);
    const gutter = code.locator('.cm-lineNumbers .cm-gutterElement.cm-hl-gutter');
    await expect(gutter).toHaveCount(to - from + 1);
    await expect(gutter.first()).toHaveText(String(from));
    await expect(gutter.last()).toHaveText(String(to));
    await expect(code.locator('.cm-line.cm-hl-selected')).toHaveCount(to - from + 1);
    return lines;
  };
  const first = await pick('UPDATE dbo.Member_Card');
  const second = await pick('INSERT INTO dbo.OrderLog');
  expect(second).not.toBe(first);

  // hovering a "Touches" chip highlights the statements that touch the table
  await page.getByTestId('touch-chip').filter({ hasText: 'OrderLog' }).hover();
  await expect(code.locator('.cm-line.cm-hl-hover').first()).toBeVisible();
  await shot('09-procedure-explain-light');
  await page.mouse.move(5, 5);

  await page.getByRole('tab', { name: /Dependencies/ }).click();
  await expect(page.getByTestId('uses')).toContainText('OrderLog');
  await expect(page.getByTestId('used-by')).toContainText('usp_Checkout');
  await shot('10-procedure-dependencies-light');

  await page.getByRole('tab', { name: 'Diagram' }).click();
  await waitForGraph();
  await shot('11-procedure-diagram-light');

  await page.getByRole('tab', { name: 'AI explanation' }).click();
  await expect(page.getByText('AI not configured — add a key in Settings')).toBeVisible();
});

test('AI explanation rendering (AI endpoints mocked in the browser; nothing is sent to Anthropic)', async () => {
  const url = page.url();
  await page.route('**/api/ai/status', (r) =>
    r.fulfill({ json: { configured: true, keySource: 'settings', model: 'claude-opus-5-5', effort: 'medium' } }),
  );
  let describeCalls = 0;
  await page.route('**/describe', async (r) => {
    describeCalls++;
    await new Promise((res) => setTimeout(res, 800));
    await r.fulfill({
      json: {
        model: 'claude-opus-5-5',
        effort: 'medium',
        promptVersion: 'test',
        createdAt: new Date().toISOString(),
        definitionSha256: 'x',
        stale: false,
        usage: { inputTokens: 1234, outputTokens: 456 },
        content: {
          summary: 'Places a bookshop order: credits loyalty points to the member card and logs the order, inside one transaction.',
          purpose: 'Core order placement.',
          steps: [
            { lines: '17-19', title: 'Update the card', explanation: 'Adds loyalty points to an active member card.' },
            { lines: '21-22', title: 'Log the order', explanation: 'Inserts a row into OrderLog.' },
          ],
          dataAccess: [{ object: 'dbo.Member_Card', access: 'UPDATE', why: 'points change' }],
          calls: [{ object: 'dbo.usp_WriteAudit', why: 'audit trail' }],
          risks: ['Errors are re-thrown after logging; callers must handle them.'],
          notes: ['Uses NEXT VALUE FOR dbo.seq_OrderRef.'],
        },
      },
    });
  });
  await page.goto(url.replace(/\?.*$/, '') + '?tab=ai');
  await page.evaluate(() => localStorage.removeItem('dbaudit.aiConsent'));
  await page.reload();
  await page.getByTestId('ai-describe').click();
  // in-app consent dialog, never window.confirm
  const consent = page.getByRole('dialog', { name: 'Send code to Anthropic?' });
  await expect(consent).toBeVisible();
  await shot('12-ai-consent-light');
  await consent.getByRole('button', { name: 'I understand, continue' }).click();
  await expect(page.getByTestId('ai-loading')).toBeVisible();
  await expect(page.getByTestId('ai-result')).toBeVisible();
  await expect(page.getByTestId('ai-result')).toContainText('Update the card');
  expect(describeCalls).toBe(1);
  await shot('13-ai-result-light');
  // clicking a step's line range switches to Explain and highlights those lines
  await page.getByTestId('ai-result').getByRole('button', { name: 'L17-19' }).click();
  await expect(page.getByTestId('explain-code')).toHaveAttribute('data-highlight', '17-19');
  await page.unroute('**/api/ai/status');
  await page.unroute('**/describe');
  await page.reload(); // drop the mocked AI status from the client cache
  await expect(page.getByTestId('detail-title')).toBeVisible();
});

test('table detail with Used by (writers / readers)', async () => {
  await page.getByTestId('nav-tables').click();
  await page.getByPlaceholder('Filter tables…').fill('OrderLog');
  await page.getByTestId('object-table').locator('tbody tr').filter({ hasText: 'OrderLog' }).filter({ hasNotText: 'Archive' }).first().click();
  await expect(page.getByTestId('detail-title')).toContainText('OrderLog');
  await expect(page.getByTestId('columns-table').locator('tbody tr').first()).toBeVisible();
  const usedBy = page.getByTestId('table-used-by');
  await expect(usedBy).toContainText(/Writers \([1-9]/);
  await expect(usedBy).toContainText('usp_PlaceOrder');
  await shot('14-table-detail-light');
});

test('jobs list -> Agent job detail with steps and executions', async () => {
  await page.getByTestId('nav-jobs').click();
  const table = page.getByTestId('jobs-table');
  await expect(table.locator('tbody tr').first()).toBeVisible();
  await shot('15-jobs-light');
  await table.locator('tbody tr').filter({ hasText: 'AuditDemo - Nightly Maintenance' }).first().click();
  await expect(page.getByTestId('detail-title')).toHaveText('AuditDemo - Nightly Maintenance');
  await expect(page.getByTestId('step-card')).toHaveCount(2);
  await expect(page.getByTestId('step-flow')).toContainText('on success');
  await shot('16-job-steps-light');
  await page.getByRole('tab', { name: /Executions/ }).click();
  const ex = page.getByTestId('executions-table');
  await expect(ex.locator('tbody tr').first()).toBeVisible();
  await ex.locator('tbody tr.clickable').first().click();
  await expect(page.getByTestId('execution-message')).toBeVisible();
  await shot('17-job-executions-light');
});

test('graph page: nodes render, clicking a node opens the side panel, focus search', async () => {
  await page.getByTestId('nav-graph').click();
  await waitForGraph();
  await page.getByTestId('graph-focus-search').fill('usp_NightlyBatch');
  await page.getByRole('option', { name: /usp_NightlyBatch/ }).first().click();
  await expect(page.getByTestId('graph-focus-chip')).toContainText('usp_NightlyBatch');
  await waitForGraph();
  await page.getByTestId('graph-node').filter({ hasText: 'usp_ArchiveOrders' }).first().click();
  const side = page.getByTestId('graph-side-panel');
  await expect(side).toBeVisible();
  await expect(side).toContainText('usp_ArchiveOrders');
  await expect(side.getByRole('link', { name: 'Open details' })).toBeVisible();
  await shot('18-graph-focus-light');
});

test('quick search jumps to an object', async () => {
  await page.locator('body').click({ position: { x: 5, y: 600 } });
  await page.keyboard.press('/');
  const input = page.getByTestId('quick-search-input');
  await expect(input).toBeFocused();
  await input.fill('nightbatch');
  await expect(page.getByTestId('quick-search-item').first()).toContainText('usp_NightlyBatch');
  await shot('19-quick-search-light');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('detail-title')).toContainText('usp_NightlyBatch');
});

test('switch to AuditArchive with the switcher, refresh it and see its data', async () => {
  await page.getByTestId('conn-switcher').click();
  await page.getByTestId('conn-option').filter({ hasText: ARCHIVE }).click();
  await expect(page.getByTestId('breadcrumb')).toContainText(ARCHIVE);
  await page.getByTestId('nav-overview').click();
  await expect(page.getByTestId('first-refresh')).toBeVisible();
  await page.getByTestId('first-refresh-button').click();
  await runRefreshFromDialog('Incremental');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByTestId('overview-page')).toBeVisible();
  await expect(page.getByTestId('conn-switcher')).toContainText('AuditArchive');
  await page.getByTestId('nav-tables').click();
  await expect(page.getByTestId('object-table').locator('tbody tr').first()).toBeVisible();
  await shot('20-archive-tables-light');
  // and back
  await page.getByTestId('conn-switcher').click();
  await page.getByTestId('conn-option').filter({ hasText: DEMO }).click();
  await expect(page.getByTestId('breadcrumb')).toContainText(DEMO);
});

test('settings page', async () => {
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('ai-settings')).toBeVisible();
  await expect(page.getByTestId('ai-settings')).toContainText('not configured');
  await expect(page.getByTestId('ai-model')).toHaveValue(/claude/);
  await shot('21-settings-light');
});

test('dark mode toggle (persisted)', async () => {
  await page.getByTestId('theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await shot('22-settings-dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByTestId('nav-overview').click();
  await expect(page.getByTestId('overview-page')).toBeVisible();
  await shot('23-overview-dark');
  await page.getByTestId('nav-procedures').click();
  await page.getByPlaceholder('Filter procedures…').fill('PlaceOrder');
  await page.getByTestId('object-table').locator('tbody tr').first().click();
  await expect(page.getByTestId('explain-code')).toBeVisible();
  const node = page.getByTestId('explain-outline').getByTestId('outline-node').filter({ hasText: 'UPDATE dbo.Member_Card' }).first();
  if (await node.count()) await node.click();
  await shot('24-procedure-explain-dark');
  await page.getByTestId('nav-graph').click();
  await page.getByTestId('graph-focus-search').fill('usp_NightlyBatch');
  await page.getByRole('option', { name: /usp_NightlyBatch/ }).first().click();
  await waitForGraph();
  await shot('25-graph-dark');
  await page.getByTestId('nav-jobs').click();
  await page.getByTestId('jobs-table').locator('tbody tr').filter({ hasText: 'AuditDemo - Nightly Maintenance' }).first().click();
  await expect(page.getByTestId('step-card').first()).toBeVisible();
  await shot('26-job-dark');
});
