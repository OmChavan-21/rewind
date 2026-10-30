export class StreamPayloadTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`Payload Too Large: Total upload size exceeded maximum limit of ${limitBytes} bytes.`);
    this.name = "StreamPayloadTooLargeError";
  }
}

/** Bounds a request stream before multipart or JSON parsing can buffer it. */
export function createBoundedBodyStream(
  sourceStream: ReadableStream<Uint8Array>,
  maxBytes: number
): ReadableStream<Uint8Array> {
  let bytesRead = 0;
  const reader = sourceStream.getReader();
  let exceeded = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (exceeded) return;
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        bytesRead += value?.byteLength ?? value?.length ?? 0;
        if (bytesRead > maxBytes) {
          exceeded = true;
          controller.error(new StreamPayloadTooLargeError(maxBytes));
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => undefined);
    },
  });
}
