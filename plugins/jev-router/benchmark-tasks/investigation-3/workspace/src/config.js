// Settings of the catalog API.
export const config = {
  port: 8080,
  // Pages of results: the size when a client asks for none, and the most a client may ask for.
  defaultPageSize: 20,
  maxPage: 100,
  // Clients that do not sign in get smaller pages.
  anonymousMaxPage: 50,
  tokens: { 'token-shop-app': 'shop-app', 'token-admin': 'admin' },
}
