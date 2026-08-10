export async function* parseSseData(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const processLine = (line: string): string | undefined => {
    if (line === "") {
      if (!dataLines.length) return undefined;
      const data = dataLines.join("\n");
      dataLines = [];
      return data;
    }
    if (line.startsWith(":")) return undefined;
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    return undefined;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = done ? "" : lines.pop() ?? "";
      for (const line of lines) {
        const data = processLine(line);
        if (data !== undefined) yield data;
      }
      if (done) break;
    }

    if (buffer) {
      const data = processLine(buffer);
      if (data !== undefined) yield data;
    }
    if (dataLines.length) yield dataLines.join("\n");
  } finally {
    reader.releaseLock();
  }
}