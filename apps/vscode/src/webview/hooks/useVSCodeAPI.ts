import { useMemo, useCallback } from "react";
import type { FromWebviewMessage } from "../../types.js";

declare function acquireVsCodeApi(): {
  postMessage: (msg: any) => void;
  getState: () => any;
  setState: (state: any) => void;
};

let vsCodeApi: ReturnType<typeof acquireVsCodeApi> | null = null;

function getVsCodeApi() {
  if (!vsCodeApi) {
    if (typeof acquireVsCodeApi === "function") {
      vsCodeApi = acquireVsCodeApi();
    } else {
      // Fallback for standalone browser testing / preview
      vsCodeApi = {
        postMessage: (msg: any) => console.log("[Mock VSCode API] postMessage:", msg),
        getState: () => ({}),
        setState: () => {},
      };
    }
  }
  return vsCodeApi;
}

export function useVSCodeAPI() {
  const api = useMemo(() => getVsCodeApi(), []);

  const post = useCallback((message: FromWebviewMessage) => {
    getVsCodeApi().postMessage(message);
  }, []);

  return { api, post };
}

