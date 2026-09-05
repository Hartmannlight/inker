/** Framework-neutral subset of an uploaded file used by the HTTP boundary. */
export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}
