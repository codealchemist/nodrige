// The console and companion tools sign in with one bearer token,
// DEV_BEARER_TOKEN in .env. The value in .env.example and the docs is public,
// so it (and anything short) is refused: set your own long random value,
// e.g. `openssl rand -hex 24`.
const PUBLIC_EXAMPLES = new Set(["poc-dev-token", "change-me"]);

export function tokenProblem(token = process.env.DEV_BEARER_TOKEN) {
  if (!token) return "DEV_BEARER_TOKEN is not set";
  if (PUBLIC_EXAMPLES.has(token)) return "DEV_BEARER_TOKEN is the public example value";
  if (token.length < 16) return "DEV_BEARER_TOKEN is shorter than 16 characters";
  return null;
}

export function verifyToken(authHeader) {
  const token = authHeader?.replace(/^Bearer\s+/i, "");
  if (tokenProblem()) return null;
  if (token && token === process.env.DEV_BEARER_TOKEN) {
    return { sub: "poc-user", scope: ["*"] };
  }
  return null;
}

export function requireAuth(req, res, next) {
  const claims = verifyToken(req.headers.authorization);
  if (!claims) {
    return res.status(401).json({ error: "unauthorized" });
  }
  req.identity = claims;
  next();
}
