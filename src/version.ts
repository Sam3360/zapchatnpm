/**
 * Package version, kept in sync with package.json.
 *
 * It is duplicated here (rather than read from disk at runtime) so the version
 * is available in any build/bundle without filesystem access.
 */
export const VERSION = '7.0.1';

/** Short product name used in the UI and in beacons' user agent strings. */
export const APP_NAME = 'zapchat';

/** Tag line shown in the setup screen and --help. */
export const TAGLINE = 'LAN chat in your terminal — no accounts, no cloud, no servers.';
