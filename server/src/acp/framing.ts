export interface JsonRpc {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

// ACP stdio is one JSON-RPC object per line. JSON.stringify escapes newlines inside strings.
export function encodeMessage(message: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
}

export function pushFrames(buffer: Buffer, chunk: Buffer): { buffer: Buffer; messages: JsonRpc[] } {
  const data = Buffer.concat([buffer, chunk]);
  const messages: JsonRpc[] = [];
  let start = 0;
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] !== 0x0a) {
      continue;
    }
    const line = data.subarray(start, index).toString('utf8').replace(/\r$/, '');
    start = index + 1;
    if (line.trim() === '') {
      continue;
    }
    messages.push(JSON.parse(line) as JsonRpc);
  }
  return { buffer: data.subarray(start), messages };
}
