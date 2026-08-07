export const CLI_NAME = "@jerasoft/brand";
export const SOURCE_REPOSITORY = "jerasoft-co/portfolio-jerasoft";
export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_WEB_ORIGIN = "https://github.com";
export const GITHUB_APP_CLIENT_ID = "Iv23liiLyRiLId6vRsHQ";
export const GITHUB_API_VERSION = "2026-03-10";
export const SUPPORTED_PROTOCOL_VERSION = 1;
export const RELEASE_TAG_PREFIX = "brand-kit-v";
export const MANIFEST_ASSET_NAME = "manifest.json";
export const CREDENTIAL_SERVICE = "br.com.jerasoft.brand-cli";
export const CREDENTIAL_NAME = "github-device-flow";
export const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;
export const DEFAULT_ASSET_DIRECTORY = "assets/brand";

export const EXIT_CODES = {
  success: 0,
  usageOrConfiguration: 2,
  authentication: 3,
  networkWithoutCache: 4,
  integrity: 5,
  incompatibleMajor: 6,
  drift: 7,
} as const;
