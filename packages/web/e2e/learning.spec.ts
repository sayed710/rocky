/**
 * E2E tests for the learning section (courses, lessons, steps).
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M14 acceptance gate');

test('learner can browse courses, open a lesson, attempt steps, and see progress persist across reload', async ({ page, context, request }) => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const handle = `learn-${suffix}`;
  const slug = `e2e-course-${suffix}`;
  const password = 'test-password-learning-123';

  // Register a player
  const registered = await request.post('/v1/auth/register', {
    data: { handle, password, email: `${handle}@example.test` },
  });
  expect(registered.ok()).toBeTruthy();
  const auth = await registered.json();
  const { user } = auth;

  // Set up authenticated session on page
  await context.addCookies([{
    name: 'gambit_refresh',
    value: auth.tokens.refreshToken,
    domain: 'localhost',
    path: '/v1/auth',
    httpOnly: true,
    secure: false,
    sameSite: 'Strict',
  }]);
  await page.addInitScript(
    ({ playerHandle, uid }) => {
      localStorage.setItem('gambit-session', JSON.stringify({ handle: playerHandle, userId: uid }));
    },
    { playerHandle: handle, uid: user.id },
  );

  // Seed a course via bridge route POST /e2e/courses
  const courseRes = await request.post('/e2e/courses', {
    data: {
      authorId: user.id,
      slug,
      title: `Tactics Course ${suffix}`,
      description: 'Learn basic tactics.',
    },
  });
  expect(courseRes.ok()).toBeTruthy();
  const seeded = await courseRes.json();

  // Navigate to /courses
  await page.goto('/courses');
  await expect(page.locator('#courses')).toBeVisible({ timeout: 15_000 });

  // Course row should be present
  const courseRow = page
    .locator('#course-list .panel-row')
    .filter({ has: page.getByText(`Tactics Course ${suffix}`, { exact: true }) });
  await expect(courseRow).toBeVisible({ timeout: 15_000 });

  // Click on the course link
  await courseRow.getByRole('link', { name: `Tactics Course ${suffix}` }).click();

  // URL should be /courses/:slug
  await expect(page).toHaveURL(`/courses/${slug}`);
  await expect(page.locator('#course')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#course-title')).toHaveText(`Tactics Course ${suffix}`);

  // Lesson row should be visible
  const lessonRow = page
    .locator('#lesson-list .panel-row')
    .filter({ has: page.getByText('Lesson 1: Basics', { exact: true }) });
  await expect(lessonRow).toBeVisible({ timeout: 15_000 });

  // Click lesson link
  await lessonRow.getByRole('link', { name: 'Lesson 1: Basics' }).click();

  // URL should be /lessons/:id
  await expect(page).toHaveURL(`/lessons/${seeded.lessonId}`);
  await expect(page.locator('#lesson')).toBeVisible({ timeout: 15_000 });

  // Quiz step: test incorrect attempt does NOT mark step done
  const quizCard = page
    .locator('#step-list .step-block')
    .filter({ has: page.getByText('Which piece moves diagonally?', { exact: true }) });
  await expect(quizCard).toBeVisible();

  // Click incorrect quiz option ('Rook')
  await quizCard.getByRole('button', { name: 'Rook' }).click();
  // Status should say 'Try again', NOT 'Done'
  await expect(quizCard.locator('.step-status')).toHaveText('Try again', { timeout: 15_000 });

  // Move step: test correct attempt ('e4') marks step done and updates progress
  const moveCard = page
    .locator('#step-list .step-block')
    .filter({ has: page.getByText('Advance your king pawn two squares.', { exact: true }) });
  await expect(moveCard).toBeVisible();

  const sanInput = moveCard.getByRole('textbox', { name: 'SAN move' });
  await sanInput.fill('e4');
  await moveCard.getByRole('button', { name: 'Submit move' }).click();

  // Move step status should say 'Done'
  await expect(moveCard.locator('.step-status')).toHaveText('Done', { timeout: 15_000 });

  // Progress summary count on lesson page updates
  await expect(page.locator('#lesson-progress')).toContainText('1 / 3', { timeout: 15_000 });

  // Reload the lesson page and verify per-step completion persists
  await page.reload();
  await expect(page.locator('#lesson')).toBeVisible({ timeout: 15_000 });

  const moveCardAfterReload = page
    .locator('#step-list .step-block')
    .filter({ has: page.getByText('Advance your king pawn two squares.', { exact: true }) });
  await expect(moveCardAfterReload.locator('.step-status')).toHaveText('Done', { timeout: 15_000 });
  await expect(page.locator('#lesson-progress')).toContainText('1 / 3', { timeout: 15_000 });
});
