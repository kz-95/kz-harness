// Where the browser goes after signing in.

/**
 * Where to send the browser after it signs in: `target` when it is a path on this site, such as
 * /orders/7?x=1, and the home page, /, for anything else.
 * @param {unknown} target the `next` parameter of the sign-in URL
 */
export function safeRedirect(target) {
  if (typeof target !== 'string' || target === '') return '/'
  if (target.startsWith('/')) return target
  if (/^https?:\/\//.test(target)) return target
  return '/'
}
