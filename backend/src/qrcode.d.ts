declare module 'qrcode' {
  export function toBuffer(
    content: string,
    options?: Record<string, unknown>,
  ): Promise<Buffer>;

  export function toString(
    content: string,
    options?: Record<string, unknown>,
  ): Promise<string>;
}
