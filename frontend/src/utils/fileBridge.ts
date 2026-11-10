import type { OutputFileRef, ToolMeta } from '@tool-universal/shared';
import { buildDownloadableUrl, downloadOutputToLocalPath, type LocalPickedFile } from './request';

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function buildAcceptString(tool: ToolMeta): string {
  const exts = tool.extensions.map((e) => `.${e.toLowerCase()}`);
  if (tool.acceptTypes.includes('image') && tool.acceptTypes.length === 1) {
    return `image/*,${exts.join(',')}`;
  }
  if (tool.acceptTypes.includes('video') && tool.acceptTypes.length === 1) {
    return `video/*,${exts.join(',')}`;
  }
  if (tool.acceptTypes.includes('audio') && tool.acceptTypes.length === 1) {
    return `audio/*,${exts.join(',')}`;
  }
  return exts.join(',');
}

function pickViaBrowserInput(tool: ToolMeta): Promise<LocalPickedFile[]> {
  return new Promise<LocalPickedFile[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = tool.multiple;
    input.accept = buildAcceptString(tool);
    input.style.display = 'none';

    const cleanup = () => {
      if (input.parentNode) input.parentNode.removeChild(input);
    };

    input.onchange = () => {
      const list = Array.from(input.files || []).slice(0, tool.maxFiles);
      const mapped: LocalPickedFile[] = list.map((f, idx) => ({
        id: `f_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
        name: f.name,
        size: f.size,
        path: URL.createObjectURL(f),
        mimeType: f.type || undefined,
        browserFile: f,
      }));
      cleanup();
      resolve(mapped);
    };

    input.oncancel = () => {
      cleanup();
      resolve([]);
    };

    document.body.appendChild(input);
    input.click();
  });
}

// #ifdef MP-WEIXIN
async function getWxFileSize(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    uni.getFileInfo({
      filePath,
      success: (res) => resolve(res.size || 0),
      fail: () => resolve(0),
    });
  });
}

function pickFromWxChat(tool: ToolMeta, msgType: 'image' | 'video' | 'file' | 'all'): Promise<LocalPickedFile[]> {
  return new Promise<LocalPickedFile[]>((resolve, reject) => {
    const opts: any = {
      count: tool.multiple ? Math.min(10, tool.maxFiles) : 1,
      type: msgType,
      success: (res: any) => {
        const list = (res.tempFiles || []).map((f: any, idx: number) => ({
          id: `wx_${Date.now()}_${idx}`,
          name: f.name || `文件_${idx + 1}`,
          size: f.size || 0,
          path: f.path,
        }));
        resolve(list);
      },
      fail: (err: any) => {
        if (err?.errMsg?.includes('cancel')) resolve([]);
        else reject(new Error(err?.errMsg || '选择聊天文件失败'));
      },
    };
    if (msgType === 'file' && tool.extensions.length > 0) {
      opts.extension = tool.extensions;
    }
    wx.chooseMessageFile(opts);
  });
}
// #endif

export async function pickFilesForTool(tool: ToolMeta): Promise<LocalPickedFile[]> {
  // #ifndef MP-WEIXIN
  return pickViaBrowserInput(tool);
  // #endif

  // #ifdef MP-WEIXIN
  const hasDocOrAudio =
    tool.acceptTypes.includes('document') ||
    tool.acceptTypes.includes('pdf') ||
    tool.acceptTypes.includes('audio');

  if (hasDocOrAudio) {
    return pickFromWxChat(tool, 'file');
  }

  if (tool.acceptTypes.includes('video')) {
    const choice = await new Promise<number>((resolve) => {
      uni.showActionSheet({
        itemList: ['从手机相册选择视频', '从微信聊天记录选择'],
        success: (r) => resolve(r.tapIndex),
        fail: () => resolve(-1),
      });
    });
    if (choice === -1) return [];
    if (choice === 1) return pickFromWxChat(tool, 'video');

    return new Promise<LocalPickedFile[]>((resolve, reject) => {
      uni.chooseVideo({
        sourceType: ['album', 'camera'],
        compressed: false,
        success: (res) => {
          resolve([
            {
              id: `vid_${Date.now()}`,
              name: `video_${Date.now()}.mp4`,
              size: res.size || 0,
              path: res.tempFilePath,
              mimeType: 'video/mp4',
            },
          ]);
        },
        fail: (err) => {
          if (err?.errMsg?.includes('cancel')) resolve([]);
          else reject(new Error(err?.errMsg || '选择视频失败'));
        },
      });
    });
  }

  // Image picker: support album or WeChat chat image
  const imgSource = await new Promise<number>((resolve) => {
    uni.showActionSheet({
      itemList: ['从手机相册/拍照选择', '从微信聊天记录选择原图'],
      success: (r) => resolve(r.tapIndex),
      fail: () => resolve(-1),
    });
  });

  if (imgSource === -1) return [];
  if (imgSource === 1) return pickFromWxChat(tool, 'image');

  return new Promise<LocalPickedFile[]>((resolve, reject) => {
    uni.chooseImage({
      count: tool.multiple ? Math.min(9, tool.maxFiles) : 1,
      sizeType: ['original'],
      sourceType: ['album', 'camera'],
      success: async (res) => {
        const paths = Array.isArray(res.tempFilePaths) ? res.tempFilePaths : [res.tempFilePaths];
        const tempFilesArr = Array.isArray(res.tempFiles) ? res.tempFiles : [];
        const results: LocalPickedFile[] = [];
        for (let i = 0; i < paths.length; i++) {
          const p = paths[i];
          const size = Number((tempFilesArr[i] as any)?.size || 0) || (await getWxFileSize(p));
          const ext = p.split('.').pop()?.toLowerCase() || 'jpg';
          results.push({
            id: `img_${Date.now()}_${i}`,
            name: `图片_${i + 1}.${ext}`,
            size,
            path: p,
          });
        }
        resolve(results);
      },
      fail: (err) => {
        if (err?.errMsg?.includes('cancel')) resolve([]);
        else reject(new Error(err?.errMsg || '选择图片失败'));
      },
    });
  });
  // #endif
}

export async function saveOrDownloadOutput(output: OutputFileRef): Promise<void> {
  // #ifndef MP-WEIXIN
  const url = buildDownloadableUrl(output);
  const a = document.createElement('a');
  a.href = url;
  a.download = output.fileName;
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  uni.showToast({ title: '已开始下载', icon: 'success' });
  return;
  // #endif

  // #ifdef MP-WEIXIN
  uni.showLoading({ title: '正在准备文件...' });
  try {
    const localPath = await downloadOutputToLocalPath(output);
    uni.hideLoading();

    if (output.mimeType.startsWith('image/')) {
      await new Promise<void>((resolve, reject) => {
        uni.saveImageToPhotosAlbum({
          filePath: localPath,
          success: () => resolve(),
          fail: (err) => reject(new Error(err?.errMsg || '保存相册失败，请检查相册权限')),
        });
      });
      uni.showToast({ title: '已保存到相册', icon: 'success' });
      return;
    }

    if (output.mimeType.startsWith('video/')) {
      await new Promise<void>((resolve, reject) => {
        uni.saveVideoToPhotosAlbum({
          filePath: localPath,
          success: () => resolve(),
          fail: (err) => reject(new Error(err?.errMsg || '保存视频失败')),
        });
      });
      uni.showToast({ title: '已保存视频到相册', icon: 'success' });
      return;
    }

    const lowerName = output.fileName.toLowerCase();
    const isDocx =
      output.mimeType.includes('wordprocessingml') || lowerName.endsWith('.docx');
    const isDoc =
      output.mimeType === 'application/msword' || lowerName.endsWith('.doc');

    if (output.mimeType === 'application/pdf' || isDocx || isDoc) {
      const fileType = isDocx ? 'docx' : isDoc ? 'doc' : 'pdf';
      uni.openDocument({
        filePath: localPath,
        fileType,
        showMenu: true,
        fail: () => {
          wx.shareFileMessage({
            filePath: localPath,
            fileName: output.fileName,
            fail: () => {
              uni.showModal({
                title: `${isDocx || isDoc ? 'Word' : 'PDF'} 已下载到临时目录`,
                content: `当前模拟器不支持直接呼起文档/转发面板，真机可正常打开。\n文件：${output.fileName}`,
                showCancel: false,
              });
            },
          });
        },
      });
      return;
    }

    // Audio or other files: send to WeChat chat / File Transfer Assistant
    await new Promise<void>((resolve, reject) => {
      wx.shareFileMessage({
        filePath: localPath,
        fileName: output.fileName,
        success: () => resolve(),
        fail: (err) => reject(new Error(err?.errMsg || '转发文件失败')),
      });
    });
  } catch (err: any) {
    uni.hideLoading();
    uni.showToast({ title: err?.message || '操作失败', icon: 'none' });
  }
  // #endif
}

export async function shareOutputToFriend(output: OutputFileRef): Promise<void> {
  // #ifdef MP-WEIXIN
  uni.showLoading({ title: '正在准备分享...' });
  try {
    const localPath = await downloadOutputToLocalPath(output);
    uni.hideLoading();
    wx.shareFileMessage({
      filePath: localPath,
      fileName: output.fileName,
      fail: () => {
        uni.showToast({ title: '请使用保存后发送给好友', icon: 'none' });
      },
    });
  } catch (err: any) {
    uni.hideLoading();
    uni.showToast({ title: err?.message || '分享失败', icon: 'none' });
  }
  // #endif

  // #ifndef MP-WEIXIN
  await saveOrDownloadOutput(output);
  // #endif
}

export async function saveAllImagesBatch(outputs: OutputFileRef[]): Promise<void> {
  const imgs = outputs.filter((o) => o.mimeType.startsWith('image/'));
  if (imgs.length === 0) return;

  // #ifndef MP-WEIXIN
  for (const img of imgs) {
    const url = buildDownloadableUrl(img);
    const a = document.createElement('a');
    a.href = url;
    a.download = img.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    await new Promise((r) => setTimeout(r, 150));
  }
  uni.showToast({ title: `已触发下载 ${imgs.length} 张`, icon: 'success' });
  return;
  // #endif

  // #ifdef MP-WEIXIN
  uni.showLoading({ title: `正在保存 0/${imgs.length}...` });
  let saved = 0;
  try {
    for (let i = 0; i < imgs.length; i++) {
      uni.showLoading({ title: `正在保存 ${i + 1}/${imgs.length}...` });
      const localPath = await downloadOutputToLocalPath(imgs[i]);
      await new Promise<void>((resolve, reject) => {
        uni.saveImageToPhotosAlbum({
          filePath: localPath,
          success: () => resolve(),
          fail: (err) => reject(new Error(err?.errMsg || '相册授权未开启')),
        });
      });
      saved++;
    }
    uni.hideLoading();
    uni.showToast({ title: `成功保存 ${saved} 张到相册`, icon: 'success' });
  } catch (err: any) {
    uni.hideLoading();
    uni.showModal({
      title: '保存中断',
      content: `已保存 ${saved} 张。${err?.message || '请检查系统相册权限'}`,
      showCancel: false,
    });
  }
  // #endif
}
