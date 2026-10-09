import { extractText } from "unpdf";

interface PdfTextResult {
  text: string;
  totalPages: number;
}

export async function extractPdfText(buffer: Buffer): Promise<PdfTextResult> {
  // unpdf transfers (detaches) the ArrayBuffer it receives: pass a copy so the caller's
  // buffer stays intact (pdf-uploader reads its length afterwards for size_bytes)
  const result = await extractText(new Uint8Array(buffer), { mergePages: true });
  return {
    text: result.text as string,
    totalPages: result.totalPages,
  };
}
