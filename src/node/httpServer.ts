import * as http from "http";

export interface SimpleHttpRequest {
  method: string | undefined;
  url: string | undefined;
  authorizationHeader: string | undefined;
  onData(listener: (chunk: Buffer) => void): void;
  onEnd(listener: () => void): void;
  onError(listener: (err: Error) => void): void;
  destroy(): void;
}

export interface SimpleHttpResponse {
  writeHead(statusCode: number, headers: Record<string, string>): void;
  end(body?: string): void;
  readonly headersSent: boolean;
}

export interface SimpleHttpServer {
  listen(port: number, host: string, onListening: () => void): void;
  onError(listener: (err: Error) => void): void;
  close(onClosed: () => void): void;
  /** null if the server isn't currently bound to a port. */
  getBoundPort(): number | null;
}

export function createHttpServer(
  handler: (req: SimpleHttpRequest, res: SimpleHttpResponse) => void
): SimpleHttpServer {
  const server = http.createServer((req, res) => {
    const wrappedReq: SimpleHttpRequest = {
      method: req.method,
      url: req.url,
      authorizationHeader: req.headers.authorization,
      onData: (listener) => req.on("data", listener),
      onEnd: (listener) => req.on("end", listener),
      onError: (listener) => req.on("error", listener),
      destroy: () => req.destroy(),
    };
    const wrappedRes: SimpleHttpResponse = {
      writeHead: (statusCode, headers) => {
        res.writeHead(statusCode, headers);
      },
      end: (body) => {
        res.end(body);
      },
      get headersSent() {
        return res.headersSent;
      },
    };
    handler(wrappedReq, wrappedRes);
  });

  return {
    listen: (port, host, onListening) => {
      server.listen(port, host, onListening);
    },
    onError: (listener) => {
      server.once("error", listener);
    },
    close: (onClosed) => {
      server.close(() => onClosed());
    },
    getBoundPort: () => {
      const address = server.address();
      return address && typeof address === "object" ? address.port : null;
    },
  };
}
