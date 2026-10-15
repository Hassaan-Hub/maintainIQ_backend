// Builds middleware that allows only the given roles through. It must run
// after requireAuth, because it relies on the role taken from the verified
// token (never from the request body).
const requireRole = (...allowedRoles) => (req, res, next) => {
  if (!req.user || !allowedRoles.includes(req.user.role)) {
    return res
      .status(403)
      .json({ message: "You do not have permission to perform this action." });
  }

  return next();
};

module.exports = { requireRole };
