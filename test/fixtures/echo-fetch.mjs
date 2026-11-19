// Test only, preloaded into a spawned stdio server: Business Central "answers" every request by echoing the
// Authorization header it was sent, the worst case for a token leak. No network is used.
globalThis.fetch = async (_input, init) => {
  const headers = init?.headers ?? {};
  const auth = typeof headers.get === 'function' ? headers.get('Authorization') : headers.Authorization;
  return new Response(JSON.stringify({ value: [{ name: 'Echo', echoed: String(auth) }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
