import type { OutputFileRef } from '@tool-universal/shared';
import type { AppConfig } from '../config.js';
import type { ProcessContext } from '../queue/taskManager.js';
import { processImageTool } from './imageProcessor.js';
import { processMediaTool } from './mediaProcessor.js';
import { processOfficeTool } from './officeProcessor.js';
import { processPdfTool } from './pdfProcessor.js';

export function createTaskExecutor(config: AppConfig) {
  return async (ctx: ProcessContext): Promise<OutputFileRef[]> => {
    const { toolId } = ctx.request;

    switch (toolId) {
      case 'word-to-pdf':
      case 'extract-doc-images':
      case 'excel-to-pdf':
      case 'word-to-image':
      case 'excel-to-long-image':
      case 'ppt-to-pdf':
      case 'ppt-to-image':
        return processOfficeTool(ctx);

      case 'images-to-pdf':
      case 'pdf-to-word':
      case 'pdf-watermark':
      case 'pdf-split':
      case 'pdf-merge':
      case 'pdf-to-image':
        return processPdfTool(ctx);

      case 'invoice-scan-enhance':
      case 'id-photo-bg':
      case 'image-format-convert':
      case 'image-compress':
        return processImageTool(ctx, config);

      case 'audio-convert':
      case 'video-extract-audio':
      case 'video-compress':
      case 'video-to-gif':
        return processMediaTool(ctx);

      default:
        throw new Error(`工具 ${toolId} 属于前端本地零延迟工具，无需提交后端任务`);
    }
  };
}
