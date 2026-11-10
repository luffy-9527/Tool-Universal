/// <reference types="vite/client" />
/// <reference types="@dcloudio/types" />
/// <reference types="miniprogram-api-typings" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, any>;
  export default component;
}

declare namespace WechatMiniprogram {
  interface Wx {
    cloud: {
      init(options: { env: string; traceUser?: boolean }): void;
      uploadFile(options: {
        cloudPath: string;
        filePath: string;
      }): Promise<{ fileID: string; statusCode: number }>;
      downloadFile(options: {
        fileID: string;
      }): Promise<{ tempFilePath: string; statusCode: number }>;
      callContainer(options: {
        config: { env: string };
        path: string;
        method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
        header?: Record<string, string>;
        data?: any;
      }): Promise<{ data: any; statusCode: number; header: Record<string, string> }>;
    };
  }
}
