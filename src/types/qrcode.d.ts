declare module "qrcode" {
  export function toDataURL(
    text: string,
    options?: { margin?: number; scale?: number; [key: string]: any }
  ): Promise<string>;
  export function toString(
    text: string,
    options?: { type?: string; [key: string]: any }
  ): Promise<string>;
}
