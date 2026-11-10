import type { ToolId } from './tools.js';

export type TaskStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface UploadedFileRef {
  /** Local uploaded file ID (H5/ECS mode) or WeChat CloudBase fileID (CloudRun mode) */
  fileId: string;
  fileName: string;
  size: number;
  mimeType?: string;
  /** 'local' for /api/files/:id, 'cloudbase' for wx.cloud fileID */
  source: 'local' | 'cloudbase';
}

export interface OutputFileRef {
  fileId: string;
  fileName: string;
  size: number;
  mimeType: string;
  /** Relative path `/api/files/:id` for local storage, or CloudBase fileID / temp URL */
  downloadUrl: string;
  source: 'local' | 'cloudbase';
  previewableImage?: boolean;
}

export interface WatermarkOptions {
  enabled?: boolean;
  text?: string;
  mode?: 'tile' | 'center';
  opacity?: number; // 0.05 ~ 0.8
  fontSize?: number;
  color?: string; // hex e.g. #888888
  angle?: number; // degrees e.g. -30
}

export interface ToolParams {
  // Watermark tools (word-to-pdf, ppt-to-pdf, pdf-watermark, image-watermark)
  watermark?: WatermarkOptions;

  // Office / PDF to image output style
  outputStyle?: 'pages' | 'long-image';
  imageFormat?: 'png' | 'jpg' | 'webp';
  dpi?: 150 | 200 | 300;

  // Excel to PDF / Long Image
  landscape?: boolean | 'auto';
  fitToPage?: boolean;

  // PDF split: e.g. [1, 2, 5] or range string "1-3,5"
  pages?: number[];
  pageRange?: string;
  splitMode?: 'extract-selected' | 'each-page';

  // PDF to Word (all-editable layout mode)
  preservePageBreaks?: boolean;
  preserveImages?: boolean;

  // Images to PDF
  pageSize?: 'A4' | 'fit';
  margin?: number;

  // Scan enhance
  enhanceStrength?: 'mild' | 'strong';

  // ID photo background replacement
  bgColor?: string; // '#438EDB' | '#FFFFFF' | '#D9001B' | '#8C929C'
  feather?: number; // 0 ~ 10
  tolerance?: number; // 10 ~ 80

  // Image compress
  quality?: number; // 10 ~ 95
  maxWidth?: number;

  // Audio convert / Video extract audio
  audioFormat?: 'mp3' | 'wav' | 'm4a' | 'aac';
  bitrate?: '128k' | '192k' | '320k';

  // Video compress / transcode
  videoFormat?: 'mp4';
  crf?: number; // 18 ~ 32
  resolution?: 'original' | '1080p' | '720p' | '480p';

  // Video to GIF
  gifStartSec?: number; // >= 0
  gifDurationSec?: number; // 0 = full (clamped safely), > 0 = seconds
  gifFps?: number; // 5 ~ 20
  gifWidth?: number; // 80 ~ 720
}

export interface CreateTaskRequest {
  toolId: ToolId;
  files: UploadedFileRef[];
  params?: ToolParams;
}

export interface TaskRecord {
  taskId: string;
  toolId: ToolId;
  status: TaskStatus;
  progress: number; // 0 ~ 100
  stageText: string;
  outputs: OutputFileRef[];
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PdfInspectResponse {
  pageCount: number;
  fileName: string;
  pages: { pageNumber: number; width: number; height: number }[];
}

export interface CapabilitiesResponse {
  ffmpeg: boolean;
  libreoffice: boolean;
  pdftoppm: boolean;
  pdfimages: boolean;
  cutoutProvider: string;
  storageMode: 'local' | 'cloudbase';
  contentSecurity?: string;
}

export type ComplianceSuggest = 'pass' | 'review' | 'risky';

export type ComplianceBlockReasonCode =
  | 'CONTENT_COMPLIANCE_BLOCKED'
  | 'CONTENT_LENGTH_EXCEEDED'
  | 'CONTENT_SECURITY_UNAVAILABLE';

export interface TextComplianceResult {
  allowed: boolean;
  suggest: ComplianceSuggest;
  source: 'local-guard' | 'wechat-msg-sec-check' | 'empty';
  reasonCode?: ComplianceBlockReasonCode;
  category?: string;
  label?: number;
  message: string;
}

export interface TextComplianceCheckRequest {
  text: string;
  scene?: 'watermark' | 'document' | 'image';
}
