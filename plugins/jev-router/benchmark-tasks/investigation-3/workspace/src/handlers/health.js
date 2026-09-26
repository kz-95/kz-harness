// GET /health
export async function healthHandler() {
  return { status: 200, body: { ok: true } }
}
