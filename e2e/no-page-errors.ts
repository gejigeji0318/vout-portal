import { expect, test } from '@playwright/test';
import { pageErrors } from './helpers';

/** どのテストでも、画面で JavaScript のエラーが 1 件も起きていないこと */
test.afterEach(() => {
  const errors = pageErrors.splice(0);
  expect(errors, `画面で JavaScript のエラーが起きました：\n${errors.join('\n')}`).toEqual([]);
});
