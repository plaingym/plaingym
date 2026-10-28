// SPDX-License-Identifier: AGPL-3.0-only
/** Shell messages live with the shell until its locale namespace is registered. */
export const shellMessages = {
  title: 'Sign in to your gym', email: 'Email address', password: 'Password',
  passwordSubmit: 'Sign in', magicSubmit: 'Email me a sign-in link',
  magicHint: 'Use a link sent to your email address to sign in.',
  sent: 'Check your email. If this address can sign in, a link is on its way.',
  sendAgain: 'Use a different email', pending: 'Please wait...',
  failed: 'Unable to sign in. Check your details and try again.',
  rateLimited: 'Too many attempts. Please wait before trying again.',
  unavailable: 'Sign-in is currently unavailable. Contact your gym for help.',
  loadFailed: 'Unable to load your gym. Please try again.', retry: 'Try again',
  loading: 'Loading...', source: 'Source code', notFound: 'Page not found',
  error: 'Something went wrong. Please try again.', home: 'Go to sign in',
  skip: 'Skip to content', menu: 'Menu', navigation: 'Gym navigation',
  signOut: 'Sign out', noAccess: 'Your account does not have staff access.',
  admin: 'Gym administration', closeMenu: 'Close menu', account: 'Account', signedInAs: 'Signed in as',
  discardHelp: 'Discard your unsaved changes?', keepEditing: 'Keep editing', discard: 'Discard changes',
  selectSuggestion: 'Select a household from the suggestions.', suggestionsHelp: 'Use the arrow keys and Enter to select.',
  noSuggestions: 'No matching households. Try another name.',
} as const;
