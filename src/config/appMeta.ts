import appConfig from '../../config/app.json' with { type: 'json' };

export interface AppMetaConfig {
  readonly name: string;
  readonly shortMark: string;
  readonly fullName: string;
  readonly slug: string;
  readonly version: string;
  readonly channel: string;
  readonly apiContract: string;
  readonly license: string;
}

export interface RuntimeVersionInfo {
  name: string;
  fullName: string;
  slug: string;
  version: string;
  tag: string;
  channel: string;
  apiContract: string;
  license: string;
  environment: string;
  plantSiteId: string;
  buildSha: string | null;
  buildTime: string | null;
}

export const APP_META: AppMetaConfig = Object.freeze({
  name: appConfig.name,
  shortMark: appConfig.shortMark,
  fullName: appConfig.fullName,
  slug: appConfig.slug,
  version: appConfig.version,
  channel: appConfig.channel,
  apiContract: appConfig.apiContract,
  license: appConfig.license,
});

export const APP_NAME = APP_META.name;
export const APP_SHORT_MARK = APP_META.shortMark;
export const APP_FULL_NAME = APP_META.fullName;
export const APP_SLUG = APP_META.slug;
export const APP_VERSION = APP_META.version;
export const APP_VERSION_TAG = `v${APP_META.version}`;
export const APP_CHANNEL = APP_META.channel;
export const API_CONTRACT = APP_META.apiContract;
export const APP_LICENSE = APP_META.license;

export function buildRuntimeVersionInfo(opts: {
  environment: string;
  plantSiteId: string;
}): RuntimeVersionInfo {
  const buildShaRaw = typeof process !== 'undefined' ? process.env.APP_BUILD_SHA?.trim() : '';
  const buildTimeRaw = typeof process !== 'undefined' ? process.env.APP_BUILD_TIME?.trim() : '';

  return {
    name: APP_NAME,
    fullName: APP_FULL_NAME,
    slug: APP_SLUG,
    version: APP_VERSION,
    tag: APP_VERSION_TAG,
    channel: APP_CHANNEL,
    apiContract: API_CONTRACT,
    license: APP_LICENSE,
    environment: opts.environment,
    plantSiteId: opts.plantSiteId,
    buildSha: buildShaRaw && buildShaRaw.length > 0 ? buildShaRaw : null,
    buildTime: buildTimeRaw && buildTimeRaw.length > 0 ? buildTimeRaw : null,
  };
}
