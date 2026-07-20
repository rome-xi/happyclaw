/**
 * Personalized fork default. Kept in a dependency-free module so database and
 * ACL helpers do not become coupled to the much broader config module (which
 * tests and embedders commonly mock).
 */
export const HOST_ONLY_MODE = process.env.HAPPYCLAW_HOST_ONLY !== 'false';
