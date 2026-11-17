export function verifyToken(authHeader) {
  const token = authHeader?.replace(/^Bearer\s+/i, "");
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
