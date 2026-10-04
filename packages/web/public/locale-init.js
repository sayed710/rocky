/* Apply the explicit preference before stylesheet/body parsing. No browser-language guessing. */
(() => {
  let locale = 'en';
  try {
    if (localStorage.getItem('rookzen_locale_v1') === 'ar') locale = 'ar';
  } catch {
    // Restricted storage retains the safe English default.
  }
  document.documentElement.lang = locale;
  document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
})();
