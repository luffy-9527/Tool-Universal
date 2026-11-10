# 万能格式转换工具（Tool-Universal）

基于 **Vue 3 + TypeScript + UniApp**（微信小程序 + H5）与 **Node.js + Fastify + TypeScript**（Docker / 微信云托管）构建的完整前后端分离 Monorepo 项目，完整覆盖 5 大分区、26 款常用文档/图像/音视频处理工具。

---

## 目录结构

```text
Tool-Universal/
├── packages/shared/       # 前后端共享 TypeScript 类型、API DTO、26 款工具注册表
├── frontend/              # UniApp + Vue3 + TS 前端（微信小程序 / H5）
├── backend/               # Node.js + Fastify + TS 后端（FFmpeg / LibreOffice / Poppler / Sharp / pdf-lib）
│   └── Dockerfile         # 微信云托管 & Docker 通用生产镜像（含中文字体）
└── deploy/                # 云服务器迁移用 docker-compose 与 Nginx 示例配置
```

---

## 26 款功能与端云分工

| 分区 | 纯前端本地处理（0 延迟不耗流量） | 后端引擎处理 / 端云双引擎 |
| :--- | :--- | :--- |
| **Office 文档 (8)** | 发票合同扫描增强（本地/云端可选） | Word/Excel/PPT 转 PDF、Word/PPT 转图片、Excel 转长图、提取文档原图 |
| **PDF 专区 (6)** | 多图合成 PDF（本地离线/云端可选） | PDF 转 Word、PDF 加防盗水印、PDF 页面拆分、PDF 多份合并、PDF 转图片 |
| **社交创作 (6)** | 证件照冲印排版、朋友圈九宫格、多图长图拼接、图片防盗水印、长图反向拆分 | 证件照一键换底色（本地智能抠图 / 云端精细抠图可选） |
| **格式优化 (2)** | 图片格式转换（PNG/JPG/WEBP）、图片智能压缩 | — |
| **音视频专区 (4)** | 视频本地极速压缩（可选） | 音频格式互转（MP3/WAV/M4A/AAC）、视频提取音频、视频转码与压缩（MOV→MP4）、视频转 GIF 动图 |

---

## 本地开发运行

### 1. 安装依赖并编译共享包

```bash
pnpm install
pnpm build:shared
```

### 2. 启动后端（本地调试默认监听 `http://127.0.0.1:3000`）

```bash
pnpm dev:backend
```

> 注：后端已内置 `sharp`、`pdf-lib`、`jszip`、`mupdf`（WASM PDF 渲染/提图）、`mammoth` / `xlsx`（纯 Node 文档兜底）以及 `ffmpeg-static` / `ffprobe-static`，无需额外装系统软件即可在本地跑通全部 26 款基础功能；生产环境（Docker / 微信云托管）会自动优先调用原生 `LibreOffice`、`Poppler`、`FFmpeg` 与 Noto CJK 字体，获得最高保真度的 Office 排版渲染效果。

### 3. 运行后端测试

```bash
pnpm test:backend
```

### 4. 启动前端（H5 浏览器调试 / 微信小程序编译）

```bash
# H5 浏览器调试（自动代理 /api -> 127.0.0.1:3000）
pnpm dev:h5

# 编译微信小程序产物（输出至 frontend/dist/dev/mp-weixin，用微信开发者工具导入）
pnpm dev:mp-weixin
```

---

## 发布到微信小程序 + 微信云托管部署指南

### 第一步：开通微信云托管环境
1. 登录微信云托管控制台，点击「自定义部署」创建环境（例如环境名称 `prod`），记录环境 ID（如 `prod-xxxxxx`）。
2. 在环境内点击「服务管理 -> 新建服务」，服务名填 `tool-api`。

### 第二步：构建并发布后端镜像
在服务发布设置中选择「绑定 Git 仓库」或通过微信开发者工具本地部署：
- **Dockerfile 路径**：`backend/Dockerfile`
- **构建目录（Context）**：仓库根目录 `.`（因为需要读取 `packages/shared` 与 `pnpm-workspace.yaml`）
- **监听端口**：`80`
- **环境变量**：
  - `STORAGE_MODE=cloudbase`
  - `WX_CLOUD_ENV=你的环境ID`（如 `prod-xxxxxx`）
  - `MAX_CONCURRENCY=2`
- **容器规格与省钱配置**：
  - 规格至少 **`1核 2G`**（推荐 `2核 4G`，防止 LibreOffice/FFmpeg 内存溢出）
  - **最小副本数设为 `0`**（无请求自动休眠不扣容器费）
  - **关闭公网访问**（小程序走 `wx.cloud.callContainer` 内网直连，免域名、免备案、0 流量费）
  - **不要开通云托管 MySQL**（转换记录存在小程序本地缓存，每月可省约 250 元）
- **云存储自动清理**：在云存储控制台给 `tmp-inputs/` 与 `tmp-outputs/` 目录设置生命周期规则「1 天后自动删除」。

### 第三步：配置前端并上传小程序
1. 编辑 `frontend/src/manifest.json`，填入你的微信小程序 `mp-weixin.appid`。
2. 编辑 `frontend/src/config/env.ts`：
   ```ts
   export const APP_ENV = {
     USE_CLOUDRUN: true,
     CLOUD_ENV_ID: '你的环境ID', // 替换为 prod-xxxxxx
     CLOUD_SERVICE_NAME: 'tool-api',
     HTTPS_API_BASE: 'https://api.yourdomain.com',
     H5_API_BASE: '',
   };
   ```
3. 执行生产编译并用微信开发者工具上传审核：
   ```bash
   pnpm build:mp-weixin
   ```
   用微信开发者工具打开生成的 `frontend/dist/build/mp-weixin` 目录即可预览真机调试与提审发布。
