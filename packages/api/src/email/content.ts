export type EmailPurpose = 'password_reset' | 'email_verify' | 'login_step_up';

export interface EmailContent {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly url: string;
}

function link(origin: string, path: string, token: string): string {
  return `${origin}${path}#token=${encodeURIComponent(token)}`;
}

function htmlLink(url: string, label: string): string {
  return `<p><a href="${url}">${label}</a></p>`;
}

export function buildEmailContent(
  purpose: EmailPurpose,
  publicWebOrigin: string,
  token: string,
): EmailContent {
  if (purpose === 'password_reset') {
    const url = link(publicWebOrigin, '/password-reset', token);
    return {
      subject: 'Reset your Shatarang password',
      text: `Use this link to reset your Shatarang password. It expires in 30 minutes.\n\n${url}`,
      html: `<p>Use this link to reset your Shatarang password. It expires in 30 minutes.</p>${htmlLink(url, 'Reset password')}`,
      url,
    };
  }

  if (purpose === 'login_step_up') {
    // A code, not a link: it is typed into the sign-in form the owner already has open, and a link
    // would sign in whichever browser opened the email.
    const url = `${publicWebOrigin}/`;
    return {
      subject: 'Your Shatarang sign-in code',
      text:
        `Your Shatarang sign-in code is ${token}. It expires in 10 minutes.

` +
        'Someone, possibly you, entered your password after many failed sign-in attempts on your ' +
        'account. If it was not you, change your password.',
      html:
        `<p>Your Shatarang sign-in code is <strong>${token}</strong>. It expires in 10 minutes.</p>` +
        '<p>Someone, possibly you, entered your password after many failed sign-in attempts on your ' +
        'account. If it was not you, change your password.</p>',
      url,
    };
  }

  const url = link(publicWebOrigin, '/email-verify', token);
  return {
    subject: 'Verify your Shatarang email address',
    text: `Use this link to verify your Shatarang email address.\n\n${url}`,
    html: `<p>Use this link to verify your Shatarang email address.</p>${htmlLink(url, 'Verify email')}`,
    url,
  };
}
