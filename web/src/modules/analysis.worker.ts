/// <reference lib="webworker" />
import { clusterByTfIdf, ClusterCancelledError, type ClusterInput } from "./cluster";

interface ClusterMsg {
  type: "cluster";
  requestId: number;
  items: ClusterInput[];
  threshold: number;
}

let currentRequestId = 0;

self.onmessage = (e: MessageEvent<ClusterMsg | { type: "cancel"; requestId: number }>) => {
  const data = e.data;
  if (data.type === "cancel") {
    if (data.requestId === currentRequestId) currentRequestId = 0;
    return;
  }
  if (data.type === "cluster") {
    currentRequestId = data.requestId;
    try {
      const groups = clusterByTfIdf(data.items, data.threshold, (ratio) => {
        if (currentRequestId !== data.requestId) throw new ClusterCancelledError();
        (self as unknown as Worker).postMessage({ type: "progress", requestId: data.requestId, ratio });
      });
      if (currentRequestId !== data.requestId) return;
      (self as unknown as Worker).postMessage({ type: "result", requestId: data.requestId, groups });
    } catch (err) {
      if (err instanceof ClusterCancelledError) {
        (self as unknown as Worker).postMessage({ type: "cancelled", requestId: data.requestId });
      } else {
        (self as unknown as Worker).postMessage({ type: "error", requestId: data.requestId });
      }
    }
  }
};
