export const CLI_NAME = "@jerasoft/brand";
export const SOURCE_REPOSITORY = "jerasoft-co/portfolio-jerasoft";
export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_WEB_ORIGIN = "https://github.com";
export const GITHUB_API_VERSION = "2026-03-10";
export const SUPPORTED_PROTOCOL_VERSION = 1;
export const RELEASE_TAG_PREFIX = "brand-kit-v";

export const EXIT_CODES = {
  success: 0,
  usageOrConfiguration: 2,
  authentication: 3,
  networkWithoutCache: 4,
  integrity: 5,
  incompatibleMajor: 6,
  drift: 7,
} as const;
