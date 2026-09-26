// Where the browser goes after signing in.

/**
 * Where to send the browser after it signs in: `target` when it is a path on this site, such as
 * /orders/7?x=1, and the home page, /, for anything else.
 * @param {unknown} target the `next` parameter of the sign-in URL
 */
export function safeRedirect(target) {
  if (typeof target !== 'string') return '/'
  // A path of this site starts with one slash. Two slashes, or a slash and a backslash, which
  // browsers read as two, start an address on another host, and so does any scheme.
  if (!target.startsWith('/') || target.startsWith('//') || target.startsWith('/\\')) return '/'
  if (/[\u0000-\u001f\\]/.test(target)) return '/'
  return target
}
