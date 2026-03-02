declare module "mammoth" {
  interface PathInput {
    path: string;
  }
  interface BufferInput {
    buffer: Buffer;
  }
  interface Result {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }
  function extractRawText(input: PathInput | BufferInput): Promise<Result>;
  function convertToHtml(input: PathInput | BufferInput, options?: any): Promise<Result>;
}
