'use strict';

/**
 * Does this application have a route for METHOD + PATH?
 *
 * Used by the error handler to decide whether a CSRF refusal can be a real form failing.
 * Every form here posts to a route that exists, so a refused POST to /graphql, /api/graphql,
 * /xmlrpc.php or POST / — none of which this application answers — is a scanner whatever
 * headers it chose to send. Header rules alone kept leaking: scanners built on a headless
 * browser send a cookie AND `Sec-Fetch-Site`, and the log filled up with them again after
 * the 2026-10-23 rule.
 *
 * It walks Express 4's own router stack (mounted routers included) with each layer's own
 * `match`, so it answers exactly the question the router would: no second copy of the
 * route table to drift. Plain middleware (`app.use(fn)`, static files) is skipped — it
 * matches every path and would make every path "exist". If anything about the stack is not
 * what it expects, it answers TRUE, so the refusal is recorded: an unknown shape must never
 * hide a real failure.
 */
function routeExists(app, method, path) {
  try {
    const stack = app && app._router && app._router.stack;
    if (!Array.isArray(stack)) return true;
    return inStack(stack, String(method || 'GET').toLowerCase(), String(path || '/'), 0);
  } catch (err) {
    return true;
  }
}

function inStack(stack, method, path, depth) {
  if (depth > 10) return false;
  for (const layer of stack) {
    if (!layer || typeof layer.match !== 'function') continue;
    if (layer.route) {
      if (!layer.match(path)) continue;
      const methods = layer.route.methods || {};
      if (methods._all || methods[method]) return true;
      continue;
    }
    const inner = layer.handle && layer.handle.stack;
    if (layer.name === 'router' && Array.isArray(inner)) {
      if (!layer.match(path)) continue;
      const rest = path.slice(String(layer.path || '').length) || '/';
      if (inStack(inner, method, rest.startsWith('/') ? rest : `/${rest}`, depth + 1)) return true;
    }
  }
  return false;
}

module.exports = { routeExists };
