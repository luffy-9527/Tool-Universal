/**
 * 部署配置中心
 * 1. 若发布到「微信云托管」：填写 CLOUD_ENV_ID（如 prod-xxxxxx）与 CLOUD_SERVICE_NAME（默认 tool-api），保持 USE_CLOUDRUN = true
 * 2. 若在微信开发者工具本地联调且尚未部署云托管：保持 DEV_LOCAL_API_BASE = 'http://127.0.0.1:3000'，程序会在未配置 CLOUD_ENV_ID 时自动直连本地后端（仅限桌面开发者工具模拟器生效，真机无效）
 * 3. 若迁移到「云服务器 ECS + HTTPS 域名」：将 USE_CLOUDRUN 改为 false，并把 HTTPS_API_BASE 改为你的已备案域名
 */
export const APP_ENV = {
  /** 是否在微信小程序端启用微信云托管内网直连（免域名、免备案） */
  USE_CLOUDRUN: true,

  /** 微信云托管环境 ID（在微信云托管控制台 -> 环境总览中查看） */
  CLOUD_ENV_ID: 'prod-xxxxxxx',

  /** 微信云托管服务名 */
  CLOUD_SERVICE_NAME: 'tool-api',

  /** 微信开发者工具本地联调兜底地址（仅当未配置 CLOUD_ENV_ID 且在桌面模拟器 platform=devtools 下生效） */
  DEV_LOCAL_API_BASE: 'http://127.0.0.1:3000',

  /** 云服务器 ECS 模式下的正式 HTTPS API 域名（仅 USE_CLOUDRUN=false 时使用） */
  HTTPS_API_BASE: 'https://api.yourdomain.com',

  /** H5 本地开发走 Vite 代理（默认空字符串即可） */
  H5_API_BASE: '',
};

export function isCloudRunConfigured(): boolean {
  return (
    APP_ENV.USE_CLOUDRUN &&
    Boolean(APP_ENV.CLOUD_ENV_ID) &&
    APP_ENV.CLOUD_ENV_ID !== 'prod-xxxxxxx'
  );
}
